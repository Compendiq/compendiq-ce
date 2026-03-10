import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  providerGenerateEmbedding: vi.fn(),
  acquireEmbeddingLock: vi.fn().mockResolvedValue(true),
  releaseEmbeddingLock: vi.fn().mockResolvedValue(undefined),
  isEmbeddingLocked: vi.fn().mockResolvedValue(false),
  invalidateGraphCache: vi.fn().mockResolvedValue(undefined),
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

vi.mock('./redis-cache.js', () => ({
  acquireEmbeddingLock: (...args: unknown[]) => mocks.acquireEmbeddingLock(...args),
  releaseEmbeddingLock: (...args: unknown[]) => mocks.releaseEmbeddingLock(...args),
  isEmbeddingLocked: (...args: unknown[]) => mocks.isEmbeddingLocked(...args),
  invalidateGraphCache: (...args: unknown[]) => mocks.invalidateGraphCache(...args),
}));

import { getEmbeddingStatus, chunkText, processDirtyPages, isProcessingUser, computePageRelationships } from './embedding-service.js';

describe('embedding-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: lock is available
    mocks.acquireEmbeddingLock.mockResolvedValue(true);
    mocks.releaseEmbeddingLock.mockResolvedValue(undefined);
    mocks.isEmbeddingLocked.mockResolvedValue(false);
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

    it('should report isProcessing=true when Redis lock is held', async () => {
      mocks.isEmbeddingLocked.mockResolvedValue(true);
      mocks.query
        .mockResolvedValueOnce({ rows: [{ count: '10' }] })
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })
        .mockResolvedValueOnce({ rows: [{ count: '50' }] })
        .mockResolvedValueOnce({ rows: [{ count: '8' }] });

      const status = await getEmbeddingStatus('locked-user');

      expect(status.isProcessing).toBe(true);
      expect(mocks.isEmbeddingLocked).toHaveBeenCalledWith('locked-user');
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
    it('should return false when no processing is active', async () => {
      mocks.isEmbeddingLocked.mockResolvedValue(false);
      expect(await isProcessingUser('nobody')).toBe(false);
    });

    it('should return true when Redis lock is held', async () => {
      mocks.isEmbeddingLocked.mockResolvedValue(true);
      expect(await isProcessingUser('busy-user')).toBe(true);
      expect(mocks.isEmbeddingLocked).toHaveBeenCalledWith('busy-user');
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
    it('should return alreadyProcessing when lock cannot be acquired', async () => {
      mocks.acquireEmbeddingLock.mockResolvedValue(false);

      const result = await processDirtyPages('concurrent-user');
      expect(result.alreadyProcessing).toBe(true);
      expect(result.processed).toBe(0);
      expect(result.errors).toBe(0);

      // Should not have called releaseEmbeddingLock since lock was never acquired
      expect(mocks.releaseEmbeddingLock).not.toHaveBeenCalled();
    });

    it('should acquire lock before processing and release in finally', async () => {
      // Query to get dirty pages (no pages)
      mocks.query.mockResolvedValueOnce({ rows: [] });

      await processDirtyPages('lock-user');

      expect(mocks.acquireEmbeddingLock).toHaveBeenCalledWith('lock-user');
      expect(mocks.releaseEmbeddingLock).toHaveBeenCalledWith('lock-user');
    });

    it('should release lock even when processing throws', async () => {
      // Query to get dirty pages throws
      mocks.query.mockRejectedValueOnce(new Error('DB connection lost'));

      await expect(processDirtyPages('crash-user')).rejects.toThrow('DB connection lost');

      expect(mocks.acquireEmbeddingLock).toHaveBeenCalledWith('crash-user');
      expect(mocks.releaseEmbeddingLock).toHaveBeenCalledWith('crash-user');
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

      // Mark page as 'embedding' + clear error
      mocks.query.mockResolvedValueOnce({ rows: [] });

      // embedPage calls: delete old embeddings
      mocks.query.mockResolvedValueOnce({ rows: [] });

      // embedPage calls: providerGenerateEmbedding (mocked)
      mocks.providerGenerateEmbedding.mockResolvedValueOnce([new Array(768).fill(0)]);

      // embedPage calls: insert embedding
      mocks.query.mockResolvedValueOnce({ rows: [] });

      // embedPage calls: mark page as embedded + clear error
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

    it('should store error message when embedding fails', async () => {
      const embeddingError = new Error('Model nomic-embed-text not found');

      // Query to get dirty pages
      mocks.query.mockResolvedValueOnce({
        rows: [{
          confluence_id: 'page-fail',
          title: 'Failing Page',
          space_key: 'DEV',
          body_html: '<p>Content that will fail</p>',
        }],
      });

      // Mark page as 'embedding' + clear error
      mocks.query.mockResolvedValueOnce({ rows: [] });

      // embedPage calls: delete old embeddings
      mocks.query.mockResolvedValueOnce({ rows: [] });

      // embedPage calls: providerGenerateEmbedding throws
      mocks.providerGenerateEmbedding.mockRejectedValueOnce(embeddingError);

      // Update embedding_status to 'failed' with error message
      mocks.query.mockResolvedValueOnce({ rows: [] });

      const result = await processDirtyPages('error-user');
      expect(result.processed).toBe(0);
      expect(result.errors).toBe(1);

      // Verify the failed status update includes the error message
      const failedUpdateCall = mocks.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes("embedding_status = 'failed'"),
      );
      expect(failedUpdateCall).toBeDefined();
      expect(failedUpdateCall![0]).toContain('embedding_error');
      expect(failedUpdateCall![1]).toContain('Model nomic-embed-text not found');
    });

    it('should truncate long error messages to 1000 characters', async () => {
      const longMessage = 'x'.repeat(2000);
      const longError = new Error(longMessage);

      // Query to get dirty pages
      mocks.query.mockResolvedValueOnce({
        rows: [{
          confluence_id: 'page-long-err',
          title: 'Long Error Page',
          space_key: 'DEV',
          body_html: '<p>Content</p>',
        }],
      });

      // Mark page as 'embedding' + clear error
      mocks.query.mockResolvedValueOnce({ rows: [] });

      // embedPage calls: delete old embeddings
      mocks.query.mockResolvedValueOnce({ rows: [] });

      // embedPage calls: providerGenerateEmbedding throws
      mocks.providerGenerateEmbedding.mockRejectedValueOnce(longError);

      // Update embedding_status to 'failed' with truncated error
      mocks.query.mockResolvedValueOnce({ rows: [] });

      await processDirtyPages('truncate-user');

      const failedUpdateCall = mocks.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes("embedding_status = 'failed'"),
      );
      expect(failedUpdateCall).toBeDefined();
      // The error message in params should be truncated to 1000 chars
      const storedError = failedUpdateCall![1][2] as string;
      expect(storedError).toHaveLength(1000);
    });

    it('should clear error when embedding succeeds after previous failure', async () => {
      // Query to get dirty pages
      mocks.query.mockResolvedValueOnce({
        rows: [{
          confluence_id: 'page-recover',
          title: 'Recovering Page',
          space_key: 'DEV',
          body_html: '<p>Content that will succeed this time</p>',
        }],
      });

      // Mark page as 'embedding' + clear error
      mocks.query.mockResolvedValueOnce({ rows: [] });

      // embedPage calls: delete old embeddings
      mocks.query.mockResolvedValueOnce({ rows: [] });

      // embedPage calls: providerGenerateEmbedding succeeds
      mocks.providerGenerateEmbedding.mockResolvedValueOnce([new Array(768).fill(0)]);

      // embedPage calls: insert embedding
      mocks.query.mockResolvedValueOnce({ rows: [] });

      // embedPage calls: mark page as embedded + clear error
      mocks.query.mockResolvedValueOnce({ rows: [] });

      await processDirtyPages('recover-user');

      // Verify the success update clears embedding_error
      const successUpdateCall = mocks.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes("embedding_status = 'embedded'"),
      );
      expect(successUpdateCall).toBeDefined();
      expect(successUpdateCall![0]).toContain('embedding_error = NULL');
    });
  });
});
