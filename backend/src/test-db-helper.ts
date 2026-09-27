import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runMigrations, getPool, closePool, checkConnection } from './core/db/postgres.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'core', 'db', 'migrations');

/** The name Postgres gave 054's inline column CHECK, which every widener rewrites. */
const USECASE_CHECK = 'llm_usecase_assignments_usecase_check';

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

/**
 * Wait for observed database state, not a fixed number of cheap SELECTs.
 * Concurrent durable writes can take longer than those SELECTs under CI load.
 * Keep this within the unchanged 30-second test budget and return false so
 * callers can release their held locks before asserting a missing barrier.
 */
export async function waitForDatabaseCondition(condition: () => Promise<boolean>): Promise<boolean> {
  const deadline = performance.now() + 10_000;
  do {
    if (await condition()) return true;
    await delay(25);
  } while (performance.now() < deadline);
  return false;
}

/**
 * Every migration that (re)writes `llm_usecase_assignments_usecase_check`,
 * oldest first. DISCOVERED, never listed: the CHECK is 054's inline column
 * constraint, so changing the admitted set means dropping and re-adding the
 * WHOLE list (090 `rerank`, 093 `image_embedding`, 097 `inline_completion`,
 * 115 `image_analysis`, 118 which NARROWS it back by retiring
 * `image_embedding`, and whatever comes next).
 *
 * Exported because `054_llm_providers.test.ts` replays every writer in order
 * to repair the schema its pre-054 simulation destroys: replaying only the one
 * that happened to be current when that file was written would leave the
 * constraint out of step with the schema in either direction. One definition
 * of "which migrations write it" is enough.
 */
export function usecaseCheckMigrations(): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8').includes(USECASE_CHECK))
    .sort();
}

/**
 * Restore `llm_usecase_assignments`' use-case CHECK to the NEWEST writer's
 * list.
 *
 * The CHECK is 054's inline column constraint, so every migration that changes
 * the admitted set drops and re-adds the WHOLE list (090 `rerank`, 093
 * `image_embedding`, 097 `inline_completion`, 115 `image_analysis`, 118 which
 * narrows `image_embedding` back out). Files on one worker database share it,
 * `truncateAllTables` cannot undo DDL, and `runMigrations` will not repair it
 * because `_migrations` still lists every writer as applied. So a file that
 * recreates the table from an older DDL, or replays a subset of the writers,
 * or is interrupted between its own narrowing and its own repair, leaves the
 * constraint out of step with the schema — and the next file to assign a use
 * case the stale list refuses fails for a reason that has nothing to do with
 * it (#1104 was the first victim). The list is read from the migration rather
 * than duplicated here, so the next writer is covered without editing this
 * file.
 *
 * Exported as well as called from `setupTestDb`, so the file that inflicts a
 * stale list can also repair it before handing the database on
 * (`097_inline_completion.test.ts` replays 097's DDL in its `beforeEach`).
 */
export async function restoreUsecaseCheck(): Promise<void> {
  const newest = usecaseCheckMigrations().pop();
  if (!newest) return;
  const listed = /CHECK\s*\(\s*usecase\s+IN\s*\(([^)]*)\)/i.exec(
    fs.readFileSync(path.join(migrationsDir, newest), 'utf8'),
  );
  if (!listed) return;
  const names = [...listed[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  const pool = getPool();
  const present = await pool.query<{ exists: string | null }>(
    `SELECT to_regclass('public.llm_usecase_assignments') AS exists`,
  );
  if (!present.rows[0]?.exists) return;
  const { rows } = await pool.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = '${USECASE_CHECK}'`,
  );
  if (rows[0] && names.every((n) => rows[0]!.def.includes(`'${n}'`))) return;
  // A row naming a use case the narrow list refuses would abort the ADD, and
  // content is not what this repairs — every file seeds its own.
  await pool.query('TRUNCATE TABLE llm_usecase_assignments');
  await pool.query(
    `ALTER TABLE llm_usecase_assignments DROP CONSTRAINT IF EXISTS ${USECASE_CHECK}`,
  );
  await pool.query(
    `ALTER TABLE llm_usecase_assignments ADD CONSTRAINT ${USECASE_CHECK}
       CHECK (usecase IN (${names.map((n) => `'${n}'`).join(', ')}))`,
  );
}

export async function setupTestDb(): Promise<void> {
  if (!initialized) {
    await runMigrations();
    initialized = true;
  }
  await restoreUsecaseCheck();
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
      -- Restore mandatory singleton state exactly as a freshly migrated DB has
      -- it. Ordinary users/content remain empty; creation remains disabled.
      IF to_regclass('public.page_baseline_feature_state') IS NOT NULL THEN
        INSERT INTO page_baseline_feature_state (singleton, creation_enabled) VALUES (TRUE, FALSE);
      END IF;
      IF to_regclass('public.page_baseline_capacity') IS NOT NULL THEN
        INSERT INTO page_baseline_capacity (singleton, reserved_bytes) VALUES (TRUE, 0);
      END IF;
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
