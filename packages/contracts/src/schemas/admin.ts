import { z } from 'zod';

export const ReEmbedRequestSchema = z.object({
  model: z.string().optional(), // New embedding model (requires env var change + restart)
});

export type ReEmbedRequest = z.infer<typeof ReEmbedRequestSchema>;

export const ReferenceActionSchema = z.enum(['flag', 'strip', 'off']);
export type ReferenceAction = z.infer<typeof ReferenceActionSchema>;

// ─── Production retrieval benchmark (#deep-search-prod-benchmark) ────────
//
// The committed retrieval fixture is deliberately a dev-only quality gate.
// This request describes an admin-triggered, read-only comparison over the
// deployment's own query distribution instead of pretending those labels fit
// a different knowledge base.
export const RetrievalBenchmarkQuerySchema = z.object({
  id: z.string().trim().min(1).max(100).optional(),
  query: z.string().trim().min(3).max(1_000),
  /** Optional ground truth for custom suites; absent for analytics queries. */
  expectedPageIds: z.array(z.number().int().positive()).max(10).optional(),
});

export const RetrievalBenchmarkRequestSchema = z.object({
  source: z.enum(['recent-queries', 'custom']).default('recent-queries'),
  days: z.number().int().min(1).max(90).default(30),
  limit: z.number().int().min(1).max(100).default(25),
  topK: z.number().int().min(1).max(10).default(5),
  queries: z.array(RetrievalBenchmarkQuerySchema).min(1).max(100).optional(),
}).superRefine((value, ctx) => {
  if (value.source === 'custom' && !value.queries) {
    ctx.addIssue({ code: 'custom', path: ['queries'], message: 'Custom benchmarks require queries' });
  }
  if (value.source === 'recent-queries' && value.queries) {
    ctx.addIssue({ code: 'custom', path: ['queries'], message: 'Recent-query benchmarks do not accept queries' });
  }
});

export type RetrievalBenchmarkQuery = z.infer<typeof RetrievalBenchmarkQuerySchema>;
export type RetrievalBenchmarkRequest = z.infer<typeof RetrievalBenchmarkRequestSchema>;

// ─── #1260 — shadow-migration comparison on real queries ─────────────────
//
// During a #1116 shadow migration the corpus carries both models' vectors on
// the same chunk rows, which is the only window a real-data A/B is possible.
// This request starts a Mode 1 agreement run: sample the most frequent
// `search_analytics` queries over `days`, embed each once per model, retrieve
// top-K pages from `embedding` and `embedding_next`, and report where the two
// disagree. No labels, so no quality verdict — that is what the judgement
// below accumulates.
export const ShadowCompareRequestSchema = z.object({
  days: z.number().int().min(1).max(90).default(30),
  /** Distinct queries, by descending frequency. */
  limit: z.number().int().min(1).max(100).default(50),
  topK: z.number().int().min(1).max(20).default(10),
});

export type ShadowCompareRequest = z.infer<typeof ShadowCompareRequestSchema>;

/**
 * #1260 Mode 2 — one side-by-side judgement on a completed comparison run.
 * The client names only the run's query and which side answered it better;
 * the server derives the query text, both models and both page lists from
 * the run's own persisted result, so a judgement can never claim pages or
 * models the run did not show.
 */
export const ShadowCompareJudgementSideSchema = z.enum(['live', 'candidate', 'neither', 'both']);
export type ShadowCompareJudgementSide = z.infer<typeof ShadowCompareJudgementSideSchema>;

export const ShadowCompareJudgementRequestSchema = z.object({
  queryId: z.string().trim().min(1).max(100),
  side: ShadowCompareJudgementSideSchema,
});
export type ShadowCompareJudgementRequest = z.infer<typeof ShadowCompareJudgementRequestSchema>;

