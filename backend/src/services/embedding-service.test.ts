import { describe, it, expect, vi, beforeEach } from 'vitest';

const FAKE_LOCK_ID = 'fake-lock-id-for-tests';

// Hoisted mocks must be declared before any vi.mock() calls
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  providerGenerateEmbedding: vi.fn(),
  htmlToText: vi.fn(),
  toSql: vi.fn().mockReturnValue('[0.1,0.2]'),
  acquireEmbeddingLock: vi.fn().mockResolvedValue('fake-lock-id-for-tests'),
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
  htmlToText: mocks.htmlToText,
}));

vi.mock('pgvector', () => ({
  default: { toSql: mocks.toSql },
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

import { getEmbeddingStatus, chunkText, processDirtyPages, isProcessingUser, computePageRelationships, DIRTY_PAGE_BATCH_SIZE } from './embedding-service.js';

/** Helper to create a fake dirty page row */
function makePage(id: string) {
  return {
    confluence_id: id,
    title: `Page ${id}`,
    space_key: 'DEV',
    body_html: `<p>Content for ${id}</p>`,
  };
}

describe('embedding-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: lock is available (returns a lock identifier)
    mocks.acquireEmbeddingLock.mockResolvedValue(FAKE_LOCK_ID);
    mocks.releaseEmbeddingLock.mockResolvedValue(undefined);
    mocks.isEmbeddingLocked.mockResolvedValue(false);
    // Default: htmlToText returns non-trivial text so embedPage proceeds
    mocks.htmlToText.mockReturnValue('Some substantial page content for embedding that is long enough');
    // Default: providerGenerateEmbedding returns one embedding vector per text
    mocks.providerGenerateEmbedding.mockImplementation((_userId: string, texts: string[]) =>
      Promise.resolve(texts.map(() => new Array(768).fill(0.1))),
    );
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
      mocks.acquireEmbeddingLock.mockResolvedValue(null);

      const result = await processDirtyPages('concurrent-user');
      expect(result.alreadyProcessing).toBe(true);
      expect(result.processed).toBe(0);
      expect(result.errors).toBe(0);

      // Should not have called releaseEmbeddingLock since lock was never acquired
      expect(mocks.releaseEmbeddingLock).not.toHaveBeenCalled();
    });

    it('should acquire lock before processing and release with lock ID in finally', async () => {
      // COUNT query (no dirty pages)
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });

      await processDirtyPages('lock-user');

      expect(mocks.acquireEmbeddingLock).toHaveBeenCalledWith('lock-user');
      expect(mocks.releaseEmbeddingLock).toHaveBeenCalledWith('lock-user', FAKE_LOCK_ID);
    });

    it('should release lock with lock ID even when processing throws', async () => {
      // COUNT query throws
      mocks.query.mockRejectedValueOnce(new Error('DB connection lost'));

      await expect(processDirtyPages('crash-user')).rejects.toThrow('DB connection lost');

      expect(mocks.acquireEmbeddingLock).toHaveBeenCalledWith('crash-user');
      expect(mocks.releaseEmbeddingLock).toHaveBeenCalledWith('crash-user', FAKE_LOCK_ID);
    });

    it('should return early with {0,0} when no dirty pages exist', async () => {
      mocks.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }); // COUNT query

      const result = await processDirtyPages('user-1');

      expect(result).toEqual({ processed: 0, errors: 0 });
      // Should only have called the COUNT query, no batch SELECT
      expect(mocks.query).toHaveBeenCalledTimes(1);
    });

    it('should process a small batch of pages (fewer than batch size)', async () => {
      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '3' }] });
      // Batch SELECT returns 3 pages
      const pages = [makePage('p1'), makePage('p2'), makePage('p3')];
      mocks.query.mockResolvedValueOnce({ rows: pages });
      // For each page: mark embedding, DELETE old, INSERT, UPDATE dirty=false
      for (let i = 0; i < 3; i++) {
        mocks.query.mockResolvedValueOnce({ rows: [] }); // UPDATE embedding_status='embedding'
        mocks.query.mockResolvedValueOnce({ rows: [] }); // DELETE old embeddings
        mocks.query.mockResolvedValueOnce({ rows: [] }); // INSERT embedding chunk
        mocks.query.mockResolvedValueOnce({ rows: [] }); // UPDATE embedding_dirty=FALSE
      }
      // Empty batch -> break (batch was < DIRTY_PAGE_BATCH_SIZE so no more needed)
      // computePageRelationships (post-embed hook)
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE relationships
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // embedding similarity
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // label overlap

      const result = await processDirtyPages('user-1');

      expect(result).toEqual({ processed: 3, errors: 0 });
    });

    it('should use LIMIT and OFFSET in the batch query', async () => {
      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
      // Batch SELECT returns 1 page
      mocks.query.mockResolvedValueOnce({ rows: [makePage('p1')] });
      // embedPage calls and everything else
      mocks.query.mockResolvedValue({ rows: [] });

      await processDirtyPages('user-1');

      // Second query call (index 1) is the batch SELECT after COUNT
      const calls = mocks.query.mock.calls;
      const batchSelectCall = calls[1];
      expect(batchSelectCall[0]).toContain('LIMIT');
      expect(batchSelectCall[0]).toContain('OFFSET');
      expect(batchSelectCall[1]).toEqual(['user-1', DIRTY_PAGE_BATCH_SIZE, 0]);
    });

    it('should process dirty pages and return counts', async () => {
      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
      // Batch SELECT with 1 page
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
      // embedPage calls: insert embedding
      mocks.query.mockResolvedValueOnce({ rows: [] });
      // embedPage calls: mark page as embedded + clear error
      mocks.query.mockResolvedValueOnce({ rows: [] });
      // computePageRelationships calls (post-embed hook):
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE existing relationships
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // INSERT embedding_similarity edges
      mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // INSERT label_overlap edges

      const result = await processDirtyPages('process-user');
      expect(result.processed).toBe(1);
      expect(result.errors).toBe(0);
      expect(result.alreadyProcessing).toBeUndefined();
    });

    it('should store error message when embedding fails', async () => {
      const embeddingError = new Error('Model nomic-embed-text not found');

      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
      // Batch SELECT with 1 page
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
      // Next batch: offset advanced by 1 (batchErrors), returns empty -> break
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

      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
      // Batch SELECT with 1 page
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
      // Empty batch -> break (offset advanced past this page)
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
      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
      // Batch SELECT with 1 page
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
      // embedPage calls: insert embedding
      mocks.query.mockResolvedValueOnce({ rows: [] });
      // embedPage calls: mark page as embedded + clear error
      mocks.query.mockResolvedValueOnce({ rows: [] });
      // computePageRelationships
      mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await processDirtyPages('recover-user');

      // Verify the success update clears embedding_error
      const successUpdateCall = mocks.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes("embedding_status = 'embedded'"),
      );
      expect(successUpdateCall).toBeDefined();
      expect(successUpdateCall![0]).toContain('embedding_error = NULL');
    });

    it('should count errors and advance offset only by error count', async () => {
      const pages = [makePage('p1'), makePage('fail-1'), makePage('p3')];

      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '3' }] });
      // Batch SELECT (all 3 pages, < batch size so only one batch)
      mocks.query.mockResolvedValueOnce({ rows: pages });
      // embedPage for p1: mark embedding + DELETE + INSERT + UPDATE
      mocks.query.mockResolvedValueOnce({ rows: [] }); // mark embedding
      mocks.query.mockResolvedValueOnce({ rows: [] }); // DELETE
      mocks.query.mockResolvedValueOnce({ rows: [] }); // INSERT
      mocks.query.mockResolvedValueOnce({ rows: [] }); // UPDATE
      // embedPage for fail-1: mark embedding + DELETE, then throw; failed update
      mocks.query.mockResolvedValueOnce({ rows: [] }); // mark embedding
      mocks.query.mockResolvedValueOnce({ rows: [] }); // DELETE
      mocks.query.mockResolvedValueOnce({ rows: [] }); // failed update
      // embedPage for p3: mark embedding + DELETE + INSERT + UPDATE
      mocks.query.mockResolvedValueOnce({ rows: [] }); // mark embedding
      mocks.query.mockResolvedValueOnce({ rows: [] }); // DELETE
      mocks.query.mockResolvedValueOnce({ rows: [] }); // INSERT
      mocks.query.mockResolvedValueOnce({ rows: [] }); // UPDATE
      // computePageRelationships (post-embed hook)
      mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });

      // Make embedPage fail for fail-1 by failing the embedding generation
      let embedCallCount = 0;
      mocks.providerGenerateEmbedding.mockImplementation(() => {
        embedCallCount++;
        if (embedCallCount === 2) {
          return Promise.reject(new Error('Ollama timeout'));
        }
        return Promise.resolve([new Array(768).fill(0.1)]);
      });

      const result = await processDirtyPages('user-1');

      expect(result).toEqual({ processed: 2, errors: 1 });
    });

    it('should terminate when all pages in a batch error (no infinite loop)', async () => {
      // All pages fail
      mocks.providerGenerateEmbedding.mockRejectedValue(new Error('Ollama down'));

      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '2' }] });
      // Batch 1: 2 pages
      mocks.query.mockResolvedValueOnce({ rows: [makePage('f1'), makePage('f2')] });
      // embedPage for f1: mark embedding + DELETE then throw; failed update
      mocks.query.mockResolvedValueOnce({ rows: [] }); // mark embedding
      mocks.query.mockResolvedValueOnce({ rows: [] }); // DELETE
      mocks.query.mockResolvedValueOnce({ rows: [] }); // failed update
      // embedPage for f2: mark embedding + DELETE then throw; failed update
      mocks.query.mockResolvedValueOnce({ rows: [] }); // mark embedding
      mocks.query.mockResolvedValueOnce({ rows: [] }); // DELETE
      mocks.query.mockResolvedValueOnce({ rows: [] }); // failed update
      // Next batch query: offset=2 (both errored), returns empty -> done
      mocks.query.mockResolvedValueOnce({ rows: [] });

      const result = await processDirtyPages('user-1');

      expect(result).toEqual({ processed: 0, errors: 2 });
    });

    it('should pass correct LIMIT value matching DIRTY_PAGE_BATCH_SIZE constant', () => {
      expect(DIRTY_PAGE_BATCH_SIZE).toBe(100);
    });
  });
});

describe('chunkText', () => {
  it('should produce a single chunk for short text', () => {
    const chunks = chunkText('Hello world, this is a test.', 'Test Page', 'DEV', 'page-1');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata).toEqual({
      page_title: 'Test Page',
      section_title: 'Test Page',
      space_key: 'DEV',
      confluence_id: 'page-1',
    });
  });

  it('should split on heading boundaries', () => {
    const text = '# Introduction\nSome intro text.\n\n# Details\nMore details here.';
    const chunks = chunkText(text, 'My Doc', 'SPACE', 'doc-1');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].metadata.section_title).toBe('Introduction');
    expect(chunks[1].metadata.section_title).toBe('Details');
  });

  it('should return empty array for empty text', () => {
    const chunks = chunkText('', 'Empty', 'DEV', 'empty-1');
    expect(chunks).toHaveLength(0);
  });
});
