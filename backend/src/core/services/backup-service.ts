import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { PoolClient } from 'pg';
import { getPool, query } from '../db/postgres.js';
import { ATTACHMENT_SNAPSHOT_LOCK_ID } from '../db/advisory-locks.js';
import { logger } from '../utils/logger.js';
import {
  acquireWorkerLock,
  isWorkerLocked,
  refreshWorkerLock,
  releaseWorkerLock,
} from './redis-cache.js';
import type { BackupManifest } from './backup-manifest.js';
import {
  encryptBackupStream,
  fingerprintPatEncryptionKey,
  hashingPassThrough,
  packArchive,
  type ArchiveEntry,
  type BackupSecret,
} from './backup-stream.js';
import {
  getBackupRuntimeConfig,
  hasMasterBackupKey,
  markBackupLastRun,
  requireMasterBackupKey,
} from './backup-settings.js';
import { objectKeyFor, pruneBackupObjects, uploadBackupObject, type S3Target } from './backup-s3.js';

export const BACKUP_LOCK_NAME = 'backup';
const LOCK_TTL_SECONDS = 3600;
const LOCK_REFRESH_MS = 60_000;

export class BackupLockError extends Error {
  constructor() {
    super('A backup is already running');
    this.name = 'BackupLockError';
  }
}

export class BackupDumpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupDumpError';
  }
}

export interface EncryptedBackupStream {
  stream: Readable;
  filename: string;
}

export function attachmentsRoot(): string {
  return path.resolve(process.env.ATTACHMENTS_DIR ?? 'data/attachments');
}

export function backupFilename(date = new Date()): string {
  const stamp = date.toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `compendiq-backup-${stamp}.enc`;
}

export function resolveBackupSecret(passphrase?: string): BackupSecret {
  if (passphrase && passphrase.length >= 12) {
    return { kind: 'passphrase', passphrase };
  }
  if (hasMasterBackupKey()) {
    return { kind: 'master', keyMaterial: requireMasterBackupKey() };
  }
  throw new Error('Provide a passphrase of at least 12 characters, or set BACKUP_ENCRYPTION_KEY');
}

export async function latestSchemaMigration(): Promise<string> {
  const result = await query<{ name: string }>(
    `SELECT name FROM _migrations ORDER BY name DESC LIMIT 1`,
  );
  return result.rows[0]?.name ?? 'unknown';
}

interface AttachmentFile {
  abs: string;
  rel: string;
  size: number;
}

export interface SnapshotPool {
  connect(): Promise<PoolClient>;
}

export interface ExportedBackupSnapshot {
  client: PoolClient;
  snapshotId: string;
  close(): Promise<void>;
}