// ─── #1114 — the keyword-index language ──────────────────────────────────
//
// PostgreSQL text-search configurations the keyword leg of search may use,
// persisted in `admin_settings.fts_language` and edited in
// Settings → AI Models → Retrieval.
//
// **This list is a security boundary, not a convenience.** PostgreSQL has no
// bind-parameter form for a `regconfig`, so the chosen name is INTERPOLATED
// into SQL (`websearch_to_tsquery('<lang>', $2)` in `rag-service.ts`,
// `search.ts` and `pages-crud.ts`). The list must therefore stay closed, and
// the reader keeps its own runtime membership check on the value it loads
// from the database — the schema guards the write path, the reader guards a
// row written any other way (psql, a restored dump, a future migration).
//
// It lives in contracts so the panel, the route and the reader all read one
// list: three copies is how the select offers a language the reader would
// silently discard.
export const FTS_LANGUAGES = [
  'simple',
  'english',
  'german',
  'french',
  'spanish',
  'italian',
  'portuguese',
  'dutch',
  'swedish',
  'norwegian',
  'danish',
  'finnish',
  'hungarian',
  'turkish',
  'russian',
  'arabic',
  'romanian',
] as const;

export const FtsLanguageEnum = z.enum(FTS_LANGUAGES);
export type FtsLanguage = z.infer<typeof FtsLanguageEnum>;

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
/**
 * `rag_images_per_page_max` (#1115 P2) — how many of a page's images the
 * image-embedding worker takes. Default 20, [1, 200].
 *
 * **0 is not a value.** The image leg is switched off by unassigning the
 * `image_embedding` use case (ADR-021's rule for the non-inheriting use
 * cases); a cap of zero would be a second, quieter off switch whose effect —
 * a corpus that reconciles every row away on the next scan — reads as an
 * indexing bug rather than a setting.
 */
const RagImagesPerPageMaxSchema = z.number().int().min(1).max(200);
/**
 * `rag_image_index_external` (#1115 P2) — whether images a Confluence body
 * pulled from an external URL (`external-<12 hex>` in the cache) are indexed.
 * Default ON: they are page content like any other, and the knob is for
 * deployments that would rather not embed third-party imagery at all.
 */
const RagImageIndexExternalSchema = z.boolean();
/**
 * `rag_image_leg_enabled` (#1115 P3) — whether retrieval fuses a third,
 * image-based RRF leg. Default ON.
 *
 * It is not a second off switch for the feature: with the `image_embedding`
 * use case unassigned or the index empty the leg does not run at all, whatever
 * this says. What it buys is the ability to stop paying the leg's one extra
 * embedding call per question WITHOUT unassigning the use case and thereby
 * stopping the index being filled — the two halves have different costs and an
 * operator has to be able to turn off the query-time one on its own.
 */
const RagImageLegEnabledSchema = z.boolean();
/**
 * `rag_answer_max_images` (#1115 P4) — how many of the images the leg matched
 * on the pages that ground an answer are attached to the question as image
 * parts. Default 2, [0, 8].
 *
 * **0 IS a value here**, unlike `rag_images_per_page_max`. That one refuses 0
 * because a zero INTAKE cap reconciles every row away on the next scan — an
 * indexing bug's symptoms from a settings change. A zero ANSWER cap destroys
 * nothing: the index still fills, the leg still ranks pages, and the pictures
 * still ride the wire as `kind: 'image'` sources with their thumbnails. All it
 * turns off is the one cost this knob exists to bound — base64 image bytes in
 * a chat completion — so it has to be reachable without unassigning anything.
 *
 * The ceiling is 8 rather than the display cap's 4 (`MAX_IMAGE_SOURCES`): the
 * two bound different costs and must not be collapsed. A source chip is one
 * cacheable browser fetch; an answer part is `MAX_IMAGE_BYTES`-worth of base64
 * in a prompt, which is why the service behind this also carries a hard
 * byte budget the cap cannot exceed.
 */
