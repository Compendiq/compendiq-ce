import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_TEST_WORKERS, workerIdFromEnv } from './test-worker-isolation.js';
import { isDbAvailable, setupTestDb } from './test-db-helper.js';
import { query } from './core/db/postgres.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('test-setup short-circuits production wall-clock timings', () => {
  const setup = readFileSync(join(here, 'test-setup.ts'), 'utf8');

  it('sets collab grace/TTL/ping and the LLM health probe under Vitest', () => {
    expect(setup).toMatch(/COLLAB_ACTIVE_TTL_SEC \?\?= '4'/);
    expect(setup).toMatch(/COLLAB_PING_INTERVAL_MS \?\?= '100'/);
    expect(setup).toMatch(/COLLAB_EMPTY_ROOM_GRACE_MS \?\?= '200'/);
    expect(setup).toMatch(/COLLAB_COMMIT_DUMP_TIMEOUT_MS \?\?= '200'/);
    expect(setup).toMatch(/LLM_HEALTH_TIMEOUT_MS \?\?= '50'/);
  });

  it('applies per-worker Postgres/Redis isolation before any suite loads', () => {
    expect(setup).toMatch(/applyWorkerIsolation\(\)/);
    expect(setup).toMatch(/ensureWorkerDatabase/);
  });

  it('this worker has a pool slot so it is not sharing kb_creator_test', () => {
    expect(workerIdFromEnv()).toBeGreaterThan(0);
    expect(process.env.POSTGRES_URL).toMatch(/kb_creator_test_w\d+/);
  });
});

describe('truncateAllTables retries deadlocks', () => {
  it('retries 40P01 / 55P03 rather than failing the next test', () => {
    const src = readFileSync(join(here, 'test-db-helper.ts'), 'utf8');
    expect(src).toMatch(/DEADLOCK = '40P01'/);
    expect(src).toMatch(/LOCK_NOT_AVAILABLE = '55P03'/);
    expect(src).toMatch(/attempt < 5/);
  });
});

describe('per-file image-index schema restore', () => {
  const helper = readFileSync(join(here, 'test-db-helper.ts'), 'utf8');
  const setup = readFileSync(join(here, 'test-setup.ts'), 'utf8');

  it('setupTestDb restores migration 093\'s placeholder after a sibling file retyped the column', () => {
    // fileParallelism shares one DB per worker. Eval/image suites retype
    // page_image_embeddings (64-dim + HNSW) and truncateAllTables does not
    // undo DDL, so 093's own test would otherwise see whichever file ran first.
    expect(helper).toMatch(/restoreImageEmbeddingPlaceholder/);
    expect(helper).toMatch(/await restoreImageEmbeddingPlaceholder\(\)/);
    expect(helper).toMatch(/TYPE vector\(2048\)/);
    expect(helper).toMatch(/page_image_embeddings_embedding_hnsw_idx/);
  });

  it('re-runs setupTestDb before every file, not only at worker boot', () => {
    // Module-level setupTestDb migrates once. A later file on the same
    // worker must restore even if it never calls setupTestDb itself.
    expect(setup).toMatch(/beforeAll\(async \(\) => \{/);
    expect(setup).toMatch(/await bootWorkerDb\(\)/);
    expect(setup).toMatch(/async function bootWorkerDb[\s\S]*?await setupTestDb\(\)/);
  });
});

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('setupTestDb restores image-index DDL', () => {
  it('undoes a 64-dim retype and the probe-time HNSW index', async () => {
    await setupTestDb();
    await query('DROP INDEX IF EXISTS page_image_embeddings_embedding_hnsw_idx');
    await query('TRUNCATE page_image_embeddings');
    await query('ALTER TABLE page_image_embeddings ALTER COLUMN embedding TYPE vector(64)');
    await query(
      `CREATE INDEX page_image_embeddings_embedding_hnsw_idx
         ON page_image_embeddings USING hnsw (embedding vector_cosine_ops)`,
    );

    await setupTestDb();

    const col = await query<{ type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_attribute a
        WHERE a.attrelid = 'page_image_embeddings'::regclass
          AND a.attname = 'embedding'`,
    );
    expect(col.rows[0]!.type).toBe('vector(2048)');

    const idx = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'page_image_embeddings'`,
    );
    expect(idx.rows.map((r) => r.indexdef).filter((d) => /USING hnsw/i.test(d))).toEqual([]);
  });
});

describe('vitest.config file parallelism', () => {
  const cfg = readFileSync(join(here, '..', 'vitest.config.ts'), 'utf8');

  it('runs files in parallel, capped at MAX_TEST_WORKERS', () => {
    expect(cfg).toMatch(/fileParallelism:\s*true/);
    expect(cfg).toMatch(/maxWorkers:\s*MAX_TEST_WORKERS/);
    expect(MAX_TEST_WORKERS).toBe(8);
  });
});

describe('production timings are Vitest-overridable', () => {
  it('collab constants go through vitestIntOr so test-setup can shorten them', () => {
    const src = readFileSync(join(here, 'core/services/collab-room-service.ts'), 'utf8');
    expect(src).toMatch(/COLLAB_ACTIVE_TTL_SEC = vitestIntOr\('COLLAB_ACTIVE_TTL_SEC', 45\)/);
    expect(src).toMatch(/COLLAB_PING_INTERVAL_MS = vitestIntOr\('COLLAB_PING_INTERVAL_MS', 15_000\)/);
    expect(src).toMatch(/COLLAB_EMPTY_ROOM_GRACE_MS = vitestIntOr\('COLLAB_EMPTY_ROOM_GRACE_MS', 10_000\)/);
    expect(src).toMatch(/COLLAB_COMMIT_DUMP_TIMEOUT_MS = vitestIntOr\('COLLAB_COMMIT_DUMP_TIMEOUT_MS', 2_000\)/);
  });

  it('LLM health probes use vitestIntOr rather than a literal 5000', () => {
    const health = readFileSync(join(here, 'routes/foundation/health.ts'), 'utf8');
    const setup = readFileSync(join(here, 'routes/foundation/setup.ts'), 'utf8');
    expect(health).toMatch(/LLM_HEALTH_TIMEOUT_MS = vitestIntOr\('LLM_HEALTH_TIMEOUT_MS', 5_000\)/);
    expect(health).not.toMatch(/5000/);
    expect(setup).toMatch(/LLM_HEALTH_TIMEOUT_MS/);
    expect(setup).not.toMatch(/5000/);
  });
});
