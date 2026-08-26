import { runMigrations, getPool, closePool, checkConnection } from './core/db/postgres.js';

let initialized = false;
let _dbAvailable: boolean | null = null;

/**
 * Check whether the test PostgreSQL instance is reachable.
 * Result is cached after the first probe.
 */
export async function isDbAvailable(): Promise<boolean> {
  if (_dbAvailable !== null) return _dbAvailable;
  _dbAvailable = await checkConnection();
  return _dbAvailable;
}

export async function setupTestDb(): Promise<void> {
  if (initialized) return;

  await runMigrations();
  initialized = true;
}

const DEADLOCK = '40P01';
const LOCK_NOT_AVAILABLE = '55P03';

export async function truncateAllTables(): Promise<void> {
  const pool = getPool();
  const sql = `
    DO $$ DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != '_migrations')
      LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `;
  // Parallel files on one worker DB are gone, but a leftover collab persist
  // (or another pooled client in THIS file) can still deadlock TRUNCATE.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await pool.query(sql);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: string }).code;
      if (code !== DEADLOCK && code !== LOCK_NOT_AVAILABLE) throw err;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function teardownTestDb(): Promise<void> {
  await closePool();
  initialized = false;
}
