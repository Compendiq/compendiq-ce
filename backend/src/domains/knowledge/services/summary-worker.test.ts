import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import {
  computeContentHash,
  getSummaryStatus,
  rescanAllSummaries,
  regenerateSummary,
  runSummaryBatch,
  stopSummaryWorker,
  stripSummaryPreamble,
} from './summary-worker.js';
import { setPiiScanHook, _resetPiiScanHookForTests } from '../../../core/services/pii-scan-hook.js';

const dbAvailable = await isDbAvailable();

// Pure-function tests: run without Postgres so the strip logic is always covered.
describe('stripSummaryPreamble', () => {
  it('strips a leading framing line', () => {
    expect(
      stripSummaryPreamble(
        "Here's a summary of the article in Markdown format:\n\n- Point one\n- Point two",
      ),
    ).toBe('- Point one\n- Point two');
  });

  it('strips a trailing meta/offer line', () => {
    expect(
      stripSummaryPreamble(
        'The system deploys nightly.\n\nIf the text was in German, please provide it so I can respond in German.',
      ),
    ).toBe('The system deploys nightly.');
  });

  it('does not strip a real sentence that merely starts with a conditional', () => {
    expect(
      stripSummaryPreamble('If the deployment fails, roll back to the prior release.'),
    ).toBe('If the deployment fails, roll back to the prior release.');
  });

  it('is a no-op on clean input', () => {
    expect(stripSummaryPreamble('- A\n- B')).toBe('- A\n- B');
  });
});

// Real saved assignments and transport admission, with an outbound HTTP stub.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bumpProviderCacheVersion } from '../../llm/services/cache-bus.js';
let server: Server;
let baseUrl: string;
let responseText: string;

// Webhook emit-call-site (#114). The hook is a CE-side no-op; we mock it
// to assert call shape from the worker's success path.
const mockEmitWebhookEvent = vi.fn();
vi.mock('../../../core/services/webhook-emit-hook.js', () => ({
  emitWebhookEvent: (...args: unknown[]) => mockEmitWebhookEvent(...args),
}));

