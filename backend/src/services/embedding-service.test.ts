import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  providerGenerateEmbedding: vi.fn(),
}));

vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => mocks.query(...args),
}));

vi.mock('./llm-provider.js', () => ({
  providerGenerateEmbedding: mocks.providerGenerateEmbedding,
}));

vi.mock('./content-converter.js', () => ({
  htmlToText: vi.fn().mockReturnValue('plain text content for embedding'),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getEmbeddingStatus, chunkText, processDirtyPages, isProcessingUser, computePageRelationships } from './embedding-service.js';

describe('embedding-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getEmbeddingStatus', () => {
    it('should return all status fields including embeddedPages', async () => {
      mocks.query
        .mockResolvedValueOnce({ rows: [{ count: '50' }] })   // totalPages
        .mockResolvedValueOnce({ rows: [{ count: '3' }] })    // dirtyPages
        .mockResolvedValueOnce({ rows: [{ count: '200' }] })  // totalEmbeddings (chunks)
        .mockResolvedValueOnce({ rows: [{ count: '47' }] });  // embeddedPages (DISTINCT)

      const status = await getEmbeddingStatus('user-1');

      expect(status).toEqual({
        totalPages: 50,
        embeddedPages: 47,
        dirtyPages: 3,
        totalEmbeddings: 200,
        isProcessing: false,
      });
    });

    it('should query COUNT(DISTINCT confluence_id) for embeddedPages', async () => {
      mocks.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });

      await getEmbeddingStatus('user-1');

      // Fourth query should be the DISTINCT count
      expect(mocks.query).toHaveBeenCalledTimes(4);
      const fourthCallSql = mocks.query.mock.calls[3][0] as string;
      expect(fourthCallSql).toContain('COUNT(DISTINCT confluence_id)');
      expect(fourthCallSql).toContain('page_embeddings');
    });

    it('should return zeros when user has no data', async () => {
      mocks.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });

      const status = await getEmbeddingStatus('user-1');

      expect(status.totalPages).toBe(0);
      expect(status.embeddedPages).toBe(0);
      expect(status.dirtyPages).toBe(0);
      expect(status.totalEmbeddings).toBe(0);
      expect(status.isProcessing).toBe(false);
    });

    it('should pass userId to all queries', async () => {
      mocks.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });

      await getEmbeddingStatus('test-user-42');

      for (const call of mocks.query.mock.calls) {
        expect(call[1]).toEqual(['test-user-42']);
      }
    });
  });

  describe('chunkText', () => {
    it('should create a single chunk for short text', () => {
      const chunks = chunkText('Hello world', 'Title', 'SPACE', 'conf-1');
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe('Hello world');
      expect(chunks[0].metadata).toEqual({
        page_title: 'Title',
        section_title: 'Title',
        space_key: 'SPACE',
        confluence_id: 'conf-1',
      });
    });

    it('should skip empty text', () => {
      const chunks = chunkText('', 'Title', 'SPACE', 'conf-1');
      expect(chunks).toHaveLength(0);
    });

    it('should split on heading boundaries', () => {
      const text = '## Section One\nSome content here.\n## Section Two\nMore content here.';
      const chunks = chunkText(text, 'Title', 'SPACE', 'conf-1');
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0].metadata.section_title).toBe('Section One');
      expect(chunks[1].metadata.section_title).toBe('Section Two');
    });
  });

  describe('isProcessingUser', () => {
    it('should return false when no processing is active', () => {
      expect(isProcessingUser('nobody')).toBe(false);
    });
  });

  describe('computePageRelationships', () => {
    it('should delete existing relationships then compute new ones', async () => {
      // DELETE existing relationships
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // INSERT embedding_similarity edges (CTE query)
      mocks.query.mockResolvedValueOnce({
        rows: [
          { page_id_1: 'page-1', page_id_2: 'page-2', score: 0.85 },
        ],
        rowCount: 1,
      });
      // INSERT label_overlap edges (CTE query)
      mocks.query.mockResolvedValueOnce({
        rows: [
          { page_id_1: 'page-1', page_id_2: 'page-3', score: 0.5 },
        ],
        rowCount: 1,
      });

      const totalEdges = await computePageRelationships('user-1');

      expect(totalEdges).toBe(2);
      expect(mocks.query).toHaveBeenCalledTimes(3);

      // First call should be DELETE
      const deleteCall = mocks.query.mock.calls[0][0] as string;
      expect(deleteCall).toContain('DELETE FROM page_relationships');
      expect(mocks.query.mock.calls[0][1]).toEqual(['user-1']);
    });

    it('should pass userId to all queries', async () => {
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // embedding similarity
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // label overlap

      await computePageRelationships('test-user-99');

      // First param of each call should include the userId
      expect(mocks.query.mock.calls[0][1]).toEqual(['test-user-99']);
      expect(mocks.query.mock.calls[1][1]).toContain('test-user-99');
      expect(mocks.query.mock.calls[2][1]).toContain('test-user-99');
    });

    it('should return 0 when no relationships found', async () => {
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // embedding similarity
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // label overlap

      const totalEdges = await computePageRelationships('user-1');

      expect(totalEdges).toBe(0);
    });

    it('should use parameterized SQL (no string concatenation)', async () => {
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await computePageRelationships('user-1');

      // All queries should use parameterized placeholders ($1, $2, etc.)
      for (const call of mocks.query.mock.calls) {
        const sql = call[0] as string;
        expect(sql).toContain('$1');
        expect(call[1]).toBeDefined();
      }
    });
  });

  describe('processDirtyPages', () => {
    it('should return alreadyProcessing when called concurrently for the same user', async () => {
      // First call: long-running processing (deferred)
      let resolveQuery!: (value: { rows: never[] }) => void;
      mocks.query.mockReturnValueOnce(
        new Promise((resolve) => { resolveQuery = resolve; }),
      );

      const firstCall = processDirtyPages('concurrent-user');

      // Second call while first is still running
      const result = await processDirtyPages('concurrent-user');
      expect(result.alreadyProcessing).toBe(true);
      expect(result.processed).toBe(0);
      expect(result.errors).toBe(0);

      // Clean up: resolve the first call
      resolveQuery({ rows: [] });
      await firstCall;
    });

    it('should process dirty pages and return counts', async () => {
      // Query to get dirty pages
      mocks.query.mockResolvedValueOnce({
        rows: [{
          confluence_id: 'page-1',
          title: 'Test Page',
          space_key: 'DEV',
          body_html: '<p>Some content for embedding</p>',
        }],
      });

      // Mark page as embedding
      mocks.query.mockResolvedValueOnce({ rows: [] });

      // embedPage calls: delete old embeddings
      mocks.query.mockResolvedValueOnce({ rows: [] });

      // embedPage calls: providerGenerateEmbedding (mocked)
      mocks.providerGenerateEmbedding.mockResolvedValueOnce([new Array(768).fill(0)]);

      // embedPage calls: insert embedding
      mocks.query.mockResolvedValueOnce({ rows: [] });

      // embedPage calls: mark page as not dirty
      mocks.query.mockResolvedValueOnce({ rows: [] });

      // computePageRelationships calls (post-embed hook):
      // DELETE existing relationships
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // INSERT embedding_similarity edges
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // INSERT label_overlap edges
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await processDirtyPages('process-user');
      expect(result.processed).toBe(1);
      expect(result.errors).toBe(0);
      expect(result.alreadyProcessing).toBeUndefined();
    });
  });
});
