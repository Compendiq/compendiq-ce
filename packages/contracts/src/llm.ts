import { z } from 'zod';
import { ImageAnalysisIdentitySchema } from './image-analysis.js';
import { ProviderLocalitySchema } from './schemas/ai-policy.js';

// ─── Use-cases (#1104 adds 'rerank' — see ADR-021 amendment: it targets a
// /v1/rerank endpoint via a dedicated client, and UNASSIGNED means the
// rerank stage is disabled, never inherit-the-default-provider) ──────────
//
// #1417 adds `inline_completion` under that rule too. It is a deliberately
// high-frequency, low-latency path with its own token and stop limits, so an
// unassigned row means ghost text is OFF rather than inherited from a default
// model an operator never chose for per-keystroke traffic.
//
// #1615 (ADR-027 D3) adds `image_analysis` under the same rule: the
// assignment IS the egress control — no image byte leaves the host until an
// administrator has explicitly assigned a provider for this purpose — so
// unassigned means no new inference, never the default provider, never the
// chat provider, never a cloud fallback.
export const LlmUsecaseSchema = z.enum([
  'chat', 'summary', 'quality', 'auto_tag', 'embedding', 'rerank',
  'inline_completion', 'image_analysis',
]);
export type LlmUsecase = z.infer<typeof LlmUsecaseSchema>;

// ─── Provider ────────────────────────────────────────────────────────────
export const LlmAuthTypeSchema = z.enum(['bearer', 'none']);
export type LlmAuthType = z.infer<typeof LlmAuthTypeSchema>;

export const LlmProviderInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().url().regex(/^https?:\/\//, 'baseUrl must be http(s)'),
  apiKey: z.string().min(1).optional(),
  authType: LlmAuthTypeSchema,
  verifySsl: z.boolean(),
  defaultModel: z.string().trim().min(1).max(200).nullable().optional(),
  /**
   * #280 — provider locality declared by the admin together with the
   * endpoint. Omitted means `external` (never `local` by default). A `local`
   * declaration is bound to the configuration revision the write produces;
   * any later endpoint edit invalidates it until it is re-declared.
   */
  locality: ProviderLocalitySchema.optional(),
});
export type LlmProviderInput = z.infer<typeof LlmProviderInputSchema>;

export const LlmProviderUpdateSchema = LlmProviderInputSchema.partial();
export type LlmProviderUpdate = z.infer<typeof LlmProviderUpdateSchema>;

export const LlmProviderSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  baseUrl: z.string(),
  authType: LlmAuthTypeSchema,
  verifySsl: z.boolean(),
  defaultModel: z.string().nullable(),
  isDefault: z.boolean(),
  hasApiKey: z.boolean(),
  keyPreview: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** #280 — declared locality and the configuration revision it was declared against. */
  locality: ProviderLocalitySchema,
  configRevision: z.number().int().nonnegative(),
  localityDeclaredAt: z.string().nullable(),
  localityDeclaredBy: z.string().nullable(),
  /** `locality = 'local'` AND declared against the CURRENT config revision. */
  localConfirmed: z.boolean(),
});
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

// ─── Use-case assignments (rewritten against providerId) ─────────────────
export const UsecaseAssignmentSchema = z.object({
  providerId: z.string().uuid().nullable(),
  model: z.string().nullable(),
  resolved: z.object({
    providerId: z.string().uuid(),
    providerName: z.string(),
    model: z.string(),
  }),
});
export type UsecaseAssignment = z.infer<typeof UsecaseAssignmentSchema>;

export const UsecaseAssignmentsSchema = z.object({
  chat: UsecaseAssignmentSchema,
  summary: UsecaseAssignmentSchema,
  quality: UsecaseAssignmentSchema,
  auto_tag: UsecaseAssignmentSchema,
  embedding: UsecaseAssignmentSchema,
  // `resolved` reports what WOULD serve if assigned; the rerank stage itself
  // only runs on an explicit assignment (resolveRerankUsecase).
  rerank: UsecaseAssignmentSchema,
  // #1417 — high-frequency editor traffic is opt-in and never inherits.
  inline_completion: UsecaseAssignmentSchema,
  // #1615 — same story as rerank: `resolved` is informational, analysis runs
  // only on an explicit assignment (resolveImageAnalysisUsecase), and
  // unassigned pauses new inference.
  image_analysis: UsecaseAssignmentSchema,
});
export type UsecaseAssignments = z.infer<typeof UsecaseAssignmentsSchema>;