export async function exportPostgresSnapshot(
  pool: SnapshotPool = getPool(),
): Promise<ExportedBackupSnapshot> {
  const client = await pool.connect();
  let began = false;
  let lockAcquired = false;

  const closeClient = async (transactionCommand?: 'COMMIT' | 'ROLLBACK'): Promise<void> => {
    let discardClient: Error | undefined;
    try {
      if (transactionCommand) await client.query(transactionCommand);
    } finally {
      try {
        if (lockAcquired) {
          await client.query('SELECT pg_advisory_unlock($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
          lockAcquired = false;
        }
      } catch (error) {
        discardClient = error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        try {
          await client.query('RESET statement_timeout');
        } catch (error) {
          discardClient ??= error instanceof Error ? error : new Error(String(error));
          throw error;
        } finally {
          client.release(discardClient);
        }
      }
    }
  };

  try {
    await client.query('SET statement_timeout = 0');
    await client.query('SELECT pg_advisory_lock($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
    lockAcquired = true;
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    began = true;
    const result = await client.query<{ snapshot?: string }>(
      'SELECT pg_export_snapshot() AS snapshot',
    );
    const snapshotId = result.rows[0]?.snapshot;
    if (!snapshotId) throw new BackupDumpError('PostgreSQL did not return an exported snapshot');

    let closed = false;
    return {
      client,
      snapshotId,
      async close() {
        if (closed) return;
        closed = true;
        await closeClient('COMMIT');
      },
    };
  } catch (error) {
    await closeClient(began ? 'ROLLBACK' : undefined);
    throw error;
  }
}

async function listAttachmentFiles(root: string): Promise<AttachmentFile[]> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const files: AttachmentFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const abs = path.join(entry.parentPath ?? root, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (rel.split('/').includes('..')) continue;
      const st = await stat(abs);
      files.push({ abs, rel, size: st.size });
    }
    files.sort((a, b) => a.rel.localeCompare(b.rel));
    return files;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
}

export function spawnPgDump(
  postgresUrl: string,
  spawnFn: typeof spawn = spawn,
  snapshot?: string,
): ChildProcess {
  const snapshotArgs = snapshot ? [`--snapshot=${snapshot}`] : [];
  return spawnFn(
    'pg_dump',
    ['--format=custom', '--no-owner', '--no-acl', ...snapshotArgs, `--dbname=${postgresUrl}`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

interface PgDumpLifecycle {
  closed: boolean;
  closePromise: Promise<void>;
  termination?: Promise<void>;
}

const pgDumpLifecycles = new WeakMap<ChildProcess, PgDumpLifecycle>();

function pgDumpLifecycle(child: ChildProcess): PgDumpLifecycle {
  const existing = pgDumpLifecycles.get(child);
  if (existing) return existing;
  let markClosed: (() => void) | undefined;
  const closePromise = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const lifecycle: PgDumpLifecycle = {
    closed: false,
    closePromise,
  };
  child.once('close', () => {
    lifecycle.closed = true;
    markClosed?.();
  });
  pgDumpLifecycles.set(child, lifecycle);
  return lifecycle;
}

function gracePeriod(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export function terminatePgDumpAndWait(
  child: ChildProcess,
  graceMs = 5_000,
): Promise<void> {
  const lifecycle = pgDumpLifecycle(child);
  if (lifecycle.closed) return Promise.resolve();
  if (lifecycle.termination) return lifecycle.termination;
  lifecycle.termination = (async () => {
    child.kill('SIGTERM');
    await Promise.race([lifecycle.closePromise, gracePeriod(graceMs)]);
    if (!lifecycle.closed) {
      child.kill('SIGKILL');
      await lifecycle.closePromise;
    }
  })();
  return lifecycle.termination;
}

export function dumpStreamFromProcess(child: ChildProcess): Readable {
  if (!child.stdout) throw new BackupDumpError('pg_dump stdout is not piped');
  const lifecycle = pgDumpLifecycle(child);

  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  let stdoutEnded = false;
  let childClosed = false;
  let exitCode: number | null = null;
  let completed = false;
  let cancellationStarted = false;
  let exitError: BackupDumpError | undefined;

  const updateExitError = () => {
    if (exitError) {
      exitError.message = `pg_dump exited ${exitCode}: ${Buffer.concat(stderrChunks, stderrBytes).toString('utf8')}`;
    }
  };

  const out = new Transform({
    transform(chunk, _enc, cb) {
      this.push(chunk);
      cb();
    },
  });

  const maybeComplete = () => {
    if (stdoutEnded && childClosed && exitCode === 0) {
      completed = true;
      out.end();
    }
  };

  child.stderr?.on('data', (chunk: Buffer | string) => {
    const remaining = 4096 - stderrBytes;
    if (remaining > 0) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const retained = Buffer.from(buffer.subarray(0, remaining));
      stderrChunks.push(retained);
      stderrBytes += retained.length;
      updateExitError();
    }
  });

  child.stdout.on('data', (chunk: Buffer) => {
    if (!out.write(chunk)) child.stdout?.pause();
  });
  out.on('drain', () => child.stdout?.resume());
  child.stdout.on('end', () => {
    stdoutEnded = true;
    maybeComplete();
  });
  child.stdout.on('error', (err) => {
    out.destroy(new BackupDumpError(`pg_dump stdout failed: ${err.message}`));
  });
  child.on('error', (err) => {
    out.destroy(new BackupDumpError(`pg_dump failed to start: ${err.message}`));
  });
  child.on('close', (code) => {
    childClosed = true;
    exitCode = code;
    if (code !== 0 && !cancellationStarted && !lifecycle.termination) {
      exitError = new BackupDumpError('');
      updateExitError();
      out.destroy(exitError);
      return;
    }
    maybeComplete();
  });
  out.on('close', () => {
    if (completed || cancellationStarted || lifecycle.closed) return;
    cancellationStarted = true;
    child.stdout?.destroy();
    void terminatePgDumpAndWait(child);
  });

  return out;
}

async function* backupMembers(dump: Readable, files: AttachmentFile[], meta: {
  schemaMigration: string;
  patFingerprint: string;
  createdAt: string;
}): AsyncGenerator<ArchiveEntry> {
  const dumpHash = hashingPassThrough();
  let dumpBytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      dumpBytes += (chunk as Buffer).length;
      this.push(chunk);
      cb();
    },
  });
  yield { name: 'database.dump', stream: dump.pipe(dumpHash.stream).pipe(counter) };

  const checksums: Record<string, string> = {
    'database.dump': dumpHash.digest(),
  };

  for (const file of files) {
    const hash = hashingPassThrough();
    yield {
      name: `attachments/${file.rel}`,
      size: file.size,
      stream: createReadStream(file.abs).pipe(hash.stream),
    };
    checksums[`attachments/${file.rel}`] = hash.digest();
  }

  const manifest: BackupManifest = {
    version: 1,
    createdAt: meta.createdAt,
    schemaMigration: meta.schemaMigration,
    patEncryptionKeyFingerprint: meta.patFingerprint,
    databaseSizeBytes: dumpBytes,
    checksums,
    format: 'cpqarc1',
  };
  const json = Buffer.from(JSON.stringify(manifest), 'utf8');
  yield { name: 'manifest.json', size: json.length, stream: Readable.from([json]) };
}

export async function isBackupLockHeld(): Promise<boolean> {
  return isWorkerLocked(BACKUP_LOCK_NAME);
}


export interface CreateEncryptedBackupOptions {
  spawnFn?: typeof spawn;
  attachmentsRoot?: string;
  snapshotPool?: SnapshotPool;
}
export async function createEncryptedBackupStream(
  secret: BackupSecret,
  options: CreateEncryptedBackupOptions = {},
): Promise<EncryptedBackupStream> {
  const token = await acquireWorkerLock(BACKUP_LOCK_NAME, LOCK_TTL_SECONDS, { failClosed: true });
  if (!token) throw new BackupLockError();

  let child: ChildProcess | undefined;
  let snapshot: ExportedBackupSnapshot | undefined;
  const timer = setInterval(() => {
    refreshWorkerLock(BACKUP_LOCK_NAME, token, LOCK_TTL_SECONDS).catch((err: unknown) => {
      logger.warn({ err }, 'Failed to refresh backup lock');
    });
  }, LOCK_REFRESH_MS);
  timer.unref();

  let releasePromise: Promise<void> | undefined;
  const release = () => {
    if (releasePromise) return releasePromise;
    clearInterval(timer);
    releasePromise = (async () => {
      try {
        if (child) await terminatePgDumpAndWait(child);
      } finally {
        try {
          await snapshot?.close();
        } finally {
          await releaseWorkerLock(BACKUP_LOCK_NAME, token);
        }
      }
    })();
    return releasePromise;
  };

  try {
    const postgresUrl = process.env.POSTGRES_URL;
    if (!postgresUrl) throw new BackupDumpError('POSTGRES_URL is not set');

    const filename = backupFilename();
    const createdAt = new Date().toISOString();
    const schemaMigration = await latestSchemaMigration();
    const patFingerprint = fingerprintPatEncryptionKey(process.env.PAT_ENCRYPTION_KEY ?? '');
    snapshot = await exportPostgresSnapshot(options.snapshotPool);
    const files = await listAttachmentFiles(options.attachmentsRoot ?? attachmentsRoot());
    child = spawnPgDump(postgresUrl, options.spawnFn ?? spawn, snapshot.snapshotId);
    const dump = dumpStreamFromProcess(child);
    const packed = packArchive(backupMembers(dump, files, { schemaMigration, patFingerprint, createdAt }));
    const encrypted = encryptBackupStream(packed, secret);
    encrypted.once('close', () => {
      void release().catch((err: unknown) => logger.error({ err }, 'Failed to release backup resources'));
    });
    encrypted.once('error', () => {
      void release().catch((err: unknown) => logger.error({ err }, 'Failed to release backup resources'));
    });
    return { stream: encrypted, filename };
  } catch (err) {
    await release();
    throw err;
  }
}

export async function insertBackupRun(row: {
  destination: 'download' | 's3';
  triggeredBy: string | null;
}): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO backup_runs (destination, status, triggered_by)
     VALUES ($1, 'running', $2)
     RETURNING id`,
    [row.destination, row.triggeredBy],
  );
  return result.rows[0]!.id;
}

export async function finishBackupRun(
  id: string,
  update: { status: 'success' | 'failed'; bytes?: number; objectKey?: string; error?: string },
): Promise<void> {
  await query(
    `UPDATE backup_runs
        SET status = $2,
            finished_at = NOW(),
            bytes = COALESCE($3, bytes),
            object_key = COALESCE($4, object_key),
            error = $5
      WHERE id = $1`,
    [id, update.status, update.bytes ?? null, update.objectKey ?? null, update.error ?? null],
  );
}

export async function listBackupRuns(limit = 20): Promise<Array<{
  id: string;
  createdAt: string;
  finishedAt: string | null;
  destination: 'download' | 's3';
  status: 'running' | 'success' | 'failed';
  bytes: number | null;
  objectKey: string | null;
  error: string | null;
  triggeredBy: string | null;
}>> {
  const result = await query<{
    id: string;
    created_at: Date;
    finished_at: Date | null;
    destination: 'download' | 's3';
    status: 'running' | 'success' | 'failed';
    bytes: string | null;
    object_key: string | null;
    error: string | null;
    triggered_by: string | null;
  }>(
    `SELECT id, created_at, finished_at, destination, status, bytes, object_key, error, triggered_by
       FROM backup_runs
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
    destination: r.destination,
    status: r.status,
    bytes: r.bytes === null ? null : Number(r.bytes),
    objectKey: r.object_key,
    error: r.error,
    triggeredBy: r.triggered_by,
  }));
}

