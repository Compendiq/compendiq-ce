/**
 * #282 — only a COMPLETED stream is a result.
 *
 * A provider that closes the socket before `data: [DONE]` (proxy timeout,
 * crashed worker) used to be indistinguishable from a finished answer: the
 * client parser yielded a manufactured `done: true`, `streamSSE` cached the
 * prefix and Improve persisted it as the `completed` improvement. Now the
 * parser throws `StreamIncompleteError`, the helper reports the truncation
 * on the wire and in the audit entry, resolves to `''`, and nothing durable
 * is written — no cache entry, no completed row.
 *
 * Real PostgreSQL, real Redis, real provider resolution; only the outbound
 * HTTP peer is synthetic, and it is the one that misbehaves here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { isDbAvailable } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { ArticleRouteFixture, sseEvents } from './article-route-test-fixture.js';
import { llmImproveRoutes } from './llm-improve.js';

const mockEmitLlmAudit = vi.fn();
vi.mock('../../domains/llm/services/llm-audit-hook.js', async (importActual) => ({
  ...await importActual<typeof import('../../domains/llm/services/llm-audit-hook.js')>(),
  emitLlmAudit: (...args: unknown[]) => mockEmitLlmAudit(...args),
}));
vi.mock('../../core/services/audit-service.js', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn((input: string) => ({ sanitized: input, warnings: [], wasModified: false })),
}));

const available = await isDbAvailable() && await isRedisAvailable();

describe.skipIf(!available)('Improve publishes only a completed stream', () => {
  const fixture = new ArticleRouteFixture();
  beforeAll(() => fixture.start(llmImproveRoutes));
  afterAll(() => fixture.close());
  beforeEach(async () => { vi.clearAllMocks(); await fixture.reset(); });

  const post = () => fixture.post('improve', { pageId: fixture.pageId, content: '<p>Original content</p>', type: 'grammar' });
  const improvements = () => query<{ improved_content: string; status: string }>('SELECT improved_content, status FROM llm_improvements');

  it('a stream that ends without [DONE] is reported, not cached and not persisted as completed', async () => {
    fixture.endWithoutDone = true;
    const response = await post();
    expect(response.statusCode).toBe(200);
    expect(fixture.requests).toHaveLength(1);

    const events = sseEvents(response.body);
    // The prefix the client already saw is on the wire …
    expect(events.some((e) => e.content === 'Improved text')).toBe(true);
    // … followed by an explicit truncation frame, never a `final` one.
    expect(events.at(-1)).toEqual({ error: 'Stream ended before completion', done: true });
    expect(events.some((e) => e.final === true)).toBe(false);

    // Nothing reusable was written.
    expect(await fixture.redis.keys('kb:llm:*')).toEqual([]);
    expect((await improvements()).rows).toEqual([{ improved_content: '', status: 'streaming' }]);

    // The audit entry records the dispatch as a FAILED inference with the
    // output it actually produced — not a success, not nothing.
    expect(mockEmitLlmAudit).toHaveBeenCalledTimes(1);
    expect(mockEmitLlmAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'improve', status: 'error', errorMessage: 'Stream ended before completion',
      outputTokens: expect.any(Number),
    }));
    expect(mockEmitLlmAudit.mock.calls[0]![0].outputTokens).toBeGreaterThan(0);
  });

  it('a completed stream is cached, persisted as completed and audited as success', async () => {
    const response = await post();
    expect(response.statusCode).toBe(200);
    const events = sseEvents(response.body);
    expect(events.some((e) => e.final === true)).toBe(true);
    expect(events.some((e) => typeof e.error === 'string')).toBe(false);

    expect(await fixture.redis.keys('kb:llm:*')).toHaveLength(1);
    expect((await improvements()).rows).toEqual([{ improved_content: 'Improved text', status: 'completed' }]);
    expect(mockEmitLlmAudit).toHaveBeenCalledTimes(1);
    expect(mockEmitLlmAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'improve', status: 'success' }));
  });

  it.each(['policy', 'provider'] as const)('a completed stream whose %s binding moved is neither cached nor persisted as completed', async (change) => {
    // The provider answers only after the page policy has been tightened
    // underneath the in-flight request: the text streams (the dispatch was
    // admitted under the old binding), but the completed-row write runs
    // under re-admission on the held client and is refused.
    const originalOutput = fixture.output;
    let tightened: Promise<unknown> | null = null;
    // The fixture's own handler answers once the body is read; this hook
    // runs first, pauses the body so that handler cannot read it yet, and
    // resumes only after the policy edit has COMMITTED — so the delta is
    // written back strictly after the article stopped admitting.
    const onArrival = (request: import('node:http').IncomingMessage) => {
      request.pause();
      tightened = (change === 'policy'
        ? query("UPDATE pages SET ai_policy = 'none', ai_policy_revision = ai_policy_revision + 1 WHERE id = $1", [Number(fixture.pageId)])
        : query('UPDATE llm_providers SET base_url = $2 WHERE id = $1', [fixture.providerId, `${fixture.baseUrl}/changed`]))
        .finally(() => request.resume());
    };
    fixture.server.prependListener('request', onArrival);
    try {
      const response = await post();
      expect(response.statusCode).toBe(200);
      expect(tightened).not.toBeNull();
      await tightened;
      expect(sseEvents(response.body).some((e) => e.content === originalOutput)).toBe(true);
      // The dispatch happened and is accounted for …
      expect(mockEmitLlmAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'improve', status: 'success' }));
      // … but the row stays unpublished: the output was generated under a
      // binding the article no longer admits.
      expect((await improvements()).rows).toEqual([{ improved_content: '', status: 'streaming' }]);
      expect(await fixture.redis.keys('kb:llm:*')).toEqual([]);
    } finally {
      fixture.server.removeListener('request', onArrival);
    }
  });
});
