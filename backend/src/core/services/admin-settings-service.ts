import { query } from '../db/postgres.js';
import { makeCachedSetting } from './cached-setting.js';
import { safeIntOr } from '../utils/safe-int.js';
import { logger } from '../utils/logger.js';

/**
 * Returns the embedding vector dimension used by the shared `page_embeddings`
 * column. Falls back to `EMBEDDING_DIMENSIONS` env (1024 default) when the
 * `embedding_dimensions` row is unset.
 *
 * LLM provider configuration previously lived in this file (getSharedLlmSettings,
 * upsertUsecaseLlmAssignments, etc.) but now lives in the `llm_providers` +
 * `llm_usecase_assignments` tables. See `domains/llm/services/llm-provider-resolver.ts`.
 */
export async function getEmbeddingDimensions(): Promise<number> {
  const r = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key='embedding_dimensions'`,
  );
  const v = r.rows[0]?.setting_value;
  if (v) {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return parseInt(process.env.EMBEDDING_DIMENSIONS ?? '1024', 10);
}

/**
 * Per-leg retrieval candidate fetch width (#1103): how many rows each RAG
 * retrieval leg pulls before fusion and ranking, decoupled from the number of
 * results the caller gets back. `resolveStageLimit` (rag-service.ts) floors
 * the effective per-leg limit at `topK` (and at `ceil(topK*1.5)` under the EE
 * ACL post-filter), so this knob can only ever ADD ranking headroom.
 *
 * **The default deliberately stays at the legacy per-leg limit (10), because
 * a wide fetch without a reranker is a measured regression, not headroom.**
 * On #1102's fixture, width 30 with plain RRF scored Recall@5 0.7153 / MRR
 * 0.4016 against the width-10 baseline's 0.8819 / 0.5831 (29 losses, 5 wins)
 * — while Recall@10 *improved* (0.9236 → 0.9444). RRF with k=60 is nearly
 * flat across ranks, so once the legs run deep, a mediocre page appearing in
 * BOTH legs (~2/(70..90) ≈ 0.024) outranks a rank-1 single-leg hit
 * (1/61 ≈ 0.016): the right answers are *in* the wider pool but drowned
 * inside the top 5. That is precisely the re-scoring job a cross-encoder
 * does — #1104 raises the effective width together with the stage that can
 * consume it. Do not raise this default on its own.
 */
export const RAG_FETCH_WIDTH_DEFAULT = 10;

/**
 * Ceiling on the admin-configured fetch width. This caps the *knob*, not the
 * stage limit: `resolveStageLimit`'s topK floors can exceed it for a caller
 * that legitimately asks for more rows (interactive search's Zod schema caps
 * `limit` at 20 today; internal callers own their topK). Values below the
 * default fall back to it — a sub-legacy width has no upside and silently
 * recreates the #1263 under-fetch (`parseInt('1e3') === 1`).
 */
export const RAG_FETCH_WIDTH_MAX = 200;

/** 60-second in-process cache, mirroring `getStreamCap` (sse-stream-limiter). */
const RAG_FETCH_WIDTH_CACHE_TTL_MS = 60_000;
let ragFetchWidthCache: { value: number; expiresAt: number } | null = null;

/**
 * Resolve the configured fetch width from the `rag_fetch_width` row in
 * `admin_settings`, clamped to [RAG_FETCH_WIDTH_DEFAULT, RAG_FETCH_WIDTH_MAX].
 * Deliberately **no env fallback** — this knob postdates the admin_settings
 * convention and ADR-021 forbids new env-driven LLM config. Cached in-process
 * for 60 s so the retrieval hot path pays no per-request round-trip; #1118's
 * PUT handler must call {@link invalidateRagFetchWidthCache} after writing
 * (other processes converge within the TTL, as with the stream cap).
 *
 * Soft-fails to the default: this read failing must degrade the *tuning*,
 * never the search — the retrieval legs surface a genuinely broken database.
 */
export async function getRagFetchWidth(): Promise<number> {
  if (ragFetchWidthCache && Date.now() < ragFetchWidthCache.expiresAt) {
    return ragFetchWidthCache.value;
  }

  let resolved = RAG_FETCH_WIDTH_DEFAULT;
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'rag_fetch_width'`,
    );
    // safeIntOr with min = DEFAULT: sub-legacy widths (including typo shapes
    // parseInt truncates, e.g. '1e3' → 1) fall back to the default — see
    // RAG_FETCH_WIDTH_MAX's JSDoc.
    resolved = Math.min(
      safeIntOr(r.rows[0]?.setting_value, RAG_FETCH_WIDTH_DEFAULT, RAG_FETCH_WIDTH_DEFAULT),
      RAG_FETCH_WIDTH_MAX,
    );
  } catch (err) {
    // Mirrors getStreamCap (sse-stream-limiter): log — an admin_settings-only
    // failure while retrieval stays healthy must not be invisible — and cache
    // the safe default for the TTL, so a persistent failure costs one failing
    // SELECT per minute, not one per search. The default is the value the
    // knob would resolve to on most deployments anyway.
    logger.warn({ err }, 'Failed to resolve rag_fetch_width — using default fetch width');
  }

  ragFetchWidthCache = { value: resolved, expiresAt: Date.now() + RAG_FETCH_WIDTH_CACHE_TTL_MS };
  return resolved;
}

/**
 * Called after writing `rag_fetch_width` (admin PUT, #1118; tests) so the new
 * value takes effect immediately in the local process.
 */
export function invalidateRagFetchWidthCache(): void {
  ragFetchWidthCache = null;
}

/**
 * Rerank candidate-pool size (#1104): how many fused candidates the
 * cross-encoder re-scores when the rerank stage is active. This is the knob
 * that finally spends the over-fetch headroom #1103 built — when rerank is
 * on, the retrieval legs widen to at least this pool so the reranker has
 * something to rescue (the measured width-30-without-rerank regression is
 * exactly what the re-scoring stage repairs). 30 default: RRF dedups by
 * page, so ~30 fused pages is the reference guide's ~20-candidate budget
 * with page-collapse headroom. Clamped to [10, 100] — every candidate is a
 * document shipped to the rerank provider and, under EE ACL, an access
 * check. Note the MIN acts as a validity floor, not a clamp: a sub-10
 * value falls back to the DEFAULT (safeIntOr semantics, same as the width
 * knob).
 */
