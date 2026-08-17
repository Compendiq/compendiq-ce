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
  /**
   * What the re-probe's DDL did, present on `POST …/reprobe` only — the GET is
   * a pure cache read and performs no DDL, so it omits both rather than
   * claiming `false`.
   *
   * `true` means the image index was EMPTIED and every non-folder page queued
   * for a re-scan (a width or endpoint change, ADR-025 D7). It is optional
   * rather than nullable because the control that renders it has to be able to
   * tell "did not rebuild" from "was never asked".
   */
  rebuilt: z.boolean().optional(),
  /** Pages marked `image_embedding_dirty` by that rebuild. 0 when it did not rebuild. */
  dirtiedPages: z.number().int().nonnegative().optional(),
});
export type ImageEmbeddingProbe = z.infer<typeof ImageEmbeddingProbeSchema>;

/**
 * #1115 P2 — why one page's images were not all embedded, by reason.
 *
 * Every reason is REQUIRED. A dropped counter and a zero read identically on a
 * card whose whole job is to explain a row count that is lower than the
 * operator expected, and the reasons are not interchangeable: `unsupported` is
 * a draw.io `.png` that is really XML (working as designed), `missing` is a
 * body pointing at bytes that are not on disk (a broken sync), and `capped` is
 * a knob the operator can move. ADR-025 D10: an image over either ceiling is
 * skipped and counted, never resized — the backend has no pixel decoder.
 */
export const ImageSkipCountsSchema = z.object({
  /** Referenced by the body, absent from the store. */
  missing: z.number().int().nonnegative(),
  /** Bytes that sniff as no raster format — SVG, draw.io XML behind a `.png`. */
  unsupported: z.number().int().nonnegative(),
  /** Declared dimensions above `MAX_IMAGE_DIMENSION` (4096). */
  oversized: z.number().int().nonnegative(),
  /** Bytes above `MAX_IMAGE_BYTES` (5 MB). */
  tooLarge: z.number().int().nonnegative(),
  /** Past `rag_images_per_page_max` on this page. */
  capped: z.number().int().nonnegative(),
  /** Fetched from an external URL, with `rag_image_index_external` off. */
  external: z.number().int().nonnegative(),
});
export type ImageSkipCounts = z.infer<typeof ImageSkipCountsSchema>;

/** What the last `processDirtyPageImages` run did, as the card reports it. */
export const ImageIndexRunSchema = z.object({
  /** ISO-8601 completion time. */
  at: z.string(),
  /** Pages visited. */
  pages: z.number().int().nonnegative(),
  embedded: z.number().int().nonnegative(),
  /** Unchanged bytes whose row was kept — the reason a re-scan is cheap. */
  reused: z.number().int().nonnegative(),
  /** Rows deleted because the page no longer references that image. */
  removed: z.number().int().nonnegative(),
  /** Images whose embed call failed; their pages stay dirty. */
  failed: z.number().int().nonnegative(),
  /**
   * Pages whose scan THREW — a database error, never a fact about an image
   * (#1115 P2, review r1). Separate from `failed` because a page that threw
   * embedded nothing at all (its transaction rolled back), and because the
   * remedy is different: an image failure is the provider, a page failure is
   * the index — most reachably a column typed to a width the assigned model
   * no longer answers with, after a guarded `ALTER` did not land.
   *
   * Defaulted rather than required so a row written before this field existed
   * still parses; the alternative is a silently-dropped last run on upgrade.
   */
  pagesFailed: z.number().int().nonnegative().default(0),
  skipped: ImageSkipCountsSchema,
});
export type ImageIndexRun = z.infer<typeof ImageIndexRunSchema>;

/**
 * `GET /api/admin/embedding/image-index` (#1115 P2).
 *
 * Three facts that read alike and are not, so none may be inferred from
 * another: whether the leg is ASSIGNED, what the column's identity IS, and
 * what the last run DID. Assigned-with-an-empty-index is a fresh assignment;
 * unassigned-with-rows is a leg that was turned off (unassigning destroys
 * nothing, ADR-025 D7); assigned-with-a-failed-run is an endpoint problem.
 *
 * `identity` carries the provider id and the model NAME only — no base URL and
 * no key. This is the index document, not the provider document, and #1184's
 * rule about what an admin read may echo applies whatever the route's gate.
 */
export const ImageIndexStatusSchema = z.object({
  /** Whether `image_embedding` resolves to a provider+model right now. */
  assigned: z.boolean(),
  identity: z
    .object({
      providerId: z.string().uuid(),
      model: z.string(),
      /** Width the column is typed to (`admin_settings.image_embedding_dimensions`). */
      dimensions: z.number().int().min(1).max(16_000).nullable(),
      tier: VectorIndexTierSchema.nullable(),
    })
    .nullable(),
  /**
   * Whether the index was built for the pair that is assigned RIGHT NOW
   * (review r1).
   *
   * `identity` above deliberately mixes two documents — the live assignment's
   * provider and model, the recorded index's width and tier — because that is
   * what an operator wants to read on one line. They can disagree: the column
   * DDL is guarded, so an `ALTER` that fails answers 200 with a warning and
   * leaves the new pair assigned against the old column. Without this flag the
   * card states a model+width pair no index has ever had, and the only visible
   * symptom is a backlog that will not drain. `null` when the leg is
   * unassigned (there is no live pair to compare) or when no rebuild has ever
   * recorded an identity (a fresh install, which is not a mismatch).
   */
  identityMatchesAssignment: z.boolean().nullable(),
  /** Rows in `page_image_embeddings`. */
  rows: z.number().int().nonnegative(),
  /** Live non-folder pages awaiting a scan. */
  pagesDirty: z.number().int().nonnegative(),
  /** Live non-folder pages in total — the denominator for "3 pending". */
  pagesTotal: z.number().int().nonnegative(),
  /** Whether the worker lock is held right now; the card polls on it. */
  running: z.boolean(),
  lastRun: ImageIndexRunSchema.nullable(),
});
export type ImageIndexStatus = z.infer<typeof ImageIndexStatusSchema>;

// ─── DEPRECATED: old two-slot enum kept for transitional typing only ──────
/** @deprecated use `LlmProvider.id` (uuid). Removed after Task 36. */
export const LlmProviderTypeSchema = z.enum(['ollama', 'openai']);
/** @deprecated */
export type LlmProviderType = z.infer<typeof LlmProviderTypeSchema>;
