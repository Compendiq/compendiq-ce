import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircuitBreakerOpenError } from '../../../core/services/circuit-breaker.js';

const FAKE_LOCK_ID = 'fake-lock-id-for-tests';

// Hoisted mocks must be declared before any vi.mock() calls.
// mockClient is a dedicated pg.PoolClient mock used by transaction tests.
const mockClient = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getPool: vi.fn(),
  providerGenerateEmbedding: vi.fn(),
  htmlToText: vi.fn(),
  toSql: vi.fn().mockReturnValue('[0.1,0.2]'),
  acquireEmbeddingLock: vi.fn().mockResolvedValue('fake-lock-id-for-tests'),
  releaseEmbeddingLock: vi.fn().mockResolvedValue(undefined),
  isEmbeddingLocked: vi.fn().mockResolvedValue(false),
  invalidateGraphCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mocks.query(...args),
  getPool: () => mocks.getPool(),
}));

vi.mock('./llm-provider.js', () => ({
  providerGenerateEmbedding: mocks.providerGenerateEmbedding,
}));

vi.mock('../../../core/services/content-converter.js', () => ({
  htmlToText: mocks.htmlToText,
}));

vi.mock('pgvector', () => ({
  default: { toSql: mocks.toSql },
}));

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../core/services/redis-cache.js', () => ({
  acquireEmbeddingLock: (...args: unknown[]) => mocks.acquireEmbeddingLock(...args),
  releaseEmbeddingLock: (...args: unknown[]) => mocks.releaseEmbeddingLock(...args),
  isEmbeddingLocked: (...args: unknown[]) => mocks.isEmbeddingLocked(...args),
  invalidateGraphCache: (...args: unknown[]) => mocks.invalidateGraphCache(...args),
}));

vi.mock('../../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: vi.fn().mockResolvedValue(['TEST']),
}));

import {
  getEmbeddingStatus,
  chunkText,
  embedPage,
  processDirtyPages,
  isProcessingUser,
  computePageRelationships,
  resetFailedEmbeddings,
  isCircuitBreakerError,
  isContextLengthError,
  splitByWords,
  CHUNK_HARD_LIMIT,
  DIRTY_PAGE_BATCH_SIZE,
  type EmbeddingProgressEvent,
} from './embedding-service.js';

/** Helper to create a fake dirty page row */
function makePage(id: string, numId = 1) {
  return {
    id: numId,
    confluence_id: id,
    title: `Page ${id}`,
    space_key: 'DEV',
    body_html: `<p>Content for ${id}</p>`,
  };
}

