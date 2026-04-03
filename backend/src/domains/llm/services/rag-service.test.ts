import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks must be declared before any vi.mock() calls
const mocks = vi.hoisted(() => {
  const mockClientQuery = vi.fn();
  const mockClient = {
    query: mockClientQuery,
    release: vi.fn(),
  };
  const mockPool = {
    connect: vi.fn().mockResolvedValue(mockClient),
  };
  const mockQuery = vi.fn();
  const mockProviderGenerateEmbedding = vi.fn();
  const mockGetUserAccessibleSpaces = vi.fn();
  const mockToSql = vi.fn().mockReturnValue('[0.1,0.2]');

  return {
    mockClientQuery,
    mockClient,
    mockPool,
    mockQuery,
    mockProviderGenerateEmbedding,
    mockGetUserAccessibleSpaces,
    mockToSql,
  };
});

vi.mock('../../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mocks.mockQuery(...args),
  getPool: () => mocks.mockPool,
}));

vi.mock('./llm-provider.js', () => ({
  providerGenerateEmbedding: (...args: unknown[]) => mocks.mockProviderGenerateEmbedding(...args),
}));

vi.mock('../../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mocks.mockGetUserAccessibleSpaces(...args),
}));

vi.mock('pgvector', () => ({
  default: { toSql: (...args: unknown[]) => mocks.mockToSql(...args) },
}));

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../core/services/fts-language.js', () => ({
  getFtsLanguage: vi.fn().mockResolvedValue('simple'),
}));

import { buildRagContext, hybridSearch, RAG_EF_SEARCH, reciprocalRankFusion, vectorSearch, keywordSearch, recordSearchAnalytics } from './rag-service.js';
import type { SearchResult } from './rag-service.js';
import { CircuitBreakerOpenError } from '../../../core/services/circuit-breaker.js';

