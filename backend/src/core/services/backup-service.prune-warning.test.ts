/**
 * A failed retention prune after a completed S3 upload is a warning (#1710).
 *
 * Before the fix a refused ListObjects/DeleteObjects call marked a finished
 * upload `failed` with no object key and never advanced `backup_last_run_at`,
 * so every 15-minute tick uploaded another full backup. These tests drive the
 * real worker entry point (`processBackupJob`) and `runS3Backup` against real
 * Postgres and Redis and a fake S3 HTTP endpoint with a stateful bucket; only
 * `pg_dump` is faked (through the mocked `spawn`).
 */

import { type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../db/postgres.js';
import { isDbAvailable, setupTestDb, truncateAllTables } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import type * as ChildProcessModule from 'node:child_process';
import type * as BackupS3 from './backup-s3.js';
import type * as SsrfGuard from '../utils/ssrf-guard.js';

const { spawnImpl, pruneOverride } = vi.hoisted(() => ({
  spawnImpl: { current: undefined as typeof ChildProcessModule.spawn | undefined },
  pruneOverride: { current: undefined as (() => Promise<string[]>) | undefined },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>();
  const spawn = (...args: unknown[]) => Reflect.apply(spawnImpl.current ?? original.spawn, undefined, args);
  return { ...original, default: { ...original, spawn }, spawn };
});

// The fake S3 endpoint listens on loopback, which the strict public-network
// policy refuses; only that resolution is replaced, the transport is real.
vi.mock('../utils/ssrf-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SsrfGuard>();
  return {
    ...actual,
    resolvePublicNetworkUrl: async (urlString: string) => {
      const url = new URL(urlString);
      if (url.hostname !== '127.0.0.1') return actual.resolvePublicNetworkUrl(urlString);
      return { url, addresses: [{ address: '127.0.0.1', family: 4 as const }] };
    },
  };
});

// The real client quotes at most 300 characters of an S3 error body, so a
// message beyond the 1000-character bound needs a prune that fails differently.
vi.mock('./backup-s3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BackupS3>();
  return {
    ...actual,
    pruneBackupObjects: (...args: Parameters<typeof actual.pruneBackupObjects>) =>
      pruneOverride.current ? pruneOverride.current() : actual.pruneBackupObjects(...args),
  };
});

import { setRedisClient } from './redis-cache.js';
import { getBackupRuntimeConfig, updateBackupSettings } from './backup-settings.js';
import { BACKUP_LOCK_NAME, isBackupDue, listBackupRuns, runS3Backup } from './backup-service.js';
import { processBackupJob } from './backup-worker.js';

const dbAvailable = await isDbAvailable();
const redisAvailable = await isRedisAvailable();

const LOCK_KEY = `worker:lock:${BACKUP_LOCK_NAME}`;
const PREFIX = 'compendiq-backups/';
const STALE_KEY = `${PREFIX}compendiq-backup-20260101T000000Z.enc`;

