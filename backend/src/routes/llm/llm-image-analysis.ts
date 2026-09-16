import type { FastifyInstance } from 'fastify';
import {
  ImageAnalysisActionResultSchema,
  ImageAnalysisStatusSchema,
  type ImageAnalysisActionResult,
  type ImageAnalysisStatus,
} from '@compendiq/contracts';
import { logger } from '../../core/utils/logger.js';
import { isWorkerLocked } from '../../core/services/redis-cache.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';
import {
  getRetainedImageAnalysisIdentity,
  resolveImageAnalysisIdentity,
} from '../../domains/llm/services/image-analysis-identity.js';
import { readImageAnalysisCorpusCounts } from '../../domains/llm/services/image-analysis-readiness.js';
import {
  IMAGE_ANALYSIS_WORKER_LOCK,
  readImageAnalysisLastRun,
  reanalyzeAllImages,
  retryFailedImageAnalyses,
  runImageAnalysisBatch,
} from '../../domains/llm/services/image-analysis-worker.js';

/**
 * #1618 (ADR-027 Stage 1) — the image-analysis processing surface, behind
 * `requireAdmin`. Four routes over reads and actions #1616 already shipped
 * with no HTTP surface of their own; this file adds no SQL and no DDL.
 *
 * **Two surfaces, one job each.** *Can it run?* stays on LLM providers, where
 * #1615 put the selector, the capability chip, Re-check and the output-token
 * ceiling (ADR-027 `:4843-4860` is explicit that the ceiling row must not
 * move). *Is it running?* is this route and the Embeddings-tab card it feeds.
 *
 * **The GET keeps four facts apart** that a smaller payload would let a reader
 * infer from one another — assignment, retained identity, whether those agree,
 * and what the last batch did. Unassigned is a PAUSE (D7): valid descriptions
 * stay searchable, changed images stay pending, and authored text RAG is
 * untouched, so "not assigned" must never render as an outage.
 *
 * **All three actions kick the batch DETACHED**, and this is not a style
 * choice. One batch is bounded by `image_analysis_batch_size` (seeded 50) at
 * up to a 120 s per-image budget, so awaiting it inside a request would hold a
 * connection open past every proxy timeout in the path and then report a
 * failure the work did not have. What the batch DID reaches the operator
 * through `lastRun` on the GET, which the card polls — the legacy leg's
 * recipe, for the same reason. The row counts the two bulk actions move are
 * awaited, deliberately: each is one bounded statement and its count is what
 * the toast quotes, so detaching it would make the response report a number it
 * had not computed.
 */

const ADMIN_RATE_LIMIT = {
  config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } },
};

/**
 * The status GET is the one route in this file a PASSIVE surface calls on a
 * timer, and the shared 20/min admin bucket is sized for the action POSTs
 * beside it. The card polls at 5 s while a batch holds the lease and for a
 * 20 s warm-up after every press (12/min), on top of the mount fetch, the
 * invalidate each press fires and react-query's window-focus refetch — and
 * the Embeddings tab is a surface an operator leaves open while watching a
 * corpus drain. A 429 here does not delay the read, it DROPS the card into
 * its "could not be read" state (`retry: false`), where the counters go to
 * em-dashes until the next interval. The request is four indexed reads and a
 * Redis `EXISTS`; it spends no LLM queue and moves no row.
 *
 * A MULTIPLE of the operator's knob, never a floor over it: lowering
 * `rate_limit_admin_max` must still lower this, the `JUDGEMENT_RATE_LIMIT`
 * rule in `llm-embedding-shadow.ts`.
 */
export const STATUS_POLL_RATE_LIMIT_FACTOR = 5;
const STATUS_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: async () => (await getRateLimits()).admin.max * STATUS_POLL_RATE_LIMIT_FACTOR,
      timeWindow: '1 minute',
    },
  },
};

