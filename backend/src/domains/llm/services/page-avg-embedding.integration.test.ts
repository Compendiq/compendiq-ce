/**
 * Integration test for issue #919 — real Postgres + pgvector.
 *
 * computePageRelationships used to AVG the ENTIRE page_embeddings table and
 * run an exact (index-less) pairwise nearest-neighbour scan on every embedding
 * run, hitting the 120s statement timeout as the corpus grew. The fix
 * materializes each page's average embedding on `pages.page_avg_embedding`
 * (migration 083) and serves kNN from an HNSW index.
 *
 * These tests exercise the real SQL that the pure-vi.fn unit tests in
 * embedding-service.test.ts cannot observe:
 *   1. embedPage materializes pages.page_avg_embedding as the elementwise
 *      average of the page's chunk vectors.
 *   2. computePageRelationships([changedId]) derives embedding_similarity
 *      edges from the materialized averages (near neighbour linked, orthogonal
 *      page not), so no full-table AVG is needed.
 *
 * Only the external embedding provider is mocked; Postgres, chunking and every
 * DB transaction run for real. Skipped when the test PG instance is offline.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Captures the vectors the mocked provider hands back so the test can compute
// the expected elementwise average independent of chunkText's internals.
const cap = vi.hoisted(() => ({ vectors: [] as number[][], counter: 0 }));

// Mock ONLY the external embedding provider — no real LLM call. Each chunk gets
// a distinct deterministic 1024-dim vector so averaging is genuinely exercised.
vi.mock('./openai-compatible-client.js', async () => {
  const actual = await vi.importActual<typeof import('./openai-compatible-client.js')>(
    './openai-compatible-client.js',
  );
  return {
    ...actual,
    generateEmbedding: vi.fn(async (_cfg: unknown, _model: string, texts: string[] | string) => {
      const arr = Array.isArray(texts) ? texts : [texts];
      return arr.map(() => {
        const seed = ++cap.counter;
        const v = Array.from({ length: 1024 }, (_, i) => Math.sin((i + 1) * seed) * 0.01);
        cap.vectors.push(v);
        return v;
      });
    }),
  };
});

// Provider resolver: skip the real DB lookup — the client mock ignores config.
vi.mock('./llm-provider-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./llm-provider-resolver.js')>(
    './llm-provider-resolver.js',
  );
  return {
    ...actual,
    resolveUsecase: vi.fn(async () => ({
      config: {
        providerId: 'test-provider',
        id: 'test-provider',
        name: 'Test',
        baseUrl: 'http://localhost:0/v1',
        apiKey: null,
        authType: 'none' as const,
        verifySsl: false,
        defaultModel: 'bge-m3',
      },
      model: 'bge-m3',
    })),
  };
});

import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { embedPage, computePageRelationships } from './embedding-service.js';
import pgvector from 'pgvector';

const dbAvailable = await isDbAvailable();

/** Insert a bare page row and return its integer id. */
async function seedPage(title = 'Page'): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html)
     VALUES (gen_random_uuid()::text, 'confluence', 'DEV', $1, 'body', '', '')
     RETURNING id`,
    [title],
  );
  return res.rows[0]!.id;
}

/** Read pages.page_avg_embedding back as a plain number[] (NULL -> null). */
async function readAvg(pageId: number): Promise<number[] | null> {
  const res = await query<{ v: string | null }>(
    'SELECT page_avg_embedding::text AS v FROM pages WHERE id = $1',
    [pageId],
  );
  const raw = res.rows[0]!.v;
  return raw ? (JSON.parse(raw) as number[]) : null;
}

describe.skipIf(!dbAvailable)('page_avg_embedding materialization + indexed kNN — issue #919', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
    cap.vectors = [];
    cap.counter = 0;
  });

  it('embedPage stores the elementwise average of the page chunk vectors', async () => {
    const pageId = await seedPage('Averaged Page');

    // Body large enough to produce several chunks (each ~1500 chars target).
    const para = '<p>' + 'Compendiq knowledge base content sentence. '.repeat(60) + '</p>';
    const bodyHtml = para.repeat(6);

    const chunks = await embedPage('test-user', pageId, 'Averaged Page', 'DEV', bodyHtml);

    // Sanity: the provider was asked to embed >1 chunk so averaging matters.
    expect(chunks).toBeGreaterThan(1);
    expect(cap.vectors.length).toBe(chunks);

    const embeddedCount = await query<{ c: string }>(
      'SELECT COUNT(*)::text AS c FROM page_embeddings WHERE page_id = $1',
      [pageId],
    );
    expect(embeddedCount.rows[0]!.c).toBe(String(chunks));

    // Expected elementwise mean of the captured chunk vectors.
    const dims = 1024;
    const expected = new Array(dims).fill(0);
    for (const v of cap.vectors) {
      for (let i = 0; i < dims; i++) expected[i] += v[i]!;
    }
    for (let i = 0; i < dims; i++) expected[i] /= cap.vectors.length;

    const stored = await readAvg(pageId);
    expect(stored).not.toBeNull();
    expect(stored!.length).toBe(dims);
    // float32 storage vs float64 mean — compare a spread of components.
    for (const i of [0, 1, 5, 42, 511, 1023]) {
      expect(stored![i]).toBeCloseTo(expected[i], 4);
    }
  });

  it('computePageRelationships([changed]) links the near page via materialized averages, not the orthogonal one', async () => {
    const near = await seedPage('Near');       // A — close to changed
    const far = await seedPage('Orthogonal');  // B — orthogonal to changed
    const changed = await seedPage('Changed');  // C — the freshly re-embedded page

    const unit = (fill: (i: number) => number): string =>
      pgvector.toSql(Array.from({ length: 1024 }, (_, i) => fill(i)));

    // A ~ [1,0,0,...]; C ~ [1,0.02,0,...] (cosine ~1 with A); B ~ [0,1,0,...] (orthogonal).
    await query('UPDATE pages SET page_avg_embedding = $1 WHERE id = $2', [unit((i) => (i === 0 ? 1 : 0)), near]);
    await query('UPDATE pages SET page_avg_embedding = $1 WHERE id = $2', [unit((i) => (i === 1 ? 1 : 0)), far]);
    await query('UPDATE pages SET page_avg_embedding = $1 WHERE id = $2', [unit((i) => (i === 0 ? 1 : i === 1 ? 0.02 : 0)), changed]);

    const edges = await computePageRelationships([changed]);
    expect(edges).toBeGreaterThanOrEqual(1);

    const sim = await query<{ page_id_1: number; page_id_2: number; score: number }>(
      `SELECT page_id_1, page_id_2, score FROM page_relationships
       WHERE relationship_type = 'embedding_similarity'
       ORDER BY page_id_2`,
    );

    // Exactly one similarity edge: the changed page -> its near neighbour.
    expect(sim.rows.length).toBe(1);
    expect(sim.rows[0]!.page_id_1).toBe(changed);
    expect(sim.rows[0]!.page_id_2).toBe(near);
    expect(sim.rows[0]!.score).toBeGreaterThan(0.4);

    // The orthogonal page must NOT be linked to the changed page.
    const toFar = sim.rows.find((r) => r.page_id_2 === far);
    expect(toFar).toBeUndefined();
  });
});