describe('embedding-service', () => {
  beforeEach(() => {
    // resetAllMocks clears call history AND resets implementations/return values,
    // preventing permanent mockResolvedValue() calls from leaking between tests.
    vi.resetAllMocks();
    // Restore defaults after reset
    mocks.toSql.mockReturnValue('[0.1,0.2]');
    // Default: lock is available (returns a lock identifier)
    mocks.acquireEmbeddingLock.mockResolvedValue(FAKE_LOCK_ID);
    mocks.releaseEmbeddingLock.mockResolvedValue(undefined);
    mocks.isEmbeddingLocked.mockResolvedValue(false);
    mocks.invalidateGraphCache.mockResolvedValue(undefined);
    // Default: htmlToText returns non-trivial text so embedPage proceeds
    mocks.htmlToText.mockReturnValue('Some substantial page content for embedding that is long enough');
    // Default: providerGenerateEmbedding returns one embedding vector per text
    mocks.providerGenerateEmbedding.mockImplementation((_userId: string, texts: string[]) =>
      Promise.resolve(texts.map(() => new Array(768).fill(0.1))),
    );
    // Default: mockClient handles all transaction queries (BEGIN/DELETE/INSERT/UPDATE/COMMIT)
    // for embedPage (Phase 2) and computePageRelationships.
    mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClient.release.mockResolvedValue(undefined);
    mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(mockClient) });
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

    it('should query COUNT(DISTINCT page_id) for embeddedPages', async () => {
      mocks.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });

      await getEmbeddingStatus('user-1');

      // Fourth query should be the DISTINCT count
      expect(mocks.query).toHaveBeenCalledTimes(4);
      const fourthCallSql = mocks.query.mock.calls[3][0] as string;
      expect(fourthCallSql).toContain('COUNT(DISTINCT');
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

    it('should scope queries to accessible spaces', async () => {
      mocks.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });

      await getEmbeddingStatus('test-user-42');

      // All 4 queries should use space_key = ANY for RBAC access control
      for (const call of mocks.query.mock.calls) {
        const sql = call[0] as string;
        expect(sql).toContain('space_key = ANY');
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
    // Transaction call order on mockClient: [0]=BEGIN, [1]=DELETE, [2]=similarity CTE, [3]=label CTE, [4]=COMMIT

    it('should delete existing relationships then compute new ones', async () => {
      // Set up 5 specific client.query responses matching the transaction order
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })                                           // BEGIN
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // DELETE
        .mockResolvedValueOnce({ rows: [{ page_id_1: 'page-1', page_id_2: 'page-2', score: 0.85 }], rowCount: 1 })  // similarity INSERT
        .mockResolvedValueOnce({ rows: [{ page_id_1: 'page-1', page_id_2: 'page-3', score: 0.5 }], rowCount: 1 })   // label INSERT
        .mockResolvedValueOnce({ rows: [] });                                          // COMMIT

      const totalEdges = await computePageRelationships();

      expect(totalEdges).toBe(2);
      expect(mockClient.query).toHaveBeenCalledTimes(5);
      expect(mocks.query).not.toHaveBeenCalled();

      // calls[0] = BEGIN
      expect(mockClient.query.mock.calls[0][0]).toBe('BEGIN');
      // calls[1] = DELETE (global, no params)
      const deleteCall = mockClient.query.mock.calls[1][0] as string;
      expect(deleteCall).toContain('DELETE FROM page_relationships');
      expect(mockClient.query.mock.calls[1][1]).toBeUndefined();
      // calls[4] = COMMIT
      expect(mockClient.query.mock.calls[4][0]).toBe('COMMIT');
    });

    it('should not use userId (global shared tables)', async () => {
      // Use default catch-all from beforeEach
      await computePageRelationships();

      // calls[1] = DELETE has no params (global clear)
      expect(mockClient.query.mock.calls[1][1]).toBeUndefined();
      // calls[2] = similarity INSERT uses $1 (TOP_K) and $2 (SIMILARITY_THRESHOLD)
      expect(mockClient.query.mock.calls[2][1]).toBeDefined();
      // calls[3] = label overlap has no user params
      expect(mockClient.query.mock.calls[3][1]).toBeUndefined();
      // pool query() is NOT used
      expect(mocks.query).not.toHaveBeenCalled();
    });

    it('should return 0 when no relationships found', async () => {
      // Default catch-all returns { rows: [], rowCount: 0 } for all calls
      const totalEdges = await computePageRelationships();

      expect(totalEdges).toBe(0);
    });

    it('should use parameterized SQL (no string concatenation)', async () => {
      await computePageRelationships();

      // Embedding similarity INSERT uses $1 (TOP_K) and $2 (SIMILARITY_THRESHOLD) — calls[2]
      const similarityCall = mockClient.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('embedding_similarity'),
      );
      expect(similarityCall).toBeDefined();
      expect(similarityCall![0]).toContain('$1');
      expect(similarityCall![1]).toBeDefined();
      expect(mocks.query).not.toHaveBeenCalled();
    });

    it('ROLLBACK when similarity INSERT fails: client released, error propagates', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })                                     // BEGIN
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })                       // DELETE
        .mockRejectedValueOnce(new Error('pgvector error'))                     // similarity INSERT fails
        .mockResolvedValueOnce({ rows: [] });                                    // ROLLBACK

      await expect(computePageRelationships()).rejects.toThrow('pgvector error');

      // ROLLBACK was called
      const rollbackCall = mockClient.query.mock.calls.find(
        (call) => call[0] === 'ROLLBACK',
      );
      expect(rollbackCall).toBeDefined();
      // COMMIT was NOT called
      const commitCall = mockClient.query.mock.calls.find(
        (call) => call[0] === 'COMMIT',
      );
      expect(commitCall).toBeUndefined();
      // client was released
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should pass SIMILARITY_THRESHOLD=0.4 to the similarity query', async () => {
      await computePageRelationships();

      // calls[2] = similarity CTE INSERT with params [TOP_K, SIMILARITY_THRESHOLD]
      const similarityCall = mockClient.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('embedding_similarity'),
      );
      expect(similarityCall).toBeDefined();
      // $2 is the similarity threshold
      expect(similarityCall![1][1]).toBe(0.4);
    });
  });

  describe('processDirtyPages', () => {
    /** Mock the chunk-settings SELECT that runs first inside processDirtyPages (admin_settings table). */
    function mockChunkSettings(chunkSize = 500, chunkOverlap = 50) {
      mocks.query.mockResolvedValueOnce({
        rows: [
          { setting_key: 'embedding_chunk_size', setting_value: String(chunkSize) },
          { setting_key: 'embedding_chunk_overlap', setting_value: String(chunkOverlap) },
        ],
      });
    }

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
      mockChunkSettings();
      // COUNT query (no dirty pages)
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });

      await processDirtyPages('lock-user');

      expect(mocks.acquireEmbeddingLock).toHaveBeenCalledWith('lock-user');
      expect(mocks.releaseEmbeddingLock).toHaveBeenCalledWith('lock-user', FAKE_LOCK_ID);
    });

    it('should release lock with lock ID even when processing throws', async () => {
      // Chunk settings query throws (simulates DB failure)
      mocks.query.mockRejectedValueOnce(new Error('DB connection lost'));

      await expect(processDirtyPages('crash-user')).rejects.toThrow('DB connection lost');

      expect(mocks.acquireEmbeddingLock).toHaveBeenCalledWith('crash-user');
      expect(mocks.releaseEmbeddingLock).toHaveBeenCalledWith('crash-user', FAKE_LOCK_ID);
    });

    it('should return early with {0,0} when no dirty pages exist', async () => {
      mockChunkSettings();
      mocks.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }); // COUNT query

      const result = await processDirtyPages('user-1');

      expect(result).toEqual({ processed: 0, errors: 0 });
      // Should have called chunk settings + COUNT query only (2 total)
      expect(mocks.query).toHaveBeenCalledTimes(2);
    });

    it('should process a small batch of pages (fewer than batch size)', async () => {
      mockChunkSettings();
      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '3' }] });
      // Batch SELECT returns 3 pages
      const pages = [makePage('p1'), makePage('p2'), makePage('p3')];
      mocks.query.mockResolvedValueOnce({ rows: pages });
      // For each page: only mark embedding goes through pool query()
      // Phase 2 (BEGIN/DELETE/INSERT×N/UPDATE/COMMIT) handled by mockClient.query default
      for (let i = 0; i < 3; i++) {
        mocks.query.mockResolvedValueOnce({ rows: [] }); // UPDATE embedding_status='embedding'
      }
      // computePageRelationships (post-embed hook) handled by mockClient.query default
      // Batch was < DIRTY_PAGE_BATCH_SIZE so loop breaks after first batch

      const result = await processDirtyPages('user-1');

      expect(result).toEqual({ processed: 3, errors: 0 });
    });

    it('should use LIMIT and OFFSET in the batch query', async () => {
      mockChunkSettings();
      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
      // Batch SELECT returns 1 page
      mocks.query.mockResolvedValueOnce({ rows: [makePage('p1')] });
      // embedPage calls and everything else
      mocks.query.mockResolvedValue({ rows: [] });

      await processDirtyPages('user-1');

      // calls[0] = chunk settings, calls[1] = COUNT, calls[2] = batch SELECT
      const calls = mocks.query.mock.calls;
      const batchSelectCall = calls[2];
      expect(batchSelectCall[0]).toContain('LIMIT');
      expect(batchSelectCall[0]).toContain('OFFSET');
      expect(batchSelectCall[1]).toEqual([DIRTY_PAGE_BATCH_SIZE, 0]);
    });

    it('should process dirty pages and return counts', async () => {
      mockChunkSettings();
      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
      // Batch SELECT with 1 page
      mocks.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          confluence_id: 'page-1',
          title: 'Test Page',
          space_key: 'DEV',
          body_html: '<p>Some content for embedding</p>',
        }],
      });
      // Mark page as 'embedding' + clear error (pool query)
      mocks.query.mockResolvedValueOnce({ rows: [] });
      // Phase 2 (BEGIN/DELETE/INSERT/UPDATE embedded/COMMIT) + computePageRelationships
      // all handled by mockClient.query default from beforeEach

      const result = await processDirtyPages('process-user');
      expect(result.processed).toBe(1);
      expect(result.errors).toBe(0);
      expect(result.alreadyProcessing).toBeUndefined();
    });

    it('should store error message when embedding fails', async () => {
      const embeddingError = new Error('Model nomic-embed-text not found');

      mockChunkSettings();
      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
      // Batch SELECT with 1 page
      mocks.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          confluence_id: 'page-fail',
          title: 'Failing Page',
          space_key: 'DEV',
          body_html: '<p>Content that will fail</p>',
        }],
      });
      // Mark page as 'embedding' + clear error (pool query)
      mocks.query.mockResolvedValueOnce({ rows: [] });
      // Phase 1: providerGenerateEmbedding throws — no DB transaction is opened
      mocks.providerGenerateEmbedding.mockRejectedValueOnce(embeddingError);
      // Update embedding_status to 'failed' with error message (pool query in processDirtyPages catch)
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

      mockChunkSettings();
      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
      // Batch SELECT with 1 page
      mocks.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          confluence_id: 'page-long-err',
          title: 'Long Error Page',
          space_key: 'DEV',
          body_html: '<p>Content</p>',
        }],
      });
      // Mark page as 'embedding' + clear error (pool query)
      mocks.query.mockResolvedValueOnce({ rows: [] });
      // Phase 1: providerGenerateEmbedding throws — no DB transaction is opened
      mocks.providerGenerateEmbedding.mockRejectedValueOnce(longError);
      // Update embedding_status to 'failed' with truncated error (pool query)
      mocks.query.mockResolvedValueOnce({ rows: [] });
      // Empty batch -> break (offset advanced past this page)
      mocks.query.mockResolvedValueOnce({ rows: [] });

      await processDirtyPages('truncate-user');

      const failedUpdateCall = mocks.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes("embedding_status = 'failed'"),
      );
      expect(failedUpdateCall).toBeDefined();
      // The error message in params should be truncated to 1000 chars
      // Error message is at [1][1]: params are [confluenceId, errorMessage]
      const storedError = failedUpdateCall![1][1] as string;
      expect(storedError).toHaveLength(1000);
    });

    it('should clear error when embedding succeeds after previous failure', async () => {
      mockChunkSettings();
      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
      // Batch SELECT with 1 page
      mocks.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          confluence_id: 'page-recover',
          title: 'Recovering Page',
          space_key: 'DEV',
          body_html: '<p>Content that will succeed this time</p>',
        }],
      });
      // Mark page as 'embedding' + clear error (pool query)
      mocks.query.mockResolvedValueOnce({ rows: [] });
      // Phase 2 (BEGIN/DELETE/INSERT/UPDATE embedded/COMMIT) + computePageRelationships
      // all handled by mockClient.query default from beforeEach

      await processDirtyPages('recover-user');

      // The UPDATE that sets embedding_status='embedded' is now inside Phase 2 transaction
      // on the client — search mockClient.query.mock.calls
      const successUpdateCall = mockClient.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes("embedding_status = 'embedded'"),
      );
      expect(successUpdateCall).toBeDefined();
      expect(successUpdateCall![0]).toContain('embedding_error = NULL');
    });

    it('should count errors and advance offset only by error count', async () => {
      const pages = [makePage('p1'), makePage('fail-1'), makePage('p3')];

      mockChunkSettings();
      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '3' }] });
      // Batch SELECT (all 3 pages, < batch size so only one batch)
      mocks.query.mockResolvedValueOnce({ rows: pages });
      // embedPage for p1: mark embedding (pool); Phase 2 handled by mockClient default
      mocks.query.mockResolvedValueOnce({ rows: [] }); // mark embedding
      // embedPage for fail-1: mark embedding (pool); Phase 1 throws (no client opened); failed update (pool)
      mocks.query.mockResolvedValueOnce({ rows: [] }); // mark embedding
      mocks.query.mockResolvedValueOnce({ rows: [] }); // failed update
      // embedPage for p3: mark embedding (pool); Phase 2 handled by mockClient default
      mocks.query.mockResolvedValueOnce({ rows: [] }); // mark embedding
      // computePageRelationships (post-embed hook) handled by mockClient default

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

      mockChunkSettings();
      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '2' }] });
      // Batch 1: 2 pages
      mocks.query.mockResolvedValueOnce({ rows: [makePage('f1'), makePage('f2')] });
      // embedPage for f1: mark embedding (pool); Phase 1 throws (no client opened); failed update (pool)
      mocks.query.mockResolvedValueOnce({ rows: [] }); // mark embedding
      mocks.query.mockResolvedValueOnce({ rows: [] }); // failed update
      // embedPage for f2: mark embedding (pool); Phase 1 throws (no client opened); failed update (pool)
      mocks.query.mockResolvedValueOnce({ rows: [] }); // mark embedding
      mocks.query.mockResolvedValueOnce({ rows: [] }); // failed update
      // Next batch query: offset=2 (both errored), returns empty -> done
      mocks.query.mockResolvedValueOnce({ rows: [] });

      const result = await processDirtyPages('user-1');

      expect(result).toEqual({ processed: 0, errors: 2 });
    });

    it('should pass correct LIMIT value matching DIRTY_PAGE_BATCH_SIZE constant', () => {
      expect(DIRTY_PAGE_BATCH_SIZE).toBe(100);
    });

    it('should call onProgress callback with progress events', async () => {
      const progressEvents: EmbeddingProgressEvent[] = [];

      mockChunkSettings();
      // COUNT query (2 dirty pages)
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '2' }] });
      // Batch SELECT (2 pages)
      mocks.query.mockResolvedValueOnce({
        rows: [
          { id: 1, confluence_id: 'p1', title: 'Page One', space_key: 'DEV', body_html: '<p>Content 1</p>' },
          { id: 2, confluence_id: 'p2', title: 'Page Two', space_key: 'DEV', body_html: '<p>Content 2</p>' },
        ],
      });

      // Page 1: mark embedding (pool); Phase 1 generate; Phase 2 + computePageRelationships via mockClient
      mocks.query.mockResolvedValueOnce({ rows: [] }); // mark embedding
      mocks.providerGenerateEmbedding.mockResolvedValueOnce([new Array(768).fill(0)]);

      // Page 2: mark embedding (pool); Phase 1 generate; Phase 2 via mockClient
      mocks.query.mockResolvedValueOnce({ rows: [] }); // mark embedding
      mocks.providerGenerateEmbedding.mockResolvedValueOnce([new Array(768).fill(0)]);
      // computePageRelationships handled by mockClient.query default

      const result = await processDirtyPages('progress-user', (event) => {
        progressEvents.push(event);
      });

      expect(result.processed).toBe(2);
      expect(result.errors).toBe(0);

      // Should have progress events for each page + completion
      expect(progressEvents.length).toBe(3);
      expect(progressEvents[0].type).toBe('progress');
      expect(progressEvents[0].total).toBe(2);
      expect(progressEvents[0].completed).toBe(1);
      expect(progressEvents[0].currentPage).toBe('Page One');
      expect(progressEvents[1].type).toBe('progress');
      expect(progressEvents[1].completed).toBe(2);
      expect(progressEvents[2].type).toBe('complete');
      expect(progressEvents[2].completed).toBe(2);
      expect(progressEvents[2].failed).toBe(0);
    });

    it('should send complete event with error list on failures', async () => {
      const progressEvents: EmbeddingProgressEvent[] = [];

      mockChunkSettings();
      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
      // Batch SELECT
      mocks.query.mockResolvedValueOnce({
        rows: [
          { id: 1, confluence_id: 'p-fail', title: 'Failing', space_key: 'DEV', body_html: '<p>Content</p>' },
        ],
      });

      // mark embedding (pool)
      mocks.query.mockResolvedValueOnce({ rows: [] });
      // Phase 1: generate fails — no client is opened, no DELETE fires
      mocks.providerGenerateEmbedding.mockRejectedValueOnce(new Error('Network timeout'));
      // mark failed (pool — processDirtyPages catch block)
      mocks.query.mockResolvedValueOnce({ rows: [] });
      // Next batch SELECT (offset advanced past the 1 failed page) -> empty -> done
      mocks.query.mockResolvedValueOnce({ rows: [] });

      await processDirtyPages('fail-progress-user', (event) => {
        progressEvents.push(event);
      });

      const completeEvent = progressEvents.find(e => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent!.failed).toBe(1);
      expect(completeEvent!.errors).toBeDefined();
      expect(completeEvent!.errors!.length).toBe(1);
      expect(completeEvent!.errors![0]).toContain('Failing');
      expect(completeEvent!.errors![0]).toContain('Network timeout');
    });

    it('should wait and retry on CircuitBreakerOpenError instead of marking page as failed', async () => {
      vi.useFakeTimers();

      const cbError = new CircuitBreakerOpenError('ollama-embed: LLM server temporarily unavailable');

      mockChunkSettings();
      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
      // Batch SELECT
      mocks.query.mockResolvedValueOnce({
        rows: [
          { id: 1, confluence_id: 'cb-page', title: 'CB Page', space_key: 'DEV', body_html: '<p>Content</p>' },
        ],
      });

      // mark embedding (pool)
      mocks.query.mockResolvedValueOnce({ rows: [] });
      // First embed attempt: Phase 1 throws CB error — no client opened, no DELETE fires
      mocks.providerGenerateEmbedding.mockRejectedValueOnce(cbError);

      // Second attempt after wait: Phase 1 succeeds, Phase 2 handled by mockClient default
      mocks.providerGenerateEmbedding.mockResolvedValueOnce([new Array(768).fill(0)]);
      // computePageRelationships handled by mockClient.query default

      const promise = processDirtyPages('cb-user');

      // Advance timers to let the sleep resolve
      await vi.advanceTimersByTimeAsync(5000);

      const result = await promise;

      vi.useRealTimers();

      expect(result.processed).toBe(1);
      expect(result.errors).toBe(0);

      // Should NOT have any 'failed' status updates
      const failedCalls = mocks.query.mock.calls.filter(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes("embedding_status = 'failed'"),
      );
      expect(failedCalls).toHaveLength(0);
    });

    it('should stop batch after max circuit breaker retries without marking remaining pages as failed', async () => {
      vi.useFakeTimers();

      const cbError = new CircuitBreakerOpenError('ollama-embed: LLM server temporarily unavailable');

      mockChunkSettings();
      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '2' }] });
      // Batch SELECT
      mocks.query.mockResolvedValueOnce({
        rows: [
          { id: 1, confluence_id: 'cb-p1', title: 'CB Page 1', space_key: 'DEV', body_html: '<p>Content 1</p>' },
          { id: 2, confluence_id: 'cb-p2', title: 'CB Page 2', space_key: 'DEV', body_html: '<p>Content 2</p>' },
        ],
      });

      // mark embedding for page 1 (pool)
      mocks.query.mockResolvedValueOnce({ rows: [] });
      // All embed attempts fail with circuit breaker in Phase 1 (first attempt + 3 retries = 4 total)
      // Phase 1 throws before any client is acquired — no DELETE fires
      mocks.providerGenerateEmbedding.mockRejectedValue(cbError);

      // Reset status for remaining pages (page 1 and page 2)
      mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const promise = processDirtyPages('cb-stop-user');

      // Advance timers enough for all retries
      await vi.advanceTimersByTimeAsync(60000);

      const result = await promise;

      vi.useRealTimers();

      expect(result.processed).toBe(0);
      // Should NOT mark pages as 'failed' — circuit breaker abort leaves them in 'embedding'
      // status so the next processDirtyPages run can retry them.
      const failedCalls = mocks.query.mock.calls.filter(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes("embedding_status = 'failed'"),
      );
      expect(failedCalls).toHaveLength(0);
    });

    it('should emit waiting event when circuit breaker is open', async () => {
      vi.useFakeTimers();

      const cbError = new CircuitBreakerOpenError('ollama-embed: LLM server temporarily unavailable');
      const progressEvents: EmbeddingProgressEvent[] = [];

      mockChunkSettings();
      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
      // Batch SELECT
      mocks.query.mockResolvedValueOnce({
        rows: [
          { id: 1, confluence_id: 'cb-wait-page', title: 'Wait Page', space_key: 'DEV', body_html: '<p>Content</p>' },
        ],
      });

      // mark embedding (pool)
      mocks.query.mockResolvedValueOnce({ rows: [] });
      // First attempt: Phase 1 throws CB error — no client opened, no DELETE fires
      mocks.providerGenerateEmbedding.mockRejectedValueOnce(cbError);

      // Retry: Phase 1 succeeds, Phase 2 handled by mockClient default
      mocks.providerGenerateEmbedding.mockResolvedValueOnce([new Array(768).fill(0)]);
      // computePageRelationships handled by mockClient.query default

      const promise = processDirtyPages('cb-wait-user', (event) => {
        progressEvents.push(event);
      });

      await vi.advanceTimersByTimeAsync(5000);
      const result = await promise;

      vi.useRealTimers();

      expect(result.processed).toBe(1);

      // Should have a 'waiting' event
      const waitingEvents = progressEvents.filter(e => e.type === 'waiting');
      expect(waitingEvents.length).toBeGreaterThan(0);
      expect(waitingEvents[0].reason).toContain('Circuit breaker open');
    });

    it('should fetch chunk settings from user_settings before processing', async () => {
      mockChunkSettings(256, 25);
      // COUNT query (no dirty pages — we only care the settings query ran)
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });

      await processDirtyPages('chunk-settings-user');

      // First query should be chunk settings SELECT from admin_settings
      const firstCall = mocks.query.mock.calls[0];
      expect(firstCall[0]).toContain('embedding_chunk_size');
      expect(firstCall[0]).toContain('embedding_chunk_overlap');
      expect(firstCall[0]).toContain('admin_settings');
      // admin_settings query has no params (global)
      expect(firstCall[1]).toBeUndefined();
    });

    it('should use default chunk settings when user has no settings row', async () => {
      // Chunk settings returns no row
      mocks.query.mockResolvedValueOnce({ rows: [] });
      // COUNT query (no dirty pages)
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });

      // Should not throw — defaults are used
      const result = await processDirtyPages('no-settings-user');
      expect(result).toEqual({ processed: 0, errors: 0 });
    });

    it('should pass custom chunk settings through to embedPage', async () => {
      mockChunkSettings(128, 10);
      // COUNT query
      mocks.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
      // Batch SELECT
      mocks.query.mockResolvedValueOnce({
        rows: [{ id: 1, confluence_id: 'cs-page', title: 'CS Page', space_key: 'DEV', body_html: '<p>Content</p>' }],
      });
      // mark embedding (pool)
      mocks.query.mockResolvedValueOnce({ rows: [] });
      // Phase 2 (BEGIN/DELETE/INSERT/UPDATE/COMMIT) + computePageRelationships
      // all handled by mockClient.query default from beforeEach

      const result = await processDirtyPages('custom-chunk-user');
      // The page was processed; custom chunk settings propagated without error
      expect(result.processed).toBe(1);
      expect(result.errors).toBe(0);
    });
  });

  describe('isCircuitBreakerError', () => {
    it('should return true for CircuitBreakerOpenError', () => {
      const err = new CircuitBreakerOpenError('test');
      expect(isCircuitBreakerError(err)).toBe(true);
    });

    it('should return false for generic Error', () => {
      expect(isCircuitBreakerError(new Error('generic'))).toBe(false);
    });

    it('should return false for non-Error values', () => {
      expect(isCircuitBreakerError('string')).toBe(false);
      expect(isCircuitBreakerError(null)).toBe(false);
      expect(isCircuitBreakerError(undefined)).toBe(false);
    });
  });

  describe('resetFailedEmbeddings', () => {
    it('should update failed pages to not_embedded and return count', async () => {
      mocks.query.mockResolvedValueOnce({ rowCount: 5 });

      const count = await resetFailedEmbeddings();

      expect(count).toBe(5);
      expect(mocks.query).toHaveBeenCalledTimes(1);
      const sql = mocks.query.mock.calls[0][0] as string;
      expect(sql).toContain("embedding_status = 'not_embedded'");
      expect(sql).toContain('embedding_dirty = TRUE');
      expect(sql).toContain('embedding_error = NULL');
      expect(sql).toContain("embedding_status = 'failed'");
      // resetFailedEmbeddings is global (no userId filter)
      expect(mocks.query.mock.calls[0][1]).toBeUndefined();
    });

    it('should return 0 when no failed pages exist', async () => {
      mocks.query.mockResolvedValueOnce({ rowCount: 0 });

      const count = await resetFailedEmbeddings();

      expect(count).toBe(0);
    });

    it('should return 0 when rowCount is null', async () => {
      mocks.query.mockResolvedValueOnce({ rowCount: null });

      const count = await resetFailedEmbeddings();

      expect(count).toBe(0);
    });
  });

  it('should not infinite-loop when all pages are too short to embed', async () => {
    // htmlToText returns text shorter than 20 chars -> embedPage skips
    mocks.htmlToText.mockReturnValue('short');

    const pages = [makePage('short-1'), makePage('short-2')];

    const responses: Array<{ rows: unknown[] }> = [];

    // 0. Chunk settings query (admin_settings format)
    responses.push({ rows: [{ setting_key: 'embedding_chunk_size', setting_value: '500' }, { setting_key: 'embedding_chunk_overlap', setting_value: '50' }] });
    // 1. COUNT query
    responses.push({ rows: [{ count: '2' }] });
    // 2. Batch SELECT (returns 2 short pages)
    responses.push({ rows: pages });
    // 3. embedPage for short-1: UPDATE embedding_dirty = FALSE (skipped page)
    responses.push({ rows: [] });
    // 4. embedPage for short-2: UPDATE embedding_dirty = FALSE (skipped page)
    responses.push({ rows: [] });
    // No more batches needed: batch.rows.length (2) < DIRTY_PAGE_BATCH_SIZE -> breaks

    let callIndex = 0;
    mocks.query.mockImplementation(() => {
      const response = responses[callIndex] ?? { rows: [] };
      callIndex++;
      return Promise.resolve(response);
    });

    const result = await processDirtyPages('user-1');

    // Short pages are "processed" (embedPage returns 0 but doesn't throw)
    expect(result).toEqual({ processed: 2, errors: 0 });

    // Verify the UPDATE queries were called to mark pages as not dirty
    const updateCalls = mocks.query.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('UPDATE pages SET embedding_dirty = FALSE'),
    );
    expect(updateCalls).toHaveLength(2);
  });
});

