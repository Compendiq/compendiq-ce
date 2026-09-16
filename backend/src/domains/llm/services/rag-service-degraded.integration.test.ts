import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import pgvector from 'pgvector';

// #1117 stage 2: the degraded-retrieval signal. The old signal was a boolean
// EXISTS probe that reported "healthy" the moment the FIRST visible page had an
// embedding row — 1% coverage looked identical to 100%. These tests pin the
// coverage-aware replacement and the analytics rows it writes.

// Deterministic 1024-dim vector for fixtures and queries
function fakeVec(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => Math.sin((i + 1) * seed) * 0.01);
}

// Stub the embedding provider; individual tests override per-call to simulate
// provider failure. Mock at the module boundary, DB stays real.
const generateEmbeddingMock = vi.hoisted(() => vi.fn(async () => [fakeVec(7)]));
vi.mock('./openai-compatible-client.js', async () => {
  const actual = await vi.importActual<typeof import('./openai-compatible-client.js')>(
    './openai-compatible-client.js',
  );
  return {
    ...actual,
    generateEmbedding: generateEmbeddingMock,
  };
});
vi.mock('./llm-provider-resolver.js', () => ({
  resolveUsecase: vi.fn(async () => ({
    config: {
      providerId: 'stub',
      id: 'stub',
      name: 'stub',
      baseUrl: '',
      apiKey: null,
      authType: 'none',
      verifySsl: true,
      defaultModel: 'stub',
    },
    model: 'stub',
  })),
}));

// Mutable EE flag so the ACL post-filter branch's analytics write is covered
// too — it duplicates the non-ACL branch deliberately and must not drift.
let ragPermissionEnforcementEnabled = false;
vi.mock('../../../core/enterprise/loader.js', async () => {
  const actual = await vi.importActual<typeof import('../../../core/enterprise/loader.js')>(
    '../../../core/enterprise/loader.js',
  );
  return {
    ...actual,
    isFeatureEnabled: (feature: string): boolean =>
      feature === 'rag_permission_enforcement' ? ragPermissionEnforcementEnabled : false,
  };
});

const {
  hybridSearch,
  getEmbeddingCoverage,
  flushSearchAnalytics,
  DEGRADED_COVERAGE_THRESHOLD,
} = await import('./rag-service.js');

const dbAvailable = await isDbAvailable();

const USER = 'dddddddd-1117-4000-8000-000000000001';
const OTHER = 'dddddddd-1117-4000-8000-000000000002';
const SPACE = 'COV';

async function seedUser(id: string): Promise<void> {
  await query(
    `INSERT INTO users (id, username, email, role, password_hash)
     VALUES ($1::uuid, $1::text, $1::text || '@t', 'user', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [id],
  );
}

async function seedSpaceForUser(userId: string, spaceKey: string): Promise<void> {
  await seedUser(userId);
  await query(
    `INSERT INTO spaces (space_key, space_name) VALUES ($1, $1)
     ON CONFLICT (space_key) DO NOTHING`,
    [spaceKey],
  );
  const role = await query<{ id: number }>(`SELECT id FROM roles WHERE name = 'viewer'`);
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)
     ON CONFLICT DO NOTHING`,
    [spaceKey, userId, role.rows[0]!.id],
  );
}

async function seedPage(opts: {
  spaceKey?: string;
  title: string;
  bodyHtml?: string | null;
  pageType?: string;
  embedded?: boolean;
  vecSeed?: number;
  visibility?: string;
  createdBy?: string;
}): Promise<number> {
  const {
    spaceKey = SPACE,
    title,
    // Long enough that the page clears embedPage's 20-char minimum — the
    // coverage denominator excludes pages below it (they can never embed).
    bodyHtml = '<p>content long enough to clear the embeddable minimum</p>',
    pageType,
    embedded = false,
    vecSeed = 7,
    visibility,
    createdBy,
  } = opts;
  const page = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html,
                        page_type, visibility, created_by_user_id)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, '', $5, $6, COALESCE($7, 'shared'), $8)
     RETURNING id`,
    [
      visibility !== undefined ? 'standalone' : 'confluence',
      visibility !== undefined ? null : spaceKey,
      title,
      `${title} body text with enough characters to embed`,
      bodyHtml,
      pageType ?? 'page',
      visibility ?? null,
      createdBy ?? null,
    ],
  );
  const pageId = page.rows[0]!.id;
  if (embedded) {
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, 0, $2, $3, $4::jsonb)`,
      [
        pageId,
        `${title} body text`,
        pgvector.toSql(fakeVec(vecSeed)),
        JSON.stringify({ page_title: title, section_title: title, space_key: spaceKey }),
      ],
    );
  }
  return pageId;
}

