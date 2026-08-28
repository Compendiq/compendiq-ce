import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encryptBackupStream, packArchive } from './backup-stream.js';
import { restoreBackup } from './backup-restore.js';

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const MASTER = { kind: 'master' as const, keyMaterial: 'backup-master-key-at-least-32-chars!!' };

describe('restoreBackup', () => {
  it('dry-run decrypts and returns the manifest', async () => {
    process.env.PAT_ENCRYPTION_KEY = 'pat-key-at-least-32-characters!!!!';
    const manifest = {
      version: 1,
      createdAt: '2026-08-28T00:00:00.000Z',
      schemaMigration: '107_backup_settings.sql',
      patEncryptionKeyFingerprint: (await import('./backup-stream.js')).fingerprintPatEncryptionKey(
        process.env.PAT_ENCRYPTION_KEY,
      ),
      databaseSizeBytes: 4,
      checksums: {},
      format: 'cpqarc1',
    };
    const json = Buffer.from(JSON.stringify(manifest));
    const packed = packArchive([
      { name: 'database.dump', stream: Readable.from([Buffer.from('DUMP')]) },
      { name: 'manifest.json', size: json.length, stream: Readable.from([json]) },
    ]);
    const encrypted = encryptBackupStream(packed, MASTER);
    const buf = await readAll(encrypted);
    const result = await restoreBackup({
      encrypted: Readable.from([buf]),
      secret: MASTER,
      attachmentsRoot: '/tmp/unused',
      postgresUrl: 'postgres://unused',
      dryRun: true,
    });
    expect(result.schemaMigration).toBe('107_backup_settings.sql');
  });

  it('refuses a fingerprint mismatch unless force is set', async () => {
    process.env.PAT_ENCRYPTION_KEY = 'pat-key-at-least-32-characters!!!!';
    const manifest = {
      version: 1,
      createdAt: '2026-08-28T00:00:00.000Z',
      schemaMigration: '107_backup_settings.sql',
      patEncryptionKeyFingerprint: 'sha256:deadbeefdeadbeefdeadbeefdeadbeef',
      databaseSizeBytes: 0,
      checksums: {},
      format: 'cpqarc1',
    };
    const json = Buffer.from(JSON.stringify(manifest));
    const packed = packArchive([
      { name: 'manifest.json', size: json.length, stream: Readable.from([json]) },
    ]);
    const buf = await readAll(encryptBackupStream(packed, MASTER));
    await expect(
      restoreBackup({
        encrypted: Readable.from([buf]),
        secret: MASTER,
        attachmentsRoot: '/tmp/unused',
        postgresUrl: 'postgres://unused',
        dryRun: true,
      }),
    ).rejects.toThrow(/fingerprint/i);
  });

  it('writes attachment members under the destination root', async () => {
    process.env.PAT_ENCRYPTION_KEY = 'pat-key-at-least-32-characters!!!!';
    const { fingerprintPatEncryptionKey } = await import('./backup-stream.js');
    const manifest = {
      version: 1 as const,
      createdAt: '2026-08-28T00:00:00.000Z',
      schemaMigration: '107_backup_settings.sql',
      patEncryptionKeyFingerprint: fingerprintPatEncryptionKey(process.env.PAT_ENCRYPTION_KEY),
      databaseSizeBytes: 0,
      checksums: {},
      format: 'cpqarc1' as const,
    };
    const json = Buffer.from(JSON.stringify(manifest));
    const packed = packArchive([
      { name: 'attachments/local/1/a.txt', size: 3, stream: Readable.from([Buffer.from('abc')]) },
      { name: 'manifest.json', size: json.length, stream: Readable.from([json]) },
    ]);
    const buf = await readAll(encryptBackupStream(packed, MASTER));
    const root = await mkdtemp(path.join(os.tmpdir(), 'cq-restore-'));
    try {
      await restoreBackup({
        encrypted: Readable.from([buf]),
        secret: MASTER,
        attachmentsRoot: root,
        postgresUrl: 'postgres://unused',
        dryRun: false,
        spawnFn: ((..._args: unknown[]) => {
          throw new Error('pg_restore should not run — no dump member');
        }) as typeof import('node:child_process').spawn,
      });
      const written = await readFile(path.join(root, 'local/1/a.txt'), 'utf8');
      expect(written).toBe('abc');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
