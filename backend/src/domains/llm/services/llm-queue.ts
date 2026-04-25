/**
 * LLM request queue with configurable concurrency and backpressure.
 *
 * Configuration precedence (first non-empty value wins):
 *   1. `admin_settings` row (`llm_concurrency`, `llm_max_queue_depth`,
 *      `llm_timeout_ms`) — loaded at boot by `initLlmQueue()` and by
 *      the admin UI on save.
 *   2. Environment variables:
 *      - `LLM_CONCURRENCY`       (default: 4)       — max concurrent LLM requests
 *      - `LLM_MAX_QUEUE_DEPTH`   (default: 50)      — reject when pending exceeds this
 *      - `LLM_STREAM_TIMEOUT_MS` (default: 300000)  — per-request timeout in ms
 *   3. Hardcoded defaults (listed above).
 *
 * Cluster coordination (Compendiq/compendiq-ee#113 Phase B-3):
 *   - `setLlmConcurrencyClusterWide` / `setLlmMaxQueueDepthClusterWide`
 *     persist the new value to `admin_settings` and publish on the cache-bus
 *     channel `admin:llm:settings`.
 *   - `initLlmQueueClusterCoordination` (called after `initCacheBus` + the
 *     cached-setting init in `admin-settings-service.ts`) subscribes to the
 *     same channel; on every invalidation, every pod re-reads the cached
 *     getter and atomically swaps `_limiter` with `pLimit(<new value>)`.
 *
 *   TODO(v0.5): swapping `_limiter` while jobs are in-flight on the previous
 *   limiter orphans those jobs on the old limiter (their `pendingCount` /
 *   `activeCount` no longer feed back into the queue's metrics or backpressure
 *   logic). This is a pre-existing race in `setConcurrency()` (the original
 *   per-pod setter has the same bug); this PR keeps the behaviour. Tracking
 *   issue: open in v0.5 to drain the old limiter before swap, e.g. by holding
 *   a queue of historical limiters and routing new work to the head.
 */

import pLimit, { type LimitFunction } from 'p-limit';
import { logger } from '../../../core/utils/logger.js';
import { publish, subscribe } from '../../../core/services/redis-cache-bus.js';
import {
  getLlmConcurrency,
  getLlmMaxQueueDepth,
} from '../../../core/services/admin-settings-service.js';
// `getLlmConcurrency` / `getLlmMaxQueueDepth` are used by
// `initLlmQueueClusterCoordination` to prime `_limiter` from the cluster-wide
// cached getter on startup. The runtime invalidation path re-reads DB directly
// (see the subscriber comment in that init function) for deterministic
// ordering vs. the cached-setting's async re-read.

export interface LlmQueueMetrics {
  concurrency: number;
  activeCount: number;
  pendingCount: number;
  maxQueueDepth: number;
  totalProcessed: number;
  totalRejected: number;
  totalTimedOut: number;
}

const HARDCODED_CONCURRENCY = 4;
const HARDCODED_MAX_QUEUE_DEPTH = 50;
const HARDCODED_TIMEOUT_MS = 300_000;

/**
 * Parse a positive integer from an env var, returning `undefined` when the var
 * is absent, empty, non-numeric, or ≤ 0.
 */
function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const DEFAULT_CONCURRENCY = envInt('LLM_CONCURRENCY') ?? HARDCODED_CONCURRENCY;
const DEFAULT_MAX_QUEUE_DEPTH = envInt('LLM_MAX_QUEUE_DEPTH') ?? HARDCODED_MAX_QUEUE_DEPTH;
const DEFAULT_TIMEOUT_MS = envInt('LLM_STREAM_TIMEOUT_MS') ?? HARDCODED_TIMEOUT_MS;

let _limiter: LimitFunction = pLimit(DEFAULT_CONCURRENCY);
let _concurrency = DEFAULT_CONCURRENCY;
let _maxQueueDepth = DEFAULT_MAX_QUEUE_DEPTH;
let _timeoutMs = DEFAULT_TIMEOUT_MS;
let _totalProcessed = 0;
let _totalRejected = 0;
let _totalTimedOut = 0;

export function setConcurrency(n: number): void {
  const val = Math.max(1, Math.min(n, 100));
  if (val !== _concurrency) {
    _concurrency = val;
    _limiter = pLimit(val);
    logger.info({ concurrency: val }, 'LLM queue concurrency updated');
  }
}

