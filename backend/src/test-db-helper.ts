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

export async function setupTestDb(): Promise<void> {
  if (!initialized) {
    await runMigrations();
    initialized = true;
  }
  await restoreImageEmbeddingPlaceholder();
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
