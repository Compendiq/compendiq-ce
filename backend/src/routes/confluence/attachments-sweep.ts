import type { FastifyInstance } from 'fastify';
import {
  AttachmentSweepTriggerSchema,
  type AttachmentStorageStats,
  type AttachmentSweepStatus,
  type AttachmentSweepTriggerResponse,
} from '@compendiq/contracts';
import { logger } from '../../core/utils/logger.js';
import { isWorkerLocked } from '../../core/services/redis-cache.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';
import {
  ATTACHMENT_SWEEP_WORKER_LOCK,
  readAttachmentStorageStatsRecord,
  readAttachmentSweepLastRun,
  runAttachmentSweep,
} from '../../domains/confluence/services/attachment-sweep-service.js';

const ADMIN_RATE_LIMIT = {
  config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } },
};

/**
 * #1349 — the attachment stores' admin surface, behind `requireAdmin`.
 *
 * Three routes, all backed by the persisted record. `GET /stats` NEVER walks
 * the tree or reconciles: the Spaces & Sync card polls it every 5 seconds,
 * and on a large corpus a walk takes minutes — a fresh figure is obtained by
 * pressing Dry run, which is the POST. Both actions are fire-and-forget
 * behind a 202 (the llm-image-index pattern): awaiting a multi-minute walk
 * inside the request would out-live every proxy timeout in the path and then
 * report a failure the work did not have. The card polls `running`, which is
 * read from the worker LOCK rather than inferred from anything the response
 * could claim.
 *
 * A sibling of `attachments.ts` rather than more routes inside it: that file
 * is the user-facing byte reader/writer, this one is operator machinery, and
 * a mock harness for one should not have to stub the other's Confluence
 * client plumbing. Same boundary either way — `routes/confluence` may import
 * `core` + the confluence domain (#1347).
 */
export async function attachmentSweepRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get(
    '/admin/attachments/stats',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (): Promise<AttachmentStorageStats> => {
      const [record, running] = await Promise.all([
        readAttachmentStorageStatsRecord(),
        isWorkerLocked(ATTACHMENT_SWEEP_WORKER_LOCK),
      ]);
      return {
        computedAt: record?.at ?? null,
        running,
        stores: record?.stores ?? null,
        missingLocalFiles: record?.missingLocalFiles ?? null,
      };
    },
  );

  fastify.get(
    '/admin/attachments/sweep',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (): Promise<AttachmentSweepStatus> => {
      const [lastRun, running] = await Promise.all([
        readAttachmentSweepLastRun(),
        isWorkerLocked(ATTACHMENT_SWEEP_WORKER_LOCK),
      ]);
      return { running, lastRun };
    },
  );

  fastify.post(
    '/admin/attachments/sweep',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply): Promise<AttachmentSweepTriggerResponse> => {
      const { dryRun } = AttachmentSweepTriggerSchema.parse(request.body);
      // The verdict is read from the lock, not from the detached run (the
      // kickScan rule): the run's own `alreadyRunning` arrives long after the
      // response. A DRY trigger still kicks when the lock is held — the read
      // and the kick are not atomic, and a lock released in between must not
      // leave nothing running; a redundant kick answers `alreadyRunning` for
      // one Redis round trip (kickScan's precedent, which is also a scan). A
      // LIVE trigger under a held lock does NOT kick (review r3): the response
      // just said the delete did not start and the card toasts exactly that,
      // so a kick that then wins the lock race would run a destructive sweep
      // the operator was told was a no-op. Silently not-running is the honest
      // outcome for a destructive trigger; pressing again is the remedy.
      // Pessimistic by construction: never "started" for a sweep that did not
      // start.
      const alreadyRunning = await isWorkerLocked(ATTACHMENT_SWEEP_WORKER_LOCK);
      if (!alreadyRunning || dryRun) {
        void runAttachmentSweep({ dryRun }).catch((err) => {
          logger.error({ err, dryRun }, 'Attachment sweep failed after an admin trigger');
        });
      }
      reply.code(202);
      return { started: !alreadyRunning, alreadyRunning };
    },
  );
}
