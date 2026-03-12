import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { readAttachment, fetchAndCachePageImage, getMimeType, writeAttachmentCache } from '../../domains/confluence/services/attachment-handler.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import { getRedisClient } from '../../core/services/redis-cache.js';
import { logger } from '../../core/utils/logger.js';

const UpdateAttachmentBodySchema = z.object({
  dataUri: z.string().min(1, 'dataUri is required'),
});

/** Maximum allowed attachment upload size: 10 MB */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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

  // PUT /api/attachments/:pageId/:filename - update a diagram attachment
  // Accepts a JSON body with { dataUri: "data:image/png;base64,..." }
  // Validates PNG, enforces 10 MB limit, uploads to Confluence, and updates local cache.
  fastify.put('/attachments/:pageId/:filename', async (request, reply) => {
    const { pageId, filename } = request.params as { pageId: string; filename: string };
    const userId = request.userId;

    // Validate request body with Zod
    const parseResult = UpdateAttachmentBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.issues[0]?.message ?? 'Missing or invalid dataUri in request body',
      });
    }
    const { dataUri } = parseResult.data;

    const pngPrefix = 'data:image/png;base64,';
    if (!dataUri.startsWith(pngPrefix)) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Only PNG data URIs are supported (must start with data:image/png;base64,)',
      });
    }

    // Decode the base64 data
    const base64Data = dataUri.slice(pngPrefix.length);
    let pngBuffer: Buffer;
    try {
      pngBuffer = Buffer.from(base64Data, 'base64');
    } catch {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Invalid base64 data in dataUri',
      });
    }

    // Validate PNG magic bytes
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (pngBuffer.length < 8 || !pngBuffer.subarray(0, 8).equals(PNG_MAGIC)) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Data is not a valid PNG file',
      });
    }

    // Enforce size limit
    if (pngBuffer.length > MAX_UPLOAD_BYTES) {
      return reply.status(413).send({
        statusCode: 413,
        error: 'Payload Too Large',
        message: `Attachment exceeds maximum size of ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`,
      });
    }

    // Verify the page belongs to the user's selected spaces
    const pageResult = await query<{ body_storage: string | null; space_key: string }>(
      `SELECT cp.body_storage, cp.space_key
       FROM cached_pages cp
       JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
       WHERE cp.confluence_id = $2`,
      [userId, pageId],
    );
    if (pageResult.rows.length === 0) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Page not found in selected spaces',
      });
    }

    // Get Confluence client for the user
    const client = await getClientForUser(userId);
    if (!client) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'No Confluence connection configured. Please set up your PAT in settings.',
      });
    }

    try {
      // Upload the attachment to Confluence
      await client.updateAttachment(pageId, filename, pngBuffer, 'image/png');

      // Update local cache so the image is served immediately without re-sync
      await writeAttachmentCache(userId, pageId, filename, pngBuffer);

      // Invalidate Redis page cache so other users get the updated diagram
      try {
        const redis = getRedisClient();
        if (redis) {
          const keys = await redis.keys(`*:page:${pageId}*`);
          if (keys.length > 0) await redis.del(keys);
        }
      } catch {
        // Redis may be unavailable — non-fatal, cache will expire naturally
      }

      logger.info({ userId, pageId, filename, size: pngBuffer.length }, 'Diagram attachment updated');

      return reply.status(200).send({
        success: true,
        filename,
        size: pngBuffer.length,
      });
    } catch (err) {
      logger.error({ err, userId, pageId, filename }, 'Failed to update attachment');
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw fastify.httpErrors.internalServerError(`Failed to update attachment: ${message}`);
    }
  });
}
