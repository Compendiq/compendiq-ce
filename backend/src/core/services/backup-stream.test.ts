import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ARCHIVE_MAGIC,
  BACKUP_MAGIC,
  BACKUP_VERSION_MASTER,
  BACKUP_VERSION_PASSPHRASE,
  HEADER_LENGTH,
  assertSafeArchivePath,
  decryptBackupStream,
  encryptBackupStream,
  fingerprintPatEncryptionKey,
  packArchive,
  parseBackupHeader,
  resolveAttachmentDest,
  unpackArchive,
  type ArchiveEntry,
  type BackupSecret,
} from './backup-stream.js';

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function bufferStream(data: Buffer | string): Readable {
  return Readable.from([typeof data === 'string' ? Buffer.from(data) : data]);
}

const MASTER: BackupSecret = { kind: 'master', keyMaterial: 'backup-master-key-at-least-32-chars!!' };
const PASS: BackupSecret = { kind: 'passphrase', passphrase: 'correct horse battery staple' };

describe('backup envelope', () => {
  it('round-trips a payload encrypted with the master key', async () => {
    const payload = Buffer.from('hello-backup-payload');
    const encrypted = await readAll(encryptBackupStream(bufferStream(payload), MASTER));
    expect(encrypted.subarray(0, 6).equals(BACKUP_MAGIC)).toBe(true);
    expect(encrypted.length).toBeGreaterThan(HEADER_LENGTH + 16);
    const header = parseBackupHeader(encrypted.subarray(0, HEADER_LENGTH));
    expect(header.version).toBe(BACKUP_VERSION_MASTER);
    const plain = await readAll(decryptBackupStream(bufferStream(encrypted), MASTER));
    expect(plain.equals(payload)).toBe(true);
  });

  it('round-trips a payload encrypted with a passphrase (PBKDF2)', async () => {
    const payload = Buffer.from('passphrase-payload');
    const encrypted = await readAll(encryptBackupStream(bufferStream(payload), PASS));
    const header = parseBackupHeader(encrypted.subarray(0, HEADER_LENGTH));
    expect(header.version).toBe(BACKUP_VERSION_PASSPHRASE);
    const plain = await readAll(decryptBackupStream(bufferStream(encrypted), PASS));
    expect(plain.equals(payload)).toBe(true);
  });

  it('uses a unique salt and IV per archive', async () => {
    const a = await readAll(encryptBackupStream(bufferStream('x'), MASTER));
    const b = await readAll(encryptBackupStream(bufferStream('x'), MASTER));
    expect(a.subarray(8, 40).equals(b.subarray(8, 40))).toBe(false);
  });

  it('rejects the wrong passphrase', async () => {
    const encrypted = await readAll(encryptBackupStream(bufferStream('secret'), PASS));
    const wrong: BackupSecret = { kind: 'passphrase', passphrase: 'incorrect horse battery' };
    await expect(readAll(decryptBackupStream(bufferStream(encrypted), wrong))).rejects.toThrow();
  });

  it('rejects a truncated ciphertext', async () => {
    const encrypted = await readAll(encryptBackupStream(bufferStream('secret'), MASTER));
    const truncated = encrypted.subarray(0, encrypted.length - 8);
    await expect(readAll(decryptBackupStream(bufferStream(truncated), MASTER))).rejects.toThrow(
      /truncated|auth|unable/i,
    );
  });

  it('rejects a buffer that is not a backup', async () => {
    expect(() => parseBackupHeader(Buffer.alloc(HEADER_LENGTH))).toThrow(/magic/i);
  });
});

describe('fingerprintPatEncryptionKey', () => {
  it('is stable and truncated sha256', () => {
    const a = fingerprintPatEncryptionKey('pat-key-at-least-32-characters!!!!');
    const b = fingerprintPatEncryptionKey('pat-key-at-least-32-characters!!!!');
    const c = fingerprintPatEncryptionKey('other-key-at-least-32-characters!!');
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{32}$/);
    expect(a).not.toBe(c);
  });
});

