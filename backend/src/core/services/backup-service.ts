import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import {
  acquireWorkerLock,
  isWorkerLocked,
  refreshWorkerLock,
  releaseWorkerLock,
} from './redis-cache.js';
import {
  encryptBackupStream,
  fingerprintPatEncryptionKey,
  hashingPassThrough,
  packArchive,
  type ArchiveEntry,
  type BackupManifest,
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
  const result = await query<{ filename: string }>(
    `SELECT filename FROM _migrations ORDER BY filename DESC LIMIT 1`,
  );
  return result.rows[0]?.filename ?? 'unknown';
}

interface AttachmentFile {
  abs: string;
  rel: string;
  size: number;
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
): ChildProcess {
  return spawnFn(
    'pg_dump',
    ['--format=custom', '--no-owner', '--no-acl', `--dbname=${postgresUrl}`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function dumpStreamFromProcess(child: ChildProcess): Readable {
  if (!child.stdout) throw new BackupDumpError('pg_dump stdout is not piped');
  const stderrChunks: Buffer[] = [];
  child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));
  const out = new Transform({
    transform(chunk, _enc, cb) {
      this.push(chunk);
      cb();
    },
  });
  child.stdout.pipe(out);
  child.on('error', (err) => {
    out.destroy(new BackupDumpError(`pg_dump failed to start: ${err.message}`));
  });
  child.on('close', (code) => {
    if (code !== 0 && code !== null) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, 500);
      out.destroy(new BackupDumpError(`pg_dump exited ${code}: ${stderr}`));
    }
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

export async function createEncryptedBackupStream(secret: BackupSecret): Promise<{
  stream: Readable;
  filename: string;
}> {
  const token = await acquireWorkerLock(BACKUP_LOCK_NAME, LOCK_TTL_SECONDS, { failClosed: true });
  if (!token) throw new BackupLockError();

  let child: ChildProcess | undefined;
  const timer = setInterval(() => {
    refreshWorkerLock(BACKUP_LOCK_NAME, token, LOCK_TTL_SECONDS).catch((err: unknown) => {
      logger.warn({ err }, 'Failed to refresh backup lock');
    });
  }, LOCK_REFRESH_MS);
  timer.unref();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    child?.kill('SIGTERM');
    void releaseWorkerLock(BACKUP_LOCK_NAME, token);
  };

  try {
    const postgresUrl = process.env.POSTGRES_URL;
    if (!postgresUrl) throw new BackupDumpError('POSTGRES_URL is not set');

    const filename = backupFilename();
    const createdAt = new Date().toISOString();
    const schemaMigration = await latestSchemaMigration();
    const patFingerprint = fingerprintPatEncryptionKey(process.env.PAT_ENCRYPTION_KEY ?? '');
    const files = await listAttachmentFiles(attachmentsRoot());
    child = spawnPgDump(postgresUrl);
    const dump = dumpStreamFromProcess(child);
    const packed = packArchive(backupMembers(dump, files, { schemaMigration, patFingerprint, createdAt }));
    const encrypted = encryptBackupStream(packed, secret);
    encrypted.once('close', release);
    encrypted.once('error', release);
    return { stream: encrypted, filename };
  } catch (err) {
    release();
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