export const UpdateUsecaseAssignmentInputSchema = z.object({
  providerId: z.string().uuid().nullable().optional(), // undefined=leave, null=clear, uuid=set
  model: z.string().nullable().optional(),
});
/**
 * Deliberately NOT `.strict()`. An unknown key — including a retired one such
 * as #1618's `image_embedding` — is stripped, and the rest of the body still
 * applies: `PUT /admin/llm-usecases` answers 200 and writes nothing for it.
 *
 * A 400 was considered and rejected. On the wire a retired name is
 * indistinguishable from one an older backend has not learned yet, so
 * refusing unknown keys would make a newer bundle (rolling deploy, cached SPA)
 * lose the operator's whole save over a name the server does not know.
 * Narrowing it to the retired names alone would mean a blacklist of dead
 * names maintained forever. Resurrection is closed structurally instead:
 * migration 118 deleted the rows and narrowed the use-case CHECK to the eight
 * survivors. Pinned by `llm-usecases.test.ts` "ignores a retired use-case key
 * and still applies the rest of the body".
 */
export const UpdateUsecaseAssignmentsInputSchema = z.object({
  chat: UpdateUsecaseAssignmentInputSchema.optional(),
  summary: UpdateUsecaseAssignmentInputSchema.optional(),
  quality: UpdateUsecaseAssignmentInputSchema.optional(),
  auto_tag: UpdateUsecaseAssignmentInputSchema.optional(),
  embedding: UpdateUsecaseAssignmentInputSchema.optional(),
  rerank: UpdateUsecaseAssignmentInputSchema.optional(),
  inline_completion: UpdateUsecaseAssignmentInputSchema.optional(),
  image_analysis: UpdateUsecaseAssignmentInputSchema.optional(),
});
export type UpdateUsecaseAssignmentsInput = z.infer<typeof UpdateUsecaseAssignmentsInputSchema>;

// ─── Read-side resolver output for non-admin callers (#355) ─────────────────
/**
 * Shape returned by `GET /llm/usecase-default?usecase=…` — the resolved
 * provider+model for a given use case, suitable for non-admin UI surfaces
 * (chat input pane, etc.). Excludes the raw assignment row to avoid leaking
 * the admin-internal "unset / inherits default" distinction.
 */
export const UsecaseDefaultSchema = z.object({
  usecase: LlmUsecaseSchema,
  providerId: z.string().uuid(),
  providerName: z.string(),
  model: z.string(),
  /**
   * #1154: whether the resolved model accepts image input. `null` means
   * probed-but-undetermined, which the UI renders differently from `false`
   * — hence nullable rather than optional.
   */
  vision: z.boolean().nullable(),
  // NOTE (#1184): `probeError` / `probedAt` deliberately do NOT belong here.
  // This route is `fastify.authenticate`, not `requireAdmin`. The evidence
  // behind a verdict lives on `VisionCapabilityDetailSchema` below.
  // NOTE (#283): declared locality does not belong here either — this
  // object's exact key set is pinned by `llm-usecases-vision.test.ts` as the
  // non-admin leak boundary. It has its own route and schema,
  // `UsecaseLocalitySchema`, below.
});
export type UsecaseDefault = z.infer<typeof UsecaseDefaultSchema>;

