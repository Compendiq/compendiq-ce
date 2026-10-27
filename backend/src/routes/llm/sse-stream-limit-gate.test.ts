/**
 * Route wiring for the per-user concurrent SSE gate. Article identities,
 * provider assignments, ACLs, final admission and transport are real. The
 * limiter seam isolates acquire/release symmetry from its separate Redis
 * atomicity suite; the external HTTP peer supplies success and failure.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { ArticleRouteFixture } from './article-route-test-fixture.js';
import { isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { llmAskRoutes } from './llm-ask.js';
import { llmGenerateRoutes } from './llm-generate.js';
import { llmImproveRoutes } from './llm-improve.js';
import { llmSummarizeRoutes } from './llm-summarize.js';
import { llmQualityRoutes } from './llm-quality.js';
import { llmDiagramRoutes } from './llm-diagram.js';

const state = vi.hoisted(() => ({
  pageId: 0,
  contentRevision: 0,
  mode: 'success' as 'success' | 'error' | 'abort',
  dispatches: 0,
  acquire: vi.fn(),
  release: vi.fn(),
}));
vi.mock('../../core/services/sse-stream-limiter.js', () => ({
  acquireStreamSlot: (...args: unknown[]) => state.acquire(...args),
  getStreamCap: vi.fn().mockResolvedValue(3),
  invalidateStreamCapCache: vi.fn(),
  _resetStreamCapCache: vi.fn(),
}));

// Abort at the outbound HTTP boundary, AFTER the real final admission. This
// exercises the transport's AbortError path without shortening production
// budgets or replacing its generator/admission with an always-allow stub.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: ((...args: Parameters<typeof actual.fetch>) => {
      state.dispatches++;
      if (state.mode === 'abort') return Promise.reject(new DOMException('aborted', 'AbortError'));
      return actual.fetch(...args);
    }) as typeof actual.fetch,
  };
});

// A deterministic retrieval candidate backed by the actual saved article.
// Policy/ACL reads and every dispatch admission remain unmocked.
vi.mock('../../domains/llm/services/rag-service.js', () => ({
  hybridSearch: vi.fn(async () => [{
    pageId: state.pageId, confluenceId: 'conf-123', chunkText: 'Original text',
    pageTitle: 'Article', sectionTitle: 'Sec', spaceKey: null,
    score: 0.032, vectorScore: 0.9, keywordRank: null,
    aiPolicy: 'all', aiPolicyRevision: 0, contentRevision: state.contentRevision,
  }]),
  buildRagContext: vi.fn(() => 'Original text'),
}));

const fixture = new ArticleRouteFixture();
const dbAvailable = await isDbAvailable();
const routes = [
  { path: 'ask', payload: { question: 'hi', model: 'm' } },
  { path: 'generate', payload: { prompt: 'hi', model: 'm' } },
  { path: 'improve', payload: { content: 'hi', type: 'grammar', model: 'm' } },
  { path: 'summarize', payload: { content: 'hi', model: 'm' } },
  { path: 'analyze-quality', payload: { content: 'hi', model: 'm' } },
  { path: 'generate-diagram', payload: { content: 'hi', model: 'm' } },
];

async function post(route: typeof routes[number]) {
  const response = await fixture.post(route.path, { ...route.payload, pageId: fixture.pageId });
  // Hijacked SSE ends before the handler's finally/audit work completes.
  if (response.statusCode !== 429) await vi.waitFor(() => expect(state.release).toHaveBeenCalledTimes(1));
  return response;
}

describe.skipIf(!dbAvailable)('Per-user SSE-stream gate — parameterised across all six handlers', () => {
  beforeAll(async () => {
    await fixture.start(async (app) => {
      await llmAskRoutes(app);
      await llmGenerateRoutes(app);
      await llmImproveRoutes(app);
      await llmSummarizeRoutes(app);
      await llmQualityRoutes(app);
      await llmDiagramRoutes(app);
    });
    fixture.server.removeAllListeners('request');
    fixture.server.on('request', (request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        fixture.requests.push(JSON.parse(raw));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (state.mode === 'error') {
          // A real partial body followed by socket failure drives the
          // generator error branch, rather than an early policy refusal.
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
          setTimeout(() => response.destroy(new Error('upstream failure')), 10);
        } else {
          response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`);
        }
      });
    });
  });
  afterAll(async () => { await fixture.close(); });
  beforeEach(async () => {
    await fixture.reset();
    state.pageId = Number(fixture.pageId);
    state.mode = 'success';
    state.dispatches = 0;
    state.acquire.mockReset();
    state.release.mockReset();
    state.acquire.mockResolvedValue({ acquired: true, release: state.release });
    state.contentRevision = Number((await query('SELECT content_revision FROM pages WHERE id = $1', [state.pageId])).rows[0]!.content_revision);
    // Keep the deterministic retrieval candidate above the confidence gate.
    await query(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ('rag_confidence_threshold', '0')
      ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`);
  });

  describe.each(routes)('$path', (route) => {
    it('returns 429 with the documented body when the cap is hit', async () => {
      state.acquire.mockResolvedValue({ acquired: false, release: state.release });
      const response = await post(route);
      expect(response.statusCode).toBe(429);
      const body = response.json();
      expect(body.error).toBe('too_many_concurrent_streams');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
      expect(state.release).not.toHaveBeenCalled();
      expect(state.dispatches).toBe(0);
    });

    it('releases the slot on the SUCCESS path', async () => {
      const response = await post(route);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain('ok');
      expect(fixture.requests.length).toBeGreaterThan(0);
      expect(state.release).toHaveBeenCalledTimes(1);
    });

    it('releases the slot on the ERROR path (generator throws mid-stream)', async () => {
      state.mode = 'error';
      const response = await post(route);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('partial');
      expect(response.body).toContain('error');
      expect(fixture.requests.length).toBeGreaterThan(0);
      expect(state.release).toHaveBeenCalledTimes(1);
    });

    it('releases the slot on the TIMEOUT/ABORT path (AbortError from transport)', async () => {
      state.mode = 'abort';
      await post(route);
      expect(state.dispatches).toBeGreaterThan(0);
      expect(fixture.requests).toHaveLength(0);
      expect(state.release).toHaveBeenCalledTimes(1);
    });

    it('acquires once per request (exactly-one symmetry with release)', async () => {
      const response = await post(route);
      expect(response.statusCode, response.body).toBe(200);
      expect(state.acquire).toHaveBeenCalledTimes(1);
      expect(state.acquire).toHaveBeenCalledWith(fixture.userId);
      expect(state.release).toHaveBeenCalledTimes(1);
    });
  });
});
