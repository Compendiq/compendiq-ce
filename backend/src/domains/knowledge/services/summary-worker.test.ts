import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import {
  computeContentHash,
  getSummaryStatus,
  rescanAllSummaries,
  regenerateSummary,
  runSummaryBatch,
  startSummaryWorker,
  stopSummaryWorker,
} from './summary-worker.js';

const dbAvailable = await isDbAvailable();

// Mock the LLM summarization to avoid real LLM calls in tests
vi.mock('../../llm/services/ollama-service.js', () => ({
  summarizeContent: vi.fn().mockImplementation(() => {
    async function* generator() {
      yield { content: 'This is a **test** summary.', done: false };
      yield { content: '', done: true };
    }
    return generator();
  }),
}));

vi.mock('../../../core/services/admin-settings-service.js', () => ({
  getSharedLlmSettings: vi.fn().mockResolvedValue({
    llmProvider: 'ollama',
    ollamaModel: 'qwen3.5',
    openaiBaseUrl: null,
    hasOpenaiApiKey: false,
    openaiModel: null,
    embeddingModel: 'nomic-embed-text',
  }),
}));

describe.skipIf(!dbAvailable)('Summary Worker', () => {
  let testUserId: string;
  const testSpaceKey = 'TEST';

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();

    // Create a test user with settings
    const userResult = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash, role) VALUES ('summaryuser', 'fakehash', 'admin') RETURNING id",
    );
    testUserId = userResult.rows[0].id;

    // Create space
    await query(
      "INSERT INTO spaces (space_key, space_name) VALUES ($1, 'Test Space')",
      [testSpaceKey],
    );

    // Link user to space via RBAC
    const editorRole = await query<{ id: number }>("SELECT id FROM roles WHERE name = 'editor' LIMIT 1");
    const roleId = editorRole.rows[0]?.id ?? 3;
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $3) ON CONFLICT DO NOTHING`,
      [testSpaceKey, testUserId, roleId],
    );
  });

  afterAll(async () => {
    stopSummaryWorker();
    await teardownTestDb();
  });

  describe('computeContentHash', () => {
    it('should return consistent SHA-256 hash for same input', () => {
      const hash1 = computeContentHash('hello world');
      const hash2 = computeContentHash('hello world');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex length
    });

    it('should return different hashes for different input', () => {
      const hash1 = computeContentHash('hello world');
      const hash2 = computeContentHash('goodbye world');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('getSummaryStatus', () => {
    it('should return aggregate counts across all pages', async () => {
      // Insert pages with various summary statuses
      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status)
         VALUES ('p1', $1, 'Page 1', 'content one', 'pending'),
                ('p2', $1, 'Page 2', 'content two', 'summarized'),
                ('p3', $1, 'Page 3', 'content three', 'failed'),
                ('p4', $1, 'Page 4', 'short', 'skipped')`,
        [testSpaceKey],
      );

      const status = await getSummaryStatus();
      expect(status.totalPages).toBe(4);
      expect(status.summarizedPages).toBe(1);
      expect(status.pendingPages).toBe(1);
      expect(status.failedPages).toBe(1);
      expect(status.skippedPages).toBe(1);
      expect(status.isProcessing).toBe(false);
    });
  });

  describe('rescanAllSummaries', () => {
    it('should reset all non-skipped pages to pending', async () => {
      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status, summary_retry_count)
         VALUES ('p1', $1, 'Page 1', 'content one', 'summarized', 0),
                ('p2', $1, 'Page 2', 'content two', 'failed', 3),
                ('p3', $1, 'Page 3', 'short', 'skipped', 0)`,
        [testSpaceKey],
      );

      const resetCount = await rescanAllSummaries();
      expect(resetCount).toBe(2); // p1 and p2, not p3 (skipped)

      const result = await query<{ confluence_id: string; summary_status: string; summary_retry_count: number }>(
        'SELECT confluence_id, summary_status, summary_retry_count FROM pages ORDER BY confluence_id',
      );

      expect(result.rows[0].summary_status).toBe('pending');
      expect(result.rows[0].summary_retry_count).toBe(0);
      expect(result.rows[1].summary_status).toBe('pending');
      expect(result.rows[1].summary_retry_count).toBe(0);
      expect(result.rows[2].summary_status).toBe('skipped'); // unchanged
    });
  });

  describe('regenerateSummary', () => {
    it('should reset a single page to pending', async () => {
      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status, summary_retry_count, summary_error)
         VALUES ('p1', $1, 'Page 1', 'content one', 'failed', 3, 'some error')`,
        [testSpaceKey],
      );

      await regenerateSummary('p1');

      const result = await query<{ summary_status: string; summary_retry_count: number; summary_error: string | null }>(
        'SELECT summary_status, summary_retry_count, summary_error FROM pages WHERE confluence_id = $1',
        ['p1'],
      );

      expect(result.rows[0].summary_status).toBe('pending');
      expect(result.rows[0].summary_retry_count).toBe(0);
      expect(result.rows[0].summary_error).toBeNull();
    });
  });

  describe('runSummaryBatch', () => {
    it('should skip pages with body_text shorter than 100 chars', async () => {
      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status)
         VALUES ('short1', $1, 'Short Page', 'too short', 'pending')`,
        [testSpaceKey],
      );

      const { processed } = await runSummaryBatch('test-model');
      expect(processed).toBe(1); // processed but skipped

      const result = await query<{ summary_status: string }>(
        "SELECT summary_status FROM pages WHERE confluence_id = 'short1'",
      );
      expect(result.rows[0].summary_status).toBe('skipped');
    });

    it('should generate summary for eligible pages', async () => {
      const longContent = 'A'.repeat(200);
      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status)
         VALUES ('long1', $1, 'Long Page', $2, 'pending')`,
        [testSpaceKey, longContent],
      );

      const { processed, errors } = await runSummaryBatch('test-model');
      expect(processed).toBe(1);
      expect(errors).toBe(0);

      const result = await query<{
        summary_status: string;
        summary_text: string;
        summary_html: string;
        summary_model: string;
        summary_content_hash: string;
      }>(
        "SELECT summary_status, summary_text, summary_html, summary_model, summary_content_hash FROM pages WHERE confluence_id = 'long1'",
      );

      expect(result.rows[0].summary_status).toBe('summarized');
      expect(result.rows[0].summary_text).toBeTruthy();
      expect(result.rows[0].summary_html).toContain('test');
      expect(result.rows[0].summary_model).toBe('test-model');
      expect(result.rows[0].summary_content_hash).toHaveLength(64);
    });

    it('should detect content changes via hash mismatch and re-summarize', async () => {
      const longContent = 'B'.repeat(200);
      const staleHash = 'aaaa'.repeat(16); // 64-char fake hash that won't match

      // Insert a page that was previously summarized but whose content has since changed
      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status, summary_content_hash, summary_text)
         VALUES ('changed1', $1, 'Changed Page', $2, 'summarized', $3, 'old summary')`,
        [testSpaceKey, longContent, staleHash],
      );

      const { processed, errors } = await runSummaryBatch('test-model');
      expect(errors).toBe(0);
      // The page should have been detected as changed and re-summarized
      expect(processed).toBe(1);

      const result = await query<{
        summary_status: string;
        summary_content_hash: string;
      }>(
        "SELECT summary_status, summary_content_hash FROM pages WHERE confluence_id = 'changed1'",
      );

      expect(result.rows[0].summary_status).toBe('summarized');
      // Hash should now match the actual content
      expect(result.rows[0].summary_content_hash).toBe(computeContentHash(longContent));
    });

    it('should not re-summarize when content hash matches', async () => {
      const longContent = 'C'.repeat(200);
      const correctHash = computeContentHash(longContent);

      // Insert a page that is already summarized with the correct hash
      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status, summary_content_hash, summary_text)
         VALUES ('unchanged1', $1, 'Unchanged Page', $2, 'summarized', $3, 'existing summary')`,
        [testSpaceKey, longContent, correctHash],
      );

      const { processed } = await runSummaryBatch('test-model');
      expect(processed).toBe(0);

      // Summary should remain unchanged
      const result = await query<{ summary_text: string }>(
        "SELECT summary_text FROM pages WHERE confluence_id = 'unchanged1'",
      );
      expect(result.rows[0].summary_text).toBe('existing summary');
    });

    it('should handle body_text with special characters in hash comparison', async () => {
      // Content with backslashes, unicode, and special chars that would break ::bytea cast
      const specialContent = 'A'.repeat(100) + ' backslash: \\ quote: " unicode: ü emoji: 🎉 tab:\t newline:\n end';
      const correctHash = computeContentHash(specialContent);

      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status, summary_content_hash, summary_text)
         VALUES ('special1', $1, 'Special Chars Page', $2, 'summarized', $3, 'existing summary')`,
        [testSpaceKey, specialContent, correctHash],
      );

      // Should NOT crash and should NOT re-summarize (hash matches)
      const { processed, errors } = await runSummaryBatch('test-model');
      expect(errors).toBe(0);
      expect(processed).toBe(0);
    });

    it('should fall back to admin settings model when empty string is passed', async () => {
      // When empty model is passed, the worker should read from admin settings (mocked as 'qwen3.5')
      // and process normally rather than marking pages as skipped
      const longContent = 'D'.repeat(200);
      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status)
         VALUES ('fallback1', $1, 'Fallback Page', $2, 'pending')`,
        [testSpaceKey, longContent],
      );

      const result = await runSummaryBatch('');
      // Admin settings mock returns 'qwen3.5', so the page should be processed
      expect(result.processed).toBe(1);
      expect(result.errors).toBe(0);
    });

    it('should mark pages as skipped (not disabled) when no model is available anywhere', async () => {
      // Override the admin settings mock to return empty model
      const { getSharedLlmSettings } = await import('../../../core/services/admin-settings-service.js');
      vi.mocked(getSharedLlmSettings).mockResolvedValueOnce({
        llmProvider: 'ollama',
        ollamaModel: '',
        openaiBaseUrl: null,
        hasOpenaiApiKey: false,
        openaiModel: null,
        embeddingModel: 'nomic-embed-text',
      });

      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status)
         VALUES ('noskip1', $1, 'No Model Page', 'Some content', 'pending')`,
        [testSpaceKey],
      );

      const result = await runSummaryBatch('');
      expect(result.processed).toBe(0);

      // Verify status is 'skipped' (not 'disabled' which would violate DB constraint)
      const pageResult = await query<{ summary_status: string }>(
        "SELECT summary_status FROM pages WHERE confluence_id = 'noskip1'",
      );
      expect(pageResult.rows[0].summary_status).toBe('skipped');
    });

    it('should summarize standalone pages with NULL confluence_id', async () => {
      const longContent = 'E'.repeat(200);
      const insertResult = await query<{ id: number }>(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status)
         VALUES (NULL, $1, 'Standalone Summary Page', $2, 'pending')
         RETURNING id`,
        [testSpaceKey, longContent],
      );
      const pageId = insertResult.rows[0].id;

      const { processed, errors } = await runSummaryBatch('test-model');
      expect(processed).toBe(1);
      expect(errors).toBe(0);

      // Verify using id since confluence_id is NULL
      const result = await query<{ summary_status: string; summary_text: string; summary_model: string }>(
        'SELECT summary_status, summary_text, summary_model FROM pages WHERE id = $1',
        [pageId],
      );
      expect(result.rows[0].summary_status).toBe('summarized');
      expect(result.rows[0].summary_text).toBeTruthy();
      expect(result.rows[0].summary_model).toBe('test-model');
    });
  });

  describe('worker lifecycle', () => {
    it('should start and stop without errors', () => {
      startSummaryWorker(999); // large interval so it doesn't fire
      stopSummaryWorker();
    });

    it('should be idempotent on start', () => {
      startSummaryWorker(999);
      startSummaryWorker(999); // second call should be a no-op
      stopSummaryWorker();
    });
  });
});