export function setMaxQueueDepth(n: number): void {
  _maxQueueDepth = Math.max(1, n);
}

export function setTimeoutMs(ms: number): void {
  _timeoutMs = Math.max(1000, ms);
}

export function getMetrics(): LlmQueueMetrics {
  return {
    concurrency: _concurrency,
    activeCount: _limiter.activeCount,
    pendingCount: _limiter.pendingCount,
    maxQueueDepth: _maxQueueDepth,
    totalProcessed: _totalProcessed,
    totalRejected: _totalRejected,
    totalTimedOut: _totalTimedOut,
  };
}

export class QueueFullError extends Error {
  constructor(depth: number, max: number) {
    super(`LLM queue full: ${depth} pending (max: ${max})`);
    this.name = 'QueueFullError';
  }
}

export class LlmTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms`);
    this.name = 'LlmTimeoutError';
  }
}

export async function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  if (_limiter.pendingCount >= _maxQueueDepth) {
    _totalRejected++;
    throw new QueueFullError(_limiter.pendingCount, _maxQueueDepth);
  }

  return _limiter(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        _totalTimedOut++;
        reject(new LlmTimeoutError(_timeoutMs));
      }, _timeoutMs);
    });

    try {
      const result = await Promise.race([fn(), timeoutPromise]);
      _totalProcessed++;
      return result;
    } catch (err) {
      if (!(err instanceof LlmTimeoutError)) {
        _totalProcessed++;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}

export async function initLlmQueue(): Promise<void> {
  try {
    const { query } = await import('../../../core/db/postgres.js');
    const result = await query<{ setting_key: string; setting_value: string }>(
      `SELECT setting_key, setting_value FROM admin_settings
       WHERE setting_key IN ('llm_concurrency', 'llm_max_queue_depth', 'llm_timeout_ms')`,
      [],
    );
    for (const row of result.rows) {
      const val = parseInt(row.setting_value, 10);
      if (isNaN(val)) continue;
      switch (row.setting_key) {
        case 'llm_concurrency': setConcurrency(val); break;
        case 'llm_max_queue_depth': setMaxQueueDepth(val); break;
        case 'llm_timeout_ms': setTimeoutMs(val); break;
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load LLM queue settings, using defaults');
  }
}

// ─── Cluster coordination (Compendiq/compendiq-ee#113 Phase B-3) ──────────
//
// `_clusterCoordinationActive` guards against double-initialisation across
// hot reloads / test re-imports. The unsubscribe handle is kept so the
// subscriber can be torn down in tests via `_resetClusterCoordinationForTests`.
let _clusterCoordinationActive = false;
let _unsubscribeClusterCoordination: (() => void) | null = null;

/**
 * Subscribe to the `admin:llm:settings` cache-bus channel and prime the
 * limiter from the cluster-wide cached getter. Must be called AFTER
 * `initCacheBus(...)` and `initLlmQueueSettings(...)` so the subscription
 * target and the authoritative cold-loaded value are both in place.
 *
 * On every invalidation message, this re-reads `admin_settings` directly
 * (NOT through the cached getter) and atomically swaps `_limiter` via the
 * existing `setConcurrency` clamp if the concurrency changed. The direct
 * read is intentional: the cached-setting in `admin-settings-service.ts`
 * also subscribes to this channel and re-reads the same row, but the
 * cache-bus dispatcher does NOT await async handlers between them — going
 * through the cached getter would risk reading a stale value if our
 * handler runs before the cached-setting's `loadFromDb` completes.
 *
 * Idempotent: a second call while already active is a no-op (matches the
 * pattern used by `initSyncConflictPolicyService` + `initIpAllowlistService`).
 *
 * Soft-fail: if `subscribe(...)` throws (e.g. the cache-bus is in
 * single-pod mode), we still prime `_limiter` from the cached getter and
 * return — the queue will run pod-locally, just like pre-#113 behaviour.
 */
export function initLlmQueueClusterCoordination(): void {
  if (_clusterCoordinationActive) {
    logger.debug('llm-queue: cluster coordination already active — skipping');
    return;
  }

  // Prime from the cluster-wide cached getters. This replaces the env-var-
  // only initial config: env still works as a bootstrap fallback when the
  // admin_settings row is absent (the cached getter's `parse` handles that),
  // but the authoritative source is now the DB.
  try {
    const initialConcurrency = getLlmConcurrency();
    const initialDepth = getLlmMaxQueueDepth();
    setConcurrency(initialConcurrency);
    setMaxQueueDepth(initialDepth);
  } catch (err) {
    logger.warn(
      { err },
      'llm-queue: priming from cached getter failed — keeping current limiter',
    );
  }

  try {
    _unsubscribeClusterCoordination = subscribe('admin:llm:settings', async () => {
      // Re-read DB directly. The cached-setting in `admin-settings-service.ts`
      // also subscribes to this channel and re-reads the same row; we read
      // independently so the limiter swap doesn't depend on the cached
      // setter's async handler having already completed (the cache-bus
      // dispatcher fires handlers sequentially but does NOT await async
      // ones — see redis-cache-bus.ts:237-247). Reading twice from the same
      // row is cheap (~one round-trip per pod per admin PUT) and removes a
      // race that would otherwise leave the limiter at the stale value
      // until the next message.
      try {
        const { query } = await import('../../../core/db/postgres.js');
        const r = await query<{ setting_key: string; setting_value: string }>(
          `SELECT setting_key, setting_value FROM admin_settings
           WHERE setting_key IN ('llm_concurrency', 'llm_max_queue_depth')`,
          [],
        );
        for (const row of r.rows) {
          const val = parseInt(row.setting_value, 10);
          if (!Number.isFinite(val) || val < 1) continue;
          if (row.setting_key === 'llm_concurrency' && val !== _concurrency) {
            // `setConcurrency` clamps to [1, 100] + logs.
            // TODO(v0.5): see file header — in-flight jobs on the previous
            // limiter become orphaned. Pre-existing race; not fixed here.
            setConcurrency(val);
          }
          if (row.setting_key === 'llm_max_queue_depth' && val !== _maxQueueDepth) {
            setMaxQueueDepth(val);
            logger.info(
              { maxQueueDepth: val },
              'LLM queue max-queue-depth updated (cluster-wide)',
            );
          }
        }
      } catch (err) {
        logger.warn(
          { err },
          'llm-queue: cache-bus invalidation handler failed — keeping current limiter',
        );
      }
    });
    _clusterCoordinationActive = true;
    logger.info('llm-queue: cluster coordination active (admin:llm:settings)');
  } catch (err) {
    logger.warn(
      { err },
      'llm-queue: subscribe failed — running pod-locally without cluster coordination',
    );
  }
}

/**
 * Persist the new concurrency to `admin_settings.llm_concurrency` (UPSERT)
 * and publish on the cache-bus so every other pod re-reads + swaps its
 * limiter. The local limiter is also swapped via the same subscriber path
 * (every pod, including the publisher, observes the message), so the route
 * handler does NOT need to call `setConcurrency()` directly anymore.
 *
 * Validation: clamped to [1, 100] — same range as `setConcurrency`. The
 * caller is expected to have already validated the value via Zod (see
 * `UpdateAdminSettingsSchema` in `@compendiq/contracts`); this clamp is a
 * defensive backstop, not the primary boundary.
 *
 * This setter is the new flow for the admin route. The local-only
 * `setConcurrency(n)` is kept for tests + the env-var bootstrap path inside
 * `initLlmQueue()`.
 */
export async function setLlmConcurrencyClusterWide(n: number): Promise<void> {
  const val = Math.max(1, Math.min(n, 100));
  const { query } = await import('../../../core/db/postgres.js');
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ('llm_concurrency', $1, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = NOW()`,
    [String(val)],
  );
  await publish('admin:llm:settings', { at: Date.now() });
}

/**
 * Persist the new max-queue-depth to `admin_settings.llm_max_queue_depth`
 * (UPSERT) and publish on the cache-bus. Same flow as
 * `setLlmConcurrencyClusterWide` — see that doc-comment.
 */
export async function setLlmMaxQueueDepthClusterWide(n: number): Promise<void> {
  const val = Math.max(1, n);
  const { query } = await import('../../../core/db/postgres.js');
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ('llm_max_queue_depth', $1, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = NOW()`,
    [String(val)],
  );
  await publish('admin:llm:settings', { at: Date.now() });
}

// Test seam — reset cluster-coordination state so a test suite can re-init
// against fresh mocks without leaking the previous run's subscription.
export function _resetClusterCoordinationForTests(): void {
  if (_unsubscribeClusterCoordination) {
    _unsubscribeClusterCoordination();
  }
  _unsubscribeClusterCoordination = null;
  _clusterCoordinationActive = false;
}
