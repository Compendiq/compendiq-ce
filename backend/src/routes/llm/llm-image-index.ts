import type { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { logger } from '../../core/utils/logger.js';
import { columnTypeFor } from '../../core/db/vector-column-tier.js';
import { isWorkerLocked } from '../../core/services/redis-cache.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';
import { readImageIndexDimensions } from '../../domains/llm/services/image-embedding-index.js';
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
 * source, and it keeps THREE facts apart that a smaller payload would let a
 * reader infer from one another: whether the leg is assigned, what the column
 * is typed to, and what the last scan did. Assigned-with-an-empty-index is a
 * fresh assignment; unassigned-with-rows is a leg that was switched off, which
 * destroys nothing (ADR-025 D7); assigned-with-a-failed-run is an endpoint
 * problem the operator has to go and fix.
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
      const [resolved, rowsRes, pagesRes, dimensions, lastRun, running] = await Promise.all([
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
      kickScan();
      return { marked, started: true };
    },
  );

  fastify.post(
    '/admin/embedding/image-index/process',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async () => {
      kickScan();
      return { started: true };
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
 * the request's.
 *
 * A rejection here is already logged by the worker with its own context; this
 * catch exists so an unhandled rejection cannot take the process down on the
 * strength of a provider being briefly unreachable.
 */
function kickScan(): void {
  void processDirtyPageImages().catch((err) => {
    logger.error({ err }, 'Image index scan failed after an admin trigger');
  });
}
