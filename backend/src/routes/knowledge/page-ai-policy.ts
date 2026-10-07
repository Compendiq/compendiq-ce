import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BulkUpdatePageAiPolicySchema, UpdatePageAiPolicySchema } from '@compendiq/contracts';
import { updatePageAiPolicies, type AiPolicyMutationResult } from '../../core/services/ai-policy-service.js';

const PageIdParamSchema = z.object({ id: z.coerce.number().int().positive() });

function failureBody(result: Extract<AiPolicyMutationResult, { ok: false }>) {
  if (result.reason === 'enforcement_unavailable') {
    return {
      error: 'ai_policy_enforcement_unavailable',
      message: 'Restrictive AI policies require the enterprise enforcement component.',
      pageIds: result.pageIds,
    };
  }
  return { error: 'ai_policy_conflict', reason: result.reason, pageIds: result.pageIds };
}

/**
 * Article AI policy mutation endpoints (SPEC-CORE-003). Changes are
 * observable through the inert `emitAiPolicyEvent` sink.
 */
export async function pageAiPolicyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.put('/pages/:id/ai-policy', async (request, reply) => {
    const { id } = PageIdParamSchema.parse(request.params);
    const body = UpdatePageAiPolicySchema.parse(request.body);
    const result = await updatePageAiPolicies(request.userId, body.policy, [
      { pageId: id, expectedRevision: body.expectedRevision },
    ]);
    if (!result.ok) {
      if (result.reason === 'not_found') return reply.status(404).send({ error: 'Page not found' });
      if (result.reason === 'not_authorized') {
        return reply.status(403).send({ error: 'Not authorized to change this page\'s AI policy' });
      }
      return reply.status(409).send(failureBody(result));
    }
    return result.rows[0]!;
  });

  // All-or-nothing: any stale, missing or unauthorized row leaves every row unchanged.
  fastify.post('/pages/bulk/ai-policy', async (request, reply) => {
    const body = BulkUpdatePageAiPolicySchema.parse(request.body);
    const result = await updatePageAiPolicies(request.userId, body.policy, body.items);
    if (!result.ok) return reply.status(409).send(failureBody(result));
    return { items: result.rows };
  });
}
