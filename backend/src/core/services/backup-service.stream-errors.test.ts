/**
 * Backup source-stream failures through `createEncryptedBackupStream` and
 * `backupMembers` together (#1709).
 *
 * The archive members used to be connected with `.pipe()`, which neither
 * forwards nor listens for source errors: a failing `pg_dump` or an attachment
 * that vanished after the listing emitted an unhandled `'error'`, killed the
 * process and left the run `running` with `worker:lock:backup` held for an
 * hour. Every test here runs the real composition (real Postgres snapshot,
 * real Redis lock, real archive/encryption) and probes the process for
 * `uncaughtException` / `unhandledRejection` as rag-service.test.ts does.
 *
 * pg_dump is faked through `spawnFn` (or the mocked `spawn` for
 * `runS3Backup`, which takes no options) except in the start-failure test,
 * which spawns a nonexistent absolute path so the `'error'` arrives with the
 * real `process.nextTick` timing.
 */
import { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import type { ReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { query } from '../db/postgres.js';
import { isDbAvailable, setupTestDb, truncateAllTables } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import type * as ChildProcessModule from 'node:child_process';
import type * as FsModule from 'node:fs';
import type * as SsrfGuard from '../utils/ssrf-guard.js';

type SpawnFn = typeof ChildProcessModule.spawn;

const { spawnImpl, openedReadStreams } = vi.hoisted(() => ({
  spawnImpl: { current: undefined as SpawnFn | undefined },
  openedReadStreams: [] as ReadStream[],
}));

// runS3Backup has no spawn seam; tests that drive it install a fake here.
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>();
  const spawn = (...args: unknown[]) => Reflect.apply(spawnImpl.current ?? original.spawn, undefined, args);
  return { ...original, default: { ...original, spawn }, spawn };
});

// Records each attachment stream so teardown can be observed on the real file handle.
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof FsModule>();
  const createReadStream = ((...args: Parameters<typeof original.createReadStream>) => {
    const stream = original.createReadStream(...args);
    openedReadStreams.push(stream);
    return stream;
  }) as typeof original.createReadStream;
  return { ...original, default: { ...original, createReadStream }, createReadStream };
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

import { setRedisClient } from './redis-cache.js';
import { updateBackupSettings } from './backup-settings.js';
import { decryptBackupStream, unpackArchive, type BackupSecret } from './backup-stream.js';
import {
  BACKUP_LOCK_NAME,
  createEncryptedBackupStream,
  runS3Backup,
  type EncryptedBackupStream,
} from './backup-service.js';

const dbAvailable = await isDbAvailable();
const redisAvailable = await isRedisAvailable();

const LOCK_KEY = `worker:lock:${BACKUP_LOCK_NAME}`;
const SECRET: BackupSecret = { kind: 'master', keyMaterial: 'master-key-at-least-32-characters' };

interface FakePgDump {
  process: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: Mock;
  readonly closed: boolean;
  /** Exit like a real process: stderr flushed first, then 'exit' and 'close'. */
  exit(code: number | null, options?: { endStdout?: boolean; signal?: NodeJS.Signals }): void;
}

function fakePgDump(): FakePgDump {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  let closed = false;
  const exit: FakePgDump['exit'] = (code, options = {}) => {
    if (closed) return;
    closed = true;
    if (options.endStdout && !stdout.destroyed) stdout.end();
    if (!stderr.destroyed) stderr.end();
    setImmediate(() => {
      emitter.emit('exit', code, options.signal ?? null);
      emitter.emit('close', code, options.signal ?? null);
    });
  };
  // A terminated pg_dump exits; its stdout is NOT ended here, so a stream that
  // is still open afterwards was not torn down by the backup itself.
  const kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    exit(null, { signal });
    return true;
  });
  const process = Object.assign(emitter, { stdout, stderr, kill }) as unknown as ChildProcess;
  return {
    process,
    stdout,
    stderr,
    kill,
    get closed() {
      return closed;
    },
    exit,
  };
}

