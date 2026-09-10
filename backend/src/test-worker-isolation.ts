/**
 * Per-worker Postgres + Redis isolation so vitest can run test files in
 * parallel. Every worker gets its own database (`kb_creator_test_wN`) and
 * Redis logical DB (`/N`) and a `vitest:wN:` pub/sub prefix. Wired from
 * `test-setup.ts` so `fileParallelism` can stay on. Redis pub/sub is not
 * scoped to logical DBs — the prefix in `prefixed-redis-channel.ts` is what
 * keeps collab/presence/cache-bus from cross-talking across workers.
 *
 * Redis ships 16 logical DBs (0–15). Isolation keys off
 * `VITEST_POOL_ID` (the reusable 1..maxWorkers slot), never
 * `VITEST_WORKER_ID` (that one increments per file).
 */

export const MAX_TEST_WORKERS = 8;
export const TEST_DATABASE_STEM = 'kb_creator_test';

const DEFAULT_POSTGRES_URL =
  'postgresql://kb_user:changeme-postgres@localhost:5433/kb_creator_test';
const DEFAULT_REDIS_URL = 'redis://:changeme-redis@localhost:6379';

export function workerIdFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
  // Pool id is the reusable slot (1..maxWorkers). Worker id increments
  // once per file and will walk off the Redis DB budget if we key on it.
  const raw = env.VITEST_POOL_ID;
  if (raw === undefined || raw === '' || raw === 'undefined') return 0;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`VITEST_POOL_ID must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  const id = Number(raw);
  if (id > MAX_TEST_WORKERS) {
    throw new Error(`VITEST_POOL_ID ${id} exceeds MAX_TEST_WORKERS=${MAX_TEST_WORKERS}`);
  }
  return id;
}

export function workerDatabaseName(workerId: number): string {
  return `${TEST_DATABASE_STEM}_w${workerId}`;
}

function withPathname(url: string, pathname: string): string {
  const parsed = new URL(url);
  parsed.pathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return parsed.toString().replace(/\/$/, '');
}

export function workerPostgresUrl(baseUrl: string, workerId: number): string {
  return withPathname(baseUrl, workerDatabaseName(workerId));
}

export function maintenancePostgresUrl(postgresUrl: string): string {
  return withPathname(postgresUrl, 'postgres');
}

export function workerRedisUrl(baseUrl: string, workerId: number): string {
  return withPathname(baseUrl, String(workerId));
}

/**
 * Point POSTGRES_* and REDIS_URL at this worker's isolated slots.
 * Safe to call more than once — a already-suffixed URL is rewritten, not stacked.
 */
export function applyWorkerIsolation(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): void {
  const id = workerIdFromEnv(env);
  const postgresBase = env.POSTGRES_TEST_URL ?? env.POSTGRES_URL ?? DEFAULT_POSTGRES_URL;
  const redisBase = env.REDIS_URL ?? DEFAULT_REDIS_URL;
  const postgresUrl = workerPostgresUrl(postgresBase, id);
  env.POSTGRES_URL = postgresUrl;
  env.POSTGRES_TEST_URL = postgresUrl;
  env.REDIS_URL = workerRedisUrl(redisBase, id);
}

export async function ensureWorkerDatabase(postgresUrl: string): Promise<void> {
  const dbName = new URL(postgresUrl).pathname.replace(/^\//, '');
  if (!new RegExp(`^${TEST_DATABASE_STEM}_w\\d+$`).test(dbName)) {
    throw new Error(`Refusing to CREATE DATABASE ${JSON.stringify(dbName)}`);
  }

  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: maintenancePostgresUrl(postgresUrl) });
  await client.connect();
  try {
    const { rows } = await client.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [dbName],
    );
    if (rows[0]?.exists) return;
    await client.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await client.end();
  }
}
