import type { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { logger } from '../../core/utils/logger.js';
import { columnTypeFor } from '../../core/db/vector-column-tier.js';
import { isWorkerLocked } from '../../core/services/redis-cache.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';
import {
  imageIndexIdentityFor,
  readImageIndexDimensions,
  readImageIndexIdentity,
} from '../../domains/llm/services/image-embedding-index.js';
import { getImageEmbeddingTargetDimensions } from '../../core/services/image-embedding-target-dimensions.js';
import { resolveImageEmbeddingUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import {
  IMAGE_INDEX_WORKER_LOCK,
  markAllPagesImageDirty,
  processDirtyPageImages,
  readImageIndexLastRun,
} from '../../domains/llm/services/image-embedding-service.js';
import type { ImageIndexStatus } from '@compendiq/contracts';

const ADMIN_RATE_LIMIT = {
  config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } },
};

/**
 * #1115 P2 — the image index's admin surface, behind `requireAdmin`.
 *
 * Three routes and one shape. `GET` is the Embeddings-tab card's whole data
 * source, and it keeps FOUR facts apart that a smaller payload would let a
 * reader infer from one another: whether the leg is assigned, what the column
 * is typed to, whether those two agree, and what the last scan did.
 * Assigned-with-an-empty-index is a fresh assignment; unassigned-with-rows is
 * a leg that was switched off, which destroys nothing (ADR-025 D7);
 * assigned-with-a-failed-run is an endpoint problem the operator has to go and
 * fix; and assigned-but-not-matching is the guarded-DDL branch, where the
 * assignment saved and the `ALTER` did not — the one state where the width on
 * screen belongs to a different model than the name beside it.
 *
 * Both actions are **fire-and-forget**. A corpus-wide scan runs for as long as
 * the corpus takes, and awaiting it inside the request would hold a connection
 * open past every proxy timeout in the path and then report a failure the work
 * did not have. The card polls `GET` for `running` instead — which is also why
 * `running` is read from the worker lock rather than inferred from
 * `pagesDirty`, a number that is non-zero for as long as any page is queued
 * whether or not anything is working through it.
 */
export async function llmImageIndexRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get(
    '/admin/embedding/image-index',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (): Promise<ImageIndexStatus> => {
      const [
        resolved,
        rowsRes,
        pagesRes,
        dimensions,
        lastRun,
        running,
        recordedIdentity,
        targetDimensions,
      ] = await Promise.all([
        resolveImageEmbeddingUsecase(),
        query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM page_image_embeddings`),
        query<{ dirty: string; total: string }>(
          `SELECT COUNT(*) FILTER (WHERE image_embedding_dirty)::text AS dirty,
                  COUNT(*)::text AS total
             FROM pages
            WHERE deleted_at IS NULL AND COALESCE(page_type, 'page') != 'folder'`,
        ),
        readImageIndexDimensions(),
        readImageIndexLastRun(),
        isWorkerLocked(IMAGE_INDEX_WORKER_LOCK),
        readImageIndexIdentity(),
        getImageEmbeddingTargetDimensions(),
      ]);

      return {
        assigned: resolved !== null,
        // Provider id and model NAME only. The base URL and the key belong to
        // the provider document; this is the index document (#1184's rule).
        identity: resolved
          ? {
              providerId: resolved.config.providerId,
              model: resolved.model,
              dimensions,
              tier: tierFor(dimensions),
            }
          : null,
        // …and, because `identity` above is deliberately two documents in one
        // line, whether they agree (review r1). They can disagree: the column
        // DDL is guarded, so a failed `ALTER` answers 200 and leaves the new
        // pair assigned against the old column and the old recorded width.
        // Reported rather than papered over — the card's remedy is Re-check,
        // and the only other symptom is a backlog that will not drain.
        identityMatchesAssignment:
          resolved === null || recordedIdentity === null
            ? null
            : recordedIdentity ===
              imageIndexIdentityFor({
                providerId: resolved.config.providerId,
                model: resolved.model,
                baseUrl: resolved.config.baseUrl,
                targetDimensions,
              }),
        rows: Number(rowsRes.rows[0]?.count ?? 0),
        pagesDirty: Number(pagesRes.rows[0]?.dirty ?? 0),
        pagesTotal: Number(pagesRes.rows[0]?.total ?? 0),
        running,
        lastRun,
      };
    },
  );

  fastify.post(
    '/admin/embedding/image-index/rescan',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async () => {
      const marked = await markAllPagesImageDirty();
      const alreadyRunning = await kickScan();
      return { marked, started: !alreadyRunning, alreadyRunning };
    },
  );

  fastify.post(
    '/admin/embedding/image-index/process',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async () => {
      const alreadyRunning = await kickScan();
      return { started: !alreadyRunning, alreadyRunning };
    },
  );
}

/**
 * The recorded width's index tier, or null when there is no usable width.
 *
 * `columnTypeFor` THROWS outside pgvector's range, and the width it is given
 * here comes from an `admin_settings` row that a restored dump, a psql session
 * or a future migration can set without passing through any schema. A status
 * read must not 500 because of it: the honest answer for "the recorded width
 * is not a width" is that the tier is unknown.
 */
function tierFor(dimensions: number | null): NonNullable<ImageIndexStatus['identity']>['tier'] {
  if (dimensions === null) return null;
  try {
    return columnTypeFor(dimensions).tier;
  } catch {
    return null;
  }
}

/**
 * Start a scan without waiting for it, and without letting its failure become
 * the request's. Answers whether a scan was ALREADY running when it was called.
 *
 * A rejection here is already logged by the worker with its own context; the
 * catch exists so an unhandled rejection cannot take the process down on the
 * strength of a provider being briefly unreachable.
 *
 * **The verdict is read from the lock, not from the worker** (review r2). The
 * run is detached, so its own `alreadyRunning` arrives long after the response
 * has been sent — and answering `started: true` regardless made the card toast
 * "scan started" for a trigger that did nothing. That matters beyond the
 * wording: an in-flight run advances its OFFSET over a result set a Re-scan
 * just grew, so pages marked ahead of that offset are not visited by it and
 * stay queued until the next trigger.
 *
 * It still kicks when the lock is held. The read and the kick are not atomic,
 * so a lock released in between would otherwise leave nothing running at all;
 * a kick that finds the lock still taken costs one Redis round trip and logs
 * its own line. The report is therefore pessimistic by construction — never
 * "started" for a scan that did not, sometimes "already running" for one that
 * then did.
 */
async function kickScan(): Promise<boolean> {
  const alreadyRunning = await isWorkerLocked(IMAGE_INDEX_WORKER_LOCK);
  void processDirtyPageImages().catch((err) => {
    logger.error({ err }, 'Image index scan failed after an admin trigger');
  });
  return alreadyRunning;
}
