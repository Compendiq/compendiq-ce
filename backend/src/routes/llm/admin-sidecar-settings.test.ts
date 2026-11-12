import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

/**
 * #1769 — the MCP Docs and SearXNG admin settings are APPLIED: what an admin
 * saves through the real routes is what the backend sends to the sidecar.
 *
 * Real Postgres (admin_settings), real admin routes, real settings readers,
 * real mcp-docs-client and real fetchWebSources. The only seam is the MCP SDK
 * client — the sidecar boundary — replaced by a fake sidecar that records every
 * tool call and answers `fetch_url` with at most `max_length` characters, as
 * the real one does. The sidecar's half (cache_ttl → Redis TTL, categories →
 * SearXNG request and cache key) is proven on the real process in
 * mcp-docs/src/admin-settings.integration.test.ts.
 */
interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** Every tool call the backend makes, and the length of the document the fake sidecar "fetches". */
const sidecar = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
  docLength: 4000,
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  StreamableHTTPClientTransport: class {
    async close() {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async callTool(call: ToolCall) {
      sidecar.calls.push(call);
      if (call.name === 'fetch_url') {
        const returned = Math.min(Number(call.arguments.max_length), sidecar.docLength);
        const meta = [
          'Title: Doc',
          `URL: ${String(call.arguments.url)}`,
          `Content length: ${sidecar.docLength} chars`,
          'Cached: false',
          returned < sidecar.docLength ? 'Truncated: true (use start_index to read more)' : '',
        ].filter(Boolean).join('\n');
        return { content: [{ type: 'text', text: `${meta}\n\n---\n\n${'d'.repeat(returned)}` }] };
      }
      return {
        content: [{
          type: 'text',
          text: '1. **R1**\n   https://example.test/1\n   S1\n\n2. **R2**\n   https://example.test/2\n   S2',
        }],
      };
    }
  },
}));

// --- Mock: llm-cache (constructed by the route module; unrelated to these routes) ---
vi.mock('../../domains/llm/services/llm-cache.js', () => ({
  LlmCache: class {
    clearAll = vi.fn();
  },
}));

import { isDbAvailable, setupTestDb } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { logger } from '../../core/utils/logger.js';
import { fetchDocumentation } from '../../core/services/mcp-docs-client.js';
import { fetchWebSources } from './_web-search-helper.js';
import { llmAdminRoutes } from './llm-admin.js';

const dbAvailable = await isDbAvailable();

async function store(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
    [key, value],
  );
}

async function stored(key: string): Promise<string | undefined> {
  const result = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
    [key],
  );
  return result.rows[0]?.setting_value;
}

function callsTo(name: string): Array<Record<string, unknown>> {
  return sidecar.calls.filter((call) => call.name === name).map((call) => call.arguments);
}

