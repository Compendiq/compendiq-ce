import { FastifyInstance } from 'fastify';
import { findDuplicates, scanAllDuplicates } from '../../domains/knowledge/services/duplicate-detector.js';
import { DuplicatesQuerySchema, AdminDuplicatesQuerySchema } from '@compendiq/contracts';
import { z } from 'zod';

const IdParamSchema = z.object({ id: z.string().min(1) });

export async function pagesDuplicateRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/pages/:id/duplicates - find duplicates for a specific page
  fastify.get('/pages/:id/duplicates', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const { threshold, limit } = DuplicatesQuerySchema.parse(request.query);

    const duplicates = await findDuplicates(userId, id, {
      distanceThreshold: threshold,
      limit,
    });

    return { duplicates, pageId: id };
  });

  // GET /api/admin/duplicates - scan all pages for duplicates (admin only)
  fastify.get('/admin/duplicates', {
    preHandler: fastify.requireAdmin,
  }, async (request) => {
    const userId = request.userId;
    const { threshold } = AdminDuplicatesQuerySchema.parse(request.query);

    const pairs = await scanAllDuplicates(userId, {
      distanceThreshold: threshold,
    });

    return { pairs, total: pairs.length };
  });
}