describe('archive pack/unpack', () => {
  it('round-trips known-size and chunked members', async () => {
    const entries: ArchiveEntry[] = [
      { name: 'manifest.json', size: 2, stream: bufferStream('{}') },
      { name: 'database.dump', stream: bufferStream('DUMPDATA') },
      { name: 'attachments/page/file.bin', size: 3, stream: bufferStream('abc') },
    ];
    const packed = await readAll(packArchive(entries));
    expect(packed.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)).toBe(true);

    const recovered: Record<string, string> = {};
    for await (const member of unpackArchive(bufferStream(packed))) {
      recovered[member.name] = (await readAll(member.stream)).toString();
    }
    expect(recovered).toEqual({
      'manifest.json': '{}',
      'database.dump': 'DUMPDATA',
      'attachments/page/file.bin': 'abc',
    });
  });

  it('encrypts a packed archive end-to-end', async () => {
    const packed = packArchive([
      { name: 'manifest.json', size: 2, stream: bufferStream('{}') },
      { name: 'database.dump', stream: bufferStream('PGDUMP') },
    ]);
    const encrypted = encryptBackupStream(packed, MASTER);
    const decrypted = decryptBackupStream(encrypted, MASTER);
    const recovered: Record<string, string> = {};
    for await (const member of unpackArchive(decrypted)) {
      recovered[member.name] = (await readAll(member.stream)).toString();
    }
    expect(recovered['database.dump']).toBe('PGDUMP');
  });

  it('rejects bytes after the archive terminator', async () => {
    const packed = await readAll(
      packArchive([{ name: 'database.dump', stream: bufferStream('PGDUMP') }]),
    );
    const withTrailingByte = Buffer.concat([packed, Buffer.from([0x01])]);
    const consume = async () => {
      for await (const member of unpackArchive(bufferStream(withTrailingByte))) {
        await readAll(member.stream);
      }
    };

    await expect(consume()).rejects.toThrow(/trailing/i);
  });

  it('waits for source EOF after the archive terminator', async () => {
    const packed = await readAll(
      packArchive([{ name: 'database.dump', stream: bufferStream('PGDUMP') }]),
    );
    const source = Readable.from(
      (async function* () {
        yield packed;
        throw new Error('authenticated EOF failed');
      })(),
    );
    const consume = async () => {
      for await (const member of unpackArchive(source)) {
        await readAll(member.stream);
      }
    };

    await expect(consume()).rejects.toThrow(/authenticated EOF failed/i);
  });
});

describe('path guards', () => {
  it('rejects traversal, absolute, and empty names', () => {
    expect(() => assertSafeArchivePath('../etc/passwd')).toThrow(/traversal/i);
    expect(() => assertSafeArchivePath('/etc/passwd')).toThrow(/absolute/i);
    expect(() => assertSafeArchivePath('attachments/foo/../../etc/passwd')).toThrow(/traversal/i);
    expect(() => assertSafeArchivePath('')).toThrow();
  });

  it('rejects backslashes instead of normalizing an archive member to another restore path', async () => {
    const name = String.raw`attachments/local/1/diagram\final.png`;
    expect(() => assertSafeArchivePath(name)).toThrow(/backslash/i);
    await expect(
      readAll(packArchive([{ name, size: 1, stream: bufferStream('x') }])),
    ).rejects.toThrow(/backslash/i);
  });

  it('resolves attachment members under the attachments root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cq-backup-'));
    try {
      const dest = resolveAttachmentDest(root, 'attachments/local/1/img.png');
      expect(dest.startsWith(path.resolve(root))).toBe(true);
      expect(() => resolveAttachmentDest(root, 'database.dump')).toThrow(/not an attachment/i);
      expect(() => resolveAttachmentDest(root, 'attachments/../../etc/passwd')).toThrow(/traversal/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