const RagAnswerMaxImagesSchema = z.number().int().min(0).max(8);
/**
 * `rag_ef_search` (#1285) — the HNSW `ef_search` FLOOR every pgvector kNN probe
 * runs at. Default 100, range [1, 1000].
 *
 * The range is **pgvector's own bound**, not a reader-invented one: values
 * above 1000 are refused by the extension itself, and 0 is not a legal
 * `ef_search` at all — which is why this floor is 1 and not the 0 that would
 * read as an off switch. The reader mirrors both ends, treating a `'0'` row as
 * unset.
 *
 * It is a floor, not the per-query value: `efSearchFor` raises it to twice a
 * probe's raw row count when that is larger. And it is very unlikely to buy
 * recall — measured on the `halfvec(2560)` corpus the index is effectively
 * exact from 40 — so the panel's help text quotes that measurement rather than
 * inviting an operator to raise it.
 */
const RagEfSearchSchema = z.number().int().min(1).max(1000);

/**
 * #1115 — `image_embedding_target_dimensions`, the MRL truncation width the
 * image leg REQUESTS. Declared once and used nullable on read, nullish on
 * update (null clears the row, i.e. "use the model's native width").
 *
 * The bounds are pgvector's column limit at the top and a sanity floor at the
 * bottom. Deliberately NOT capped at 4000: that is the largest indexable
 * width, and the settings row already reports the unindexed tier — refusing
 * the number here would make an operator who *wants* a sequential-scan index
 * unable to say so.
 */
export const IMAGE_EMBEDDING_TARGET_DIMENSIONS_MIN = 64;
export const IMAGE_EMBEDDING_TARGET_DIMENSIONS_MAX = 16_000;
export const ImageEmbeddingTargetDimensionsSchema = z
  .number()
  .int()
  .min(IMAGE_EMBEDDING_TARGET_DIMENSIONS_MIN)
  .max(IMAGE_EMBEDDING_TARGET_DIMENSIONS_MAX);

/**
 * #1114 — which model a confidence threshold was calibrated against, and
 * whether that model is still the live one.
 *
 * The two thresholds sit on scales the MODELS decide: cosine similarity is
 * whatever the embedder's geometry makes it, rerank relevance whatever the
 * reranker's normalisation makes it (the argument for splitting them into
 * two knobs in the first place — see `RagConfidenceThresholdSchema`). So an
 * embedding swap or a rerank re-assignment silently reinterprets a number
 * nobody touched: 0.35 tuned on bge-m3 is a different gate on Qwen3.
 *
 * The ruling is **warn, don't mutate** — a model change never rewrites
 * refusal policy behind the operator's back. The server records the pair
 * beside the threshold when it is written, compares it with the live
 * assignment on read, and the panel says so until the threshold is saved
 * again.
 *
 * **All four id/model fields are nullable, and the two halves mean different
 * things** (review r1). `liveProviderId` / `liveModel` null is "nothing is
 * assigned for this basis right now" — a real state, ADR-021's unassigned
 * rerank = stage disabled — and it is a STALE one when a pair was recorded,
 * because the threshold now gates against nothing it was tuned on.
 * `providerId` / `model` null is the mirror image: the threshold was WRITTEN
 * while nothing was assigned, which is equally real and equally a fact worth
 * keeping. Collapsing that second case into "no record at all" made the panel
 * report a threshold saved seconds ago as predating the feature, and made its
 * remedy ("save it to record the live model") a permanent no-op, since saving
 * again recorded the same absence. A record whose pair is null is a record: it
 * goes stale the moment a model appears behind that basis.
 *
 * **A resolver FAILURE is a third state, and it rides on `liveResolved`**
 * (review r3). The write path already refuses to collapse the two — it
 * abstains rather than persist "tuned against nothing" — but the read path
 * shipped `{resolved:false, pair:null}` and `{resolved:true, pair:null}` to
 * the wire identically, and the panel then stated the second one's copy ("no
 * model is assigned now") as a fact about `llm_usecase_assignments`. That is
 * false, and persistently so, when the row is present and merely unreadable:
 * a `PAT_ENCRYPTION_KEY` rotation that leaves `api_key` undecryptable, or an
 * EE org policy pointing at a deleted provider, both throw on every GET. The
 * operator is then sent to the assignment grid instead of to the provider
 * row. `stale` is deliberately unchanged by it — erring toward "this still
 * needs attention" is the safe direction — but the sentence must name the
 * cause it actually knows.
 *
 * **Provider id and model name only.** This rides the same `GET
 * /api/admin/settings` payload as everything else on this schema; base URLs
 * and API keys stay on `/api/admin/llm-providers`, which redacts them.
 */
