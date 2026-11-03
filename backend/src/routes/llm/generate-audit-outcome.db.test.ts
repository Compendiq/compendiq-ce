/**
 * #282 — Generate's audit entry records the stream's REAL outcome.
 *
 * The route used to emit an unconditional `success` after `streamSSE`
 * returned, which — because the helper consumes stream exceptions itself —
 * recorded a completed generation for every failed or truncated stream. The
 * entry now comes from the helper's outcome, like every other direct route:
 * one `error` row for a truncated HTTP stream (with the output it actually
 * produced, and no cache entry), one `success` row for a completed stream,
 * and nothing at all for a replay (no model call happened).
 *
 * Real PostgreSQL, real Redis, real provider resolution and cache; only the
 * outbound HTTP peer is synthetic.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { isDbAvailable } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { ArticleRouteFixture, sseEvents } from './article-route-test-fixture.js';
import { llmGenerateRoutes } from './llm-generate.js';

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

describe.skipIf(!available)('POST /api/llm/generate audits the real stream outcome', () => {
  const fixture = new ArticleRouteFixture();
  beforeAll(() => fixture.start(llmGenerateRoutes));
  afterAll(() => fixture.close());
  beforeEach(async () => { vi.clearAllMocks(); await fixture.reset(); fixture.output = 'A generated article.'; });

  const post = () => fixture.post('generate', { prompt: 'Write about retries.' });

  it('a truncated stream is one failed inference with observed usage and no cache entry', async () => {
    fixture.endWithoutDone = true;
    const response = await post();
    expect(response.statusCode).toBe(200);
    expect(fixture.requests).toHaveLength(1);
    expect(sseEvents(response.body).at(-1)).toEqual({ error: 'Stream ended before completion', done: true });

    expect(mockEmitLlmAudit).toHaveBeenCalledTimes(1);
    const entry = mockEmitLlmAudit.mock.calls[0]![0];
    expect(entry).toMatchObject({
      action: 'generate', status: 'error', errorMessage: 'Stream ended before completion',
      model: 'm', provider: fixture.providerId, userId: fixture.userId,
    });
    expect(entry.outputTokens).toBeGreaterThan(0);
    expect(await fixture.redis.keys('kb:llm:*')).toEqual([]);

    // A retry is a fresh dispatch, not a replay of the prefix.
    fixture.endWithoutDone = false;
    expect((await post()).statusCode).toBe(200);
    expect(fixture.requests).toHaveLength(2);
  });

  it('a completed stream is one successful inference; its replay adds none', async () => {
    const first = await post();
    expect(first.statusCode).toBe(200);
    expect(sseEvents(first.body).some((e) => e.content === 'A generated article.')).toBe(true);
    expect(mockEmitLlmAudit).toHaveBeenCalledTimes(1);
    expect(mockEmitLlmAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'generate', status: 'success' }));
    expect(await fixture.redis.keys('kb:llm:*')).toHaveLength(1);

    const replay = await post();
    expect(replay.statusCode).toBe(200);
    expect(sseEvents(replay.body)[0]).toMatchObject({ cached: true, content: 'A generated article.' });
    expect(fixture.requests).toHaveLength(1);
    expect(mockEmitLlmAudit).toHaveBeenCalledTimes(1);
  });

  it.each(['legacy', 'provider_revision'])('refuses %s cache without invalidation or a new model call', async (mode) => {
    expect((await post()).statusCode).toBe(200);
    const [key] = await fixture.redis.keys('kb:llm:*');
    if (mode === 'legacy') {
      await fixture.redis.set(key!, JSON.stringify({ content: 'Legacy output', cachedAt: Date.now() }));
    } else {
      const { query } = await import('../../core/db/postgres.js');
      await query("UPDATE llm_providers SET base_url = 'http://changed.test/v1' WHERE id = $1", [fixture.providerId]);
    }
    vi.clearAllMocks();
    const response = await post();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'ai_history_not_replayable', stage: 'chat' });
    expect(fixture.requests).toHaveLength(1);
    expect(mockEmitLlmAudit).not.toHaveBeenCalled();
  });

  it('a malformed cache entry is refused, not regenerated and not audited', async () => {
    expect((await post()).statusCode).toBe(200);
    const [key] = await fixture.redis.keys('kb:llm:*');
    await fixture.redis.set(key!, JSON.stringify({ content: '', cachedAt: 1 }));
    vi.clearAllMocks();

    const refused = await post();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'ai_history_not_replayable', stage: 'chat' });
    expect(fixture.requests).toHaveLength(1);
    expect(mockEmitLlmAudit).not.toHaveBeenCalled();
  });
});
