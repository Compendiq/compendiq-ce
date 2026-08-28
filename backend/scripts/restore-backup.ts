/**
 * Restore a Compendiq encrypted backup (#1420).
 *
 * Run outside the live Fastify process:
 *   npx tsx scripts/restore-backup.ts --file backup.enc [--passphrase '...'] [--dry-run] [--force]
 *
 * Encryption key: --passphrase, or BACKUP_ENCRYPTION_KEY (master).
 * Database: POSTGRES_URL. Attachments: ATTACHMENTS_DIR (default data/attachments).
 */

import { createReadStream } from 'node:fs';
import { resolveBackupSecret } from '../src/core/services/backup-service.js';
import { restoreBackup } from '../src/core/services/backup-restore.js';
import path from 'node:path';

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
    process.exit(2);
  }
  const passphrase = arg('--passphrase');
  const secret = resolveBackupSecret(passphrase);
  const postgresUrl = process.env.POSTGRES_URL;
  if (!postgresUrl && !hasFlag('--dry-run')) {
    console.error('POSTGRES_URL is required unless --dry-run');
    process.exit(2);
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

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
