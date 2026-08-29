/**
 * Streaming encrypted backup payload (#1420).
 *
 * Envelope (cleartext prefix + GCM ciphertext + tag):
 *   [ Magic 'CPQBCK' (6B) | Version (u16 BE) | KDF Salt (16B) | Stream IV (16B)
 *     | gzip(CPQARC1 archive) encrypted with AES-256-GCM | Auth Tag (16B) ]
 *
 * Version 1 = HKDF-SHA256 from BACKUP_ENCRYPTION_KEY (automated / master).
 * Version 2 = PBKDF2-SHA256, 600_000 iterations, from a user passphrase.
 *
 * Inner archive is a length-prefixed framed format (not POSIX tar) so
 * pg_dump stdout can be packed without knowing its size up front — required
 * by the zero-buffering invariant (container mem_limit 1024m, read_only,
 * tmpfs /tmp).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  pbkdf2Sync,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

export const BACKUP_MAGIC = Buffer.from('CPQBCK');
export const ARCHIVE_MAGIC = Buffer.from('CPQARC1');
export const BACKUP_VERSION_MASTER = 1;
export const BACKUP_VERSION_PASSPHRASE = 2;
export const PBKDF2_ITERATIONS = 600_000;
export const HEADER_LENGTH = 6 + 2 + 16 + 16;
const SALT_LENGTH = 16;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const HKDF_INFO = Buffer.from('compendiq-backup-aes-256-gcm', 'utf8');

export type BackupSecret =
  | { kind: 'master'; keyMaterial: string }
  | { kind: 'passphrase'; passphrase: string };


export interface ArchiveEntry {
  name: string;
  /** Omit to write a chunked (unknown-length) member. */
  size?: number;
  stream: Readable;
}

export class BackupCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupCryptoError';
  }
}

export class BackupArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupArchiveError';
  }
}

export function fingerprintPatEncryptionKey(rawKey: string): string {
  return `sha256:${createHash('sha256').update(rawKey, 'utf8').digest('hex').slice(0, 32)}`;
}

export function deriveBackupKey(secret: BackupSecret, salt: Buffer, version: number): Buffer {
  if (version === BACKUP_VERSION_MASTER) {
    if (secret.kind !== 'master') {
      throw new BackupCryptoError('Archive is master-key encrypted');
    }
    return Buffer.from(
      hkdfSync('sha256', Buffer.from(secret.keyMaterial, 'utf8'), salt, HKDF_INFO, KEY_LENGTH),
    );
  }
  if (version === BACKUP_VERSION_PASSPHRASE) {
    if (secret.kind !== 'passphrase') {
      throw new BackupCryptoError('Archive is passphrase encrypted');
    }
    return pbkdf2Sync(secret.passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
  }
  throw new BackupCryptoError(`Unsupported backup version ${version}`);
}

function versionForSecret(secret: BackupSecret): number {
  return secret.kind === 'master' ? BACKUP_VERSION_MASTER : BACKUP_VERSION_PASSPHRASE;
}

function writeHeader(version: number, salt: Buffer, iv: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_LENGTH);
  BACKUP_MAGIC.copy(header, 0);
  header.writeUInt16BE(version, 6);
  salt.copy(header, 8);
  iv.copy(header, 24);
  return header;
}

export function parseBackupHeader(header: Buffer): { version: number; salt: Buffer; iv: Buffer } {
  if (header.length < HEADER_LENGTH) {
    throw new BackupCryptoError('Backup header truncated');
  }
  if (!header.subarray(0, 6).equals(BACKUP_MAGIC)) {
    throw new BackupCryptoError('Not a Compendiq backup (bad magic)');
  }
  const version = header.readUInt16BE(6);
  if (version !== BACKUP_VERSION_MASTER && version !== BACKUP_VERSION_PASSPHRASE) {
    throw new BackupCryptoError(`Unsupported backup version ${version}`);
  }
  return {
    version,
    salt: header.subarray(8, 24),
    iv: header.subarray(24, 40),
  };
}

class GcmEncryptTransform extends Transform {
  private readonly cipher: CipherGCM;
  private headerWritten = false;

  constructor(
    private readonly header: Buffer,
    key: Buffer,
    iv: Buffer,
  ) {
    super();
    this.cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LENGTH });
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      if (!this.headerWritten) {
        this.push(this.header);
        this.headerWritten = true;
      }
      const out = this.cipher.update(chunk);
      if (out.length) this.push(out);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    try {
      if (!this.headerWritten) this.push(this.header);
      const tail = this.cipher.final();
      if (tail.length) this.push(tail);
      this.push(this.cipher.getAuthTag());
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }
}

class GcmDecryptTransform extends Transform {
  private pending = Buffer.alloc(0);
  private headerDone = false;
  private decipher: DecipherGCM | undefined;
  private hold = Buffer.alloc(0);

