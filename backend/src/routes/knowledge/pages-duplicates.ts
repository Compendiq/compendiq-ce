import { FastifyInstance } from 'fastify';
import { findDuplicates, scanAllDuplicates } from '../../domains/knowledge/services/duplicate-detector.js';
import { z } from 'zod';

const IdParamSchema = z.object({ id: z.string().min(1) });

export async function pagesDuplicateRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/pages/:id/duplicates - find duplicates for a specific page
  fastify.get('/pages/:id/duplicates', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const { threshold = '0.15', limit = '10' } = request.query as Record<string, string>;

    const duplicates = await findDuplicates(userId, id, {
      distanceThreshold: parseFloat(threshold) || 0.15,
      limit: Math.min(parseInt(limit, 10) || 10, 50),
    });

    return { duplicates, pageId: id };
  });

  // GET /api/admin/duplicates - scan all pages for duplicates (admin only)
  fastify.get('/admin/duplicates', {
    preHandler: fastify.requireAdmin,
  }, async (request) => {
    const userId = request.userId;
    const { threshold = '0.15' } = request.query as Record<string, string>;

    const pairs = await scanAllDuplicates(userId, {
      distanceThreshold: parseFloat(threshold) || 0.15,
    });

    return { pairs, total: pairs.length };
  });
}
