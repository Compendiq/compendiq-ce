import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  LlmUsecaseSchema,
  UpdateUsecaseAssignmentsInputSchema,
  UsecaseDefaultSchema,
  VisionCapabilityDetailSchema,
  type LlmUsecase,
} from '@compendiq/contracts';
import { query, getPool } from '../../core/db/postgres.js';
import { resolveUsecase, resolveRerankUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import { bumpProviderCacheVersion } from '../../domains/llm/services/cache-bus.js';
import { emitLlmAudit } from '../../domains/llm/services/llm-audit-hook.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';
import {
  getVisionCapability,
  refreshVisionCapability,
  readVisionCapabilityDetail,
} from '../../domains/llm/services/model-capabilities.js';
import { getShadowMigrationState } from '../../domains/llm/services/shadow-migration-service.js';
import { logger } from '../../core/utils/logger.js';

const ADMIN_LIMIT = {
  config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } },
};

const USECASES: readonly LlmUsecase[] = ['chat', 'summary', 'quality', 'auto_tag', 'embedding', 'rerank'] as const;

/** #1184 — shared by the capability read and the manual re-probe. */
const NO_CHAT_PROVIDER =
  'No provider resolved for use case "chat". Configure one in Settings → AI Models.';

/**
 * The provider+model that `chat` currently resolves to, or null when nothing
 * is configured. Uses `resolveUsecase` so the capability routes always talk
 * about the same pair the post-save refresh probes.
 */
async function resolveChatPair(): Promise<{ providerId: string; model: string } | null> {
  const resolved = await resolveUsecase('chat').catch(() => null);
  return resolved ? { providerId: resolved.config.providerId, model: resolved.model } : null;
}

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
      // Rerank never inherits the default provider — unassigned means the
      // stage is disabled (#1104), which this route reports as 404 rather
      // than pretending the default provider serves /v1/rerank.
      resolved = usecase === 'rerank' ? await resolveRerankUsecase() : await resolveUsecase(usecase);
    } catch {
      resolved = null;
    }
    if (!resolved) {
      return reply.code(404).send({
        error: `No provider resolved for use case "${usecase}". Configure one in Settings → AI Models.`,
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
        // Rerank never falls back to the default provider — unassigned means
        // the stage is DISABLED (#1104), and showing the default here would
        // imply it serves rerank traffic. The empty sentinel renders as
        // "unset" in the settings grid.
        const resolved = u === 'rerank'
          ? await resolveRerankUsecase().catch(() => null)
          : await resolveUsecase(u).catch(() => null);
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
    async (req, reply) => {
      const updates = UpdateUsecaseAssignmentsInputSchema.parse(req.body);
      // #1116: while a shadow migration is in flight, the embedding
      // assignment is load-bearing migration state — embedPage's dual-write
      // resolves the LIVE model from it, and the swap captures it as the
      // rollback target. Repointing it mid-flight would silently change which
      // model the live column receives. Refuse until the migration ends.
      const embeddingPatch = updates.embedding;
      if (
        embeddingPatch
        && (Object.prototype.hasOwnProperty.call(embeddingPatch, 'providerId')
          || Object.prototype.hasOwnProperty.call(embeddingPatch, 'model'))
        && (await getShadowMigrationState()) !== null
      ) {
        return reply.code(409).send({
          error:
            'A shadow embedding migration is in progress — the embedding assignment is pinned until it swaps, rolls back or is cleaned up (#1116).',
          statusCode: 409,
        });
      }
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

  // ─── #1184: vision capability detail + manual re-probe ───────────────────
  //
  // Both routes are about `chat` specifically, spelled into the path rather
  // than taken as a `:usecase` parameter. Only `chat` ever resolves to a model
  // that will be asked to read an image; a probe aimed at an embedding
  // endpoint is a chat completion against the wrong API and would cache a
  // meaningless verdict. Same reasoning as the `usecase === 'chat'` guard on
  // `/llm/usecase-default` above.
  //
  // Both are `requireAdmin`. `probeError` is the provider's own error body
  // (see `llm-http-error.ts`) — third-party text that can echo request
  // fragments and internal topology — so it is reachable here and nowhere
  // else. `/llm/usecase-default` is authenticated but *not* admin-gated and
  // must never gain these fields.

  // GET /admin/llm-usecases/chat/vision-capability — the stored verdict plus
  // the evidence behind it, so the Settings badge can render `probed_at` and
  // `probe_error` on page load rather than only after a click. A pure cache
  // read: it never probes — it runs on every paint of Settings → AI Models.
  fastify.get(
    '/admin/llm-usecases/chat/vision-capability',
    { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT },
    async (_req, reply) => {
      const pair = await resolveChatPair();
      if (!pair) return reply.code(404).send({ error: NO_CHAT_PROVIDER });

      // No row means never probed — answer with nulls rather than 404ing, so
      // the badge renders "Unconfirmed" without special-casing an absent body.
      const detail = await readVisionCapabilityDetail(pair.providerId, pair.model);
      return VisionCapabilityDetailSchema.parse({
        providerId: pair.providerId,
        model: pair.model,
        vision: detail?.vision ?? null,
        probedAt: detail?.probedAt ?? null,
        probeError: detail?.probeError ?? null,
      });
    },
  );

  // POST /admin/llm-usecases/chat/reprobe-vision — force a fresh probe of the
  // resolved chat pair and answer with the new verdict.
  //
  // Blocking, like `POST /admin/llm-providers/:id/test`: the admin clicked a
  // button and is waiting for its answer. It goes through the queue and the
  // per-provider breaker, so a busy provider can make this slow — `maxTokens:
  // 64` keeps the probe itself short, but the client must not assume a
  // sub-second response.
  //
  // Deliberately `refreshVisionCapability` for the single pair, not
  // `invalidateProviderCapabilities` — the latter drops every verdict for the
  // provider, including models the admin did not ask about.
  fastify.post(
    '/admin/llm-usecases/chat/reprobe-vision',
    { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT },
    async (req, reply) => {
      const pair = await resolveChatPair();
      if (!pair) return reply.code(404).send({ error: NO_CHAT_PROVIDER });

      const detail = await refreshVisionCapability(pair.providerId, pair.model);
      emitLlmAudit({
        event: 'llm_vision_capability_reprobed',
        userId: req.userId,
        metadata: { providerId: pair.providerId, model: pair.model, vision: detail.vision },
      });
      return VisionCapabilityDetailSchema.parse({
        providerId: pair.providerId,
        model: pair.model,
        vision: detail.vision,
        probedAt: detail.probedAt,
        probeError: detail.probeError,
      });
    },
  );
}
