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
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetPool: vi.fn(),
  mockAcquireWorkerLock: vi.fn(),
  mockRefreshWorkerLock: vi.fn(),
  mockGetBackupRuntimeConfig: vi.fn(),
  mockReleaseWorkerLock: vi.fn(),
}));
vi.mock('../db/postgres.js', () => ({
  getPool: () => mockGetPool(),
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
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
  markBackupLastRun: vi.fn(),
  requireMasterBackupKey: vi.fn(() => 'master-key-at-least-32-characters'),
}));
vi.mock('./backup-s3.js', () => ({
  objectKeyFor: vi.fn(),
  pruneBackupObjects: vi.fn(),
  uploadBackupObject: vi.fn(),
}));

import {
  createEncryptedBackupStream,
  dumpStreamFromProcess,
  exportPostgresSnapshot,
  latestSchemaMigration,
  listBackupRuns,
  runS3Backup,
  spawnPgDump,
  terminatePgDumpAndWait,
} from './backup-service.js';

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
  options: { commitError?: Error } = {},
) {
  const calls: string[] = [];
  const release = vi.fn();
  const client = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql === 'COMMIT' && options.commitError) throw options.commitError;
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
  mockAcquireWorkerLock.mockReset();
  mockAcquireWorkerLock.mockResolvedValue('lock-token');
  mockRefreshWorkerLock.mockReset();
  mockRefreshWorkerLock.mockResolvedValue(undefined);
  mockReleaseWorkerLock.mockReset();
  mockReleaseWorkerLock.mockResolvedValue(undefined);
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

  it('returns persisted queue job IDs in backup history', async () => {
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
        },
      ],
    });

    await expect(listBackupRuns()).resolves.toEqual([
      expect.objectContaining({ id: 'run-1', jobId: 'backup-job-42' }),
    ]);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringMatching(/SELECT .*job_id.*FROM backup_runs/s),
      [20],
    );
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
