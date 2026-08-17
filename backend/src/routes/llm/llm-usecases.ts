import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  LlmUsecaseSchema,
  UpdateUsecaseAssignmentsInputSchema,
  UsecaseDefaultSchema,
  VisionCapabilityDetailSchema,
  ImageEmbeddingProbeSchema,
  type LlmUsecase,
} from '@compendiq/contracts';
import { query, getPool } from '../../core/db/postgres.js';
import {
  resolveUsecase,
  resolveRerankUsecase,
  resolveImageEmbeddingUsecase,
  resolveConfidenceBasisPair,
  loadProviderConfig,
  type ConfidenceBasisResolution,
} from '../../domains/llm/services/llm-provider-resolver.js';
import {
  probeImageEmbedding,
  persistImageEmbeddingProbe,
  readImageEmbeddingProbe,
  type ImageEmbeddingProbeResult,
  type ImageProbeFailureReason,
} from '../../domains/llm/services/image-embedding-probe.js';
import { ensureImageEmbeddingColumn } from '../../domains/llm/services/image-embedding-index.js';
import {
  warnThresholdOutlivedItsModel,
  type CalibrationPair,
  type ConfidenceBasis,
} from '../../core/services/confidence-calibration.js';
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

const USECASES: readonly LlmUsecase[] = [
  'chat', 'summary', 'quality', 'auto_tag', 'embedding', 'rerank', 'image_embedding',
] as const;

/**
 * The two ADR-021 use cases that never inherit the default provider. Spelled
 * once, so the three places that special-case them (`GET /llm/usecase-default`,
 * the admin grid, and the resolver behind both) cannot disagree.
 */
const NON_INHERITING: ReadonlySet<LlmUsecase> = new Set<LlmUsecase>(['rerank', 'image_embedding']);

function resolveNonInheriting(usecase: LlmUsecase) {
  return usecase === 'rerank' ? resolveRerankUsecase() : resolveImageEmbeddingUsecase();
}

/** #1184 — shared by the capability read and the manual re-probe. */
const NO_CHAT_PROVIDER =
  'No provider resolved for use case "chat". Configure one in Settings → AI Models.';

/** #1115 — the same sentence for the image leg's own detail routes. */
const NO_IMAGE_EMBEDDING_PROVIDER =
  'No provider is assigned to image embedding, so the image leg is off. Assign one in Settings → AI Models.';

/**
 * What a refused assignment says. **The category, never the provider's body**
 * (#1184's rule): the raw body can echo request fragments and internal
 * topology, and it lands in an admin toast from here.
 *
 * The prose no longer points at the row's "Why this verdict?" disclosure
 * (review round 1). On the common case — a first-ever assignment against the
 * wrong server — the refused pair is deliberately NOT persisted, and the
 * disclosure either shows nothing or the previous, still-working pair's answer.
 * The provider's own body goes to the server log, which is where the sentence
 * now sends the operator, and `reason` beside `error` is the category slug the
 * runbook's table is keyed on.
 */
const PROBE_REFUSAL_MESSAGE: Record<ImageProbeFailureReason, string> = {
  shape_rejected:
    'This endpoint refused the request. Image embedding needs a server that accepts vLLM\'s chat-embeddings shape (a `messages` array) on /v1/embeddings — Ollama, LM Studio and TEI do not. The provider\'s own answer is in the backend log.',
  unreachable:
    'The provider could not be reached for the probe. Check the base URL, the credentials and that the model server is running, then try again.',
  width_mismatch:
    'This endpoint returned different vector widths for an image and for a text, so image and text vectors would not be comparable. It is likely applying the chat template to only one of the two.',
  unusable_width:
    'This endpoint returned a vector width Postgres cannot index. Serve the model at 4000 dimensions or fewer (its `dimensions` / MRL parameter).',
};

/**
 * #1114 — the two use cases whose model sets the scale a confidence threshold
 * is measured on. `chat`, `summary`, `quality` and `auto_tag` do not appear:
 * none of them produces a score the refuse gate compares against.
 */
const CONFIDENCE_BASIS_BY_USECASE: ReadonlyArray<readonly [LlmUsecase, ConfidenceBasis]> = [
  ['embedding', 'similarity'],
  ['rerank', 'rerank'],
] as const;

