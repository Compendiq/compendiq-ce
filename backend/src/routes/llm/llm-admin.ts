import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RetrievalBenchmarkRequestSchema } from '@compendiq/contracts';
import { LlmCache } from '../../domains/llm/services/llm-cache.js';
import { getMcpDocsSettings, upsertMcpDocsSettings } from '../../core/services/mcp-docs-settings.js';
import { testConnection as testMcpConnection, fetchDocumentation, searchDocumentation } from '../../core/services/mcp-docs-client.js';
import { query } from '../../core/db/postgres.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import {
  createProductionBenchmarkRun,
  getActiveProductionBenchmark,
  getProductionBenchmarkRun,
  ProductionBenchmarkAlreadyRunningError,
  runProductionBenchmark,
} from '../../domains/llm/eval/production-benchmark.js';
import { slotBusyMessage } from '../../domains/llm/eval/benchmark-run-lifecycle.js';

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

  // ─── Production retrieval benchmark ─────────────────────────────────

  // Starts a paired, read-only comparison over real production queries. The
  // work is intentionally asynchronous: a provider call plus three retrieval
  // legs per question can outlive an HTTP request timeout.
  fastify.post('/admin/retrieval-benchmark', {
    preHandler: fastify.requireAdmin,
    ...ADMIN_RATE_LIMIT,
  }, async (request, reply) => {
    const config = RetrievalBenchmarkRequestSchema.parse(request.body ?? {});
    const active = await getActiveProductionBenchmark();
    if (active) {
      return reply.code(409).send({
        error: 'benchmark_in_progress',
        // Worded by the run that HOLDS the slot, never by the route that was
        // asked (r3). The slot is shared with the #1260 shadow comparison, so
        // the fixed sentence told an operator refused by a running comparison
        // that "a production retrieval benchmark is already running" — a run
        // that did not exist, on the surface they consult to find out what is
        // holding it, and toasted verbatim by the Retrieval tab. That the
        // exclusion itself is acceptable and stated in both cards' copy is the
        // #1260 owner decision; wording it wrongly is not part of it.
        message: slotBusyMessage(active.kind),
        // The ID is withheld for the mirror-image reason: the #1260 shadow
        // comparison, and `GET /admin/retrieval-benchmark/:id` is kind-guarded
        // and 404s a compare run's id. Handing it back would let this card
        // adopt an id its own poll refuses (r1) — the mirror of the guard the
        // compare route already applies. Note the same GET is also scoped to
        // the admin who STARTED the run (r2 — its report carries page titles
        // read under that admin's ACL), so a benchmark id handed to a
        // different admin is likewise unreadable by them; the Retrieval tab
        // reads only its own POST's id and never this field.
        ...(active.kind === null ? { runId: active.id } : {}),
      });
    }

    let runId: string;
    try {
      runId = await createProductionBenchmarkRun(request.userId, config);
    } catch (err) {
      if (err instanceof ProductionBenchmarkAlreadyRunningError) {
        return reply.code(409).send({
          error: 'benchmark_in_progress',
          // Same holder-worded sentence as above: the race's winner may be a
          // comparison, and `err.message` is the class's fixed benchmark one.
          message: slotBusyMessage(err.kind),
          // Same kind guard as above: only ever a benchmark's own id.
          ...(err.kind === null ? { runId: err.activeRunId } : {}),
        });
      }
      throw err;
    }

    await logAuditEvent(request.userId, 'RETRIEVAL_BENCHMARK_STARTED', 'llm', undefined, {
      runId,
      source: config.source,
      queryLimit: config.source === 'recent-queries' ? config.limit : config.queries?.length,
      topK: config.topK,
    }, request);

    void runProductionBenchmark(runId, request.userId).catch((err) => {
      logger.error({ err, runId }, 'Production retrieval benchmark could not start');
    });

    return reply.code(202).send({
      runId,
      status: 'queued',
      message: 'Production retrieval benchmark started',
    });
  });

  fastify.get('/admin/retrieval-benchmark/:id', {
    preHandler: fastify.requireAdmin,
    ...ADMIN_RATE_LIMIT,
  }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const run = await getProductionBenchmarkRun(id, request.userId);
    if (!run) return reply.code(404).send({ error: 'not_found', message: 'Benchmark run not found' });
    return run;
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