export const ConfidenceCalibrationSchema = z.object({
  providerId: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  /** ISO instant the threshold was last written with this pair recorded. */
  setAt: z.string().datetime(),
  liveProviderId: z.string().min(1).nullable(),
  liveModel: z.string().min(1).nullable(),
  /**
   * False when the resolver itself could not answer. Then `liveProviderId` /
   * `liveModel` are null for lack of an answer, NOT because nothing is
   * assigned — a distinction the panel's copy turns on.
   */
  liveResolved: z.boolean(),
  stale: z.boolean(),
});

/**
 * Both bases' calibration, `null` only where none was ever recorded — a
 * threshold set before #1114, one at 0 (nothing to calibrate), or a row that
 * no longer parses. Null is deliberately NOT rendered as a warning by the
 * panel: an absent record is the absence of evidence, not evidence of a
 * change. "Recorded while no model was assigned" is NOT this case; it is a
 * present record with a null pair (above).
 */
export const RagConfidenceCalibrationSchema = z.object({
  similarity: ConfidenceCalibrationSchema.nullable(),
  rerank: ConfidenceCalibrationSchema.nullable(),
});

/**
 * #1114 review r3 — what `PUT /api/admin/settings` DID with a threshold's
 * calibration, reported per basis.
 *
 * The panel's remedy for a stale (or unrecorded) calibration is a button that
 * re-writes the same number so the server re-records the pair beside it. The
 * server can decline: it abstains when `resolveConfidenceBasisPair` reports
 * `resolved: false`, and the bookkeeping row itself is written best-effort.
 * Either way the threshold row lands and the route answers **200**, so a
 * client that infers success from the status code tells the operator
 * "recorded", invalidates the query, and the notice comes straight back with
 * nothing on screen explaining why. `resolved: false` is not always
 * transient — an undecryptable `api_key` after a key rotation and an EE
 * policy naming a deleted provider both persist — so that is a permanent
 * dead end, the same shape review r2 removed one layer up.
 *
 * Four outcomes, because each needs different words:
 *  - `recorded` — written; `model` names the pair it was recorded against,
 *    `null` when nothing is assigned for that basis (a real record, ADR-021's
 *    disabled rerank stage);
 *  - `cleared` — the threshold went to 0, so the record was deleted;
 *  - `unresolved` — the live model could not be resolved; the previous record
 *    stands;
 *  - `failed` — the record write itself failed; the previous record stands.
 *
 * `model` only. The provider id is part of the *stored* identity (two
 * providers serving one model are two deployments of it) but this object
 * exists to word a toast, and a UUID in a toast is noise.
 */
export const ConfidenceCalibrationWriteSchema = z.object({
  outcome: z.enum(['recorded', 'cleared', 'unresolved', 'failed']),
  model: z.string().min(1).nullable(),
});

/** Per basis, `null` where this request carried no threshold for it. */
export const RagConfidenceCalibrationWriteSchema = z.object({
  similarity: ConfidenceCalibrationWriteSchema.nullable(),
  rerank: ConfidenceCalibrationWriteSchema.nullable(),
});

/** The body of a successful `PUT /api/admin/settings`. */
export const UpdateAdminSettingsResultSchema = z.object({
  message: z.string(),
  /**
   * Absent on the empty-body "No changes" answer, and on a server that
   * predates #1114 — the panel treats absence as "the server said nothing",
   * never as a failure.
   */
  ragConfidenceCalibrationWrite: RagConfidenceCalibrationWriteSchema.optional(),
});

