import type { FastifyInstance } from 'fastify';
import { UpdateUsecaseAssignmentsInputSchema, type LlmUsecase } from '@compendiq/contracts';
import { query, getPool } from '../../core/db/postgres.js';
import { resolveUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import { bumpProviderCacheVersion } from '../../domains/llm/services/cache-bus.js';
import { emitLlmAudit } from '../../domains/llm/services/llm-audit-hook.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';

const ADMIN_LIMIT = {
  config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } },
};

const USECASES: readonly LlmUsecase[] = ['chat', 'summary', 'quality', 'auto_tag', 'embedding'] as const;

export async function llmUsecaseRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

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
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        for (const u of USECASES) {
          const patch = updates[u];
          if (!patch) continue;
          const hasProvider = Object.prototype.hasOwnProperty.call(patch, 'providerId');
          const hasModel = Object.prototype.hasOwnProperty.call(patch, 'model');
          if (!hasProvider && !hasModel) continue;

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
      bumpProviderCacheVersion();
      emitLlmAudit({
        event: 'llm_usecase_assignments_updated',
        userId: req.userId,
        metadata: { usecases: Object.keys(updates) },
      });
      return { ok: true };
    },
  );
}
