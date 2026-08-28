import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { runMigrations } from '../db/postgres.js';
import { parseBackupManifest, type BackupManifest } from './backup-manifest.js';
import {
  decryptBackupStream,
  fingerprintPatEncryptionKey,
  resolveAttachmentDest,
  unpackArchive,
  type BackupSecret,
} from './backup-stream.js';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_RESTORE_STDERR_BYTES = 4096;

export class BackupRestoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BackupRestoreError';
  }
}

export interface StageBackupOptions {
  encrypted: Readable;
  secret: BackupSecret;
  attachmentsRoot: string;
  force?: boolean;
  newestMigration?: string;
}

export interface CommitBackupOptions {
  attachmentsRoot: string;
  postgresUrl: string;
  spawnFn?: typeof spawn;
  runMigrationsFn?: () => Promise<void>;
}

export interface ValidatedBackupStage {
  root: string;
  dumpPath: string;
  attachmentsPath: string;
  manifest: BackupManifest;
}

export interface RestoreOptions extends StageBackupOptions, CommitBackupOptions {
  dryRun?: boolean;
}

interface StagedMember {
  checksum: string;
  size: number;
}

async function newestShippedMigration(): Promise<string> {
  const migrationsDir = path.join(__dirname, '../db/migrations');
  const migrations = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  const newest = migrations.at(-1);
  if (!newest) throw new BackupRestoreError('No shipped database migrations were found');
  return newest;
}

async function drain(stream: Readable): Promise<void> {
  await pipeline(
    stream,
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
}

async function stageMember(stream: Readable, destination: string): Promise<StagedMember> {
  await mkdir(path.dirname(destination), { recursive: true });
  const hash = createHash('sha256');
  let size = 0;
  const inspect = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      this.push(chunk);
      callback();
    },
  });
  await pipeline(stream, inspect, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  return { checksum: hash.digest('hex'), size };
}

async function readManifest(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_MANIFEST_BYTES) {
        oversized = true;
      } else if (!oversized) {
        chunks.push(Buffer.from(chunk));
      }
      callback();
    },
    flush(callback) {
      callback(
        oversized
          ? new BackupRestoreError(`Backup manifest is too large (limit ${MAX_MANIFEST_BYTES} bytes)`)
          : undefined,
      );
    },
  });
  await pipeline(stream, bounded);
  return Buffer.concat(chunks, size).toString('utf8');
}

function assertExactChecksumSet(actualNames: string[], expectedNames: Set<string>): void {
  const actual = new Set(actualNames);
  const missing = [...expectedNames].filter((name) => !actual.has(name));
  const extra = [...actual].filter((name) => !expectedNames.has(name));
  if (missing.length === 0 && extra.length === 0) return;

  const details = [
    missing.length > 0 ? `missing: ${missing.join(', ')}` : undefined,
    extra.length > 0 ? `extra: ${extra.join(', ')}` : undefined,
  ].filter(Boolean);
  throw new BackupRestoreError(`Backup manifest checksum set mismatch (${details.join('; ')})`);
}

