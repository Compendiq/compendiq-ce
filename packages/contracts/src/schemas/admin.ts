import { z } from 'zod';

export const ReEmbedRequestSchema = z.object({
  model: z.string().optional(), // New embedding model (requires env var change + restart)
});

export type ReEmbedRequest = z.infer<typeof ReEmbedRequestSchema>;

export const ReferenceActionSchema = z.enum(['flag', 'strip', 'off']);
export type ReferenceAction = z.infer<typeof ReferenceActionSchema>;

// ─── #1118 — retrieval knobs (epic #1100) ────────────────────────────────
//
// Nine `admin_settings` rows the retrieval pipeline reads through 60-second
// in-process caches. Each schema below MIRRORS ITS READER in
// `backend/src/core/services/admin-settings-service.ts` exactly — the panel
// would otherwise accept a value the reader silently discards, and report
// "saved" for a setting that never took effect.
//
// Two reader behaviours the ranges encode, both deliberate:
//   - the two integer pools treat their MIN as a validity floor, not a clamp
//     (`safeIntOr` falls back to the DEFAULT below it), so the schema refuses
//     sub-minimum values rather than letting them round-trip as the default;
//   - both confidence thresholds are half-open. The reader rejects `'1'`
//     outright — an operator asking for maximal strictness must not silently
//     get "gate off" — so this is `.lt(1)`, never `.max(1)`.
//
// Each is declared once and re-used with `.optional()` on the update schema,
// so read and update cannot drift apart.

/** `rag_fetch_width` (#1103) — per-leg candidate width. Default 10. */
const RagFetchWidthSchema = z.number().int().min(10).max(200);
/** `rag_rerank_candidates` (#1104) — cross-encoder pool size. Default 30. */
const RagRerankCandidatesSchema = z.number().int().min(10).max(100);
/**
 * `rag_confidence_threshold` / `rag_confidence_threshold_rerank` (#1105) —
 * one per basis, both default 0 (gate off, confidence diagnostic-only).
 */
const RagConfidenceThresholdSchema = z.number().min(0).lt(1);
/** `rag_context_chars_per_page` (#1106) — 0 disables assembly. Default 6000. */
const RagContextCharsPerPageSchema = z.number().int().min(0).max(24_000);
/** `rag_pin_identifiers` (#1107) — exact-identifier pin stage. Default ON. */
const RagPinIdentifiersSchema = z.boolean();
/** `rag_mmr_enabled` (#1109) — diversity narrow. Default OFF. */
const RagMmrEnabledSchema = z.boolean();
/** `rag_mmr_lambda` (#1109) — relevance/diversity trade-off. Default 0.7. */
const RagMmrLambdaSchema = z.number().min(0).max(1);
/**
 * `rag_ranking_prior_weight` (#1111) — quality/recency prior. Default 0
 * (stage off). The ceiling is the leg-agreement gap: at 0.05 the prior would
 * start outranking retrieval itself.
 */
const RagRankingPriorWeightSchema = z.number().min(0).max(0.05);

