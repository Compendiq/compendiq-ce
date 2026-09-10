/**
 * Restore a Compendiq encrypted backup (#1420).
 *
 * Run outside the live Fastify process. Prefer BACKUP_PASSPHRASE so the
 * passphrase is not exposed in the process list:
 *   BACKUP_PASSPHRASE='...' npx tsx scripts/restore-backup.ts --file backup.enc [--dry-run] [--force]
 *
 * The compatibility form `--passphrase '...'` remains supported. Without
 * either passphrase input, BACKUP_ENCRYPTION_KEY supplies the master key.
 * Database: POSTGRES_URL. Attachments: ATTACHMENTS_DIR (default data/attachments).
 */

import { createReadStream } from 'node:fs';
import path from 'node:path';
import { closePool } from '../src/core/db/postgres.js';
import { resolveBackupSecret } from '../src/core/services/backup-service.js';
import { restoreBackup } from '../src/core/services/backup-restore.js';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const file = arg('--file');
  if (!file) {
    console.error(
      'Usage: restore-backup --file <path.enc> [--passphrase <str>] [--dry-run] [--force]',
    );
    process.exitCode = 2;
    return;
  }
  const passphrase = arg('--passphrase') ?? process.env.BACKUP_PASSPHRASE;
  const secret = resolveBackupSecret(passphrase);
  const postgresUrl = process.env.POSTGRES_URL;
  if (!postgresUrl && !hasFlag('--dry-run')) {
    console.error('POSTGRES_URL is required unless --dry-run');
    process.exitCode = 2;
    return;
  }
  const attachmentsRoot = path.resolve(process.env.ATTACHMENTS_DIR ?? 'data/attachments');
  const manifest = await restoreBackup({
    encrypted: createReadStream(file),
    secret,
    attachmentsRoot,
    postgresUrl: postgresUrl ?? '',
    dryRun: hasFlag('--dry-run'),
    force: hasFlag('--force'),
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: hasFlag('--dry-run'),
        schemaMigration: manifest.schemaMigration,
        createdAt: manifest.createdAt,
        patFingerprint: manifest.patEncryptionKeyFingerprint,
      },
      null,
      2,
    ),
  );
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    try {
      await closePool();
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}

void run();
