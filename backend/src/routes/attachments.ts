import { FastifyInstance } from 'fastify';
import { readAttachment, getMimeType } from '../services/attachment-handler.js';

export async function attachmentRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/attachments/:pageId/:filename - serve cached attachment
  fastify.get('/attachments/:pageId/:filename', async (request, reply) => {
    const { pageId, filename } = request.params as { pageId: string; filename: string };
    const userId = request.userId;

    const data = await readAttachment(userId, pageId, filename);
    if (!data) {
      throw fastify.httpErrors.notFound('Attachment not found');
    }

    const mimeType = getMimeType(filename);
    reply.header('Content-Type', mimeType);
    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.send(data);
  });
}