export async function llmImageAnalysisRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get(
    '/admin/embedding/image-analysis',
    { preHandler: fastify.requireAdmin, ...STATUS_RATE_LIMIT },
    async (): Promise<ImageAnalysisStatus> => {
      const [counts, retained, resolved, lastRun, running] = await Promise.all([
        readImageAnalysisCorpusCounts(),
        getRetainedImageAnalysisIdentity(),
        resolveImageAnalysisIdentity(),
        readImageAnalysisLastRun(),
        isWorkerLocked(IMAGE_ANALYSIS_WORKER_LOCK),
      ]);

      return ImageAnalysisStatusSchema.parse({
        assigned: resolved !== null,
        retainedIdentity: retained,
        // D13's third gate, reported rather than left to be deduced from a
        // backlog that will not drain. `null` only when nothing is assigned:
        // an unassigned instance is paused, not mismatched.
        identityMatchesAssignment:
          resolved === null ? null : retained !== null && retained.identityHash === resolved.identityHash,
        rows: counts.rows,
        // The reconcile's snake_case reason keys, camelCased for the wire in
        // exactly one place. Spread would pass `too_large` straight through
        // and the schema would reject it.
        skipReasons: {
          missing: counts.skipReasons.missing,
          unsupported: counts.skipReasons.unsupported,
          oversized: counts.skipReasons.oversized,
          tooLarge: counts.skipReasons.too_large,
          external: counts.skipReasons.external,
          capped: counts.skipReasons.capped,
        },
        dirtyPages: counts.dirtyPages,
        pagesAwaitingEmbed: counts.pagesAwaitingEmbed,
        running,
        lastRun,
      });
    },
  );

  fastify.post(
    '/admin/embedding/image-analysis/process',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (): Promise<ImageAnalysisActionResult> => {
      const alreadyRunning = await kickBatch();
      return ImageAnalysisActionResultSchema.parse({ started: !alreadyRunning, alreadyRunning });
    },
  );

  fastify.post(
    '/admin/embedding/image-analysis/retry-failed',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (): Promise<ImageAnalysisActionResult> => {
      // D13: `failed` and `failed_terminal` become due now with a fresh
      // attempt budget. No one-active-run guard — it moves no payload and
      // spends no call by itself; the batch it kicks is the ordinary one.
      const rows = await retryFailedImageAnalyses();
      const alreadyRunning = await kickBatch();
      return ImageAnalysisActionResultSchema.parse({ rows, started: !alreadyRunning, alreadyRunning });
    },
  );

  fastify.post(
    '/admin/embedding/image-analysis/reanalyze-all',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (): Promise<ImageAnalysisActionResult> => {
      // Nulls every payload, so the next run spends one vision call per row.
      // `reanalyzeAllImages` owns the one-active-run rule it shares with text
      // Re-embed all and the #1116 shadow backfill, and throws a 409 the
      // app-level error handler forwards with its own sentence — the refusal
      // is the service's, not a second copy of the rule in a route.
      const rows = await reanalyzeAllImages();
      const alreadyRunning = await kickBatch();
      return ImageAnalysisActionResultSchema.parse({ rows, started: !alreadyRunning, alreadyRunning });
    },
  );
}

/**
 * Start a batch without waiting for it, and without letting its failure become
 * the request's. Answers whether a batch was ALREADY running when called.
 *
 * The verdict is a SAMPLE OF THE LOCK taken before the kick, not a report
 * from the batch: the detached run's own `alreadyRunning` arrives long after
 * the response has been sent. It is therefore inexact in BOTH directions, and
 * the guarantee is not one-sided — a lease taken between the read and the
 * kick (BullMQ's repeat, another replica) makes the detached batch a no-op
 * under `started: true`, and a lease released in that window lets the batch
 * run under `alreadyRunning: true`. Nothing is spent or lost either way: the
 * kick costs one Redis round trip and returns from the worker's own guard,
 * and both readings are corrected by the next poll — `running` is read from
 * the same lock and `lastRun` from what the batch actually recorded. What
 * the flag must never do is hold the request open to find out.
 */
async function kickBatch(): Promise<boolean> {
  const alreadyRunning = await isWorkerLocked(IMAGE_ANALYSIS_WORKER_LOCK);
  void runImageAnalysisBatch().catch((err: unknown) => {
    logger.error({ err }, 'Image analysis batch failed after an admin trigger');
  });
  return alreadyRunning;
}
