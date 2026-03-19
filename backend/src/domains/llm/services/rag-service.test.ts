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

import { buildRagContext, hybridSearch, RAG_EF_SEARCH, reciprocalRankFusion } from './rag-service.js';
import type { SearchResult } from './rag-service.js';

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
  });

  describe('buildRagContext', () => {
    it('should return "no context" message for empty results', () => {
      const context = buildRagContext([]);
      expect(context).toBe('No relevant context found in the knowledge base.');
    });

    it('should format a single result', () => {
      const results: SearchResult[] = [
        {
          confluenceId: 'page-1',
          pageId: 1,
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
          confluenceId: 'page-1',
          pageId: 1,
          chunkText: 'First chunk.',
          pageTitle: 'Page 1',
          sectionTitle: 'Section A',
          spaceKey: 'DEV',
          score: 0.9,
        },
        {
          confluenceId: 'page-2',
          pageId: 2,
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
        confluenceId: `page-${i}`,
        pageId: i + 1,
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
          confluenceId: 'standalone-1',
          pageId: 10,
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
          confluenceId: 'page-1',
          pageId: 1,
          chunkText: 'Confluence content.',
          pageTitle: 'Confluence Page',
          sectionTitle: 'Intro',
          spaceKey: 'DEV',
          score: 0.9,
        },
        {
          confluenceId: 'standalone-1',
          pageId: 2,
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

  describe('reciprocalRankFusion', () => {
    it('should rank a result appearing in both vector and keyword results higher than one in only one list', () => {
      // sharedChunk is > 100 chars to test that the 100-char slice still identifies the same chunk
      const sharedChunk = 'This is shared content between vector and keyword search results that appears in both lists. It has more than one hundred characters total.';
      const vectorResults: SearchResult[] = [
        {
          pageId: 1,
          confluenceId: 'page-1',
          chunkText: sharedChunk,
          pageTitle: 'Shared Page',
          sectionTitle: 'Intro',
          spaceKey: 'DEV',
          score: 0.9,
        },
        {
          pageId: 2,
          confluenceId: 'page-2',
          chunkText: 'Only in vector results, not in keyword results at all.',
          pageTitle: 'Vector Only Page',
          sectionTitle: 'Body',
          spaceKey: 'DEV',
          score: 0.8,
        },
      ];
      const keywordResults: SearchResult[] = [
        {
          pageId: 1,
          confluenceId: 'page-1',
          chunkText: sharedChunk,
          pageTitle: 'Shared Page',
          sectionTitle: 'Intro',
          spaceKey: 'DEV',
          score: 0.7,
        },
        {
          pageId: 3,
          confluenceId: 'page-3',
          chunkText: 'Only in keyword results, not in vector results at all.',
          pageTitle: 'Keyword Only Page',
          sectionTitle: 'Conclusion',
          spaceKey: 'OPS',
          score: 0.6,
        },
      ];

      const combined = reciprocalRankFusion(vectorResults, keywordResults);

      // The shared result (page-1) should rank first as it has double RRF score
      expect(combined[0].confluenceId).toBe('page-1');
      expect(combined[0].pageId).toBe(1);
      // All 3 unique chunks (by confluenceId:chunkText key) should appear
      expect(combined.length).toBe(3);
    });

    it('should sort results by descending RRF score', () => {
      const v: SearchResult[] = [
        { pageId: 1, confluenceId: 'a', chunkText: 'alpha', pageTitle: 'A', sectionTitle: 'A', spaceKey: 'S', score: 1 },
        { pageId: 2, confluenceId: 'b', chunkText: 'beta', pageTitle: 'B', sectionTitle: 'B', spaceKey: 'S', score: 0.5 },
      ];
      const k: SearchResult[] = [
        { pageId: 1, confluenceId: 'a', chunkText: 'alpha', pageTitle: 'A', sectionTitle: 'A', spaceKey: 'S', score: 0.8 },
      ];

      const combined = reciprocalRankFusion(v, k);
      // Result 'a' appears in both → higher RRF score → first
      expect(combined[0].confluenceId).toBe('a');
      // Scores should be descending
      for (let i = 0; i < combined.length - 1; i++) {
        expect(combined[i].score).toBeGreaterThanOrEqual(combined[i + 1].score);
      }
    });

    it('should return empty array when both inputs are empty', () => {
      expect(reciprocalRankFusion([], [])).toEqual([]);
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
      // providerGenerateEmbedding returns one 768-dim vector
      const fakeEmbedding = new Array(768).fill(0.1);
      mocks.mockProviderGenerateEmbedding.mockResolvedValue([[...fakeEmbedding]]);

      // getUserAccessibleSpaces
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

      // vectorSearch uses pool.connect → BEGIN → SET LOCAL → main SELECT
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({ rows: [] }); // main vector SELECT (empty)
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      // keywordSearch uses query() — return empty
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
      const fakeEmbedding = new Array(768).fill(0.1);
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

    it('should fall back to keyword-only results when embedding generation throws', async () => {
      // Arrange: embedding fails
      mocks.mockProviderGenerateEmbedding.mockRejectedValue(new Error('Circuit breaker open'));
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

      // Keyword search returns one matching result
      mocks.mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              confluence_id: 'page-kw-1',
              page_id: 42,
              title: 'Keyword Result Page',
              space_key: 'DEV',
              body_text: 'Keyword match content here.',
              rank: 0.5,
            },
          ],
        })
        // analytics insert
        .mockResolvedValue({ rows: [] });

      // Act
      const results = await hybridSearch('user-1', 'keyword only query');

      // Assert: should resolve (no throw) with keyword results
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].pageId).toBe(42);
      expect(results[0].chunkText).toBe('Keyword match content here.');
      // vectorSearch must NOT have been called (no pool.connect calls)
      expect(mocks.mockPool.connect).not.toHaveBeenCalled();
    });

    it('should deduplicate results by pageId regardless of confluenceId (standalone pages with NULL confluenceId)', async () => {
      // Arrange: two vector results with the same page_id but different chunk text
      const fakeEmbedding = new Array(768).fill(0.1);
      mocks.mockProviderGenerateEmbedding.mockResolvedValue([[...fakeEmbedding]]);
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue([]);

      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({
        rows: [
          {
            page_id: 99,
            confluence_id: null,
            chunk_text: 'First chunk from the standalone page content.',
            metadata: { page_title: 'My Standalone Article', section_title: 'Part A', space_key: null },
            distance: 0.1,
          },
          {
            page_id: 99, // same page_id — should be deduped
            confluence_id: null,
            chunk_text: 'Second chunk from the exact same standalone page with different text.',
            metadata: { page_title: 'My Standalone Article', section_title: 'Part B', space_key: null },
            distance: 0.2,
          },
        ],
      }); // vector SELECT
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      // Keyword search empty, analytics empty
      mocks.mockQuery.mockResolvedValue({ rows: [] });

      // Act
      const results = await hybridSearch('user-1', 'standalone query', 5);

      // Assert: despite two vector results with the same pageId, only one deduped result
      expect(results).toHaveLength(1);
      expect(results[0].pageId).toBe(99);
      // The first (higher-scored) chunk should win
      expect(results[0].chunkText).toBe('First chunk from the standalone page content.');
    });
  });
});
