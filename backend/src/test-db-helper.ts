import fs from 'node:fs';
import path from 'node:path';
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
 * Probe-time DDL (`ensureImageEmbeddingColumn`) retypes
 * `page_image_embeddings.embedding` and may build an HNSW index. Sequential
 * files on one worker share that database, and `truncateAllTables` does not
 * undo DDL — so restore migration 093's placeholder at the start of every
 * file (via `setupTestDb`), or 093's own test sees whichever file ran first.
 *
 * The index name is the one `image-embedding-index.ts` creates
 * (`page_image_embeddings_embedding_hnsw_idx`); kept as a literal here so
 * this helper does not import `domains/llm`.
 */
export async function restoreImageEmbeddingPlaceholder(): Promise<void> {
  const pool = getPool();
  const present = await pool.query<{ exists: string | null }>(
    `SELECT to_regclass('public.page_image_embeddings') AS exists`,
  );
  if (!present.rows[0]?.exists) return;

  const col = await pool.query<{ type: string }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
      WHERE a.attrelid = 'page_image_embeddings'::regclass
        AND a.attname = 'embedding'
        AND a.attnum > 0
        AND NOT a.attisdropped`,
  );
  const type = col.rows[0]?.type;
  const idx = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE tablename = 'page_image_embeddings'
        AND indexname = 'page_image_embeddings_embedding_hnsw_idx'`,
  );

  if (type === 'vector(2048)' && idx.rows.length === 0) return;

  await pool.query('DROP INDEX IF EXISTS page_image_embeddings_embedding_hnsw_idx');
  if (type !== 'vector(2048)') {
    // A retype cannot cast 64-dim (or halfvec) rows into vector(2048).
    await pool.query('TRUNCATE page_image_embeddings');
    await pool.query(
      'ALTER TABLE page_image_embeddings ALTER COLUMN embedding TYPE vector(2048)',
    );
  }
}

/**
 * Every migration that rewrites `llm_usecase_assignments_usecase_check`,
 * oldest first. DISCOVERED, never listed: the CHECK is 054's inline column
 * constraint, so widening it for a new use case means dropping and re-adding
 * the WHOLE list (090 rerank, 093 image_embedding, 097 inline_completion,
 * 115 image_analysis, and whatever comes next).
 */
export function usecaseCheckMigrations(): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8').includes(USECASE_CHECK))
    .sort();
}

/** The use-case names the NEWEST widener admits, read from that migration. */
function currentUsecaseNames(): string[] {
  const wideners = usecaseCheckMigrations();
  const newest = wideners[wideners.length - 1];
  if (!newest) throw new Error(`No migration writes ${USECASE_CHECK}`);
  const sql = fs.readFileSync(path.join(migrationsDir, newest), 'utf8');
  const listed = /CHECK\s*\(\s*usecase\s+IN\s*\(([^)]*)\)/i.exec(sql);
  if (!listed) throw new Error(`${newest} rewrites ${USECASE_CHECK} but no CHECK (usecase IN (…)) was found`);
  return [...listed[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/**
 * Restore the use-case CHECK to the newest widener's list — the same class of
 * shared-schema damage as `restoreImageEmbeddingPlaceholder` above, and the
 * same remedy (run it at the start of every file, via `setupTestDb`).
 *
 * A migration test that re-executes its own historical SQL against the shared
 * worker database re-imposes that migration's SHORTER list
 * (`097_inline_completion.test.ts` does exactly this in its `beforeEach`).
 * That is DDL: `truncateAllTables` cannot undo it, and `_migrations` still
 * lists every later widener as applied, so `runMigrations` never widens it
 * back. The next file on that worker to insert a newer use case then fails on
 * a constraint that has nothing to do with it — `image_analysis` (migration
 * 115) was the case that surfaced it.
 *
 * The list is read from the migration, never spelled out here, so the next
 * use case is covered without touching this helper.
 */
export async function restoreUsecaseCheck(): Promise<void> {
  const pool = getPool();
  const live = await pool.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
      WHERE c.conname = $1
        AND c.conrelid = to_regclass('public.llm_usecase_assignments')`,
    [USECASE_CHECK],
  );
  const def = live.rows[0]?.def;
  if (def === undefined) return; // no table / no constraint: a migration's own business

  const expected = currentUsecaseNames();
  const admitted = [...def.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  if (expected.length === admitted.length && expected.every((n) => admitted.includes(n))) return;

  // Widening only: every row admitted by the narrower list is admitted here,
  // so the ADD's validation of existing rows cannot fail.
  await pool.query(`ALTER TABLE llm_usecase_assignments DROP CONSTRAINT IF EXISTS ${USECASE_CHECK}`);
  await pool.query(
    `ALTER TABLE llm_usecase_assignments ADD CONSTRAINT ${USECASE_CHECK}
       CHECK (usecase IN (${expected.map((n) => `'${n}'`).join(', ')}))`,
  );
}

export async function setupTestDb(): Promise<void> {
  if (!initialized) {
    await runMigrations();
    initialized = true;
  }
  await restoreImageEmbeddingPlaceholder();
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
