import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { getQualityStatus, forceQualityRescan, triggerQualityBatch } from '../../domains/knowledge/services/quality-worker.js';
import { getSummaryStatus, rescanAllSummaries, regenerateSummary, runSummaryBatch, triggerSummaryBatch } from '../../domains/knowledge/services/summary-worker.js';
import { getEmbeddingStatus, processDirtyPages, reEmbedAll, resetFailedEmbeddings } from '../../domains/llm/services/embedding-service.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';

const adminMax = async () => (await getRateLimits()).admin.max;

export async function knowledgeAdminRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/llm/quality-status - aggregate quality analysis stats
  fastify.get('/llm/quality-status', async () => {
    return getQualityStatus();
  });

  // POST /api/llm/quality-rescan - admin only: force re-analysis of all pages
  fastify.post('/llm/quality-rescan', {
    preHandler: fastify.requireAdmin,
    config: { rateLimit: { max: adminMax, timeWindow: '1 minute' } },
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
    config: { rateLimit: { max: adminMax, timeWindow: '1 minute' } },
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

    // Verify page exists — use id (works for both standalone and Confluence pages)
    const pageResult = await query<{ id: number }>(
      'SELECT id FROM pages WHERE id = $1 OR confluence_id = $1',
      [pageId],
    );
    if (pageResult.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const resolvedId = pageResult.rows[0].id;
    await regenerateSummary(resolvedId);

    // Fire off a batch immediately for this page
    runSummaryBatch().catch((err) => {
      logger.error({ err, pageId }, 'Summary regenerate immediate batch failed');
    });

    return { message: 'Summary regeneration queued', pageId };
  });

  // ======== Run Now — Trigger immediate batch processing ========

  // POST /api/llm/quality-run-now - admin: trigger immediate quality batch
  fastify.post('/llm/quality-run-now', {
    preHandler: fastify.requireAdmin,
    config: { rateLimit: { max: adminMax, timeWindow: '1 minute' } },
  }, async (request) => {
    await logAuditEvent(request.userId, 'QUALITY_RUN_NOW', 'llm', undefined, {}, request);
    triggerQualityBatch().catch((err) => {
      logger.error({ err }, 'Manual quality batch trigger failed');
    });
    return { message: 'Quality analysis batch triggered' };
  });

  // POST /api/llm/summary-run-now - admin: trigger immediate summary batch
  fastify.post('/llm/summary-run-now', {
    preHandler: fastify.requireAdmin,
    config: { rateLimit: { max: adminMax, timeWindow: '1 minute' } },
  }, async (request) => {
    await logAuditEvent(request.userId, 'SUMMARY_RUN_NOW', 'llm', undefined, {}, request);
    triggerSummaryBatch().catch((err) => {
      logger.error({ err }, 'Manual summary batch trigger failed');
    });
    return { message: 'Summary generation batch triggered' };
  });

  // ======== Embedding Status & Actions ========

  // GET /api/llm/embedding-status - get embedding processing stats
  fastify.get('/llm/embedding-status', async (request) => {
    return getEmbeddingStatus(request.userId);
  });

  // POST /api/llm/embedding-run-now - admin: trigger immediate embedding processing
  fastify.post('/llm/embedding-run-now', {
    preHandler: fastify.requireAdmin,
    config: { rateLimit: { max: adminMax, timeWindow: '1 minute' } },
  }, async (request) => {
    await logAuditEvent(request.userId, 'EMBEDDING_RUN_NOW', 'llm', undefined, {}, request);
    processDirtyPages(request.userId).catch((err) => {
      logger.error({ err }, 'Manual embedding batch trigger failed');
    });
    return { message: 'Embedding processing triggered' };
  });

  // POST /api/llm/embedding-rescan - admin: reset all pages for re-embedding
  fastify.post('/llm/embedding-rescan', {
    preHandler: fastify.requireAdmin,
    config: { rateLimit: { max: adminMax, timeWindow: '1 minute' } },
  }, async (request) => {
    await reEmbedAll();
    await logAuditEvent(request.userId, 'EMBEDDING_RESCAN', 'llm', undefined, {}, request);
    processDirtyPages(request.userId).catch((err) => {
      logger.error({ err }, 'Embedding rescan immediate batch failed');
    });
    return { message: 'All pages reset for re-embedding' };
  });

  // POST /api/llm/embedding-reset-failed - admin: retry failed embeddings
  fastify.post('/llm/embedding-reset-failed', {
    preHandler: fastify.requireAdmin,
    config: { rateLimit: { max: adminMax, timeWindow: '1 minute' } },
  }, async (request) => {
    const count = await resetFailedEmbeddings();
    await logAuditEvent(request.userId, 'EMBEDDING_RESET_FAILED', 'llm', undefined, { count }, request);
    processDirtyPages(request.userId).catch((err) => {
      logger.error({ err }, 'Embedding reset-failed immediate batch failed');
    });
    return { message: `${count} failed embeddings reset to pending`, count };
  });
}
