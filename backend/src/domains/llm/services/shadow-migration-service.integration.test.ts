import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query, getPool } from '../../../core/db/postgres.js';
import pgvector from 'pgvector';

// #1116 — non-destructive re-embed: shadow column + atomic rename-swap.
// Owner decisions (recorded on #1100): Option A with rename-swap under an
// explicit lock_timeout + bounded retry; dual-write during backfill; runtime
// DDL only (no numbered migration). These tests hit the real test Postgres;
// the embedding provider and the job queue are mocked at their boundaries.

function vecOf(dims: number, seed: number): number[] {
  return Array.from({ length: dims }, (_, i) => Math.sin((i + 1) * seed) * 0.01);
}

const LIVE_MODEL = 'bge-m3';
const SHADOW_MODEL = 'shadow-model';
const SHADOW_DIMS = 8;

// Per-model mock: live model answers 1024-dim, shadow model answers 8-dim
// (or 2560 when a test flips bigShadow). shadowFail makes the shadow model
// throw, to exercise the dual-write failure path.
const mockState = vi.hoisted(() => ({ bigShadow: false, shadowFail: false }));
const generateEmbeddingMock = vi.hoisted(() =>
  vi.fn(async (_cfg: unknown, model: string, input: string | string[]) => {
    const texts = Array.isArray(input) ? input : [input];
    const dims = model === 'shadow-model' ? (mockState.bigShadow ? 2560 : 8) : 1024;
    if (model === 'shadow-model' && mockState.shadowFail) {
      throw new Error('shadow provider exploded');
    }
    return texts.map((_, i) => Array.from({ length: dims }, (_, j) => Math.sin((j + 1) * (i + 3)) * 0.01));
  }),
);
vi.mock('./openai-compatible-client.js', async () => {
  const actual = await vi.importActual<typeof import('./openai-compatible-client.js')>(
    './openai-compatible-client.js',
  );
  return { ...actual, generateEmbedding: generateEmbeddingMock };
});

// The queue is Redis-backed infrastructure, unavailable in local tests (same
// boundary CI mocks). Record enqueues; tests drive the job runner directly.
const enqueueJobMock = vi.hoisted(() => vi.fn(async () => 'job-1'));
vi.mock('../../../core/services/queue-service.js', async () => {
  const actual = await vi.importActual<typeof import('../../../core/services/queue-service.js')>(
    '../../../core/services/queue-service.js',
  );
  return {
    ...actual,
    enqueueJob: enqueueJobMock,
    getJobStatus: vi.fn(async () => null),
  };
});

const {
  startShadowMigration,
  getShadowMigrationState,
  getShadowMigrationStatus,
  runShadowBackfillJob,
  performShadowSwap,
  rollbackShadowMigration,
  cleanupShadowMigration,
} = await import('./shadow-migration-service.js');
const { embedPage, enqueueReembedAll } = await import('./embedding-service.js');
const { resetUsecaseCache } = await import('./llm-provider-resolver.js');

const dbAvailable = await isDbAvailable();

const USER = 'aaaaaaaa-1116-4000-8000-000000000001';
let liveProviderId = '';
let shadowProviderId = '';

async function seedBase(): Promise<void> {
  await query(
    `INSERT INTO users (id, username, email, role, password_hash)
     VALUES ($1::uuid, $1::text, $1::text || '@t', 'admin', 'x') ON CONFLICT (id) DO NOTHING`,
    [USER],
  );
  const p1 = await query<{ id: string }>(
    `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default)
     VALUES ('live-prov','http://live/v1','none',true,true) RETURNING id`,
  );
  liveProviderId = p1.rows[0]!.id;
  const p2 = await query<{ id: string }>(
    `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default)
     VALUES ('shadow-prov','http://shadow/v1','none',true,false) RETURNING id`,
  );
  shadowProviderId = p2.rows[0]!.id;
  await query(
    `INSERT INTO llm_usecase_assignments (usecase, provider_id, model, updated_at)
     VALUES ('embedding', $1, $2, NOW())
     ON CONFLICT (usecase) DO UPDATE SET provider_id = $1, model = $2, updated_at = NOW()`,
    [liveProviderId, LIVE_MODEL],
  );
  resetUsecaseCache?.();
}

