/**
 * #282 — the Ask identity contract against the REAL route, real Postgres,
 * real Redis and a synthetic provider.
 *
 * The mocked unit suite (`llm-ask.test.ts`) declares its legacy payloads
 * `independent` from a fixture hook; nothing here does, so these cells prove
 * the route's own rule: a question that names neither an article nor an
 * explicit `independent` is refused before anything is read, shipped or
 * persisted — never downgraded to a free-form question.
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

describe.skipIf(!available)('Ask identity contract (#282)', () => {
  const fixture = new ArticleRouteFixture();
  beforeAll(() => fixture.start(llmAskRoutes));
  beforeEach(() => fixture.reset());
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => fixture.close());

  const conversations = () => query<{ id: string }>('SELECT id FROM llm_conversations');

  it('refuses 400 ask_identity_required when the body names no article and does not declare the question independent', async () => {
    const usage = vi.spyOn(audit, 'emitLlmAudit');
    const response = await fixture.post('ask', { question: 'What does the paragraph I pasted mean?', referenceText: 'Grounding' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'ask_identity_required' });
    // Nothing was shipped, nothing was persisted, nothing was metered.
    expect(fixture.requests).toEqual([]);
    expect(usage).not.toHaveBeenCalled();
    expect((await conversations()).rows).toEqual([]);
  });

  it('refuses 400 when inputKind "independent" contradicts a pageId', async () => {
    const response = await fixture.post('ask', {
      question: 'q', inputKind: 'independent', pageId: fixture.pageId, referenceText: 'Grounding',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'ask_identity_required' });
    expect(fixture.requests).toEqual([]);
    expect((await conversations()).rows).toEqual([]);
  });

  it('refuses 400 when inputKind "page" names no article', async () => {
    const response = await fixture.post('ask', { question: 'q', inputKind: 'page', referenceText: 'Grounding' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'ask_identity_required' });
    expect(fixture.requests).toEqual([]);
  });

  it('answers an explicitly independent question and records no page in its provenance', async () => {
    const response = await fixture.post('ask', {
      question: 'How many retries?', inputKind: 'independent', referenceText: 'Retry three times.',
    });
    expect(response.statusCode, response.body).toBe(200);
    const final = sseEvents(response.body).find((event) => event.final === true)!;
    expect(final).toBeDefined();
    expect(final.refused).not.toBe(true);
    // The answer was ONE chat completion. Other requests reach the same
    // synthetic peer and are not the answer: the question's retrieval
    // embedding (the `embedding` use case inherits the default provider,
    // an `{ model, input }` body with no `messages`) and, after INSERT, the
    // #1361 auto-title, which races this assertion. So the shape is pinned,
    // not the count — and no embedding ever carries the reference text.
    const chatCalls = fixture.requests.filter((request) => Array.isArray(request.messages));
    const answerCalls = chatCalls.filter((request) => !request.messages.some((m) => m.content.includes('You write titles')));
    expect(answerCalls).toHaveLength(1);
    for (const request of fixture.requests) {
      if (Array.isArray(request.messages)) continue;
      expect(JSON.stringify((request as unknown as { input?: unknown }).input ?? '')).not.toContain('Retry three times.');
    }
    const saved = (await query<{ messages: SavedTurn[]; page_ref: number | null }>(
      'SELECT messages, page_ref FROM llm_conversations WHERE id = $1', [final.conversationId],
    )).rows[0]!;
    expect(saved.page_ref).toBeNull();
    expect(saved.messages[1]!.aiProvenance!.pages).toEqual([]);
  });

  it('answers a page-bound question (a pageId implies the page identity) and records the article in its provenance', async () => {
    const response = await fixture.post('ask', {
      question: 'What does this say?', pageId: fixture.pageId, referenceText: 'Draft grounding',
    });
    expect(response.statusCode, response.body).toBe(200);
    const final = sseEvents(response.body).find((event) => event.final === true)!;
    expect(final).toBeDefined();
    const saved = (await query<{ messages: SavedTurn[]; page_ref: number | null }>(
      'SELECT messages, page_ref FROM llm_conversations WHERE id = $1', [final.conversationId],
    )).rows[0]!;
    expect(saved.page_ref).toBe(Number(fixture.pageId));
    expect(saved.messages[1]!.aiProvenance!.pages).toEqual([
      expect.objectContaining({ pageId: Number(fixture.pageId), policy: 'all' }),
    ]);
  });
});