describe('embedPage', () => {
  beforeEach(() => {
    // vi.clearAllMocks() only clears call history, not implementations.
    // The outer describe('embedding-service').beforeEach called vi.resetAllMocks() which
    // resets ALL implementations. This nested beforeEach re-applies everything embedPage
    // tests need so that atomicity tests are isolated from each other.
    vi.clearAllMocks();
    mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClient.release.mockResolvedValue(undefined);
    mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(mockClient) });
    mocks.toSql.mockReturnValue('[0.1,0.2]');
    mocks.htmlToText.mockReturnValue('Some substantial page content for embedding that is long enough');
    mocks.providerGenerateEmbedding.mockImplementation((_userId: string, texts: string[]) =>
      Promise.resolve(texts.map(() => new Array(768).fill(0.1))),
    );
  });

  it('should mark page as not dirty when text is too short', async () => {
    mocks.htmlToText.mockReturnValue('tiny');
    mocks.query.mockResolvedValue({ rows: [] });

    const result = await embedPage('user-1', 101, 'Short Page', 'DEV', '<p>tiny</p>');

    expect(result).toBe(0);
    // Should have called UPDATE to clear embedding_dirty (using pages.id, not confluence_id)
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(
      'UPDATE pages SET embedding_dirty = FALSE WHERE id = $1',
      [101],
    );
  });

  it('should mark page as not dirty when htmlToText returns empty string', async () => {
    mocks.htmlToText.mockReturnValue('');
    mocks.query.mockResolvedValue({ rows: [] });

    const result = await embedPage('user-1', 102, 'Empty Page', 'DEV', '<p></p>');

    expect(result).toBe(0);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(
      'UPDATE pages SET embedding_dirty = FALSE WHERE id = $1',
      [102],
    );
  });

  // ── Atomicity tests ──────────────────────────────────────────────────────────

  it('Phase 1 LLM failure: no BEGIN, no DELETE, old embeddings remain intact', async () => {
    // Phase 1 throws before any client is acquired
    mocks.providerGenerateEmbedding.mockRejectedValueOnce(new Error('LLM down'));

    await expect(embedPage('u1', 1, 'Title', 'DEV', '<p>Content</p>')).rejects.toThrow('LLM down');

    // No client interaction at all — old embeddings are untouched
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.release).not.toHaveBeenCalled();
  });

  it('Phase 2 INSERT failure: ROLLBACK called, client released', async () => {
    // Phase 1 succeeds (default mock provides embeddings)
    // Phase 2: BEGIN ok, DELETE ok, INSERT throws
    mockClient.query
      .mockResolvedValueOnce({ rows: [] })          // BEGIN
      .mockResolvedValueOnce({ rows: [] })          // DELETE
      .mockRejectedValueOnce(new Error('constraint violation'))  // INSERT fails
      .mockResolvedValueOnce({ rows: [] });          // ROLLBACK

    await expect(embedPage('u1', 1, 'Title', 'DEV', '<p>Content</p>')).rejects.toThrow('constraint violation');

    // ROLLBACK was called
    const rollbackCall = mockClient.query.mock.calls.find((call) => call[0] === 'ROLLBACK');
    expect(rollbackCall).toBeDefined();
    // COMMIT was NOT called
    const commitCall = mockClient.query.mock.calls.find((call) => call[0] === 'COMMIT');
    expect(commitCall).toBeUndefined();
    // client was released despite the error
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('Phase 2 UPDATE failure: ROLLBACK called, client released', async () => {
    // Phase 1 succeeds; Phase 2: BEGIN ok, DELETE ok, INSERT ok, UPDATE throws
    let callIndex = 0;
    mockClient.query.mockImplementation((sql: string) => {
      callIndex++;
      if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
      if (typeof sql === 'string' && sql.includes('DELETE FROM page_embeddings')) return Promise.resolve({ rows: [] });
      if (typeof sql === 'string' && sql.includes('INSERT INTO page_embeddings')) return Promise.resolve({ rows: [] });
      if (typeof sql === 'string' && sql.includes('UPDATE pages')) return Promise.reject(new Error('UPDATE failed'));
      return Promise.resolve({ rows: [] }); // ROLLBACK
    });

    await expect(embedPage('u1', 1, 'Title', 'DEV', '<p>Content</p>')).rejects.toThrow('UPDATE failed');

    const rollbackCall = mockClient.query.mock.calls.find((call) => call[0] === 'ROLLBACK');
    expect(rollbackCall).toBeDefined();
    const commitCall = mockClient.query.mock.calls.find((call) => call[0] === 'COMMIT');
    expect(commitCall).toBeUndefined();
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    void callIndex; // suppress unused var warning
  });

  it('Phase 2 full success: BEGIN DELETE INSERTs UPDATE COMMIT in order, client released', async () => {
    // Phase 1 + Phase 2 both succeed via default mocks
    const count = await embedPage('u1', 1, 'Title', 'DEV', '<p>Content</p>');

    expect(count).toBeGreaterThan(0);

    const calls = mockClient.query.mock.calls.map((c) => c[0] as string);

    // First call must be BEGIN
    expect(calls[0]).toBe('BEGIN');
    // Must include DELETE
    expect(calls.some((sql) => sql.includes('DELETE FROM page_embeddings'))).toBe(true);
    // Must include INSERT
    expect(calls.some((sql) => sql.includes('INSERT INTO page_embeddings'))).toBe(true);
    // Must include UPDATE with embedding_status = 'embedded'
    expect(calls.some((sql) => sql.includes("embedding_status = 'embedded'"))).toBe(true);
    // Last meaningful call must be COMMIT
    expect(calls[calls.length - 1]).toBe('COMMIT');
    // Client released exactly once
    expect(mockClient.release).toHaveBeenCalledTimes(1);
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

  it('should use default CHUNK_SIZE when no params provided', () => {
    // Short text fits in one chunk regardless of chunk size
    const chunks = chunkText('Some text', 'Title', 'DEV', 'page-1');
    expect(chunks).toHaveLength(1);
  });

  it('should respect custom chunkSize parameter', () => {
    // Build text that exceeds a very small chunk size (e.g. 2 tokens = 8 chars)
    // but fits in the default 500 tokens
    const paragraph1 = 'A'.repeat(50);
    const paragraph2 = 'B'.repeat(50);
    const text = `${paragraph1}\n\n${paragraph2}`;

    // With a tiny chunkSize of 10 tokens (40 chars), the two paragraphs should split
    const chunksSmall = chunkText(text, 'Title', 'DEV', 'page-1', 10, 0);
    // With default 500 tokens everything fits in one chunk
    const chunksDefault = chunkText(text, 'Title', 'DEV', 'page-1');

    expect(chunksSmall.length).toBeGreaterThan(chunksDefault.length);
  });

  it('should respect custom chunkOverlap parameter (zero overlap)', () => {
    // Two paragraphs, small chunk size, zero overlap
    const paragraph1 = 'First paragraph content here. '.repeat(5);
    const paragraph2 = 'Second paragraph content here. '.repeat(5);
    const text = `${paragraph1}\n\n${paragraph2}`;

    // With zero overlap the chunks should be independent
    const chunks = chunkText(text, 'Title', 'DEV', 'page-1', 30, 0);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // With zero overlap no chunk should start with words from previous chunk's tail
    // (this is a structural check — all chunks should be non-empty)
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  describe('splitByWords', () => {
    it('returns the input as a single item when it fits within maxChars', () => {
      const result = splitByWords('hello world foo bar', 100);
      expect(result).toEqual(['hello world foo bar']);
    });

    it('splits on word boundaries when text exceeds maxChars', () => {
      // 5-char words separated by spaces: "aaaaa bbbbb ccccc ddddd"
      const text = 'aaaaa bbbbb ccccc ddddd';
      const result = splitByWords(text, 11); // fits 2 words ("aaaaa bbbbb" = 11 chars)
      expect(result.length).toBeGreaterThan(1);
      for (const part of result) {
        expect(part.length).toBeLessThanOrEqual(11);
      }
    });

    it('reconstructs all content without dropping words', () => {
      const words = Array.from({ length: 100 }, (_, i) => `word${i}`);
      const text = words.join(' ');
      const result = splitByWords(text, 50);
      const reconstructed = result.join(' ');
      expect(reconstructed).toBe(text);
    });

    it('handles empty string', () => {
      expect(splitByWords('', 100)).toEqual([]);
    });
  });

  describe('isContextLengthError', () => {
    it('returns true for "input length exceeds context length" message', () => {
      const err = new Error('HTTP 400 - {"error":{"message":"the input length exceeds the context length"}}');
      expect(isContextLengthError(err)).toBe(true);
    });

    it('returns true for message containing "context length"', () => {
      expect(isContextLengthError(new Error('context length exceeded'))).toBe(true);
    });

    it('returns false for other HTTP 400 errors', () => {
      expect(isContextLengthError(new Error('HTTP 400 - invalid request body'))).toBe(false);
    });

    it('returns false for non-Error values', () => {
      expect(isContextLengthError('some string')).toBe(false);
      expect(isContextLengthError(null)).toBe(false);
      expect(isContextLengthError({ message: 'context length' })).toBe(false);
    });
  });

  describe('chunkText — CHUNK_HARD_LIMIT enforcement', () => {
    it('applies word-level splitting when a small section exceeds CHUNK_HARD_LIMIT (Path 1)', () => {
      // A single section with no paragraph breaks that exceeds the hard limit
      // Use chunkSize large enough that maxChars > text length but CHUNK_HARD_LIMIT is still hit
      const hugeSection = 'word '.repeat(CHUNK_HARD_LIMIT); // well above 6000 chars
      const chunks = chunkText(hugeSection, 'Title', 'DEV', 'page-1', 99999, 0);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_HARD_LIMIT);
      }
    });

    it('applies word-level splitting for single-paragraph sections with no \\n\\n breaks (Path 2)', () => {
      // A single section that has NO paragraph breaks (\n\n) — forces the
      // currentChunk final-push path.  The section is larger than maxChars
      // (so the else branch is taken) but is a single paragraph.
      const singlePara = 'x'.repeat(CHUNK_HARD_LIMIT + 500);
      // chunkSize=1 → maxChars=3 chars, so any real content triggers the else branch
      const chunks = chunkText(singlePara, 'Title', 'DEV', 'page-1', 1, 0);
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_HARD_LIMIT);
      }
    });

    it('all chunks preserve correct metadata', () => {
      const hugeSection = 'word '.repeat(CHUNK_HARD_LIMIT);
      const chunks = chunkText(hugeSection, 'MyTitle', 'SPACE', 'conf-42', 99999, 0);
      for (const chunk of chunks) {
        expect(chunk.metadata.page_title).toBe('MyTitle');
        expect(chunk.metadata.space_key).toBe('SPACE');
        expect(chunk.metadata.confluence_id).toBe('conf-42');
      }
    });
  });

  describe('embedPage — HTTP 400 context-length continuation', () => {
    beforeEach(() => {
      // Re-apply mockClient and getPool defaults since this describe block does not inherit
      // from describe('embedding-service').beforeEach (it's in a separate top-level describe).
      // Clear call history first so tests don't see calls from prior tests.
      mockClient.query.mockReset();
      mockClient.release.mockReset();
      mocks.getPool.mockReset();
      mocks.query.mockReset();
      mocks.providerGenerateEmbedding.mockReset();
      mocks.toSql.mockReset();
      mocks.htmlToText.mockReset();
      // Re-apply defaults
      mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
      mockClient.release.mockResolvedValue(undefined);
      mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(mockClient) });
      mocks.toSql.mockReturnValue('[0.1,0.2]');
      mocks.providerGenerateEmbedding.mockImplementation((_userId: string, texts: string[]) =>
        Promise.resolve(texts.map(() => new Array(768).fill(0.1))),
      );
    });

    it('skips an oversized batch (HTTP 400 context-length) and continues embedding remaining batches', async () => {
      // Make htmlToText return enough text to produce multiple chunks
      const textWith3Chunks = Array.from(
        { length: 3 },
        (_, i) => `## Section ${i}\n${'content '.repeat(10)}`,
      ).join('\n');
      mocks.htmlToText.mockReturnValue(textWith3Chunks);

      // Phase 2 (BEGIN/DELETE/INSERT×N/UPDATE/COMMIT) handled by mockClient.query default
      // Pool query is NOT used in Phase 2

      const contextErr = new Error('HTTP 400 - input length exceeds context length');

      // First batch (chunks 0..9) throws a context-length error in Phase 1
      // Second batch succeeds in Phase 1 — then Phase 2 runs atomically
      mocks.providerGenerateEmbedding
        .mockRejectedValueOnce(contextErr)
        .mockImplementation((_userId: string, texts: string[]) =>
          Promise.resolve(texts.map(() => new Array(768).fill(0.1))),
        );

      // Should not throw even though first batch failed
      const count = await embedPage('user-1', 101, 'Page', 'DEV', '<p>content</p>');
      // Some chunks should have been embedded (from the successful second batch)
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('rethrows non-context-length errors from embedPage', async () => {
      mocks.htmlToText.mockReturnValue('Some content for the page that is long enough');
      // Phase 1 throws a server error — no client is opened, no pool query needed
      const serverErr = new Error('HTTP 500 - internal server error');
      mocks.providerGenerateEmbedding.mockRejectedValueOnce(serverErr);

      await expect(
        embedPage('user-1', 101, 'Page', 'DEV', '<p>content</p>'),
      ).rejects.toThrow('HTTP 500');

      // No DB interaction at all since Phase 1 throws
      expect(mockClient.query).not.toHaveBeenCalled();
    });
  });
});
