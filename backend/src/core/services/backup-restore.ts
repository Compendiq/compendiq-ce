import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  decryptBackupStream,
  fingerprintPatEncryptionKey,
  resolveAttachmentDest,
  unpackArchive,
  type BackupManifest,
  type BackupSecret,
} from './backup-stream.js';

export class BackupRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupRestoreError';
  }
}

export interface RestoreOptions {
  encrypted: Readable;
  secret: BackupSecret;
  attachmentsRoot: string;
  postgresUrl: string;
  dryRun?: boolean;
  force?: boolean;
  spawnFn?: typeof spawn;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function spawnPgRestore(postgresUrl: string, spawnFn: typeof spawn): ChildProcess {
  return spawnFn(
    'pg_restore',
    ['--clean', '--if-exists', '--no-owner', '--no-acl', `--dbname=${postgresUrl}`],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
}

export async function restoreBackup(opts: RestoreOptions): Promise<BackupManifest> {
  const decrypted = decryptBackupStream(opts.encrypted, opts.secret);
  let manifest: BackupManifest | null = null;
  const spawnFn = opts.spawnFn ?? spawn;

  for await (const member of unpackArchive(decrypted)) {
    if (member.name === 'manifest.json') {
      manifest = JSON.parse((await readAll(member.stream)).toString('utf8')) as BackupManifest;
      continue;
    }
    if (member.name === 'database.dump') {
      if (opts.dryRun) {
        await readAll(member.stream);
        continue;
      }
      const child = spawnPgRestore(opts.postgresUrl, spawnFn);
      if (!child.stdin) throw new BackupRestoreError('pg_restore stdin is not piped');
      const stderrChunks: Buffer[] = [];
      child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));
      const exit = new Promise<void>((resolve, reject) => {
        child.on('error', (err) => reject(new BackupRestoreError(`pg_restore failed to start: ${err.message}`)));
        child.on('close', (code) => {
          if (code === 0 || code === null) resolve();
          else {
            reject(
              new BackupRestoreError(
                `pg_restore exited ${code}: ${Buffer.concat(stderrChunks).toString('utf8').slice(0, 500)}`,
              ),
            );
          }
        });
      });
      await pipeline(member.stream, child.stdin);
      await exit;
      continue;
    }
    const dest = resolveAttachmentDest(opts.attachmentsRoot, member.name);
    if (opts.dryRun) {
      await readAll(member.stream);
      continue;
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await pipeline(member.stream, createWriteStream(dest));
  }

  if (!manifest) throw new BackupRestoreError('Backup is missing manifest.json');
  const expected = fingerprintPatEncryptionKey(process.env.PAT_ENCRYPTION_KEY ?? '');
  if (manifest.patEncryptionKeyFingerprint !== expected && !opts.force) {
    throw new BackupRestoreError(
      `PAT_ENCRYPTION_KEY fingerprint mismatch (archive ${manifest.patEncryptionKeyFingerprint}, host ${expected}). Pass --force to override.`,
    );
  }
  return manifest;
}
