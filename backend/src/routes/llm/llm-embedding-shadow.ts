import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ShadowCompareRequestSchema, ShadowCompareJudgementRequestSchema } from '@compendiq/contracts';
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
  getLatestShadowCompareRun,
  runShadowCompare,
  recordShadowCompareJudgement,
  getShadowCompareJudgements,
  CompareRunNotFoundError,
  CompareRunIncompleteError,
  UnknownCompareQueryError,
} from '../../domains/llm/services/shadow-compare-service.js';
import {
  activeBenchmarkRun,
  BenchmarkRunSlotBusyError,
  // Worded by the holder's kind, and shared with the benchmark route (r3):
  // a route may not import another route, so the sentence lives beside the
  // rest of the run lifecycle.
  slotBusyMessage,
} from '../../domains/llm/eval/benchmark-run-lifecycle.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';
import { LlmHttpError } from '../../domains/llm/services/llm-http-error.js';

const ADMIN_RATE_LIMIT = {
  config: {
    rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' },
  },
};

/**
 * The Mode 2 judgement POST is the one route in this file a HUMAN WORKFLOW
 * calls in a burst, and the shared 20/min admin bucket is sized for the
 * run-STARTING posts beside it. The verdict quotes a p only past
 * `MIN_JUDGEMENTS_FOR_P` (20) live-or-candidate PICKS, `neither`/`both` cost a
 * POST without counting toward that floor, and a change of mind re-POSTs — so
 * the documented "twenty judgements across sittings" flow can cross 20 writes
 * inside one rolling minute, and a 429 here DROPS the pick rather than
 * delaying it (the client reverts its optimistic overlay and the row goes back
 * to unjudged). The request itself is one bounded upsert into a table keyed by
 * the run's own queries, not a job that spends the LLM queue.
 *
 * A MULTIPLE of the operator's knob, never a floor over it: lowering
 * `rate_limit_admin_max` must still lower this, or the setting is decorative
 * on the one route that would matter.
 */
export const JUDGEMENT_RATE_LIMIT_FACTOR = 5;
const JUDGEMENT_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: async () => (await getRateLimits()).admin.max * JUDGEMENT_RATE_LIMIT_FACTOR,
      timeWindow: '1 minute',
    },
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
      // The 409 is worded by the HOLDER's kind (r3): the card's runId is
      // plain useState, so an admin who switches tabs mid-run and returns
      // reaches this with their own comparison holding the slot — and the
      // sentence is toasted verbatim, so naming a "production retrieval
      // benchmark" there names a run that does not exist. The `error` token
      // stays `benchmark_in_progress` — it is the machine-readable name of
      // the shared slot, not of the holder.
      const active = await activeBenchmarkRun();
      if (active) {
        return reply.code(409).send({
          error: 'benchmark_in_progress',
          message: slotBusyMessage(active.kind),
          // Only ever a COMPARE run's id, and only ever THIS admin's (r1).
          // The card polls whatever id it is handed, and `GET …/compare/:id`
          // is guarded twice over: by kind, and by `requested_by`. So a
          // production benchmark's id 404s on every poll — and so does
          // another admin's comparison, because that run's report carries
          // page titles read under THAT admin's ACL. Either one leaves the
          // card re-attached to a run it can never read; the only id worth
          // adopting is a comparison the caller started themselves.
          ...(active.kind === 'shadow-compare' && active.requestedBy === request.userId
            ? { runId: active.id }
            : {}),
        });
      }

      let runId: string;
      try {
        runId = await createShadowCompareRun(request.userId, { kind: 'shadow-compare', ...body });
      } catch (err) {
        if (err instanceof BenchmarkRunSlotBusyError) {
          return reply.code(409).send({
            error: 'benchmark_in_progress',
            message: slotBusyMessage(err.kind),
            // Same two guards as above: the caller's OWN comparison only.
            ...(err.kind === 'shadow-compare' && err.requestedBy === request.userId
              ? { runId: err.activeRunId }
              : {}),
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

  // GET /admin/embedding/shadow-migration/compare — THIS admin's most recent
  // comparison, in any status, or `{ run: null }`. The card's runId is plain
  // component state: a tab switch, a route change or a reload loses it, and
  // without this lookup the finished report, its disagreement list and the
  // whole Mode 2 workflow become unreachable while the run itself still holds
  // the one-active slot against a replacement.
  fastify.get(
    '/admin/embedding/shadow-migration/compare',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request) => {
      return { run: await getLatestShadowCompareRun(request.userId) };
    },
  );

  // GET /admin/embedding/shadow-migration/compare/:id — poll status/result.
  // 404 for an unknown id, for a run of another kind (so this surface cannot
  // serve or poll production-benchmark runs) and for ANOTHER ADMIN's run: the
  // persisted report carries page titles retrieved under the starting admin's
  // own ACL, private standalone pages included.
  fastify.get(
    '/admin/embedding/shadow-migration/compare/:id',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const run = await getShadowCompareRun(id, request.userId);
      if (!run) return reply.code(404).send({ error: 'not_found', message: 'Comparison run not found' });
      return run;
    },
  );

  // The Mode 2 judgement refusals. Mapped by TYPE, never by a regex over the
  // message: matching English prose makes a copy edit silently turn a 409
  // into an unhandled 500.
  function mapJudgementError(err: unknown): { statusCode: number; message: string } | null {
    if (err instanceof CompareRunNotFoundError) return { statusCode: 404, message: err.message };
    if (err instanceof CompareRunIncompleteError) return { statusCode: 409, message: err.message };
    if (err instanceof UnknownCompareQueryError) return { statusCode: 422, message: err.message };
    return null;
  }

  // POST …/compare/:id/judgements — record which side answered one of the
  // run's queries better. The client names only the run's queryId and a side;
  // the query text, both models and both page lists come from the run's own
  // persisted result, so a judgement can never claim pages the run did not
  // show. Answers the refreshed judgement map + verdict, so the card can
  // render the updated state from the response it already has.
  fastify.post(
    '/admin/embedding/shadow-migration/compare/:id/judgements',
    { preHandler: fastify.requireAdmin, ...JUDGEMENT_RATE_LIMIT },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = ShadowCompareJudgementRequestSchema.parse(request.body);
      try {
        return await recordShadowCompareJudgement(id, body.queryId, body.side, request.userId);
      } catch (err) {
        const mapped = mapJudgementError(err);
        if (mapped) return reply.code(mapped.statusCode).send({ error: mapped.message, statusCode: mapped.statusCode });
        throw err;
      }
    },
  );

  // GET …/compare/:id/judgements — the stored sides for this run's queries
  // plus the verdict over every judgement recorded for the run's model pair
  // (the fixture accumulates across runs).
  fastify.get(
    '/admin/embedding/shadow-migration/compare/:id/judgements',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      try {
        return await getShadowCompareJudgements(id, request.userId);
      } catch (err) {
        const mapped = mapJudgementError(err);
        if (mapped) return reply.code(mapped.statusCode).send({ error: mapped.message, statusCode: mapped.statusCode });
        throw err;
      }
    },
  );
}