export const RAG_RERANK_CANDIDATES_DEFAULT = 30;
export const RAG_RERANK_CANDIDATES_MIN = 10;
export const RAG_RERANK_CANDIDATES_MAX = 100;

const RAG_RERANK_CANDIDATES_TTL_MS = 60_000;
let ragRerankCandidatesCache: { value: number; expiresAt: number } | null = null;

/** `rag_rerank_candidates` row, TTL-cached like {@link getRagFetchWidth}. */
export async function getRagRerankCandidates(): Promise<number> {
  if (ragRerankCandidatesCache && Date.now() < ragRerankCandidatesCache.expiresAt) {
    return ragRerankCandidatesCache.value;
  }
  let resolved = RAG_RERANK_CANDIDATES_DEFAULT;
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'rag_rerank_candidates'`,
    );
    resolved = Math.min(
      safeIntOr(r.rows[0]?.setting_value, RAG_RERANK_CANDIDATES_DEFAULT, RAG_RERANK_CANDIDATES_MIN),
      RAG_RERANK_CANDIDATES_MAX,
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve rag_rerank_candidates — using default');
  }
  ragRerankCandidatesCache = { value: resolved, expiresAt: Date.now() + RAG_RERANK_CANDIDATES_TTL_MS };
  return resolved;
}

export function invalidateRagRerankCandidatesCache(): void {
  ragRerankCandidatesCache = null;
}

/**
 * Retrieval-confidence refuse threshold (#1105), in [0, 1). **Default 0 =
 * the gate is OFF and the confidence is diagnostic-only** — the issue's
 * "ship diagnostic first, then enable" staging is the default state, and an
 * absent row answers exactly like a fresh install. The value is compared
 * against `computeRetrievalConfidence` (rag-service): max rerank relevance
 * when the #1104 stage ran, else max cosine similarity. Both scales are
 * deployment-specific (the embedding model moves the cosine distribution;
 * rerank normalisation moves the relevance one — see
 * SearchResult.rerankScore), which is precisely why this is an operator
 * knob with no meaningful universal constant, and why the corpus-size
 * tiering idea from `tieredMinScoreForCorpus` was deliberately NOT ported:
 * one tunable per deployment beats three hardcoded numbers calibrated to a
 * different distribution.
 */
export const RAG_CONFIDENCE_THRESHOLD_DEFAULT = 0;

const RAG_CONFIDENCE_TTL_MS = 60_000;
const ragConfidenceCaches = new Map<string, { value: number; expiresAt: number }>();

/**
 * **One threshold per BASIS, never one for both (#1268 review B2):** cosine
 * similarity and rerank relevance are incommensurable scales, and the basis
 * flips PER REQUEST (a rerank bypass measures that request on the cosine
 * scale). A single knob tuned on cosines (~0.35) would refuse everything the
 * day an admin assigns a local reranker whose sigmoided logits score a
 * strong match ~0.14 — two unrelated admin actions colliding invisibly.
 * Each basis gates only when ITS OWN knob is raised; both default 0 (off).
 */
async function readConfidenceThreshold(settingKey: string): Promise<number> {
  const cached = ragConfidenceCaches.get(settingKey);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  let resolved = RAG_CONFIDENCE_THRESHOLD_DEFAULT;
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
      [settingKey],
    );
    const raw = r.rows[0]?.setting_value;
    // An empty/whitespace row means UNSET, same as an absent row — a panel's
    // "clear" writing '' must not become a once-a-minute WARN for the life
    // of the process (#1268 review).
    if (raw !== undefined && raw.trim() !== '') {
      // Strict shape, not bare parseFloat: '0,35' parseFloats to 0 — an
      // in-range value that silently disables the gate while looking
      // accepted, and '1' (an operator asking for maximal strictness) must
      // not silently mean none. Reject loudly, keep the default (#1268 M4).
      const n = /^\d*\.?\d+$/.test(raw.trim()) ? Number.parseFloat(raw.trim()) : Number.NaN;
      if (Number.isFinite(n) && n >= 0 && n < 1) {
        resolved = n;
      } else {
        logger.warn(
          { settingKey, raw },
          'Rejected confidence-threshold value (must be a plain decimal in [0, 1)) — gate stays off',
        );
      }
    }
  } catch (err) {
    logger.warn({ err, settingKey }, 'Failed to resolve confidence threshold — gate off');
  }
  ragConfidenceCaches.set(settingKey, { value: resolved, expiresAt: Date.now() + RAG_CONFIDENCE_TTL_MS });
  return resolved;
}

/** Threshold for the `similarity` (cosine) basis: `rag_confidence_threshold`. */
export async function getRagConfidenceThreshold(): Promise<number> {
  return readConfidenceThreshold('rag_confidence_threshold');
}

/** Threshold for the `rerank` basis: `rag_confidence_threshold_rerank`. */
export async function getRagConfidenceThresholdRerank(): Promise<number> {
  return readConfidenceThreshold('rag_confidence_threshold_rerank');
}

export function invalidateRagConfidenceThresholdCache(): void {
  ragConfidenceCaches.clear();
}

/**
 * Per-page char budget for #1106 PR 2's sibling-chunk context assembly.
 * `admin_settings` key `rag_context_chars_per_page`; **default 6000** — the
 * existing CHUNK_HARD_LIMIT per-CHUNK ceiling, so the default budget admits
 * roughly what one maximal chunk already could and the per-page prompt
 * ceiling is UNCHANGED at the default — clamped to **[0, 24000]** (the cap
 * quadruples the ceiling; there is no input-side context-window guard, so
 * raising it is a deliberate capacity decision).
 * **0 disables assembly entirely** (the operator kill switch for small
 * local models; the design-round graft). The parse is STRICT-SHAPE
 * (/^-?\d+$/): parseInt truncation shapes — '1e4' → 1, '8,000' → 8 — would
 * otherwise become live tiny budgets that pay the full sibling fetch to
 * assemble nothing (#1270 review F5). Malformed values fall back to the
 * default; negatives clamp to 0 (off).
 * TTL-cached like the other retrieval knobs; #1118's panel is the write
 * surface, SQL until then.
 */
export const RAG_CONTEXT_CHARS_DEFAULT = 6000;
export const RAG_CONTEXT_CHARS_MAX = 24_000;
const RAG_CONTEXT_CHARS_TTL_MS = 60_000;
let ragContextCharsCache: { value: number; expiresAt: number } | null = null;
let ragContextCharsLastGood: number | null = null;

export async function getRagContextCharsPerPage(): Promise<number> {
  if (ragContextCharsCache && Date.now() < ragContextCharsCache.expiresAt) {
    return ragContextCharsCache.value;
  }
  let resolved = RAG_CONTEXT_CHARS_DEFAULT;
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'rag_context_chars_per_page'`,
    );
    // STRICT shape, then clamp [0, MAX]. Negatives clamp to 0 (assembly
    // OFF) rather than the default — '-1' reads as a stronger kill switch
    // (#1270 m11). NOT safeIntOr (#1270 F5/F12): its parseInt accepts
    // truncation shapes ('1e4' → 1) and its floor semantics would resolve
    // '-1' to the DEFAULT, silently reversing the kill-switch decision —
    // do not "tidy" this back into it.
    const raw = (r.rows[0]?.setting_value ?? '').trim();
    if (raw !== '') {
      resolved = /^-?\d+$/.test(raw)
        ? Math.min(Math.max(Number.parseInt(raw, 10), 0), RAG_CONTEXT_CHARS_MAX)
        : RAG_CONTEXT_CHARS_DEFAULT;
    }
    ragContextCharsLastGood = resolved;
  } catch (err) {
    // FAIL TOWARD THE OPERATOR'S LAST KNOWN SETTING, not the default
    // (#1270 review F8): unlike the sibling knobs — whose defaults are
    // neutral tunings — defaulting here can turn a feature ON that the
    // operator explicitly disabled (budget 0 for a choking local model),
    // for a full TTL per transient settings-SELECT blip. The error path
    // also does NOT refresh the TTL cache, so recovery is the next call.
    logger.warn({ err }, 'Failed to resolve rag_context_chars_per_page — using last known value');
    return ragContextCharsLastGood ?? RAG_CONTEXT_CHARS_DEFAULT;
  }
  ragContextCharsCache = { value: resolved, expiresAt: Date.now() + RAG_CONTEXT_CHARS_TTL_MS };
  return resolved;
}

