import { describe, expect, it } from 'vitest';
import {
  MAX_TEST_WORKERS,
  applyWorkerIsolation,
  ensureWorkerDatabase,
  maintenancePostgresUrl,
  workerDatabaseName,
  workerIdFromEnv,
  workerPostgresUrl,
  workerRedisUrl,
} from './test-worker-isolation.js';

const invalidNamespaces = [
  '',
  'Uppercase',
  'with-hyphen',
  "with'quote",
  'with/slash',
  'with space',
  'name\n',
  'a'.repeat(33),
  '1namespace',
  '_namespace',
];

describe('TEST_DATABASE_NAMESPACE pure', () => {
  const namespace = 'epic1905_a8zoun_1739';
  const databaseName = 'kb_creator_test_epic1905_a8zoun_1739_w1';
  const postgresBase = 'postgresql://test%40user:p%40ss@db.invalid:5433/kb_creator_test';

  it('preserves legacy names when the namespace is absent or undefined', () => {
    for (const workerId of [0, 1, MAX_TEST_WORKERS]) {
      expect(workerDatabaseName(workerId)).toBe(`kb_creator_test_w${workerId}`);
      expect(workerDatabaseName(workerId, undefined)).toBe(`kb_creator_test_w${workerId}`);
    }
  });

  it('preserves legacy URL encoding and never infers a namespace from the incoming path', () => {
    const expected = 'postgresql://test%40user:p%40ss@db.invalid:5433/kb_creator_test_w1';
    expect(workerPostgresUrl(postgresBase, 1)).toBe(expected);
    expect(workerPostgresUrl(postgresBase, 1, undefined)).toBe(expected);
    expect(
      workerPostgresUrl(
        'postgresql://test%40user:p%40ss@db.invalid:5433/kb_creator_test_epic1905_a8zoun_1738_w8',
        1,
      ),
    ).toBe(expected);
  });

  it('preserves namespace-absent URL precedence and fixture-env idempotence', () => {
    const env: Record<string, string | undefined> = {
      VITEST_POOL_ID: '1',
      VITEST_WORKER_ID: '29',
      POSTGRES_TEST_URL: postgresBase,
      POSTGRES_URL: 'postgresql://other:password@other.invalid:6543/ignored',
      REDIS_URL: 'redis://:p%40ss@cache.invalid:6379/7',
      UNCHANGED: 'sentinel',
    };
    const expected = {
      ...env,
      POSTGRES_URL: 'postgresql://test%40user:p%40ss@db.invalid:5433/kb_creator_test_w1',
      POSTGRES_TEST_URL: 'postgresql://test%40user:p%40ss@db.invalid:5433/kb_creator_test_w1',
      REDIS_URL: 'redis://:p%40ss@cache.invalid:6379/1',
    };
    applyWorkerIsolation(env);
    expect(env).toEqual(expected);
    applyWorkerIsolation(env);
    expect(env).toEqual(expected);
  });

  it.each([
    {
      source: 'POSTGRES_URL',
      input: { POSTGRES_URL: 'postgresql://u:p@fallback.invalid:6543/original' },
      expected: 'postgresql://u:p@fallback.invalid:6543/kb_creator_test_w1',
    },
    {
      source: 'default URLs',
      input: { TEST_DATABASE_NAMESPACE: undefined },
      expected: 'postgresql://kb_user:changeme-postgres@localhost:5433/kb_creator_test_w1',
    },
  ])('preserves namespace-absent $source fallback', ({ input, expected }) => {
    const env: Record<string, string | undefined> = { VITEST_POOL_ID: '1', ...input };
    applyWorkerIsolation(env);
    expect(env.POSTGRES_URL).toBe(expected);
    expect(env.POSTGRES_TEST_URL).toBe(expected);
    expect(env.REDIS_URL).toBe('redis://:changeme-redis@localhost:6379/1');
  });

  it.each([
    ['epic1905_a8zoun_1738', 'kb_creator_test_epic1905_a8zoun_1738_w1'],
    ['epic1905_a8zoun_1739', 'kb_creator_test_epic1905_a8zoun_1739_w1'],
  ])('derives the exact slot-1 database name for namespace %s', (value, expected) => {
    expect(workerDatabaseName(1, value)).toBe(expected);
  });

  it('uses the namespace in the URL while retaining encoded credentials, host and port', () => {
    expect(workerPostgresUrl(postgresBase, 1, namespace)).toBe(
      'postgresql://test%40user:p%40ss@db.invalid:5433/kb_creator_test_epic1905_a8zoun_1739_w1',
    );
  });

  it.each(['a', 'a'.repeat(32)])('accepts the namespace length boundary %j', (value) => {
    expect(workerDatabaseName(1, value)).toBe(`kb_creator_test_${value}_w1`);
  });

  it.each([
    'kb_creator_test',
    'kb_creator_test_w8',
    'kb_creator_test_epic1905_a8zoun_1738_w1',
    'kb_creator_test_epic1905_a8zoun_1739_w1',
  ])('replaces %s without stacking suffixes and keeps Redis on slot 1', (incomingPath) => {
    const env: Record<string, string | undefined> = {
      TEST_DATABASE_NAMESPACE: namespace,
      VITEST_POOL_ID: '1',
      POSTGRES_TEST_URL: `postgresql://test%40user:p%40ss@db.invalid:5433/${incomingPath}`,
      POSTGRES_URL: 'postgresql://other:password@other.invalid:6543/ignored',
      REDIS_URL: 'redis://:p%40ss@cache.invalid:6379/7',
      UNCHANGED: 'sentinel',
    };
    const expected = {
      ...env,
      POSTGRES_URL: `postgresql://test%40user:p%40ss@db.invalid:5433/${databaseName}`,
      POSTGRES_TEST_URL: `postgresql://test%40user:p%40ss@db.invalid:5433/${databaseName}`,
      REDIS_URL: 'redis://:p%40ss@cache.invalid:6379/1',
    };
    applyWorkerIsolation(env);
    expect(env).toEqual(expected);
    applyWorkerIsolation(env);
    expect(env).toEqual(expected);
  });

  it.each(invalidNamespaces)('rejects invalid namespace %j in the name and URL helpers', (value) => {
    expect(() => workerDatabaseName(1, value)).toThrow(/TEST_DATABASE_NAMESPACE/);
    expect(() => workerPostgresUrl(postgresBase, 1, value)).toThrow(/TEST_DATABASE_NAMESPACE/);
  });

  it.each(invalidNamespaces)('rejects invalid namespace %j before any fixture-env mutation', (value) => {
    const env: Record<string, string | undefined> = {
      TEST_DATABASE_NAMESPACE: value,
      VITEST_POOL_ID: '1',
      POSTGRES_TEST_URL: postgresBase,
      POSTGRES_URL: 'postgresql://other:password@other.invalid:6543/original',
      REDIS_URL: 'redis://:p%40ss@cache.invalid:6379/7',
      UNCHANGED: 'sentinel',
    };
    const before = { ...env };
    expect(() => applyWorkerIsolation(env)).toThrow(/TEST_DATABASE_NAMESPACE/);
    expect(env).toEqual(before);
  });

  it('accepts the literal undefined namespace according to the grammar', () => {
    const expectedPostgres =
      'postgresql://test%40user:p%40ss@db.invalid:5433/kb_creator_test_undefined_w1';
    expect(workerDatabaseName(1, 'undefined')).toBe('kb_creator_test_undefined_w1');
    expect(workerPostgresUrl(postgresBase, 1, 'undefined')).toBe(expectedPostgres);
    const env: Record<string, string | undefined> = {
      TEST_DATABASE_NAMESPACE: 'undefined',
      VITEST_POOL_ID: '1',
      POSTGRES_TEST_URL: postgresBase,
      POSTGRES_URL: 'postgresql://other:password@other.invalid:6543/ignored',
      REDIS_URL: 'redis://:p%40ss@cache.invalid:6379/7',
      UNCHANGED: 'sentinel',
    };
    const expected = {
      ...env,
      POSTGRES_URL: expectedPostgres,
      POSTGRES_TEST_URL: expectedPostgres,
      REDIS_URL: 'redis://:p%40ss@cache.invalid:6379/1',
    };
    applyWorkerIsolation(env);
    expect(env).toEqual(expected);
    expect(env.TEST_DATABASE_NAMESPACE).toBe('undefined');
  });
});