async function seedEmbeddedPage(title: string, chunks = 2): Promise<number> {
  const page = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html, page_type, visibility)
     VALUES (gen_random_uuid()::text, 'standalone', NULL, $1, $1 || ' body text with enough characters', '', '<p>' || $1 || ' body with enough characters to embed</p>', 'page', 'shared')
     RETURNING id`,
    [title],
  );
  const pageId = page.rows[0]!.id;
  for (let c = 0; c < chunks; c++) {
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [pageId, c, `${title} chunk ${c} text`, pgvector.toSql(vecOf(1024, c + 2)), JSON.stringify({ page_title: title, section_title: title, space_key: null })],
    );
  }
  await query(
    `UPDATE pages SET embedding_status = 'embedded', embedding_dirty = FALSE,
        page_avg_embedding = (SELECT AVG(embedding) FROM page_embeddings WHERE page_id = $1)
     WHERE id = $1`,
    [pageId],
  );
  return pageId;
}

async function columnInfo(table: string, column: string): Promise<{ data_type: string; udt: string; is_nullable: string } | undefined> {
  const { rows } = await query<{ data_type: string; udt: string; is_nullable: string }>(
    `SELECT data_type, format_type(a.atttypid, a.atttypmod) AS udt, CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable
     FROM information_schema.columns c
     JOIN pg_attribute a ON a.attrelid = c.table_name::regclass AND a.attname = c.column_name
     WHERE c.table_name = $1 AND c.column_name = $2`,
    [table, column],
  );
  return rows[0];
}

/**
 * The shared test DB must leave every file exactly as migrations built it:
 * canonical vector(1024) NOT NULL live columns, canonical index names, no
 * shadow/prev leftovers, no migration state.
 */
async function resetCanonicalSchema(): Promise<void> {
  await query(`ALTER TABLE page_embeddings DROP COLUMN IF EXISTS embedding_next`);
  await query(`ALTER TABLE page_embeddings DROP COLUMN IF EXISTS embedding_prev`);
  await query(`ALTER TABLE pages DROP COLUMN IF EXISTS page_avg_embedding_next`);
  await query(`ALTER TABLE pages DROP COLUMN IF EXISTS page_avg_embedding_prev`);
  await query(`DROP INDEX IF EXISTS idx_page_embeddings_hnsw_next`);
  await query(`DROP INDEX IF EXISTS idx_page_embeddings_hnsw_prev`);
  await query(`DROP INDEX IF EXISTS idx_pages_page_avg_embedding_hnsw_next`);
  await query(`DROP INDEX IF EXISTS idx_pages_page_avg_embedding_hnsw_prev`);
  const live = await columnInfo('page_embeddings', 'embedding');
  if (!live) {
    await query(`ALTER TABLE page_embeddings ADD COLUMN embedding vector(1024) NOT NULL`);
  } else if (live.udt !== 'vector(1024)') {
    await query(`TRUNCATE page_embeddings`);
    await query(`ALTER TABLE page_embeddings ALTER COLUMN embedding TYPE vector(1024) USING NULL`);
    await query(`ALTER TABLE page_embeddings ALTER COLUMN embedding SET NOT NULL`);
  } else if (live.is_nullable === 'YES') {
    await query(`DELETE FROM page_embeddings WHERE embedding IS NULL`);
    await query(`ALTER TABLE page_embeddings ALTER COLUMN embedding SET NOT NULL`);
  }
  const avg = await columnInfo('pages', 'page_avg_embedding');
  if (!avg) {
    await query(`ALTER TABLE pages ADD COLUMN page_avg_embedding vector(1024)`);
  } else if (avg.udt !== 'vector(1024)') {
    await query(`ALTER TABLE pages ALTER COLUMN page_avg_embedding TYPE vector(1024) USING NULL`);
  }
  const idx = await query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'page_embeddings' AND indexname = 'idx_page_embeddings_hnsw'`,
  );
  if (idx.rows.length === 0) {
    await query(
      `CREATE INDEX idx_page_embeddings_hnsw ON page_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 200)`,
    );
  }
  await query(`DELETE FROM admin_settings WHERE setting_key = 'embedding_shadow_migration'`);
}

