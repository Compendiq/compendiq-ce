import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  LlmProviderInputSchema,
  LlmProviderUpdateSchema,
} from '@compendiq/contracts';
import {
  listProviders,
  getProviderById,
  createProvider,
  updateProvider,
  deleteProvider,
  setDefaultProvider,
} from '../../domains/llm/services/llm-provider-service.js';
import {
  checkHealth,
  listModels as clientListModels,
} from '../../domains/llm/services/openai-compatible-client.js';
import { emitLlmAudit } from '../../domains/llm/services/llm-audit-hook.js';
import {
  validateUrl,
  addAllowedBaseUrl,
  removeAllowedBaseUrl,
  SsrfError,
} from '../../core/utils/ssrf-guard.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';

const ADMIN_RATE_LIMIT = {
  config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } },
};

const IdParamsSchema = z.object({ id: z.string().uuid() });

export async function llmProviderRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /admin/llm-providers — list all providers (api_key masked to `hasApiKey`/`keyPreview`)
  fastify.get(
    '/admin/llm-providers',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async () => {
      return listProviders();
    },
  );

  // POST /admin/llm-providers — create a new provider
  fastify.post(
    '/admin/llm-providers',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const input = LlmProviderInputSchema.parse(request.body);
      // Allowlist BEFORE validating so private-network LLM endpoints
      // (LM Studio / Ollama on the LAN, on-prem vLLM, etc.) aren't rejected
      // by the SSRF guard. Mirrors the Confluence test-connection flow.
      // Protocol restrictions (HTTP/HTTPS only) still apply post-allowlist
      // because validateUrl() runs the protocol check before short-circuiting
      // on the allowlist.
      addAllowedBaseUrl(input.baseUrl);
      try {
        validateUrl(input.baseUrl);
      } catch (err) {
        removeAllowedBaseUrl(input.baseUrl);
        if (err instanceof SsrfError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
      let provider;
      try {
        provider = await createProvider(input);
      } catch (err) {
        // DB write failed (e.g. unique-name violation) — revoke the
        // speculative allowlist entry so it doesn't outlive the failed row.
        removeAllowedBaseUrl(input.baseUrl);
        throw err;
      }
      emitLlmAudit({
        event: 'llm_provider_created',
        userId: request.userId,
        metadata: { providerId: provider.id, name: provider.name },
      });
      reply.code(201);
      return provider;
    },
  );

  // PATCH /admin/llm-providers/:id — partial update
  fastify.patch(
    '/admin/llm-providers/:id',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const { id } = IdParamsSchema.parse(request.params);
      const patch = LlmProviderUpdateSchema.parse(request.body);
      if (patch.baseUrl) {
        // Same allowlist-before-validate ordering as POST so private-network
        // base URLs can be patched in. Revoke on any downstream failure.
        addAllowedBaseUrl(patch.baseUrl);
        try {
          validateUrl(patch.baseUrl);
        } catch (err) {
          removeAllowedBaseUrl(patch.baseUrl);
          if (err instanceof SsrfError) {
            return reply.code(400).send({ error: err.message });
          }
          throw err;
        }
      }
      let updated;
      try {
        updated = await updateProvider(id, patch);
      } catch (err) {
        if (patch.baseUrl) removeAllowedBaseUrl(patch.baseUrl);
        throw err;
      }
      if (!updated) {
        if (patch.baseUrl) removeAllowedBaseUrl(patch.baseUrl);
        return reply.code(404).send({ error: 'Provider not found' });
      }
      emitLlmAudit({
        event: 'llm_provider_updated',
        userId: request.userId,
        metadata: { providerId: id, fields: Object.keys(patch) },
      });
      return updated;
    },
  );

  // DELETE /admin/llm-providers/:id — delete (409 if referenced or default)
  fastify.delete(
    '/admin/llm-providers/:id',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const { id } = IdParamsSchema.parse(request.params);
      try {
        await deleteProvider(id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'delete failed';
        // Map to 409 Conflict when:
        //   - our service layer rejected (default provider or use-case reference)
        //   - PostgreSQL raises a foreign-key violation (23503) from a race
        //     between DELETE and a concurrent usecase-assignment INSERT.
        const pgCode = (err as { code?: unknown })?.code;
        if (pgCode === '23503' || /default|referenced/i.test(msg)) {
          return reply.code(409).send({ error: msg });
        }
        throw err;
      }
      emitLlmAudit({
        event: 'llm_provider_deleted',
        userId: request.userId,
        metadata: { providerId: id },
      });
      return { ok: true };
    },
  );

  // POST /admin/llm-providers/:id/set-default — mark as default
  fastify.post(
    '/admin/llm-providers/:id/set-default',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const { id } = IdParamsSchema.parse(request.params);
      try {
        await setDefaultProvider(id);
      } catch {
        return reply.code(404).send({ error: 'Provider not found' });
      }
      emitLlmAudit({
        event: 'llm_provider_set_default',
        userId: request.userId,
        metadata: { providerId: id },
      });
      return { ok: true };
    },
  );

  // POST /admin/llm-providers/:id/test — health-check + sample model count
  fastify.post(
    '/admin/llm-providers/:id/test',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const { id } = IdParamsSchema.parse(request.params);
      const cfg = await getProviderById(id);
      if (!cfg) return reply.code(404).send({ error: 'Provider not found' });
      const health = await checkHealth({
        providerId: cfg.id,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        authType: cfg.authType,
        verifySsl: cfg.verifySsl,
      });
      let sampleModelsCount = 0;
      if (health.connected) {
        const models = await clientListModels({
          providerId: cfg.id,
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          authType: cfg.authType,
          verifySsl: cfg.verifySsl,
        });
        sampleModelsCount = models.length;
      }
      return { ...health, sampleModelsCount };
    },
  );

  // GET /admin/llm-providers/:id/models — list upstream models for a provider
  fastify.get(
    '/admin/llm-providers/:id/models',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const { id } = IdParamsSchema.parse(request.params);
      const cfg = await getProviderById(id);
      if (!cfg) return reply.code(404).send({ error: 'Provider not found' });
      return clientListModels({
        providerId: cfg.id,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        authType: cfg.authType,
        verifySsl: cfg.verifySsl,
      });
    },
  );
}