export function invalidateRagContextCharsCache(): void {
  ragContextCharsCache = null;
  ragContextCharsLastGood = null;
}

/**
 * #1107's operator kill switch (#1273 review M11): every neighbouring
 * retrieval stage is disableable (rerank via assignment, assembly via its
 * budget, the gate via its thresholds); the pin stage must be too.
 * `admin_settings` key `rag_pin_identifiers`, default ON; the literal '0'
 * (or 'false'/'off') disables. TTL-cached like its siblings; #1118 is the
 * write surface.
 */
const RAG_PIN_TTL_MS = 60_000;
let ragPinCache: { value: boolean; expiresAt: number } | null = null;

export async function getRagPinIdentifiersEnabled(): Promise<boolean> {
  if (ragPinCache && Date.now() < ragPinCache.expiresAt) return ragPinCache.value;
  let resolved = true;
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'rag_pin_identifiers'`,
    );
    const raw = (r.rows[0]?.setting_value ?? '').trim().toLowerCase();
    if (raw === '0' || raw === 'false' || raw === 'off') resolved = false;
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve rag_pin_identifiers — pin stage stays enabled');
  }
  ragPinCache = { value: resolved, expiresAt: Date.now() + RAG_PIN_TTL_MS };
  return resolved;
}

export function invalidateRagPinIdentifiersCache(): void {
  ragPinCache = null;
}

/**
 * #1109's MMR diversity narrow. Two knobs, both TTL-cached like their
 * siblings, both written by #1118.
 *
 * `rag_mmr_enabled` — default OFF. This stage is a CONTEXT-BUDGET
 * optimisation, not a recall one: measured on a corpus authored to crowd
 * results with near-duplicates, retrieval still ranks the right page first
 * every time, so MMR cannot convert a miss into a hit. What it removes is
 * redundant context. Shipping it off by default means the measured benefit
 * has to be wanted before it is taken.
 *
 * `rag_mmr_lambda` — default 0.7. An earlier default of 0.5 came from a
 * SIMULATION over recorded result pools, and that simulation was wrong: it
 * narrowed a 10-wide pool while the code narrowed the whole 30-wide reranked
 * pool, so it measured a design the pipeline did not implement. Measured
 * LIVE on the duplicative corpus, rerank axis, 158 queries:
 *
 *   config     Recall@5              MRR      redundant slots
 *   off        0.9177                0.8123   37/1580 (2.34%)
 *   0.7        0.9177  (0w/0l)       0.8087   23/1580 (1.46%)
 *   0.5        0.9177  (0w/1l)       0.8002    4/1580 (0.25%)
 *
 * Read that table before changing the default. The stage is NOT free: MRR
 * degrades monotonically with diversity even where Recall@5 holds, because
 * the narrow reorders within the returned set. 0.7 is the strongest setting
 * that costs no recall at all, and it still removes a third of the redundant
 * slots. 0.5 nearly eliminates redundancy but loses a query and more MRR.
 *
 * The benefit CONCENTRATES where duplication exists: corpus-wide redundancy
 * is 2.34%, but on the fixture's `diversity` queries — the copied-runbook
 * topics — 53% of returned slots were near-duplicates. A real Confluence
 * space full of per-team copies should see more of this than a corpus that
 * is mostly public documentation, which is the argument for shipping the
 * knob at all rather than the stage on by default.
 */
const RAG_MMR_TTL_MS = 60_000;
export const RAG_MMR_LAMBDA_DEFAULT = 0.7;
let ragMmrCache: { enabled: boolean; lambda: number; expiresAt: number } | null = null;

export async function getRagMmrConfig(): Promise<{ enabled: boolean; lambda: number }> {
  if (ragMmrCache && Date.now() < ragMmrCache.expiresAt) {
    return { enabled: ragMmrCache.enabled, lambda: ragMmrCache.lambda };
  }
  let enabled = false;
  let lambda = RAG_MMR_LAMBDA_DEFAULT;
  try {
    const r = await query<{ setting_key: string; setting_value: string }>(
      `SELECT setting_key, setting_value FROM admin_settings
       WHERE setting_key IN ('rag_mmr_enabled', 'rag_mmr_lambda')`,
    );
    for (const row of r.rows) {
      if (row.setting_key === 'rag_mmr_enabled') {
        const raw = (row.setting_value ?? '').trim().toLowerCase();
        enabled = raw === '1' || raw === 'true' || raw === 'on';
      } else {
        // Strict shape, like rag_context_chars_per_page: a malformed value
        // must not silently become NaN and disable relevance entirely.
        const raw = (row.setting_value ?? '').trim();
        if (/^-?\d+(\.\d+)?$/.test(raw)) {
          const n = Number(raw);
          if (n >= 0 && n <= 1) lambda = n;
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve MMR settings — diversity narrow stays off');
  }
  ragMmrCache = { enabled, lambda, expiresAt: Date.now() + RAG_MMR_TTL_MS };
  return { enabled, lambda };
}

export function invalidateRagMmrCache(): void {
  ragMmrCache = null;
}

/**
 * #1111's quality/recency prior weight, `rag_ranking_prior_weight`.
 *
 * **Default 0 — the stage ships DISABLED.** It is here as a mechanism an
 * operator can turn on, not as a behaviour we assert is an improvement. Two
 * measurements on the local rig (275 pages, 164 queries) decided that:
 *
 * - **With a rerank provider assigned the effect is provably ZERO** — not
 *   small, byte-identical. The rerank pool (`rag_rerank_candidates`, default
 *   30) is wider than the fused candidate set (the fetch width, default 10),
 *   so the cross-encoder rescores every candidate and discards the prior's
 *   ordering wholesale. That is arithmetic, not a tuning miss, and it follows
 *   from the pre-rerank placement ruling.
 * - **Without rerank it moved exactly two queries: one intended gain and one
 *   regression.** In the regression a scored page passed the correct,
 *   unscored one purely for *carrying signals at all*. That is partial-
 *   coverage bias: "neutral on NULL" stops an unscored page being penalised
 *   absolutely, but a scored near-tie neighbour still gains, which demotes
 *   the unscored page relatively. It is inherent to an additive prior over a
 *   partly-scored corpus.
 *
 * **0.003 is the tuned-but-unshipped value** an operator can set, and it is
 * the number the rest of this comment sizes. It is measured against RRF's
 * own scale rather than picked: a both-legs hit scores ~0.0328 and a
 * single-leg hit ~0.0164, so the maximum prior is under a fifth of that gap
 * and cannot carry a page across leg agreement. WITHIN a tier it is far from
 * a nudge — adjacent RRF ranks differ by only ~0.00026 at k=60, so 0.003
 * spans roughly **fourteen** adjacent positions inside one leg-agreement
 * tier, not "a rank or two". See `ranking-prior.ts` for why that asymmetry
 * is the intent rather than a flaw.
 *
 * The clamp stays [0, 0.05]: at 0.05 the prior exceeds the leg-agreement gap
 * and would start outranking retrieval itself.
 */
const RAG_PRIOR_TTL_MS = 60_000;
export const RAG_RANKING_PRIOR_WEIGHT_DEFAULT = 0;
let ragPriorCache: { value: number; expiresAt: number } | null = null;

export async function getRagRankingPriorWeight(): Promise<number> {
  if (ragPriorCache && Date.now() < ragPriorCache.expiresAt) return ragPriorCache.value;
  let resolved = RAG_RANKING_PRIOR_WEIGHT_DEFAULT;
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'rag_ranking_prior_weight'`,
    );
    const raw = (r.rows[0]?.setting_value ?? '').trim();
    if (raw !== '' && /^\d+(\.\d+)?$/.test(raw)) {
      const n = Number(raw);
      if (n >= 0 && n <= 0.05) resolved = n;
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve rag_ranking_prior_weight — using the default');
  }
  ragPriorCache = { value: resolved, expiresAt: Date.now() + RAG_PRIOR_TTL_MS };
  return resolved;
}

