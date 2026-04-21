import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { enqueueReembedAll } from '../../domains/llm/services/embedding-service.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';

const ADMIN_RATE_LIMIT = {
  config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } },
};

// `newDimensions` is optional. When provided and it differs from the current
// embedding_dimensions row in admin_settings, enqueueReembedAll opens a
// transaction that TRUNCATEs page_embeddings, ALTERs the vector column type,
// and rebuilds the HNSW index.
const ReembedBodySchema = z.object({
  newDimensions: z.number().int().min(1).max(8192).optional(),
});

export async function llmEmbeddingReembedRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post(
    '/admin/embedding/reembed',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request) => {
      const { newDimensions } = ReembedBodySchema.parse(request.body ?? {});
      const { rows } = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM pages`);
      const pageCount = parseInt(rows[0]!.c, 10);
      const jobId = await enqueueReembedAll(newDimensions !== undefined ? { newDimensions } : {});
      return { jobId, pageCount };
    },
  );
}
