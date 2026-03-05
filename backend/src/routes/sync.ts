import { FastifyInstance } from 'fastify';
import { syncUser, getSyncStatus } from '../services/sync-service.js';
import { logAuditEvent } from '../services/audit-service.js';
import { logger } from '../utils/logger.js';

export async function syncRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /api/sync - trigger manual sync
  fastify.post('/sync', async (request, reply) => {
    const userId = request.userId;

    const status = getSyncStatus(userId);
    if (status.status === 'syncing') {
      return reply.status(409).send({ message: 'Sync already in progress', status });
    }

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