export async function runS3Backup(triggeredBy: string | null): Promise<string> {
  const cfg = await getBackupRuntimeConfig();
  if (!cfg.s3.enabled || !cfg.s3.bucket || !cfg.s3.endpoint) {
    throw new Error('S3 backup is not configured');
  }
  const secret: BackupSecret = { kind: 'master', keyMaterial: requireMasterBackupKey() };
  const runId = await insertBackupRun({ destination: 's3', triggeredBy });
  try {
    const { stream, filename } = await createEncryptedBackupStream(secret);
    const target: S3Target = {
      endpoint: cfg.s3.endpoint,
      bucket: cfg.s3.bucket,
      region: cfg.s3.region,
      accessKey: cfg.s3.accessKey,
      secretKey: cfg.s3.secretKey,
      prefix: cfg.s3.prefix,
      forcePathStyle: cfg.s3.forcePathStyle,
    };
    const key = objectKeyFor(cfg.s3.prefix);
    const uploaded = await uploadBackupObject(target, key, stream);
    const pruned = await pruneBackupObjects(target, cfg.schedule.retentionCount, cfg.schedule.retentionDays);
    if (pruned.length) logger.info({ pruned }, 'Pruned expired S3 backups');
    await finishBackupRun(runId, {
      status: 'success',
      bytes: uploaded.bytes,
      objectKey: uploaded.key,
    });
    await markBackupLastRun(new Date().toISOString());
    return filename;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishBackupRun(runId, { status: 'failed', error: message });
    throw err;
  }
}

export async function isBackupDue(now = new Date()): Promise<boolean> {
  const cfg = await getBackupRuntimeConfig();
  if (!cfg.schedule.enabled || !cfg.s3.enabled) return false;
  if (!cfg.schedule.lastRunAt) return true;
  const last = Date.parse(cfg.schedule.lastRunAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= cfg.schedule.intervalHours * 60 * 60 * 1000;
}