  constructor(private readonly secret: BackupSecret) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      this.pending = Buffer.concat([this.pending, chunk]);
      if (!this.headerDone) {
        if (this.pending.length < HEADER_LENGTH) {
          cb();
          return;
        }
        const { version, salt, iv } = parseBackupHeader(this.pending.subarray(0, HEADER_LENGTH));
        const key = deriveBackupKey(this.secret, salt, version);
        this.decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LENGTH });
        this.pending = this.pending.subarray(HEADER_LENGTH);
        this.headerDone = true;
      }
      this.consumeCiphertext(this.pending);
      this.pending = Buffer.alloc(0);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    try {
      if (!this.headerDone || !this.decipher) {
        throw new BackupCryptoError('Backup truncated: missing header');
      }
      if (this.hold.length !== AUTH_TAG_LENGTH) {
        throw new BackupCryptoError('Backup truncated: missing auth tag');
      }
      this.decipher.setAuthTag(this.hold);
      const tail = this.decipher.final();
      if (tail.length) this.push(tail);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  private consumeCiphertext(data: Buffer): void {
    const combined = Buffer.concat([this.hold, data]);
    if (combined.length <= AUTH_TAG_LENGTH) {
      this.hold = combined;
      return;
    }
    const ciphertext = combined.subarray(0, combined.length - AUTH_TAG_LENGTH);
    this.hold = combined.subarray(combined.length - AUTH_TAG_LENGTH);
    const out = this.decipher!.update(ciphertext);
    if (out.length) this.push(out);
  }
}

export function encryptBackupStream(payload: Readable, secret: BackupSecret): Readable {
  const version = versionForSecret(secret);
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveBackupKey(secret, salt, version);
  const header = writeHeader(version, salt, iv);
  const gzip = createGzip({ level: 6 });
  const gcm = new GcmEncryptTransform(header, key, iv);
  const out = new Transform({
    transform(chunk, _enc, cb) {
      this.push(chunk);
      cb();
    },
  });
  pipeline(payload, gzip, gcm, out).catch((err: unknown) => {
    out.destroy(err instanceof Error ? err : new Error(String(err)));
  });
  return out;
}

export function decryptBackupStream(encrypted: Readable, secret: BackupSecret): Readable {
  const gcm = new GcmDecryptTransform(secret);
  const gunzip = createGunzip();
  const out = new Transform({
    transform(chunk, _enc, cb) {
      this.push(chunk);
      cb();
    },
  });
  pipeline(encrypted, gcm, gunzip, out).catch((err: unknown) => {
    out.destroy(err instanceof Error ? err : new Error(String(err)));
  });
  return out;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

async function* chunksOf(stream: Readable): AsyncGenerator<Buffer> {
  for await (const chunk of stream) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }
}

async function* archiveFrames(entries: AsyncIterable<ArchiveEntry> | ArchiveEntry[]): AsyncGenerator<Buffer> {
  yield ARCHIVE_MAGIC;
  for await (const entry of entries) {
    assertSafeArchivePath(entry.name);
    const nameBuf = Buffer.from(entry.name, 'utf8');
    if (nameBuf.length > 0xffff) {
      throw new BackupArchiveError(`Archive member name too long: ${entry.name}`);
    }
    const chunked = entry.size === undefined;
    yield u16(nameBuf.length);
    yield nameBuf;
    yield Buffer.from([chunked ? 1 : 0]);
    if (!chunked) {
      yield u64(entry.size!);
      let written = 0;
      for await (const chunk of chunksOf(entry.stream)) {
        written += chunk.length;
        yield chunk;
      }
      if (written !== entry.size) {
        throw new BackupArchiveError(
          `Archive member ${entry.name} size mismatch: expected ${entry.size}, got ${written}`,
        );
      }
    } else {
      for await (const chunk of chunksOf(entry.stream)) {
        yield u32(chunk.length);
        yield chunk;
      }
      yield u32(0);
    }
  }
  yield u16(0);
}

export function packArchive(entries: AsyncIterable<ArchiveEntry> | ArchiveEntry[]): Readable {
  return Readable.from(archiveFrames(entries));
}

async function readExactFromIterator(
  iterator: AsyncIterator<Buffer>,
  leftover: { buf: Buffer },
  n: number,
): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let got = 0;
  if (leftover.buf.length) {
    if (leftover.buf.length >= n) {
      const out = leftover.buf.subarray(0, n);
      leftover.buf = leftover.buf.subarray(n);
      return out;
    }
    parts.push(leftover.buf);
    got = leftover.buf.length;
    leftover.buf = Buffer.alloc(0);
  }
  while (got < n) {
    const next = await iterator.next();
    if (next.done) {
      if (got === 0 && parts.length === 0) return null;
      throw new BackupArchiveError('Archive truncated');
    }
    const chunk = next.value;
    const need = n - got;
    if (chunk.length > need) {
      parts.push(chunk.subarray(0, need));
      leftover.buf = chunk.subarray(need);
      got = n;
    } else {
      parts.push(chunk);
      got += chunk.length;
    }
  }
  return Buffer.concat(parts, n);
}

