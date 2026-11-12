/**
 * #1767 — the public `searchQuery` bound on the four LLM routes, on the REAL
 * app: `buildApp()` (real auth plugin and JWT, real RBAC, real rate limit,
 * real routes, real error handler), real Postgres, real Redis, a synthetic
 * chat provider. The only seam is `mcp-docs-client`, the sole code path from
 * these routes to the sidecar's `search_web` tool — its call count IS the
 * "no MCP tool call" of the acceptance criteria, and the backend has no
 * SearXNG client of its own, so "no SearXNG request" follows.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Short-circuit DNS lookups performed by the SSRF guard during buildApp().
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    const err = new Error('getaddrinfo ENOTFOUND (mocked)') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  }),
}));

const mcp = vi.hoisted(() => ({
  searchDocumentation: vi.fn(),
  fetchDocumentation: vi.fn(),
}));
vi.mock('../../core/services/mcp-docs-client.js', () => ({
  isEnabled: async () => true,
  searchDocumentation: (...args: unknown[]) => mcp.searchDocumentation(...args),
  fetchDocumentation: (...args: unknown[]) => mcp.fetchDocumentation(...args),
}));

import { buildApp } from '../../app.js';
import { query } from '../../core/db/postgres.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import { bumpProviderCacheVersion } from '../../domains/llm/services/cache-bus.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { sseEvents } from './article-route-test-fixture.js';

const available = await isDbAvailable() && await isRedisAvailable();

// 200 chars / 21 words; every token <= 11 chars (no 40+ base64-alphabet run),
// no URL, code or JSON, no surrounding whitespace — the sidecar's sanitizer
// passes it through unchanged, so "exactly 200 characters" is what reaches
// search_web.
const QUERY_200 = 'kubernetes scaling '.repeat(10) + 'autoscaler';
const QUERY_201 = `${QUERY_200}s`;
const WORDS_31 = Array.from({ length: 31 }, (_, i) => `w${i}`).join(' ');

// improve and summarize are page-bound in practice (`pageId` is filled in per
// test); ask says `inputKind: 'independent'` so it gets past the #282 identity
// check. The refusal under test must be the searchQuery validation, nothing
// earlier.
const ROUTES = [
  { path: 'ask', payload: { question: 'hi', model: 'm', inputKind: 'independent' } },
  { path: 'generate', payload: { prompt: 'hi', model: 'm' } },
  { path: 'improve', payload: { content: '<p>Original text</p>', type: 'grammar', model: 'm' }, pageBound: true },
  { path: 'summarize', payload: { content: 'Original text', model: 'm' }, pageBound: true },
] as const;

const TWO_RESULTS = [
  { title: 'R1', url: 'https://example.test/1', snippet: 'S1' },
  { title: 'R2', url: 'https://example.test/2', snippet: 'S2' },
];

describe.skipIf(!available)('searchQuery bound on the LLM routes (#1767)', () => {
  let app: FastifyInstance;
  let provider: Server;
  let providerUrl: string;
  let userId: string;
  let token: string;
  let pageId: string;
  const providerRequests: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];

  beforeAll(async () => {
    await setupTestDb();
    provider = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw) as { stream?: boolean; model: string; messages: Array<{ role: string; content: string }> };
        providerRequests.push(body);
        if (body.stream !== true) {
          // Non-streaming side calls (e.g. the conversation auto-title) expect a JSON completion.
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Title' } }] }));
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Generated text' } }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    const listening = Promise.withResolvers<void>();
    provider.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
    app = await buildApp();
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    const closed = Promise.withResolvers<void>();
    provider.close(() => closed.resolve());
    provider.closeAllConnections();
    await closed.promise;
    await teardownTestDb();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    providerRequests.length = 0;
    await truncateAllTables();
    // An admin bypasses RBAC (auth.ts `userCan`), so the truncated `roles`
    // table never gets in the way of `requireGlobalPermission`.
    userId = (await query<{ id: string }>(
      "INSERT INTO users (username, password_hash, role) VALUES ('web-search-query-admin', 'x', 'admin') RETURNING id",
    )).rows[0]!.id;
    await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
    token = await generateAccessToken({ sub: userId, username: 'web-search-query-admin', role: 'admin' });
    // The LLM stream limit is 10/min per IP and every inject comes from
    // 127.0.0.1; this file sends more than that. Lift it through the
    // production setting rather than by mocking the limiter.
    await query(
      "INSERT INTO admin_settings (setting_key, setting_value) VALUES ('rate_limit_llm_stream_max', '1000')",
    );
    const providerId = (await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, default_model, is_default)
       VALUES ('Query-limit provider', $1, 'none', 'm', TRUE) RETURNING id`,
      [providerUrl],
    )).rows[0]!.id;
    await query(
      "INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('chat', $1, 'm')",
      [providerId],
    );
    bumpProviderCacheVersion();
    pageId = (await query<{ id: number }>(
      `INSERT INTO pages (title, source, visibility, created_by_user_id, owner_id, body_text, confluence_id)
       VALUES ('Article', 'standalone', 'private', $1, $1, 'Original text', 'conf-123') RETURNING id`,
      [userId],
    )).rows[0]!.id.toString();
    mcp.searchDocumentation.mockResolvedValue([]);
    mcp.fetchDocumentation.mockRejectedValue(new Error('unused'));
  });

  async function post(route: string, payload: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/llm/${route}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    if (response.statusCode === 200) {
      // A hijacked SSE ends before the handler's audit/cache/slot finally
      // blocks run in the real app; poll the real terminal counter (wall
      // clock on purpose: the work is on the other side of the hijack) so
      // the next reset never races it.
      const deadline = Date.now() + 5_000;
      while (Number(await app.redis.get(`llm:streams:${userId}`)) > 0) {
        if (Date.now() >= deadline) throw new Error('LLM stream did not settle');
        const tick = Promise.withResolvers<void>();
        setTimeout(tick.resolve, 10);
        await tick.promise;
      }
    }
    return response;
  }

  function expectRefusedBeforeTheSidecar(response: { statusCode: number; body: string; json: () => unknown }, message: string) {
    // Soft on the status/body so a failure also shows whether the sidecar was
    // reached; a streamed (non-JSON) body is reported as text.
    const body = (() => { try { return response.json(); } catch { return response.body; } })();
    expect.soft(response.statusCode).toBe(400);
    expect.soft(body).toEqual({ error: 'ValidationError', message, statusCode: 400 });
    expect(mcp.searchDocumentation).not.toHaveBeenCalled();
    expect(mcp.fetchDocumentation).not.toHaveBeenCalled();
    expect(providerRequests).toEqual([]);
  }

  describe.each(ROUTES)('$path', (route) => {
    const body = (searchQuery: string) => ({
      ...route.payload,
      ...('pageBound' in route && route.pageBound ? { pageId } : {}),
      searchWeb: true,
      searchQuery,
    });

    it('returns 400 ValidationError naming searchQuery for 201 characters and never calls the sidecar', async () => {
      const response = await post(route.path, body(QUERY_201));
      expectRefusedBeforeTheSidecar(response, 'searchQuery: Too big: expected string to have <=200 characters');
    });

    it('returns 400 for 31 words within 200 characters', async () => {
      const response = await post(route.path, body(WORDS_31));
      expectRefusedBeforeTheSidecar(response, 'searchQuery: keywords only (max 30 words)');
    });

    it('returns 400 for a whitespace-only searchQuery instead of forwarding it', async () => {
      const response = await post(route.path, body('   '));
      expectRefusedBeforeTheSidecar(response, 'searchQuery: Too small: expected string to have >=1 characters');
    });
  });

  it('forwards an exactly-200-character searchQuery verbatim to search_web and turns two sidecar results into two sources', async () => {
    mcp.searchDocumentation.mockResolvedValue(TWO_RESULTS);
    mcp.fetchDocumentation.mockImplementation(async (url: string) => ({
      url, title: url, markdown: `Body of ${url}`, cached: false, contentLength: 10, truncated: false,
    }));

    const response = await post('generate', { prompt: 'hi', model: 'm', searchWeb: true, searchQuery: QUERY_200 });

    expect(response.statusCode, response.body).toBe(200);
    expect(mcp.searchDocumentation).toHaveBeenCalledTimes(1);
    expect(mcp.searchDocumentation).toHaveBeenCalledWith(QUERY_200, userId, 5);
    const sources = sseEvents(response.body).find((event) => event.final)!.sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(2);
    expect(sources.map((source) => source.url)).toEqual(['https://example.test/1', 'https://example.test/2']);
    expect(sources.every((source) => source.pageId === 0)).toBe(true);
  });

  it('trims surrounding whitespace before forwarding (202 raw characters reach search_web as the 200-char query)', async () => {
    const response = await post('generate', { prompt: 'hi', model: 'm', searchWeb: true, searchQuery: ` ${QUERY_200} ` });

    expect(response.statusCode, response.body).toBe(200);
    expect(mcp.searchDocumentation).toHaveBeenCalledWith(QUERY_200, userId, 5);
  });
});
