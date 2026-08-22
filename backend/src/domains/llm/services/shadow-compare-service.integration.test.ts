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
}));

// Page → candidate basis index, keyed off the chunk text the backfill embeds.
const PAGE_AXES: Array<[string, number]> = [
  ['Page A', 0],
  ['Page B', 1],
  ['Page C', 2],
  ['Secret D', 3],
];

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
      return vectors;
    },
  );
}

const { createShadowCompareRun, getShadowCompareRun, runShadowCompare } = await import(
  './shadow-compare-service.js'
);
const { startShadowMigration, runShadowBackfillJob, getShadowMigrationStatus } = await import(
  './shadow-migration-service.js'
);
const { getActiveProductionBenchmark } = await import('../eval/production-benchmark.js');
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
      await runShadowCompare(runId, ADMIN);

      const run = await getShadowCompareRun(runId);
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
      expect((await getShadowCompareRun(runId))?.status).toBe('completed');

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

      const run = await getShadowCompareRun(runId);
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
      const run = await getShadowCompareRun(runId);
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

      const run = await getShadowCompareRun(runId);
      expect(run?.status).toBe('failed');
      expect(run?.error).toMatch(/changed while the comparison ran/i);
      expect(run?.error).not.toMatch(/42703|column/i);
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
      const run = await getShadowCompareRun(runId);
      expect(run?.status).toBe('failed');
      expect(run?.error).toBe('No production queries were available in the selected period');
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
      // two deliberately share the slot, and both cards say so.
      expect((await getActiveProductionBenchmark())?.id).toBe(runId);
    });

    it('getShadowCompareRun answers null for a run of another kind', async () => {
      const foreign = await query<{ id: string }>(
        `INSERT INTO retrieval_benchmark_runs (requested_by, status, config)
         VALUES ($1, 'completed', '{"source":"recent-queries","days":30,"limit":25,"topK":5}'::jsonb)
         RETURNING id`,
        [ADMIN],
      );
      expect(await getShadowCompareRun(foreign.rows[0]!.id)).toBeNull();
    });
  });
});
