import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  BulkUpdatePageAiPolicySchema,
  UpdatePageAiPolicySchema,
  type PageAiPolicyResponse,
} from '@compendiq/contracts';
import {
  updatePageAiPolicies,
  type AiPolicyMutationResult,
  type AiPolicyRefusal,
} from '../../core/services/ai-policy-service.js';

const PageIdParamSchema = z.object({ id: z.coerce.number().int().positive() });

function toResponse(row: { pageId: number; policy: string; revision: number }): PageAiPolicyResponse {
  return { pageId: row.pageId, aiPolicy: row.policy as PageAiPolicyResponse['aiPolicy'], aiPolicyRevision: row.revision };
}

/**
 * The frozen policy refusal bodies, answered by the page create/update
 * routes too (they share this ONE serializer so the wire contract cannot
 * drift between `PUT /pages/:id/ai-policy` and `PUT /pages/:id`).
 */
export function sendAiPolicyRefusal(reply: FastifyReply, err: AiPolicyRefusal) {
  const body: Record<string, unknown> = { ...err.body, message: err.message };
  return reply.status(err.statusCode).send(body);
}

/**
 * Frozen error shapes (#280): 404 for an inaccessible/missing page,
 * 403 `ai_policy_denied`, 409 `ai_policy_conflict` (stale revision),
 * 409 `ai_policy_enforcement_unavailable` (foundation-only deployment).
 */
export function sendAiPolicyFailure(reply: FastifyReply, result: Extract<AiPolicyMutationResult, { ok: false }>) {
  switch (result.reason) {
    case 'not_found':
      return reply.status(404).send({ error: 'Page not found', pageIds: result.pageIds });
    case 'not_authorized':
      return reply.status(403).send({ error: 'ai_policy_denied', pageIds: result.pageIds });
    case 'enforcement_unavailable':
      return reply.status(409).send({
        error: 'ai_policy_enforcement_unavailable',
        message: 'Restrictive AI policies require the enterprise enforcement component.',
        pageIds: result.pageIds,
      });
    case 'stale_revision':
      return reply.status(409).send({ error: 'ai_policy_conflict', reason: 'stale_revision', pageIds: result.pageIds });
    // #281 review: the direct setter is a label writer and runs under the
    // page-write fence, so it answers the fence's own refusals.
    case 'page_is_frozen':
      return reply.status(423).send({ error: 'page_is_frozen', pageIds: result.pageIds });
    case 'page_write_busy':
      return reply.status(409).send({
        error: 'page_write_busy',
        message: 'Another external page write is unresolved',
        pageIds: result.pageIds,
      });
  }
}

/**
 * Article AI policy mutation endpoints (SPEC-CORE-003). Changes are
 * observable through the inert `emitAiPolicyEvent` sink.
 */
export async function pageAiPolicyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.put('/pages/:id/ai-policy', async (request, reply) => {
    const { id } = PageIdParamSchema.parse(request.params);
    const body = UpdatePageAiPolicySchema.parse(request.body);
    const result = await updatePageAiPolicies(request.userId, body.aiPolicy, [
      { pageId: id, expectedRevision: body.expectedRevision },
    ]);
    if (!result.ok) return sendAiPolicyFailure(reply, result);
    return toResponse(result.rows[0]!);
  });

  // All-or-nothing: any stale, missing or unauthorized row leaves every row unchanged.
  fastify.post('/pages/bulk/ai-policy', async (request, reply) => {
    const body = BulkUpdatePageAiPolicySchema.parse(request.body);
    const result = await updatePageAiPolicies(request.userId, body.aiPolicy, body.items);
    if (!result.ok) return sendAiPolicyFailure(reply, result);
    return { items: result.rows.map(toResponse) };
  });
}
