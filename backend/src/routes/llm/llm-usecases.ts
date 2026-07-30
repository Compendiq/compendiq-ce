import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LlmUsecaseSchema, UpdateUsecaseAssignmentsInputSchema, UsecaseDefaultSchema, type LlmUsecase } from '@compendiq/contracts';
import { query, getPool } from '../../core/db/postgres.js';
import { resolveUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import { bumpProviderCacheVersion } from '../../domains/llm/services/cache-bus.js';
import { emitLlmAudit } from '../../domains/llm/services/llm-audit-hook.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';
import { getVisionCapability, refreshVisionCapability } from '../../domains/llm/services/model-capabilities.js';
import { logger } from '../../core/utils/logger.js';

const ADMIN_LIMIT = {
  config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } },
};

const USECASES: readonly LlmUsecase[] = ['chat', 'summary', 'quality', 'auto_tag', 'embedding'] as const;

export async function llmUsecaseRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /llm/usecase-default?usecase=chat — non-admin: resolved default for a
  // single use case. Used by the AI chat input pane to pre-fill its model
  // selector with the admin-configured chat default (#355). Returns the same
  // shape that resolveUsecase produces, excluding the raw assignment row.
  fastify.get('/llm/usecase-default', async (req, reply) => {
    const { usecase } = z.object({ usecase: LlmUsecaseSchema }).parse(req.query);
    let resolved;
    try {
      resolved = await resolveUsecase(usecase);
    } catch {
      return reply.code(404).send({
        error: `No provider resolved for use case "${usecase}". Configure one in Settings → LLM.`,
      });
    }

    // #1154: read-only — never blocks on a probe, so AiContext's mount-time
    // fetch is not gated on an LLM round-trip.
    //
    // Only `chat` has a vision question to answer. `getVisionCapability`
    // schedules a background chat-completion probe on a miss, so asking it
    // about `embedding` would fire one at an embeddings endpoint and cache a
    // meaningless `false`. The app only ever requests `chat`, but this route
    // is reachable by any authenticated user with any use case in the query.
    const vision = usecase === 'chat'
      ? await getVisionCapability(resolved.config.providerId, resolved.model)
      : null;
    return UsecaseDefaultSchema.parse({
      usecase,
      providerId: resolved.config.providerId,
      providerName: resolved.config.name,
      model: resolved.model,
      vision,
    });
  });

  // GET /admin/llm-usecases — return all 5 use-cases with raw + resolved values.
  fastify.get(
    '/admin/llm-usecases',
    { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT },
    async () => {
      const rawRows = await query<{ usecase: LlmUsecase; provider_id: string | null; model: string | null }>(
        `SELECT usecase, provider_id, model FROM llm_usecase_assignments`,
      );
      const raw = new Map(rawRows.rows.map(r => [r.usecase, r]));
      const out: Record<string, unknown> = {};
      for (const u of USECASES) {
        const resolved = await resolveUsecase(u).catch(() => null);
        out[u] = {
          providerId: raw.get(u)?.provider_id ?? null,
          model: raw.get(u)?.model ?? null,
          resolved: resolved
            ? {
                providerId: resolved.config.providerId,
                providerName: resolved.config.name,
                model: resolved.model,
              }
            : { providerId: '00000000-0000-0000-0000-000000000000', providerName: '', model: '' },
        };
      }
      return out;
    },
  );

  // PUT /admin/llm-usecases — upsert one or more use-case assignments.
  // Tri-state per field: undefined=leave, null=clear, value=set.
  fastify.put(
    '/admin/llm-usecases',
    { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT },
    async (req) => {
      const updates = UpdateUsecaseAssignmentsInputSchema.parse(req.body);
      // #1154: whether this save actually moved the `chat` assignment. Saving
      // only, say, `embedding` must not fire a vision probe.
      let chatAssignmentChanged = false;
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        for (const u of USECASES) {
          const patch = updates[u];
          if (!patch) continue;
          const hasProvider = Object.prototype.hasOwnProperty.call(patch, 'providerId');
          const hasModel = Object.prototype.hasOwnProperty.call(patch, 'model');
          if (!hasProvider && !hasModel) continue;
          if (u === 'chat') chatAssignmentChanged = true;

          // Load existing row (if any) so we can fill in untouched fields.
          const existing = await client.query<{ provider_id: string | null; model: string | null }>(
            `SELECT provider_id, model FROM llm_usecase_assignments WHERE usecase = $1`,
            [u],
          );
          const prev = existing.rows[0];

          const nextProviderId = hasProvider ? (patch.providerId ?? null) : (prev?.provider_id ?? null);
          const nextModel = hasModel ? (patch.model ?? null) : (prev?.model ?? null);

          await client.query(
            `INSERT INTO llm_usecase_assignments (usecase, provider_id, model, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (usecase) DO UPDATE
               SET provider_id = EXCLUDED.provider_id,
                   model       = EXCLUDED.model,
                   updated_at  = NOW()`,
            [u, nextProviderId, nextModel],
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      await bumpProviderCacheVersion();
      // #1154: refresh the capability verdict for the newly assigned
      // provider+model so Settings shows it immediately. Fire-and-forget —
      // the admin's save must not wait on an LLM round-trip, and the read
      // path probes lazily if this hasn't landed yet. Only when the save
      // touched `chat`: nothing else resolves to a model that will ever be
      // asked to read an image.
      if (chatAssignmentChanged) {
        void resolveUsecase('chat')
          .then((r) => refreshVisionCapability(r.config.providerId, r.model))
          .catch((err) => logger.warn({ err }, 'Post-save vision probe failed'));
      }
      emitLlmAudit({
        event: 'llm_usecase_assignments_updated',
        userId: req.userId,
        metadata: { usecases: Object.keys(updates) },
      });
      return { ok: true };
    },
  );
}