/** A pg_dump that writes a small dump and exits 0. */
function spawnHealthyPgDump(): typeof ChildProcessModule.spawn {
  const fake = () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const emitter = new EventEmitter();
    const process_ = Object.assign(emitter, { stdout, stderr, kill: vi.fn(() => true) });
    process.nextTick(() => {
      stdout.end(randomBytes(8 * 1024));
      stderr.end();
      setImmediate(() => {
        emitter.emit('exit', 0, null);
        emitter.emit('close', 0, null);
      });
    });
    return process_ as unknown as ChildProcess;
  };
  return fake as unknown as typeof ChildProcessModule.spawn;
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  'S3 prune failure after a completed upload (#1710, real Postgres + Redis + fake S3)',
  () => {
    let redis: RedisClientType;
    let attachmentsDir: string;
    let server: Server;
    /** Object key -> last modified; mutated by uploads and by accepted deletes. */
    let bucket: Map<string, Date>;
    let requests: string[];
    let listStatus: number;
    let deleteStatus: number;

    const uploadRequests = () => requests.filter((request) => /^POST .*\?uploads=$/.test(request));

    async function configure(overrides: Parameters<typeof updateBackupSettings>[0] = {}) {
      const { port } = server.address() as AddressInfo;
      await updateBackupSettings({
        s3Enabled: true,
        s3Endpoint: `http://127.0.0.1:${port}`,
        s3Bucket: 'backups',
        s3Region: 'us-east-1',
        s3AccessKey: 'test-access-key',
        s3SecretKey: 'test-secret-key',
        s3Prefix: PREFIX,
        s3ForcePathStyle: true,
        scheduleEnabled: true,
        intervalHours: 24,
        retentionCount: 1,
        retentionDays: 30,
        ...overrides,
      });
    }

    async function runRows() {
      const result = await query<{
        status: string;
        bytes: string | null;
        object_key: string | null;
        error: string | null;
        warning: string | null;
        finished_at: Date | null;
      }>('SELECT status, bytes, object_key, error, warning, finished_at FROM backup_runs ORDER BY created_at');
      return result.rows;
    }

    beforeAll(async () => {
      await setupTestDb();
      redis = createClient({ url: process.env.REDIS_URL }) as RedisClientType;
      await redis.connect();
      setRedisClient(redis);
    }, 15_000);

    afterAll(async () => {
      setRedisClient(null);
      await redis?.quit();
    });

    beforeEach(async () => {
      await truncateAllTables();
      await redis.del(LOCK_KEY);
      attachmentsDir = await mkdtemp(path.join(os.tmpdir(), 'backup-1710-'));
      process.env.BACKUP_ENCRYPTION_KEY = 'backup-encryption-key-at-least-32-bytes';
      process.env.ATTACHMENTS_DIR = attachmentsDir;
      spawnImpl.current = spawnHealthyPgDump();
      requests = [];
      listStatus = 200;
      deleteStatus = 200;
      bucket = new Map([[STALE_KEY, new Date('2026-01-01T00:00:00Z')]]);
      server = createServer((req: IncomingMessage, res) => {
        const body: Buffer[] = [];
        req.on('data', (chunk: Buffer) => body.push(chunk));
        req.once('end', () => {
          const url = new URL(req.url ?? '/', 'http://fake-s3');
          requests.push(`${req.method} ${url.pathname}?${url.searchParams.toString()}`);
          const key = decodeURIComponent(url.pathname).replace(/^\/backups\//, '');
          if (req.method === 'POST' && url.searchParams.has('uploads')) {
            res.writeHead(200, { 'content-type': 'application/xml' });
            res.end('<InitiateMultipartUploadResult><UploadId>upload-1710</UploadId></InitiateMultipartUploadResult>');
          } else if (req.method === 'PUT') {
            res.writeHead(200, { etag: '"part-etag"' });
            res.end();
          } else if (req.method === 'POST' && url.searchParams.has('uploadId')) {
            bucket.set(key, new Date());
            res.writeHead(200, { 'content-type': 'application/xml' });
            res.end('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
          } else if (req.method === 'GET') {
            if (listStatus !== 200) {
              res.writeHead(listStatus, { 'content-type': 'application/xml' });
              res.end('<Error><Code>AccessDenied</Code><Message>ListObjectsV2 denied</Message></Error>');
              return;
            }
            const contents = [...bucket]
              .map(
                ([k, modified]) =>
                  `<Contents><Key>${k}</Key><LastModified>${modified.toISOString()}</LastModified><Size>1</Size></Contents>`,
              )
              .join('');
            res.writeHead(200, { 'content-type': 'application/xml' });
            res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
          } else if (req.method === 'POST' && url.searchParams.has('delete')) {
            if (deleteStatus !== 200) {
              res.writeHead(deleteStatus, { 'content-type': 'application/xml' });
              res.end('<Error><Code>AccessDenied</Code><Message>DeleteObjects denied</Message></Error>');
              return;
            }
            for (const match of Buffer.concat(body).toString('utf8').matchAll(/<Key>([^<]+)<\/Key>/g)) {
              bucket.delete(match[1]!);
            }
            res.writeHead(200, { 'content-type': 'application/xml' });
            res.end('<DeleteResult></DeleteResult>');
          } else {
            res.writeHead(404);
            res.end();
          }
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      await configure();
    });

    afterEach(async () => {
      spawnImpl.current = undefined;
      pruneOverride.current = undefined;
      delete process.env.ATTACHMENTS_DIR;
      delete process.env.BACKUP_ENCRYPTION_KEY;
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
      await rm(attachmentsDir, { recursive: true, force: true });
    });

    it('migration 153 added the nullable warning column', async () => {
      const column = await query<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'backup_runs' AND column_name = 'warning'`,
      );
      expect(column.rows).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
    });

    it('denied DeleteObjects: one object, a success row with a truncated warning, the gate set, later ticks skip', async () => {
      deleteStatus = 403;

      await expect(processBackupJob('tick-1')).resolves.toMatch(/^Uploaded compendiq-backup-.+\.enc$/);

      expect(uploadRequests()).toHaveLength(1);
      expect([...bucket.keys()].filter((key) => key !== STALE_KEY)).toHaveLength(1);
      const [row, ...others] = await runRows();
      expect(others).toEqual([]);
      expect(row).toMatchObject({ status: 'success', error: null });
      expect(row!.object_key).toMatch(/^compendiq-backups\/compendiq-backup-\d{8}T\d{6}Z\.enc$/);
      expect(Number(row!.bytes)).toBeGreaterThan(0);
      expect(row!.finished_at).toBeInstanceOf(Date);
      expect(row!.warning).toMatch(/^DeleteObjects failed \(403\): .*AccessDenied/);
      expect(row!.warning!.length).toBeLessThanOrEqual(1000);

      const cfg = await getBackupRuntimeConfig();
      expect(cfg.schedule.lastRunAt).not.toBeNull();
      await expect(isBackupDue()).resolves.toBe(false);
      expect(await redis.get(LOCK_KEY)).toBeNull();

      const requestsAfterFirstTick = requests.length;
      await expect(processBackupJob('tick-2')).resolves.toBe('Backup not due');
      await expect(processBackupJob('tick-3')).resolves.toBe('Backup not due');
      expect(requests).toHaveLength(requestsAfterFirstTick);
      expect(await runRows()).toHaveLength(1);

      const audit = await query<{ user_id: string | null; resource_type: string; resource_id: string; metadata: Record<string, unknown> }>(
        `SELECT user_id, resource_type, resource_id, metadata FROM audit_log WHERE action = 'BACKUP_UPLOADED'`,
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        user_id: null,
        resource_type: 'backup',
        metadata: { objectKey: row!.object_key, bytes: Number(row!.bytes), pruneWarning: row!.warning },
      });
      const history = await listBackupRuns();
      expect(history[0]).toMatchObject({ status: 'success', warning: row!.warning, error: null });
    });

    it('denied ListObjects takes the same path as a denied delete', async () => {
      listStatus = 403;

      await expect(runS3Backup(null, 'job-list')).resolves.toMatch(/^compendiq-backup-/);

      const [row] = await runRows();
      expect(row).toMatchObject({ status: 'success', error: null });
      expect(row!.warning).toMatch(/^ListObjects failed \(403\): .*AccessDenied/);
      expect((await getBackupRuntimeConfig()).schedule.lastRunAt).not.toBeNull();
      expect(requests.some((request) => request.startsWith('POST') && request.includes('delete='))).toBe(false);
    });

    it('truncates an over-long prune error to 1000 characters', async () => {
      pruneOverride.current = async () => {
        throw new Error('x'.repeat(1500));
      };

      await runS3Backup(null, null);

      const [row] = await runRows();
      expect(row).toMatchObject({ status: 'success', error: null });
      expect(row!.warning).toBe('x'.repeat(1000));
    });

    it('allowed deletes: no warning, the stale object is pruned, success and gate as before', async () => {
      await expect(processBackupJob('tick-1')).resolves.toMatch(/^Uploaded /);

      const [row] = await runRows();
      expect(row).toMatchObject({ status: 'success', error: null, warning: null });
      expect(bucket.has(STALE_KEY)).toBe(false);
      expect(bucket.size).toBe(1);
      expect((await getBackupRuntimeConfig()).schedule.lastRunAt).not.toBeNull();
      const audit = await query<{ metadata: { pruneWarning: string | null } }>(
        `SELECT metadata FROM audit_log WHERE action = 'BACKUP_UPLOADED'`,
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.metadata.pruneWarning).toBeNull();
    });

    it('an upload failure is still a failed run: no object key, no audit, the gate not advanced', async () => {
      // CreateMultipartUpload is refused, so no object exists.
      server.removeAllListeners('request');
      server.on('request', (req: IncomingMessage, res) => {
        req.resume();
        res.writeHead(403, { 'content-type': 'application/xml' });
        res.end('<Error><Code>AccessDenied</Code></Error>');
      });

      await expect(runS3Backup(null, 'job-upload')).rejects.toThrow(/CreateMultipartUpload failed \(403\)/);

      const [row] = await runRows();
      expect(row).toMatchObject({ status: 'failed', object_key: null, warning: null });
      expect(row!.error).toMatch(/CreateMultipartUpload failed/);
      expect((await getBackupRuntimeConfig()).schedule.lastRunAt).toBeNull();
      await expect(isBackupDue()).resolves.toBe(true);
      const audit = await query(`SELECT 1 FROM audit_log WHERE action = 'BACKUP_UPLOADED'`);
      expect(audit.rows).toEqual([]);
      expect(await redis.get(LOCK_KEY)).toBeNull();
    });
  },
);
