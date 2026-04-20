import type { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { enqueueReembedAll } from '../../domains/llm/services/embedding-service.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';

const ADMIN_RATE_LIMIT = {
  config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } },
};

export async function llmEmbeddingReembedRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /admin/embedding/reembed — enqueue a re-embed job for all pages.
  // Task 30 will extend this to accept `{ newDimensions?: number }` in the body
  // and run a dimension-probe + ALTER TABLE path when dimensions change.
  fastify.post(
    '/admin/embedding/reembed',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async () => {
      const { rows } = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM pages`);
      const pageCount = parseInt(rows[0]!.c, 10);
      const jobId = await enqueueReembedAll();
      return { jobId, pageCount };
    },
  );
}
