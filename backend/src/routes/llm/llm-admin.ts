import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { LlmCache } from '../../domains/llm/services/llm-cache.js';
import { getQualityStatus, forceQualityRescan } from '../../domains/knowledge/services/quality-worker.js';
import { getSummaryStatus, rescanAllSummaries, regenerateSummary, runSummaryBatch } from '../../domains/knowledge/services/summary-worker.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';

export async function llmAdminRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // Create LLM cache instance
  const llmCache = new LlmCache(fastify.redis);

  // POST /api/admin/clear-llm-cache - admin only: clear all LLM response cache
  fastify.post('/admin/clear-llm-cache', {
    preHandler: fastify.requireAdmin,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async () => {
    const deleted = await llmCache.clearAll();
    return { message: `LLM cache cleared`, entriesDeleted: deleted };
  });

  // GET /api/llm/quality-status - aggregate quality analysis stats
  fastify.get('/llm/quality-status', async () => {
    return getQualityStatus();
  });

  // POST /api/llm/quality-rescan - admin only: force re-analysis of all pages
  fastify.post('/llm/quality-rescan', {
    preHandler: fastify.requireAdmin,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async () => {
    const count = await forceQualityRescan();
    return { message: `Quality rescan started — ${count} pages reset to pending`, pagesReset: count };
  });

  // ======== Background Summary Status & Actions (Issue #323) ========

  // GET /api/llm/summary-status - get overall summary worker stats
  fastify.get('/llm/summary-status', async () => {
    return getSummaryStatus();
  });

  // POST /api/llm/summary-rescan - admin: reset all summaries to re-generate
  fastify.post('/llm/summary-rescan', {
    preHandler: fastify.requireAdmin,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request) => {
    const resetCount = await rescanAllSummaries();
    await logAuditEvent(request.userId, 'SUMMARY_RESCAN', 'llm', undefined, { resetCount }, request);

    // Fire off a batch immediately (don't await — let it run in background)
    runSummaryBatch().catch((err) => {
      logger.error({ err }, 'Summary rescan immediate batch failed');
    });

    return { message: `Reset ${resetCount} pages for re-summarization`, resetCount };
  });

  // POST /api/llm/summary-regenerate/:pageId - re-generate summary for one page
  fastify.post('/llm/summary-regenerate/:pageId', async (request) => {
    const { pageId } = z.object({ pageId: z.string().min(1) }).parse(request.params);

    // Verify page exists
    const pageResult = await query<{ confluence_id: string }>(
      'SELECT confluence_id FROM cached_pages WHERE confluence_id = $1',
      [pageId],
    );
    if (pageResult.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    await regenerateSummary(pageId);

    // Fire off a batch immediately for this page
    runSummaryBatch().catch((err) => {
      logger.error({ err, pageId }, 'Summary regenerate immediate batch failed');
    });

    return { message: 'Summary regeneration queued', pageId };
  });
}