// AdminSettings is now scoped to non-LLM configuration only.
// LLM provider configuration lives in the `llm_providers` table and is
// managed through `/api/admin/llm-providers` + `/api/admin/llm-usecases`.
// Embedding dimensions remain here because the shared `page_embeddings`
// vector column size is decided once per install (with admin-triggered
// reembeds when the active provider's dimension changes).
export const AdminSettingsSchema = z.object({
  embeddingDimensions: z.number().int().min(128).max(4096),
  ftsLanguage: z.string().min(1),
  embeddingChunkSize: z.number().int().min(128).max(2048),
  embeddingChunkOverlap: z.number().int().min(0).max(512),
  /**
   * URL of the draw.io embed server used in the diagram editor.
   * Null means the default (https://embed.diagrams.net) is used.
   * Useful for corporate/firewalled environments that need a self-hosted draw.io instance.
   * The backend returns an explicit `null` when unset (see GET /api/admin/settings),
   * so the read schema must accept `null` rather than `undefined`.
   */
  drawioEmbedUrl: z.string().url().nullable(),
  // AI Safety settings
  aiGuardrailNoFabrication: z.string().max(5000).optional(),
  aiGuardrailNoFabricationEnabled: z.boolean().optional(),
  aiOutputRuleStripReferences: z.boolean().optional(),
  aiOutputRuleReferenceAction: ReferenceActionSchema.optional(),
  /**
   * Issue #705 — Swiss spelling. When true, the output post-processor replaces
   * every `ß` with `ss` and capital `ẞ` (U+1E9E) with `SS` on the final AI
   * output (Improve / Summarize / Generate). Switzerland abolished the eszett,
   * so for Swiss teams every `ß` the model emits is wrong. Default off.
   */
  aiOutputRuleSwissSpelling: z.boolean().optional(),
  // Rate limits (requests per minute)
  rateLimitGlobal: z.number().int().min(10).max(10000).optional(),
  rateLimitAuth: z.number().int().min(3).max(1000).optional(),
  rateLimitAdmin: z.number().int().min(5).max(1000).optional(),
  rateLimitLlmStream: z.number().int().min(1).max(1000).optional(),
  rateLimitLlmEmbedding: z.number().int().min(1).max(1000).optional(),
  /**
   * Issue #257 — how many completed/failed re-embed-all BullMQ jobs are
   * retained in Redis before the oldest get swept. Takes effect on the
   * next re-embed run (read per-enqueue inside `enqueueReembedAll`).
   * Default 150, clamped to [10, 10000].
   */
  reembedHistoryRetention: z.number().int().min(10).max(10_000),
  // Per-user concurrent SSE-stream cap (#268). Separate from rateLimitLlmStream:
  // that caps requests/minute; this caps concurrently-open streams.
  llmMaxConcurrentStreamsPerUser: z.number().int().min(1).max(20).optional(),
  /**
   * Issue #264 — retention (days) for `audit_log` rows where
   * action = 'ADMIN_ACCESS_DENIED'. Consumed by the targeted purge in
   * `data-retention-service.ts :: runAdminAccessDeniedRetention`. Default
   * 90, clamped to [7, 3650]. Does NOT affect other audit actions — they
   * continue to follow the umbrella `audit_log: 365 days` sweep.
   */
  adminAccessDeniedRetentionDays: z.number().int().min(7).max(3650),
  /**
   * Compendiq/compendiq-ee#113 Phase B-3 — cluster-wide LLM queue
   * concurrency. Persisted in `admin_settings.llm_concurrency` and
   * broadcast via the `admin:llm:settings` cache-bus channel. Default 4
   * (matches `LLM_CONCURRENCY` env var fallback in
   * `domains/llm/services/llm-queue.ts`).
   */
  llmConcurrency: z.number().int().min(1).max(100),
  /**
   * Compendiq/compendiq-ee#113 Phase B-3 — cluster-wide LLM queue
   * max-queue-depth (rejects new requests with QueueFullError when the
   * pending count is at this cap). Persisted in
   * `admin_settings.llm_max_queue_depth`. Default 50 (matches
   * `LLM_MAX_QUEUE_DEPTH` env var fallback). Capped at 1000 to keep
   * per-pod memory bounded; the route handler enforces this same range.
   */
  llmMaxQueueDepth: z.number().int().min(1).max(1000),
  /**
   * Issue #1051 — deployment-level self-registration policy. Persisted in
   * `admin_settings.registration_mode`.
   *   - `closed` (default): public `POST /api/auth/register` is rejected with
   *     403 `registration_disabled` once a real admin exists.
   *   - `open`: any visitor may self-register.
   * Registration is always implicitly allowed during bootstrap (before the
   * first real admin exists) regardless of this value, so the very first
   * account can be created on a fresh install.
   */
  registrationMode: z.enum(['open', 'closed']),
  /**
   * #1118 — the retrieval knobs, required on read. The GET handler resolves
   * each through its own cached getter, so an absent row answers with the
   * same value the pipeline is using rather than with `undefined`; a panel
   * that had to guess the default would drift from the reader the first time
   * one moved.
   */
  ragFetchWidth: RagFetchWidthSchema,
  ragRerankCandidates: RagRerankCandidatesSchema,
  ragConfidenceThreshold: RagConfidenceThresholdSchema,
  ragConfidenceThresholdRerank: RagConfidenceThresholdSchema,
  ragContextCharsPerPage: RagContextCharsPerPageSchema,
  ragPinIdentifiers: RagPinIdentifiersSchema,
  ragMmrEnabled: RagMmrEnabledSchema,
  ragMmrLambda: RagMmrLambdaSchema,
  ragRankingPriorWeight: RagRankingPriorWeightSchema,
});