// AdminSettings is now scoped to non-LLM configuration only.
// LLM provider configuration lives in the `llm_providers` table and is
// managed through `/api/admin/llm-providers` + `/api/admin/llm-usecases`.
// Embedding dimensions remain here because the shared `page_embeddings`
// vector column size is decided once per install (with admin-triggered
// reembeds when the active provider's dimension changes).
export const AdminSettingsSchema = z.object({
  embeddingDimensions: z.number().int().min(128).max(4096),
  ftsLanguage: FtsLanguageEnum,
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
  /**
   * #1115 — MRL truncation width for the `image_embedding` leg, or `null` to
   * take whatever width the served checkpoint answers with.
   *
   * It is a REQUEST parameter, not a serving flag: vLLM's `dimensions` is
   * per-request and `--hf-overrides '{"is_matryoshka": true}'` only makes the
   * server accept it. So the number has to live somewhere the client can read
   * it — here — and the probe, P2's image embedder and P3's query embed all
   * send the same value, or the column is typed to one width and filled from
   * another.
   *
   * The floor is 64 because MRL truncation below that is not a width any of
   * these checkpoints is trained to be useful at; the ceiling is pgvector's
   * own column limit. 4000 is the largest *indexable* width — that is a tier
   * boundary the settings row states, not a validation error.
   */
  imageEmbeddingTargetDimensions: ImageEmbeddingTargetDimensionsSchema.nullable(),
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
  /**
   * #1115 P2 — the image-index intake knobs, required on read for the same
   * reason as the nine above: the GET resolves them through their own reader,
   * so an absent row answers with the value the worker is using and no panel
   * has to restate a default.
   */
  ragImagesPerPageMax: RagImagesPerPageMaxSchema,
  ragImageIndexExternal: RagImageIndexExternalSchema,
  /** #1115 P3 — the retrieval half of the image index. Default ON. */
  ragImageLegEnabled: RagImageLegEnabledSchema,
  /** #1115 P4 — how many retrieved images the answer path shows the model. */
  ragAnswerMaxImages: RagAnswerMaxImagesSchema,
  /**
   * #1285 — the HNSW `ef_search` floor, required on read for the same reason
   * as every knob above: the GET resolves it through its own reader, so an
   * absent row (and a deployment still on the deprecated `RAG_EF_SEARCH` env
   * var) answers with the value the kNN probes are really using.
   */
  ragEfSearch: RagEfSearchSchema,
  /**
   * #1285 (review r1) — whether that value came from the deprecated
   * `RAG_EF_SEARCH` environment variable rather than from a `rag_ef_search`
   * row. Read-only, and there is deliberately no write counterpart: it is a
   * fact about where the server resolved the number, not a setting.
   *
   * The panel needs it because Save is a pure value diff. On an instance still
   * running on the variable the field already shows what the server resolved,
   * so nothing is ever "changed" and the row the panel tells the operator to
   * write cannot be written from it — the same dead end #1114's calibration
   * notice hit, fixed the same way, with a one-key mutation beside the note.
   */
  ragEfSearchFromEnv: z.boolean(),
  /**
   * #1114 — read-only, and deliberately absent from the update schema below.
   * The server resolves the pair itself when it writes a threshold; a client
   * that could assert this could also assert "still calibrated" for a
   * threshold tuned against a model that is long gone.
   */
  ragConfidenceCalibration: RagConfidenceCalibrationSchema,
});

