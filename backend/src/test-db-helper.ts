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

export async function truncateAllTables(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    DO $$ DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != '_migrations')
      LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
}

export async function teardownTestDb(): Promise<void> {
  await closePool();
  initialized = false;
}
