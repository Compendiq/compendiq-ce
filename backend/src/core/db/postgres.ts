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

export async function runMigrations(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

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
    client.release();
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
