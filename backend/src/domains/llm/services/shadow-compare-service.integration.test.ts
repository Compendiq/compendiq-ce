import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import pgvector from 'pgvector';

// #1260 — shadow comparison on real queries, against real Postgres. The
// embedding provider and the job queue are mocked at their boundaries (the
// same two the #1116 migration tests mock); everything else — the shadow
// backfill, both kNN probes, the ACL predicate, the run row — is real.

const LIVE_MODEL = 'bge-m3';
// Deliberately a Qwen3 embedding id: the candidate side must be PREFIXED
// while the live side stays bare, and the assertion below reads the actual
// embed calls.
const SHADOW_MODEL = 'qwen3-embedding:4b';

const LIVE_DIMS = 1024;

function basis(dims: number, index: number, weight = 1): number[] {
  const v = Array.from({ length: dims }, () => 0.0001);
  v[index] = weight;
  return v;
}

/** Mix of basis directions, so cosine ranking is strict and deterministic. */
function mix(dims: number, weights: Array<[number, number]>): number[] {
  const v = Array.from({ length: dims }, () => 0.0001);
  for (const [index, weight] of weights) v[index] = weight;
  return v;
}

const mockState = vi.hoisted(() => ({
  shadowDims: 8,
  /** When set, the shadow-model QUERY embed simulates a concurrent abort
   *  (drops the shadow columns + state) after answering. */
  abortAfterCandidateQueryEmbed: false,
  /** When set, the shadow-model QUERY embed rewrites only the migration
   *  STATE row (a swap immediately rolled back), leaving both columns and
   *  the index standing — only the loop-top fingerprint check can see it. */
  rewriteStateAfterCandidateQueryEmbed: false,
  /** When set, the shadow-model QUERY embed drops the shadow COLUMN and
   *  leaves the state row alone: a 42703 with the migration still standing,
   *  which is a schema fault rather than a transient provider failure. */
  dropShadowColumnAfterCandidateQueryEmbed: false,
}));

// Page → candidate basis index, keyed off the chunk text the backfill embeds.
const PAGE_AXES: Array<[string, number]> = [
  ['Page A', 0],
  ['Page B', 1],
  ['Page C', 2],
  ['Secret D', 3],
];

/** A swap immediately rolled back between two queries: `embedding_next` and
 *  its index survive intact, but the state row now carries a `revertedAt`
 *  this run's fingerprint has never seen. No kNN will ever 42703 here. */
async function simulateLifecycleRewrite(): Promise<void> {
  await query(
    `UPDATE admin_settings
     SET setting_value = jsonb_set(setting_value::jsonb, '{revertedAt}', to_jsonb(NOW()::text))::text
     WHERE setting_key = 'embedding_shadow_migration'`,
  );
}

async function simulateAbort(): Promise<void> {
  await query(`DROP INDEX IF EXISTS idx_page_embeddings_hnsw_next`);
  await query(`DROP INDEX IF EXISTS idx_pages_page_avg_embedding_hnsw_next`);
  await query(`ALTER TABLE page_embeddings DROP COLUMN IF EXISTS embedding_next`);
  await query(`ALTER TABLE pages DROP COLUMN IF EXISTS page_avg_embedding_next`);
  await query(`DELETE FROM admin_settings WHERE setting_key = 'embedding_shadow_migration'`);
}

