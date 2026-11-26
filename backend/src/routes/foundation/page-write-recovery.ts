import type { FastifyInstance } from 'fastify';
import {
  PAGE_WRITER_QUIESCE_RUNBOOK,
  PageWriteIntentParamSchema,
  PageWriteReconcileResultSchema,
  PageWriteReconcileSchema,
  PageWriteRecoveryQuerySchema,
  PageWriteRecoveryStateSchema,
  PageWriterFenceResultSchema,
  PageWriterFenceSchema,
  PageWriterQuiesceBlockedSchema,
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
  RuntimeQuiesceBlockedError,
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
  // A refusal leaves the gate closed. Only this admin route discloses the
  // blocking intent ids (#1934); the generic error handler never does.
  fastify.post('/admin/page-write-recovery/runtime/quiesce', async (request, reply) => {
    const { expectedRuntimeId, reason } = PageWriterQuiesceSchema.parse(request.body);
    const runtimeId = await getPageWriterRuntimeId();
    if (expectedRuntimeId !== runtimeId) {
      throw new PageWriteError(409, 'runtime_not_local', 'Target the backend process identified by this runtime before retiring it.');
    }
    try {
      return PageWriterQuiesceResultSchema.parse(await quiescePageWriterRuntime({
        actorId: request.userId,
        reason,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      }));
    } catch (error) {
      if (!(error instanceof RuntimeQuiesceBlockedError)) throw error;
      return reply.status(409).send(PageWriterQuiesceBlockedSchema.parse({
        error: error.name,
        reason: error.reason,
        code: error.reason,
        message: error.message,
        blockingIntents: error.blockingIntents,
        runbook: PAGE_WRITER_QUIESCE_RUNBOOK,
      }));
    }
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
