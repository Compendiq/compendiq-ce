import { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockQuery,
  mockGetPool,
  mockAcquireWorkerLock,
  mockRefreshWorkerLock,
  mockReleaseWorkerLock,
  mockGetBackupRuntimeConfig,
  mockRequireMasterBackupKey,
  mockMarkBackupLastRun,
  mockObjectKeyFor,
  mockPruneBackupObjects,
  mockUploadBackupObject,
  mockLogAuditEvent,
  mockSpawn,
  mockLogger,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetPool: vi.fn(),
  mockAcquireWorkerLock: vi.fn(),
  mockRefreshWorkerLock: vi.fn(),
  mockGetBackupRuntimeConfig: vi.fn(),
  mockRequireMasterBackupKey: vi.fn(),
  mockReleaseWorkerLock: vi.fn(),
  mockMarkBackupLastRun: vi.fn(),
  mockObjectKeyFor: vi.fn(),
  mockPruneBackupObjects: vi.fn(),
  mockUploadBackupObject: vi.fn(),
  mockLogAuditEvent: vi.fn(),
  mockSpawn: vi.fn(),
  mockLogger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, spawn: mockSpawn };
});
vi.mock('../db/postgres.js', () => ({
  getPool: () => mockGetPool(),
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
}));
vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));
vi.mock('./redis-cache.js', () => ({
  acquireWorkerLock: mockAcquireWorkerLock,
  isWorkerLocked: vi.fn(),
  refreshWorkerLock: mockRefreshWorkerLock,
  releaseWorkerLock: mockReleaseWorkerLock,
}));
vi.mock('./backup-settings.js', () => ({
  getBackupRuntimeConfig: mockGetBackupRuntimeConfig,
  hasMasterBackupKey: vi.fn(() => true),
  markBackupLastRun: mockMarkBackupLastRun,
  requireMasterBackupKey: mockRequireMasterBackupKey,
}));
vi.mock('./backup-s3.js', () => ({
  objectKeyFor: mockObjectKeyFor,
  pruneBackupObjects: mockPruneBackupObjects,
  uploadBackupObject: mockUploadBackupObject,
}));
vi.mock('./audit-service.js', () => ({
  logAuditEvent: mockLogAuditEvent,
}));

import {
  createEncryptedBackupStream,
  dumpStreamFromProcess,
  exportPostgresSnapshot,
  latestSchemaMigration,
  listBackupRuns,
  isBackupDue,
  runS3Backup,
  spawnPgDump,
  terminatePgDumpAndWait,
} from './backup-service.js';

const falsyRejections = [undefined, null, false, 0, ''] as const;

const S3_RUNTIME_CONFIG = {
  s3: {
    enabled: true,
    endpoint: 'https://s3.example.com',
    bucket: 'backups',
    region: 'us-east-1',
    accessKey: 'access',
    secretKey: 'secret',
    prefix: 'compendiq-backups/',
    forcePathStyle: true,
  },
  schedule: { retentionCount: 7, retentionDays: 30 },
};

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  const outcome = await promise.then(
    () => ({ rejected: false as const, value: undefined }),
    (value: unknown) => ({ rejected: true as const, value }),
  );
  expect(outcome.rejected).toBe(true);
  return outcome.value;
}

function fakeChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  const process = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill,
  }) as unknown as ChildProcess;
  return { process, stdout, stderr, kill };
}

function fakeSnapshotClient(
  snapshotId = '00000003-0000001B-1',
  options: { commitError?: unknown; unlockError?: unknown } = {},
) {
  const calls: string[] = [];
  const release = vi.fn();
  const client = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql === 'COMMIT' && 'commitError' in options) throw options.commitError;
      if (sql.includes('pg_advisory_unlock') && 'unlockError' in options) {
        throw options.unlockError;
      }
      if (sql.includes('pg_export_snapshot')) return { rows: [{ snapshot: snapshotId }] };
      return { rows: [] };
    }),
    release,
  } as unknown as PoolClient;
  return { client, calls, release };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockGetPool.mockReset();
  mockGetBackupRuntimeConfig.mockReset();
  mockRequireMasterBackupKey.mockReset();
  mockRequireMasterBackupKey.mockReturnValue('master-key-at-least-32-characters');
  mockAcquireWorkerLock.mockReset();
  mockAcquireWorkerLock.mockResolvedValue('lock-token');
  mockRefreshWorkerLock.mockReset();
  mockRefreshWorkerLock.mockResolvedValue(undefined);
  mockReleaseWorkerLock.mockReset();
  mockReleaseWorkerLock.mockResolvedValue(undefined);
  mockMarkBackupLastRun.mockReset();
  mockObjectKeyFor.mockReset();
  mockObjectKeyFor.mockReturnValue('compendiq-backups/backup.enc');
  mockPruneBackupObjects.mockReset();
  mockPruneBackupObjects.mockResolvedValue([]);
  mockUploadBackupObject.mockReset();
  mockLogger.error.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogAuditEvent.mockReset();
  mockLogAuditEvent.mockResolvedValue(undefined);
  mockSpawn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.POSTGRES_URL;
});