const generateEmbeddingMock = vi.hoisted(() => vi.fn());
vi.mock('./openai-compatible-client.js', async () => {
  const actual = await vi.importActual<typeof import('./openai-compatible-client.js')>(
    './openai-compatible-client.js',
  );
  return { ...actual, generateEmbedding: generateEmbeddingMock };
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

function installEmbeddingMock(): void {
  generateEmbeddingMock.mockImplementation(
    async (_cfg: unknown, model: string, input: string | string[]) => {
      const texts = Array.isArray(input) ? input : [input];
      const dims = model === SHADOW_MODEL ? mockState.shadowDims : LIVE_DIMS;
      const vectors = texts.map((text) => {
        if (model === SHADOW_MODEL) {
          // Backfill embeds chunk texts (bare); the comparison embeds the
          // prefixed query. Chunk texts carry their page name.
          const axis = PAGE_AXES.find(([name]) => text.includes(name));
          if (axis) return basis(dims, axis[1]);
          // Query: rank B > C > A on the candidate column; Secret D would
          // win outright if the ACL predicate were missing.
          return mix(dims, [[3, 0.95], [1, 0.9], [2, 0.4], [0, 0.1]]);
        }
        // Live model sees only query text here (live vectors are seeded by
        // SQL): rank A > B > C, with Secret D again the would-be winner.
        return mix(dims, [[3, 0.95], [0, 0.9], [1, 0.4], [2, 0.1]]);
      });
      if (model === SHADOW_MODEL && !Array.isArray(input) && mockState.abortAfterCandidateQueryEmbed) {
        await simulateAbort();
      }
      if (
        model === SHADOW_MODEL &&
        !Array.isArray(input) &&
        mockState.rewriteStateAfterCandidateQueryEmbed
      ) {
        await simulateLifecycleRewrite();
      }
      if (
        model === SHADOW_MODEL &&
        !Array.isArray(input) &&
        mockState.dropShadowColumnAfterCandidateQueryEmbed
      ) {
        await query(`DROP INDEX IF EXISTS idx_page_embeddings_hnsw_next`);
        await query(`ALTER TABLE page_embeddings DROP COLUMN IF EXISTS embedding_next`);
      }
      return vectors;
    },
  );
}

const {
  createShadowCompareRun,
  getShadowCompareRun,
  getLatestShadowCompareRun,
  runShadowCompare,
  recordShadowCompareJudgement,
  getShadowCompareJudgements,
  MIN_JUDGEMENTS_FOR_P,
  // The Mode 2 refusals as TYPES. The route maps them with `instanceof`, so
  // asserting only their English message here leaves that seam untested: a
  // plain `new Error('<same words>')` kept every message regex green while
  // `mapJudgementError` fell through to null and Fastify answered 500 where
  // the surface needs 404/409/422 (r2).
  CompareRunNotFoundError,
  CompareRunIncompleteError,
  UnknownCompareQueryError,
} = await import('./shadow-compare-service.js');
const { startShadowMigration, runShadowBackfillJob, getShadowMigrationStatus } = await import(
  './shadow-migration-service.js'
);
const { getActiveProductionBenchmark, getProductionBenchmarkRun } = await import(
  '../eval/production-benchmark.js'
);
const { recoverStaleBenchmarkRuns } = await import('../eval/benchmark-run-lifecycle.js');
const { sampleAnalyticsQueries } = await import('../eval/analytics-query-sampler.js');

const dbAvailable = await isDbAvailable();

const ADMIN = 'aaaaaaaa-1260-4000-8000-000000000001';
const OTHER_USER = 'aaaaaaaa-1260-4000-8000-000000000002';
let liveProviderId = '';
let shadowProviderId = '';

async function seedBase(): Promise<void> {
  for (const [id, role] of [
    [ADMIN, 'admin'],
    [OTHER_USER, 'user'],
  ] as const) {
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, $1::text, $1::text || '@t', $2, 'x') ON CONFLICT (id) DO NOTHING`,
      [id, role],
    );
  }
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
}

async function seedEmbeddedPage(
  title: string,
  liveVector: number[],
  opts?: { privateTo?: string },
): Promise<number> {
  const page = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html, page_type, visibility, created_by_user_id)
     VALUES (gen_random_uuid()::text, 'standalone', NULL, $1, $1 || ' body text with enough characters', '', '<p>' || $1 || ' body</p>', 'page', $2, $3)
     RETURNING id`,
    [title, opts?.privateTo ? 'private' : 'shared', opts?.privateTo ?? null],
  );
  const pageId = page.rows[0]!.id;
  await query(
    `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
     VALUES ($1, 0, $2, $3, $4::jsonb)`,
    [
      pageId,
      `${title} chunk 0 text`,
      pgvector.toSql(liveVector),
      JSON.stringify({ page_title: title, section_title: title, space_key: null }),
    ],
  );
  await query(`UPDATE pages SET embedding_status = 'embedded', embedding_dirty = FALSE WHERE id = $1`, [pageId]);
  return pageId;
}

async function seedAnalytics(entries: Array<[string, number]>): Promise<void> {
  for (const [text, count] of entries) {
    for (let i = 0; i < count; i++) {
      await query(
        `INSERT INTO search_analytics (user_id, query, result_count, search_type, created_at)
         VALUES ($1, $2, 3, 'hybrid', NOW() - ($3 * INTERVAL '1 minute'))`,
        [ADMIN, text, i],
      );
    }
  }
}

/** Seed pages, start the migration through the real service, run the real
 *  backfill to `ready`. Returns the page ids in [A, B, C, D] order. */
async function seedReadyMigration(): Promise<number[]> {
  const a = await seedEmbeddedPage('Page A', mix(LIVE_DIMS, [[0, 1]]));
  const b = await seedEmbeddedPage('Page B', mix(LIVE_DIMS, [[1, 1]]));
  const c = await seedEmbeddedPage('Page C', mix(LIVE_DIMS, [[2, 1]]));
  const d = await seedEmbeddedPage('Secret D', mix(LIVE_DIMS, [[3, 1]]), { privateTo: OTHER_USER });
  await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
  const backfill = await runShadowBackfillJob();
  expect(backfill).toEqual({ processed: 4, failed: 0 });
  const status = await getShadowMigrationStatus();
  expect(status?.phase).toBe('ready');
  return [a, b, c, d];
}

async function resetCanonicalSchema(): Promise<void> {
  await query(`ALTER TABLE page_embeddings DROP COLUMN IF EXISTS embedding_next`);
  await query(`ALTER TABLE pages DROP COLUMN IF EXISTS page_avg_embedding_next`);
  await query(`DROP INDEX IF EXISTS idx_page_embeddings_hnsw_next`);
  await query(`DROP INDEX IF EXISTS idx_pages_page_avg_embedding_hnsw_next`);
  await query(`DELETE FROM admin_settings WHERE setting_key = 'embedding_shadow_migration'`);
}

describe.skipIf(!dbAvailable)('#1260 shadow-compare service', () => {
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
    mockState.shadowDims = 8;
    mockState.abortAfterCandidateQueryEmbed = false;
    mockState.rewriteStateAfterCandidateQueryEmbed = false;
    mockState.dropShadowColumnAfterCandidateQueryEmbed = false;
    generateEmbeddingMock.mockReset();
    installEmbeddingMock();
    getJobStatusMock.mockResolvedValue(null);
  });

  describe('sampleAnalyticsQueries', () => {
    it('orders by frequency, dedups case/whitespace variants, keeps the latest spelling', async () => {
      await seedAnalytics([
        ['export pdf', 1],
        ['reset password', 2],
        ['how to configure sync', 2],
      ]);
      // A case/whitespace variant of the sync query: counts toward its
      // frequency (3 > 2) and the MOST RECENT spelling wins.
      await query(
        `INSERT INTO search_analytics (user_id, query, result_count, search_type, created_at)
         VALUES ($1, '  How to configure SYNC ', 3, 'hybrid', NOW())`,
        [ADMIN],
      );
      const byFrequency = await sampleAnalyticsQueries({ days: 30, limit: 10, orderBy: 'frequency' });
      expect(byFrequency).toEqual(['How to configure SYNC', 'reset password', 'export pdf']);

      const capped = await sampleAnalyticsQueries({ days: 30, limit: 2, orderBy: 'frequency' });
      expect(capped).toHaveLength(2);
    });

    it('keeps the recency ordering the production benchmark was built on', async () => {
      await seedAnalytics([
        ['asked often but long ago', 5],
      ]);
      await query(
        `UPDATE search_analytics SET created_at = NOW() - INTERVAL '10 days'`,
      );
      await seedAnalytics([['asked once, just now', 1]]);
      const byRecency = await sampleAnalyticsQueries({ days: 30, limit: 10, orderBy: 'recency' });
      expect(byRecency[0]).toBe('asked once, just now');
      const byFrequency = await sampleAnalyticsQueries({ days: 30, limit: 10, orderBy: 'frequency' });
      expect(byFrequency[0]).toBe('asked often but long ago');
    });
  });

  describe('runShadowCompare', () => {
    it('retrieves per-query top-K from both columns, reports agreement, and never leaks chunk text', async () => {
      const [a, b, c, d] = await seedReadyMigration();
      await seedAnalytics([
        ['how to configure sync', 3],
        ['reset password', 2],
        ['export pdf', 1],
      ]);
      generateEmbeddingMock.mockClear();

      const runId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });

      // Observe the 092 heartbeat DURING the run, not after it: the claim and
      // completion writes both touch `last_heartbeat_at` seconds apart, so a
      // post-run freshness SELECT cannot tell per-batch renewal from none.
      // Back-date the row on the FIRST query's candidate embed; by a LATER
      // query's embed only the intervening per-query progress write can have
      // repaired it. Without per-batch heartbeats the captured value stays two
      // hours stale and `recoverStaleProductionBenchmarks` would mark a long
      // run failed mid-flight, freeing the one-active slot under the worker.
      const innerEmbedImpl = generateEmbeddingMock.getMockImplementation()!;
      let candidateQueryEmbeds = 0;
      let heartbeatFreshMidRun: boolean | null = null;
      generateEmbeddingMock.mockImplementation(async (cfg, model, input) => {
        if (model === SHADOW_MODEL && !Array.isArray(input)) {
          candidateQueryEmbeds++;
          if (candidateQueryEmbeds === 1) {
            await query(
              `UPDATE retrieval_benchmark_runs
               SET last_heartbeat_at = NOW() - INTERVAL '2 hours' WHERE id = $1`,
              [runId],
            );
          } else if (candidateQueryEmbeds === 2) {
            const seen = await query<{ fresh: boolean }>(
              `SELECT last_heartbeat_at > NOW() - INTERVAL '1 minute' AS fresh
               FROM retrieval_benchmark_runs WHERE id = $1`,
              [runId],
            );
            heartbeatFreshMidRun = seen.rows[0]?.fresh ?? null;
          }
        }
        return innerEmbedImpl(cfg, model, input);
      });

      await runShadowCompare(runId, ADMIN);

      // The per-query progress write renewed the back-dated heartbeat while
      // the run was still mid-loop.
      expect(heartbeatFreshMidRun).toBe(true);

      const run = await getShadowCompareRun(runId, ADMIN);
      expect(run?.status).toBe('completed');
      expect(run?.progressDone).toBe(3);
      expect(run?.progressTotal).toBe(3);
      const report = run!.result!;
      expect(report.kind).toBe('shadow-compare');
      expect(report.topK).toBe(3);
      expect(report.queryCount).toBe(3);
      expect(report.live).toEqual({ providerId: liveProviderId, model: LIVE_MODEL });
      expect(report.candidate).toEqual({ providerId: shadowProviderId, model: SHADOW_MODEL });

      // Frequency order, live A>B>C vs candidate B>C>A on every query.
      expect(report.queries.map((row) => row.query)).toEqual([
        'how to configure sync',
        'reset password',
        'export pdf',
      ]);
      for (const row of report.queries) {
        expect(row.live.pageIds).toEqual([a, b, c]);
        expect(row.candidate.pageIds).toEqual([b, c, a]);
        expect(row.top1Changed).toBe(true);
        expect(row.jaccard).toBe(1);
        expect(row.rbo).toBeLessThan(1);
        // The ACL predicate ran on BOTH columns: Secret D's vectors are the
        // best match for every query vector, and it belongs to someone else.
        expect(row.live.pageIds).not.toContain(d);
        expect(row.candidate.pageIds).not.toContain(d);
        expect(row.live.pages.map((page) => page.title)).toEqual(['Page A', 'Page B', 'Page C']);
      }
      expect(report.agreement.queryCount).toBe(3);
      expect(report.agreement.top1ChangedQueries).toBe(3);
      expect(report.agreement.disagreementCount).toBe(3);
      expect(report.agreement.meanJaccard).toBe(1);

      // Page ids and titles only — the persisted report must carry no chunk
      // text and no raw vectors.
      const persisted = JSON.stringify(report);
      expect(persisted).not.toContain('chunk 0 text');

      // The run heartbeats (092): a stale sweep must see live progress.
      const heartbeat = await query<{ fresh: boolean }>(
        `SELECT last_heartbeat_at > NOW() - INTERVAL '1 minute' AS fresh
         FROM retrieval_benchmark_runs WHERE id = $1`,
        [runId],
      );
      expect(heartbeat.rows[0]?.fresh).toBe(true);
    });

    it('prefixes the QUERY embed per model: Qwen3 candidate prefixed, bge-m3 live bare', async () => {
      await seedReadyMigration();
      await seedAnalytics([['how to configure sync', 1]]);
      generateEmbeddingMock.mockClear();

      const runId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      await runShadowCompare(runId, ADMIN);
      expect((await getShadowCompareRun(runId, ADMIN))?.status).toBe('completed');

      const queryCalls = generateEmbeddingMock.mock.calls.filter(
        (call) => typeof call[2] === 'string',
      );
      const liveCall = queryCalls.find((call) => call[1] === LIVE_MODEL);
      const candidateCall = queryCalls.find((call) => call[1] === SHADOW_MODEL);
      expect(liveCall?.[2]).toBe('how to configure sync');
      expect(candidateCall?.[2]).toMatch(/^Instruct: /);
      expect(candidateCall?.[2]).toContain('\nQuery:how to configure sync');
    });

    it('compares against a halfvec candidate column without any cast', async () => {
      mockState.shadowDims = 2560; // halfvec tier
      await seedReadyMigration();
      await seedAnalytics([['how to configure sync', 1]]);
      generateEmbeddingMock.mockClear();

      const runId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      await runShadowCompare(runId, ADMIN);

      const run = await getShadowCompareRun(runId, ADMIN);
      expect(run?.status).toBe('completed');
      expect(run?.result?.queries[0]?.candidate.pageIds.length).toBeGreaterThan(0);
    });

    it('fails cleanly when no shadow migration exists', async () => {
      await seedAnalytics([['how to configure sync', 1]]);
      const runId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      await runShadowCompare(runId, ADMIN);
      const run = await getShadowCompareRun(runId, ADMIN);
      expect(run?.status).toBe('failed');
      expect(run?.error).toMatch(/not in the ready window/i);
    });

    it('an abort landing mid-run is a clean failure naming the migration change, never a 42703 crash', async () => {
      await seedReadyMigration();
      await seedAnalytics([['how to configure sync', 1]]);
      generateEmbeddingMock.mockClear();
      // The candidate QUERY embed simulates a concurrent abort right after
      // answering, so the very next kNN names a dropped column.
      mockState.abortAfterCandidateQueryEmbed = true;

      const runId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      await runShadowCompare(runId, ADMIN);

      const run = await getShadowCompareRun(runId, ADMIN);
      expect(run?.status).toBe('failed');
      expect(run?.error).toMatch(/changed while the comparison ran/i);
      expect(run?.error).not.toMatch(/42703|column/i);
    });

    it('a lifecycle change that keeps the columns standing fails at the next query boundary, not with a stitched two-epoch report', async () => {
      await seedReadyMigration();
      await seedAnalytics([
        ['how to configure sync', 2],
        ['reset password', 1],
      ]);
      generateEmbeddingMock.mockClear();
      // The FIRST query's candidate embed rewrites only the state row (a swap
      // immediately rolled back): both columns and the index stay, so the
      // 42703 fallback can never fire — the loop-top fingerprint re-check is
      // the ONLY thing standing between this and a report spanning two
      // migration epochs.
      mockState.rewriteStateAfterCandidateQueryEmbed = true;

      const runId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      await runShadowCompare(runId, ADMIN);

      const run = await getShadowCompareRun(runId, ADMIN);
      expect(run?.status).toBe('failed');
      expect(run?.error).toMatch(/changed while the comparison ran/i);
      // The first query completed; the guard fired BETWEEN queries, at the
      // second query's loop top.
      expect(run?.progressDone).toBe(1);
      // The premise the 42703 path cannot cover: the candidate column is
      // still there, so no kNN ever errored.
      const column = await query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'page_embeddings' AND column_name = 'embedding_next'`,
      );
      expect(column.rowCount).toBe(1);
    });

    it('never admits a page whose embedding_next is NULL — a null distance is not a perfect match', async () => {
      // `embedding_next` is nullable by construction and the dual-write
      // deliberately leaves it NULL when the candidate provider fails on a
      // page edited mid-migration. `NULL <=> $2` is NULL, and `1 - null` is
      // 1 in JS: unguarded, the unfilled page enters the candidate top-K as
      // its BEST hit and inflates every agreement figure computed from it.
      const [a, b, c] = await seedReadyMigration();
      await seedAnalytics([['how to configure sync', 1]]);
      // The row goes NULL *during* the run — a page edited mid-migration
      // whose candidate-side dual-write failed. Nothing re-checks the
      // straggler count per query (only the migration fingerprint does), so
      // the run carries on and this row is what it retrieves against.
      const innerEmbedImpl = generateEmbeddingMock.getMockImplementation()!;
      generateEmbeddingMock.mockImplementation(async (cfg, model, input) => {
        const vectors = await innerEmbedImpl(cfg, model, input);
        if (model === SHADOW_MODEL && !Array.isArray(input)) {
          // Clear the candidate vector of the page the candidate ranks FIRST.
          await query(`UPDATE page_embeddings SET embedding_next = NULL WHERE page_id = $1`, [b]);
        }
        return vectors;
      });

      const runId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 10,
      });
      await runShadowCompare(runId, ADMIN);

      const run = await getShadowCompareRun(runId, ADMIN);
      expect(run?.status).toBe('completed');
      const row = run!.result!.queries[0]!;
      expect(row.candidate.pageIds).not.toContain(b);
      // The remaining candidate ranking is intact, and the live side — whose
      // column is untouched — still sees every page.
      expect(row.candidate.pageIds).toEqual([c, a]);
      expect(row.live.pageIds).toEqual([a, b, c]);
    });

    it('skips a query whose embedding call fails, keeps the work already done, and says how many', async () => {
      // A 429, an opened breaker or a shared-queue timeout at query 2 of 3
      // must not throw away query 1: the run has already spent N x 2 provider
      // calls, and re-running re-spends the whole budget.
      const [a, b, c] = await seedReadyMigration();
      await seedAnalytics([
        ['how to configure sync', 3],
        ['reset password', 2],
        ['export pdf', 1],
      ]);
      const innerEmbedImpl = generateEmbeddingMock.getMockImplementation()!;
      generateEmbeddingMock.mockImplementation(async (cfg, model, input) => {
        if (!Array.isArray(input) && input === 'reset password') {
          throw new Error('429 Too Many Requests');
        }
        return innerEmbedImpl(cfg, model, input);
      });

      const runId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      await runShadowCompare(runId, ADMIN);

      const run = await getShadowCompareRun(runId, ADMIN);
      expect(run?.status).toBe('completed');
      const report = run!.result!;
      expect(report.failedQueries).toBe(1);
      expect(report.sampledQueryCount).toBe(3);
      expect(report.queryCount).toBe(2);
      expect(report.queries.map((row) => row.query)).toEqual([
        'how to configure sync',
        'export pdf',
      ]);
      // The surviving rows are real comparisons, and their ids stay dense so
      // a judgement can address every rendered row.
      expect(report.queries.map((row) => row.id)).toEqual(['query-1', 'query-2']);
      expect(report.queries[0]!.live.pageIds).toEqual([a, b, c]);
      expect(report.agreement.queryCount).toBe(2);
      // Progress still reaches the sampled total, so the card does not hang
      // at 2/3 on a completed run.
      expect(run?.progressDone).toBe(3);
    });

    it('fails the run when most queries fail — a thinned sample is not a comparison', async () => {
      await seedReadyMigration();
      await seedAnalytics([
        ['how to configure sync', 3],
        ['reset password', 2],
        ['export pdf', 1],
      ]);
      generateEmbeddingMock.mockImplementation(async (_cfg, _model, input) => {
        if (!Array.isArray(input)) throw new Error('503 provider unavailable');
        return [basis(8, 0)];
      });

      const runId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      await runShadowCompare(runId, ADMIN);

      const run = await getShadowCompareRun(runId, ADMIN);
      expect(run?.status).toBe('failed');
      expect(run?.error).toMatch(/3 of 3 queries could not be embedded/i);
    });

    it('draws the publishable line at half the sample: 2 of 4 completes, 3 of 4 fails', async () => {
      // The cut itself, not merely its existence. The other two cases (1 of 3
      // completes, 3 of 3 fails) hold for every share in [1/3, 1), so the one
      // number deciding when a thinned sample stops being evidence for a
      // production swap could drift to 0.95 with the suite green. The counts
      // here are deliberately hand-written rather than derived from the
      // constant: bracketing it is the whole point.
      await seedReadyMigration();
      await seedAnalytics([
        ['how to configure sync', 4],
        ['reset password', 3],
        ['export pdf', 2],
        ['permissions model', 1],
      ]);
      const innerEmbedImpl = generateEmbeddingMock.getMockImplementation()!;
      let failing: string[] = ['export pdf', 'permissions model'];
      generateEmbeddingMock.mockImplementation(async (cfg, model, input) => {
        if (!Array.isArray(input) && failing.some((text) => input === text)) {
          throw new Error('429 Too Many Requests');
        }
        return innerEmbedImpl(cfg, model, input);
      });

      const half = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      await runShadowCompare(half, ADMIN);
      const halfRun = await getShadowCompareRun(half, ADMIN);
      expect(halfRun?.status).toBe('completed');
      expect(halfRun?.result?.failedQueries).toBe(2);
      expect(halfRun?.result?.sampledQueryCount).toBe(4);

      failing = ['export pdf', 'permissions model', 'reset password'];
      const majority = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      await runShadowCompare(majority, ADMIN);
      const majorityRun = await getShadowCompareRun(majority, ADMIN);
      expect(majorityRun?.status).toBe('failed');
      expect(majorityRun?.error).toMatch(/3 of 4 queries could not be embedded/i);
    });

    it('a 42703 with the migration STILL STANDING stops the run instead of blaming the provider', async () => {
      // The first cut's comment said this branch stayed "the bug it would
      // be"; the code fell through to the skipped-query path, so every query
      // raised the same schema fault, the run tripped the failed-share
      // ceiling, and the admin was told to check the provider about a missing
      // column.
      await seedReadyMigration();
      await seedAnalytics([
        ['how to configure sync', 3],
        ['reset password', 2],
        ['export pdf', 1],
      ]);
      // The column disappears DURING the run (after the phase gate, after the
      // loop-top fingerprint check) with the migration state row LEFT INTACT,
      // so the fingerprint is unchanged and only the 42703 itself is evidence.
      mockState.dropShadowColumnAfterCandidateQueryEmbed = true;

      const runId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      await runShadowCompare(runId, ADMIN);

      const run = await getShadowCompareRun(runId, ADMIN);
      expect(run?.status).toBe('failed');
      expect(run?.error).toMatch(/column the comparison reads is missing/i);
      expect(run?.error).not.toMatch(/check the provider/i);
      // Stopped at the FIRST query rather than spending the whole sample on
      // an error no retry can clear.
      expect(run?.progressDone).toBe(0);
    });

    it('fails cleanly with no analytics queries in the window', async () => {
      await seedReadyMigration();
      const runId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      await runShadowCompare(runId, ADMIN);
      const run = await getShadowCompareRun(runId, ADMIN);
      expect(run?.status).toBe('failed');
      // The most likely first-run outcome on a quiet instance, rendered in the
      // section's amber strip on every attempt — so it names the knob that
      // fixes it, and the window it is talking about (r1 of this round).
      expect(run?.error).toMatch(/no searches were recorded in the last 30 days/i);
      expect(run?.error).toMatch(/look back \(days\)/i);
    });

    it('the empty-sample failure quotes the window that was actually asked for', async () => {
      // The remedy is "widen the window", so the sentence has to say which
      // window — a fixed "the selected period" leaves the admin guessing at
      // the number they set two fields away.
      await seedReadyMigration();
      const runId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 7,
        limit: 50,
        topK: 3,
      });
      await runShadowCompare(runId, ADMIN);
      const run = await getShadowCompareRun(runId, ADMIN);
      expect(run?.error).toMatch(/last 7 days/i);
    });
  });

  describe('the shared one-active slot', () => {
    it('a queued compare blocks a second run and is visible to the production benchmark guard', async () => {
      const runId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 10,
      });
      await expect(
        createShadowCompareRun(ADMIN, { kind: 'shadow-compare', days: 30, limit: 50, topK: 10 }),
      ).rejects.toThrow(/already running/i);
      // The production benchmark's own 409 guard sees the compare run — the
      // two deliberately share the slot, and both cards say so. It also
      // reports the holder's KIND off the real config row, so the compare
      // route can word its 409 as a comparison rather than a benchmark (r3).
      const active = await getActiveProductionBenchmark();
      expect(active?.id).toBe(runId);
      expect(active?.kind).toBe('shadow-compare');
    });

    it('a completed run frees the slot for the next one', async () => {
      await seedReadyMigration();
      await seedAnalytics([['how to configure sync', 1]]);
      const first = await createShadowCompareRun(ADMIN, { kind: 'shadow-compare', days: 30, limit: 50, topK: 3 });
      await runShadowCompare(first, ADMIN);
      expect((await getShadowCompareRun(first, ADMIN))?.status).toBe('completed');
      await expect(
        createShadowCompareRun(ADMIN, { kind: 'shadow-compare', days: 30, limit: 50, topK: 3 }),
      ).resolves.toBeTruthy();
    });

    it('getShadowCompareRun answers null for a run of another kind', async () => {
      const foreign = await query<{ id: string }>(
        `INSERT INTO retrieval_benchmark_runs (requested_by, status, config)
         VALUES ($1, 'completed', '{"source":"recent-queries","days":30,"limit":25,"topK":5}'::jsonb)
         RETURNING id`,
        [ADMIN],
      );
      expect(await getShadowCompareRun(foreign.rows[0]!.id, ADMIN)).toBeNull();
    });

    it('the benchmark surface answers null for a COMPARE run — the kind guard is symmetric', async () => {
      // Without this the benchmark GET serves a comparison (sampled
      // production query text included) to `BenchmarkSummary`, which
      // dereferences `report.baseline` and blanks the Retrieval panel. The
      // benchmark's own 409 hands out `runId: active.id`, which is a compare
      // run's id whenever a comparison holds the shared slot.
      const compareId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 10,
      });
      expect(await getProductionBenchmarkRun(compareId, ADMIN)).toBeNull();
      expect((await getShadowCompareRun(compareId, ADMIN))?.id).toBe(compareId);
    });

    it('the stale sweep fails a comparison with COMPARISON wording, and a benchmark with the benchmark one', async () => {
      // One sweep, two kinds. Telling an admin whose comparison was killed by
      // a pod restart to "start a new benchmark" names a run they never
      // started, on a different tab.
      const compareId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 10,
      });
      await query(
        `UPDATE retrieval_benchmark_runs SET last_heartbeat_at = NOW() - INTERVAL '2 hours'`,
      );
      await recoverStaleBenchmarkRuns();
      const stale = await getShadowCompareRun(compareId, ADMIN);
      expect(stale?.status).toBe('failed');
      expect(stale?.error).toMatch(/comparison worker stopped/i);
      expect(stale?.error).not.toMatch(/benchmark/i);

      const benchId = await query<{ id: string }>(
        `INSERT INTO retrieval_benchmark_runs (requested_by, status, config, last_heartbeat_at)
         VALUES ($1, 'running', '{"source":"recent-queries","days":30,"limit":25,"topK":5}'::jsonb,
                 NOW() - INTERVAL '2 hours')
         RETURNING id`,
        [ADMIN],
      );
      await recoverStaleBenchmarkRuns();
      const staleBench = await getProductionBenchmarkRun(benchId.rows[0]!.id, ADMIN);
      expect(staleBench?.status).toBe('failed');
      expect(staleBench?.error).toMatch(/benchmark worker stopped/i);
    });
  });

  describe('reading a run back', () => {
    it('is scoped to the admin who started it — a report carries titles from THAT admin\'s ACL', async () => {
      // `Secret D` is visible only to its owner, so a report started by an
      // admin who can see it must not be readable by another admin, who has
      // no other route to those titles and keeps none of the run's context.
      const runId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 10,
      });
      await query(
        `INSERT INTO users (id, username, email, role, password_hash)
         VALUES ($1::uuid, 'admin2', 'admin2@t', 'admin', 'x') ON CONFLICT (id) DO NOTHING`,
        ['aaaaaaaa-1260-4000-8000-000000000009'],
      );
      expect((await getShadowCompareRun(runId, ADMIN))?.id).toBe(runId);
      expect(await getShadowCompareRun(runId, 'aaaaaaaa-1260-4000-8000-000000000009')).toBeNull();
      await expect(
        getShadowCompareJudgements(runId, 'aaaaaaaa-1260-4000-8000-000000000009'),
      ).rejects.toBeInstanceOf(CompareRunNotFoundError);
    });

    it('finds this admin\'s most recent comparison after the card lost its run id', async () => {
      expect(await getLatestShadowCompareRun(ADMIN)).toBeNull();
      const runId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 10,
      });
      expect((await getLatestShadowCompareRun(ADMIN))?.id).toBe(runId);
      // Not another admin's, and not a production benchmark.
      expect(await getLatestShadowCompareRun(OTHER_USER)).toBeNull();
      await query(`DELETE FROM retrieval_benchmark_runs`);
      await query(
        `INSERT INTO retrieval_benchmark_runs (requested_by, status, config)
         VALUES ($1, 'completed', '{"source":"recent-queries","days":30,"limit":25,"topK":5}'::jsonb)`,
        [ADMIN],
      );
      expect(await getLatestShadowCompareRun(ADMIN)).toBeNull();
    });

    it('never re-attaches a comparison run against a DIFFERENT candidate model', async () => {
      // Run rows outlive the migration that produced them. Without the
      // candidate stamp, an aborted migration's report is adopted into the
      // NEXT migration's card: the old candidate's page lists under a heading
      // naming the new one, with live judgement controls beside them — on the
      // one surface the feature exists to produce swap go/no-go evidence on.
      await seedReadyMigration();
      await seedAnalytics([['how to configure sync', 1]]);
      const oldRun = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      await runShadowCompare(oldRun, ADMIN);
      expect((await getLatestShadowCompareRun(ADMIN))?.id).toBe(oldRun);

      // Abort that migration and start a second one against another model.
      await simulateAbort();
      await startShadowMigration({ providerId: shadowProviderId, model: 'some-other-embed:1b' });
      expect(await getLatestShadowCompareRun(ADMIN)).toBeNull();

      // A run started under the NEW migration is adopted again, and the run
      // itself stays readable by id — only the "latest" adoption is scoped.
      const newRun = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      expect((await getLatestShadowCompareRun(ADMIN))?.id).toBe(newRun);
      expect((await getShadowCompareRun(oldRun, ADMIN))?.id).toBe(oldRun);
    });

    it('re-attaches the newest run OF THE LIVE PAIR, not merely the newest run', async () => {
      // The pair check must be part of the SELECT, not a filter applied after
      // `LIMIT 1` (r2). An admin who flip-flops the candidate — start against
      // X, abort, start against Y, abort, come back to X — otherwise loses the
      // completed comparison of X: the newest row names Y, the filter discards
      // it, and the card offers to re-spend N x 2 embedding calls on a
      // comparison that is sitting finished in the table.
      await seedReadyMigration();
      await seedAnalytics([['how to configure sync', 1]]);
      const runAgainstX = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      await runShadowCompare(runAgainstX, ADMIN);
      expect((await getShadowCompareRun(runAgainstX, ADMIN))?.status).toBe('completed');

      // A newer comparison against a DIFFERENT candidate…
      await simulateAbort();
      await startShadowMigration({ providerId: shadowProviderId, model: 'some-other-embed:1b' });
      const runAgainstY = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      expect((await getLatestShadowCompareRun(ADMIN))?.id).toBe(runAgainstY);

      // …and back to X. The completed comparison of the pair that is live now
      // is still the evidence this card exists to show, even though Y's row is
      // the newest one this admin owns.
      await simulateAbort();
      await startShadowMigration({ providerId: shadowProviderId, model: SHADOW_MODEL });
      expect((await getLatestShadowCompareRun(ADMIN))?.id).toBe(runAgainstX);
    });

    it('never re-attaches a run started against the same model behind a DIFFERENT provider', async () => {
      // 101 keys judgements by provider AND model; the adoption must use the
      // same identity, or two providers' indexes are pooled into one card.
      await seedReadyMigration();
      const runId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      expect((await getLatestShadowCompareRun(ADMIN))?.id).toBe(runId);
      await simulateAbort();
      const other = await query<{ id: string }>(
        `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default)
         VALUES ('shadow-prov-2','http://shadow2/v1','none',true,false) RETURNING id`,
      );
      await startShadowMigration({ providerId: other.rows[0]!.id, model: SHADOW_MODEL });
      expect(await getLatestShadowCompareRun(ADMIN)).toBeNull();
    });
  });

  describe('judgements (Mode 2)', () => {
    async function completedRun(): Promise<string> {
      await seedReadyMigration();
      await seedAnalytics([
        ['how to configure sync', 3],
        ['reset password', 2],
        ['export pdf', 1],
      ]);
      const runId = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      await runShadowCompare(runId, ADMIN);
      expect((await getShadowCompareRun(runId, ADMIN))?.status).toBe('completed');
      return runId;
    }

    it('records a judgement keyed to the run query, replaces on re-judge, and answers the verdict', async () => {
      const runId = await completedRun();

      const first = await recordShadowCompareJudgement(runId, 'query-1', 'candidate', ADMIN);
      expect(first.judgements['query-1']).toBe('candidate');
      expect(first.verdict.judgementCount).toBe(1);
      expect(first.verdict.candidateBetter).toBe(1);
      // Below the floor no p is quoted — a p-value over one judgement is noise
      // wearing statistics.
      expect(first.verdict.mcnemar?.pValue).toBeNull();
      expect(first.verdict.minJudgementsForP).toBe(MIN_JUDGEMENTS_FOR_P);

      // Re-judging replaces the row for this (query, model pair) — one vote
      // per query, whatever run it was judged from.
      const again = await recordShadowCompareJudgement(runId, 'query-1', 'live', ADMIN);
      expect(again.verdict.judgementCount).toBe(1);
      expect(again.verdict.liveBetter).toBe(1);
      expect(again.verdict.candidateBetter).toBe(0);

      const got = await getShadowCompareJudgements(runId, ADMIN);
      expect(got.judgements).toEqual({ 'query-1': 'live' });
    });

    it('refuses a judgement on an unfinished run and on an unknown query id', async () => {
      const queued = await createShadowCompareRun(ADMIN, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      // Asserted by TYPE as well as by wording: the route decides 404 / 409 /
      // 422 with `instanceof`, so a refusal that keeps the sentence and loses
      // the class is a 500 on a surface whose whole job is a clean refusal.
      await expect(
        recordShadowCompareJudgement(queued, 'query-1', 'live', ADMIN),
      ).rejects.toBeInstanceOf(CompareRunIncompleteError);
      await expect(recordShadowCompareJudgement(queued, 'query-1', 'live', ADMIN)).rejects.toThrow(
        /not completed/i,
      );
      // Free the slot, complete a run, then a bogus query id.
      await query(`DELETE FROM retrieval_benchmark_runs`);
      const runId = await completedRun();
      await expect(
        recordShadowCompareJudgement(runId, 'query-99', 'live', ADMIN),
      ).rejects.toBeInstanceOf(UnknownCompareQueryError);
      await expect(recordShadowCompareJudgement(runId, 'query-99', 'live', ADMIN)).rejects.toThrow(
        /unknown query/i,
      );
      await expect(
        recordShadowCompareJudgement('2c0c8a92-98a8-4f8c-a6a1-00000000dead', 'query-1', 'live', ADMIN),
      ).rejects.toBeInstanceOf(CompareRunNotFoundError);
      await expect(recordShadowCompareJudgement('2c0c8a92-98a8-4f8c-a6a1-00000000dead', 'query-1', 'live', ADMIN)).rejects.toThrow(
        /not found/i,
      );
    });

    it(`quotes McNemar p, Recall and MRR once ${MIN_JUDGEMENTS_FOR_P} judgements exist for the model pair — the fixture accumulates across runs`, async () => {
      const runId = await completedRun();
      // Three real judgements from this run. Candidate's top page (Page B)
      // is also in the live list, so under the judged-top-page metric these
      // three are ties — the human preferred candidate, but both sides did
      // retrieve the page.
      for (const id of ['query-1', 'query-2', 'query-3']) {
        await recordShadowCompareJudgement(runId, id, 'candidate', ADMIN);
      }
      // Seventeen accumulated judgements for the SAME model pair from earlier
      // runs (inserted the way an earlier run would have): disjoint lists, so
      // the candidate's judged-better top page is missing from the live side
      // — seventeen clean candidate wins.
      for (let i = 0; i < MIN_JUDGEMENTS_FOR_P - 3; i++) {
        await query(
          `INSERT INTO embedding_compare_judgements
             (query_hash, query_text, live_provider_id, live_model, candidate_provider_id, candidate_model,
              judged_side, live_page_ids, candidate_page_ids, judged_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'candidate', ARRAY[101,102], ARRAY[201,202], $7)`,
          [
            `synthetic-${i}`,
            `earlier run query ${i}`,
            liveProviderId,
            LIVE_MODEL,
            shadowProviderId,
            SHADOW_MODEL,
            ADMIN,
          ],
        );
      }

      const { verdict } = await getShadowCompareJudgements(runId, ADMIN);
      expect(verdict.judgementCount).toBe(MIN_JUDGEMENTS_FOR_P);
      expect(verdict.candidateBetter).toBe(MIN_JUDGEMENTS_FOR_P);
      expect(verdict.mcnemar).not.toBeNull();
      expect(verdict.mcnemar!.wins).toBe(17);
      expect(verdict.mcnemar!.losses).toBe(0);
      expect(verdict.mcnemar!.pValue).not.toBeNull();
      expect(verdict.mcnemar!.pValue!).toBeLessThan(0.001);
      expect(verdict.mcnemar!.direction).toBe('improvement');
      // Recall over the judged-better side's top page: candidate contains its
      // own pick every time (1.0); live only on the three tie queries.
      expect(verdict.recall?.candidate).toBe(1);
      expect(verdict.recall?.live).toBeCloseTo(3 / 20, 12);
      expect(verdict.mrr?.candidate).toBeGreaterThan(0);
    });

    it('counts SCORED picks against the floor — ties must not unlock a p over six clicks', async () => {
      // 14 'both' + 6 'candidate' is 20 stored judgements and six real picks.
      // Gated on the stored total, McNemar sees 6 wins / 0 losses and the
      // panel publishes "p = 0.031 — significant, favouring the candidate"
      // from six clicks, which is exactly the verdict the floor exists to
      // withhold.
      const runId = await completedRun();
      const insert = async (i: number, side: string) => {
        await query(
          `INSERT INTO embedding_compare_judgements
             (query_hash, query_text, live_provider_id, live_model, candidate_provider_id, candidate_model,
              judged_side, live_page_ids, candidate_page_ids, judged_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, ARRAY[101,102], ARRAY[201,202], $8)`,
          [
            `tie-${i}`,
            `earlier query ${i}`,
            liveProviderId,
            LIVE_MODEL,
            shadowProviderId,
            SHADOW_MODEL,
            side,
            ADMIN,
          ],
        );
      };
      for (let i = 0; i < 14; i++) await insert(i, 'both');
      for (let i = 14; i < 20; i++) await insert(i, 'candidate');

      const { verdict } = await getShadowCompareJudgements(runId, ADMIN);
      expect(verdict.judgementCount).toBe(20);
      expect(verdict.scoredJudgementCount).toBe(6);
      expect(verdict.mcnemar).not.toBeNull();
      expect(verdict.mcnemar!.wins).toBe(6);
      expect(verdict.mcnemar!.losses).toBe(0);
      expect(verdict.mcnemar!.pValue).toBeNull();
      expect(verdict.mcnemar!.significant).toBe(false);
      expect(verdict.mcnemar!.direction).toBe('none');
    });

    it('a second provider behind the same model names keeps its own verdict', async () => {
      // Re-hosting `qwen3-embedding:4b` behind another provider is a
      // different index: its judgements record different page-id arrays, and
      // pooling them into the earlier migration's verdict scores one
      // migration's evidence against another's.
      const runId = await completedRun();
      await recordShadowCompareJudgement(runId, 'query-1', 'candidate', ADMIN);
      const otherProvider = await query<{ id: string }>(
        `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default)
         VALUES ('shadow-prov-2','http://shadow2/v1','none',true,false) RETURNING id`,
      );
      await query(
        `INSERT INTO embedding_compare_judgements
           (query_hash, query_text, live_provider_id, live_model, candidate_provider_id, candidate_model,
            judged_side, live_page_ids, candidate_page_ids, judged_by)
         VALUES ('other-pair', 'a query from the other migration', $1, $2, $3, $4,
                 'live', ARRAY[301], ARRAY[302], $5)`,
        [liveProviderId, LIVE_MODEL, otherProvider.rows[0]!.id, SHADOW_MODEL, ADMIN],
      );

      const { verdict } = await getShadowCompareJudgements(runId, ADMIN);
      expect(verdict.judgementCount).toBe(1);
      expect(verdict.candidateBetter).toBe(1);
      expect(verdict.liveBetter).toBe(0);
    });

    // ── #1527 — per-judge key, one trial per query ───────────────────────
    //
    // 109 keys the table per judge so one admin can no longer destroy
    // another's evidence. The one-query-one-McNemar-trial invariant therefore
    // moves to the READ path: `judgementsForReport` collapses to the newest
    // judgement per `query_hash`.
    const SECOND_ADMIN = 'aaaaaaaa-1527-4000-8000-00000000000b';

    async function seedSecondAdmin(): Promise<void> {
      await query(
        `INSERT INTO users (id, username, email, role, password_hash)
         VALUES ($1::uuid, 'admin-1527', 'admin-1527@t', 'admin', 'x')
         ON CONFLICT (id) DO NOTHING`,
        [SECOND_ADMIN],
      );
    }

    /** `getShadowCompareRun` is scoped to the admin who STARTED the run, so a
     *  second admin cannot judge the first admin's run — they need their OWN
     *  completed compare of the same live/candidate pair. A completed run
     *  frees the shared one-active slot, and the same query text yields the
     *  same `query_hash`, so both judgements land on one key. */
    async function completedRunFor(admin: string): Promise<string> {
      const runId = await createShadowCompareRun(admin, {
        kind: 'shadow-compare',
        days: 30,
        limit: 50,
        topK: 3,
      });
      await runShadowCompare(runId, admin);
      expect((await getShadowCompareRun(runId, admin))?.status).toBe('completed');
      return runId;
    }

    /** Recency is asserted, so it is SET, never left to the wall clock between
     *  two round-trips. `created_at` is the judged-at stamp: the upsert bumps
     *  it on every re-judge. */
    async function stampJudgement(judgedBy: string, iso: string): Promise<void> {
      await query(
        `UPDATE embedding_compare_judgements SET created_at = $2::timestamptz WHERE judged_by = $1`,
        [judgedBy, iso],
      );
    }

    it('two admins judging one query keep both rows but count as ONE McNemar trial', async () => {
      await seedSecondAdmin();
      const runA = await completedRun();
      await recordShadowCompareJudgement(runA, 'query-1', 'candidate', ADMIN);
      const runB = await completedRunFor(SECOND_ADMIN);
      const view = await recordShadowCompareJudgement(runB, 'query-1', 'candidate', SECOND_ADMIN);

      // Both rows survive on disk — each with its own judge and its own
      // visibility-scoped page-id arrays. That is the ACL fix.
      const stored = await query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM embedding_compare_judgements`,
      );
      expect(Number(stored.rows[0]!.n)).toBe(2);

      // …and the report is still ONE trial for that query: a per-judge key
      // that inflated N would double the evidence behind the p-value.
      expect(view.verdict.judgementCount).toBe(1);
      expect(view.verdict.scoredJudgementCount).toBe(1);
      expect(view.verdict.candidateBetter).toBe(1);
      expect(view.judgements).toEqual({ 'query-1': 'candidate' });
      const readBack = await getShadowCompareJudgements(runA, ADMIN);
      expect(readBack.verdict.judgementCount).toBe(1);
      expect(readBack.judgements).toEqual({ 'query-1': 'candidate' });
    });

    it('the NEWEST judgement wins the collapse, whole row and all', async () => {
      await seedSecondAdmin();
      const runA = await completedRun();
      await recordShadowCompareJudgement(runA, 'query-1', 'live', ADMIN);
      const runB = await completedRunFor(SECOND_ADMIN);
      await recordShadowCompareJudgement(runB, 'query-1', 'candidate', SECOND_ADMIN);

      // Second admin judged most recently → their 'candidate' is the trial.
      await stampJudgement(ADMIN, '2024-01-01T00:00:00Z');
      await stampJudgement(SECOND_ADMIN, '2024-06-01T00:00:00Z');
      let view = await getShadowCompareJudgements(runA, ADMIN);
      expect(view.verdict.judgementCount).toBe(1);
      expect(view.verdict.candidateBetter).toBe(1);
      expect(view.verdict.liveBetter).toBe(0);
      expect(view.judgements).toEqual({ 'query-1': 'candidate' });

      // Invert the recency and the reported side flips with it.
      await stampJudgement(SECOND_ADMIN, '2024-01-01T00:00:00Z');
      await stampJudgement(ADMIN, '2024-06-01T00:00:00Z');
      view = await getShadowCompareJudgements(runA, ADMIN);
      expect(view.verdict.judgementCount).toBe(1);
      expect(view.verdict.liveBetter).toBe(1);
      expect(view.verdict.candidateBetter).toBe(0);
      expect(view.judgements).toEqual({ 'query-1': 'live' });
    });

    /** The tie-break leg is the PRIMARY KEY, so a test of it has to own the
     *  ids: they are `gen_random_uuid()` defaults, and which of two random
     *  uuids is the greater decides the trial. Rewriting them is safe —
     *  nothing references `embedding_compare_judgements.id`. */
    async function stampId(judgedBy: string, id: string): Promise<void> {
      await query(`UPDATE embedding_compare_judgements SET id = $2::uuid WHERE judged_by = $1`, [
        judgedBy,
        id,
      ]);
    }

    it('breaks a created_at TIE on the id, so no unordered scan decides the trial', async () => {
      // `id DESC` is the ORDER BY's only total-ordering leg. Two admins
      // judging one query inside the same microsecond — or a restored dump
      // that flattened the stamps — otherwise leave the trial to whatever
      // row the scan happens to yield first, and the trial is a WHOLE row:
      // the judged side AND the page-id arrays the Recall/MRR expected set
      // and the McNemar discordance are drawn from. Both rows carry ONE
      // timestamp here, so only the id can decide.
      await seedSecondAdmin();
      const runA = await completedRun();
      await recordShadowCompareJudgement(runA, 'query-1', 'live', ADMIN);
      const runB = await completedRunFor(SECOND_ADMIN);
      await recordShadowCompareJudgement(runB, 'query-1', 'candidate', SECOND_ADMIN);

      const TIED = '2024-03-01T00:00:00Z';
      await stampJudgement(ADMIN, TIED);
      await stampJudgement(SECOND_ADMIN, TIED);

      // ADMIN holds the GREATER id → ADMIN's row is the trial.
      await stampId(ADMIN, '00000000-0000-4000-8000-0000000000a2');
      await stampId(SECOND_ADMIN, '00000000-0000-4000-8000-0000000000a1');
      let view = await getShadowCompareJudgements(runA, ADMIN);
      expect(view.verdict.judgementCount).toBe(1);
      expect(view.verdict.liveBetter).toBe(1);
      expect(view.verdict.candidateBetter).toBe(0);
      expect(view.judgements).toEqual({ 'query-1': 'live' });

      // Swap the ids under the same tied timestamp and the trial swaps with
      // them. BOTH directions are asserted on purpose: with the leg deleted
      // the scan yields one fixed row, which is right in one direction and
      // wrong in the other, so a single direction would be a coin flip.
      await stampId(ADMIN, '00000000-0000-4000-8000-0000000000b1');
      await stampId(SECOND_ADMIN, '00000000-0000-4000-8000-0000000000b2');
      view = await getShadowCompareJudgements(runA, ADMIN);
      expect(view.verdict.judgementCount).toBe(1);
      expect(view.verdict.candidateBetter).toBe(1);
      expect(view.verdict.liveBetter).toBe(0);
      expect(view.judgements).toEqual({ 'query-1': 'candidate' });
    });

    it('a re-judge wins the collapse back — `created_at = NOW()` IS the judged-at stamp', async () => {
      // The guard on the upsert's `created_at = NOW()`. The test above stamps
      // BOTH rows after the writes, so it cannot see whether a re-judge bumps
      // the stamp — and without the bump an admin who re-judges a query a
      // colleague judged more recently has their click stored and then
      // IGNORED by the report. Deterministic without stamping the final row:
      // the re-judge's NOW() is necessarily later than both past timestamps.
      await seedSecondAdmin();
      const runA = await completedRun();
      await recordShadowCompareJudgement(runA, 'query-1', 'live', ADMIN);
      const runB = await completedRunFor(SECOND_ADMIN);
      await recordShadowCompareJudgement(runB, 'query-1', 'candidate', SECOND_ADMIN);

      // Push both existing rows into the past, the colleague's the newer.
      await stampJudgement(ADMIN, '2024-01-01T00:00:00Z');
      await stampJudgement(SECOND_ADMIN, '2024-06-01T00:00:00Z');

      // ADMIN re-judges AFTER the colleague, so their row must win again.
      const view = await recordShadowCompareJudgement(runA, 'query-1', 'both', ADMIN);
      expect(view.verdict.judgementCount).toBe(1);
      expect(view.judgements).toEqual({ 'query-1': 'both' });
      expect(view.verdict.both).toBe(1);
      expect(view.verdict.candidateBetter).toBe(0);
      expect(view.verdict.liveBetter).toBe(0);

      // In place, not a third row: the re-judge is an UPDATE on the judge's
      // own key, so the recency cannot have come from a fresh INSERT.
      const stored = await query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM embedding_compare_judgements`,
      );
      expect(Number(stored.rows[0]!.n)).toBe(2);

      const readBack = await getShadowCompareJudgements(runB, SECOND_ADMIN);
      expect(readBack.judgements).toEqual({ 'query-1': 'both' });
    });
  });
});