function samePair(a: CalibrationPair | null, b: CalibrationPair | null): boolean {
  if (!a || !b) return a === b;
  return a.providerId === b.providerId && a.model === b.model;
}

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
      // than pretending the default provider serves /v1/rerank. #1115's
      // `image_embedding` is the same rule; `resolveUsecase` throws for both,
      // so this branch is what keeps the route from 500ing on them.
      resolved = NON_INHERITING.has(usecase)
        ? await resolveNonInheriting(usecase)
        : await resolveUsecase(usecase);
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
        // Rerank and image embedding never fall back to the default provider —
        // unassigned means the stage is DISABLED (#1104, #1115), and showing
        // the default here would imply it serves that traffic. The empty
        // sentinel renders as "unset" in the settings grid.
        const resolved = NON_INHERITING.has(u)
          ? await resolveNonInheriting(u).catch(() => null)
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

      // ── #1115: the image leg is probe-gated, BEFORE the transaction ──────
      //
      // A leg that cannot embed must not be assignable. Unlike the vision
      // probe (fire-and-forget after the save, because a wrong verdict only
      // disables an optional composer control), a wrong `image_embedding`
      // assignment is silent and expensive: the default text provider ANSWERS
      // the request in the plain shape with a well-formed vector, and an index
      // built from those is indistinguishable from bad retrieval. So this is
      // BLOCKING and it REFUSES — the admin waits on one round-trip, once, at
      // the moment they chose the endpoint.
      //
      // Unassigning is not probed: there is nothing to probe, and the leg
      // simply goes off (`resolveImageEmbeddingUsecase` answers null).
      const imagePatch = updates.image_embedding;
      let imageAssignment:
        | { providerId: string; model: string; baseUrl: string; probe: ImageEmbeddingProbeResult }
        | null = null;
      if (
        imagePatch
        && (Object.prototype.hasOwnProperty.call(imagePatch, 'providerId')
          || Object.prototype.hasOwnProperty.call(imagePatch, 'model'))
      ) {
        const existing = await query<{ provider_id: string | null; model: string | null }>(
          `SELECT provider_id, model FROM llm_usecase_assignments WHERE usecase = 'image_embedding'`,
        );
        const prev = existing.rows[0];
        const nextProviderId = Object.prototype.hasOwnProperty.call(imagePatch, 'providerId')
          ? (imagePatch.providerId ?? null)
          : (prev?.provider_id ?? null);
        const nextModel = Object.prototype.hasOwnProperty.call(imagePatch, 'model')
          ? (imagePatch.model ?? null)
          : (prev?.model ?? null);

        if (nextProviderId) {
          // Resolve the pair the assignment WOULD produce, the same way
          // `resolveImageEmbeddingUsecase` will: an unpinned model inherits the
          // provider's `default_model`, and neither existing means the leg
          // could never run.
          let cfg;
          try {
            cfg = await loadProviderConfig(nextProviderId);
          } catch {
            return reply.code(422).send({
              error: 'That provider no longer exists. Reload Settings → AI Models and pick another.',
              statusCode: 422,
            });
          }
          const model = nextModel || cfg.defaultModel || '';
          if (!model) {
            return reply.code(422).send({
              error:
                'No model resolves for image embedding. Pick a model, or set a default model on the provider.',
              statusCode: 422,
            });
          }
          const probe = await probeImageEmbedding(cfg, model);
          // A FAILED probe of a pair that is not the live one must not
          // overwrite the record — the assignment is being refused, so the live
          // leg is unchanged, and clobbering its stored verdict would replace a
          // true "2048-dim · halfvec HNSW" with "Not established" for an
          // endpoint that is still working. The refusal category in the 422 is
          // the feedback for the pair that failed, and `probeImageEmbedding`
          // logs the provider's own answer.
          const samePairAsLive =
            prev?.provider_id === nextProviderId && (prev?.model ?? null) === (nextModel ?? null);
          if (!probe.reason || samePairAsLive) {
            await persistImageEmbeddingProbe(nextProviderId, model, probe);
          }
          if (probe.reason) {
            // `reason` is the CATEGORY slug, not the provider's body — the
            // thing ADR-025 and the runbook's refusal table are keyed on, and
            // what a client needs to branch on. It is deliberately the only
            // machine-readable half of this answer.
            return reply.code(422).send({
              error: PROBE_REFUSAL_MESSAGE[probe.reason],
              reason: probe.reason,
              statusCode: 422,
            });
          }
          imageAssignment = { providerId: nextProviderId, model, baseUrl: cfg.baseUrl, probe };
        }
      }

      // #1114 — the pair each confidence basis resolved to BEFORE the save.
      // Read through the resolver, not the raw row, because inheritance and
      // the EE override decide what the pipeline actually scores with — and
      // captured before the transaction, because after it the old answer is
      // gone. Only for a basis this body touches: a `summary` re-point must
      // cost nothing here.
      const basisBefore = new Map<ConfidenceBasis, ConfidenceBasisResolution>();
      for (const [usecase, basis] of CONFIDENCE_BASIS_BY_USECASE) {
        if (updates[usecase]) basisBefore.set(basis, await resolveConfidenceBasisPair(basis));
      }
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
          // #1115, review round 1: the image leg stores the RESOLVED model, not
          // the (possibly null) one the admin sent. An assignment of
          // {provider: P, model: null} re-resolves `P.default_model` on every
          // read, so editing that default would repoint the live image model
          // with no probe and no rebuild — silently breaking D7's "a model
          // change truncates and re-scans". The probe verified exactly one
          // pair; the row now names it. Every other use case keeps inheriting,
          // because for them a repoint costs a differently-worded answer, not a
          // corrupt index.
          const nextModel =
            u === 'image_embedding' && imageAssignment
              ? imageAssignment.model
              : hasModel ? (patch.model ?? null) : (prev?.model ?? null);

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

      // #1115 — the column follows the probe, and only once the assignment
      // has actually landed. `ensureImageEmbeddingColumn` is a no-op beyond
      // "create the index if it is missing" when the width and the pair are
      // unchanged, so a re-save of the same assignment costs nothing; a
      // changed model truncates and re-dirties (ADR-025 D7).
      //
      // Guarded, because it runs AFTER the assignment transaction committed
      // (review round 1). A lock pile-up or a failed ALTER used to surface as a
      // bare 500 for a request whose row really did save — the panel would then
      // show the leg as assigned against a column of the previous width, with
      // nothing said about it. The DDL is idempotent, so the honest answer is
      // 200 plus the remedy: press Re-check.
      let imageIndexWarning: string | undefined;
      if (imageAssignment && imageAssignment.probe.dimensions !== null) {
        try {
          await ensureImageEmbeddingColumn(imageAssignment.probe.dimensions, {
            providerId: imageAssignment.providerId,
            model: imageAssignment.model,
            baseUrl: imageAssignment.baseUrl,
          });
        } catch (err) {
          logger.error(
            { err, providerId: imageAssignment.providerId, model: imageAssignment.model },
            'Image embedding assignment saved, but the image index could not be brought in line',
          );
          imageIndexWarning =
            'The assignment was saved, but the image index could not be retyped — it is still at its previous width. Use Re-check on the Image embedding row to retry.';
        }
      }

      // #1114 — the quiet counterpart of the shadow swap's warning: no
      // migration, no runbook, just an admin picking a different model in a
      // dropdown, after which a threshold tuned on the old one silently
      // refuses a different set of questions. Gated on the pair actually
      // MOVING, so re-saving the same assignment is silent — and, per the
      // owner ruling, read-only: the threshold is left exactly as it was and
      // the Retrieval panel carries the same notice for whoever set it.
      // After `bumpProviderCacheVersion`, or the "after" read could still be
      // answered from the pre-save provider cache.
      for (const [, basis] of CONFIDENCE_BASIS_BY_USECASE) {
        const before = basisBefore.get(basis);
        if (!before) continue;
        const after = await resolveConfidenceBasisPair(basis);
        // Review r2 — an UNRESOLVED side is not a changed side. A resolver
        // that threw on either read would otherwise be reported as
        // "bge-m3 → nothing", a model change that never happened, in a log
        // line whose whole job is to name the two models.
        if (!before.resolved || !after.resolved) continue;
        if (samePair(before.pair, after.pair)) continue;
        await warnThresholdOutlivedItsModel({
          basis,
          previousModel: before.pair?.model ?? null,
          newModel: after.pair?.model ?? null,
        });
      }

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
      return imageIndexWarning ? { ok: true, imageIndexWarning } : { ok: true };
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

  // ─── #1115: image-embedding probe detail + manual re-probe ───────────────
  //
  // Mirrors the #1184 pair above, for the same reasons and with the same
  // gating. `error` is the provider's own body, so both are `requireAdmin` and
  // `UsecaseDefaultSchema` — served to every authenticated user — must never
  // gain it.
  //
  // Spelled into the path rather than taken as a `:usecase` parameter, exactly
  // as the vision pair is: only `image_embedding` resolves to an endpoint that
  // speaks the chat-embeddings shape, and probing anything else with it would
  // post an image at a text embedder and record a meaningless verdict.

  // GET — the LAST stored probe, never a fresh one. Read on every paint of
  // Settings → AI Models, so it must not cost a provider round-trip.
  fastify.get(
    '/admin/llm-usecases/image_embedding/probe',
    { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT },
    async (_req, reply) => {
      const resolved = await resolveImageEmbeddingUsecase().catch(() => null);
      if (!resolved) return reply.code(404).send({ error: NO_IMAGE_EMBEDDING_PROVIDER });

      const stored = await readImageEmbeddingProbe();
      // A stored probe for a DIFFERENT pair describes an endpoint that is no
      // longer assigned. Answering with nulls says "never probed", which is
      // true of the live pair and is what the panel's Re-check exists for.
      const matches =
        stored?.providerId === resolved.config.providerId && stored?.model === resolved.model;
      return ImageEmbeddingProbeSchema.parse({
        providerId: resolved.config.providerId,
        model: resolved.model,
        dimensions: matches ? stored!.dimensions : null,
        tier: matches ? stored!.tier : null,
        probedAt: matches ? stored!.probedAt : null,
        error: matches ? stored!.error : null,
      });
    },
  );

  // POST — force a fresh probe of the resolved pair and answer with it.
  //
  // Blocking, like the vision re-probe: the admin clicked a button and is
  // waiting. It goes through the queue and the per-provider breaker, and an
  // image prompt is 10–25x a short text one, so the client must not assume a
  // sub-second response.
  //
  // A SUCCESSFUL re-probe also re-runs `ensureImageEmbeddingColumn`. That is
  // the remedy for the case this control exists for — an operator restarted
  // the model server at a different width or with a different `--hf-overrides`
  // — and it is why the re-check is not merely diagnostic. A FAILED one leaves
  // the column exactly as it is: an unreachable endpoint is not evidence that
  // the existing index is wrong.
  fastify.post(
    '/admin/llm-usecases/image_embedding/reprobe',
    { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT },
    async (req, reply) => {
      const resolved = await resolveImageEmbeddingUsecase().catch(() => null);
      if (!resolved) return reply.code(404).send({ error: NO_IMAGE_EMBEDDING_PROVIDER });

      const probe = await probeImageEmbedding(resolved.config, resolved.model);
      await persistImageEmbeddingProbe(resolved.config.providerId, resolved.model, probe);
      // What the DDL actually did travels back to the caller (review round 1).
      // "Re-check" reads as diagnostic, and on a width or endpoint change it is
      // not: it empties `page_image_embeddings` and re-dirties every non-folder
      // page. The control cannot say so unless the server tells it.
      //
      // Deliberately NOT wrapped the way the assignment PUT's call is. There
      // the row had already committed, so a 500 denied a save that happened;
      // here applying the column type IS the request, and a failure is honestly
      // a failed request — the operator presses Re-check again.
      let ensured: Awaited<ReturnType<typeof ensureImageEmbeddingColumn>> | null = null;
      if (probe.dimensions !== null) {
        ensured = await ensureImageEmbeddingColumn(probe.dimensions, {
          providerId: resolved.config.providerId,
          model: resolved.model,
          baseUrl: resolved.config.baseUrl,
        });
      }
      emitLlmAudit({
        event: 'llm_image_embedding_reprobed',
        userId: req.userId,
        metadata: {
          providerId: resolved.config.providerId,
          model: resolved.model,
          dimensions: probe.dimensions,
          reason: probe.reason,
          action: ensured?.action ?? null,
          dirtiedPages: ensured?.dirtiedPages ?? null,
        },
      });
      const stored = await readImageEmbeddingProbe();
      return ImageEmbeddingProbeSchema.parse({
        providerId: resolved.config.providerId,
        model: resolved.model,
        dimensions: probe.dimensions,
        tier: probe.tier,
        probedAt: stored?.probedAt ?? null,
        error: probe.error,
        ...(ensured
          ? { rebuilt: ensured.action === 'rebuilt', dirtiedPages: ensured.dirtiedPages }
          : {}),
      });
    },
  );
}
