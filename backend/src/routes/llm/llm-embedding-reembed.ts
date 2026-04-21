import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { enqueueReembedAll } from '../../domains/llm/services/embedding-service.js';
import { listActiveEmbeddingLocks } from '../../core/services/redis-cache.js';
import { getJobStatus } from '../../core/services/queue-service.js';
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

const ReembedJobParamsSchema = z.object({
  jobId: z.string().min(1).max(256),
});

/**
 * The synthetic `__reembed_all__` lock is held by the re-embed worker while
 * it runs. It is NOT a real user and must be filtered out of any list we
 * hand to the UI (plan §2.5 / §2.10).
 */
const REEMBED_SYSTEM_LOCK_USER = '__reembed_all__';

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

      // Plan §2.5 — surface currently-held per-user lock userIds in the
      // initial POST response so the UI can render "waiting for alice, bob
      // to finish" without a second round-trip.
      const heldBy = (await listActiveEmbeddingLocks())
        .filter((l) => l.userId !== REEMBED_SYSTEM_LOCK_USER)
        .map((l) => l.userId);
      return { jobId, pageCount, heldBy };
    },
  );

  // Plan §2.5 — progress-polling endpoint for the admin UI.
  fastify.get(
    '/admin/embedding/reembed/:jobId',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request) => {
      const { jobId } = ReembedJobParamsSchema.parse(request.params);
      const status = await getJobStatus('reembed-all', jobId);
      const heldBy = (await listActiveEmbeddingLocks())
        .filter((l) => l.userId !== REEMBED_SYSTEM_LOCK_USER)
        .map((l) => l.userId);
      if (!status) return { jobId, state: 'unknown', progress: null, heldBy };
      return { jobId, ...status, heldBy };
    },
  );
}
