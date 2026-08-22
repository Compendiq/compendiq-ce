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
  acquireAttachmentSweepLock,
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
      // The verdict IS the acquisition (review, external round): the route
      // takes the worker lock itself — one atomic SET NX — and hands the token
      // to the detached run, which owns it from there (refresh + release).
      // The earlier shape read the lock advisorily and let the run acquire on
      // its own, so two concurrent triggers could both be answered
      // `started: true` while the loser's `null` return vanished into the
      // fire-and-forget — the invariant below held per response and lied
      // across the pair. Deriving `started` from the acquire closes that, and
      // it retires the old redundant DRY kick with it: a lost acquire means
      // the lock really was held at that instant, so there is no
      // read-to-kick window left for the redundancy to paper over. A LIVE
      // trigger that loses likewise does not kick (review r3): the response
      // just said the delete did not start and the card toasts exactly that;
      // pressing again is the remedy. Pessimistic by construction: never
      // "started" for a sweep that did not start.
      const token = await acquireAttachmentSweepLock();
      if (token) {
        void runAttachmentSweep({ dryRun, token }).catch((err) => {
          logger.error({ err, dryRun }, 'Attachment sweep failed after an admin trigger');
        });
      }
      reply.code(202);
      return { started: token !== null, alreadyRunning: token === null };
    },
  );
}