export async function* unpackArchive(
  source: Readable,
): AsyncGenerator<{ name: string; stream: Readable }> {
  const leftover = { buf: Buffer.alloc(0) };
  const iterator = chunksOf(source)[Symbol.asyncIterator]();
  const magic = await readExactFromIterator(iterator, leftover, ARCHIVE_MAGIC.length);
  if (!magic || !magic.equals(ARCHIVE_MAGIC)) {
    throw new BackupArchiveError('Not a Compendiq backup archive');
  }
  for (;;) {
    const nameLenBuf = await readExactFromIterator(iterator, leftover, 2);
    if (!nameLenBuf) throw new BackupArchiveError('Archive truncated at member header');
    const nameLen = nameLenBuf.readUInt16BE(0);
    if (nameLen === 0) {
      if (leftover.buf.length > 0) {
        throw new BackupArchiveError('Archive has trailing data after the terminator');
      }
      const next = await iterator.next();
      if (!next.done) {
        throw new BackupArchiveError('Archive has trailing data after the terminator');
      }
      return;
    }
    const nameBuf = await readExactFromIterator(iterator, leftover, nameLen);
    if (!nameBuf) throw new BackupArchiveError('Archive truncated at member name');
    const name = nameBuf.toString('utf8');
    assertSafeArchivePath(name);
    const flagsBuf = await readExactFromIterator(iterator, leftover, 1);
    if (!flagsBuf) throw new BackupArchiveError('Archive truncated at member flags');
    const chunked = flagsBuf[0] === 1;
    const body = new Transform({
      transform(chunk, _enc, cb) {
        this.push(chunk);
        cb();
      },
    });
    const delivered = (async () => {
      try {
        if (!chunked) {
          const sizeBuf = await readExactFromIterator(iterator, leftover, 8);
          if (!sizeBuf) throw new BackupArchiveError(`Archive truncated at size for ${name}`);
          let remaining = Number(sizeBuf.readBigUInt64BE(0));
          while (remaining > 0) {
            const take = Math.min(remaining, leftover.buf.length || 64 * 1024);
            const chunk = await readExactFromIterator(iterator, leftover, take);
            if (!chunk) throw new BackupArchiveError(`Archive truncated in ${name}`);
            remaining -= chunk.length;
            if (!body.write(chunk)) {
              await new Promise<void>((resolve) => body.once('drain', resolve));
            }
          }
        } else {
          for (;;) {
            const lenBuf = await readExactFromIterator(iterator, leftover, 4);
            if (!lenBuf) throw new BackupArchiveError(`Archive truncated in ${name}`);
            const len = lenBuf.readUInt32BE(0);
            if (len === 0) break;
            const chunk = await readExactFromIterator(iterator, leftover, len);
            if (!chunk) throw new BackupArchiveError(`Archive truncated in ${name}`);
            if (!body.write(chunk)) {
              await new Promise<void>((resolve) => body.once('drain', resolve));
            }
          }
        }
        body.end();
      } catch (err) {
        body.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    })();
    yield { name, stream: body };
    await delivered;
  }
}

export function assertSafeArchivePath(name: string): string {
  if (!name || name.includes('\0')) {
    throw new BackupArchiveError('Invalid archive member name');
  }
  if (name.includes('\\')) {
    throw new BackupArchiveError(`Backslash rejected in archive member name: ${name}`);
  }
  if (path.posix.isAbsolute(name) || name.startsWith('/')) {
    throw new BackupArchiveError(`Absolute path rejected: ${name}`);
  }
  const segments = name.split('/');
  if (segments.some((s) => s === '..' || s === '')) {
    throw new BackupArchiveError(`Path traversal rejected: ${name}`);
  }
  return name;
}

export function resolveAttachmentDest(attachmentsRoot: string, archiveName: string): string {
  const safe = assertSafeArchivePath(archiveName);
  const prefix = 'attachments/';
  if (!safe.startsWith(prefix) || safe.length <= prefix.length) {
    throw new BackupArchiveError(`Not an attachment member: ${archiveName}`);
  }
  const rel = safe.slice(prefix.length);
  const root = path.resolve(attachmentsRoot);
  const dest = path.resolve(root, rel);
  const relToRoot = path.relative(root, dest);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    throw new BackupArchiveError(`Path traversal rejected: ${archiveName}`);
  }
  return dest;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hashingPassThrough(): { stream: Transform; digest: () => string } {
  const hash = createHash('sha256');
  const stream = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      this.push(chunk);
      cb();
    },
  });
  return {
    stream,
    digest: () => hash.digest('hex'),
  };
}

export { AUTH_TAG_LENGTH };