export function invalidateRagRankingPriorCache(): void {
  ragPriorCache = null;
}

/**
 * #1115 P2 — the two knobs that bound what the image-embedding worker takes
 * off a page. Both read in ONE query and share one TTL cache, because the
 * worker reads them per page and they are always wanted together.
 *
 * `rag_images_per_page_max` — default **20**, clamped to [1, 200]. It is a
 * COST bound, not a quality one: every image past it is one VL request, one
 * base64-inflated body through the shared LLM queue and one row. A page with
 * ninety screenshots is real, and letting it spend ninety requests while the
 * rest of the corpus waits is how a re-scan stops finishing. Images past the
 * cap are skipped and COUNTED (`skipped.capped`), never silently dropped —
 * the Embeddings-tab card is where an operator finds out the cap is biting.
 *
 * `rag_image_index_external` — default **on**. `syncImageAttachments` caches
 * images a Confluence body pulled from an external URL under
 * `external-<12 hex>` names (`core/services/image-references.ts`), and those
 * are page content like any other. The knob exists for deployments that would
 * rather not embed third-party imagery at all; turning it off is a policy
 * decision, so the default is the one that indexes what the page shows.
 *
 * Soft-fail is "index normally": a failed `admin_settings` read must degrade
 * the tuning, never quietly narrow the index — an operator reading "12 rows"
 * cannot tell a DB hiccup from a corpus with twelve images.
 */
