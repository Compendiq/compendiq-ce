import { runMigrations, getPool, closePool } from './db/postgres.js';

let initialized = false;

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
