/**
 * Per-user concurrent SSE-stream limiter (issue #268).
 *
 * Streaming LLM calls intentionally bypass the LLM request queue
 * (see `openai-compatible-client.ts` — streamed requests are long-lived and
 * would clog the queue). Without an upper bound, one user can saturate the
 * upstream LLM by opening many simultaneous streams. This module caps the
 * number of simultaneously-open streams per user via a Redis counter.
 *
 * Cap cascade (mirrors `rate-limit-service` / `admin-settings-service`):
 *   admin_settings.llm_max_concurrent_streams_per_user   (authoritative)
 *     → process.env.LLM_MAX_CONCURRENT_STREAMS_PER_USER  (deprecated bootstrap fallback)
 *     → 3                                                (hard default)
 *
 * Redis key: `llm:streams:<userId>`. Every acquire re-runs `EXPIRE` with a
 * 1-hour TTL so a crashed process's leaked counter self-heals.
 *
 * Lowering the cap at runtime is graceful: existing in-flight streams run to
 * completion (their DECR on release still executes, even if it drives the
 * counter below the new cap). Only new opens see the lower cap.
 *
 * Fail-open: when Redis is unavailable or the acquire eval throws, the slot is
 * treated as acquired with a no-op release. Consistent with
 * `acquireEmbeddingLock` (redis-cache.ts) — rejecting streams during a Redis
 * outage is worse than temporarily exceeding the cap.
 */
import { getRedisClient } from './redis-cache.js';
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

/** 1-hour safety TTL so crashed processes don't leak counters permanently. */
const STREAM_COUNTER_TTL_SECONDS = 3600;
/** 60-second in-process cache for the resolved cap. Matches rate-limit-service. */
const CACHE_TTL_MS = 60_000;
/** Hard fallback when neither admin_settings nor env var is set. */
const HARD_DEFAULT = 3;
/** Zod validation range (kept in sync with packages/contracts/src/schemas/admin.ts). */
const MIN_CAP = 1;
const MAX_CAP = 20;
/** admin_settings setting_key. */
const DB_KEY = 'llm_max_concurrent_streams_per_user';

let capCache: { value: number; expiresAt: number } | null = null;

/**
 * Resolve the per-user concurrent-stream cap via the admin-settings → env
 * → hard-default cascade. Cached in-process for 60 s.
 */
export async function getStreamCap(): Promise<number> {
  if (capCache && Date.now() < capCache.expiresAt) {
    return capCache.value;
  }

  let resolved = HARD_DEFAULT;
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
      [DB_KEY],
    );
    const dbValue = r.rows[0]?.setting_value;
    if (dbValue !== undefined) {
      const n = parseInt(dbValue, 10);
      if (Number.isFinite(n) && n >= MIN_CAP && n <= MAX_CAP) {
        resolved = n;
      }
      // Out-of-range or non-numeric DB values silently fall through to
      // HARD_DEFAULT — do NOT consult the env var in that case, since the
      // admin explicitly wrote a bad value and the UI/Zod should catch it
      // on the next write.
    } else {
      // DB row absent → consult the deprecated bootstrap env var.
      const envValue = process.env.LLM_MAX_CONCURRENT_STREAMS_PER_USER;
      if (envValue) {
        const n = parseInt(envValue, 10);
        if (Number.isFinite(n) && n >= MIN_CAP && n <= MAX_CAP) {
          resolved = n;
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve SSE-stream cap — falling back to hard default');
  }

  capCache = { value: resolved, expiresAt: Date.now() + CACHE_TTL_MS };
  return resolved;
}

/**
 * Called by the admin-settings PUT handler after writing the new value so
 * the cap takes effect immediately in the local process. Other processes
 * pick it up within the 60-second TTL.
 */
export function invalidateStreamCapCache(): void {
  capCache = null;
}

function streamKey(userId: string): string {
  return `llm:streams:${userId}`;
}

/**
 * Atomic acquire. Avoids the "two clients race past the cap by one" classic:
 * a naive INCR + read-and-compare has a TOCTOU window between the two ops.
 *
 *   KEYS[1] = llm:streams:<userId>
 *   ARGV[1] = cap
 *   ARGV[2] = TTL seconds
 *
 * Returns 1 if acquired, 0 if the resulting count would exceed the cap (in
 * which case the INCR is rolled back by DECR). Always re-sets TTL on success
 * so a leaked counter self-heals.
 */
const ACQUIRE_SCRIPT = `
local n = redis.call("incr", KEYS[1])
if n > tonumber(ARGV[1]) then
  redis.call("decr", KEYS[1])
  return 0
end
redis.call("expire", KEYS[1], ARGV[2])
return 1
`;

export interface StreamSlot {
  acquired: boolean;
  /**
   * Release the slot. Idempotent — calling twice DECRs once. Safe to call
   * regardless of whether `acquired` was true. No-op if the slot was not
   * acquired (rejected) or Redis is unavailable.
   */
  release: () => Promise<void>;
}

/**
 * Fail-open slot: behaves as if acquired but does nothing on release.
 * Used when Redis is unreachable so streams aren't blocked during outage.
 */
function failOpenSlot(): StreamSlot {
  return {
    acquired: true,
    release: async () => {
      /* no-op — no counter was incremented */
    },
  };
}

/**
 * Attempt to acquire a per-user SSE-stream slot. Must be called BEFORE
 * `reply.hijack()` so a rejection can be returned as a normal JSON 429.
 *
 * The caller MUST wrap the SSE body in `try { … } finally { slot.release(); }`
 * so the counter decrements on success, error, timeout, AND client-disconnect.
 */
export async function acquireStreamSlot(userId: string): Promise<StreamSlot> {
  const redis = getRedisClient();
  if (!redis) {
    logger.warn(
      { userId },
      'Redis unavailable; skipping SSE-stream cap check (fail-open)',
    );
    return failOpenSlot();
  }

  const cap = await getStreamCap();

  let result: unknown;
  try {
    result = await redis.eval(ACQUIRE_SCRIPT, {
      keys: [streamKey(userId)],
      arguments: [String(cap), String(STREAM_COUNTER_TTL_SECONDS)],
    });
  } catch (err) {
    logger.error(
      { err, userId },
      'acquireStreamSlot eval failed — failing open',
    );
    return failOpenSlot();
  }

  // node-redis returns Lua integers as number | bigint depending on version.
  const acquired = result === 1 || result === 1n || result === '1';
  if (!acquired) {
    // Cap exceeded — the Lua script already rolled back the INCR.
    return {
      acquired: false,
      release: async () => {
        /* no-op — nothing was incremented on our behalf */
      },
    };
  }

  let released = false;
  return {
    acquired: true,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await redis.decr(streamKey(userId));
      } catch (err) {
        // The 1-hour TTL will eventually self-heal the leaked counter.
        logger.error(
          { err, userId },
          'Failed to DECR SSE-stream counter — will self-heal via TTL',
        );
      }
    },
  };
}

/**
 * Test-only helper. Do not call from production code.
 * Exposed so tests can force a re-read of the cascade between steps.
 */
export function _resetStreamCapCache(): void {
  capCache = null;
}