export const RAG_IMAGES_PER_PAGE_MAX_DEFAULT = 20;
export const RAG_IMAGES_PER_PAGE_MAX_MIN = 1;
export const RAG_IMAGES_PER_PAGE_MAX_MAX = 200;

const RAG_IMAGE_INTAKE_TTL_MS = 60_000;
let ragImageIntakeCache:
  | { imagesPerPageMax: number; indexExternal: boolean; expiresAt: number }
  | null = null;

async function getRagImageIntake(): Promise<{ imagesPerPageMax: number; indexExternal: boolean }> {
  if (ragImageIntakeCache && Date.now() < ragImageIntakeCache.expiresAt) {
    return {
      imagesPerPageMax: ragImageIntakeCache.imagesPerPageMax,
      indexExternal: ragImageIntakeCache.indexExternal,
    };
  }
  let imagesPerPageMax = RAG_IMAGES_PER_PAGE_MAX_DEFAULT;
  let indexExternal = true;
  try {
    const r = await query<{ setting_key: string; setting_value: string }>(
      `SELECT setting_key, setting_value FROM admin_settings
        WHERE setting_key IN ('rag_images_per_page_max', 'rag_image_index_external')`,
    );
    for (const row of r.rows) {
      if (row.setting_key === 'rag_images_per_page_max') {
        // A STRICT shape, not `safeIntOr` — and the difference is load-bearing
        // *here* in a way it is not on `rag_fetch_width`. That knob's floor is
        // its default, so `parseInt`'s truncations (`'1e3'` → 1) land below it
        // and fall back. This one's floor is genuinely 1, so the same typo
        // would parse as a legal cap of ONE image per page and quietly index a
        // fraction of the corpus. Refusing the shape outright is the only way
        // to tell "the operator asked for one" from "the operator fat-fingered
        // a thousand".
        const raw = (row.setting_value ?? '').trim();
        if (/^\d+$/.test(raw)) {
          const n = Number(raw);
          if (n >= RAG_IMAGES_PER_PAGE_MAX_MIN) {
            imagesPerPageMax = Math.min(n, RAG_IMAGES_PER_PAGE_MAX_MAX);
          }
        }
      } else {
        // An OFF-list, like `rag_pin_identifiers`: anything else leaves the
        // default (on) standing, so a half-written row cannot narrow the index.
        const raw = (row.setting_value ?? '').trim().toLowerCase();
        if (raw === '0' || raw === 'false' || raw === 'off') indexExternal = false;
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve the image-index intake knobs — using defaults');
  }
  ragImageIntakeCache = {
    imagesPerPageMax,
    indexExternal,
    expiresAt: Date.now() + RAG_IMAGE_INTAKE_TTL_MS,
  };
  return { imagesPerPageMax, indexExternal };
}

/** Cap on images embedded per page (`rag_images_per_page_max`). */
export async function getRagImagesPerPageMax(): Promise<number> {
  return (await getRagImageIntake()).imagesPerPageMax;
}

/** Whether externally-fetched page images are indexed (`rag_image_index_external`). */
export async function getRagImageIndexExternal(): Promise<boolean> {
  return (await getRagImageIntake()).indexExternal;
}

export function invalidateRagImageIntakeCache(): void {
  ragImageIntakeCache = null;
}

/**
 * #1115 P3 — `rag_image_leg_enabled`, the RETRIEVAL half of the image index.
 * Default **on**, cached like `rag_pin_identifiers` and read on the hot path
 * (once per hybrid search).
 *
 * It is deliberately a SEPARATE switch from the `image_embedding` assignment,
 * and the two are not redundant. Unassigning the use case turns off both
 * halves: nothing indexes and nothing retrieves, and the index stops being
 * filled while pages keep accumulating the dirty flag. This knob turns off
 * only the query-time half — the one extra embedding call every question pays
 * — and leaves the index being built. An operator who finds the leg too slow,
 * or who wants a clean A/B, needs exactly that and nothing else.
 *
 * It also cannot turn the leg ON: with the use case unassigned or
 * `page_image_embeddings` empty the leg does not run whatever this says. A
 * setting that can only subtract is safe to read from a cache.
 *
 * Soft-fail is "leg stays enabled", the same direction as its siblings: a DB
 * hiccup must not silently narrow retrieval, because a result set that lost
 * its image leg is indistinguishable from a corpus with no matching pictures.
 */
const RAG_IMAGE_LEG_TTL_MS = 60_000;
let ragImageLegCache: { value: boolean; expiresAt: number } | null = null;

export async function getRagImageLegEnabled(): Promise<boolean> {
  if (ragImageLegCache && Date.now() < ragImageLegCache.expiresAt) return ragImageLegCache.value;
  let resolved = true;
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'rag_image_leg_enabled'`,
    );
    // An OFF-list, like `rag_pin_identifiers`: anything unrecognised leaves the
    // default standing, so a half-written row cannot disable a retrieval leg.
    const raw = (r.rows[0]?.setting_value ?? '').trim().toLowerCase();
    if (raw === '0' || raw === 'false' || raw === 'off') resolved = false;
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve rag_image_leg_enabled — the image leg stays enabled');
  }
  ragImageLegCache = { value: resolved, expiresAt: Date.now() + RAG_IMAGE_LEG_TTL_MS };
  return resolved;
}

export function invalidateRagImageLegCache(): void {
  ragImageLegCache = null;
}

/**
 * #1115 P4 — `rag_answer_max_images`, how many of the images the leg matched
 * on the pages grounding an answer are ATTACHED to the question as image
 * parts. Default **2**, clamped to [0, 8], cached like its siblings and read
 * once per `/llm/ask` that gets as far as a completion.
 *
 * **Zero is a value, and this reader is the one place that shows.** Its
 * sibling `rag_images_per_page_max` refuses 0 outright, because a zero INTAKE
 * cap reconciles every row away on the next scan. A zero ANSWER cap subtracts
 * nothing durable: the index still fills, the leg still ranks, and the
 * pictures still reach the reader as `kind: 'image'` sources. So `'0'` must
 * resolve to 0 rather than falling back — otherwise the panel's own off switch
 * would be unreachable and every vision-capable deployment would keep paying
 * the bytes.
 *
 * The SHAPE is strict for the intake cap's reason, read the other way round:
 * `parseInt('1e3')` is 1, and a permissive parse would read a fat-fingered row
 * as "show the model one picture" rather than as the typo it is. Anything that
 * is not a run of digits leaves the default standing.
 *
 * Soft-fail is the DEFAULT, not 0 — the direction its siblings all take. A DB
 * hiccup must not silently change what the model is shown, and 2 is what the
 * deployment asked for by not asking.
 */
export const RAG_ANSWER_MAX_IMAGES_DEFAULT = 2;
export const RAG_ANSWER_MAX_IMAGES_MAX = 8;

const RAG_ANSWER_MAX_IMAGES_TTL_MS = 60_000;
let ragAnswerMaxImagesCache: { value: number; expiresAt: number } | null = null;

export async function getRagAnswerMaxImages(): Promise<number> {
  if (ragAnswerMaxImagesCache && Date.now() < ragAnswerMaxImagesCache.expiresAt) {
    return ragAnswerMaxImagesCache.value;
  }
  let resolved = RAG_ANSWER_MAX_IMAGES_DEFAULT;
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'rag_answer_max_images'`,
    );
    const raw = (r.rows[0]?.setting_value ?? '').trim();
    if (/^\d+$/.test(raw)) {
      resolved = Math.min(Number(raw), RAG_ANSWER_MAX_IMAGES_MAX);
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve rag_answer_max_images — using the default');
  }
  ragAnswerMaxImagesCache = { value: resolved, expiresAt: Date.now() + RAG_ANSWER_MAX_IMAGES_TTL_MS };
  return resolved;
}

export function invalidateRagAnswerMaxImagesCache(): void {
  ragAnswerMaxImagesCache = null;
}

/**
 * #1285 — `rag_ef_search`, the HNSW `ef_search` FLOOR every pgvector kNN probe
 * in the app runs at. Default **100**, range **[1, 1000]** (pgvector's own
 * bound). This is the knob, not the per-query value: `efSearchFor`
 * (`domains/llm/services/hnsw-ef-search.ts`) raises it to `2 x` a probe's raw
 * row count when that is larger, clamped at 1000.
 *
 * It moved here from `process.env.RAG_EF_SEARCH` because a deployment's recall
 * floor belongs beside the retrieval knobs it is read with, not in a shell the
 * panel cannot see: read at module load it could not change without a restart.
 * It is **not** bounded-fetch coupling — `efSearchFor`'s `2 x` headroom covers
 * every probe's own LIMIT at every reachable width, so a wider fetch outgrows
 * this floor rather than being capped by it (review r1).
 * ADR-021 forbids new env-driven retrieval config, so the variable survives
 * only as a **bootstrap fallback** (below) and is reported at startup by
 * {@link warnIfRagEfSearchEnvSet}.
 *
 * Raising it is very unlikely to buy recall. Measured on #1114's
 * `halfvec(2560)` corpus the index is effectively exact from 40: recall@10 is
 * 0.9995 at this default and unchanged all the way to the 1000 ceiling. The
 * cost that DOES move with the setting is SCAN TIME — 0.39 ms per probe at
 * 100 against 1.74 ms at 1000 on that corpus. Not footprint: `ef_search` is a
 * query-time GUC, and the 18.6 MiB of HNSW that paragraph in CLAUDE.md tells
 * you to watch is a build property of `m` / `ef_construction`, identical at
 * every value of this setting. See `docs/runbooks/shadow-reembed.md`.
 */
export const RAG_EF_SEARCH_DEFAULT = 100;
/** pgvector's own lower bound on `hnsw.ef_search`. */
export const RAG_EF_SEARCH_MIN = 1;
/** pgvector's own upper bound on `hnsw.ef_search`. */
export const RAG_EF_SEARCH_MAX = 1000;

const RAG_EF_SEARCH_TTL_MS = 60_000;

/**
 * Where the resolved floor came from. The panel needs this and not only the
 * number: on an instance still running on `RAG_EF_SEARCH` the value the panel
 * shows already equals what the server resolved, so Save — a pure value diff —
 * has nothing to send and the row can never be written from the control that
 * tells the operator to write it (review r1).
 */
export type RagEfSearchSource = 'row' | 'env' | 'default';

let ragEfSearchCache: { value: number; source: RagEfSearchSource; expiresAt: number } | null = null;
let ragEfSearchEnvBootstrapLogged = false;

/** `RAG_EF_SEARCH` parsed and range-checked, or `null` if it is unusable. */
function parseRagEfSearchEnv(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (n < RAG_EF_SEARCH_MIN || n > RAG_EF_SEARCH_MAX) return null;
  return n;
}

/**
 * The deprecated `RAG_EF_SEARCH` env var, validated the same way a row is, or
 * `null` when it is unset or unusable.
 *
 * **Bootstrap only.** It is consulted exactly when no `rag_ef_search` row
 * exists — which, unlike `fts_language`, is the state of every instance that
 * has never saved the Retrieval panel, because nothing seeds this row. So the
 * value stays live until an admin saves once, and that is what the startup
 * notice says.
 */
function ragEfSearchEnvBootstrap(): number | null {
  const n = parseRagEfSearchEnv((process.env.RAG_EF_SEARCH ?? '').trim());
  if (n === null) return null;
  if (!ragEfSearchEnvBootstrapLogged) {
    ragEfSearchEnvBootstrapLogged = true;
    logger.info(
      { envVar: 'RAG_EF_SEARCH', setting: 'rag_ef_search', value: n },
      'No rag_ef_search row — falling back to the deprecated RAG_EF_SEARCH environment variable. Save Settings → AI Models → Retrieval once to make the setting authoritative.',
    );
  }
  return n;
}

/**
 * Resolve the `ef_search` floor, TTL-cached like its Retrieval-panel siblings.
 *
 * Fallback order is **row → `RAG_EF_SEARCH` → 100**, and the shape check is
 * strict for `rag_answer_max_images`' reason read the other way round:
 * `parseInt('1e3')` is 1, and 1 is a *legal* `ef_search`, so a permissive parse
 * would read a fat-fingered row as "walk one candidate" and gut recall rather
 * than reading as the typo it is. `'0'` falls back too — pgvector's floor is 1,
 * so a zero row means unset, not off.
 *
 * Soft-fails to the fallback: like `getRagFetchWidth`, this read failing must
 * degrade the tuning and never the search.
 *
 * **A read that THREW is not evidence that no row exists** (review r1). The
 * first cut left `fromRow` false in the catch, so a transient failure — pool
 * pressure, a statement timeout — put a stale `RAG_EF_SEARCH` back in force
 * for a full TTL on an instance that had saved the panel, which is the exact
 * opposite of what the startup notice, `.env.example`, ADMIN-GUIDE and the
 * panel's own line all promise. The bootstrap is consulted only when the read
 * SUCCEEDED and returned nothing; a failure falls to the constant default.
 */
export async function resolveRagEfSearch(): Promise<{ value: number; source: RagEfSearchSource }> {
  if (ragEfSearchCache && Date.now() < ragEfSearchCache.expiresAt) {
    return { value: ragEfSearchCache.value, source: ragEfSearchCache.source };
  }
  let resolved = RAG_EF_SEARCH_DEFAULT;
  let source: RagEfSearchSource = 'default';
  let readFailed = false;
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'rag_ef_search'`,
    );
    const raw = (r.rows[0]?.setting_value ?? '').trim();
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (n >= RAG_EF_SEARCH_MIN) {
        resolved = Math.min(n, RAG_EF_SEARCH_MAX);
        source = 'row';
      }
    }
  } catch (err) {
    readFailed = true;
    logger.warn({ err }, 'Failed to resolve rag_ef_search — using the configured fallback');
  }
  if (source !== 'row' && !readFailed) {
    const fromEnv = ragEfSearchEnvBootstrap();
    if (fromEnv !== null) {
      resolved = fromEnv;
      source = 'env';
    }
  }

  ragEfSearchCache = { value: resolved, source, expiresAt: Date.now() + RAG_EF_SEARCH_TTL_MS };
  return { value: resolved, source };
}

/** The floor itself — what every kNN probe calls. */
export async function getRagEfSearch(): Promise<number> {
  return (await resolveRagEfSearch()).value;
}

export function invalidateRagEfSearchCache(): void {
  ragEfSearchCache = null;
}

/**
 * Startup notice for the deprecated `RAG_EF_SEARCH` environment variable
 * (#1285).
 *
 * **LEGACY-LLM-VARS semantics, not `FTS_LANGUAGE`'s.** That one is *ignored*
 * everywhere, because migration 049 seeds the row it lost to. Nothing seeds
 * `rag_ef_search`, so this variable is still doing exactly what it always did
 * on every instance that has not saved the Retrieval panel — and the message
 * has to say so, or an operator reads "deprecated" as "already inert" and
 * removes a value that was live.
 *
 * It **re-validates the value** (review r1) rather than gating on truthiness
 * alone. `RAG_EF_SEARCH=2000` was legal under the module-load reader this
 * knob replaced (it validated 1..10000), and is not under pgvector's own
 * [1, 1000] bound: such an instance drops from a 1000 floor to 100 on
 * upgrade. Saying "it is used" there would name the one case where it is not.
 *
 * **Both branches hedge on the row** (review r2). This function reads
 * `process.env` and nothing else — it cannot know whether a `rag_ef_search`
 * row exists, and a present row wins over the variable either way. The
 * out-of-range branch used to state the fallback flatly ("the floor falls
 * back to 100"), which is a claim about the *resolved* floor and is simply
 * false on any instance that has saved the panel; it now scopes the sentence
 * the same way the in-range branch does.
 */
export function warnIfRagEfSearchEnvSet(): void {
  const present = process.env.RAG_EF_SEARCH;
  if (!present) return;
  const parsed = parseRagEfSearchEnv(present.trim());
  if (parsed === null) {
    logger.warn(
      { envVar: 'RAG_EF_SEARCH', setting: 'rag_ef_search', value: present },
      `RAG_EF_SEARCH=${present} is not a whole number inside pgvector's [${RAG_EF_SEARCH_MIN}, ${RAG_EF_SEARCH_MAX}] and is ignored — while no \`rag_ef_search\` row exists the floor falls back to ${RAG_EF_SEARCH_DEFAULT}; set it on Settings → AI Models → Retrieval`,
    );
    return;
  }
  logger.warn(
    { envVar: 'RAG_EF_SEARCH', setting: 'rag_ef_search', value: parsed },
    'RAG_EF_SEARCH is deprecated — it is used only while no `rag_ef_search` row exists; set it on Settings → AI Models → Retrieval',
  );
}

