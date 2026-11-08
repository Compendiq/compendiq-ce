/**
 * #282 — a page-bound Ask WITHOUT the sub-page tree.
 *
 * The question may carry the open article's own text (an unsaved selection,
 * a draft paragraph), so the article's policy governs the turn BEFORE
 * retrieval, before any provider call, and on every later reuse of the
 * recorded turn. The fixture's provider carries no accountable local
 * declaration, i.e. it is effectively external. Real Postgres, real Redis,
 * real provider resolution; only the outbound HTTP peer is synthetic.
 */
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as audit from '../../domains/llm/services/llm-audit-hook.js';
import { isDbAvailable } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { ArticleRouteFixture, sseEvents } from './article-route-test-fixture.js';
import { llmAskRoutes } from './llm-ask.js';

const available = await isDbAvailable() && await isRedisAvailable();

type SavedTurn = { aiProvenance?: { pages: Array<Record<string, unknown>> } };

describe.skipIf(!available)('Ask page-associated input without a descendant tree (#282)', () => {
  const fixture = new ArticleRouteFixture();
  beforeAll(() => fixture.start(llmAskRoutes));
  beforeEach(() => fixture.reset());
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => fixture.close());

  for (const policy of ['none', 'local_only']) {
    it(`${policy}: refuses 409 before any provider call, with no conversation row and no usage entry`, async () => {
      const usage = vi.spyOn(audit, 'emitLlmAudit');
      await query('UPDATE pages SET ai_policy = $1 WHERE id = $2', [policy, Number(fixture.pageId)]);
      const response = await fixture.post('ask', {
        pageId: fixture.pageId, includeSubPages: false,
        question: 'Restricted unsaved selection', referenceText: 'Draft grounding',
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'ai_grounding_not_admissible', stage: 'chat' });
      expect(fixture.requests).toEqual([]);
      expect(usage).not.toHaveBeenCalled();
      expect((await query('SELECT id FROM llm_conversations')).rows).toEqual([]);
    });
  }

  it('refuses 409 for an article the caller cannot read, exactly like one that does not exist', async () => {
    const other = (await query<{ id: string }>(
      "INSERT INTO users (username, password_hash, role) VALUES ('other', 'x', 'user') RETURNING id",
    )).rows[0]!.id;
    await query('UPDATE pages SET created_by_user_id = $1, owner_id = $1 WHERE id = $2', [other, Number(fixture.pageId)]);
    const denied = await fixture.post('ask', { pageId: fixture.pageId, question: 'q', referenceText: 'Draft grounding' });
    const missing = await fixture.post('ask', { pageId: '999999', question: 'q', referenceText: 'Draft grounding' });
    expect(denied.statusCode).toBe(409);
    expect(missing.statusCode).toBe(409);
    expect(denied.json()).toEqual(missing.json());
    expect(fixture.requests).toEqual([]);
    expect((await query('SELECT id FROM llm_conversations')).rows).toEqual([]);
  });

  it('records the article in the turn provenance even with empty retrieval, and refuses a continuation once its policy moved', async () => {
    const page = (await query<{ ai_policy_revision: string | number; content_revision: string | number }>(
      'SELECT ai_policy_revision, content_revision FROM pages WHERE id = $1', [Number(fixture.pageId)],
    )).rows[0]!;
    const response = await fixture.post('ask', {
      pageId: fixture.pageId, includeSubPages: false,
      question: 'Unmatched unsaved selection', referenceText: 'Draft grounding',
    });
    expect(response.statusCode, response.body).toBe(200);
    const final = sseEvents(response.body).find((event) => event.final === true)!;
    expect(final).toBeDefined();
    const saved = (await query<{ messages: SavedTurn[]; page_ref: number | null }>(
      'SELECT messages, page_ref FROM llm_conversations WHERE id = $1', [final.conversationId],
    )).rows[0]!;
    expect(saved.messages[1]!.aiProvenance!.pages).toEqual([{
      pageId: Number(fixture.pageId), policy: 'all',
      policyRevision: Number(page.ai_policy_revision), contentRevision: Number(page.content_revision),
    }]);
    expect(saved.page_ref).toBe(Number(fixture.pageId));
    // ONE answer call. The same synthetic peer also receives the question's
    // retrieval embedding (the `embedding` use case inherits the default
    // provider — an `{ model, input }` body with no `messages`) and, after
    // INSERT, the #1361 auto-title, which races this read; so the shape is
    // pinned, not the total count — and the embedding carries the QUESTION,
    // never the article body (the page text ships only in the admitted
    // chat completion, #282).
    const chatCalls = fixture.requests.filter((request) => Array.isArray(request.messages));
    const answerCalls = chatCalls.filter((request) => !request.messages.some((m) => m.content.includes('You write titles')));
    expect(answerCalls).toHaveLength(1);
    for (const request of fixture.requests) {
      if (Array.isArray(request.messages)) continue;
      expect(JSON.stringify((request as unknown as { input?: unknown }).input ?? '')).not.toContain('Original text');
    }

    await query(
      "UPDATE pages SET ai_policy = 'none', ai_policy_revision = ai_policy_revision + 1 WHERE id = $1",
      [Number(fixture.pageId)],
    );
    // Let a still-in-flight auto-title land before the count is taken, so
    // the refused continuation is measured against a settled baseline.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const count = fixture.requests.length;
    const continuation = await fixture.post('ask', {
      conversationId: final.conversationId, inputKind: 'independent', question: 'Continue',
    });
    expect(continuation.statusCode).toBe(409);
    expect(continuation.json().error).toBe('ai_history_not_replayable');
    expect(fixture.requests).toHaveLength(count);
  });
});
