import { FastifyInstance } from 'fastify';
import { readAttachment, fetchAndCacheAttachment, getMimeType } from '../services/attachment-handler.js';
import { getClientForUser } from '../services/sync-service.js';
import { logger } from '../utils/logger.js';

export async function attachmentRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/attachments/:pageId/:filename - serve cached or on-demand fetched attachment
  fastify.get('/attachments/:pageId/:filename', async (request, reply) => {
    const { pageId, filename } = request.params as { pageId: string; filename: string };
    const userId = request.userId;

    // Try local cache first
    let data = await readAttachment(userId, pageId, filename);

    // On cache miss, fetch from Confluence on-demand
    if (!data) {
      const client = await getClientForUser(userId);
      if (!client) {
        // User has no Confluence PAT configured — can't fetch on-demand
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Attachment not found',
          reason: 'no_confluence_client',
        });
      }

      try {
        data = await fetchAndCacheAttachment(client, userId, pageId, filename);
      } catch (err) {
        logger.error({ err, userId, pageId, filename }, 'On-demand attachment fetch failed');
        // Infrastructure error — don't expose as a "not found"
        throw fastify.httpErrors.internalServerError('Failed to fetch attachment from Confluence');
      }

      if (!data) {
        // fetchAndCacheAttachment returned null — attachment genuinely not in Confluence
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Attachment not found',
          reason: 'not_found_in_confluence',
        });
      }
    }

    const mimeType = getMimeType(filename);
    reply.header('Content-Type', mimeType);
    reply.header('Cache-Control', 'public, max-age=3600');

    // SVG files can contain embedded JavaScript — prevent execution
    if (mimeType === 'image/svg+xml') {
      reply.header('Content-Security-Policy', 'sandbox');
      reply.header('Content-Disposition', 'attachment');
    }

    return reply.send(data);
  });
}
