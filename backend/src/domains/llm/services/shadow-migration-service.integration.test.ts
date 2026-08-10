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
const defaultEmbeddingImpl = vi.hoisted(
  () => async (_cfg: unknown, model: string, input: string | string[]) => {
    const texts = Array.isArray(input) ? input : [input];
    const dims = model === 'shadow-model' ? (mockState.bigShadow ? 2560 : 8) : 1024;
    if (model === 'shadow-model' && mockState.shadowFail) {
      throw new Error('shadow provider exploded');
    }
    return texts.map((_, i) => Array.from({ length: dims }, (_, j) => Math.sin((j + 1) * (i + 3)) * 0.01));
  },
);
const generateEmbeddingMock = vi.hoisted(() => vi.fn());
vi.mock('./openai-compatible-client.js', async () => {
  const actual = await vi.importActual<typeof import('./openai-compatible-client.js')>(
    './openai-compatible-client.js',
  );
  return { ...actual, generateEmbedding: generateEmbeddingMock };
});

// The queue is Redis-backed infrastructure, unavailable in local tests (same
// boundary CI mocks). Record enqueues; tests drive the job runner directly.
// The EE org-LLM-policy hook. CE's real noop answers null; tests flip it to
// exercise the guard that keeps a policy-pinned instance from migrating.
const enterpriseOverride = vi.hoisted(() =>
  vi.fn(async (): Promise<{ providerId: string; model: string } | null> => null),
);
vi.mock('../../../core/enterprise/loader.js', async () => {
  const actual = await vi.importActual<typeof import('../../../core/enterprise/loader.js')>(
    '../../../core/enterprise/loader.js',
  );
  return {
    ...actual,
    getEnterprisePlugin: () => ({
      ...actual.getEnterprisePlugin(),
      resolveUsecaseOverride: enterpriseOverride,
    }),
  };
});

const enqueueJobMock = vi.hoisted(() => vi.fn(async () => 'job-1'));
const getJobStatusMock = vi.hoisted(() => vi.fn(async (): Promise<{ state: string } | null> => null));
vi.mock('../../../core/services/queue-service.js', async () => {
  const actual = await vi.importActual<typeof import('../../../core/services/queue-service.js')>(
    '../../../core/services/queue-service.js',
  );
  return {
    ...actual,
    enqueueJob: enqueueJobMock,
    getJobStatus: (...args: unknown[]) => getJobStatusMock(...(args as [])),
  };
});