/**
 * Issue #257 — returns the configured re-embed-all job history retention
 * (how many completed/failed BullMQ job records are kept in Redis before
 * the oldest get swept). Default 150, clamped to [10, 10000].
 *
 * Read per-enqueue inside `enqueueReembedAll` so runtime changes take
 * effect on the next run. Also consumed by the admin GET/PUT
 * `/api/admin/settings` surface.
 */
export async function getReembedHistoryRetention(): Promise<number> {
  const r = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key='reembed_history_retention'`,
  );
  const raw = r.rows[0]?.setting_value;
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return 150;
  return Math.max(10, Math.min(10_000, n));
}

/**
 * Issue #264 — returns the configured retention window (days) for
 * `audit_log` rows with action='ADMIN_ACCESS_DENIED'. Consumed by the
 * targeted purge in `data-retention-service.ts ::
 * runAdminAccessDeniedRetention`. Also consumed by the admin GET/PUT
 * `/api/admin/settings` surface.
 *
 * Read cascade:
 *   admin_settings.admin_access_denied_retention_days  (authoritative)
 *     -> env RETENTION_ADMIN_ACCESS_DENIED_DAYS        (optional fallback)
 *     -> 90                                            (hard default)
 *
 * Clamped to [7, 3650]. No caching — the retention scheduler runs once
 * per 24 h, so a per-tick DB read is negligible and keeps the code
 * simple (no cache invalidation on PUT).
 */
export async function getAdminAccessDeniedRetentionDays(): Promise<number> {
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key='admin_access_denied_retention_days'`,
    );
    const raw = r.rows[0]?.setting_value;
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 7 && n <= 3650) return n;
    }
  } catch {
    // Fall through to env / default — this getter must never throw.
  }
  const env = process.env.RETENTION_ADMIN_ACCESS_DENIED_DAYS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 7 && n <= 3650) return n;
  }
  return 90;
}

