import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';

// #1102 — the seeder against real Postgres. The embedding PROVIDER is mocked
// at its HTTP boundary; the chunking, the pgvector writes and the column
// retyping are all real, because those are what the eval depends on.

const MODEL_DIMS = 384; // the small CI model's dimension, deliberately != the schema's 1024

// Named so beforeEach can RE-INSTALL it: a bare mockClear() keeps the last
// test's mockImplementation, which is how the truncation-probe tests below
// silently broke the seeding tests above them.
const { generateEmbeddingMock, defaultEmbeddingImpl } = vi.hoisted(() => {
  const defaultEmbeddingImpl = async (_cfg: unknown, _model: string, input: string | string[]) => {
    const texts = Array.isArray(input) ? input : [input];
    return texts.map((_, i) => Array.from({ length: 384 }, (_, j) => Math.sin((j + 1) * (i + 2)) * 0.01));
  };
  return { generateEmbeddingMock: vi.fn(defaultEmbeddingImpl), defaultEmbeddingImpl };
});
vi.mock('../services/openai-compatible-client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/openai-compatible-client.js')>(
    '../services/openai-compatible-client.js',
  );
  return { ...actual, generateEmbedding: generateEmbeddingMock };
});

const { seedCorpus, ensureVectorDimensions, configureEmbeddingProvider, resetEvalCorpus, assertModelReadsFullChunk, TruncatingModelError, EVAL_SPACE_KEY } = await import('./seed.js');
const { loadCorpus } = await import('./fixture.js');

// Real corpus prose, so the probe carries the token density a real chunk does
// — repeated filler words are ~6 chars/token, corpus text is ~4 (review r2).
const SAMPLE = loadCorpus()
  .map((p) => p.markdown)
  .join('\n\n')
  .slice(0, 20_000);

const dbAvailable = await isDbAvailable();
const USER = 'aaaaaaaa-1102-4000-8000-000000000002';

async function vectorDims(table: string, column: string): Promise<number | null> {
  const r = await query<{ atttypmod: number }>(
    `SELECT atttypmod FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2`,
    [table, column],
  );
  const mod = r.rows[0]?.atttypmod;
  return mod === undefined || mod < 0 ? null : mod;
}

