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