describe('latestSchemaMigration', () => {
  it('reads the migration name recorded by the production migration runner', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ name: '107_backup_settings.sql' }],
      rowCount: 1,
    });

    await expect(latestSchemaMigration()).resolves.toBe('107_backup_settings.sql');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringMatching(/SELECT name FROM _migrations ORDER BY name DESC/),
      undefined,
    );
  });
});

describe('exported PostgreSQL capture snapshot', () => {
  it('takes the exclusive lock before repeatable-read state and closes every resource exactly once', async () => {
    const harness = fakeSnapshotClient();
    const pool = { connect: vi.fn(async () => harness.client) };

    const snapshot = await exportPostgresSnapshot(pool);
    expect(snapshot.snapshotId).toBe('00000003-0000001B-1');
    expect(snapshot.client).toBe(harness.client);
    expect(harness.calls).toEqual([
      'SET statement_timeout = 0',
      'SELECT pg_advisory_lock($1)',
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'SELECT pg_export_snapshot() AS snapshot',
    ]);

    await snapshot.close();
    await snapshot.close();
    expect(harness.calls).toEqual([
      'SET statement_timeout = 0',
      'SELECT pg_advisory_lock($1)',
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'SELECT pg_export_snapshot() AS snapshot',
      'COMMIT',
      'SELECT pg_advisory_unlock($1)',
      'RESET statement_timeout',
    ]);
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it.each(falsyRejections)('preserves falsy COMMIT rejection %#', async (failure) => {
    const harness = fakeSnapshotClient('00000003-0000001B-1', { commitError: failure });
    const snapshot = await exportPostgresSnapshot({
      connect: vi.fn(async () => harness.client),
    });

    const actual = await rejectedValue(snapshot.close());

    expect(Object.is(actual, failure)).toBe(true);
  });

  it.each(falsyRejections)('surfaces falsy snapshot unlock rejection %#', async (failure) => {
    const harness = fakeSnapshotClient('00000003-0000001B-1', { unlockError: failure });
    const snapshot = await exportPostgresSnapshot({
      connect: vi.fn(async () => harness.client),
    });

    const actual = await rejectedValue(snapshot.close());

    expect(Object.is(actual, failure)).toBe(true);
  });

  it('preserves a falsy COMMIT rejection when snapshot cleanup also fails', async () => {
    const harness = fakeSnapshotClient('00000003-0000001B-1', {
      commitError: false,
      unlockError: new Error('snapshot unlock failed'),
    });
    const snapshot = await exportPostgresSnapshot({
      connect: vi.fn(async () => harness.client),
    });

    const actual = await rejectedValue(snapshot.close());

    expect(actual).toBe(false);
  });

  it('passes the exported snapshot to pg_dump without changing existing callers', () => {
    const spawnFn = vi.fn();
    spawnPgDump('postgres://db', spawnFn, '00000003-0000001B-1');

    expect(spawnFn).toHaveBeenCalledWith(
      'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-acl',
        '--snapshot=00000003-0000001B-1',
        '--dbname=postgres://db',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  });
});

  it('releases the Redis backup lock when snapshot close rejects', async () => {
    process.env.POSTGRES_URL = 'postgres://backup-test';
    mockQuery.mockResolvedValueOnce({
      rows: [{ name: '107_backup_settings.sql' }],
      rowCount: 1,
    });
    const commitError = new Error('snapshot commit failed');
    const harness = fakeSnapshotClient('00000003-0000001B-1', { commitError });
    const pool = { connect: vi.fn(async () => harness.client) };

    await expect(
      createEncryptedBackupStream(
        { kind: 'master', keyMaterial: 'master-key-at-least-32-characters' },
        {
          attachmentsRoot: new URL(import.meta.url).pathname,
          snapshotPool: pool,
        },
      ),
    ).rejects.toThrow('snapshot commit failed');

    expect(mockReleaseWorkerLock).toHaveBeenCalledOnce();
    expect(mockReleaseWorkerLock).toHaveBeenCalledWith('backup', 'lock-token');
    expect(harness.calls).toContain('SELECT pg_advisory_unlock($1)');
    expect(harness.calls).toContain('RESET statement_timeout');
    expect(harness.release).toHaveBeenCalledOnce();
  });

describe('pg_dump cancellation lifecycle', () => {
  it('escalates to SIGKILL after the bounded grace period and waits for close', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    let settled = false;
    const terminated = terminatePgDumpAndWait(child.process).finally(() => {
      settled = true;
    });

    await nextEventLoopTurn();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(settled).toBe(false);

    child.process.emit('close', null, 'SIGKILL');
    await terminated;
    expect(settled).toBe(true);
  });

  it('keeps the backup lock and snapshot until cancelled pg_dump has exited', async () => {
    vi.useFakeTimers();
    process.env.POSTGRES_URL = 'postgres://db';
    mockQuery.mockResolvedValue({ rows: [{ name: '107_backup_settings.sql' }] });
    const snapshotHarness = fakeSnapshotClient();
    const pool = { connect: vi.fn(async () => snapshotHarness.client) };
    mockGetPool.mockReturnValue(pool);
    const child = fakeChild();
    const spawnFn = vi.fn(
      (_command: string, _args: readonly string[], _options: SpawnOptions) => child.process,
    );

    const backup = await createEncryptedBackupStream(
      { kind: 'master', keyMaterial: 'master-key-at-least-32-characters' },
      { spawnFn, attachmentsRoot: '/definitely/missing', snapshotPool: pool },
    );
    backup.stream.destroy();
    await nextEventLoopTurn();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockReleaseWorkerLock).not.toHaveBeenCalled();
    expect(snapshotHarness.calls).not.toContain('COMMIT');

    child.process.emit('close', null, 'SIGTERM');
    await nextEventLoopTurn();
    await nextEventLoopTurn();

    expect(snapshotHarness.calls).toContain('COMMIT');
    expect(snapshotHarness.release).toHaveBeenCalledOnce();
    expect(mockReleaseWorkerLock).toHaveBeenCalledOnce();
    expect(snapshotHarness.release.mock.invocationCallOrder[0]!).toBeLessThan(
      mockReleaseWorkerLock.mock.invocationCallOrder[0]!,
    );
  });
});

describe('backup run job correlation', () => {
  it('stores the exact queue job ID when an S3 run starts', async () => {
    mockGetBackupRuntimeConfig.mockResolvedValue({
      s3: {
        enabled: true,
        endpoint: 'https://s3.example.com',
        bucket: 'backups',
      },
    });
    mockAcquireWorkerLock.mockResolvedValueOnce(null);
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'run-1' }] });

    await expect(runS3Backup('admin-1', 'backup-job-42')).rejects.toThrow(
      'A backup is already running',
    );

    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(
        /INSERT INTO backup_runs \(destination, status, triggered_by, job_id\)/,
      ),
      ['s3', 'admin-1', 'backup-job-42'],
    );
  });

  it('records a terminal failed row for a correlated job when S3 configuration preflight fails', async () => {
    mockGetBackupRuntimeConfig.mockResolvedValue({
      s3: { enabled: false, endpoint: '', bucket: '' },
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'run-config-failed' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(runS3Backup('admin-1', 'backup-job-config')).rejects.toThrow(
      'S3 backup is not configured',
    );

    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(
        /INSERT INTO backup_runs \(destination, status, triggered_by, job_id\)/,
      ),
      ['s3', 'admin-1', 'backup-job-config'],
    );
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE backup_runs'),
      ['run-config-failed', 'failed', null, null, 'S3 backup is not configured'],
    );
  });


  it('releases backup resources before recording an immediate S3 upload failure', async () => {
    process.env.POSTGRES_URL = 'postgres://db';
    mockGetBackupRuntimeConfig.mockResolvedValue(S3_RUNTIME_CONFIG);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'run-1' }] })
      .mockResolvedValueOnce({ rows: [{ name: '108_backup_run_job_id.sql' }] })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const snapshotHarness = fakeSnapshotClient();
    mockGetPool.mockReturnValue({ connect: vi.fn(async () => snapshotHarness.client) });
    const child = fakeChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.process.emit('close', null, 'SIGTERM'));
      return true;
    });
    mockSpawn.mockReturnValue(child.process);
    mockUploadBackupObject.mockRejectedValue(new Error('CreateMultipartUpload failed'));

    await expect(runS3Backup('admin-1', 'backup-job-43')).rejects.toThrow(
      'CreateMultipartUpload failed',
    );

    expect(mockReleaseWorkerLock).toHaveBeenCalledOnce();
    expect(snapshotHarness.calls).toContain('COMMIT');
    const finishFailureCall = mockQuery.mock.calls.findIndex((call) =>
      String(call[0]).includes('UPDATE backup_runs'),
    );
    expect(finishFailureCall).toBeGreaterThanOrEqual(0);
    expect(mockReleaseWorkerLock.mock.invocationCallOrder[0]!).toBeLessThan(
      mockQuery.mock.invocationCallOrder[finishFailureCall]!,
    );
    // An upload failure is unchanged by #1710: not recorded as uploaded, no gate advanced.
    expect(mockMarkBackupLastRun).not.toHaveBeenCalled();
    expect(mockPruneBackupObjects).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it('preserves the primary S3 upload failure when snapshot release also rejects', async () => {
    process.env.POSTGRES_URL = 'postgres://db';
    mockGetBackupRuntimeConfig.mockResolvedValue(S3_RUNTIME_CONFIG);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'run-1' }] })
      .mockResolvedValueOnce({ rows: [{ name: '108_backup_run_job_id.sql' }] })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const cleanupFailure = new Error('snapshot commit failed during cleanup');
    const snapshotHarness = fakeSnapshotClient('00000003-0000001B-1', {
      commitError: cleanupFailure,
    });
    mockGetPool.mockReturnValue({ connect: vi.fn(async () => snapshotHarness.client) });
    const child = fakeChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.process.emit('close', null, 'SIGTERM'));
      return true;
    });
    mockSpawn.mockReturnValue(child.process);
    const primaryFailure = new Error('primary S3 upload failed');
    mockUploadBackupObject.mockRejectedValue(primaryFailure);

    const actual = await rejectedValue(runS3Backup('admin-1', 'backup-job-44'));

    expect(actual).toBe(primaryFailure);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE backup_runs'),
      ['run-1', 'failed', null, null, primaryFailure.message],
    );
    expect(mockPruneBackupObjects).not.toHaveBeenCalled();
  });

  it('returns persisted queue job IDs and prune warnings in backup history', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'run-1',
          created_at: new Date('2026-08-28T10:00:00.000Z'),
          finished_at: null,
          destination: 's3',
          status: 'running',
          bytes: null,
          object_key: null,
          error: null,
          triggered_by: 'admin-1',
          job_id: 'backup-job-42',
          warning: 'DeleteObjects failed (403)',
        },
        {
          id: 'run-2',
          created_at: new Date('2026-08-28T09:00:00.000Z'),
          finished_at: new Date('2026-08-28T09:01:00.000Z'),
          destination: 's3',
          status: 'success',
          bytes: '123',
          object_key: 'compendiq-backups/backup.enc',
          error: null,
          triggered_by: null,
          job_id: null,
          warning: null,
        },
      ],
    });

    await expect(listBackupRuns()).resolves.toEqual([
      expect.objectContaining({ id: 'run-1', jobId: 'backup-job-42', warning: 'DeleteObjects failed (403)' }),
      expect.objectContaining({ id: 'run-2', bytes: 123, warning: null }),
    ]);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringMatching(/SELECT .*job_id.*warning.*FROM backup_runs/s),
      [20],
    );
  });
});