describe.skipIf(!dbAvailable)('eval seeder (#1102)', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    // Leave the shared schema as the canonical 1024 for every other suite.
    await ensureVectorDimensions(1024);
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, $1::text, $1::text || '@t', 'admin', 'x') ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
    generateEmbeddingMock.mockReset();
    generateEmbeddingMock.mockImplementation(defaultEmbeddingImpl);
  });

  it('retypes both vector columns to the probed dimension and rebuilds the indexes', async () => {
    await ensureVectorDimensions(MODEL_DIMS);

    expect(await vectorDims('page_embeddings', 'embedding')).toBe(MODEL_DIMS);
    // pages.page_avg_embedding must move WITH it: embedPage assigns an AVG of
    // the chunk vectors into it, and a mismatch fails every page's embed.
    expect(await vectorDims('pages', 'page_avg_embedding')).toBe(MODEL_DIMS);

    const idx = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
         AND indexname IN ('idx_page_embeddings_hnsw', 'idx_pages_page_avg_embedding_hnsw')`,
    );
    expect(idx.rows).toHaveLength(2);
  });

  it('is a no-op when the dimension already matches, so a re-run does not drop the corpus', async () => {
    await ensureVectorDimensions(MODEL_DIMS);
    await configureEmbeddingProvider({ baseUrl: 'http://stub/v1', model: 'stub-embed' });
    await seedCorpus(USER, { corpus: loadCorpus().slice(0, 2) });
    const before = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM page_embeddings`);

    await ensureVectorDimensions(MODEL_DIMS);

    const after = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM page_embeddings`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(before.rows[0]!.n).toBeGreaterThan(0);
  });

  it('reseeding replaces the corpus instead of duplicating it', async () => {
    // The bug this exists for: a second run against the same database left two
    // identical copies of every page, retrieval split between the twins, and
    // the comparison reported a credible REGRESSION for identical code.
    await ensureVectorDimensions(MODEL_DIMS);
    await configureEmbeddingProvider({ baseUrl: 'http://stub/v1', model: 'stub-embed' });
    const corpus = loadCorpus().slice(0, 3);

    await seedCorpus(USER, { corpus });
    await resetEvalCorpus();
    const second = await seedCorpus(USER, { corpus });

    const pages = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages`);
    expect(pages.rows[0]!.n).toBe(3);
    for (const pageId of second.pageIdByFile.values()) {
      const row = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages WHERE id = $1`, [pageId]);
      expect(row.rows[0]!.n).toBe(1);
    }
  });

  it('refuses a probe sample shorter than a real chunk, which would certify nothing', async () => {
    const CFG = { providerId: 'x', id: 'x', name: 'x', baseUrl: '', apiKey: null, authType: 'none' as const, verifySsl: true, defaultModel: 'm' };
    await expect(assertModelReadsFullChunk(CFG, 'm', 'too short')).rejects.toThrow(/real corpus text/i);
  });

  it('refuses a model that truncates the input, which would score text it never read', async () => {
    // The real failure: all-minilm returns BYTE-IDENTICAL vectors for two
    // 5400-character texts differing only in their last word, while the run
    // still reports "100% embedded" and a confident Recall@K.
    const CFG = { providerId: 'x', id: 'x', name: 'x', baseUrl: '', apiKey: null, authType: 'none' as const, verifySsl: true, defaultModel: 'm' };
    const truncated = Array.from({ length: 8 }, (_, i) => i / 8);
    generateEmbeddingMock.mockImplementation(async () => [truncated]);

    await expect(assertModelReadsFullChunk(CFG, 'truncating-model', SAMPLE)).rejects.toBeInstanceOf(TruncatingModelError);
    await expect(assertModelReadsFullChunk(CFG, 'truncating-model', SAMPLE)).rejects.toThrow(/truncating the input/i);
  });

  it('accepts a model whose vector responds to the end of the chunk', async () => {
    const CFG = { providerId: 'x', id: 'x', name: 'x', baseUrl: '', apiKey: null, authType: 'none' as const, verifySsl: true, defaultModel: 'm' };
    let call = 0;
    generateEmbeddingMock.mockImplementation(async () => {
      call++;
      return [Array.from({ length: 8 }, (_, i) => Math.sin((i + 1) * call))];
    });

    await expect(assertModelReadsFullChunk(CFG, 'honest-model', SAMPLE)).resolves.toBeUndefined();
  });

  it('refuses an implausible dimension rather than issuing the DDL', async () => {
    await expect(ensureVectorDimensions(0)).rejects.toThrow(/implausible/i);
    await expect(ensureVectorDimensions(99_999)).rejects.toThrow(/implausible/i);
  });

  it('seeds pages through the real pipeline and maps every file to its page id', async () => {
    await ensureVectorDimensions(MODEL_DIMS);
    await configureEmbeddingProvider({ baseUrl: 'http://stub/v1', model: 'stub-embed' });
    const corpus = loadCorpus().slice(0, 3);

    const result = await seedCorpus(USER, { corpus });

    expect(result.pageIdByFile.size).toBe(3);
    expect(result.embeddedPages).toBe(3);
    expect(result.skipped).toEqual([]);
    // The provider was actually called — the pipeline ran, rather than rows
    // being inserted with pre-computed vectors.
    expect(generateEmbeddingMock).toHaveBeenCalled();

    for (const page of corpus) {
      const pageId = result.pageIdByFile.get(page.file)!;
      const row = await query<{ title: string; space_key: string; body_html: string }>(
        `SELECT title, space_key, body_html FROM pages WHERE id = $1`,
        [pageId],
      );
      expect(row.rows[0]!.title).toBe(page.title);
      expect(row.rows[0]!.space_key).toBe(EVAL_SPACE_KEY);
      // Converted, not stored raw. Asserting merely that body_html contains
      // '<' proves nothing — every corpus page's markdown contains one
      // already (review r1). Assert the conversion's signature instead.
      expect(row.rows[0]!.body_html).toMatch(/<(p|h[1-6]|ul|pre|code)\b/);

      // …and body_text is the EXTRACTED text the FTS trigger indexes, not the
      // markdown source: no heading markers, no code fences, no link URLs.
      const stored = await query<{ body_text: string }>(`SELECT body_text FROM pages WHERE id = $1`, [pageId]);
      expect(stored.rows[0]!.body_text).not.toMatch(/^#{1,6}\s/m);
      expect(stored.rows[0]!.body_text).not.toContain('```');

      const chunks = await query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM page_embeddings WHERE page_id = $1`,
        [pageId],
      );
      expect(chunks.rows[0]!.n).toBeGreaterThan(0);
    }
  });

  it('makes the corpus fully embedded, which is what the runner refuses to measure without', async () => {
    await ensureVectorDimensions(MODEL_DIMS);
    await configureEmbeddingProvider({ baseUrl: 'http://stub/v1', model: 'stub-embed' });

    await seedCorpus(USER, { corpus: loadCorpus().slice(0, 5) });

    const { getEmbeddingCoverage } = await import('../services/rag-service.js');
    expect((await getEmbeddingCoverage(USER)).coverage).toBe(1);
  });

  it('configures a provider row, without which resolveUsecase throws and retrieval degrades silently', async () => {
    const providerId = await configureEmbeddingProvider({ baseUrl: 'http://stub/v1', model: 'stub-embed' });

    const assignment = await query<{ provider_id: string; model: string }>(
      `SELECT provider_id, model FROM llm_usecase_assignments WHERE usecase = 'embedding'`,
    );
    expect(assignment.rows[0]).toEqual({ provider_id: providerId, model: 'stub-embed' });
  });
});
