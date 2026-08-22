import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ShadowCompareRequestSchema } from '@compendiq/contracts';
import {
  startShadowMigration,
  getShadowMigrationStatus,
  performShadowSwap,
  rollbackShadowMigration,
  cleanupShadowMigration,
  rerunShadowBackfill,
  ShadowProbeError,
} from '../../domains/llm/services/shadow-migration-service.js';
import {
  createShadowCompareRun,
  getShadowCompareRun,
  runShadowCompare,
} from '../../domains/llm/services/shadow-compare-service.js';
import {
  getActiveProductionBenchmark,
  ProductionBenchmarkAlreadyRunningError,
} from '../../domains/llm/eval/production-benchmark.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';
import { LlmHttpError } from '../../domains/llm/services/llm-http-error.js';

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
    // The r2/r3 race refusals: safe, deliberate, and carrying the admin's
    // next step — they must arrive as 409s, not masked 500s (review r3).
    if (/changed mid-(swap|abort|cleanup|rollback)|swap completed while the abort/i.test(message)) {
      return { statusCode: 409, message };
    }
    // The EE org-policy refusal is a conflict with instance configuration,
    // not a server fault — and its text is the admin's next step (review r6).
    if (/organization LLM policy/i.test(message)) return { statusCode: 409, message };
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
        // The probe is the most likely admin-facing failure (wrong model
        // picked, provider down, expired key) — a masked 500 hides the one
        // thing they can act on (review r2). LlmHttpError messages are
        // body-free per #1185, safe to echo to an admin.
        // Two shapes of probe failure, one admin-facing answer: the provider
        // answered with an error status (LlmHttpError, body-free per #1185),
        // or it never answered at all (ShadowProbeError — wrong port, service
        // down, open breaker). The latter used to reach the global handler and
        // come back as 'Internal Server Error' with the cause stripped, which
        // is precisely the failure the admin can fix (review r5).
        if (err instanceof LlmHttpError || err instanceof ShadowProbeError) {
          return reply.code(502).send({
            error: `Probing "${body.model}" against the provider failed: ${err instanceof ShadowProbeError ? err.detail.slice(0, 300) : err.message}`,
            statusCode: 502,
          });
        }
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

  // ── #1260 — compare the candidate against the live model on real queries ──

  // POST /admin/embedding/shadow-migration/compare — start a Mode 1 agreement
  // run over the shadow window. Async (202 + poll): N queries × 2 embed calls
  // ride the shared LLM queue and can outlive an HTTP timeout. Gated on the
  // same `ready` the swap gates on — a partially backfilled candidate column
  // measures the backfill, not the model.
  fastify.post(
    '/admin/embedding/shadow-migration/compare',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const body = ShadowCompareRequestSchema.parse(request.body ?? {});
      const status = await getShadowMigrationStatus();
      if (!status || status.status !== 'active') {
        return reply.code(409).send({
          error:
            'No active shadow migration — the comparison needs the candidate vectors a shadow migration backfills. Start one from the embedding assignment first.',
          statusCode: 409,
        });
      }
      if (status.phase !== 'ready') {
        return reply.code(409).send({
          error: `The candidate column is not fully backfilled (${status.stragglerPages} straggler pages${status.indexReady ? '' : ', shadow index not built'}) — comparing now would measure the backfill, not the model. Wait for the backfill to finish.`,
          statusCode: 409,
        });
      }
      // One run at a time, SHARED with the production retrieval benchmark:
      // both spend the same LLM queue and the 091 partial unique index below
      // is the cross-replica guard. Both cards' copy states the sharing.
      const active = await getActiveProductionBenchmark();
      if (active) {
        return reply.code(409).send({
          error: 'benchmark_in_progress',
          message: 'A production retrieval benchmark is already running',
          runId: active.id,
        });
      }

      let runId: string;
      try {
        runId = await createShadowCompareRun(request.userId, { kind: 'shadow-compare', ...body });
      } catch (err) {
        if (err instanceof ProductionBenchmarkAlreadyRunningError) {
          return reply.code(409).send({
            error: 'benchmark_in_progress',
            message: err.message,
            runId: err.activeRunId,
          });
        }
        throw err;
      }

      await logAuditEvent(
        request.userId,
        'EMBEDDING_SHADOW_COMPARE_STARTED',
        'llm',
        undefined,
        { runId, days: body.days, limit: body.limit, topK: body.topK },
        request,
      );

      void runShadowCompare(runId, request.userId).catch((err) => {
        logger.error({ err, runId }, 'Shadow embedding comparison could not start');
      });

      return reply.code(202).send({ runId, status: 'queued' });
    },
  );

  // GET /admin/embedding/shadow-migration/compare/:id — poll status/result.
  // 404 for an unknown id AND for a run of another kind, so this surface
  // cannot serve (or be used to poll) production-benchmark runs.
  fastify.get(
    '/admin/embedding/shadow-migration/compare/:id',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const run = await getShadowCompareRun(id);
      if (!run) return reply.code(404).send({ error: 'not_found', message: 'Comparison run not found' });
      return run;
    },
  );
}