const {
  startShadowMigration,
  getShadowMigrationState,
  getShadowMigrationStatus,
  shadowStateFingerprint,
  awaitSimilarityEdgeRefresh,
  runShadowBackfillJob,
  rerunShadowBackfill,
  performShadowSwap,
  rollbackShadowMigration,
  cleanupShadowMigration,
} = await import('./shadow-migration-service.js');
const { embedPage, enqueueReembedAll, reEmbedAll, assertNoShadowMigration, assertShadowRollbackWindowClear } = await import('./embedding-service.js');

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
  // No resolver-cache reset is needed (and none is exported): the config
  // cache is keyed by provider id and every test seeds fresh UUIDs, so a
  // stale entry is unreachable. The optional call that used to sit here read
  // as a safety net that did not exist (review r9).
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
    // mockReset + re-install: a bare mockClear would leak the PREVIOUS test's
    // mockImplementation into this one.
    generateEmbeddingMock.mockReset();
    generateEmbeddingMock.mockImplementation(defaultEmbeddingImpl);
    enqueueJobMock.mockClear();
    getJobStatusMock.mockReset();
    getJobStatusMock.mockResolvedValue(null);
    enterpriseOverride.mockReset();
    enterpriseOverride.mockResolvedValue(null);
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

    it("refuses to start while a previous shadow job is still in the queue (review r1)", async () => {
      // After an abort, the fixed-jobId backfill job can still be waiting or
      // active; BullMQ silently ignores a duplicate add, so a new start would
      // create a migration with NO job and no error. Refuse instead.
      getJobStatusMock.mockImplementation(async (queueName?: string) =>
        queueName === 'shadow-reembed' ? { state: 'active' } : null,
      );
      await expect(
        startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL }),
      ).rejects.toThrow(/still (running|queued)/i);
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

    it('terminates when a poison page keeps failing, leaving it a straggler (review r1, blocking)', async () => {
      // The r1 blocking finding: both loop exits required the GLOBAL
      // processed === 0, so one persistently-failing page after any success
      // re-selected forever — hammering the provider until an admin aborted.
      await seedEmbeddedPage('Good one');
      await seedEmbeddedPage('Poisoned doc');
      await seedEmbeddedPage('Good two');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      generateEmbeddingMock.mockImplementation(async (_cfg: unknown, model: string, input: string | string[]) => {
        const texts = Array.isArray(input) ? input : [input];
        if (model === SHADOW_MODEL && texts.some((t) => t.includes('Poisoned'))) {
          throw new Error('provider rejects this content');
        }
        return texts.map((_, i) => Array.from({ length: model === SHADOW_MODEL ? 8 : 1024 }, (_2, j) => Math.sin((j + 1) * (i + 3)) * 0.01));
      });

      const result = await runShadowBackfillJob();

      expect(result).toMatchObject({ processed: 2, failed: 1 });
      const status = await getShadowMigrationStatus();
      expect(status!.stragglerPages).toBe(1);
      expect(status!.phase).toBe('backfilling');
    }, 20_000);

    it('never overwrites a fresh dual-written shadow vector with stale-text embeddings (review r1)', async () => {
      // The backfill reads chunk text, spends the provider round-trip, then
      // writes back — a concurrent embedPage can replace the row in that
      // window. The write-back must be guarded on embedding_next IS NULL and
      // unchanged chunk_text, or vectors of deleted text get stamped in.
      const pageId = await seedEmbeddedPage('Doc A', 2);
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      const marker = Array.from({ length: SHADOW_DIMS }, () => 0.5);
      let interleaved = false;
      generateEmbeddingMock.mockImplementation(async (_cfg: unknown, model: string, input: string | string[]) => {
        const texts = Array.isArray(input) ? input : [input];
        if (model === SHADOW_MODEL && !interleaved && texts.length > 1) {
          interleaved = true;
          // Simulate a concurrent embedPage replacing chunk 0 and dual-writing it.
          await query(
            `UPDATE page_embeddings SET chunk_text = 'REPLACED by a concurrent edit', embedding_next = $2
             WHERE page_id = $1 AND chunk_index = 0`,
            [pageId, pgvector.toSql(marker)],
          );
        }
        return texts.map((_, i) => Array.from({ length: model === SHADOW_MODEL ? 8 : 1024 }, (_2, j) => Math.sin((j + 1) * (i + 3)) * 0.01));
      });

      await runShadowBackfillJob();

      const rows = await query<{ chunk_index: number; v: string | null }>(
        `SELECT chunk_index, embedding_next::text AS v FROM page_embeddings WHERE page_id = $1 ORDER BY chunk_index`,
        [pageId],
      );
      expect(rows.rows[0]!.v).toBe(pgvector.toSql(marker)); // fresh dual-write preserved
      expect(rows.rows[1]!.v).not.toBeNull(); // the untouched chunk still backfilled
    });

    it('aborts promptly when the state row disappears mid-run (review r1)', async () => {
      await seedEmbeddedPage('Doc A');
      await seedEmbeddedPage('Doc B');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      let calls = 0;
      generateEmbeddingMock.mockImplementation(async (_cfg: unknown, model: string, input: string | string[]) => {
        const texts = Array.isArray(input) ? input : [input];
        if (model === SHADOW_MODEL) {
          calls++;
          if (calls === 1) {
            // A rollback lands while page 1 is being embedded.
            await query(`DELETE FROM admin_settings WHERE setting_key = 'embedding_shadow_migration'`);
          }
        }
        return texts.map((_, i) => Array.from({ length: model === SHADOW_MODEL ? 8 : 1024 }, (_2, j) => Math.sin((j + 1) * (i + 3)) * 0.01));
      });

      const result = await runShadowBackfillJob();
      expect(result).toBe('aborted');
    });

    it('rerunShadowBackfill re-enqueues the job for an active migration (review r1)', async () => {
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      enqueueJobMock.mockClear();

      await rerunShadowBackfill();
      expect(enqueueJobMock).toHaveBeenCalledTimes(1);

      await rollbackShadowMigration();
      await expect(rerunShadowBackfill()).rejects.toThrow(/no active/i);
    });

    it('rerunShadowBackfill refuses while the job is still queued — BullMQ would silently dedupe (review r2)', async () => {
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      getJobStatusMock.mockImplementation(async (queueName?: string) =>
        queueName === 'shadow-reembed' ? { state: 'active' } : null,
      );
      await expect(rerunShadowBackfill()).rejects.toThrow(/still running|still queued/i);
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

    it('a wrong-dimension shadow vector is treated as a shadow failure, never failing the live embed (review r1)', async () => {
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      // Provider misbehaves: returns 4-dim vectors for the 8-dim shadow column.
      generateEmbeddingMock.mockImplementation(async (_cfg: unknown, model: string, input: string | string[]) => {
        const texts = Array.isArray(input) ? input : [input];
        const dims = model === SHADOW_MODEL ? 4 : 1024;
        return texts.map((_, i) => Array.from({ length: dims }, (_2, j) => Math.sin((j + 1) * (i + 3)) * 0.01));
      });
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

    it('an embedPage racing a swap aborts and re-dirties instead of writing stale-model vectors (review r1)', async () => {
      // embedPage resolves models and generates BEFORE its write transaction;
      // a swap committing in that window would otherwise let old-model vectors
      // land in the renamed columns (silently, when dimensions happen to match).
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      await runShadowBackfillJob();

      const page = await query<{ id: number }>(
        `INSERT INTO pages (confluence_id, source, title, body_text, body_storage, body_html, page_type, visibility)
         VALUES (gen_random_uuid()::text, 'standalone', 'Racing page', 'racing body text long enough to embed', '', '<p>x</p>', 'page', 'shared')
         RETURNING id`,
      );
      const pageId = page.rows[0]!.id;

      let swapped = false;
      generateEmbeddingMock.mockImplementation(async (_cfg: unknown, model: string, input: string | string[]) => {
        const texts = Array.isArray(input) ? input : [input];
        if (model === LIVE_MODEL && !swapped) {
          swapped = true;
          await performShadowSwap(); // the swap lands mid-embed
        }
        return texts.map((_, i) => Array.from({ length: model === SHADOW_MODEL ? 8 : 1024 }, (_2, j) => Math.sin((j + 1) * (i + 3)) * 0.01));
      });

      const chunks = await embedPage(USER, pageId, 'Racing page', '', '<p>racing body text long enough to embed properly</p>');
      expect(chunks).toBe(0); // aborted, not written

      const rows = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM page_embeddings WHERE page_id = $1`, [pageId]);
      expect(rows.rows[0]!.n).toBe(0);
      const dirty = await query<{ embedding_dirty: boolean }>(`SELECT embedding_dirty FROM pages WHERE id = $1`, [pageId]);
      expect(dirty.rows[0]!.embedding_dirty).toBe(true); // re-queued for a clean post-swap embed
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

    it('embeds the SAME text in the live path and the backfill', async () => {
      // #1108 measured the title prefix and it did not survive, but the
      // invariant it exposed is worth keeping: whatever the live embed sends
      // to the model, the backfill must send byte-for-byte. A divergence
      // changes the embedded TEXT and the MODEL in the same swap, with
      // identical dimensions and row counts to show for it — and #1114 is
      // about to add a query-side prefix, which is exactly the kind of change
      // that leaks into the document path.
      const pageId = await seedEmbeddedPage('Doc A');
      await query(`DELETE FROM page_embeddings WHERE page_id = $1`, [pageId]);

      generateEmbeddingMock.mockClear();
      await embedPage(USER, pageId, 'Doc A', 'SPACE', '<p>alpha content about hooks and plugins, long enough to embed properly</p>');
      const liveTexts = generateEmbeddingMock.mock.calls.flatMap((c) => c[2] as string[]);
      expect(liveTexts.length).toBeGreaterThan(0);

      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      generateEmbeddingMock.mockClear();
      await runShadowBackfillJob();
      const backfillTexts = generateEmbeddingMock.mock.calls.flatMap((c) => c[2] as string[]);

      expect(backfillTexts.length).toBeGreaterThan(0);
      expect(new Set(backfillTexts)).toEqual(new Set(liveTexts));
    });

    it('refuses a bulk page re-embed only inside the rollback window (review r9)', async () => {
      // Bounded and non-admin, so it is not refused for the whole backfill —
      // during `active` embedPage dual-writes and the rows stay consistent.
      // After the swap they carry no embedding_prev, so a rollback would
      // re-dirty exactly these pages and search would lose them meanwhile.
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });

      await expect(assertShadowRollbackWindowClear()).resolves.toBeUndefined();
      await expect(assertNoShadowMigration()).rejects.toMatchObject({ statusCode: 409 });

      await runShadowBackfillJob();
      await performShadowSwap();

      await expect(assertShadowRollbackWindowClear()).rejects.toMatchObject({ statusCode: 409 });
    });

    it('refuses reEmbedAll(), the OTHER whole-corpus door into the same hazard (review r8)', async () => {
      // enqueueReembedAll was guarded in r7, but reEmbedAll() — behind the
      // embedding-rescan admin routes — reaches the same corpus by a
      // different path, and the chunk-settings change reaches it by a third.
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });

      await expect(reEmbedAll()).rejects.toMatchObject({ statusCode: 409 });

      // Nothing was dirtied on the way to the refusal.
      const dirty = await query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM pages WHERE embedding_dirty = TRUE`,
      );
      expect(dirty.rows[0]!.n).toBe(0);
    });

    it('refuses a SAME-dimension destructive re-embed too, not only a dimension change (review r7)', async () => {
      // The same-dimension path TRUNCATEs and rebuilds `embedding` as well.
      // Run during 'swapped' it fills the table with rows whose
      // embedding_prev is NULL, and the rollback that deletes NULL-vector
      // rows would then empty the corpus — the opposite of the runbook's
      // "old model serves again immediately".
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });

      await expect(enqueueReembedAll({})).rejects.toMatchObject({ statusCode: 409 });
    });

    it('refuses to start while an org LLM policy pins the embedding use case (review r6)', async () => {
      // The policy is consulted BEFORE llm_usecase_assignments, so the swap's
      // repoint would be cosmetic: corpus on one model, every query on
      // another. Inert in CE, where the noop plugin answers null.
      enterpriseOverride.mockResolvedValue({ providerId: liveProviderId, model: 'policy-pinned-model' });

      await expect(
        startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL }),
      ).rejects.toThrow(/organization LLM policy/i);

      expect(await getShadowMigrationState()).toBeNull();
    });

    it('refuses to swap when a policy is switched on mid-backfill (review r6)', async () => {
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      await runShadowBackfillJob();
      enterpriseOverride.mockResolvedValue({ providerId: liveProviderId, model: 'policy-pinned-model' });

      await expect(performShadowSwap()).rejects.toThrow(/organization LLM policy/i);

      // Nothing renamed: the live column is still the 1024-dim original, not
      // the 8-dim shadow.
      const live = await columnInfo('page_embeddings', 'embedding');
      expect(live?.udt).toBe('vector(1024)');
      expect(await columnInfo('page_embeddings', 'embedding_prev')).toBeUndefined();
    });

    it('an abort that lands between batches ends the job cleanly, not on a raw undefined-column error (review r6)', async () => {
      // The batch SELECT names embedding_next; an abort committing after the
      // last page of a batch pulls the column out from under the job's own
      // query. That is a race the job is meant to lose.
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      generateEmbeddingMock.mockImplementationOnce(async () => {
        await query(`ALTER TABLE page_embeddings DROP COLUMN embedding_next`);
        await query(`ALTER TABLE pages DROP COLUMN page_avg_embedding_next`);
        await query(`DELETE FROM admin_settings WHERE setting_key = 'embedding_shadow_migration'`);
        return [vecOf(8, 1)];
      });

      await expect(runShadowBackfillJob()).resolves.toBe('aborted');
    });

    it('a start racing another start\'s probe window is refused, not a raw duplicate-column error (review r5)', async () => {
      // The pre-probe check is stale by the time the DDL runs — the probe is
      // a provider round-trip. Simulate the loser: the winner's state row
      // lands WHILE our probe is in flight.
      generateEmbeddingMock.mockImplementationOnce(async () => {
        await query(
          `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
           VALUES ('embedding_shadow_migration', $1, NOW())`,
          [JSON.stringify({ status: 'active', providerId: shadowProviderId, model: SHADOW_MODEL, dimensions: 8, columnType: 'vector(8)', indexed: true, startedAt: new Date().toISOString() })],
        );
        return [vecOf(8, 1)];
      });

      await expect(
        startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL }),
      ).rejects.toThrow(/already active/i);
    });

    it('a provider deleted during the probe window refuses instead of creating a dangling migration (review r5)', async () => {
      generateEmbeddingMock.mockImplementationOnce(async () => {
        await query(`DELETE FROM llm_providers WHERE id = $1`, [shadowProviderId]);
        return [vecOf(8, 1)];
      });

      await expect(
        startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL }),
      ).rejects.toThrow(/Provider not found/i);

      expect(await getShadowMigrationState()).toBeNull();
      expect(await columnInfo('page_embeddings', 'embedding_next')).toBeUndefined();
    });

    it('refuses while stragglers remain', async () => {
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      await expect(performShadowSwap()).rejects.toThrow(/straggler|not ready/i);
    });

    it("a state flip landing during the swap's lock wait is caught by the in-lock recheck (review r2)", async () => {
      // The concurrent-abort interleaving the OUTER status check cannot see:
      // the abort's CAS lands while the swap is already queued on the table
      // lock. Without the in-lock re-read the swap would spread 'aborting'
      // into 'swapped' and the queued abort would later erase the swap's
      // state row — new model live, prev columns stranded, lifecycle wedged.
      await readyMigration();
      const blocker = await getPool().connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT 1 FROM page_embeddings LIMIT 1'); // ACCESS SHARE queues the AEL

        const swapPromise = performShadowSwap({ lockTimeoutMs: 3000, maxAttempts: 2 }).then(
          () => 'swapped' as const,
          (e: unknown) => e as Error,
        );
        // Give the swap time to pass its outer check and block on LOCK TABLE.
        await new Promise((r) => setTimeout(r, 300));
        const state = await getShadowMigrationState();
        await query(
          `UPDATE admin_settings SET setting_value = $1 WHERE setting_key = 'embedding_shadow_migration'`,
          [JSON.stringify({ ...state, status: 'aborting' })],
        );
        await blocker.query('ROLLBACK'); // lock granted to the swap now

        const result = await swapPromise;
        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toMatch(/changed mid-swap/i);
        expect((await columnInfo('page_embeddings', 'embedding'))!.udt).toBe('vector(1024)');
      } finally {
        await blocker.query('ROLLBACK').catch(() => {});
        blocker.release();
      }
    }, 20_000);

    it('refuses while the shadow index is missing, even with zero stragglers', async () => {
      // The in-lock recheck only counts stragglers — index readiness is the
      // outer gate's unique job. Swapping without the shadow index would leave
      // vector search seq-scanning the moment the rename commits.
      await readyMigration();
      await query(`DROP INDEX IF EXISTS idx_page_embeddings_hnsw_next`);
      await expect(performShadowSwap()).rejects.toThrow(/index/i);
    });

    it('ignores a same-named index living in another schema (review r5)', async () => {
      // pg_indexes spans the whole database; a restored clone schema keeps the
      // original index names, so an unfiltered count of 2 can be reached with
      // one real shadow index and one impostor.
      await readyMigration();
      await query(`DROP INDEX IF EXISTS idx_pages_page_avg_embedding_hnsw_next`);
      await query(`CREATE SCHEMA IF NOT EXISTS r5_clone`);
      try {
        await query(`CREATE TABLE r5_clone.decoy (id int)`);
        await query(`CREATE INDEX idx_pages_page_avg_embedding_hnsw_next ON r5_clone.decoy (id)`);

        await expect(performShadowSwap()).rejects.toThrow(/index/i);
      } finally {
        await query(`DROP SCHEMA r5_clone CASCADE`);
      }
    });

    it('refuses when only the pages avg shadow index is missing (review r4)', async () => {
      // A crash between the two CREATE INDEX statements leaves exactly this
      // state; swapping would silently strand pages.page_avg_embedding
      // unindexed after cleanup drops the prev index.
      await readyMigration();
      await query(`DROP INDEX IF EXISTS idx_pages_page_avg_embedding_hnsw_next`);
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
        // The assignment repoint and dimensions write must live INSIDE the
        // same aborted transaction — a failed swap leaves both untouched
        // (review r1: previously unasserted, so moving them out passed).
        const assign = await query<{ provider_id: string; model: string }>(
          `SELECT provider_id, model FROM llm_usecase_assignments WHERE usecase = 'embedding'`,
        );
        expect(assign.rows[0]).toEqual({ provider_id: liveProviderId, model: LIVE_MODEL });
        const dims = await query<{ setting_value: string }>(
          `SELECT setting_value FROM admin_settings WHERE setting_key = 'embedding_dimensions'`,
        );
        expect(dims.rows).toHaveLength(0);
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
      // The revert deletes NULL rows, so restoring the schema invariant is
      // safe — and required, or the live column stays nullable forever
      // (review r1).
      expect((await columnInfo('page_embeddings', 'embedding'))!.is_nullable).toBe('NO');
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

    it('rebuilds the persisted similarity edges after the swap (review r7)', async () => {
      // page_relationships.embedding_similarity is derived from
      // pages.page_avg_embedding — the column the swap replaces. Nothing else
      // rebuilds it, so the graph would keep serving old-model scores and
      // drift into a mixture as individual pages are edited.
      const a = await seedEmbeddedPage('Doc A');
      const b = await seedEmbeddedPage('Doc B');
      await query(
        `INSERT INTO page_relationships (page_id_1, page_id_2, relationship_type, score)
         VALUES ($1, $2, 'embedding_similarity', 0.75)`,
        [a, b],
      );
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      await runShadowBackfillJob();

      await performShadowSwap();
      await awaitSimilarityEdgeRefresh(); // detached from the request; deterministic here

      // 0.75 is exact in float4, so this really does match the seeded row —
      // 0.999 would not, and the assertion would pass without the fix.
      const seeded = await query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM page_relationships
         WHERE page_id_1 = $1 AND page_id_2 = $2
           AND relationship_type = 'embedding_similarity' AND score = 0.75::real`,
        [a, b],
      );
      expect(seeded.rows[0]!.n).toBe(0);
    });

    it('a revert leaves an epoch distinct from the pre-swap one (review r7)', async () => {
      // The fingerprint was status:startedAt:swappedAt, and a revert restores
      // status 'active' with the original startedAt and no swappedAt — byte
      // identical to before the swap. An embedPage whose snapshot straddled
      // BOTH transitions then passed its recheck and wrote swapped-epoch
      // vectors into reverted columns.
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      const before = shadowStateFingerprint(await getShadowMigrationState());
      await runShadowBackfillJob();
      await performShadowSwap();
      await rollbackShadowMigration();

      expect(shadowStateFingerprint(await getShadowMigrationState())).not.toBe(before);
    });

    it('the revert restores the state it verified under the lock, not the pre-lock snapshot (review r5)', async () => {
      // A rollback can wait seconds on the table lock. Whatever else commits
      // in that window is what the DB now holds — restoring the snapshot read
      // BEFORE the wait would write back a superseded rollback target.
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      await runShadowBackfillJob();
      await performShadowSwap();

      const blocker = await getPool().connect();
      let rollbackPromise: Promise<'aborted' | 'reverted'>;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT 1 FROM page_embeddings LIMIT 1'); // ACCESS SHARE queues the AEL

        rollbackPromise = rollbackShadowMigration({ lockTimeoutMs: 3000, maxAttempts: 3 });
        await new Promise((r) => setTimeout(r, 300));

        const live = await getShadowMigrationState();
        await query(
          `UPDATE admin_settings SET setting_value = $1 WHERE setting_key = 'embedding_shadow_migration'`,
          [JSON.stringify({ ...live, prev: { providerId: shadowProviderId, model: 'succeeding-model', dimensions: 8 } })],
        );
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      await rollbackPromise;

      const assign = await query<{ provider_id: string; model: string }>(
        `SELECT provider_id, model FROM llm_usecase_assignments WHERE usecase = 'embedding'`,
      );
      expect(assign.rows[0]).toEqual({ provider_id: shadowProviderId, model: 'succeeding-model' });
    });

    it('rollback restores a partially-pinned embedding assignment verbatim (review r4)', async () => {
      // {provider: P, model: NULL} resolves P.default_model — deleting the
      // row on rollback would silently repoint embedding at the DEFAULT
      // provider while the restored vectors came from P.
      await query(
        `UPDATE llm_usecase_assignments SET model = NULL WHERE usecase = 'embedding'`,
      );
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      await runShadowBackfillJob();
      await performShadowSwap();

      await rollbackShadowMigration();

      const assign = await query<{ provider_id: string; model: string | null }>(
        `SELECT provider_id, model FROM llm_usecase_assignments WHERE usecase = 'embedding'`,
      );
      expect(assign.rows).toHaveLength(1);
      expect(assign.rows[0]).toEqual({ provider_id: liveProviderId, model: null });
    });

    it('an interrupted abort is resumable instead of stranding the shadow columns (review r1)', async () => {
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      // Simulate a crash mid-abort: the state was flipped to 'aborting' but
      // the column drops never ran.
      const state = await getShadowMigrationState();
      await query(
        `UPDATE admin_settings SET setting_value = $1 WHERE setting_key = 'embedding_shadow_migration'`,
        [JSON.stringify({ ...state, status: 'aborting' })],
      );

      // Status must not blow up even if the columns are half-gone.
      const status = await getShadowMigrationStatus();
      expect(status!.phase).toBe('aborting');

      // Re-running rollback completes the abort idempotently.
      const result = await rollbackShadowMigration();
      expect(result).toBe('aborted');
      expect(await columnInfo('page_embeddings', 'embedding_next')).toBeUndefined();
      expect(await getShadowMigrationState()).toBeNull();
    });

    it('cleanup re-dirties pages whose live embedding is NULL instead of silently deleting their chunks (review r1)', async () => {
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      await runShadowBackfillJob();
      await performShadowSwap();

      // A row that slipped through with a NULL live vector (the recheck-race
      // shape): cleanup must re-queue its page, not just delete its chunks.
      const fresh = await query<{ id: number }>(
        `INSERT INTO pages (confluence_id, source, title, body_text, body_storage, body_html, page_type, visibility)
         VALUES (gen_random_uuid()::text, 'standalone', 'Slipped page', 'slipped body text long enough', '', '<p>x</p>', 'page', 'shared')
         RETURNING id`,
      );
      await query(
        `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
         VALUES ($1, 0, 'slipped chunk', NULL, '{}'::jsonb)`,
        [fresh.rows[0]!.id],
      );
      await query(`UPDATE pages SET embedding_status = 'embedded', embedding_dirty = FALSE WHERE id = $1`, [fresh.rows[0]!.id]);

      await cleanupShadowMigration();

      const rows = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM page_embeddings WHERE page_id = $1`, [fresh.rows[0]!.id]);
      expect(rows.rows[0]!.n).toBe(0);
      const dirty = await query<{ embedding_dirty: boolean; embedding_status: string }>(
        `SELECT embedding_dirty, embedding_status FROM pages WHERE id = $1`,
        [fresh.rows[0]!.id],
      );
      expect(dirty.rows[0]!.embedding_dirty).toBe(true);
      expect(dirty.rows[0]!.embedding_status).toBe('not_embedded');
    });

    it('rollback before swap aborts: drops the shadow columns and clears state', async () => {
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });

      await rollbackShadowMigration();

      expect(await columnInfo('page_embeddings', 'embedding_next')).toBeUndefined();
      expect(await getShadowMigrationState()).toBeNull();
    });

    it("a rollback landing during cleanup's lock wait is caught by cleanup's in-lock recheck (review r3)", async () => {
      // cleanup-vs-rollback: if the rollback wins the lock and reverts the
      // schema to 'active', cleanup's IF EXISTS drops would silently no-op
      // and its DELETE would erase the ACTIVE migration's state row —
      // stranding the _next columns and wedging every future start.
      await seedEmbeddedPage('Doc A');
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      await runShadowBackfillJob();
      await performShadowSwap();

      const blocker = await getPool().connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT 1 FROM page_embeddings LIMIT 1');

        const cleanupPromise = cleanupShadowMigration({ lockTimeoutMs: 3000, maxAttempts: 2 }).then(
          () => 'cleaned' as const,
          (e: unknown) => e as Error,
        );
        await new Promise((r) => setTimeout(r, 300)); // cleanup queued on the lock
        // The rollback wins conceptually: simulate its committed end-state.
        const state = await getShadowMigrationState();
        await query(
          `UPDATE admin_settings SET setting_value = $1 WHERE setting_key = 'embedding_shadow_migration'`,
          [JSON.stringify({ ...state, status: 'active' })],
        );
        await blocker.query('ROLLBACK');

        const result = await cleanupPromise;
        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toMatch(/changed mid-cleanup/i);
        // The state row survived:
        expect(await getShadowMigrationState()).not.toBeNull();
      } finally {
        await blocker.query('ROLLBACK').catch(() => {});
        blocker.release();
      }
    }, 20_000);

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
      // The refusal must reach the destructive route as a 409, not a masked
      // 500 (review r1: llm-embedding-reembed.ts has no error mapping, so the
      // statusCode rides on the error itself).
      const err = await enqueueReembedAll({ newDimensions: 512 }).catch((e) => e);
      expect((err as { statusCode?: number }).statusCode).toBe(409);
    });
  });
});
