import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  LlmUsecaseSchema,
  UpdateUsecaseAssignmentsInputSchema,
  UsecaseDefaultSchema,
  VisionCapabilityDetailSchema,
  ImageAnalysisCapabilityDetailSchema,
  ImageAnalysisReanalysisScopeQuerySchema,
  ImageAnalysisReanalysisScopeSchema,
  type LlmUsecase,
} from '@compendiq/contracts';
import { query, getPool } from '../../core/db/postgres.js';
import {
  resolveUsecase,
  resolveRerankUsecase,
  resolveInlineCompletionUsecase,
  resolveImageAnalysisUsecase,
  resolveConfidenceBasisPair,
  loadProviderConfig,
  ProviderNotFoundError,
  type ConfidenceBasisResolution,
} from '../../domains/llm/services/llm-provider-resolver.js';
import { VISION_PROBE_TIMEOUT_MS } from '../../domains/llm/services/vision-probe.js';
import {
  computeIdentityHash,
  getRetainedImageAnalysisIdentity,
  reanalysisScopeFor,
  resolveCandidateImageAnalysisIdentity,
  retainImageAnalysisIdentity,
  ImageAnalysisResolutionError,
  type ImageAnalysisResolutionReason,
  type ResolvedImageAnalysisIdentity,
} from '../../domains/llm/services/image-analysis-identity.js';
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

const USECASES: readonly LlmUsecase[] = [...LlmUsecaseSchema.options];

/**
 * The ADR-021 use cases that never inherit the default provider. Spelled
 * once, so the three places that special-case them (`GET /llm/usecase-default`,
 * the admin grid, and the resolver behind both) cannot disagree.
 */
const NON_INHERITING: ReadonlySet<LlmUsecase> = new Set<LlmUsecase>([
  'rerank',
  'inline_completion',
  'image_analysis',
]);

function resolveNonInheriting(usecase: LlmUsecase) {
  if (usecase === 'rerank') return resolveRerankUsecase();
  if (usecase === 'inline_completion') return resolveInlineCompletionUsecase();
  if (usecase === 'image_analysis') return resolveImageAnalysisUsecase();
  throw new Error(`${usecase} is not a non-inheriting use case`);
}

/** #1184 — shared by the capability read and the manual re-probe. */
const NO_CHAT_PROVIDER =
  'No provider resolved for use case "chat". Configure one in Settings → AI Models.';

/** #1615 — the same sentence for the image-analysis detail routes (ADR-027 D3). */
const NO_IMAGE_ANALYSIS_PROVIDER =
  'No provider is assigned to image analysis, so no page image is analyzed. Assign one in Settings → AI Models.';

/**
 * #1615 — what a refused `image_analysis` assignment says (ADR-027 "Settings
 * and capability semantics"). Four machine-readable reasons; the category,
 * never the provider's body (#1184's rule), and each names its remedy.
 * `text_only` is a NEGATIVE verdict; `unconfirmed` deliberately is not —
 * transport, auth, 429 and an open breaker all land there, and none of them
 * is evidence that the model cannot read an image.
 */
