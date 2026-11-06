/**
 * #282 — direct-route output cache replay is re-admitted against the binding
 * the entry was RECORDED under (`replayDirectOutput`), and a malformed entry
 * is refused rather than regenerated.
 *
 * Real PostgreSQL, real Redis, real provider resolution and cache; only the
 * outbound HTTP peer is synthetic (`ArticleRouteFixture`). A refusal is a
 * status code answered BEFORE any SSE header, with `fixture.requests`
 * proving no provider round-trip was spent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { isDbAvailable } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { bumpProviderCacheVersion } from '../../domains/llm/services/cache-bus.js';
import { ArticleRouteFixture, sseEvents } from './article-route-test-fixture.js';
import { llmImproveRoutes } from './llm-improve.js';
import { llmSummarizeRoutes } from './llm-summarize.js';
import { llmDiagramRoutes } from './llm-diagram.js';

vi.mock('../../core/services/audit-service.js', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn((input: string) => ({ sanitized: input, warnings: [], wasModified: false })),
}));

const available = await isDbAvailable() && await isRedisAvailable();

describe.skipIf(!available)('direct-route cache replay is re-admitted under recorded provenance', () => {
  const fixture = new ArticleRouteFixture();
  beforeAll(() => fixture.start(async (app: FastifyInstance) => {
    await app.register(llmImproveRoutes);
    await app.register(llmSummarizeRoutes);
    await app.register(llmDiagramRoutes);
  }));
  afterAll(() => fixture.close());

  const routes = [
    { route: 'improve', usecase: 'chat', payload: () => ({ pageId: fixture.pageId, content: '<p>Original content</p>', type: 'grammar' }), stage: 'chat' },
    { route: 'summarize', usecase: 'summary', payload: () => ({ pageId: fixture.pageId, content: '<p>Original content</p>' }), stage: 'summary' },
    { route: 'generate-diagram', usecase: 'chat', payload: () => ({ pageId: fixture.pageId, content: '<p>A calls B.</p>' }), stage: 'chat' },
  ] as const;

  async function cacheKeys(): Promise<string[]> {
    return fixture.redis.keys('kb:llm:*');
  }

  describe.each(routes)('$route', ({ route, usecase, payload, stage }) => {
    beforeEach(async () => {
      vi.clearAllMocks();
      await fixture.reset(usecase);
      fixture.output = route === 'generate-diagram' ? 'graph TD\n  A --> B' : 'Improved text';
    });

    it('replays a hit generated under the same binding without a provider call', async () => {
      expect((await fixture.post(route, payload())).statusCode).toBe(200);
      expect(fixture.requests).toHaveLength(1);
      const keys = await cacheKeys();
      expect(keys).toHaveLength(1);
      // The entry carries the binding it was generated under.
      const entry = JSON.parse((await fixture.redis.get(keys[0]!))!);
      expect(entry.aiProvenance).toMatchObject({
        providerId: fixture.providerId,
        pages: [expect.objectContaining({ pageId: Number(fixture.pageId) })],
      });

      const replay = await fixture.post(route, payload());
      expect(replay.statusCode).toBe(200);
      expect(replay.headers['content-type']).toBe('text/event-stream');
      expect(sseEvents(replay.body)[0]).toMatchObject({ cached: true, content: fixture.output });
      expect(fixture.requests).toHaveLength(1);
    });

    it('refuses with 409 once the page policy forbids the provider — before the cache, without regenerating', async () => {
      expect((await fixture.post(route, payload())).statusCode).toBe(200);
      await query("UPDATE pages SET ai_policy = 'none', ai_policy_revision = ai_policy_revision + 1 WHERE id = $1", [Number(fixture.pageId)]);

      // A page that now denies this provider is refused when the route
      // captures its article — ahead of the cache lookup — with the
      // grounding code, not the replay code: the live article is the
      // reason, not the entry. (It used to surface as an unhandled 500.)
      const refused = await fixture.post(route, payload());
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: 'ai_grounding_not_admissible', stage });
      expect(refused.headers['content-type']).not.toBe('text/event-stream');
      expect(fixture.requests).toHaveLength(1);
      // The entry is untouched: it is not replayable NOW, not deleted.
      expect(await cacheKeys()).toHaveLength(1);
    });

    it('refuses the hit with 409 when the RECORDED grounding no longer matches the live page', async () => {
      expect((await fixture.post(route, payload())).statusCode).toBe(200);
      const [key] = await cacheKeys();
      const original = JSON.parse((await fixture.redis.get(key!))!);
      // The page itself still admits (policy `all`), so the route reaches
      // the cache; the ENTRY, though, records a different content revision
      // than the live row — a result generated against other bytes.
      const stale = { ...original, aiProvenance: { ...original.aiProvenance,
        pages: original.aiProvenance.pages.map((p: { contentRevision: number }) => ({ ...p, contentRevision: p.contentRevision + 1 })) } };
      await fixture.redis.set(key!, JSON.stringify(stale));

      const refused = await fixture.post(route, payload());
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: 'ai_history_not_replayable', stage });
      expect(refused.headers['content-type']).not.toBe('text/event-stream');
      expect(fixture.requests).toHaveLength(1);
    });

    it('refuses the hit with 409 once the provider configuration moved, without regenerating', async () => {
      expect((await fixture.post(route, payload())).statusCode).toBe(200);
      await query('UPDATE llm_providers SET base_url = $2 WHERE id = $1', [fixture.providerId, `${fixture.baseUrl}/moved`]);
      bumpProviderCacheVersion();

      const refused = await fixture.post(route, payload());
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: 'ai_history_not_replayable', stage });
      expect(fixture.requests).toHaveLength(1);
    });

    it('refuses a malformed cached entry with 409 and never regenerates from it', async () => {
      expect((await fixture.post(route, payload())).statusCode).toBe(200);
      const [key] = await cacheKeys();
      const original = (await fixture.redis.get(key!))!;
      const valid = JSON.parse(original);

      const malformed: unknown[] = [
        // empty output
        { ...valid, content: '' },
        // non-string output
        { ...valid, content: 42 },
        // missing output
        { cachedAt: valid.cachedAt, aiProvenance: valid.aiProvenance },
        // bad timestamp
        { ...valid, cachedAt: 'yesterday' },
        // unparseable provenance
        { ...valid, aiProvenance: { version: 'x' } },
        // valid output, NO provenance — unknown provenance is never safe
        { content: valid.content, cachedAt: valid.cachedAt },
        // not even an object
        'just a string',
      ];
      for (const entry of malformed) {
        await fixture.redis.set(key!, JSON.stringify(entry));
        const refused = await fixture.post(route, payload());
        expect(refused.statusCode, JSON.stringify(entry)).toBe(409);
        expect(refused.json()).toEqual({ error: 'ai_history_not_replayable', stage });
        expect(fixture.requests, JSON.stringify(entry)).toHaveLength(1);
      }

      // Restoring the original entry proves the key still replays.
      await fixture.redis.set(key!, original);
      const replay = await fixture.post(route, payload());
      expect(replay.statusCode).toBe(200);
      expect(sseEvents(replay.body)[0]).toMatchObject({ cached: true });
      expect(fixture.requests).toHaveLength(1);
    });

    it('refuses a hit the caller can no longer read', async () => {
      expect((await fixture.post(route, payload())).statusCode).toBe(200);
      const other = (await query<{ id: string }>("INSERT INTO users (username, password_hash, role) VALUES ('other-owner', 'x', 'user') RETURNING id")).rows[0]!.id;
      await query('UPDATE pages SET owner_id = $2, created_by_user_id = $2 WHERE id = $1', [Number(fixture.pageId), other]);

      const refused = await fixture.post(route, payload());
      expect(refused.statusCode).toBeGreaterThanOrEqual(400);
      expect(refused.headers['content-type']).not.toBe('text/event-stream');
      expect(fixture.requests).toHaveLength(1);
    });
  });
});
