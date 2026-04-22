import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getProviderById } from '../../domains/llm/services/llm-provider-service.js';
import { generateEmbedding } from '../../domains/llm/services/openai-compatible-client.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';
import { logger } from '../../core/utils/logger.js';

const ADMIN_RATE_LIMIT = {
  config: {
    rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' },
  },
};

const ProbeBodySchema = z.object({
  providerId: z.string().uuid(),
  model: z.string().trim().min(1).max(200),
});

export async function llmEmbeddingProbeRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /admin/embedding/probe — probe the vector length a (providerId, model)
  // pair produces. Returns `{dimensions, error?}`. Failures are returned as
  // `{dimensions: 0, error}` (HTTP 200) so the frontend can present a useful
  // message instead of having to unpack a 500.
  fastify.post(
    '/admin/embedding/probe',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const { providerId, model } = ProbeBodySchema.parse(request.body);
      const cfg = await getProviderById(providerId);
      if (!cfg) return reply.code(404).send({ error: 'Provider not found' });

      try {
        const vectors = await generateEmbedding(
          {
            providerId: cfg.id,
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            authType: cfg.authType,
            verifySsl: cfg.verifySsl,
          },
          model,
          'probe',
        );
        const first = vectors[0] ?? [];
        return { dimensions: first.length };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'probe failed';
        logger.warn({ err, providerId, model }, 'embedding probe failed');
        return { dimensions: 0, error: message };
      }
    },
  );
}
