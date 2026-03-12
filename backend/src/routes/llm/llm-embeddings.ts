import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { confluenceToHtml } from '../../core/services/content-converter.js';
import { getEmbeddingStatus, processDirtyPages, reEmbedAll, isProcessingUser, embedPage, resetFailedEmbeddings } from '../../domains/llm/services/embedding-service.js';
import type { EmbeddingProgressEvent } from '../../domains/llm/services/embedding-service.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import { ForceEmbedTreeRequestSchema } from '@kb-creator/contracts';
import { logger } from '../../core/utils/logger.js';
import { EMBEDDING_RATE_LIMIT } from './_helpers.js';

export async function llmEmbeddingRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/embeddings/status
  fastify.get('/embeddings/status', async (request) => {
    return getEmbeddingStatus(request.userId);
  });

  // POST /api/embeddings/process - trigger embedding processing with SSE progress
  fastify.post('/embeddings/process', EMBEDDING_RATE_LIMIT, async (request, reply) => {
    const userId = request.userId;

    // Return 409 if embedding is already in progress for this user
    if (await isProcessingUser(userId)) {
      throw fastify.httpErrors.conflict('Embedding processing is already in progress for this user');
    }

    // Set up SSE response
    const controller = new AbortController();
    const onClose = () => controller.abort();
    request.raw.on('close', onClose);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send initial event
    reply.raw.write(`data: ${JSON.stringify({ type: 'started', message: 'Embedding processing started' })}\n\n`);

    try {
      const onProgress = (event: EmbeddingProgressEvent) => {
        if (!controller.signal.aborted) {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      };

      await processDirtyPages(userId, onProgress);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        logger.debug('Embedding process SSE aborted by client disconnect');
      } else {
        logger.error({ err, userId }, 'Embedding processing failed');
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: 'Embedding processing failed', done: true })}\n\n`);
      }
    } finally {
      request.raw.removeListener('close', onClose);
      reply.raw.end();
    }
  });

  // POST /api/embeddings/retry-failed - reset failed embeddings and reprocess
  fastify.post('/embeddings/retry-failed', EMBEDDING_RATE_LIMIT, async (request, reply) => {
    const userId = request.userId;

    // Return 409 if embedding is already in progress for this user
    if (await isProcessingUser(userId)) {
      throw fastify.httpErrors.conflict('Embedding processing is already in progress for this user');
    }

    // Reset all failed pages back to 'not_embedded'
    const resetCount = await resetFailedEmbeddings();

    if (resetCount === 0) {
      return { message: 'No failed embeddings to retry', reset: 0 };
    }

    // Set up SSE response for reprocessing
    const controller = new AbortController();
    const onClose = () => controller.abort();
    request.raw.on('close', onClose);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    reply.raw.write(`data: ${JSON.stringify({ type: 'started', message: `Reset ${resetCount} failed pages, reprocessing...`, reset: resetCount })}\n\n`);

    try {
      const onProgress = (event: EmbeddingProgressEvent) => {
        if (!controller.signal.aborted) {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      };

      await processDirtyPages(userId, onProgress);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        logger.debug('Retry-failed SSE aborted by client disconnect');
      } else {
        logger.error({ err, userId }, 'Retry-failed embedding processing failed');
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: 'Retry processing failed', done: true })}\n\n`);
      }
    } finally {
      request.raw.removeListener('close', onClose);
      reply.raw.end();
    }
  });

  // POST /api/embeddings/force-embed-tree - force-embed a page and all its sub-pages via SSE
  fastify.post('/embeddings/force-embed-tree', EMBEDDING_RATE_LIMIT, async (request, reply) => {
    const { pageId } = ForceEmbedTreeRequestSchema.parse(request.body);
    const userId = request.userId;

    const client = await getClientForUser(userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence credentials not configured');
    }

    // Set up SSE response
    const controller = new AbortController();
    const onClose = () => controller.abort();
    request.raw.on('close', onClose);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {
      // Phase 1: Discover all pages in the tree
      reply.raw.write(`data: ${JSON.stringify({ phase: 'discovering', total: 0, completed: 0, done: false })}\n\n`);

      const rootPage = await client.getPage(pageId);
      const descendants = await client.getDescendantPages(pageId);
      const allPages = [rootPage, ...descendants];
      const total = allPages.length;

      reply.raw.write(`data: ${JSON.stringify({ phase: 'embedding', total, completed: 0, done: false })}\n\n`);

      // Phase 2: Embed each page, reporting progress
      let completed = 0;
      let errors = 0;

      for (const page of allPages) {
        if (controller.signal.aborted) break;

        try {
          // Fetch full page content if not already expanded
          const fullPage = page.body?.storage?.value ? page : await client.getPage(page.id);
          const storageXhtml = fullPage.body?.storage?.value ?? '';

          if (storageXhtml) {
            // Try to get space_key and cached HTML from local DB first
            const cachedRow = await query<{ space_key: string; body_html: string }>(
              'SELECT space_key, body_html FROM cached_pages WHERE confluence_id = $1',
              [page.id],
            );

            const resolvedSpaceKey = cachedRow.rows[0]?.space_key ?? '';
            const bodyHtml = confluenceToHtml(storageXhtml, page.id, resolvedSpaceKey);
            const resolvedBodyHtml = cachedRow.rows[0]?.body_html ?? bodyHtml;

            await embedPage(userId, page.id, page.title, resolvedSpaceKey, resolvedBodyHtml);
          }

          completed++;
        } catch (err) {
          errors++;
          completed++;
          logger.error({ err, pageId: page.id, title: page.title }, 'Failed to embed page in tree');
        }

        reply.raw.write(`data: ${JSON.stringify({
          phase: 'embedding',
          total,
          completed,
          errors,
          currentPage: page.title,
          done: false,
        })}\n\n`);
      }

      // Final event
      if (!controller.signal.aborted) {
        reply.raw.write(`data: ${JSON.stringify({
          phase: 'complete',
          total,
          completed,
          errors,
          done: true,
        })}\n\n`);
      }
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        logger.debug('Force embed tree SSE aborted by client disconnect');
      } else {
        logger.error({ err, pageId }, 'Force embed tree failed');
        reply.raw.write(`data: ${JSON.stringify({ error: 'Failed to embed page tree', done: true })}\n\n`);
      }
    } finally {
      request.raw.removeListener('close', onClose);
      reply.raw.end();
    }
  });

  // POST /api/admin/re-embed - admin only: re-embed all pages
  fastify.post('/admin/re-embed', {
    preHandler: fastify.requireAdmin,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (_request, _reply) => {
    reEmbedAll().catch((err) => {
      logger.error({ err }, 'Re-embed all failed');
    });

    return { message: 'Re-embedding started for all users' };
  });
}