/**
 * Compendiq/compendiq-ee#118 — returns the configured retention window
 * (days) for `pending_sync_versions` rows. Stale conflict-pending versions
 * older than this are pruned by `data-retention-service.ts`.
 *
 * Read cascade:
 *   admin_settings.pending_sync_versions_retention_days  (authoritative)
 *     -> env RETENTION_PENDING_SYNC_VERSIONS_DAYS        (optional fallback)
 *     -> 90                                              (hard default)
 *
 * Clamped to [7, 3650]. No caching — the retention scheduler runs once per
 * 24 h, so the per-tick DB read is negligible (matches the pattern used by
 * `getAdminAccessDeniedRetentionDays`). Resolution deletes the pending row
 * synchronously, so the retention sweep only catches genuinely-abandoned
 * conflict queues.
 */
export async function getPendingSyncVersionsRetentionDays(): Promise<number> {
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key='pending_sync_versions_retention_days'`,
    );
    const raw = r.rows[0]?.setting_value;
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 7 && n <= 3650) return n;
    }
  } catch {
    // Fall through to env / default — this getter must never throw.
  }
  const env = process.env.RETENTION_PENDING_SYNC_VERSIONS_DAYS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 7 && n <= 3650) return n;
  }
  return 90;
}

// ─── LLM queue settings — cluster-wide cached getters (Compendiq/compendiq-ee#113 Phase B-3) ──
//
// These wrap `admin_settings.llm_concurrency` and `admin_settings.llm_max_queue_depth`
// behind the cache-bus channel `admin:llm:settings`. A PUT on one pod publishes
// on the channel; every other pod's subscriber re-reads from the DB and the
// llm-queue updates its `pLimit` limiter's `concurrency` in place (see #404).
// See `domains/llm/services/llm-queue.ts` for the mutation logic.
//
// Defaults match the existing env-var fallbacks in `llm-queue.ts` (which the
// cached-setting bypasses on cold-load when the admin_settings row is absent —
// the parse function below honours `LLM_CONCURRENCY` / `LLM_MAX_QUEUE_DEPTH`
// as a bootstrap fallback so existing single-pod deployments keep working
// without any DB row).
//
// Range bounds mirror `setConcurrency` / `setMaxQueueDepth` in llm-queue.ts:
//   - concurrency:    [1, 100]
//   - maxQueueDepth:  [1, ∞)  (effectively bounded by the route schema)
//
// Both bounds are enforced in `parseLlm…` so a corrupted/typo'd DB value does
// not turn into a process-killing pLimit(0).

const HARDCODED_LLM_CONCURRENCY = 4;
const HARDCODED_LLM_MAX_QUEUE_DEPTH = 50;

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseLlmConcurrency(raw: string | null): number {
  if (raw !== null && raw !== '') {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 100) return n;
  }
  // Bootstrap fallback: env override → hardcoded default. Mirrors the
  // env-var precedence in llm-queue.ts so first-boot pods (no admin_settings
  // row yet) still honour LLM_CONCURRENCY.
  return envPositiveInt('LLM_CONCURRENCY') ?? HARDCODED_LLM_CONCURRENCY;
}

function parseLlmMaxQueueDepth(raw: string | null): number {
  if (raw !== null && raw !== '') {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return envPositiveInt('LLM_MAX_QUEUE_DEPTH') ?? HARDCODED_LLM_MAX_QUEUE_DEPTH;
}

let _getLlmConcurrency: (() => number) | null = null;
let _getLlmMaxQueueDepth: (() => number) | null = null;

/**
 * Initialise the cluster-wide cached LLM queue settings. Must be called
 * AFTER `initCacheBus(...)` so the subscriber is wired up. Idempotent: a
 * second call replaces the existing getters (used by tests).
 *
 * Soft-fail: if cold-load fails the getter falls back to the env / hardcoded
 * default — we never throw out of init.
 */
export async function initLlmQueueSettings(): Promise<void> {
  _getLlmConcurrency = await makeCachedSetting<number>({
    key: 'llm_concurrency',
    cacheBusChannel: 'admin:llm:settings',
    parse: parseLlmConcurrency,
    defaultValue: parseLlmConcurrency(null),
  });
  _getLlmMaxQueueDepth = await makeCachedSetting<number>({
    key: 'llm_max_queue_depth',
    cacheBusChannel: 'admin:llm:settings',
    parse: parseLlmMaxQueueDepth,
    defaultValue: parseLlmMaxQueueDepth(null),
  });
}

/**
 * Synchronous getter for the cluster-wide LLM concurrency. Returns the
 * env / hardcoded default when the service has not been initialised
 * (startup-order safety: a callsite that fires before `initLlmQueueSettings`
 * sees a sane value rather than NaN or 0).
 */
export function getLlmConcurrency(): number {
  if (!_getLlmConcurrency) return parseLlmConcurrency(null);
  return _getLlmConcurrency();
}

/** Synchronous getter for the cluster-wide LLM max queue depth (see above). */
export function getLlmMaxQueueDepth(): number {
  if (!_getLlmMaxQueueDepth) return parseLlmMaxQueueDepth(null);
  return _getLlmMaxQueueDepth();
}

// Test seam — mirrors `_resetForTests()` in `sync-conflict-policy-service.ts`.
// Lets test suites re-init `makeCachedSetting` against fresh mocks without
// leaking the previous run's getter closure.
export function _resetLlmQueueSettingsForTests(): void {
  _getLlmConcurrency = null;
  _getLlmMaxQueueDepth = null;
}