/**
 * #283 — `GET /llm/usecase-locality?usecase=…`: the DECLARED locality of the
 * provider a use case resolves to, so a `local_only` article surface can say
 * whether THIS use case's destination is admitted without inferring it from
 * the default chat row, a URL, a name or a probe.
 *
 * `locality` is `null` when the provider row could not be read: unknown is
 * never `local`, and a consumer treats null as "not admitted for
 * local_only". `localityConfirmed` is `LlmProviderSchema.localConfirmed` —
 * `local` declared against the CURRENT configuration revision. A `local`
 * declaration left behind by an endpoint edit is `locality: 'local',
 * localityConfirmed: false` and does not admit `local_only` content.
 *
 * Authenticated, not admin: it names a category of the destination (the
 * same two words the provider list shows every reader of Settings), never
 * an endpoint, a key or a probe body.
 */
export const UsecaseLocalitySchema = z.object({
  usecase: LlmUsecaseSchema,
  providerId: z.string().uuid(),
  providerName: z.string(),
  locality: ProviderLocalitySchema.nullable(),
  localityConfirmed: z.boolean(),
}).strict();
export type UsecaseLocality = z.infer<typeof UsecaseLocalitySchema>;

/**
 * Whether a use case's resolved destination may receive `local_only`
 * article content, from a `UsecaseLocality` row. Fail closed: unknown
 * locality, an unconfirmed declaration, a missing row or a server that
 * predates the route all say no. This is a DISPLAY verdict for the shared
 * frontend; the server admits or refuses each dispatch independently.
 */
export function usecaseAdmitsLocalOnly(
  row: { locality?: 'local' | 'external' | null; localityConfirmed?: boolean } | null | undefined,
): boolean {
  return !!row && row.locality === 'local' && row.localityConfirmed === true;
}

// ─── Admin-only capability detail (#1184) ────────────────────────────────
/**
 * Shape returned by `GET /admin/llm-usecases/chat/vision-capability` and by
 * `POST /admin/llm-usecases/chat/reprobe-vision` — the stored verdict for the
 * provider+model that `chat` currently resolves to, plus the evidence behind
 * it.
 *
 * **Admin-only, deliberately.** `probeError` is the provider's own error body
 * (see `backend/.../llm-http-error.ts`): third-party text that can echo
 * request fragments and internal topology. `UsecaseDefaultSchema` above is
 * served to every authenticated user, which is why this is a separate schema
 * rather than an extension of it.
 *
 * `probedAt` is null for a pair with no row yet (never probed). `vision` keeps
 * the tri-state: `false` = probed and refused, `null` = never established.
 */
export const VisionCapabilityDetailSchema = z.object({
  providerId: z.string().uuid(),
  model: z.string(),
  vision: z.boolean().nullable(),
  probedAt: z.string().nullable(),
  probeError: z.string().nullable(),
});
export type VisionCapabilityDetail = z.infer<typeof VisionCapabilityDetailSchema>;

/**
 * #1615 (ADR-027) — `GET /admin/llm-usecases/image_analysis/capability` and
 * `POST /admin/llm-usecases/image_analysis/recheck`: the chat detail above for
 * the pair `image_analysis` resolves to, plus the D7 state the card renders.
 *
 * `identity` is the RETAINED identity (`admin_settings.image_analysis_identity`),
 * which survives an unassign and can differ from the resolved pair;
 * `identityDrift` is that difference — a provider `base_url` edit is the one
 * identity dimension no assignment PUT touches, and while it stands the worker
 * skips inference (`identity_drift`). `reanalyzeRows` is present only on the
 * re-check, only when a `true` verdict adopted a new identity: the count of
 * analyzed rows that replacement invalidated. Admin-only like its parent.
 */
export const ImageAnalysisCapabilityDetailSchema = VisionCapabilityDetailSchema.extend({
  identity: ImageAnalysisIdentitySchema.nullable(),
  identityDrift: z.boolean(),
  reanalyzeRows: z.number().int().min(0).optional(),
});
export type ImageAnalysisCapabilityDetail = z.infer<typeof ImageAnalysisCapabilityDetailSchema>;

// ─── DEPRECATED: old two-slot enum kept for transitional typing only ──────
/** @deprecated use `LlmProvider.id` (uuid). Removed after Task 36. */
export const LlmProviderTypeSchema = z.enum(['ollama', 'openai']);
/** @deprecated */
export type LlmProviderType = z.infer<typeof LlmProviderTypeSchema>;
