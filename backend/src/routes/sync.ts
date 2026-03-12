import { FastifyInstance } from 'fastify';
import { syncUser, getSyncStatus, setSyncStatus } from '../domains/confluence/services/sync-service.js';
import { logAuditEvent } from '../core/services/audit-service.js';
import { logger } from '../core/utils/logger.js';

export async function syncRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /api/sync - trigger manual sync
  fastify.post('/sync', async (request, reply) => {
    const userId = request.userId;

    const status = getSyncStatus(userId);
    if (status.status === 'syncing') {
      return reply.status(409).send({ message: 'Sync already in progress', status });
    }

    // Set status to syncing immediately so the response reflects it
    // and the frontend can start polling right away
    setSyncStatus(userId, { userId, status: 'syncing' });

    await logAuditEvent(userId, 'SYNC_STARTED', 'sync', undefined, {}, request);

    // Run sync in background, return immediately
    syncUser(userId).then(async () => {
      await logAuditEvent(userId, 'SYNC_COMPLETED', 'sync', undefined, {});
    }).catch((err) => {
      logger.error({ err, userId }, 'Manual sync failed');
    });

    return { message: 'Sync started', status: getSyncStatus(userId) };
  });

  // GET /api/sync/status
  fastify.get('/sync/status', async (request) => {
    return getSyncStatus(request.userId);
  });
}