const IMAGE_ANALYSIS_REFUSAL_MESSAGE: Record<ImageAnalysisResolutionReason | 'text_only' | 'unconfirmed', string> = {
  no_provider: 'That provider no longer exists. Reload Settings → AI Models and pick another.',
  no_model:
    'No model resolves for image analysis. Pick a model, or set a default model on the provider.',
  text_only:
    'This model refused the test image, so it cannot analyze page images. Pick a vision-capable model; the previous assignment is unchanged.',
  unconfirmed:
    'Image support could not be confirmed — the provider did not answer the probe (unreachable, an authentication or rate-limit error, or an open breaker). That is not a verdict about the model: check the endpoint and credentials, then save again. The previous assignment is unchanged.',
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
      // Three specialized use cases never inherit the default provider:
      // rerank (#1104), inline completion (#1417) and image analysis (#1615).
      // This branch reports an unassigned row as 404 instead of pretending the
      // default provider can serve that traffic.
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

  // GET /admin/llm-usecases — return every contract-defined use case.
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
        // Specialized non-inheriting use cases stay disabled when unassigned;
        // showing the default here would imply it serves that traffic. The
        // empty sentinel renders as "unset" in the settings grid.
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

      // ── #1615: image analysis is probe-gated the same way, BEFORE the row ─
      //
      // ADR-027 D3: the probe is the known-content vision probe through
      // `refreshVisionCapability`, run synchronously here — not the chat
      // path's fire-and-forget post-save probe — and only `true` writes the
      // row. `false` and `null` are both 422s with different reasons: a
      // text-only model is a NEGATIVE verdict; an unreachable, unauthorised or
      // rate-limited one is UNCONFIRMED, and treating that as "text-only"
      // would tell an admin running exactly the right endpoint to abandon it.
      // All four refusals leave the previous assignment AND the retained
      // identity (D7) untouched. Unassigning is not probed.
      const analysisPatch = updates.image_analysis;
      let imageAnalysisAssignment: ResolvedImageAnalysisIdentity | null = null;
      if (
        analysisPatch
        && (Object.prototype.hasOwnProperty.call(analysisPatch, 'providerId')
          || Object.prototype.hasOwnProperty.call(analysisPatch, 'model'))
      ) {
        const existing = await query<{ provider_id: string | null; model: string | null }>(
          `SELECT provider_id, model FROM llm_usecase_assignments WHERE usecase = 'image_analysis'`,
        );
        const prev = existing.rows[0];
        const nextProviderId = Object.prototype.hasOwnProperty.call(analysisPatch, 'providerId')
          ? (analysisPatch.providerId ?? null)
          : (prev?.provider_id ?? null);
        const nextModel = Object.prototype.hasOwnProperty.call(analysisPatch, 'model')
          ? (analysisPatch.model ?? null)
          : (prev?.model ?? null);

        if (nextProviderId) {
          // The pair the row WOULD produce, by the one rule the scope preview
          // also uses: assignment model, else the provider's default model.
          let candidate: ResolvedImageAnalysisIdentity;
          try {
            candidate = await resolveCandidateImageAnalysisIdentity({
              providerId: nextProviderId,
              model: nextModel,
            });
          } catch (err) {
            if (!(err instanceof ImageAnalysisResolutionError)) throw err;
            return reply.code(422).send({
              error: IMAGE_ANALYSIS_REFUSAL_MESSAGE[err.reason],
              reason: err.reason,
              statusCode: 422,
            });
          }
          // Bounded like the image-embedding probe: the admin is waiting on
          // this request, and a queue that never drains must answer
          // `unconfirmed`, not hang the save. The verdict is persisted per
          // pair either way — a refused pair's `false` is exactly what the
          // capability route should show for it, and the live pair's stored
          // verdict is a different row.
          const detail = await refreshVisionCapability(candidate.providerId, candidate.model, {
            timeoutMs: VISION_PROBE_TIMEOUT_MS,
          });
          if (detail.vision !== true) {
            const reason = detail.vision === false ? 'text_only' : 'unconfirmed';
            return reply.code(422).send({
              error: IMAGE_ANALYSIS_REFUSAL_MESSAGE[reason],
              reason,
              statusCode: 422,
            });
          }
          imageAnalysisAssignment = candidate;
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
          // #1615: image analysis stores the RESOLVED model, not the (possibly
          // null) one the admin sent. An assignment of {provider: P, model:
          // null} re-resolves `P.default_model` on every read, so editing that
          // default would repoint the live vision model with no probe — and
          // D7's retained identity would then disagree with the pair that is
          // live. The probe verified exactly one pair; the row now names it.
          // Every other use case keeps inheriting, because for them a repoint
          // costs a differently-worded answer, not a silent model swap.
          const nextModel =
            u === 'image_analysis' && imageAnalysisAssignment
              ? imageAnalysisAssignment.model
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
      // #1615 — D7: only after the row has committed and the provider cache
      // has been bumped. Equal to the retained identity → resume (0);
      // different → replaced, and the count is the after-the-fact figure the
      // scope preview disclosed beforehand. Absent from the answer when this
      // PUT did not assign `image_analysis` — a body that only re-pointed
      // `summary`, or that cleared the row, discloses nothing.
      let reanalyzeRows: number | undefined;
      if (imageAnalysisAssignment) {
        reanalyzeRows = (await retainImageAnalysisIdentity(imageAnalysisAssignment)).reanalyzeRows;
      }
      return {
        ok: true,
        ...(reanalyzeRows !== undefined ? { reanalyzeRows } : {}),
      };
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

  // ─── #1615 (ADR-027): image-analysis capability detail, re-check, scope ──
  //
  // The third of the three pairs above, with the same gating and for the same
  // reasons: `probeError` is the provider's own body, so every route here is
  // `requireAdmin`, and `UsecaseDefaultSchema` never gains it. Spelled into
  // the path, not a `:usecase` parameter — only `image_analysis` resolves to a
  // pair whose verdict the D13 gate reads.
  //
  // What is NEW relative to the chat pair is D7: the retained identity rides
  // on the detail (`identity`, `identityDrift`), and a `true` re-check of a
  // pair whose resolved identity differs from the retained one ADOPTS it — the
  // documented way out of `identity_drift` after a provider `base_url` edit,
  // the one identity dimension no assignment PUT touches.

  /** The resolved pair plus the D7 state, shared by the GET and the POST. */
  async function imageAnalysisDetailFor(
    resolved: ResolvedImageAnalysisIdentity,
    detail: { vision: boolean | null; probedAt: string | null; probeError: string | null },
    reanalyzeRows?: number,
  ) {
    const identity = await getRetainedImageAnalysisIdentity();
    return ImageAnalysisCapabilityDetailSchema.parse({
      providerId: resolved.providerId,
      model: resolved.model,
      vision: detail.vision,
      probedAt: detail.probedAt,
      probeError: detail.probeError,
      identity,
      identityDrift: identity !== null && identity.identityHash !== resolved.identityHash,
      ...(reanalyzeRows !== undefined ? { reanalyzeRows } : {}),
    });
  }

  // GET — the stored verdict for the assigned pair, never a fresh probe. Read
  // on every paint of Settings → AI Models. 404 when unassigned, nulls when
  // never probed (the PUT probes before writing, so "assigned and never
  // probed" is a pair whose verdict row was deleted by a provider edit —
  // `invalidateProviderCapabilities` — and Re-check is exactly the remedy).
  fastify.get(
    '/admin/llm-usecases/image_analysis/capability',
    { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT },
    async (_req, reply) => {
      const resolved = await resolveImageAnalysisUsecase().catch(() => null);
      if (!resolved) return reply.code(404).send({ error: NO_IMAGE_ANALYSIS_PROVIDER });
      const triple = {
        providerId: resolved.config.providerId,
        model: resolved.model,
        baseUrl: resolved.config.baseUrl,
      };
      const detail = await readVisionCapabilityDetail(triple.providerId, triple.model);
      return imageAnalysisDetailFor(
        { ...triple, identityHash: computeIdentityHash(triple) },
        { vision: detail?.vision ?? null, probedAt: detail?.probedAt ?? null, probeError: detail?.probeError ?? null },
      );
    },
  );

  // POST — force a fresh probe of the resolved pair and answer with it.
  // Blocking, bounded like the PUT's probe. A `false`/`null` verdict does NOT
  // unassign and does not touch the retained identity: the worker's gate is
  // "assigned AND verdict true AND resolved identity = retained", so
  // inference simply pauses until a re-check restores it. A `true` verdict
  // adopts the resolved identity when it differs (D7's second writer) and
  // reports the rows that adoption invalidated.
  fastify.post(
    '/admin/llm-usecases/image_analysis/recheck',
    { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT },
    async (req, reply) => {
      const resolved = await resolveImageAnalysisUsecase().catch(() => null);
      if (!resolved) return reply.code(404).send({ error: NO_IMAGE_ANALYSIS_PROVIDER });
      const triple = {
        providerId: resolved.config.providerId,
        model: resolved.model,
        baseUrl: resolved.config.baseUrl,
      };
      const identity: ResolvedImageAnalysisIdentity = { ...triple, identityHash: computeIdentityHash(triple) };

      const detail = await refreshVisionCapability(triple.providerId, triple.model, {
        timeoutMs: VISION_PROBE_TIMEOUT_MS,
      });
      let reanalyzeRows: number | undefined;
      if (detail.vision === true) {
        const retained = await retainImageAnalysisIdentity(identity);
        if (retained.changed) reanalyzeRows = retained.reanalyzeRows;
      }
      emitLlmAudit({
        event: 'llm_image_analysis_reprobed',
        userId: req.userId,
        metadata: {
          providerId: triple.providerId,
          model: triple.model,
          vision: detail.vision,
          identityAdopted: reanalyzeRows !== undefined,
          reanalyzeRows: reanalyzeRows ?? null,
        },
      });
      return imageAnalysisDetailFor(identity, detail, reanalyzeRows);
    },
  );

  // GET — the scope preview (D7): what a PUT or re-check of this candidate
  // pair WOULD invalidate, computed without probing, writing or calling. The
  // resolution refusals are the PUT's, with the PUT's reasons; the probe's
  // (`text_only`, `unconfirmed`) cannot occur because nothing is probed. An
  // unparseable query is the boundary's ordinary 400; 404 is not an answer
  // here — the route exists and the provider is a parameter. With no
  // identity retained it answers `changed: true, reanalyzeRows: 0`.
  fastify.get(
    '/admin/llm-usecases/image_analysis/reanalysis-scope',
    { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT },
    async (req, reply) => {
      const q = ImageAnalysisReanalysisScopeQuerySchema.parse(req.query);
      let candidate: ResolvedImageAnalysisIdentity;
      try {
        candidate = await resolveCandidateImageAnalysisIdentity(q);
      } catch (err) {
        if (!(err instanceof ImageAnalysisResolutionError)) throw err;
        return reply.code(422).send({
          error: IMAGE_ANALYSIS_REFUSAL_MESSAGE[err.reason],
          reason: err.reason,
          statusCode: 422,
        });
      }
      const scope = await reanalysisScopeFor(candidate.identityHash);
      return ImageAnalysisReanalysisScopeSchema.parse({
        identityHash: candidate.identityHash,
        changed: scope.changed,
        reanalyzeRows: scope.reanalyzeRows,
      });
    },
  );
}
