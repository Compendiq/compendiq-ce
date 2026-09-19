import type { FastifyInstance } from 'fastify';
import {
  PageWriteIntentParamSchema,
  PageWriteReconcileResultSchema,
  PageWriteReconcileSchema,
  PageWriteRecoveryQuerySchema,
  PageWriteRecoveryStateSchema,
  PageWriterFenceResultSchema,
  PageWriterFenceSchema,
  PageWriterQuiesceResultSchema,
  PageWriterQuiesceSchema,
  PageWriterRuntimeParamSchema,
} from '@compendiq/contracts';
import { query } from '../../core/db/postgres.js';
import {
  fencePageWriterRuntime,
  getPageWriteRecoveryState,
  getPageWriterRuntimeId,
  PageWriteError,
  quiescePageWriterRuntime,
  reconcilePageWriteIntent,
} from '../../core/services/page-write-admission.js';

/** Recovery is deployment administration, never authority inherited from a page. */
export async function pageWriteRecoveryRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.requireAdmin);
  fastify.addHook('preHandler', async (request) => {
    const actor = await query(
      "SELECT 1 FROM users WHERE id = $1 AND role = 'admin' AND deactivated_at IS NULL",
      [request.userId],
    );
    if (actor.rows.length === 0) {
      throw new PageWriteError(403, 'recovery_admin_required', 'An active system administrator is required.');
    }
  });

  fastify.get('/admin/page-write-recovery', async (request) => {
    const { pageId } = PageWriteRecoveryQuerySchema.parse(request.query);
    const state = await getPageWriteRecoveryState(pageId);
    return PageWriteRecoveryStateSchema.parse({
      limitPerCollection: 500,
      truncated: state.truncated,
      intents: state.intents.map((intent) => ({
        id: intent.id,
        runtimeId: intent.runtimeId,
        pageIds: intent.pageIds,
        kind: intent.kind,
        createdAt: intent.createdAt,
        effectStartedAt: intent.effectStartedAt,
        effectFinishedAt: intent.effectFinishedAt,
        remoteEffectStartedAt: intent.remoteEffectStartedAt,
        remoteEffectsCompletedAt: intent.remoteEffectsCompletedAt,
        recoveryStartedAt: intent.recoveryStartedAt,
        recoveryMode: intent.recoveryMode,
      })),
      admissions: state.admissions.map((admission) => ({
        id: admission.id,
        runtimeId: admission.runtimeId,
        pageId: admission.pageId,
        lifecycleRevision: admission.lifecycleRevision,
        admittedAt: admission.admittedAt,
      })),
      runtimes: state.runtimes,
    });
  });

  // This retires the receiving process's write gate. It is NOT a remote proof
  // submission, a force-clear, or a substitute for removing the pod from service.
  fastify.post('/admin/page-write-recovery/runtime/quiesce', async (request) => {
    const { expectedRuntimeId, reason } = PageWriterQuiesceSchema.parse(request.body);
    const runtimeId = await getPageWriterRuntimeId();
    if (expectedRuntimeId !== runtimeId) {
      throw new PageWriteError(409, 'runtime_not_local', 'Target the backend process identified by this runtime before retiring it.');
    }
    // Audit the requested retirement durably BEFORE closing the gate. A failure
    // here must not retire an unrecorded process; no success is claimed by this row.
    await query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, ip_address, user_agent)
       VALUES ($1, 'ADMIN_ACTION', 'page_writer_runtime', $2, $3::jsonb, $4, $5)`,
      [
        request.userId,
        runtimeId,
        JSON.stringify({ action: 'page_writer_quiesce_requested', reason }),
        request.ip,
        request.headers['user-agent'] ?? null,
      ],
    );
    return PageWriterQuiesceResultSchema.parse(await quiescePageWriterRuntime());
  });

  fastify.post('/admin/page-write-recovery/runtimes/:runtimeId/fence', async (request) => {
    const { runtimeId } = PageWriterRuntimeParamSchema.parse(request.params);
    const fence = PageWriterFenceSchema.parse(request.body);
    return PageWriterFenceResultSchema.parse(await fencePageWriterRuntime({
      ...fence, runtimeId, actorId: request.userId,
    }));
  });

  fastify.post('/admin/page-write-recovery/intents/:intentId/reconcile', async (request) => {
    const { intentId } = PageWriteIntentParamSchema.parse(request.params);
    const { reason } = PageWriteReconcileSchema.parse(request.body);
    return PageWriteReconcileResultSchema.parse(await reconcilePageWriteIntent(intentId, {
      actorId: request.userId, reason,
    }));
  });
}