/** A `spawnFn` returning `child`; `onSpawn` runs on the next tick, like a real spawn's first events. */
function spawnReturning(child: FakePgDump, onSpawn?: (child: FakePgDump) => void): SpawnFn {
  const fake = (_command: string, _args: readonly string[], _options: SpawnOptions) => {
    if (onSpawn) process.nextTick(onSpawn, child);
    return child.process;
  };
  // One function cannot implement spawn's overloads; the backup calls only (command, args, options).
  return fake as unknown as SpawnFn;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  'backup source-stream failures (#1709, real Postgres + Redis)',
  () => {
    let redis: RedisClientType;
    let attachmentsDir: string;
    const escaped: unknown[] = [];
    let escape = Promise.withResolvers<never>();
    const recordEscape = (reason: unknown) => {
      escaped.push(reason);
      escape.reject(new Error(`escaped to the process: ${String(reason)}`));
    };

    /** The rejection of `promise`; fails at once if an error escapes to the process first. */
    async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
      const outcome = await Promise.race([promise, escape.promise]).then(
        () => ({ rejected: false as const, value: undefined }),
        (value: unknown) => ({ rejected: true as const, value }),
      );
      expect(escaped).toEqual([]);
      expect(outcome.rejected).toBe(true);
      expect(outcome.value).toBeInstanceOf(Error);
      return outcome.value as Error;
    }

    async function expectLockReleased(): Promise<void> {
      await vi.waitFor(async () => expect(await redis.get(LOCK_KEY)).toBeNull());
    }

    /** Lets every queued tick, microtask and immediate run, so a late escape is caught. */
    async function expectProcessStayedUp(): Promise<void> {
      for (let i = 0; i < 5; i += 1) await nextEventLoopTurn();
      expect(escaped).toEqual([]);
    }

    async function startBackup(spawnFn: SpawnFn): Promise<EncryptedBackupStream> {
      const backup = await createEncryptedBackupStream(SECRET, { spawnFn, attachmentsRoot: attachmentsDir });
      expect(await redis.get(LOCK_KEY)).not.toBeNull();
      return backup;
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
      attachmentsDir = await mkdtemp(path.join(os.tmpdir(), 'backup-1709-'));
      openedReadStreams.length = 0;
      escaped.length = 0;
      escape = Promise.withResolvers<never>();
      escape.promise.catch(() => {});
      process.on('uncaughtException', recordEscape);
      process.on('unhandledRejection', recordEscape);
    });

    afterEach(async () => {
      process.off('uncaughtException', recordEscape);
      process.off('unhandledRejection', recordEscape);
      spawnImpl.current = undefined;
      delete process.env.ATTACHMENTS_DIR;
      delete process.env.BACKUP_ENCRYPTION_KEY;
      await rm(attachmentsDir, { recursive: true, force: true });
    });

    it('(a) contains a pg_dump start failure that arrives on process.nextTick from the real spawn', async () => {
      const { spawn: realSpawn } = await vi.importActual<typeof ChildProcessModule>('node:child_process');
      const missingBinary = path.join(attachmentsDir, 'no-such-dir', 'pg_dump');
      // A listed attachment, as in any real deployment, makes `stat` the last
      // await before spawn. After a recursive readdir of an EMPTY root, Node
      // 26.13 never reports an exception thrown in the following tick queue to
      // 'uncaughtException' at all, which would hide an unhandled 'error'.
      await writeFile(path.join(attachmentsDir, 'page-1.png'), randomBytes(512));
      let childClosed = false;
      const spawnMissingBinary = (_command: string, args: readonly string[], options: SpawnOptions) => {
        const child = realSpawn(missingBinary, args, options);
        child.once('close', () => {
          childClosed = true;
        });
        return child;
      };

      // One function cannot implement spawn's overloads; the backup calls only (command, args, options).
      const backup = await startBackup(spawnMissingBinary as unknown as SpawnFn);
      const error = await rejectionOf(readAll(backup.stream));

      expect(error.name).toBe('BackupDumpError');
      expect(error.message).toMatch(/^pg_dump failed to start: .*ENOENT/);
      await expectLockReleased();
      expect(childClosed).toBe(true);
      await expectProcessStayedUp();
    });

    it('(b) fails with the pg_dump exit message when pg_dump exits non-zero after partial stdout', async () => {
      const pgDump = fakePgDump();
      const backup = await startBackup(spawnReturning(pgDump, (child) => {
        child.stdout.write(randomBytes(32 * 1024));
      }));
      const result = readAll(backup.stream);
      await vi.waitFor(() => expect(pgDump.stdout.readableLength).toBe(0));

      pgDump.stderr.write('pg_dump: error: query failed: permission denied for table pages');
      pgDump.exit(1, { endStdout: true });
      const error = await rejectionOf(result);

      expect(error.message).toBe(
        'pg_dump exited 1: pg_dump: error: query failed: permission denied for table pages',
      );
      await expectLockReleased();
      expect(pgDump.closed).toBe(true);
      await expectProcessStayedUp();
    });

    it('(c) fails when pg_dump exits non-zero immediately without any stdout', async () => {
      const pgDump = fakePgDump();
      const backup = await startBackup(spawnReturning(pgDump, (child) => {
        child.stderr.write('pg_dump: error: server version mismatch');
        child.exit(1, { endStdout: true });
      }));

      const error = await rejectionOf(readAll(backup.stream));

      expect(error.message).toBe('pg_dump exited 1: pg_dump: error: server version mismatch');
      await expectLockReleased();
      expect(pgDump.closed).toBe(true);
      await expectProcessStayedUp();
    });

    it('(d) fails with ENOENT when an attachment is removed between listing and read', async () => {
      await mkdir(path.join(attachmentsDir, 'page-1'));
      const vanishing = path.join(attachmentsDir, 'page-1', 'diagram.png');
      await writeFile(vanishing, randomBytes(1024));
      const pgDump = fakePgDump();
      const backup = await startBackup(spawnReturning(pgDump));
      const result = readAll(backup.stream);

      // Listed by createEncryptedBackupStream; read only after the dump member completes.
      await unlink(vanishing);
      pgDump.stdout.write(randomBytes(4 * 1024));
      pgDump.exit(0, { endStdout: true });
      const error = await rejectionOf(result);

      expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
      expect(error.message).toContain(vanishing);
      await expectLockReleased();
      expect(pgDump.closed).toBe(true);
      await expectProcessStayedUp();
    });

    describe('(e) consumer destroys the encrypted stream early', () => {
      it('while the archive is suspended at a yield of buffered dump data', async () => {
        const pgDump = fakePgDump();
        const backup = await startBackup(spawnReturning(pgDump, (child) => {
          for (let i = 0; i < 32; i += 1) child.stdout.write(randomBytes(64 * 1024));
        }));
        // Nothing reads the encrypted stream, so once it holds output the
        // archive stops at a yield with the rest of the dump still buffered.
        await vi.waitFor(() => expect(backup.stream.readableLength).toBeGreaterThan(0));
        await nextEventLoopTurn();
        expect(pgDump.stdout.readableLength).toBeGreaterThan(0);

        backup.stream.destroy();

        await expectLockReleased();
        expect(pgDump.kill).toHaveBeenCalledWith('SIGTERM');
        expect(pgDump.closed).toBe(true);
        expect(pgDump.stdout.destroyed).toBe(true);
        await expectProcessStayedUp();
      });

      it('while the archive is waiting for the next dump chunk', async () => {
        const pgDump = fakePgDump();
        const backup = await startBackup(spawnReturning(pgDump, (child) => {
          child.stdout.write(randomBytes(1024));
        }));
        backup.stream.on('error', () => {});
        backup.stream.resume();
        // pg_dump stays silent: the archive drains what it wrote and waits.
        await vi.waitFor(() => expect(pgDump.stdout.readableLength).toBe(0));
        for (let i = 0; i < 3; i += 1) await nextEventLoopTurn();

        backup.stream.destroy();

        await expectLockReleased();
        expect(pgDump.kill).toHaveBeenCalledWith('SIGTERM');
        expect(pgDump.closed).toBe(true);
        expect(pgDump.stdout.destroyed).toBe(true);
        await expectProcessStayedUp();
      });

      it('while the archive is suspended at a yield of an in-flight attachment', async () => {
        await writeFile(path.join(attachmentsDir, 'large.bin'), randomBytes(4 * 1024 * 1024));
        const pgDump = fakePgDump();
        const backup = await startBackup(spawnReturning(pgDump, (child) => {
          child.stdout.write(randomBytes(1024));
          child.exit(0, { endStdout: true });
        }));
        await vi.waitFor(() => expect(openedReadStreams).toHaveLength(1));
        const attachment = openedReadStreams[0]!;
        await vi.waitFor(() => expect(attachment.bytesRead).toBeGreaterThan(0));
        await nextEventLoopTurn();
        expect(attachment.bytesRead).toBeLessThan(4 * 1024 * 1024);

        backup.stream.destroy();

        // The file descriptor is closed, not just the hash stream the archive reads.
        await vi.waitFor(() => expect(attachment.closed).toBe(true));
        expect(attachment.destroyed).toBe(true);
        await expectLockReleased();
        expect(pgDump.closed).toBe(true);
        await expectProcessStayedUp();
      });
    });

    it('(f) still produces the unchanged archive, manifest and checksums on success', async () => {
      const dumpBytes = randomBytes(300 * 1024);
      const attachments = {
        'page-1/a.png': randomBytes(2048),
        'page-2/nested/b.pdf': Buffer.from('second attachment'),
      };
      for (const [rel, content] of Object.entries(attachments)) {
        await mkdir(path.dirname(path.join(attachmentsDir, rel)), { recursive: true });
        await writeFile(path.join(attachmentsDir, rel), content);
      }
      const pgDump = fakePgDump();
      const backup = await startBackup(spawnReturning(pgDump, (child) => {
        child.stdout.write(dumpBytes.subarray(0, 100 * 1024));
        child.stdout.write(dumpBytes.subarray(100 * 1024));
        child.exit(0, { endStdout: true });
      }));

      const encrypted = await readAll(backup.stream);
      const members: Array<[string, Buffer]> = [];
      for await (const member of unpackArchive(decryptBackupStream(Readable.from([encrypted]), SECRET))) {
        members.push([member.name, await readAll(member.stream)]);
      }

      expect(members.map(([name]) => name)).toEqual([
        'database.dump',
        'attachments/page-1/a.png',
        'attachments/page-2/nested/b.pdf',
        'manifest.json',
      ]);
      const content = new Map(members);
      expect(content.get('database.dump')).toEqual(dumpBytes);
      expect(content.get('attachments/page-1/a.png')).toEqual(attachments['page-1/a.png']);
      expect(content.get('attachments/page-2/nested/b.pdf')).toEqual(attachments['page-2/nested/b.pdf']);
      const manifest = JSON.parse(content.get('manifest.json')!.toString('utf8'));
      expect(manifest).toMatchObject({
        version: 1,
        format: 'cpqarc1',
        databaseSizeBytes: dumpBytes.length,
        checksums: {
          'database.dump': sha256(dumpBytes),
          'attachments/page-1/a.png': sha256(attachments['page-1/a.png']),
          'attachments/page-2/nested/b.pdf': sha256(attachments['page-2/nested/b.pdf']),
        },
      });
      await expectLockReleased();
      expect(pgDump.kill).not.toHaveBeenCalled();
      await expectProcessStayedUp();
    });

    describe('runS3Backup against a fake S3 endpoint', () => {
      let server: Server;
      let requests: string[];
      let onCreateMultipartUpload: (() => void) | undefined;

      beforeEach(async () => {
        requests = [];
        onCreateMultipartUpload = undefined;
        server = createServer((req: IncomingMessage, res) => {
          req.resume();
          req.once('end', () => {
            const url = new URL(req.url ?? '/', 'http://fake-s3');
            requests.push(`${req.method} ${url.pathname}?${url.searchParams.toString()}`);
            if (req.method === 'POST' && url.searchParams.has('uploads')) {
              onCreateMultipartUpload?.();
              res.writeHead(200, { 'content-type': 'application/xml' });
              res.end('<InitiateMultipartUploadResult><UploadId>upload-1709</UploadId></InitiateMultipartUploadResult>');
              return;
            }
            if (req.method === 'PUT') {
              res.writeHead(200, { etag: '"part-etag"' });
              res.end();
              return;
            }
            if (req.method === 'DELETE') {
              res.writeHead(204);
              res.end();
              return;
            }
            res.writeHead(200, { 'content-type': 'application/xml' });
            res.end('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
          });
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const { port } = server.address() as AddressInfo;
        await updateBackupSettings({
          s3Enabled: true,
          s3Endpoint: `http://127.0.0.1:${port}`,
          s3Bucket: 'backups',
          s3Region: 'us-east-1',
          s3AccessKey: 'test-access-key',
          s3SecretKey: 'test-secret-key',
          s3Prefix: 'compendiq-backups/',
          s3ForcePathStyle: true,
        });
        process.env.BACKUP_ENCRYPTION_KEY = 'backup-encryption-key-at-least-32-bytes';
        process.env.ATTACHMENTS_DIR = attachmentsDir;
      });

      afterEach(async () => {
        server.closeAllConnections();
        server.close();
        await once(server, 'close');
      });

      it('marks the run failed with the pg_dump message, aborts the multipart upload and releases the lock', async () => {
        const pgDump = fakePgDump();
        spawnImpl.current = spawnReturning(pgDump, (child) => {
          child.stdout.write(randomBytes(8 * 1024));
        });
        // pg_dump fails while the multipart upload is open.
        onCreateMultipartUpload = () => {
          pgDump.stderr.write('pg_dump: error: connection to server failed');
          pgDump.exit(1, { endStdout: true });
        };

        const error = await rejectionOf(runS3Backup('admin-1709', 'backup-job-1709'));

        expect(error.message).toBe('pg_dump exited 1: pg_dump: error: connection to server failed');
        const runs = await query<{ status: string; error: string | null; job_id: string | null }>(
          'SELECT status, error, job_id FROM backup_runs',
        );
        expect(runs.rows).toEqual([
          {
            status: 'failed',
            error: 'pg_dump exited 1: pg_dump: error: connection to server failed',
            job_id: 'backup-job-1709',
          },
        ]);
        expect(requests[0]).toMatch(/^POST \/backups\/compendiq-backups\/.+\?uploads=$/);
        expect(requests.at(-1)).toMatch(/^DELETE \/backups\/compendiq-backups\/.+\?uploadId=upload-1709$/);
        expect(requests.some((request) => request.includes('CompleteMultipartUpload'))).toBe(false);
        await expectLockReleased();
        expect(pgDump.closed).toBe(true);
        await expectProcessStayedUp();
      });
    });
  },
);
