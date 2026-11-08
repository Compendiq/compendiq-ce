import type { FastifyInstance } from 'fastify';
import {
  AiPolicyActivationRequestSchema,
  AiPolicyActivationStateSchema,
} from '@compendiq/contracts';
import {
  AiPolicyActivationError,
  getAiPolicyActivationState,
  setAiPolicyEnforcementEnabled,
} from '../../core/services/ai-policy-activation.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';

// Same dynamic admin bucket as routes/foundation/admin.ts (default 20/min).
const ADMIN_RATE_LIMIT = {
  config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } },
};

/**
 * Article AI policy enforcement switch (#1881). System administrators only;
 * authority is re-checked on the activation transaction (`users` row
 * `FOR SHARE`), so a demotion that beats the 30 s auth cache still answers
 * 403. Wire contract: `AiPolicyActivationStateSchema` on 200, 409
 * `ai_policy_activation_refused` with the observed blockers, 503
 * `ai_policy_activation_busy` on a lock timeout; a bad body is the global
 * Zod 400.
 */
export async function aiPolicyActivationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRequest', fastify.requireAdmin);

  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof AiPolicyActivationError) return reply.status(error.statusCode).send(error.body);
    throw error;
  });

  fastify.get('/admin/ai-policy/activation', ADMIN_RATE_LIMIT, async (request) =>
    AiPolicyActivationStateSchema.parse(await getAiPolicyActivationState(request.userId)));

  fastify.put('/admin/ai-policy/activation', ADMIN_RATE_LIMIT, async (request) => {
    const body = AiPolicyActivationRequestSchema.parse(request.body);
    return AiPolicyActivationStateSchema.parse(await setAiPolicyEnforcementEnabled(request.userId, body));
  });
}
