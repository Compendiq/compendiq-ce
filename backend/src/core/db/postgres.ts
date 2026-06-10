import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.POSTGRES_URL,
      max: parseInt(process.env.PG_POOL_MAX || '20', 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ...(process.env.PG_STATEMENT_TIMEOUT
        ? { options: `--statement_timeout=${process.env.PG_STATEMENT_TIMEOUT}` }
        : {}),
    });
    pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected PostgreSQL pool error');
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ── Dedicated vector search pool ─────────────────────────────────────────
// Keeps long-running pgvector similarity queries from consuming the
// main pool's connections and starving CRUD routes.

let vectorPool: pg.Pool | null = null;

export function getVectorPool(): pg.Pool {
  if (!vectorPool) {
    vectorPool = new pg.Pool({
      connectionString: process.env.POSTGRES_URL,
      max: parseInt(process.env.PG_VECTOR_POOL_MAX ?? '5', 10),
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    vectorPool.on('error', (err) => {
      logger.error({ err }, 'Unexpected PostgreSQL vector pool error');
    });
  }
  return vectorPool;
}

export async function closeVectorPool(): Promise<void> {
  if (vectorPool) {
    await vectorPool.end();
    vectorPool = null;
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

// Cross-replica mutex for the migrations runner (issue #745). Arbitrary but
// stable application-defined key; must stay unique among advisory-lock users
// of this database. The lock is SESSION-scoped, so it is acquired and released
// on the same dedicated pool client below — and it survives the per-migration
// BEGIN/COMMIT/ROLLBACK because session-level advisory locks do not honor
// transaction semantics. If the holding session dies mid-run, PostgreSQL
// releases the lock automatically, so a crashed pod cannot wedge deploys.
const MIGRATIONS_ADVISORY_LOCK_ID = 745_001;

export async function runMigrations(): Promise<void> {
  const client = await getPool().connect();
  try {
    // The blocking pg_advisory_lock() wait below counts as statement execution
    // time, so the pool-wide PG_STATEMENT_TIMEOUT (applied to every connection
    // via startup `options` in getPool()) would cancel replicas waiting on a
    // slow migration winner — and a server/role-level lock_timeout would do
    // the same to the lock wait and to DDL inside the migrations. Exempt this
    // session for the duration of the run. Plain `SET` (not `SET LOCAL`) is
    // deliberate: the advisory lock is taken outside any transaction, and the
    // exemption must also cover the long-running migration statements
    // themselves. Both settings are session-scoped, so they are RESET in the
    // outer finally before the client returns to the shared pool.
    await client.query('SET statement_timeout = 0');
    await client.query('SET lock_timeout = 0');

    // Serialize replicas booting concurrently (rolling deploy / HPA scale-up):
    // exactly one pod runs the migration loop; the rest block here until the
    // winner finishes, then re-read _migrations below and see its work.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATIONS_ADVISORY_LOCK_ID]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // Must be read AFTER acquiring the lock so a pod that waited sees the
      // migrations the winner just applied.
      const applied = await client.query<{ name: string }>('SELECT name FROM _migrations ORDER BY id');
      const appliedSet = new Set(applied.rows.map((r) => r.name));

      const migrationsDir = path.join(__dirname, 'migrations');
      const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

      for (const file of files) {
        if (appliedSet.has(file)) continue;

        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
        logger.info({ migration: file }, 'Running migration');

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
          await client.query('COMMIT');
          logger.info({ migration: file }, 'Migration applied');
        } catch (err) {
          await client.query('ROLLBACK');
          logger.error({ err, migration: file }, 'Migration failed');
          throw err;
        }
      }
    } finally {
      // Explicit unlock so the pooled connection does not keep holding the
      // lock when it returns to the pool. Swallow failures: if the connection
      // is already broken, the server has released the lock with the session.
      await client
        .query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_ADVISORY_LOCK_ID])
        .catch((err) => {
          logger.warn({ err }, 'Failed to release migrations advisory lock (auto-released on disconnect)');
        });
    }
  } finally {
    try {
      // RESET restores each parameter to its session default — for
      // statement_timeout that is the value from the pool's startup `options`
      // (PG_STATEMENT_TIMEOUT, when set), NOT Postgres' compiled-in default —
      // so the client re-enters the shared pool with the configured timeouts.
      await client.query('RESET statement_timeout; RESET lock_timeout');
      client.release();
    } catch (err) {
      // Connection is unusable: destroy it rather than return a session with
      // disabled timeouts to the pool.
      logger.warn({ err }, 'Failed to restore timeouts on migration client, discarding connection');
      client.release(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

export async function checkConnection(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
