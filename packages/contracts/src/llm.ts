import { z } from 'zod';

// ─── Use-cases (#1104 adds 'rerank' — see ADR-021 amendment: it targets a
// /v1/rerank endpoint via a dedicated client, and UNASSIGNED means the
// rerank stage is disabled, never inherit-the-default-provider) ──────────
//
// #1115 adds 'image_embedding' under the SAME non-inheriting rule, one rung
// stronger: a default text embedder handed the VL request answers the plain
// `{model, input}` shape with a well-formed vector that is simply wrong, and
// wrong vectors are indistinguishable from bad retrieval. See ADR-025.
export const LlmUsecaseSchema = z.enum([
  'chat', 'summary', 'quality', 'auto_tag', 'embedding', 'rerank', 'image_embedding',
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
  // #1115 — same story as rerank: `resolved` is informational, the image leg
  // runs only on an explicit assignment (resolveImageEmbeddingUsecase).
  image_embedding: UsecaseAssignmentSchema,
});
export type UsecaseAssignments = z.infer<typeof UsecaseAssignmentsSchema>;

export const UpdateUsecaseAssignmentInputSchema = z.object({
  providerId: z.string().uuid().nullable().optional(), // undefined=leave, null=clear, uuid=set
  model: z.string().nullable().optional(),
});
export const UpdateUsecaseAssignmentsInputSchema = z.object({
  chat: UpdateUsecaseAssignmentInputSchema.optional(),
  summary: UpdateUsecaseAssignmentInputSchema.optional(),
  quality: UpdateUsecaseAssignmentInputSchema.optional(),
  auto_tag: UpdateUsecaseAssignmentInputSchema.optional(),
  embedding: UpdateUsecaseAssignmentInputSchema.optional(),
  rerank: UpdateUsecaseAssignmentInputSchema.optional(),
  image_embedding: UpdateUsecaseAssignmentInputSchema.optional(),
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
});
export type UsecaseDefault = z.infer<typeof UsecaseDefaultSchema>;

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

// ─── Admin-only image-embedding probe result (#1115) ─────────────────────
/**
 * pgvector's index tiers, as the probed width picks them: `vector` +
 * `vector_cosine_ops` HNSW up to 2000 dims, `halfvec` + `halfvec_cosine_ops`
 * HNSW to 4000, and above that a `vector` column with **no index at all** —
 * correct but sequentially scanned, which is why the UI states it rather than
 * leaving the operator to discover it from query latency.
 */
export const VectorIndexTierSchema = z.enum(['vector', 'halfvec', 'unindexed']);
export type VectorIndexTier = z.infer<typeof VectorIndexTierSchema>;

/**
 * Shape returned by `GET /admin/llm-usecases/image_embedding/probe` and by
 * `POST /admin/llm-usecases/image_embedding/reprobe` — the last probe of the
 * pair `resolveImageEmbeddingUsecase()` resolves.
 *
 * **Admin-only, deliberately**, for exactly the reason `VisionCapabilityDetail`
 * is: `error` folds in the provider's own response body, which
 * `llm-http-error.ts` keeps off client-visible paths because it can echo
 * request fragments and internal topology. It is truncated at
 * `PROBE_ERROR_MAX_CHARS` on the way out and rendered as plain JSX text.
 * `UsecaseDefaultSchema` must never gain it.
 *
 * `dimensions` and `tier` are null together on a failed probe: a probe that
 * did not return a vector has no width, and nullable-rather-than-optional
 * stops a caller reading "absent" as "zero-dimensional".
 */
export const ImageEmbeddingProbeSchema = z.object({
  providerId: z.string().uuid(),
  model: z.string(),
  /** Vector width the model answered with. Bounded like every other pgvector width. */
  dimensions: z.number().int().min(1).max(16_000).nullable(),
  tier: VectorIndexTierSchema.nullable(),
  /** ISO-8601. Null when this pair has never been probed. */
  probedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type ImageEmbeddingProbe = z.infer<typeof ImageEmbeddingProbeSchema>;

// ─── DEPRECATED: old two-slot enum kept for transitional typing only ──────
/** @deprecated use `LlmProvider.id` (uuid). Removed after Task 36. */
export const LlmProviderTypeSchema = z.enum(['ollama', 'openai']);
/** @deprecated */
export type LlmProviderType = z.infer<typeof LlmProviderTypeSchema>;