describe('S3 backup run: a prune failure is a warning (#1710)', () => {
  interface CompletedUploadHarness {
    snapshotHarness: { calls: string[] };
    /** The stream handed to the uploader, i.e. the one runS3Backup must destroy. */
    readonly uploadSource: Readable;
  }
  const SUCCESS_UPDATE = ['run-1', 'success', 123, 'compendiq-backups/backup.enc', null];

  /** The run's UPDATE statements, in call order. */
  function runUpdates() {
    return mockQuery.mock.calls.filter(([sql]) => String(sql).includes('UPDATE backup_runs'));
  }
  function failedUpdates() {
    return runUpdates().filter(([, params]) => (params as unknown[])[1] === 'failed');
  }
  function warningUpdates() {
    return runUpdates().filter(([sql]) => String(sql).includes('SET warning'));
  }
  function callOrder(update: unknown[] | undefined): number {
    const index = mockQuery.mock.calls.findIndex((call) => call === update);
    return mockQuery.mock.invocationCallOrder[index]!;
  }

  /** A real encrypted stream over a fake pg_dump whose upload "completes" at once. */
  function arrangeCompletedUpload(options: {
    commitError?: unknown;
    failQuery?: (sql: string, params: unknown[] | undefined) => Error | undefined;
  } = {}): CompletedUploadHarness {
    process.env.POSTGRES_URL = 'postgres://db';
    mockGetBackupRuntimeConfig.mockResolvedValue(S3_RUNTIME_CONFIG);
    let insertedRun = false;
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      const failure = options.failQuery?.(sql, params);
      if (failure) throw failure;
      if (!insertedRun && sql.includes('INSERT INTO backup_runs')) {
        insertedRun = true;
        return { rows: [{ id: 'run-1' }] };
      }
      if (sql.includes('_migrations')) return { rows: [{ name: '108_backup_run_job_id.sql' }] };
      return { rows: [], rowCount: 1 };
    });
    const snapshotHarness = fakeSnapshotClient(
      '00000003-0000001B-1',
      'commitError' in options ? { commitError: options.commitError } : {},
    );
    mockGetPool.mockReturnValue({ connect: vi.fn(async () => snapshotHarness.client) });
    const child = fakeChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.process.emit('close', null, 'SIGTERM'));
      return true;
    });
    mockSpawn.mockReturnValue(child.process);
    let uploadSource: Readable | undefined;
    mockUploadBackupObject.mockImplementation(async (_target: unknown, key: string, stream: Readable) => {
      uploadSource = stream;
      return { key, bytes: 123 };
    });
    return {
      snapshotHarness,
      /** The stream handed to the uploader, i.e. the one runS3Backup must destroy. */
      get uploadSource() {
        return uploadSource!;
      },
    };
  }

  function expectRecordedAsSuccess() {
    expect(runUpdates()[0]![1]).toEqual(SUCCESS_UPDATE);
    expect(failedUpdates()).toEqual([]);
  }

  function expectReleasedOnce(harness: CompletedUploadHarness) {
    expect(harness.uploadSource.destroyed).toBe(true);
    expect(mockReleaseWorkerLock).toHaveBeenCalledOnce();
    expect(harness.snapshotHarness.calls.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
  }

  it.each([
    ['delete', 'DeleteObjects failed (403): <Error><Code>AccessDenied</Code></Error>'],
    ['list', 'ListObjects failed (403): <Error><Code>AccessDenied</Code></Error>'],
  ])('records success with a warning when the %s step of the prune fails', async (_step, message) => {
    const harness = arrangeCompletedUpload();
    const pruneError = new Error(message);
    mockPruneBackupObjects.mockRejectedValue(pruneError);

    await expect(runS3Backup('admin-1', 'backup-job-1')).resolves.toMatch(/^compendiq-backup-.+\.enc$/);

    expectRecordedAsSuccess();
    expect(mockMarkBackupLastRun).toHaveBeenCalledOnce();
    expect(warningUpdates().map(([sql, params]) => [String(sql), params])).toEqual([
      ['UPDATE backup_runs SET warning = $2 WHERE id = $1', ['run-1', message]],
    ]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', err: pruneError }),
      expect.any(String),
    );
    expect(mockLogAuditEvent).toHaveBeenCalledWith('admin-1', 'BACKUP_UPLOADED', 'backup', 'run-1', {
      objectKey: 'compendiq-backups/backup.enc',
      bytes: 123,
      pruneWarning: message,
    });
    expectReleasedOnce(harness);
  });

  it('truncates the stored warning to 1000 characters', async () => {
    arrangeCompletedUpload();
    mockPruneBackupObjects.mockRejectedValue(new Error(`${'x'.repeat(1000)}tail`));

    await runS3Backup(null, null);

    expect(warningUpdates()[0]![1]).toEqual(['run-1', 'x'.repeat(1000)]);
    expect(mockLogAuditEvent).toHaveBeenCalledWith(null, 'BACKUP_UPLOADED', 'backup', 'run-1', {
      objectKey: 'compendiq-backups/backup.enc',
      bytes: 123,
      pruneWarning: 'x'.repeat(1000),
    });
  });

  it('stores no warning and audits a null pruneWarning when the prune succeeds', async () => {
    arrangeCompletedUpload();
    mockPruneBackupObjects.mockResolvedValue(['compendiq-backups/old.enc']);

    await runS3Backup('admin-1', null);

    expectRecordedAsSuccess();
    expect(warningUpdates()).toEqual([]);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      { pruned: ['compendiq-backups/old.enc'] },
      'Pruned expired S3 backups',
    );
    expect(mockLogAuditEvent).toHaveBeenCalledWith('admin-1', 'BACKUP_UPLOADED', 'backup', 'run-1', {
      objectKey: 'compendiq-backups/backup.enc',
      bytes: 123,
      pruneWarning: null,
    });
  });

  it('records success and the interval gate, then releases the lock, and only then prunes, warns and audits', async () => {
    arrangeCompletedUpload();
    let lockReleasesWhenPruneStarted = -1;
    mockPruneBackupObjects.mockImplementation(async () => {
      lockReleasesWhenPruneStarted = mockReleaseWorkerLock.mock.calls.length;
      throw new Error('DeleteObjects failed (403)');
    });

    await runS3Backup('admin-1', null);

    expect(lockReleasesWhenPruneStarted).toBe(1);
    const order = [
      callOrder(runUpdates()[0]),
      mockMarkBackupLastRun.mock.invocationCallOrder[0]!,
      mockReleaseWorkerLock.mock.invocationCallOrder[0]!,
      mockPruneBackupObjects.mock.invocationCallOrder[0]!,
      callOrder(warningUpdates()[0]),
      mockLogAuditEvent.mock.invocationCallOrder[0]!,
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
  });

  it('lets isBackupDue hold for the interval after a success with a warning', async () => {
    arrangeCompletedUpload();
    mockPruneBackupObjects.mockRejectedValue(new Error('DeleteObjects failed (403)'));

    await runS3Backup(null, null);

    const lastRunAt = mockMarkBackupLastRun.mock.calls[0]![0] as string;
    mockGetBackupRuntimeConfig.mockResolvedValue({
      s3: { enabled: true },
      schedule: { enabled: true, intervalHours: 24, lastRunAt },
    });
    const finishedAt = Date.parse(lastRunAt);
    await expect(isBackupDue(new Date(finishedAt + 15 * 60 * 1000))).resolves.toBe(false);
    await expect(isBackupDue(new Date(finishedAt + 23 * 60 * 60 * 1000))).resolves.toBe(false);
    await expect(isBackupDue(new Date(finishedAt + 24 * 60 * 60 * 1000))).resolves.toBe(true);
  });

  describe('a failure after the upload is recorded', () => {
    it('keeps the success, releases once and still prunes when markBackupLastRun rejects', async () => {
      const harness = arrangeCompletedUpload();
      const gateError = new Error('settings write failed');
      mockMarkBackupLastRun.mockRejectedValue(gateError);

      await expect(runS3Backup('admin-1', null)).resolves.toMatch(/^compendiq-backup-/);

      expectRecordedAsSuccess();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-1', err: gateError }),
        expect.any(String),
      );
      expectReleasedOnce(harness);
      expect(mockPruneBackupObjects).toHaveBeenCalledOnce();
      expect(mockLogAuditEvent).toHaveBeenCalledOnce();
    });

    it('keeps the success when releasing the snapshot rejects after the upload', async () => {
      const harness = arrangeCompletedUpload({ commitError: new Error('snapshot commit failed') });

      await expect(runS3Backup('admin-1', null)).resolves.toMatch(/^compendiq-backup-/);

      expectRecordedAsSuccess();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-1' }),
        'Failed to release backup resources',
      );
      expect(harness.uploadSource.destroyed).toBe(true);
      expect(mockMarkBackupLastRun).toHaveBeenCalledOnce();
      expect(mockPruneBackupObjects).toHaveBeenCalledOnce();
      expect(mockLogAuditEvent).toHaveBeenCalledOnce();
    });

    it('keeps the success when persisting the warning rejects', async () => {
      arrangeCompletedUpload({
        failQuery: (sql) => (sql.includes('SET warning') ? new Error('warning write failed') : undefined),
      });
      mockPruneBackupObjects.mockRejectedValue(new Error('DeleteObjects failed (403)'));

      await expect(runS3Backup('admin-1', null)).resolves.toMatch(/^compendiq-backup-/);

      expectRecordedAsSuccess();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-1' }),
        'Failed to persist the backup prune warning',
      );
      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        'admin-1',
        'BACKUP_UPLOADED',
        'backup',
        'run-1',
        expect.objectContaining({ pruneWarning: 'DeleteObjects failed (403)' }),
      );
    });

    it('keeps the success when the audit write rejects', async () => {
      arrangeCompletedUpload();
      mockPruneBackupObjects.mockRejectedValue(new Error('DeleteObjects failed (403)'));
      mockLogAuditEvent.mockRejectedValue(new Error('audit write failed'));

      await expect(runS3Backup('admin-1', null)).resolves.toMatch(/^compendiq-backup-/);

      expectRecordedAsSuccess();
      expect(warningUpdates()).toHaveLength(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-1' }),
        'Failed to audit the uploaded backup',
      );
    });
  });

  describe('before the upload is recorded', () => {
    it('destroys the stream, releases once and records failed when the success write rejects', async () => {
      const writeError = new Error('database unavailable');
      const harness = arrangeCompletedUpload({
        failQuery: (sql, params) =>
          sql.includes('UPDATE backup_runs') && params?.[1] === 'success' ? writeError : undefined,
      });

      await expect(runS3Backup('admin-1', null)).rejects.toBe(writeError);

      expectReleasedOnce(harness);
      expect(failedUpdates().map(([, params]) => params)).toEqual([
        ['run-1', 'failed', null, null, 'database unavailable'],
      ]);
      expect(mockMarkBackupLastRun).not.toHaveBeenCalled();
      expect(mockPruneBackupObjects).not.toHaveBeenCalled();
      expect(mockLogAuditEvent).not.toHaveBeenCalled();
      // The failed write comes after the lock is released.
      expect(mockReleaseWorkerLock.mock.invocationCallOrder[0]!).toBeLessThan(
        callOrder(failedUpdates()[0]),
      );
    });
  });
});