describe.skipIf(!dbAvailable)('Summary Worker', () => {
  let testUserId: string;
  const testSpaceKey = 'TEST';

  beforeAll(async () => {
    await setupTestDb();
    server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: responseText } }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  beforeEach(async () => {
    await truncateAllTables();

    const provider = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, default_model, is_default) VALUES ('X', $1, 'none', 'qwen3.5', TRUE) RETURNING id::text`,
      [baseUrl],
    );
    responseText = 'This is a **test** summary.';
    await query("INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('summary', $1, 'qwen3.5')", [provider.rows[0]!.id]);
    bumpProviderCacheVersion();

    // Re-seed system roles (truncateAllTables clears them)
    await query(
      `INSERT INTO roles (name, display_name, is_system, permissions) VALUES
        ('system_admin', 'System Administrator', TRUE, ARRAY['read','comment','edit','delete','manage','admin']),
        ('space_admin', 'Space Administrator', TRUE, ARRAY['read','comment','edit','delete','manage']),
        ('editor', 'Editor', TRUE, ARRAY['read','comment','edit','delete']),
        ('commenter', 'Commenter', TRUE, ARRAY['read','comment']),
        ('viewer', 'Viewer', TRUE, ARRAY['read'])
       ON CONFLICT (name) DO NOTHING`,
    );

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
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
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
    it('should return aggregate counts across the pages the caller may read', async () => {
      // Insert pages with various summary statuses
      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status)
         VALUES ('p1', $1, 'Page 1', 'content one', 'pending'),
                ('p2', $1, 'Page 2', 'content two', 'summarized'),
                ('p3', $1, 'Page 3', 'content three', 'failed'),
                ('p4', $1, 'Page 4', 'short', 'skipped')`,
        [testSpaceKey],
      );

      const status = await getSummaryStatus(testUserId);
      expect(status.totalPages).toBe(4);
      expect(status.summarizedPages).toBe(1);
      expect(status.pendingPages).toBe(1);
      expect(status.failedPages).toBe(1);
      expect(status.skippedPages).toBe(1);
      expect(status.isProcessing).toBe(false);
    });
  });

  describe('rescanAllSummaries', () => {
    it('resets non-skipped pages and config-skips, but not content/PII skips', async () => {
      // p3 is a content-too-short skip (non-null summary_error) → must stay skipped.
      // p4 is a config-skip (summary_error IS NULL) → the documented no-model
      // recovery path (#910) must reset it to pending.
      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status, summary_retry_count, summary_error)
         VALUES ('p1', $1, 'Page 1', 'content one', 'summarized', 0, NULL),
                ('p2', $1, 'Page 2', 'content two', 'failed', 3, NULL),
                ('p3', $1, 'Page 3', 'short', 'skipped', 0, 'Content too short for summarization'),
                ('p4', $1, 'Page 4', 'content four', 'skipped', 0, NULL)`,
        [testSpaceKey],
      );

      const resetCount = await rescanAllSummaries();
      expect(resetCount).toBe(3); // p1, p2, p4 — not p3 (content skip)

      const result = await query<{ confluence_id: string; summary_status: string; summary_retry_count: number }>(
        'SELECT confluence_id, summary_status, summary_retry_count FROM pages ORDER BY confluence_id',
      );

      expect(result.rows[0].summary_status).toBe('pending'); // p1
      expect(result.rows[0].summary_retry_count).toBe(0);
      expect(result.rows[1].summary_status).toBe('pending'); // p2
      expect(result.rows[1].summary_retry_count).toBe(0);
      expect(result.rows[2].summary_status).toBe('skipped'); // p3 content skip — unchanged
      expect(result.rows[3].summary_status).toBe('pending'); // p4 config skip — recovered
    });
  });

  describe('regenerateSummary', () => {
    it('should reset a single page to pending', async () => {
      const insertResult = await query<{ id: number }>(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status, summary_retry_count, summary_error)
         VALUES ('p1', $1, 'Page 1', 'content one', 'failed', 3, 'some error')
         RETURNING id`,
        [testSpaceKey],
      );

      await regenerateSummary(insertResult.rows[0].id);

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

      expect(await runSummaryBatch('test-model')).toEqual({ processed: 1, errors: 0 });

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

    it('re-queues pages orphaned in summarizing after a crash (#911)', async () => {
      // A prior batch marked this page 'summarizing' then crashed before finishing.
      // The next batch runs under the single-worker lock, so any leftover
      // 'summarizing' row is necessarily orphaned and must be reset + reprocessed.
      const longContent = 'F'.repeat(200);
      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status)
         VALUES ('orphan1', $1, 'Orphaned Page', $2, 'summarizing')`,
        [testSpaceKey, longContent],
      );

      await runSummaryBatch('test-model');

      const row = await query<{ summary_status: string; summary_text: string | null }>(
        "SELECT summary_status, summary_text FROM pages WHERE confluence_id = 'orphan1'",
      );
      expect(row.rows[0].summary_status).toBe('summarized');
      expect(row.rows[0].summary_text).toBeTruthy();
    });

    it('strips model preamble/meta framing before persisting the summary (#912)', async () => {
      responseText = "Here's a summary of the article in Markdown format:\n\n- Deploys nightly.\n\nIf the text was in German, please provide it so I can respond in German.";

      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status)
         VALUES ('preamble1', $1, 'Preamble Page', $2, 'pending')`,
        [testSpaceKey, 'A'.repeat(200)],
      );

      await runSummaryBatch('test-model');

      const row = await query<{ summary_status: string; summary_text: string }>(
        "SELECT summary_status, summary_text FROM pages WHERE confluence_id = 'preamble1'",
      );
      expect(row.rows[0].summary_status).toBe('summarized');
      expect(row.rows[0].summary_text).toContain('Deploys nightly');
      expect(row.rows[0].summary_text).not.toContain('Here');
      expect(row.rows[0].summary_text).not.toContain('please provide');
    });

    describe('PII guard (EE #119)', () => {
      afterEach(() => {
        _resetPiiScanHookForTests();
      });

      it('withholds the summary when the PII scanner blocks it', async () => {
        setPiiScanHook(async () => ({
          spans: [{ start: 0, end: 5, category: 'EMAIL', confidence: 0.99, source: 'regex' }],
          action: 'blocked',
        }));
        await query(
          `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status)
           VALUES ('pii-block', $1, 'PII Page', $2, 'pending')`,
          [testSpaceKey, 'C'.repeat(200)],
        );

        expect(await runSummaryBatch('test-model')).toEqual({ processed: 1, errors: 0 });

        const row = await query<{ summary_status: string; summary_text: string | null }>(
          "SELECT summary_status, summary_text FROM pages WHERE confluence_id = 'pii-block'",
        );
        expect(row.rows[0].summary_status).toBe('skipped');
        expect(row.rows[0].summary_text).toBeNull();
      });

      it('persists the redacted summary when the PII scanner redacts', async () => {
        setPiiScanHook(async () => ({
          spans: [{ start: 0, end: 5, category: 'EMAIL', confidence: 0.99, source: 'regex' }],
          action: 'redacted',
          redactedText: 'Redacted [REDACTED:EMAIL] summary.',
        }));
        await query(
          `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status)
           VALUES ('pii-redact', $1, 'PII Page', $2, 'pending')`,
          [testSpaceKey, 'D'.repeat(200)],
        );

        await runSummaryBatch('test-model');

        const row = await query<{ summary_status: string; summary_html: string }>(
          "SELECT summary_status, summary_html FROM pages WHERE confluence_id = 'pii-redact'",
        );
        expect(row.rows[0].summary_status).toBe('summarized');
        expect(row.rows[0].summary_html).toContain('REDACTED');
      });
    });

    it('should detect content changes via timestamp and re-summarize', async () => {
      const longContent = 'B'.repeat(200);

      // Insert a page that was previously summarized but whose content has since changed
      // (last_modified_at is after summary_generated_at)
      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status, summary_content_hash, summary_text, summary_generated_at, last_modified_at)
         VALUES ('changed1', $1, 'Changed Page', $2, 'summarized', $3, 'old summary', NOW() - INTERVAL '1 hour', NOW())`,
        [testSpaceKey, longContent, computeContentHash('old content')],
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

    it('should not re-summarize when content has not changed since last summary', async () => {
      const longContent = 'C'.repeat(200);
      const correctHash = computeContentHash(longContent);

      // Insert a page that is already summarized and has not been modified since
      // (summary_generated_at is after last_modified_at)
      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status, summary_content_hash, summary_text, summary_generated_at, last_modified_at)
         VALUES ('unchanged1', $1, 'Unchanged Page', $2, 'summarized', $3, 'existing summary', NOW(), NOW() - INTERVAL '1 hour')`,
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

    it('should handle body_text with special characters in timestamp comparison', async () => {
      // Content with backslashes, unicode, and special chars
      const specialContent = 'A'.repeat(100) + ' backslash: \\ quote: " unicode: ü emoji: 🎉 tab:\t newline:\n end';
      const correctHash = computeContentHash(specialContent);

      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status, summary_content_hash, summary_text, summary_generated_at, last_modified_at)
         VALUES ('special1', $1, 'Special Chars Page', $2, 'summarized', $3, 'existing summary', NOW(), NOW() - INTERVAL '1 hour')`,
        [testSpaceKey, specialContent, correctHash],
      );

      // Should NOT crash and should NOT re-summarize (not modified since summary)
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

    it('keeps work pending when no model is available anywhere', async () => {
      // Real resolver configuration: no model is available anywhere.
      await query("UPDATE llm_usecase_assignments SET model = '' WHERE usecase = 'summary'");
      await query("UPDATE llm_providers SET default_model = ''");
      bumpProviderCacheVersion();

      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status)
         VALUES ('noskip1', $1, 'No Model Page', 'Some content', 'pending')`,
        [testSpaceKey],
      );

      const result = await runSummaryBatch('');
      expect(result.processed).toBe(0);

      const pageResult = await query<{ summary_status: string; summary_ai_attempt: number }>(
        "SELECT summary_status, summary_ai_attempt FROM pages WHERE confluence_id = 'noskip1'",
      );
      expect(pageResult.rows[0]).toMatchObject({ summary_status: 'pending', summary_ai_attempt: 1 });
    });

    it('keeps a re-synced page eligible despite a prior error and unavailable model', async () => {
      // Missing configuration must not hide work behind a terminal skip or
      // overwrite the previous failure. Pending work remains rescan eligible.
      await query("UPDATE llm_usecase_assignments SET model = '' WHERE usecase = 'summary'");
      await query("UPDATE llm_providers SET default_model = ''");
      bumpProviderCacheVersion();

      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status, summary_error)
         VALUES ('stale-err', $1, 'Re-synced Page', 'Some content', 'pending', 'LLM timeout from a prior failure')`,
        [testSpaceKey],
      );

      const result = await runSummaryBatch('');
      expect(result.processed).toBe(0);

      const afterSkip = await query<{ summary_status: string; summary_error: string | null }>(
        "SELECT summary_status, summary_error FROM pages WHERE confluence_id = 'stale-err'",
      );
      expect(afterSkip.rows[0].summary_status).toBe('pending');
      expect(afterSkip.rows[0].summary_error).toBe('LLM timeout from a prior failure');

      // Rescan still selects the queued row; no terminal config-skip is needed.
      const resetCount = await rescanAllSummaries();
      expect(resetCount).toBe(1);

      const afterRescan = await query<{ summary_status: string }>(
        "SELECT summary_status FROM pages WHERE confluence_id = 'stale-err'",
      );
      expect(afterRescan.rows[0].summary_status).toBe('pending');
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

  describe('ai.summary.complete webhook emit (#114)', () => {
    beforeEach(() => {
      mockEmitWebhookEvent.mockReset();
    });

    it('emits ai.summary.complete with the generated summary on success', async () => {
      const longContent = 'D'.repeat(200);
      const insertResult = await query<{ id: number }>(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status)
         VALUES ('w-summary', $1, 'Summary Webhook Page', $2, 'pending')
         RETURNING id`,
        [testSpaceKey, longContent],
      );
      const pageId = insertResult.rows[0].id;

      const { processed, errors } = await runSummaryBatch('test-model');
      expect(processed).toBe(1);
      expect(errors).toBe(0);

      const completedCalls = mockEmitWebhookEvent.mock.calls.filter(
        (c) => c[0]?.eventType === 'ai.summary.complete',
      );
      expect(completedCalls).toHaveLength(1);
      const event = completedCalls[0]![0];
      expect(event.payload).toMatchObject({ pageId });
      expect(typeof event.payload.summary).toBe('string');
      expect(event.payload.summary.length).toBeGreaterThan(0);
      expect(typeof event.payload.completedAt).toBe('string');
    });

    it('does NOT emit ai.summary.complete when content is too short (skipped)', async () => {
      await query(
        `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status)
         VALUES ('w-summary-short', $1, 'Short Page', 'tiny', 'pending')`,
        [testSpaceKey],
      );

      await runSummaryBatch('test-model');

      const completedCalls = mockEmitWebhookEvent.mock.calls.filter(
        (c) => c[0]?.eventType === 'ai.summary.complete',
      );
      expect(completedCalls).toHaveLength(0);
    });
  });

});
