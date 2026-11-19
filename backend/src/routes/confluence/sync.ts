import { FastifyInstance } from 'fastify';
import { isConfluenceEnabled } from '../../core/services/confluence-integration.js';
import { startManualSync, getSyncStatus } from '../../domains/confluence/services/sync-service.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { requireGlobalPermission } from '../../core/utils/rbac-guards.js';

export async function syncRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /api/sync - trigger manual sync (gated by sync:trigger)
  fastify.post('/sync', { preHandler: requireGlobalPermission('sync:trigger') }, async (request, reply) => {
    const userId = request.userId;

    const status = await getSyncStatus(userId);
    if (status.status === 'syncing') {
      return reply.status(409).send({ message: 'Sync already in progress', status });
    }

    // Standalone mode (#1623): nothing syncs. Report it instead of flipping the
    // status to `syncing` and letting the background run settle it back to
    // `idle` — same response shape, no phantom progress, no audit event for a
    // sync that never ran.
    if (!(await isConfluenceEnabled(userId))) {
      return { message: 'Confluence integration is disabled', status };
    }

    // Claims the deployment-global sync lock the scheduler also holds (#1775),
    // then flips the status to `syncing` and detaches the run. While any other
    // run holds the lock — a concurrent request, another user's run or a
    // scheduled cycle — the request is refused and the status stays as read;
    // the message is the one relocate's sync guard gives for the same cause.
    const started = await startManualSync(userId, {
      onStarted: () => logAuditEvent(userId, 'SYNC_STARTED', 'sync', undefined, {}, request),
      onCompleted: () => logAuditEvent(userId, 'SYNC_COMPLETED', 'sync', undefined, {}),
    });
    if (!started) {
      return reply.status(409).send({
        message: 'A Confluence sync is currently running. Wait for it to finish and try again.',
        status,
      });
    }

    return { message: 'Sync started', status: await getSyncStatus(userId) };
  });

  // GET /api/sync/status
  fastify.get('/sync/status', async (request) => {
    return await getSyncStatus(request.userId);
  });
}