export const UpdateAdminSettingsSchema = z.object({
  ftsLanguage: FtsLanguageEnum.optional(),
  embeddingChunkSize: z.number().int().min(128).max(2048).optional(),
  embeddingChunkOverlap: z.number().int().min(0).max(512).optional(),
  /**
   * Update semantics:
   *  - field omitted → leave existing value unchanged
   *  - null          → clear stored value (backend deletes the row, falls back to default)
   *  - URL string    → set / replace value
   */
  drawioEmbedUrl: z.string().url().nullish(),
  /**
   * #1115 — same three-state update semantics as `drawioEmbedUrl`: omitted
   * leaves the row alone, `null` deletes it (back to the model's native
   * width), a number sets the truncation width every image-side call sends.
   */
  imageEmbeddingTargetDimensions: ImageEmbeddingTargetDimensionsSchema.nullish(),
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
  /**
   * #1115 P2 — optional on update, same omit-to-leave-unchanged rule. The
   * Retrieval tab gains the controls in P3; the schema and the backend
   * read/write land here so the worker's knobs are settable from the moment
   * the worker exists.
   */
  ragImagesPerPageMax: RagImagesPerPageMaxSchema.optional(),
  ragImageIndexExternal: RagImageIndexExternalSchema.optional(),
  /** #1115 P3 — the Retrieval tab's `Image leg` toggle. */
  ragImageLegEnabled: RagImageLegEnabledSchema.optional(),
  /** #1115 P4 — the Retrieval tab's `Images shown to the model` cap. */
  ragAnswerMaxImages: RagAnswerMaxImagesSchema.optional(),
  /** #1285 — the Retrieval tab's `Index search depth` floor, beside Fetch width. */
  ragEfSearch: RagEfSearchSchema.optional(),
});

export type AdminSettings = z.infer<typeof AdminSettingsSchema>;
/** #1114 — one basis' calibration record plus the live comparison. */
export type ConfidenceCalibration = z.infer<typeof ConfidenceCalibrationSchema>;
/** #1114 — both bases, as `GET /api/admin/settings` reports them. */
export type RagConfidenceCalibration = z.infer<typeof RagConfidenceCalibrationSchema>;
/** #1114 — what the PUT did with one basis' calibration record. */
export type ConfidenceCalibrationWrite = z.infer<typeof ConfidenceCalibrationWriteSchema>;
/** #1114 — both bases, as `PUT /api/admin/settings` reports them. */
export type RagConfidenceCalibrationWrite = z.infer<typeof RagConfidenceCalibrationWriteSchema>;
/** #1114 — the body of a successful `PUT /api/admin/settings`. */
export type UpdateAdminSettingsResult = z.infer<typeof UpdateAdminSettingsResultSchema>;
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

// ─── Issue #1284 — observed confidence distribution (read-only) ──────────
// `GET /api/analytics/confidence-distribution` — the shape behind the
// readout under each threshold on Settings → AI Models → Retrieval.
//
// Deliberately NOT part of `AdminSettingsSchema`: this is a measurement of
// what the deployment has been doing, not a setting the panel writes, and
// `GET /admin/settings` is a settings document that is already doing enough.

/** One basis's observed distribution over the window. */
export const ConfidenceDistributionBucketSchema = z.object({
  /**
   * Median and 90th percentile of the recorded `rag.confidence` values, both
   * `null` when `count` is 0 — never NaN, and never 0, which would read as a
   * measured verdict rather than as an empty sample.
   */
  p50: z.number().nullable(),
  p90: z.number().nullable(),
  /**
   * How many assistant questions the two percentiles were computed over. It
   * is required, not optional: a p90 over eleven questions is noise, and a
   * readout without a sample size invites tuning against it.
   */
  count: z.number().int().min(0),
});
export type ConfidenceDistributionBucket = z.infer<typeof ConfidenceDistributionBucketSchema>;

export const ConfidenceDistributionSchema = z.object({
  /** Fixed window, in days. Not configurable in this pass. */
  windowDays: z.number().int().positive(),
  /**
   * Which `search_analytics.surface` the sample was drawn from — `'ask'`.
   * On the wire because the panel's copy names it, and a readout that says
   * "assistant questions" while the server counted something else would be
   * the one thing this feature must not do.
   */
  surface: z.literal('ask'),
  /**
   * Per BASIS, never merged: the basis flips per request (a rerank bypass
   * measures that request on the cosine scale), and the two thresholds are
   * two knobs precisely because the two scales are unrelated.
   */
  similarity: ConfidenceDistributionBucketSchema,
  rerank: ConfidenceDistributionBucketSchema,
});
export type ConfidenceDistribution = z.infer<typeof ConfidenceDistributionSchema>;