async function lastAnalyticsRow(): Promise<{
  search_type: string;
  degraded_reason: string | null;
  embedding_coverage: number | null;
  rerank_score: number | null;
}> {
  await flushSearchAnalytics();
  const { rows } = await query<{
    search_type: string;
    degraded_reason: string | null;
    embedding_coverage: number | null;
    rerank_score: number | null;
  }>(
    `SELECT search_type, degraded_reason, embedding_coverage, rerank_score
     FROM search_analytics ORDER BY created_at DESC LIMIT 1`,
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe.skipIf(!dbAvailable)('#1117 degraded-retrieval signal', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await flushSearchAnalytics();
    await truncateAllTables();
    await query(
      `INSERT INTO roles (name, display_name, is_system, permissions) VALUES
         ('viewer', 'Viewer', TRUE, ARRAY['read'])
       ON CONFLICT (name) DO NOTHING`,
    );
    await seedSpaceForUser(USER, SPACE);
    generateEmbeddingMock.mockClear();
    generateEmbeddingMock.mockImplementation(async () => [fakeVec(7)]);
    ragPermissionEnforcementEnabled = false;
  });
  afterEach(async () => {
    await flushSearchAnalytics();
  });

  describe('getEmbeddingCoverage', () => {
    it('reports the embedded fraction of the embeddable corpus', async () => {
      await seedPage({ title: 'Embedded page', embedded: true });
      await seedPage({ title: 'Bare page one', embedded: false });
      await seedPage({ title: 'Bare page two', embedded: false });
      await seedPage({ title: 'Bare page three', embedded: false });

      const cov = await getEmbeddingCoverage(USER);
      expect(cov.embeddedPages).toBe(1);
      expect(cov.totalPages).toBe(4);
      expect(cov.coverage).toBeCloseTo(0.25, 5);
    });

    it('excludes folders and contentless pages from the denominator', async () => {
      await seedPage({ title: 'Real page', embedded: true });
      await seedPage({ title: 'A folder', pageType: 'folder' });
      await seedPage({ title: 'No body yet', bodyHtml: null });

      const cov = await getEmbeddingCoverage(USER);
      expect(cov.totalPages).toBe(1);
      expect(cov.coverage).toBe(1);
    });

    it("does not count pages the caller cannot see — another user's private note", async () => {
      await seedUser(OTHER);
      await seedPage({ title: 'Visible page', embedded: true });
      await seedPage({
        title: 'Private note',
        visibility: 'private',
        createdBy: OTHER,
        embedded: false,
      });

      const cov = await getEmbeddingCoverage(USER);
      expect(cov.totalPages).toBe(1);
      expect(cov.coverage).toBe(1);
    });

    it('treats an empty embeddable corpus as full coverage, not degradation', async () => {
      const cov = await getEmbeddingCoverage(USER);
      expect(cov.embeddedPages).toBe(0);
      expect(cov.totalPages).toBe(0);
      expect(cov.coverage).toBe(1);
    });

    it('excludes pages the pipeline permanently refuses — under 20 chars of text (review r1)', async () => {
      // embedPage skips any page whose plain text is under 20 characters and
      // settles it with zero embedding rows. Counting such pages in the
      // denominator would make a corpus with >5% structural stubs read
      // "degraded" forever — a cry-wolf banner with no recovery action.
      await seedPage({ title: 'Real page', embedded: true });
      const stub = await query<{ id: number }>(
        `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html, page_type)
         VALUES (gen_random_uuid()::text, 'confluence', $1, 'Stub', 'short', '', '<p>short</p>', 'page')
         RETURNING id`,
        [SPACE],
      );
      expect(stub.rows[0]!.id).toBeGreaterThan(0);

      const cov = await getEmbeddingCoverage(USER);
      expect(cov.totalPages).toBe(1);
      expect(cov.coverage).toBe(1);
    });
  });

  describe('hybridSearch analytics', () => {
    it('records a healthy row at full coverage', async () => {
      await seedPage({ title: 'Runbook', embedded: true });

      await hybridSearch(USER, 'Runbook body');

      const row = await lastAnalyticsRow();
      expect(row.search_type).toBe('hybrid');
      expect(row.degraded_reason).toBeNull();
      expect(row.embedding_coverage).toBe(1);
      expect(row.rerank_score).toBeNull();
    });

    it('records partial_embeddings with the measured coverage below the threshold', async () => {
      await seedPage({ title: 'Runbook', embedded: true });
      await seedPage({ title: 'Second doc', embedded: false });
      await seedPage({ title: 'Third doc', embedded: false });
      await seedPage({ title: 'Fourth doc', embedded: false });

      await hybridSearch(USER, 'Runbook body');

      const row = await lastAnalyticsRow();
      expect(row.search_type).toBe('hybrid');
      expect(row.degraded_reason).toBe('partial_embeddings');
      expect(row.embedding_coverage).toBeCloseTo(0.25, 5);
    });

    it('stays healthy at exactly the documented threshold', async () => {
      // 19 of 20 embedded = 0.95 — the boundary is `< threshold`, so this is
      // NOT degraded. One transiently-dirty page must not raise the flag.
      expect(DEGRADED_COVERAGE_THRESHOLD).toBe(0.95);
      for (let i = 0; i < 19; i++) {
        await seedPage({ title: `Doc ${i}`, embedded: true, vecSeed: i + 2 });
      }
      await seedPage({ title: 'Fresh edit', embedded: false });

      await hybridSearch(USER, 'Doc body');

      const row = await lastAnalyticsRow();
      expect(row.degraded_reason).toBeNull();
      expect(row.embedding_coverage).toBeCloseTo(0.95, 5);
    });

    it('records no_embeddings when the corpus has embeddable pages but zero embeddings', async () => {
      await seedPage({ title: 'Runbook', embedded: false });

      await hybridSearch(USER, 'Runbook body');

      const row = await lastAnalyticsRow();
      // The vector leg contributed nothing while keyword answered, so the
      // existing search_type semantics already say keyword_fallback — the new
      // degraded_reason records WHY (empty index, not a provider failure).
      expect(row.search_type).toBe('keyword_fallback');
      expect(row.degraded_reason).toBe('no_embeddings');
      expect(row.embedding_coverage).toBe(0);
    });

    it('uses an injected coverage reading instead of probing again (review r1)', async () => {
      // /api/search hands its own probe result over so a hybrid request never
      // counts twice. Prove the injected value wins: the DB is fully embedded,
      // but the caller injects a partial reading and the row must carry it.
      await seedPage({ title: 'Runbook', embedded: true });

      await hybridSearch(USER, 'Runbook body', 5, {
        embeddedPages: 1,
        totalPages: 4,
        coverage: 0.25,
      });

      const row = await lastAnalyticsRow();
      expect(row.degraded_reason).toBe('partial_embeddings');
      expect(row.embedding_coverage).toBeCloseTo(0.25, 5);
    });

    it('records the extras on the EE ACL branch too (review r1)', async () => {
      ragPermissionEnforcementEnabled = true;
      await seedPage({ title: 'Runbook', embedded: true });
      await seedPage({ title: 'Second doc', embedded: false });
      await seedPage({ title: 'Third doc', embedded: false });
      await seedPage({ title: 'Fourth doc', embedded: false });

      await hybridSearch(USER, 'Runbook body');

      const row = await lastAnalyticsRow();
      expect(row.degraded_reason).toBe('partial_embeddings');
      expect(row.embedding_coverage).toBeCloseTo(0.25, 5);
    });

    it('records embedding_failed when the provider throws, alongside keyword_fallback', async () => {
      await seedPage({ title: 'Runbook', embedded: true });
      generateEmbeddingMock.mockImplementationOnce(async () => {
        throw new Error('provider exploded');
      });

      const results = await hybridSearch(USER, 'Runbook body');
      // The keyword leg still returns rows — the SEARCH degrades. Since
      // #1114's prerequisite the ANSWER does not: `/llm/ask` refuses the
      // turn over exactly these rows and attaches them as unranked
      // references, so "still answered" would now be the wrong word for it.
      expect(results.length).toBeGreaterThan(0);

      const row = await lastAnalyticsRow();
      expect(row.search_type).toBe('keyword_fallback');
      expect(row.degraded_reason).toBe('embedding_failed');
      // Coverage was still measured — the corpus itself is fine.
      expect(row.embedding_coverage).toBe(1);
    });
  });
});