describe.skipIf(!dbAvailable)('#1116 shadow migration service', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await resetCanonicalSchema();
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
    await resetCanonicalSchema();
    await seedBase();
    mockState.bigShadow = false;
    mockState.shadowFail = false;
    generateEmbeddingMock.mockClear();
    enqueueJobMock.mockClear();
  });
  afterEach(async () => {
    await resetCanonicalSchema();
    vi.clearAllMocks();
  });

  describe('start', () => {
    it('probes the pair server-side, creates nullable shadow columns of the measured type, enqueues the backfill', async () => {
      await seedEmbeddedPage('Doc A');

      const result = await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });

      expect(result.dimensions).toBe(SHADOW_DIMS);
      const col = await columnInfo('page_embeddings', 'embedding_next');
      expect(col).toBeDefined();
      expect(col!.udt).toBe(`vector(${SHADOW_DIMS})`);
      expect(col!.is_nullable).toBe('YES');
      const avgCol = await columnInfo('pages', 'page_avg_embedding_next');
      expect(avgCol!.udt).toBe(`vector(${SHADOW_DIMS})`);

      const state = await getShadowMigrationState();
      expect(state).toMatchObject({
        status: 'active',
        providerId: shadowProviderId,
        model: SHADOW_MODEL,
        dimensions: SHADOW_DIMS,
      });
      expect(enqueueJobMock).toHaveBeenCalled();
    });

    it('selects halfvec above the 2000-dim vector ceiling', async () => {
      mockState.bigShadow = true;
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      const col = await columnInfo('page_embeddings', 'embedding_next');
      expect(col!.udt).toBe('halfvec(2560)');
    });

    it('refuses a second start while one is active', async () => {
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      await expect(
        startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL }),
      ).rejects.toThrow(/already/i);
    });
  });

  describe('backfill', () => {
    it('fills embedding_next on existing rows and materializes page_avg_embedding_next', async () => {
      const pageId = await seedEmbeddedPage('Doc A', 3);
      await seedEmbeddedPage('Doc B', 2);
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });

      const result = await runShadowBackfillJob();

      expect(result.processed).toBe(2);
      const rows = await query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM page_embeddings WHERE embedding_next IS NULL`,
      );
      expect(rows.rows[0]!.n).toBe(0);
      const avg = await query<{ v: string | null }>(
        `SELECT page_avg_embedding_next::text AS v FROM pages WHERE id = $1`,
        [pageId],
      );
      expect(avg.rows[0]!.v).not.toBeNull();
    });

    it('reports stragglers until every row is shadow-embedded', async () => {
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });

      let status = await getShadowMigrationStatus();
      expect(status!.stragglerPages).toBe(1);
      expect(status!.phase).toBe('backfilling');

      await runShadowBackfillJob();
      status = await getShadowMigrationStatus();
      expect(status!.stragglerPages).toBe(0);
      expect(status!.phase).toBe('ready');
    });
  });

  describe('dual-write (embedPage)', () => {
    it('writes both columns while a migration is active', async () => {
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      const page = await query<{ id: number }>(
        `INSERT INTO pages (confluence_id, source, title, body_text, body_storage, body_html, page_type, visibility)
         VALUES (gen_random_uuid()::text, 'standalone', 'Fresh page', 'fresh body text long enough to embed', '', '<p>x</p>', 'page', 'shared')
         RETURNING id`,
      );
      const pageId = page.rows[0]!.id;

      const chunks = await embedPage(USER, pageId, 'Fresh page', '', '<p>fresh body text long enough to embed properly for the test</p>');
      expect(chunks).toBeGreaterThan(0);

      const row = await query<{ live: string | null; next: string | null }>(
        `SELECT embedding::text AS live, embedding_next::text AS next FROM page_embeddings WHERE page_id = $1 LIMIT 1`,
        [pageId],
      );
      expect(row.rows[0]!.live).not.toBeNull();
      expect(row.rows[0]!.next).not.toBeNull();
      const avg = await query<{ v: string | null }>(
        `SELECT page_avg_embedding_next::text AS v FROM pages WHERE id = $1`,
        [pageId],
      );
      expect(avg.rows[0]!.v).not.toBeNull();
    });

    it('a shadow-provider failure leaves embedding_next NULL and the live embed intact', async () => {
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      mockState.shadowFail = true;
      const page = await query<{ id: number }>(
        `INSERT INTO pages (confluence_id, source, title, body_text, body_storage, body_html, page_type, visibility)
         VALUES (gen_random_uuid()::text, 'standalone', 'Fresh page', 'fresh body text long enough to embed', '', '<p>x</p>', 'page', 'shared')
         RETURNING id`,
      );
      const pageId = page.rows[0]!.id;

      const chunks = await embedPage(USER, pageId, 'Fresh page', '', '<p>fresh body text long enough to embed properly for the test</p>');
      expect(chunks).toBeGreaterThan(0);

      const row = await query<{ live: string | null; next: string | null }>(
        `SELECT embedding::text AS live, embedding_next::text AS next FROM page_embeddings WHERE page_id = $1 LIMIT 1`,
        [pageId],
      );
      expect(row.rows[0]!.live).not.toBeNull();
      expect(row.rows[0]!.next).toBeNull();
    });
  });

  describe('swap', () => {
    async function readyMigration(): Promise<number> {
      const pageId = await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      await runShadowBackfillJob();
      return pageId;
    }

    it('refuses while stragglers remain', async () => {
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      await expect(performShadowSwap()).rejects.toThrow(/straggler|not ready/i);
    });

    it('refuses while the shadow index is missing, even with zero stragglers', async () => {
      // The in-lock recheck only counts stragglers — index readiness is the
      // outer gate's unique job. Swapping without the shadow index would leave
      // vector search seq-scanning the moment the rename commits.
      await readyMigration();
      await query(`DROP INDEX IF EXISTS idx_page_embeddings_hnsw_next`);
      await expect(performShadowSwap()).rejects.toThrow(/index/i);
    });

    it('atomically renames columns and indexes, drops the prev NOT NULL, repoints the assignment', async () => {
      await readyMigration();

      await performShadowSwap();

      expect((await columnInfo('page_embeddings', 'embedding'))!.udt).toBe(`vector(${SHADOW_DIMS})`);
      expect((await columnInfo('page_embeddings', 'embedding_prev'))!.udt).toBe('vector(1024)');
      // Post-swap inserts do not provide embedding_prev — its NOT NULL must be gone.
      expect((await columnInfo('page_embeddings', 'embedding_prev'))!.is_nullable).toBe('YES');
      expect((await columnInfo('pages', 'page_avg_embedding'))!.udt).toBe(`vector(${SHADOW_DIMS})`);

      const idx = await query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'page_embeddings' AND indexname LIKE 'idx_page_embeddings_hnsw%' ORDER BY indexname`,
      );
      expect(idx.rows.map((r) => r.indexname)).toContain('idx_page_embeddings_hnsw');
      expect(idx.rows.map((r) => r.indexname)).toContain('idx_page_embeddings_hnsw_prev');

      const assign = await query<{ provider_id: string; model: string }>(
        `SELECT provider_id, model FROM llm_usecase_assignments WHERE usecase = 'embedding'`,
      );
      expect(assign.rows[0]).toEqual({ provider_id: shadowProviderId, model: SHADOW_MODEL });
      const dims = await query<{ setting_value: string }>(
        `SELECT setting_value FROM admin_settings WHERE setting_key = 'embedding_dimensions'`,
      );
      expect(dims.rows[0]!.setting_value).toBe(String(SHADOW_DIMS));

      const state = await getShadowMigrationState();
      expect(state!.status).toBe('swapped');

      // The new live column answers vector search at the new dimension.
      const hits = await query<{ page_id: number }>(
        `SELECT page_id FROM page_embeddings ORDER BY embedding <=> $1 LIMIT 1`,
        [pgvector.toSql(vecOf(SHADOW_DIMS, 3))],
      );
      expect(hits.rows.length).toBe(1);
    });

    it('a held conflicting lock exhausts the bounded retries and leaves everything unswapped', async () => {
      await readyMigration();

      const blocker = await getPool().connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT 1 FROM page_embeddings LIMIT 1');

        await expect(
          performShadowSwap({ lockTimeoutMs: 100, maxAttempts: 2 }),
        ).rejects.toThrow(/lock/i);

        expect(await columnInfo('page_embeddings', 'embedding_next')).toBeDefined();
        expect((await columnInfo('page_embeddings', 'embedding'))!.udt).toBe('vector(1024)');
        const state = await getShadowMigrationState();
        expect(state!.status).toBe('active');
      } finally {
        await blocker.query('ROLLBACK').catch(() => {});
        blocker.release();
      }
    });
  });

  describe('rollback + cleanup', () => {
    it('rollback after swap restores the old columns and re-dirties pages embedded post-swap', async () => {
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      await runShadowBackfillJob();
      await performShadowSwap();

      // A page embedded AFTER the swap has no prev vectors — rollback must
      // re-dirty it or it silently vanishes from the old index.
      const fresh = await query<{ id: number }>(
        `INSERT INTO pages (confluence_id, source, title, body_text, body_storage, body_html, page_type, visibility)
         VALUES (gen_random_uuid()::text, 'standalone', 'Post swap', 'post swap body text long enough', '', '<p>x</p>', 'page', 'shared')
         RETURNING id`,
      );
      await query(
        `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
         VALUES ($1, 0, 'post swap chunk', $2, '{}'::jsonb)`,
        [fresh.rows[0]!.id, pgvector.toSql(vecOf(SHADOW_DIMS, 5))],
      );
      await query(`UPDATE pages SET embedding_status = 'embedded', embedding_dirty = FALSE WHERE id = $1`, [fresh.rows[0]!.id]);

      await rollbackShadowMigration();

      expect((await columnInfo('page_embeddings', 'embedding'))!.udt).toBe('vector(1024)');
      const assign = await query<{ provider_id: string; model: string }>(
        `SELECT provider_id, model FROM llm_usecase_assignments WHERE usecase = 'embedding'`,
      );
      expect(assign.rows[0]).toEqual({ provider_id: liveProviderId, model: LIVE_MODEL });
      const dirty = await query<{ embedding_dirty: boolean }>(
        `SELECT embedding_dirty FROM pages WHERE id = $1`,
        [fresh.rows[0]!.id],
      );
      expect(dirty.rows[0]!.embedding_dirty).toBe(true);
    });

    it('rollback before swap aborts: drops the shadow columns and clears state', async () => {
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });

      await rollbackShadowMigration();

      expect(await columnInfo('page_embeddings', 'embedding_next')).toBeUndefined();
      expect(await getShadowMigrationState()).toBeNull();
    });

    it('cleanup drops the prev columns, restores NOT NULL, clears state', async () => {
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      await runShadowBackfillJob();
      await performShadowSwap();

      await cleanupShadowMigration();

      expect(await columnInfo('page_embeddings', 'embedding_prev')).toBeUndefined();
      expect(await columnInfo('pages', 'page_avg_embedding_prev')).toBeUndefined();
      expect((await columnInfo('page_embeddings', 'embedding'))!.is_nullable).toBe('NO');
      expect(await getShadowMigrationState()).toBeNull();
    });
  });

  describe('mutual exclusion with the destructive path', () => {
    it('enqueueReembedAll({newDimensions}) refuses while a shadow migration is active', async () => {
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      await expect(enqueueReembedAll({ newDimensions: 512 })).rejects.toThrow(/shadow/i);
    });
  });
});