// ─── #1349 — attachment storage observability + orphan sweep ─────────────────
// Shared contract for `GET /api/admin/attachments/stats`,
// `POST /api/admin/attachments/sweep` and `GET /api/admin/attachments/sweep`.
// New named schemas appended at the end of this file by convention (parallel
// lanes append their own; never reorder).

/**
 * One store's figures as the last walk measured them. The two stores are
 * walked SEPARATELY: the Confluence-style tree (`<ATTACHMENTS_DIR>/<key>/`)
 * and the local store (`<ATTACHMENTS_DIR>/local/<page_id>/`).
 */
export const AttachmentStoreSweepStatsSchema = z.object({
  /** Total bytes of the store's plain files (dot-files excluded). */
  bytes: z.number().int().nonnegative(),
  /** Plain files counted (dot-files excluded). */
  files: z.number().int().nonnegative(),
  /** Attachment-key directories walked. */
  directories: z.number().int().nonnegative(),
  /** Directories whose key matches no page row at all (grace-window aged). */
  orphanDirectories: z.number().int().nonnegative(),
  orphanDirectoryBytes: z.number().int().nonnegative(),
  /** Files orphaned inside a directory that DOES belong to a page. */
  orphanFiles: z.number().int().nonnegative(),
  orphanFileBytes: z.number().int().nonnegative(),
  /** Candidates skipped only because they are younger than the grace window. */
  graceSkipped: z.number().int().nonnegative(),
  /**
   * Pageless directories skipped because a contained filename sits in the
   * keep-set — some body text still references a file inside, so the
   * directory-level verdict stands down (never deleted, counted here).
   * Defaulted so records persisted before the field existed still parse.
   */
  keepProtectedDirectories: z.number().int().nonnegative().default(0),
  /**
   * Pageless directories skipped because they hold an entry the walk could not
   * MEASURE (#1349 review r1) — a subdirectory, or anything else that is not a
   * plain file (a symlink, socket or device; verification round). An
   * attachment key directory is flat by construction, so such an entry under
   * one is something else wearing a key-shaped name — and the walk counts only
   * plain files, which would make the keep-set and grace-window checks vacuous
   * and the whole thing a `bytes: 0` recursive delete. Structural, never
   * judged, counted here.
   *
   * The NAME is historical and kept deliberately: renaming it would orphan
   * every persisted stats record. The card's copy says "sub-folders or links".
   * Defaulted so records persisted before the field existed still parse.
   */
  nestedDirectories: z.number().int().nonnegative().default(0),
  /**
   * Store-root directories whose NAME is not a usable attachment key (fixer
   * r1) — `tmp.12345/`, `12345 (copy)/`, a numeric name above `pages.id`'s
   * int4 range. Each is dropped BEFORE the walk opens it, so it contributes to
   * none of `bytes` / `files` / `directories` and is judged by nothing.
   * Skipping is the correct verdict; leaving it uncounted was not, on a card
   * whose contract is to name every verdict the walk declined to reach — its
   * bytes were simply missing from the figures. Reserved store names
   * (`local/`, `page-icons/`) and dot-directories are NOT counted here: the
   * first two are other stores and the third is #1169 debris, neither of which
   * this store was ever going to measure.
   * Defaulted so records persisted before the field existed still parse.
   */
  unkeyedDirectories: z.number().int().nonnegative().default(0),
  /** Directories whose readdir failed — never judged, reported instead. */
  unreadableDirectories: z.number().int().nonnegative(),
});
export type AttachmentStoreSweepStats = z.infer<typeof AttachmentStoreSweepStatsSchema>;

/** One orphan candidate (dry run) or deletion (live run), for the sample list. */
export const AttachmentSweepCandidateSchema = z.object({
  store: z.enum(['confluence', 'local']),
  /** Attachment-key directory (`confluence_id` | page id | local page id). */
  key: z.string(),
  /** `null` = the whole directory is the candidate. */
  filename: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  reason: z.enum(['orphan_directory', 'orphan_file']),
});
export type AttachmentSweepCandidate = z.infer<typeof AttachmentSweepCandidateSchema>;