describe('dumpStreamFromProcess', () => {
  it('rejects when stdout ends before pg_dump later exits non-zero', async () => {
    const child = fakeChild();
    let settled = false;
    const result = readAll(dumpStreamFromProcess(child.process)).finally(() => {
      settled = true;
    });
    const stdoutEnded = once(child.stdout, 'end');

    child.stdout.end(Buffer.from('partial'));
    await stdoutEnded;
    await nextEventLoopTurn();
    expect(settled).toBe(false);

    child.stderr.end(Buffer.from('fatal dump error'));
    await once(child.stderr, 'end');
    const rejection = expect(result).rejects.toThrow(/pg_dump exited 2.*fatal dump error/i);
    child.process.emit('close', 2);
    await rejection;
  });

  it('does not emit EOF before pg_dump closes successfully', async () => {
    const child = fakeChild();
    const output = dumpStreamFromProcess(child.process);
    let outputEnded = false;
    let settled = false;
    output.once('end', () => {
      outputEnded = true;
    });
    const result = readAll(output).finally(() => {
      settled = true;
    });
    const stdoutEnded = once(child.stdout, 'end');

    child.stdout.end(Buffer.from('complete'));
    await stdoutEnded;
    await nextEventLoopTurn();
    expect(outputEnded).toBe(false);
    expect(settled).toBe(false);

    child.process.emit('close', 0);
    await expect(result).resolves.toEqual(Buffer.from('complete'));
  });

  it('bounds stderr retained for the failure message', async () => {
    const child = fakeChild();
    const result = readAll(dumpStreamFromProcess(child.process));
    child.stderr.write(Buffer.alloc(8 * 1024, 0x61));
    child.stdout.end();
    child.process.emit('close', 1);
    await expect(result).rejects.toThrow(/^pg_dump exited 1: a{4096}$/);
  });

  it('cancels pg_dump exactly once when the returned stream is destroyed', async () => {
    const child = fakeChild();
    const output = dumpStreamFromProcess(child.process);
    const closed = once(output, 'close');

    output.destroy();
    output.destroy();
    await closed;
    output.destroy();
    await nextEventLoopTurn();

    expect(child.stdout.destroyed).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
