import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LlmCache } from '../../domains/llm/services/llm-cache.js';
import { getMcpDocsSettings, upsertMcpDocsSettings } from '../../core/services/mcp-docs-settings.js';
import { testConnection as testMcpConnection, fetchDocumentation, searchDocumentation } from '../../core/services/mcp-docs-client.js';
import { query } from '../../core/db/postgres.js';
import { logAuditEvent } from '../../core/services/audit-service.js';

import { getRateLimits } from '../../core/services/rate-limit-service.js';
const ADMIN_RATE_LIMIT = { config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } } };

const UpdateMcpDocsSchema = z.object({
  enabled: z.boolean().optional(),
  url: z.string().url().optional(),
  domainMode: z.enum(['allowlist', 'blocklist']).optional(),
  allowedDomains: z.array(z.string()).optional(),
  blockedDomains: z.array(z.string()).optional(),
  cacheTtl: z.number().int().min(60).max(86400).optional(),
  maxContentLength: z.number().int().min(1000).max(500_000).optional(),
});

const TestFetchSchema = z.object({
  url: z.string().url(),
});

export async function llmAdminRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // Create LLM cache instance
  const llmCache = new LlmCache(fastify.redis);

  // POST /api/admin/clear-llm-cache - admin only: clear all LLM response cache
  fastify.post('/admin/clear-llm-cache', {
    preHandler: fastify.requireAdmin,
    config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } },
  }, async () => {
    const deleted = await llmCache.clearAll();
    return { message: `LLM cache cleared`, entriesDeleted: deleted };
  });

  // ─── MCP Docs Admin Routes ──────────────────────────────────────────

  // GET /api/admin/mcp-docs - get MCP docs settings
  fastify.get('/admin/mcp-docs', {
    preHandler: fastify.requireAdmin,
    ...ADMIN_RATE_LIMIT,
  }, async () => {
    return getMcpDocsSettings();
  });

  // PUT /api/admin/mcp-docs - update MCP docs settings
  fastify.put('/admin/mcp-docs', {
    preHandler: fastify.requireAdmin,
    ...ADMIN_RATE_LIMIT,
  }, async (request) => {
    const updates = UpdateMcpDocsSchema.parse(request.body);
    await upsertMcpDocsSettings(updates);
    return { message: 'MCP docs settings updated', ...await getMcpDocsSettings() };
  });

  // POST /api/admin/mcp-docs/test - test MCP sidecar connectivity
  fastify.post('/admin/mcp-docs/test', {
    preHandler: fastify.requireAdmin,
    ...ADMIN_RATE_LIMIT,
  }, async () => {
    return testMcpConnection();
  });

  // POST /api/admin/mcp-docs/test-fetch - test fetch a URL via the sidecar
  fastify.post('/admin/mcp-docs/test-fetch', {
    preHandler: fastify.requireAdmin,
    ...ADMIN_RATE_LIMIT,
  }, async (request) => {
    const { url } = TestFetchSchema.parse(request.body);
    try {
      const result = await fetchDocumentation(url, request.userId, 2000);
      return {
        ok: true,
        title: result.title,
        url: result.url,
        contentLength: result.contentLength,
        cached: result.cached,
        preview: result.markdown.slice(0, 500),
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  });

  // ─── SearXNG Admin Routes ──────────────────────────────────────────

  const SEARXNG_KEYS = ['searxng_url', 'searxng_max_results', 'searxng_categories'] as const;

  const UpdateSearxngSchema = z.object({
    url: z.string().url().optional(),
    maxResults: z.number().int().min(1).max(20).optional(),
    categories: z.string().max(200).optional(),
  });

  fastify.get('/admin/searxng', { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT }, async () => {
    const result = await query<{ setting_key: string; setting_value: string }>(
      `SELECT setting_key, setting_value FROM admin_settings WHERE setting_key = ANY($1::text[])`,
      [SEARXNG_KEYS as unknown as string[]],
    );
    const map: Record<string, string> = {};
    for (const row of result.rows) map[row.setting_key] = row.setting_value;
    return {
      url: map['searxng_url'] ?? process.env.SEARXNG_URL ?? 'http://searxng:8080',
      maxResults: parseInt(map['searxng_max_results'] ?? '5', 10),
      categories: map['searxng_categories'] ?? 'general',
    };
  });

  fastify.put('/admin/searxng', { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT }, async (request) => {
    const body = UpdateSearxngSchema.parse(request.body);
    for (const [field, key] of [['url', 'searxng_url'], ['maxResults', 'searxng_max_results'], ['categories', 'searxng_categories']] as const) {
      const val = body[field as keyof typeof body];
      if (val !== undefined) {
        await query(
          `INSERT INTO admin_settings (setting_key, setting_value, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
          [key, String(val)],
        );
      }
    }
    await logAuditEvent(request.userId, 'ADMIN_ACTION', 'admin_settings', undefined, {
      action: 'update_searxng_settings', changedFields: Object.keys(body),
    });
    return { message: 'SearXNG settings updated' };
  });

  fastify.post('/admin/searxng/test', { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT }, async (request) => {
    try {
      const results = await searchDocumentation('test connection', request.userId, 3);
      return { ok: true, resultCount: results.length, sample: results.slice(0, 3).map((r) => ({ title: r.title, url: r.url })) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  });
}