describe('TEST_DATABASE_NAMESPACE preconnection', () => {
  const namespace = 'epic1905_a8zoun_1739';
  const postgresBase = 'postgresql://guard_user:guard_password@guard.invalid:9';

  it.each([
    'postgres',
    'kb_creator_test_w0',
    'kb_creator_test_w1',
    'kb_creator_test_epic1905_a8zoun_1738_w1',
    'kb_creator_test_epic1905_a8zoun_1739_w0',
    'kb_creator_test_epic1905_a8zoun_1739_w2',
    'kb_creator_test_epic1905_a8zoun_1739_w1_extra',
  ])('refuses %s outside the exact active namespace and worker', async (databaseName) => {
    const postgresUrl = `${postgresBase}/${databaseName}`;
    const env: Record<string, string | undefined> = {
      TEST_DATABASE_NAMESPACE: namespace,
      VITEST_POOL_ID: '1',
      POSTGRES_URL: postgresUrl,
      POSTGRES_TEST_URL: postgresUrl,
      UNCHANGED: 'sentinel',
    };
    const before = { ...env };
    await expect(ensureWorkerDatabase(postgresUrl, env)).rejects.toThrow(
      /Refusing to CREATE DATABASE/,
    );
    expect(env).toEqual(before);
  });

  it.each(invalidNamespaces)(
    'validates invalid namespace %j before a legacy or maintenance URL',
    async (value) => {
      for (const databaseName of ['kb_creator_test_w1', 'postgres']) {
        const postgresUrl = `${postgresBase}/${databaseName}`;
        const env: Record<string, string | undefined> = {
          TEST_DATABASE_NAMESPACE: value,
          VITEST_POOL_ID: '1',
          POSTGRES_URL: postgresUrl,
          POSTGRES_TEST_URL: postgresUrl,
          UNCHANGED: 'sentinel',
        };
        const before = { ...env };
        await expect(ensureWorkerDatabase(postgresUrl, env)).rejects.toThrow(
          /TEST_DATABASE_NAMESPACE/,
        );
        expect(env).toEqual(before);
      }
    },
  );

  it.each([
    { label: 'omitted', namespaceEnv: {} },
    { label: 'actual undefined', namespaceEnv: { TEST_DATABASE_NAMESPACE: undefined } },
  ])('preserves legacy refusal when the namespace is $label', async ({ namespaceEnv }) => {
    const postgresUrl = `${postgresBase}/postgres`;
    const env: Record<string, string | undefined> = {
      ...namespaceEnv,
      VITEST_POOL_ID: '1',
      POSTGRES_URL: postgresUrl,
      POSTGRES_TEST_URL: postgresUrl,
      UNCHANGED: 'sentinel',
    };
    const before = { ...env };
    await expect(ensureWorkerDatabase(postgresUrl, env)).rejects.toThrow(
      /Refusing to CREATE DATABASE/,
    );
    expect(env).toEqual(before);
  });
});

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
    // Keep DB imports in this callback so setup-free groups never load database modules.
    const { isDbAvailable } = await import('./test-db-helper.js');
    expect(await isDbAvailable()).toBe(true);
    const url = process.env.POSTGRES_URL!;
    await expect(ensureWorkerDatabase(url)).resolves.toBeUndefined();
    await expect(ensureWorkerDatabase(url)).resolves.toBeUndefined();
    const { query } = await import('./core/db/postgres.js');
    const { rows } = await query<{ name: string }>('SELECT current_database() AS name');
    expect(rows[0]?.name).toBe(
      workerDatabaseName(workerIdFromEnv(), process.env.TEST_DATABASE_NAMESPACE),
    );
  });

  it('refuses to create a database whose name is not the worker stem', async () => {
    await expect(
      ensureWorkerDatabase('postgresql://guard_user:guard_password@guard.invalid:9/postgres'),
    ).rejects.toThrow(/Refusing to CREATE DATABASE/);
  });
});