export const UpdateAdminSettingsSchema = z.object({
  ftsLanguage: z.string().min(1).optional(),
  embeddingChunkSize: z.number().int().min(128).max(2048).optional(),
  embeddingChunkOverlap: z.number().int().min(0).max(512).optional(),
  /**
   * Update semantics:
   *  - field omitted → leave existing value unchanged
   *  - null          → clear stored value (backend deletes the row, falls back to default)
   *  - URL string    → set / replace value
   */
  drawioEmbedUrl: z.string().url().nullish(),
  // AI Safety settings
  aiGuardrailNoFabrication: z.string().max(5000).optional(),
  aiGuardrailNoFabricationEnabled: z.boolean().optional(),
  aiOutputRuleStripReferences: z.boolean().optional(),
  aiOutputRuleReferenceAction: ReferenceActionSchema.optional(),
  /** Issue #705 — Swiss spelling (ß→ss). Optional on update; omitted → unchanged. */
  aiOutputRuleSwissSpelling: z.boolean().optional(),
  // Rate limits (requests per minute)
  rateLimitGlobal: z.number().int().min(10).max(10000).optional(),
  rateLimitAuth: z.number().int().min(3).max(1000).optional(),
  rateLimitAdmin: z.number().int().min(5).max(1000).optional(),
  rateLimitLlmStream: z.number().int().min(1).max(1000).optional(),
  rateLimitLlmEmbedding: z.number().int().min(1).max(1000).optional(),
  /** Issue #257 — optional on update; omitted → leave unchanged. */
  reembedHistoryRetention: z.number().int().min(10).max(10_000).optional(),
  // Per-user concurrent SSE-stream cap (#268).
  llmMaxConcurrentStreamsPerUser: z.number().int().min(1).max(20).optional(),
  /** Issue #264 — optional on update; omitted → leave unchanged. */
  adminAccessDeniedRetentionDays: z.number().int().min(7).max(3650).optional(),
  /**
   * Compendiq/compendiq-ee#113 Phase B-3 — optional on update; omitted →
   * leave the cluster-wide concurrency unchanged. Range mirrors the
   * `setConcurrency` clamp in `llm-queue.ts` ([1, 100]).
   */
  llmConcurrency: z.number().int().min(1).max(100).optional(),
  /**
   * Compendiq/compendiq-ee#113 Phase B-3 — optional on update; omitted →
   * leave the cluster-wide max-queue-depth unchanged. Capped at 1000 to
   * keep per-pod memory bounded.
   */
  llmMaxQueueDepth: z.number().int().min(1).max(1000).optional(),
  /** Issue #1051 — optional on update; omitted → leave the registration policy unchanged. */
  registrationMode: z.enum(['open', 'closed']).optional(),
  /**
   * #1118 — optional on update; omitted → leave the row untouched. The panel
   * sends only the fields it changed, which is what keeps an operator who
   * never opened the confidence section from having a `'0'` row written on
   * their behalf (absent and `'0'` read alike, but a row nobody set is a
   * misleading thing to find in `admin_settings`).
   */
  ragFetchWidth: RagFetchWidthSchema.optional(),
  ragRerankCandidates: RagRerankCandidatesSchema.optional(),
  ragConfidenceThreshold: RagConfidenceThresholdSchema.optional(),
  ragConfidenceThresholdRerank: RagConfidenceThresholdSchema.optional(),
  ragContextCharsPerPage: RagContextCharsPerPageSchema.optional(),
  ragPinIdentifiers: RagPinIdentifiersSchema.optional(),
  ragMmrEnabled: RagMmrEnabledSchema.optional(),
  ragMmrLambda: RagMmrLambdaSchema.optional(),
  ragRankingPriorWeight: RagRankingPriorWeightSchema.optional(),
});

export type AdminSettings = z.infer<typeof AdminSettingsSchema>;
export type UpdateAdminSettingsInput = z.infer<typeof UpdateAdminSettingsSchema>;

// ─── Issue #257 — admin embedding-lock visibility + force-release ────────
// Shared contract between `GET /api/admin/embedding/locks` / the force-release
// POST and the frontend `ActiveEmbeddingLocksBanner`. See plan §2.10 / §3.3.

/**
 * Safety TTL on every `embedding:lock:${userId}` key in Redis (milliseconds).
 * Mirrors `EMBEDDING_LOCK_TTL` in `backend/src/core/services/redis-cache.ts`
 * (1 hour, in seconds there — kept aligned across both sides). Exposed from
 * the contracts package so the frontend can derive "held for" without
 * hardcoding the value. When the backend constant moves, update this too.
 */
export const EMBEDDING_LOCK_TTL_MS = 3_600_000;

export const EmbeddingLockSnapshotSchema = z.object({
  /** Lock holder. Usually a user id, but can also be the synthetic
   *  `__reembed_all__` system lock (which the admin endpoint filters out). */
  userId: z.string().min(1),
  /** Random UUID written by `acquireEmbeddingLock`. The worker's holder-epoch
   *  guard compares this every 20 pages to detect a force-release. May be
   *  the empty string when the SCAN caught the key but the subsequent GET
   *  raced against a release. */
  holderEpoch: z.string(),
  /** `PTTL` return in milliseconds. `-1` = no TTL (shouldn't happen),
   *  `-2` = key missing. */
  ttlRemainingMs: z.number().int(),
});
export type EmbeddingLockSnapshot = z.infer<typeof EmbeddingLockSnapshotSchema>;

export const AdminEmbeddingLocksResponseSchema = z.object({
  locks: z.array(EmbeddingLockSnapshotSchema),
});
export type AdminEmbeddingLocksResponse = z.infer<typeof AdminEmbeddingLocksResponseSchema>;

export const ForceReleaseLockResponseSchema = z.object({
  /** `true` when the key existed and was deleted; `false` when the lock was
   *  already gone (idempotent — no 404). */
  released: z.boolean(),
  userId: z.string().min(1),
});
export type ForceReleaseLockResponse = z.infer<typeof ForceReleaseLockResponseSchema>;
