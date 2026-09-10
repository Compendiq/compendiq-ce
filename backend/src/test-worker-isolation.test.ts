import { describe, expect, it } from 'vitest';
import {
  MAX_TEST_WORKERS,
  applyWorkerIsolation,
  maintenancePostgresUrl,
  workerDatabaseName,
  workerIdFromEnv,
  workerPostgresUrl,
  workerRedisUrl,
} from './test-worker-isolation.js';

describe('workerIdFromEnv', () => {
  it('defaults to 0 when Vitest has not assigned a pool slot', () => {
    expect(workerIdFromEnv({})).toBe(0);
  });

  it('reads VITEST_POOL_ID and ignores the incrementing VITEST_WORKER_ID', () => {
    expect(workerIdFromEnv({ VITEST_POOL_ID: '3' })).toBe(3);
    expect(workerIdFromEnv({ VITEST_POOL_ID: '3', VITEST_WORKER_ID: '29' })).toBe(3);
    expect(workerIdFromEnv({ VITEST_WORKER_ID: '29' })).toBe(0);
  });

  it('rejects a non-numeric or out-of-range pool id rather than inventing a colliding slot', () => {
    expect(() => workerIdFromEnv({ VITEST_POOL_ID: 'nope' })).toThrow(/VITEST_POOL_ID/);
    expect(() => workerIdFromEnv({ VITEST_POOL_ID: '-1' })).toThrow(/VITEST_POOL_ID/);
    expect(() => workerIdFromEnv({ VITEST_POOL_ID: String(MAX_TEST_WORKERS + 1) })).toThrow(
      /VITEST_POOL_ID/,
    );
  });
});

describe('workerDatabaseName', () => {
  it('is a safe identifier scoped to the worker', () => {
    expect(workerDatabaseName(3)).toBe('kb_creator_test_w3');
    expect(workerDatabaseName(3)).toMatch(/^[a-z0-9_]+$/);
  });
});

describe('workerPostgresUrl', () => {
  it('points the existing test URL at the worker database', () => {
    expect(workerPostgresUrl('postgresql://kb_user:changeme-postgres@localhost:5433/kb_creator_test', 3)).toBe(
      'postgresql://kb_user:changeme-postgres@localhost:5433/kb_creator_test_w3',
    );
  });

  it('replaces an already-suffixed database name', () => {
    expect(workerPostgresUrl('postgresql://kb_user:p@localhost:5433/kb_creator_test_w1', 4)).toBe(
      'postgresql://kb_user:p@localhost:5433/kb_creator_test_w4',
    );
  });

  it('keeps userinfo encoding intact', () => {
    expect(workerPostgresUrl('postgresql://kb_user:p%40ss@localhost:5433/kb_creator_test', 2)).toBe(
      'postgresql://kb_user:p%40ss@localhost:5433/kb_creator_test_w2',
    );
  });
});

describe('maintenancePostgresUrl', () => {
  it('connects to the cluster default so CREATE DATABASE is legal', () => {
    expect(maintenancePostgresUrl('postgresql://kb_user:p@localhost:5433/kb_creator_test_w3')).toBe(
      'postgresql://kb_user:p@localhost:5433/postgres',
    );
  });
});

describe('applyWorkerIsolation', () => {
  it('rewrites postgres and redis onto the pool slot without stacking suffixes', () => {
    const env: Record<string, string | undefined> = {
      VITEST_POOL_ID: '3',
      POSTGRES_TEST_URL: 'postgresql://u:p@localhost:5433/kb_creator_test',
      REDIS_URL: 'redis://localhost:6379',
    };
    applyWorkerIsolation(env);
    expect(env.POSTGRES_URL).toBe('postgresql://u:p@localhost:5433/kb_creator_test_w3');
    expect(env.POSTGRES_TEST_URL).toBe(env.POSTGRES_URL);
    expect(env.REDIS_URL).toBe('redis://localhost:6379/3');
    applyWorkerIsolation(env);
    expect(env.POSTGRES_URL).toBe('postgresql://u:p@localhost:5433/kb_creator_test_w3');
  });
});

describe('workerRedisUrl', () => {
  it('selects the worker logical database', () => {
    expect(workerRedisUrl('redis://localhost:6379', 3)).toBe('redis://localhost:6379/3');
  });

  it('replaces an existing database number and keeps auth', () => {
    expect(workerRedisUrl('redis://:changeme-redis@localhost:6379/0', 2)).toBe(
      'redis://:changeme-redis@localhost:6379/2',
    );
  });
});

describe('ensureWorkerDatabase', () => {
  it('creates the named worker database and is idempotent', async () => {
    const { isDbAvailable } = await import('./test-db-helper.js');
    const { ensureWorkerDatabase, workerPostgresUrl } = await import('./test-worker-isolation.js');
    if (!(await isDbAvailable())) return;
    const url = workerPostgresUrl(process.env.POSTGRES_URL!, 0);
    await expect(ensureWorkerDatabase(url)).resolves.toBeUndefined();
    await expect(ensureWorkerDatabase(url)).resolves.toBeUndefined();
  });

  it('refuses to create a database whose name is not the worker stem', async () => {
    const { ensureWorkerDatabase } = await import('./test-worker-isolation.js');
    await expect(
      ensureWorkerDatabase('postgresql://kb_user:p@localhost:5433/postgres'),
    ).rejects.toThrow(/Refusing to CREATE DATABASE/);
  });
});
