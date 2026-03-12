import { FastifyInstance } from 'fastify';
import { query } from '../db/postgres.js';
import { readAttachment, fetchAndCachePageImage, getMimeType } from '../services/attachment-handler.js';
import { getClientForUser } from '../services/sync-service.js';
import { logger } from '../utils/logger.js';

export async function attachmentRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/attachments/:pageId/:filename - serve cached or on-demand fetched attachment
  fastify.get('/attachments/:pageId/:filename', async (request, reply) => {
    const { pageId, filename } = request.params as { pageId: string; filename: string };
    const userId = request.userId;

    const pageResult = await query<{ body_storage: string | null; space_key: string }>(
      `SELECT cp.body_storage, cp.space_key
       FROM cached_pages cp
       JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
       WHERE cp.confluence_id = $2`,
      [userId, pageId],
    );
    const cachedPage = pageResult.rows[0];
    if (!cachedPage) {
      logger.warn({ userId, pageId, filename }, 'Attachment 404: page not found in user space selections');
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Attachment not found',
        reason: 'page_not_in_selected_spaces',
      });
    }

    // Try local cache first
    let data = await readAttachment(userId, pageId, filename);
    if (data) {
      logger.debug({ pageId, filename, size: data.length }, 'Serving attachment from local cache');
    }

    // On cache miss, fetch from Confluence on-demand
    if (!data) {
      logger.debug({ pageId, filename }, 'Attachment cache miss — attempting on-demand fetch');
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
        if (cachedPage.body_storage) {
          data = await fetchAndCachePageImage(
            client,
            userId,
            pageId,
            filename,
            cachedPage.body_storage,
            cachedPage.space_key,
          );
        } else {
          data = null;
        }
      } catch (err) {
        logger.error({ err, userId, pageId, filename }, 'On-demand attachment fetch failed');
        // Infrastructure error — don't expose as a "not found"
        throw fastify.httpErrors.internalServerError('Failed to fetch attachment from Confluence');
      }

      if (!data) {
        // fetchAndCachePageImage returned null — asset genuinely not in source system
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
