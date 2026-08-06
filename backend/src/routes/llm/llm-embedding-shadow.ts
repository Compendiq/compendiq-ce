import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  startShadowMigration,
  getShadowMigrationStatus,
  performShadowSwap,
  rollbackShadowMigration,
  cleanupShadowMigration,
  rerunShadowBackfill,
} from '../../domains/llm/services/shadow-migration-service.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';

const ADMIN_RATE_LIMIT = {
  config: {
    rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' },
  },
};

const StartBodySchema = z.object({
  providerId: z.string().uuid(),
  model: z.string().trim().min(1).max(200),
});

/**
 * #1116 — non-destructive re-embed lifecycle. All admin-only. The service
 * throws typed-by-message errors; this layer maps them onto status codes and
 * never invents its own state transitions. Error messages here are app-
 * authored (never a provider body — generateEmbedding throws LlmHttpError
 * whose message is body-free per #1185), so echoing them to an admin is safe.
 */
export async function llmEmbeddingShadowRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  function mapError(err: unknown): { statusCode: number; message: string } | null {
    const message = err instanceof Error ? err.message : '';
    if (/already (active|swapped)|destructive re-embed|shadow migration is already/i.test(message)) {
      return { statusCode: 409, message };
    }
    if (/not ready to swap|No active shadow migration|No shadow migration|nothing to clean up|nothing to backfill|still (running|queued)/i.test(message)) {
      return { statusCode: 409, message };
    }
    if (/Provider not found/i.test(message)) return { statusCode: 404, message };
    if (/unusable dimension/i.test(message)) return { statusCode: 422, message };
    if (/Could not acquire the table lock/i.test(message)) return { statusCode: 503, message };
    return null;
  }

  // POST /admin/embedding/shadow-migration — probe the pair, create the shadow
  // columns, enqueue the backfill.
  fastify.post(
    '/admin/embedding/shadow-migration',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const body = StartBodySchema.parse(request.body);
      try {
        return await startShadowMigration(body);
      } catch (err) {
        const mapped = mapError(err);
        if (mapped) return reply.code(mapped.statusCode).send({ error: mapped.message, statusCode: mapped.statusCode });
        throw err;
      }
    },
  );

  // GET /admin/embedding/shadow-migration — live status + progress.
  fastify.get(
    '/admin/embedding/shadow-migration',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async () => {
      const migration = await getShadowMigrationStatus();
      return { active: migration !== null, migration };
    },
  );

  // POST /admin/embedding/shadow-migration/backfill — re-enqueue the backfill
  // for an active migration (stragglers, a crashed worker, or a crash between
  // start's COMMIT and its enqueue).
  fastify.post(
    '/admin/embedding/shadow-migration/backfill',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (_request, reply) => {
      try {
        return await rerunShadowBackfill();
      } catch (err) {
        const mapped = mapError(err);
        if (mapped) return reply.code(mapped.statusCode).send({ error: mapped.message, statusCode: mapped.statusCode });
        throw err;
      }
    },
  );

  // POST /admin/embedding/shadow-migration/swap — atomic rename-swap. Lock
  // budget is server-side policy, deliberately not a client knob.
  fastify.post(
    '/admin/embedding/shadow-migration/swap',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (_request, reply) => {
      try {
        await performShadowSwap();
        return { swapped: true };
      } catch (err) {
        const mapped = mapError(err);
        if (mapped) return reply.code(mapped.statusCode).send({ error: mapped.message, statusCode: mapped.statusCode });
        throw err;
      }
    },
  );

  // POST /admin/embedding/shadow-migration/rollback — abort (pre-swap) or
  // revert (post-swap, until cleanup).
  fastify.post(
    '/admin/embedding/shadow-migration/rollback',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (_request, reply) => {
      try {
        const result = await rollbackShadowMigration();
        return { result };
      } catch (err) {
        const mapped = mapError(err);
        if (mapped) return reply.code(mapped.statusCode).send({ error: mapped.message, statusCode: mapped.statusCode });
        throw err;
      }
    },
  );

  // POST /admin/embedding/shadow-migration/cleanup — drop the prev columns,
  // restore NOT NULL, close the migration.
  fastify.post(
    '/admin/embedding/shadow-migration/cleanup',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (_request, reply) => {
      try {
        await cleanupShadowMigration();
        return { cleaned: true };
      } catch (err) {
        const mapped = mapError(err);
        if (mapped) return reply.code(mapped.statusCode).send({ error: mapped.message, statusCode: mapped.statusCode });
        throw err;
      }
    },
  );
}
