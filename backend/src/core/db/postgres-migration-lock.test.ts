import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isDbAvailable } from '../../test-db-helper.js';
import { runMigrations, closePool, query } from './postgres.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbAvailable = await isDbAvailable();

// Dedicated throwaway database so this test never fights the shared schema
// used by the rest of the suite (which runs migrations once per file).
const LOCK_TEST_DB = 'kb_creator_migration_lock_test';

// POSTGRES_URL is set by test-setup.ts before this module loads.
const baseUrl = process.env.POSTGRES_URL as string;

function urlForDb(dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** Run admin DDL (CREATE/DROP DATABASE) on the suite's default database. */
async function withAdminClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe.skipIf(!dbAvailable)('runMigrations cross-replica locking (issue #745)', () => {
  beforeAll(async () => {
    await withAdminClient(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${LOCK_TEST_DB} WITH (FORCE)`);
      await client.query(`CREATE DATABASE ${LOCK_TEST_DB}`);
    });
    // Re-point the singleton pool at the fresh database. The pool is created
    // lazily from POSTGRES_URL, so it must be closed before the env switch.
    await closePool();
    process.env.POSTGRES_URL = urlForDb(LOCK_TEST_DB);
  }, 60_000);

  afterAll(async () => {
    await closePool();
    process.env.POSTGRES_URL = baseUrl;
    await withAdminClient(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${LOCK_TEST_DB} WITH (FORCE)`);
    });
  }, 60_000);

  it(
    'two concurrent runMigrations() both succeed and apply each migration exactly once',
    async () => {
      // Simulates a rolling deploy / HPA scale-up: two replicas boot against
      // the same fresh database at the same time. Each call checks out its
      // own pool client, i.e. its own Postgres session — exactly like two pods.
      const results = await Promise.allSettled([runMigrations(), runMigrations()]);

      const failures = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => String(r.reason));
      expect(failures).toEqual([]);

      // Each migration file recorded exactly once (UNIQUE on name would throw
      // anyway, but assert explicitly for clarity).
      const dupes = await query<{ name: string; n: string }>(
        'SELECT name, COUNT(*) AS n FROM _migrations GROUP BY name HAVING COUNT(*) > 1',
      );
      expect(dupes.rows).toEqual([]);

      const migrationsDir = path.join(__dirname, 'migrations');
      const fileCount = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql')).length;
      const total = await query<{ count: string }>('SELECT COUNT(*) AS count FROM _migrations');
      expect(parseInt(total.rows[0].count, 10)).toBe(fileCount);
    },
    120_000,
  );
});
