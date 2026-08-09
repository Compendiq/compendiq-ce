import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';

// #1102 — the seeder against real Postgres. The embedding PROVIDER is mocked
// at its HTTP boundary; the chunking, the pgvector writes and the column
// retyping are all real, because those are what the eval depends on.

const MODEL_DIMS = 384; // the small CI model's dimension, deliberately != the schema's 1024

const { generateEmbeddingMock } = vi.hoisted(() => ({
  generateEmbeddingMock: vi.fn(async (_cfg: unknown, _model: string, input: string | string[]) => {
    const texts = Array.isArray(input) ? input : [input];
    return texts.map((_, i) => Array.from({ length: MODEL_DIMS }, (_, j) => Math.sin((j + 1) * (i + 2)) * 0.01));
  }),
}));
vi.mock('../services/openai-compatible-client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/openai-compatible-client.js')>(
    '../services/openai-compatible-client.js',
  );
  return { ...actual, generateEmbedding: generateEmbeddingMock };
});

const { seedCorpus, ensureVectorDimensions, configureEmbeddingProvider, EVAL_SPACE_KEY } = await import('./seed.js');
const { loadCorpus } = await import('./fixture.js');

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
    generateEmbeddingMock.mockClear();
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
      // Markdown was converted, not stored raw: retrieval reads body_html.
      expect(row.rows[0]!.body_html).toContain('<');

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