describe.skipIf(!dbAvailable)('admin MCP Docs / SearXNG settings reach the sidecar as tool arguments (#1769)', () => {
  let app: ReturnType<typeof Fastify>;
  let adminId: string;

  beforeAll(async () => {
    await setupTestDb();
    await query(`DELETE FROM users WHERE username = 'sidecar-settings-admin'`);
    adminId = (await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role) VALUES ('sidecar-settings-admin', 'x', 'admin') RETURNING id`,
    )).rows[0]!.id;

    app = Fastify({ logger: false });
    await app.register(sensible);
    const asAdmin = async (request: { userId: string; userRole: string }) => {
      request.userId = adminId;
      request.userRole = 'admin';
    };
    app.decorate('authenticate', asAdmin);
    app.decorate('requireAdmin', asAdmin);
    app.decorate('redis', {});
    app.decorateRequest('userId', '');
    // Match the production error handler for Zod validation errors (app.ts).
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        reply.status(400).send({
          error: 'ValidationError',
          message: error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          statusCode: 400,
        });
        return;
      }
      reply.status(error.statusCode ?? 500).send({ error: error.message, statusCode: error.statusCode ?? 500 });
    });
    await app.register(llmAdminRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    // Leave nothing behind for later files in this worker's database.
    await query(`DELETE FROM admin_settings WHERE setting_key LIKE 'searxng_%' OR setting_key LIKE 'mcp_docs_%'`);
    await query(`DELETE FROM users WHERE id = $1`, [adminId]);
  });

  beforeEach(async () => {
    sidecar.calls.length = 0;
    await query(`DELETE FROM admin_settings WHERE setting_key LIKE 'searxng_%' OR setting_key LIKE 'mcp_docs_%'`);
    await store('mcp_docs_enabled', 'true');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const put = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'PUT', url, payload });
  const testFetch = () => app.inject({ method: 'POST', url: '/api/admin/mcp-docs/test-fetch', payload: { url: 'https://docs.example/a' } });

  describe('MCP Docs — Cache TTL and Max Content Length', () => {
    it('a saved Max Content Length of 1000 caps test-fetch at 1000 characters and a saved Cache TTL of 60 is sent as cache_ttl', async () => {
      expect((await put('/api/admin/mcp-docs', { maxContentLength: 1000, cacheTtl: 60 })).statusCode).toBe(200);

      const response = await testFetch();

      expect(callsTo('fetch_url')).toEqual([
        { url: 'https://docs.example/a', max_length: 1000, user_id: adminId, cache_ttl: 60 },
      ]);
      // The route reports the document's full length and previews the first
      // 500 of the (now at most 1000) characters it was given.
      expect(response.json()).toEqual({
        ok: true, title: 'Doc', url: 'https://docs.example/a', contentLength: sidecar.docLength, cached: false, preview: 'd'.repeat(500),
      });
    });

    it('the same save makes web search fetch each source with max_length 1000, not 5000', async () => {
      await put('/api/admin/mcp-docs', { maxContentLength: 1000, cacheTtl: 60 });

      const { sources } = await fetchWebSources('kubernetes scaling', 'user-1');

      expect(callsTo('fetch_url').map((args) => [args.max_length, args.cache_ttl])).toEqual([[1000, 60], [1000, 60]]);
      expect(sources.map((source) => source.snippet.length)).toEqual([1000, 1000]);
    });

    it('at the default ceiling web search still asks for 5000, test-fetch for 2000 and a bare fetch for 10000', async () => {
      await fetchWebSources('kubernetes scaling', 'user-1');
      await testFetch();
      await fetchDocumentation('https://docs.example/external', 'user-1');

      expect(callsTo('fetch_url').map((args) => args.max_length)).toEqual([5000, 5000, 2000, 10_000]);
      expect(callsTo('fetch_url').map((args) => args.cache_ttl)).toEqual([3600, 3600, 3600, 3600]);
    });

    it('a saved Cache TTL of 7200 is sent as cache_ttl 7200', async () => {
      await put('/api/admin/mcp-docs', { cacheTtl: 7200 });

      await testFetch();

      expect(callsTo('fetch_url')[0]).toMatchObject({ cache_ttl: 7200, max_length: 2000 });
    });

    it('PUT /api/admin/mcp-docs rejects maxContentLength 500000 with 400 and stores nothing', async () => {
      const response = await put('/api/admin/mcp-docs', { maxContentLength: 500_000 });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'ValidationError' });
      expect(response.json().message).toContain('maxContentLength');
      expect(await stored('mcp_docs_max_content_length')).toBeUndefined();
    });

    it('PUT /api/admin/mcp-docs accepts the sidecar cap 100000', async () => {
      const response = await put('/api/admin/mcp-docs', { maxContentLength: 100_000 });

      expect(response.statusCode).toBe(200);
      expect(response.json().maxContentLength).toBe(100_000);
    });

    it('a stored pre-#1769 maxContentLength of 500000 is read back as 100000 with a warning and never sent', async () => {
      const warn = vi.spyOn(logger, 'warn');
      await store('mcp_docs_max_content_length', '500000');

      const response = await app.inject({ method: 'GET', url: '/api/admin/mcp-docs' });
      await fetchDocumentation('https://docs.example/big', 'user-1', 400_000);

      expect(response.json().maxContentLength).toBe(100_000);
      expect(callsTo('fetch_url')[0]!.max_length).toBe(100_000);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'mcp_docs_max_content_length', stored: '500000', effective: 100_000 }),
        expect.stringContaining('clamped'),
      );
    });
  });

  describe('SearXNG — categories', () => {
    it.each(['it', 'general,it'])('saved categories %j are sent by web search and by Test', async (categories) => {
      expect((await put('/api/admin/searxng', { categories })).statusCode).toBe(200);

      await fetchWebSources('kubernetes scaling', 'user-1');
      const test = await app.inject({ method: 'POST', url: '/api/admin/searxng/test' });

      expect(test.json()).toMatchObject({ ok: true, resultCount: 2 });
      expect(callsTo('search_web').map((args) => [args.query, args.categories])).toEqual([
        ['kubernetes scaling', categories],
        ['test connection', categories],
      ]);
    });

    it('nothing saved sends the default category general', async () => {
      await fetchWebSources('kubernetes scaling', 'user-1');

      expect(callsTo('search_web')[0]).toMatchObject({ categories: 'general' });
    });

    it.each(['general; drop', 'general, it', 'General', ''])('PUT /api/admin/searxng rejects categories %j with 400 and stores nothing', async (categories) => {
      const response = await put('/api/admin/searxng', { categories });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'ValidationError' });
      expect(response.json().message).toContain('categories');
      expect(await stored('searxng_categories')).toBeUndefined();
    });

    it('a stored pre-#1769 value the sidecar would reject is read as general, with a warning', async () => {
      const warn = vi.spyOn(logger, 'warn');
      await store('searxng_categories', 'general, it');

      const get = await app.inject({ method: 'GET', url: '/api/admin/searxng' });
      await fetchWebSources('kubernetes scaling', 'user-1');

      expect(get.json().categories).toBe('general');
      expect(callsTo('search_web')[0]).toMatchObject({ categories: 'general' });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ stored: 'general, it', effective: 'general' }),
        expect.stringContaining('searxng_categories'),
      );
    });
  });

  describe('SearXNG — no admin-controlled URL', () => {
    it('GET /api/admin/searxng returns the result count and categories only, even when a stale searxng_url row exists', async () => {
      await store('searxng_url', 'http://stale.example:8080');

      const response = await app.inject({ method: 'GET', url: '/api/admin/searxng' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ maxResults: 5, categories: 'general' });
    });

    it('PUT /api/admin/searxng ignores url: the rest is saved, nothing is written under searxng_url', async () => {
      const response = await put('/api/admin/searxng', { url: 'http://evil.example:8080', maxResults: 7, categories: 'it' });

      expect(response.statusCode).toBe(200);
      expect(await stored('searxng_url')).toBeUndefined();
      expect(await stored('searxng_max_results')).toBe('7');
      expect(await stored('searxng_categories')).toBe('it');
      const audit = await query<{ metadata: { changedFields: string[] } }>(
        `SELECT metadata FROM audit_log
         WHERE user_id = $1 AND metadata->>'action' = 'update_searxng_settings'
         ORDER BY created_at DESC LIMIT 1`,
        [adminId],
      );
      expect(audit.rows[0]!.metadata.changedFields).toEqual(['maxResults', 'categories']);
    });

    it('PUT /api/admin/searxng leaves a stale searxng_url row untouched and no search carries a host', async () => {
      await store('searxng_url', 'http://stale.example:8080');

      await put('/api/admin/searxng', { url: 'http://evil.example:8080' });
      await fetchWebSources('kubernetes scaling', 'user-1');
      await app.inject({ method: 'POST', url: '/api/admin/searxng/test' });

      expect(await stored('searxng_url')).toBe('http://stale.example:8080');
      for (const args of callsTo('search_web')) {
        expect(Object.keys(args).sort()).toEqual(['categories', 'num_results', 'query', 'user_id']);
      }
    });
  });
});