describe('RAG Service', () => {
  describe('RAG_EF_SEARCH config', () => {
    it('should default to 100', () => {
      // Since test-setup.ts does not set RAG_EF_SEARCH, it should default to 100
      expect(RAG_EF_SEARCH).toBe(100);
    });

    it('should be a positive integer', () => {
      expect(Number.isInteger(RAG_EF_SEARCH)).toBe(true);
      expect(RAG_EF_SEARCH).toBeGreaterThan(0);
    });

    it('should produce a safe number for SQL interpolation', () => {
      expect(Number(RAG_EF_SEARCH)).toBe(RAG_EF_SEARCH);
      expect(Number.isFinite(Number(RAG_EF_SEARCH))).toBe(true);
    });
  });

  describe('buildRagContext', () => {
    it('should return "no context" message for empty results', () => {
      const context = buildRagContext([]);
      expect(context).toBe('No relevant context found in the knowledge base.');
    });

    it('should format a single result', () => {
      const results: SearchResult[] = [
        {
          pageId: 1,
          confluenceId: 'page-1',
          chunkText: 'Some chunk text here.',
          pageTitle: 'Getting Started Guide',
          sectionTitle: 'Installation',
          spaceKey: 'DEV',
          score: 0.85,
        },
      ];

      const context = buildRagContext(results);
      expect(context).toContain('[Source 1:');
      expect(context).toContain('"Getting Started Guide"');
      expect(context).toContain('Space: DEV');
      expect(context).toContain('Section: Installation');
      expect(context).toContain('Some chunk text here.');
    });

    it('should format multiple results separated by ---', () => {
      const results: SearchResult[] = [
        {
          pageId: 1,
          confluenceId: 'page-1',
          chunkText: 'First chunk.',
          pageTitle: 'Page 1',
          sectionTitle: 'Section A',
          spaceKey: 'DEV',
          score: 0.9,
        },
        {
          pageId: 2,
          confluenceId: 'page-2',
          chunkText: 'Second chunk.',
          pageTitle: 'Page 2',
          sectionTitle: 'Section B',
          spaceKey: 'OPS',
          score: 0.8,
        },
      ];

      const context = buildRagContext(results);
      expect(context).toContain('[Source 1:');
      expect(context).toContain('[Source 2:');
      expect(context).toContain('---');
      expect(context).toContain('First chunk.');
      expect(context).toContain('Second chunk.');
    });

    it('should number sources sequentially', () => {
      const results: SearchResult[] = Array.from({ length: 5 }, (_, i) => ({
        pageId: i + 1,
        confluenceId: `page-${i}`,
        chunkText: `Chunk ${i}`,
        pageTitle: `Page ${i}`,
        sectionTitle: `Section ${i}`,
        spaceKey: 'DEV',
        score: 1 - i * 0.1,
      }));

      const context = buildRagContext(results);
      for (let i = 1; i <= 5; i++) {
        expect(context).toContain(`[Source ${i}:`);
      }
    });

    it('should show "Local" for standalone articles with null spaceKey', () => {
      const results: SearchResult[] = [
        {
          pageId: 10,
          confluenceId: 'standalone-1',
          chunkText: 'Standalone article content.',
          pageTitle: 'My Local Article',
          sectionTitle: 'Overview',
          spaceKey: null,
          score: 0.75,
        },
      ];

      const context = buildRagContext(results);
      expect(context).toContain('Space: Local');
      expect(context).toContain('"My Local Article"');
      expect(context).toContain('Standalone article content.');
    });

    it('should handle mixed confluence and standalone results', () => {
      const results: SearchResult[] = [
        {
          pageId: 1,
          confluenceId: 'page-1',
          chunkText: 'Confluence content.',
          pageTitle: 'Confluence Page',
          sectionTitle: 'Intro',
          spaceKey: 'DEV',
          score: 0.9,
        },
        {
          pageId: 11,
          confluenceId: 'standalone-1',
          chunkText: 'Standalone content.',
          pageTitle: 'Local Article',
          sectionTitle: 'Details',
          spaceKey: null,
          score: 0.8,
        },
      ];

      const context = buildRagContext(results);
      expect(context).toContain('Space: DEV');
      expect(context).toContain('Space: Local');
      expect(context).toContain('---');
    });
  });

  describe('RAG_EF_SEARCH bounds check', () => {
    it('should fall back to 100 for NaN input', async () => {
      vi.resetModules();
      vi.stubEnv('RAG_EF_SEARCH', 'garbage');

      const mod = await import('./rag-service.js');
      expect(mod.RAG_EF_SEARCH).toBe(100);
      vi.unstubAllEnvs();
    });

    it('should fall back to 100 for negative input', async () => {
      vi.resetModules();
      vi.stubEnv('RAG_EF_SEARCH', '-5');

      const mod = await import('./rag-service.js');
      expect(mod.RAG_EF_SEARCH).toBe(100);
      vi.unstubAllEnvs();
    });

    it('should fall back to 100 for zero', async () => {
      vi.resetModules();
      vi.stubEnv('RAG_EF_SEARCH', '0');

      const mod = await import('./rag-service.js');
      expect(mod.RAG_EF_SEARCH).toBe(100);
      vi.unstubAllEnvs();
    });

    it('should fall back to 100 for values exceeding 10000', async () => {
      vi.resetModules();
      vi.stubEnv('RAG_EF_SEARCH', '99999');

      const mod = await import('./rag-service.js');
      expect(mod.RAG_EF_SEARCH).toBe(100);
      vi.unstubAllEnvs();
    });

    it('should accept valid values within bounds', async () => {
      vi.resetModules();
      vi.stubEnv('RAG_EF_SEARCH', '200');

      const mod = await import('./rag-service.js');
      expect(mod.RAG_EF_SEARCH).toBe(200);
      vi.unstubAllEnvs();
    });
  });

  describe('vectorSearch (via hybridSearch)', () => {
    beforeEach(() => {
      vi.resetAllMocks();
      // Restore pool mock after reset
      mocks.mockPool.connect.mockResolvedValue(mocks.mockClient);
      mocks.mockClient.release.mockResolvedValue(undefined);
      mocks.mockToSql.mockReturnValue('[0.1,0.2]');
    });

    it('should use pe.page_id = cp.id JOIN (not pe.confluence_id = cp.confluence_id)', async () => {
      // providerGenerateEmbedding returns one 1024-dim vector
      const fakeEmbedding = new Array(1024).fill(0.1);
      mocks.mockProviderGenerateEmbedding.mockResolvedValue([[...fakeEmbedding]]);

      // getUserAccessibleSpaces
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

      // vectorSearch uses pool.connect -> BEGIN -> SET LOCAL -> main SELECT
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({ rows: [] }); // main vector SELECT (empty)
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      // keywordSearch uses query() -- return empty
      mocks.mockQuery.mockResolvedValue({ rows: [] });

      await hybridSearch('user-1', 'test query about embeddings');

      // Verify the vector SELECT SQL contains the corrected JOIN
      const vectorSelectCall = mocks.mockClientQuery.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes('page_embeddings'),
      );
      expect(vectorSelectCall).toBeDefined();
      const vectorSQL = vectorSelectCall![0] as string;
      expect(vectorSQL).toContain('pe.page_id = cp.id');
      expect(vectorSQL).not.toContain('pe.confluence_id = cp.confluence_id');
    });

    it('should return empty results when no embeddings exist', async () => {
      const fakeEmbedding = new Array(1024).fill(0.1);
      mocks.mockProviderGenerateEmbedding.mockResolvedValue([[...fakeEmbedding]]);
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({ rows: [] }); // vector SELECT empty
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      // keyword search + analytics
      mocks.mockQuery.mockResolvedValue({ rows: [] });

      const results = await hybridSearch('user-1', 'test query');
      expect(results).toEqual([]);
    });

    it('should fall back to keyword-only when embedding generation fails', async () => {
      mocks.mockProviderGenerateEmbedding.mockRejectedValue(new Error('Ollama unreachable'));
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

      // keyword search returns results
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [{
          page_id: 1,
          confluence_id: 'page-1',
          title: 'Test Page',
          space_key: 'DEV',
          body_text: 'Some text content for search',
          rank: 0.5,
        }],
      });
      // analytics insert
      mocks.mockQuery.mockResolvedValue({ rows: [] });

      const results = await hybridSearch('user-1', 'test query');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].pageTitle).toBe('Test Page');
    });

    it('should re-throw CircuitBreakerOpenError instead of falling back', async () => {
      const cbError = new CircuitBreakerOpenError('LLM server temporarily unavailable');
      mocks.mockProviderGenerateEmbedding.mockRejectedValue(cbError);
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

      // keyword search is started concurrently but the CB error should still propagate
      mocks.mockQuery.mockResolvedValue({ rows: [] });

      await expect(hybridSearch('user-1', 'test query')).rejects.toThrow(
        'LLM server temporarily unavailable',
      );
    });

    it('should record keyword_fallback search type when embedding fails', async () => {
      mocks.mockProviderGenerateEmbedding.mockRejectedValue(new Error('Ollama unreachable'));
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

      // keyword search returns results
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [{
          page_id: 1,
          confluence_id: 'page-1',
          title: 'Fallback Page',
          space_key: 'DEV',
          body_text: 'Fallback content',
          rank: 0.4,
        }],
      });
      // analytics insert
      mocks.mockQuery.mockResolvedValue({ rows: [] });

      await hybridSearch('user-1', 'test query');

      // Find the analytics INSERT call
      const analyticsCalls = mocks.mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes('search_analytics'),
      );
      expect(analyticsCalls.length).toBeGreaterThanOrEqual(1);
      // The 5th parameter should be 'keyword_fallback'
      const analyticsParams = analyticsCalls[0][1] as unknown[];
      expect(analyticsParams[4]).toBe('keyword_fallback');
    });

    it('should record hybrid search type when both vector and keyword succeed', async () => {
      const fakeEmbedding = new Array(1024).fill(0.1);
      mocks.mockProviderGenerateEmbedding.mockResolvedValue([[...fakeEmbedding]]);
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({
        rows: [{
          page_id: 1,
          confluence_id: 'page-1',
          chunk_text: 'Vector result content',
          metadata: { page_title: 'Vector Page', section_title: 'Intro', space_key: 'DEV' },
          distance: 0.2,
        }],
      }); // vector SELECT
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      // keyword search returns results
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [{
          page_id: 2,
          confluence_id: 'page-2',
          title: 'Keyword Page',
          space_key: 'DEV',
          body_text: 'Keyword content',
          rank: 0.5,
        }],
      });
      // analytics insert
      mocks.mockQuery.mockResolvedValue({ rows: [] });

      await hybridSearch('user-1', 'test query');

      // Find the analytics INSERT call
      const analyticsCalls = mocks.mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes('search_analytics'),
      );
      expect(analyticsCalls.length).toBeGreaterThanOrEqual(1);
      const analyticsParams = analyticsCalls[0][1] as unknown[];
      expect(analyticsParams[4]).toBe('hybrid');
    });
  });

  describe('reciprocalRankFusion', () => {
    // Deterministic pageId from confluence id string so the same id always
    // produces the same pageId (needed for RRF merge key).
    const idMap = new Map<string, number>();
    let nextId = 1;
    const stablePageId = (id: string): number => {
      if (!idMap.has(id)) idMap.set(id, nextId++);
      return idMap.get(id)!;
    };
    const makeResult = (id: string, chunk: string, overrides?: Partial<SearchResult>): SearchResult => ({
      pageId: stablePageId(id),
      confluenceId: id,
      chunkText: chunk,
      pageTitle: `Page ${id}`,
      sectionTitle: `Section ${id}`,
      spaceKey: 'DEV',
      score: 0.5,
      ...overrides,
    });

    it('should combine results from vector and keyword search', () => {
      const vectorResults = [makeResult('page-1', 'Vector chunk 1'), makeResult('page-2', 'Vector chunk 2')];
      const keywordResults = [makeResult('page-3', 'Keyword chunk 3'), makeResult('page-1', 'Keyword chunk 1')];
      const combined = reciprocalRankFusion(vectorResults, keywordResults);
      expect(combined).toHaveLength(3);
    });

    it('should boost results that appear in both searches (even with different chunkText)', () => {
      const vectorChunk = 'Specific embedding chunk about Redis configuration options';
      const keywordChunk = 'First 500 chars of the full page body text about Redis...';
      const combined = reciprocalRankFusion(
        [makeResult('page-1', vectorChunk)],
        [makeResult('page-1', keywordChunk)],
      );
      const singleSource = reciprocalRankFusion(
        [makeResult('page-1', vectorChunk)],
        [],
      );
      // Same page from both methods must produce a higher combined RRF score
      expect(combined).toHaveLength(1);
      expect(combined[0].score).toBeGreaterThan(singleSource[0].score);
    });

    it('should always prefer vector chunk over keyword body text as representative', () => {
      // Vector chunks are purpose-built for LLM context; keyword results return raw body text.
      // Even if keyword ts_rank were numerically larger (different scale), vector chunk wins.
      const vectorResult = makeResult('page-1', 'High quality embedding chunk', { score: 0.9 });
      const keywordResult = makeResult('page-1', 'First 500 chars of body text', { score: 0.3 });
      const combined = reciprocalRankFusion([vectorResult], [keywordResult]);
      expect(combined).toHaveLength(1);
      expect(combined[0].chunkText).toBe('High quality embedding chunk');
    });

    it('should prefer vector chunk even when keyword score is numerically higher', () => {
      // ts_rank and cosine similarity are on different scales — never compare across methods.
      // Vector chunk always wins as the representative for LLM context.
      const vectorResult = makeResult('page-1', 'Low similarity chunk', { score: 0.2 });
      const keywordResult = makeResult('page-1', 'Highly relevant body text', { score: 0.8 });
      const combined = reciprocalRankFusion([vectorResult], [keywordResult]);
      expect(combined).toHaveLength(1);
      expect(combined[0].chunkText).toBe('Low similarity chunk');
    });

    it('should merge multiple vector chunks for the same page', () => {
      // Vector search can return multiple chunks from the same page
      const chunk1 = makeResult('page-1', 'First chunk from page', { score: 0.7 });
      const chunk2 = makeResult('page-1', 'Second chunk from page', { score: 0.9 });
      const keywordResult = makeResult('page-1', 'Body text of page', { score: 0.3 });
      const combined = reciprocalRankFusion([chunk1, chunk2], [keywordResult]);
      // All three entries for page-1 should merge into a single entry
      expect(combined).toHaveLength(1);
      // Representative should be the chunk with highest individual score (0.9)
      expect(combined[0].chunkText).toBe('Second chunk from page');
    });

    it('should handle empty vector results (keyword-only fallback)', () => {
      const keywordResults = [makeResult('page-1', 'Keyword result 1'), makeResult('page-2', 'Keyword result 2')];
      const combined = reciprocalRankFusion([], keywordResults);
      expect(combined).toHaveLength(2);
    });

    it('should handle both empty', () => {
      expect(reciprocalRankFusion([], [])).toHaveLength(0);
    });

    it('should sort by RRF score descending', () => {
      const vectorResults = [makeResult('page-a', 'Chunk A'), makeResult('page-b', 'Chunk B')];
      const keywordResults = [makeResult('page-b', 'Chunk B')]; // page-b in both
      const combined = reciprocalRankFusion(vectorResults, keywordResults);
      for (let i = 1; i < combined.length; i++) {
        expect(combined[i - 1].score).toBeGreaterThanOrEqual(combined[i].score);
      }
    });

    it('should not collapse standalone pages that share NULL confluenceId', () => {
      // Two standalone pages both have null confluenceId but distinct pageIds
      const standalone1: SearchResult = {
        pageId: 100,
        confluenceId: '',   // NULL from DB becomes empty string
        chunkText: 'Standalone article one',
        pageTitle: 'Article One',
        sectionTitle: 'Article One',
        spaceKey: null,
        score: 0.5,
      };
      const standalone2: SearchResult = {
        pageId: 200,
        confluenceId: '',   // same empty confluenceId
        chunkText: 'Standalone article two',
        pageTitle: 'Article Two',
        sectionTitle: 'Article Two',
        spaceKey: null,
        score: 0.5,
      };
      const combined = reciprocalRankFusion([], [standalone1, standalone2]);
      // Both should survive because RRF key uses pageId, not confluenceId
      expect(combined).toHaveLength(2);
    });
  });

  // ── Newly exported functions ────────────────────────────────────────────────

  describe('keywordSearch (exported)', () => {
    beforeEach(() => {
      vi.resetAllMocks();
      mocks.mockPool.connect.mockResolvedValue(mocks.mockClient);
      mocks.mockToSql.mockReturnValue('[0.1,0.2]');
    });

    it('returns empty array when query is empty', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      const results = await keywordSearch('user-1', '   ');
      expect(results).toEqual([]);
      // query() should NOT have been called
      expect(mocks.mockQuery).not.toHaveBeenCalled();
    });

    it('calls query() with plainto_tsquery parameterized SQL', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      mocks.mockQuery.mockResolvedValueOnce({ rows: [] });

      await keywordSearch('user-1', 'redis caching', 5);

      expect(mocks.mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mocks.mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('plainto_tsquery');
      expect(sql).toContain('pages cp');
      expect(params).toContain('redis caching');
      expect(params).toContain(5);
    });

    it('maps result rows to SearchResult shape', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [
          {
            page_id: 42,
            confluence_id: 'PAGE-42',
            title: 'Redis Overview',
            space_key: 'DEV',
            body_text: 'First 500 chars of body text here.',
            rank: 0.75,
          },
        ],
      });

      const results = await keywordSearch('user-1', 'redis', 10);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        pageId: 42,
        confluenceId: 'PAGE-42',
        pageTitle: 'Redis Overview',
        spaceKey: 'DEV',
        score: 0.75,
      });
      expect(results[0].chunkText).toBe('First 500 chars of body text here.');
    });
  });

  describe('vectorSearch (exported)', () => {
    beforeEach(() => {
      vi.resetAllMocks();
      mocks.mockPool.connect.mockResolvedValue(mocks.mockClient);
      mocks.mockClient.release.mockResolvedValue(undefined);
      mocks.mockToSql.mockReturnValue('[0.1,0.2]');
    });

    it('uses BEGIN/SET LOCAL/COMMIT transaction pattern', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({ rows: [] }); // SELECT
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      await vectorSearch('user-1', new Array(1024).fill(0.1), 5);

      const queries = mocks.mockClientQuery.mock.calls.map((c: unknown[]) => c[0]);
      expect(queries[0]).toBe('BEGIN');
      expect(queries[1]).toMatch(/SET LOCAL hnsw.ef_search/);
      expect(queries[3]).toBe('COMMIT');
    });

    it('maps result rows to SearchResult shape with similarity score', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({
        rows: [
          {
            page_id: 7,
            confluence_id: 'PAGE-7',
            chunk_text: 'Sample chunk content',
            metadata: { page_title: 'Vector Page', section_title: 'Intro', space_key: 'DEV' },
            distance: 0.3,
          },
        ],
      }); // SELECT
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      const results = await vectorSearch('user-1', new Array(1024).fill(0.1), 5);
      expect(results).toHaveLength(1);
      expect(results[0].pageId).toBe(7);
      expect(results[0].score).toBeCloseTo(0.7); // 1 - 0.3
      expect(results[0].chunkText).toBe('Sample chunk content');
    });

    it('calls client.release() even on error', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockRejectedValueOnce(new Error('DB exploded')); // SELECT
      // ROLLBACK
      mocks.mockClientQuery.mockResolvedValueOnce(undefined);

      await expect(vectorSearch('user-1', new Array(1024).fill(0.1))).rejects.toThrow('DB exploded');
      expect(mocks.mockClient.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('recordSearchAnalytics (exported)', () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    it('calls query() with INSERT INTO search_analytics', async () => {
      mocks.mockQuery.mockResolvedValueOnce({ rows: [] });

      await recordSearchAnalytics('user-1', 'my query', 5, 0.9, 'keyword');

      expect(mocks.mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mocks.mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO search_analytics');
      expect(params).toContain('user-1');
      expect(params).toContain('my query');
      expect(params).toContain(5);
      expect(params).toContain('keyword');
    });

    it('swallows errors without throwing', async () => {
      mocks.mockQuery.mockRejectedValueOnce(new Error('analytics table gone'));

      // Should NOT throw
      await expect(recordSearchAnalytics('user-1', 'test', 0, null, 'hybrid')).resolves.toBeUndefined();
    });
  });
});