export async function stageAndValidateBackup(
  opts: StageBackupOptions,
): Promise<ValidatedBackupStage> {
  const attachmentsRoot = path.resolve(opts.attachmentsRoot);
  const stagingParent = path.dirname(attachmentsRoot);
  await mkdir(stagingParent, { recursive: true });
  const root = await mkdtemp(path.join(stagingParent, '.compendiq-restore-'));
  await chmod(root, 0o700);
  const dumpPath = path.join(root, 'database.dump');
  const attachmentsPath = path.join(root, 'attachments');
  await mkdir(attachmentsPath, { recursive: true, mode: 0o700 });

  try {
    const seen = new Set<string>();
    const staged = new Map<string, StagedMember>();
    const attachmentNames: string[] = [];
    let manifestRaw: string | undefined;
    let memberError: BackupRestoreError | undefined;
    const decrypted = decryptBackupStream(opts.encrypted, opts.secret);

    for await (const member of unpackArchive(decrypted)) {
      if (seen.has(member.name)) {
        memberError ??= new BackupRestoreError(`Duplicate archive member: ${member.name}`);
        await drain(member.stream);
        continue;
      }
      seen.add(member.name);

      if (member.name === 'manifest.json') {
        manifestRaw = await readManifest(member.stream);
        continue;
      }
      if (member.name === 'database.dump') {
        staged.set(member.name, await stageMember(member.stream, dumpPath));
        continue;
      }
      if (member.name.startsWith('attachments/')) {
        const destination = resolveAttachmentDest(attachmentsPath, member.name);
        staged.set(member.name, await stageMember(member.stream, destination));
        attachmentNames.push(member.name);
        continue;
      }

      memberError ??= new BackupRestoreError(`Unknown archive member: ${member.name}`);
      await drain(member.stream);
    }

    if (memberError) throw memberError;
    if (!seen.has('database.dump')) {
      throw new BackupRestoreError('Backup is missing database.dump');
    }
    if (manifestRaw === undefined) {
      throw new BackupRestoreError('Backup is missing manifest.json');
    }

    const manifest = parseBackupManifest(manifestRaw);
    const expectedNames = new Set(['database.dump', ...attachmentNames]);
    assertExactChecksumSet(Object.keys(manifest.checksums), expectedNames);

    for (const name of expectedNames) {
      const actual = staged.get(name);
      if (!actual || actual.checksum !== manifest.checksums[name]) {
        throw new BackupRestoreError(`Checksum mismatch for archive member ${name}`);
      }
    }

    const database = staged.get('database.dump')!;
    if (database.size !== manifest.databaseSizeBytes) {
      throw new BackupRestoreError(
        `Database dump size mismatch: manifest ${manifest.databaseSizeBytes}, staged ${database.size}`,
      );
    }

    const hostFingerprint = fingerprintPatEncryptionKey(process.env.PAT_ENCRYPTION_KEY ?? '');
    if (manifest.patEncryptionKeyFingerprint !== hostFingerprint && !opts.force) {
      throw new BackupRestoreError(
        `PAT_ENCRYPTION_KEY fingerprint mismatch (archive ${manifest.patEncryptionKeyFingerprint}, host ${hostFingerprint}). Pass --force to override.`,
      );
    }

    const newestMigration = opts.newestMigration ?? (await newestShippedMigration());
    if (manifest.schemaMigration > newestMigration) {
      throw new BackupRestoreError(
        `Backup migration ${manifest.schemaMigration} is newer than this binary (${newestMigration})`,
      );
    }

    return { root, dumpPath, attachmentsPath, manifest };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function pgRestoreExit(child: ChildProcess): Promise<void> {
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr?.on('data', (chunk: Buffer | string) => {
    const available = MAX_RESTORE_STDERR_BYTES - stderrBytes;
    if (available <= 0) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const retained = Buffer.from(buffer.subarray(0, available));
    stderrChunks.push(retained);
    stderrBytes += retained.length;
  });

  let code: number | null;
  try {
    [code] = (await once(child, 'close')) as [number | null];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BackupRestoreError(`pg_restore failed to start: ${message}`, { cause: error });
  }
  if (code === 0) return;

  const stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8');
  throw new BackupRestoreError(`pg_restore exited ${String(code)}: ${stderr}`);
}

async function restoreDatabase(
  dumpPath: string,
  postgresUrl: string,
  spawnFn: typeof spawn,
): Promise<void> {
  const child = spawnFn(
    'pg_restore',
    [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-acl',
      '--single-transaction',
      `--dbname=${postgresUrl}`,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  if (!child.stdin) throw new BackupRestoreError('pg_restore stdin is not piped');

  const [streamed, exited] = await Promise.allSettled([
    pipeline(createReadStream(dumpPath), child.stdin),
    pgRestoreExit(child),
  ]);
  if (exited.status === 'rejected') throw exited.reason;
  if (streamed.status === 'rejected') {
    throw new BackupRestoreError(`Failed to stream database dump to pg_restore: ${streamed.reason}`, {
      cause: streamed.reason,
    });
  }
}

async function restoreAttachmentsAfterFailure(
  attachmentsRoot: string,
  rollbackPath: string,
  hasRollback: boolean,
): Promise<void> {
  await rm(attachmentsRoot, { recursive: true, force: true });
  if (hasRollback) await rename(rollbackPath, attachmentsRoot);
}

export async function commitValidatedBackup(
  stage: ValidatedBackupStage,
  opts: CommitBackupOptions,
): Promise<void> {
  const attachmentsRoot = path.resolve(opts.attachmentsRoot);
  const rollbackPath = `${attachmentsRoot}.restore-backup-${randomUUID()}`;
  let hasRollback = false;

  try {
    await rename(attachmentsRoot, rollbackPath);
    hasRollback = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  try {
    await rename(stage.attachmentsPath, attachmentsRoot);
  } catch (error) {
    if (hasRollback) await rename(rollbackPath, attachmentsRoot);
    throw error;
  }

  try {
    await restoreDatabase(stage.dumpPath, opts.postgresUrl, opts.spawnFn ?? spawn);
  } catch (error) {
    try {
      await restoreAttachmentsAfterFailure(attachmentsRoot, rollbackPath, hasRollback);
    } catch (rollbackError) {
      throw new BackupRestoreError(
        `${error instanceof Error ? error.message : String(error)}; attachment rollback failed. Previous attachments remain at ${rollbackPath}`,
        { cause: rollbackError },
      );
    }
    throw error;
  }

  try {
    await (opts.runMigrationsFn ?? runMigrations)();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BackupRestoreError(
      `Database restore succeeded but migrations failed: ${message}. Attachment rollback retained at ${rollbackPath}; restore staging retained at ${stage.root}`,
      { cause: error },
    );
  }

  if (hasRollback) await rm(rollbackPath, { recursive: true, force: true });
  await rm(stage.root, { recursive: true, force: true });
}

export async function restoreBackup(opts: RestoreOptions): Promise<BackupManifest> {
  const stage = await stageAndValidateBackup(opts);
  if (opts.dryRun) {
    await rm(stage.root, { recursive: true, force: true });
    return stage.manifest;
  }

  await commitValidatedBackup(stage, opts);
  return stage.manifest;
}
