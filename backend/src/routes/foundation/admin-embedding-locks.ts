/**
 * Admin-only visibility + escape-hatch routes for per-user embedding locks.
 * Scope: issue #257, plan §2.10.
 *
 * Endpoints:
 *   - `GET  /api/admin/embedding/locks`              — list all active locks
 *   - `POST /api/admin/embedding/locks/:userId/release` — force-release (audited)
 *
 * Both are admin-only (`fastify.requireAdmin`) and rate-limited with the
 * shared admin bucket. The list endpoint is polled by the admin UI every
 * 5 s; the release endpoint is behind a confirm modal on the frontend.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listActiveEmbeddingLocks,
  forceReleaseEmbeddingLock,
} from '../../core/services/redis-cache.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';

const ADMIN_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: async () => (await getRateLimits()).admin.max,
      timeWindow: '1 minute',
    },
  },
};

const UserIdParam = z.object({ userId: z.string().min(1).max(256) });

/**
 * The synthetic `__reembed_all__` lock is held by the reembed-all worker
 * (plan §2.3). It is NOT a real user and is hidden from the admin UI, which
 * learns about the global run via the reembed job-status endpoint instead.
 */
const REEMBED_SYSTEM_LOCK_USER = '__reembed_all__';

export async function adminEmbeddingLocksRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET — list all per-user locks. Admin-only.
  fastify.get(
    '/admin/embedding/locks',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async () => {
      const locks = (await listActiveEmbeddingLocks()).filter(
        (l) => l.userId !== REEMBED_SYSTEM_LOCK_USER,
      );
      return { locks };
    },
  );

  // POST — admin escape hatch. Audit-logged on every call, including
  // idempotent no-ops so deliberate releases on already-gone locks are
  // observable in the audit trail.
  fastify.post(
    '/admin/embedding/locks/:userId/release',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request) => {
      const { userId } = UserIdParam.parse(request.params);

      const result = await forceReleaseEmbeddingLock(userId);

      await logAuditEvent(
        request.userId,
        'ADMIN_ACTION',
        'embedding_lock',
        userId,
        {
          action: 'force_release_embedding_lock',
          targetUserId: userId,
          released: result.released,
          previousHolderEpoch: result.previousHolderEpoch,
        },
        request,
      );

      // Idempotent — 200 with released:false when the lock was already gone.
      return { released: result.released, userId };
    },
  );
}
