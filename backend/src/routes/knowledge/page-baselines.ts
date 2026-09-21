import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FreezePageRequestSchema,
  PageBaselineActivationRequestSchema,
  PageBaselineActivationStateSchema,
  PageBaselineEvidenceSchema,
  PageFreezeHistoryQuerySchema,
  PageFreezeHistoryResponseSchema,
  PageFreezePreviewResponseSchema,
  PageLifecycleMutationResponseSchema,
  UnfreezePageRequestSchema,
} from '@compendiq/contracts';
import {
  freezePage,
  getAdminBaselineHistory,
  getPageBaselineActivationState,
  getPageBaselineEvidence,
  getPageFreezeHistory,
  previewPageBaseline,
  readBaselineEvidenceAttachment,
  readFrozenBaselineMedia,
  setPageBaselineCreationEnabled,
  unfreezePage,
} from '../../core/services/page-baseline-service.js';

const PageIdParamsSchema = z.object({ id: z.coerce.number().int().positive() }).strict();
const BaselineParamsSchema = z.object({ baselineId: z.string().uuid() }).strict();
const AttachmentParamsSchema = BaselineParamsSchema.extend({
  attachmentIdentity: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
const BaselineMediaParamsSchema = PageIdParamsSchema.extend({
  baselineId: z.string().uuid(),
  identity: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export async function pageBaselineRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/pages/:id/freeze-preview', async (request) => {
    const { id } = PageIdParamsSchema.parse(request.params);
    return PageFreezePreviewResponseSchema.parse(
      await previewPageBaseline(id, request.userId),
    );
  });

  fastify.post('/pages/:id/freeze', async (request) => {
    const { id } = PageIdParamsSchema.parse(request.params);
    const body = FreezePageRequestSchema.parse(request.body);
    const state = await freezePage({ pageId: id, actorId: request.userId, ...body });
    return PageLifecycleMutationResponseSchema.parse({ state });
  });

  fastify.post('/pages/:id/unfreeze', async (request) => {
    const { id } = PageIdParamsSchema.parse(request.params);
    const body = UnfreezePageRequestSchema.parse(request.body);
    const state = await unfreezePage(id, request.userId, body);
    return PageLifecycleMutationResponseSchema.parse({ state });
  });

  fastify.get('/pages/:id/freeze-history', async (request) => {
    const { id } = PageIdParamsSchema.parse(request.params);
    const query = PageFreezeHistoryQuerySchema.parse(request.query);
    return PageFreezeHistoryResponseSchema.parse(
      await getPageFreezeHistory(id, request.userId, query),
    );
  });
  fastify.get('/pages/:id/baselines/:baselineId/media/:identity', async (request, reply) => {
    const { id, baselineId, identity } = BaselineMediaParamsSchema.parse(request.params);
    const attachment = await readFrozenBaselineMedia(
      id,
      baselineId,
      identity,
      request.userId,
    );
    reply
      .header('content-type', attachment.mediaType)
      .header('content-length', String(attachment.size))
      .header('content-security-policy', 'sandbox')
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'same-origin')
      .header('cache-control', 'private, no-store');
    return reply.send(attachment.stream);
  });

  fastify.get('/admin/page-baselines/activation', {
    onRequest: [fastify.requireAdmin],
  }, async (request) => PageBaselineActivationStateSchema.parse(
    await getPageBaselineActivationState(request.userId),
  ));

  fastify.put('/admin/page-baselines/activation', {
    onRequest: [fastify.requireAdmin],
  }, async (request) => {
    const body = PageBaselineActivationRequestSchema.parse(request.body);
    return PageBaselineActivationStateSchema.parse(
      await setPageBaselineCreationEnabled(request.userId, body.creationEnabled),
    );
  });

  fastify.get('/admin/page-baselines/:baselineId', {
    onRequest: [fastify.requireAdmin],
  }, async (request) => {
    const { baselineId } = BaselineParamsSchema.parse(request.params);
    return PageBaselineEvidenceSchema.parse(
      await getPageBaselineEvidence(baselineId, request.userId),
    );
  });

  fastify.get('/admin/page-baselines/:baselineId/history', {
    onRequest: [fastify.requireAdmin],
  }, async (request) => {
    const { baselineId } = BaselineParamsSchema.parse(request.params);
    const query = PageFreezeHistoryQuerySchema.parse(request.query);
    return PageFreezeHistoryResponseSchema.parse(
      await getAdminBaselineHistory(baselineId, request.userId, query),
    );
  });

  fastify.get('/admin/page-baselines/:baselineId/attachments/:attachmentIdentity', {
    onRequest: [fastify.requireAdmin],
  }, async (request, reply) => {
    const { baselineId, attachmentIdentity } = AttachmentParamsSchema.parse(request.params);
    const attachment = await readBaselineEvidenceAttachment(
      baselineId,
      attachmentIdentity,
      request.userId,
    );
    reply
      .header('content-type', attachment.mediaType)
      .header('content-length', String(attachment.size))
      .header('content-disposition', 'attachment')
      .header('content-security-policy', 'sandbox')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store');
    return reply.send(attachment.stream);
  });
}
