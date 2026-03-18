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

import { buildRagContext, hybridSearch, RAG_EF_SEARCH } from './rag-service.js';
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
          chunkText: 'First chunk.',
          pageTitle: 'Page 1',
          sectionTitle: 'Section A',
          spaceKey: 'DEV',
          score: 0.9,
        },
        {
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
          confluenceId: 'page-1',
          chunkText: 'Confluence content.',
          pageTitle: 'Confluence Page',
          sectionTitle: 'Intro',
          spaceKey: 'DEV',
          score: 0.9,
        },
        {
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
  });
});