/** What a live run deleted; `null` on a dry run (nothing is ever touched). */
export const AttachmentSweepDeletedSchema = z.object({
  directories: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  /** `page_image_embeddings` rows removed for files the sweep deleted (safety net). */
  imageEmbeddingRows: z.number().int().nonnegative(),
  /** Pages marked `image_embedding_dirty` because their files were removed. */
  pagesMarkedDirty: z.number().int().nonnegative(),
});
export type AttachmentSweepDeleted = z.infer<typeof AttachmentSweepDeletedSchema>;

/**
 * What the last sweep run (dry or live) did — the persisted record the admin
 * card reads. `refused` means the run declined to judge or delete anything
 * (an unreadable root, or a live run where BOTH stores are empty on disk while
 * the database still references them — a mis-pointed `ATTACHMENTS_DIR`). When
 * only one store is anomalous the run completes, sweeps the sound store and
 * carries the reason in `note`.
 */
export const AttachmentSweepRunSchema = z.object({
  /** ISO-8601 completion time. */
  at: z.string(),
  dryRun: z.boolean(),
  status: z.enum(['completed', 'refused', 'failed']),
  /**
   * Human-readable reason for `refused` / `failed` — and, since #1349 review
   * r1, for a `completed` live run that swept ONE store because the other was
   * anomalous (empty on disk while the database references it). Null on an
   * unqualified completion.
   */
  note: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  /** Per-store figures; null when the walk never completed. */
  stores: z
    .object({
      confluence: AttachmentStoreSweepStatsSchema,
      local: AttachmentStoreSweepStatsSchema,
    })
    .nullable(),
  /** `local_attachments` rows whose file is missing on disk — counted, never deleted. */
  missingLocalFiles: z.number().int().nonnegative(),
  /** Bounded sample of candidates/deletions; `candidatesTotal` is the real count. */
  candidateSample: z.array(AttachmentSweepCandidateSchema),
  candidatesTotal: z.number().int().nonnegative(),
  deleted: AttachmentSweepDeletedSchema.nullable(),
});
export type AttachmentSweepRun = z.infer<typeof AttachmentSweepRunSchema>;

/** `GET /api/admin/attachments/sweep` — status + the persisted last run. */
export const AttachmentSweepStatusSchema = z.object({
  /** Whether the sweep worker lock is held right now; the card polls on it. */
  running: z.boolean(),
  lastRun: AttachmentSweepRunSchema.nullable(),
});
export type AttachmentSweepStatus = z.infer<typeof AttachmentSweepStatusSchema>;

/** `POST /api/admin/attachments/sweep` body. */
export const AttachmentSweepTriggerSchema = z.object({
  dryRun: z.boolean(),
});
export type AttachmentSweepTrigger = z.infer<typeof AttachmentSweepTriggerSchema>;

/** `POST /api/admin/attachments/sweep` 202 response. */
export const AttachmentSweepTriggerResponseSchema = z.object({
  started: z.boolean(),
  alreadyRunning: z.boolean(),
});
export type AttachmentSweepTriggerResponse = z.infer<typeof AttachmentSweepTriggerResponseSchema>;

/**
 * `GET /api/admin/attachments/stats` — read from the persisted record only.
 * The GET never walks the tree (the card polls it); a fresh figure is
 * obtained by pressing Dry run. `stores: null` + `computedAt: null` is the
 * explicit "no run yet" state.
 */
export const AttachmentStorageStatsSchema = z.object({
  computedAt: z.string().nullable(),
  running: z.boolean(),
  stores: z
    .object({
      confluence: AttachmentStoreSweepStatsSchema,
      local: AttachmentStoreSweepStatsSchema,
    })
    .nullable(),
  missingLocalFiles: z.number().int().nonnegative().nullable(),
});
export type AttachmentStorageStats = z.infer<typeof AttachmentStorageStatsSchema>;
