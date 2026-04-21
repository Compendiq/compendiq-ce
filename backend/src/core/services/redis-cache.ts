import type { RedisClientType } from 'redis';
import { randomUUID } from 'node:crypto';
import { EMBEDDING_LOCK_TTL_MS } from '@compendiq/contracts';
import { logger } from '../utils/logger.js';

// Module-level reference for services that need cache invalidation without Fastify context
let _redisClient: RedisClientType | null = null;

/**
 * Store a reference to the Redis client so standalone services (e.g. embedding-service)
 * can invalidate cache entries without access to the Fastify instance.
 */
export function setRedisClient(client: RedisClientType): void {
  _redisClient = client;
}

/**
 * Get the module-level Redis client (for use by other services).
 * Returns null if Redis is not initialised.
 */
export function getRedisClient(): RedisClientType | null {
  return _redisClient;
}

/**
 * Invalidate the graph cache for a specific user.
 * Safe to call even if Redis is not initialised (no-op).
 */
export async function invalidateGraphCache(userId: string): Promise<void> {
  if (!_redisClient) return;
  try {
    await _redisClient.del(key(userId, 'pages', 'graph'));
    logger.debug({ userId }, 'Invalidated graph cache');
  } catch (err) {
    logger.error({ err, userId }, 'Failed to invalidate graph cache');
  }
}

// ── Embedding processing lock (distributed via Redis) ──────────────────
// Replaces in-memory Set<string> to work correctly in multi-process deployments.
// Uses SET NX EX for atomic lock acquisition with a safety TTL.

/**
 * Safety TTL on embedding lock keys (seconds). Derived from the shared
 * `EMBEDDING_LOCK_TTL_MS` contract constant so the frontend banner can
 * compute "held for" without hardcoding the value. 1 hour default —
 * prevents permanent locks on crash.
 */
export const EMBEDDING_LOCK_TTL = Math.floor(EMBEDDING_LOCK_TTL_MS / 1000);

function embeddingLockKey(userId: string): string {
  return `embedding:lock:${userId}`;
}

/**
 * Attempt to acquire the embedding processing lock for a user.
 * Uses Redis SET NX EX for atomic acquisition.
 * Returns a unique lock identifier if acquired, or null if already held.
 * The identifier must be passed to releaseEmbeddingLock to prove ownership.
 * Falls back to a generated identifier if Redis is not available.
 */
export async function acquireEmbeddingLock(userId: string): Promise<string | null> {
  const lockId = randomUUID();
  if (!_redisClient) {
    logger.warn({ userId }, 'Redis not available for embedding lock, proceeding without lock');
    return lockId;
  }
  try {
    const result = await _redisClient.set(embeddingLockKey(userId), lockId, {
      NX: true,
      EX: EMBEDDING_LOCK_TTL,
    });
    return result !== null ? lockId : null;
  } catch (err) {
    logger.error({ err, userId }, 'Failed to acquire embedding lock');
    return null;
  }
}

// Lua script: only delete the lock if the caller owns it (value matches).
// Prevents a process from deleting a lock that was re-acquired by another
// process after the original lock's TTL expired.
const RELEASE_LOCK_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/**
 * Release the embedding processing lock for a user.
 * Uses a Lua script to verify lock ownership before deleting, preventing
 * stale lock deletion when the TTL has expired and another process has
 * re-acquired the lock.
 * Safe to call even if Redis is not available (no-op).
 */
export async function releaseEmbeddingLock(userId: string, lockId: string): Promise<void> {
  if (!_redisClient) return;
  try {
    await _redisClient.eval(RELEASE_LOCK_SCRIPT, {
      keys: [embeddingLockKey(userId)],
      arguments: [lockId],
    });
  } catch (err) {
    logger.error({ err, userId }, 'Failed to release embedding lock');
  }
}

/**
 * Check if the embedding processing lock is held for a user.
 * Returns false if Redis is not available.
 */
export async function isEmbeddingLocked(userId: string): Promise<boolean> {
  if (!_redisClient) return false;
  try {
    const result = await _redisClient.exists(embeddingLockKey(userId));
    return result === 1;
  } catch (err) {
    logger.error({ err, userId }, 'Failed to check embedding lock');
    return false;
  }
}

// ── Embedding lock visibility + admin escape hatch (plan §2.1) ───────────

/** Snapshot of a single active per-user embedding lock (issue #257). */
export interface EmbeddingLockSnapshot {
  userId: string;
  /** Lock identity token (random UUID written by `acquireEmbeddingLock`).
   *  Exposed so the worker can verify, before each write, that the lock it
   *  originally acquired is still the one in Redis (holder-epoch guard). */
  holderEpoch: string;
  /** Remaining TTL in milliseconds. `-2` means key does not exist; `-1` means
   *  the key has no TTL (should not happen — `acquireEmbeddingLock` always
   *  sets one). */
  ttlRemainingMs: number;
}

/**
 * List all per-user embedding locks currently held.
 *
 * Uses Redis SCAN (NOT KEYS) to avoid blocking Redis on large keyspaces.
 * Returns `[]` when Redis is unavailable or SCAN fails.
 *
 * Consumers:
 *   1. Admin UI (`GET /api/admin/embedding/locks`) — renders "alice, bob".
 *   2. `runReembedAllJob` wait-on-locks loop (worker back-pressure).
 */
export async function listActiveEmbeddingLocks(): Promise<EmbeddingLockSnapshot[]> {
  if (!_redisClient) return [];
  const out: EmbeddingLockSnapshot[] = [];
  try {
    // Existing modules (e.g. `clearAttachmentFailures`, `RedisCache.scanAndDelete`)
    // use the string-cursor form. Stay consistent with that idiom.
    let cursor = '0';
    do {
      const reply = await _redisClient.scan(cursor, {
        MATCH: 'embedding:lock:*',
        COUNT: 100,
      });
      cursor = String(reply.cursor);
      for (const key of reply.keys) {
        const userId = key.slice('embedding:lock:'.length);
        if (!userId) continue; // defend against malformed trailing-colon keys
        // Two round-trips per key is fine for the expected keyspace size
        // (typically << 100 entries) and the 5-second admin poll cadence.
        const [holderEpoch, pttl] = await Promise.all([
          _redisClient.get(key),
          _redisClient.pTTL(key),
        ]);
        out.push({
          userId,
          holderEpoch: holderEpoch ?? '',
          ttlRemainingMs: typeof pttl === 'number' ? pttl : -2,
        });
      }
    } while (cursor !== '0');
    return out;
  } catch (err) {
    logger.error({ err }, 'Failed to list active embedding locks');
    return [];
  }
}

/**
 * Admin escape hatch — force-delete a per-user embedding lock regardless of
 * holder. Unlike `releaseEmbeddingLock(userId, lockId)` (which refuses to
 * delete unless the caller's lockId matches the stored value via Lua), this
 * one unconditionally DELs the key. Use ONLY from admin-authenticated routes;
 * log to the audit trail on every call.
 *
 * Returns:
 *   - `{ released: true,  previousHolderEpoch: '<uuid>' }` when the key existed.
 *   - `{ released: false, previousHolderEpoch: null     }` when the key was
 *     already gone (idempotent — no 404) or when Redis is unavailable.
 *
 * Safety contract (documented for operators):
 *   If the user's embedding worker is still genuinely running when this is
 *   called, the worker's next `embedPage` transaction will still commit (it
 *   doesn't re-check the lock between every row). A racing second acquirer of
 *   the same userId's lock would see a fresh `holderEpoch`; the original
 *   worker's write-guard (§2.10 holder-epoch guard) detects this and aborts
 *   the loop. Duplicate rows in `page_embeddings` are prevented by the
 *   DELETE/INSERT transaction inside `embedPage`.
 */
export async function forceReleaseEmbeddingLock(
  userId: string,
): Promise<{ released: boolean; previousHolderEpoch: string | null }> {
  if (!_redisClient) {
    return { released: false, previousHolderEpoch: null };
  }
  try {
    const key = embeddingLockKey(userId);
    const previous = await _redisClient.get(key);
    const deleted = await _redisClient.del(key);
    return {
      released: deleted === 1,
      previousHolderEpoch: previous,
    };
  } catch (err) {
    logger.error({ err, userId }, 'Failed to force-release embedding lock');
    return { released: false, previousHolderEpoch: null };
  }
}

// ── Generic worker lock (distributed via Redis) ──────────────────────────
// Provides a simple distributed lock for background workers (quality, summary,
// token-cleanup) so that only one process runs a given worker at a time.
// Falls back to returning true (lock acquired) when Redis is unavailable,
// preserving single-node behaviour.

/**
 * Attempt to acquire a named worker lock via Redis SET NX EX.
 * Returns true if the lock was acquired, false if another holder has it.
 * Falls back to true when Redis is not available (single-node fallback).
 */
export async function acquireWorkerLock(name: string, ttlSeconds = 300): Promise<boolean> {
  if (!_redisClient) return true; // single-node fallback
  try {
    const result = await _redisClient.set(`worker:lock:${name}`, '1', {
      NX: true,
      EX: ttlSeconds,
    });
    return result !== null;
  } catch (err) {
    logger.error({ err, name }, 'Failed to acquire worker lock');
    return true; // degrade to local execution
  }
}

/**
 * Release a named worker lock.
 * Safe to call when Redis is unavailable (no-op).
 */
export async function releaseWorkerLock(name: string): Promise<void> {
  if (!_redisClient) return;
  try {
    await _redisClient.del(`worker:lock:${name}`);
  } catch (err) {
    logger.error({ err, name }, 'Failed to release worker lock');
  }
}

// ── Attachment download-failure tracking (persisted in Redis) ──────────────
// Tracks per-attachment download failures so we can skip Confluence calls
// for attachments that have persistently failed, even across container restarts.
// Uses a simple INCR + EXPIRE pattern (non-atomic: TTL is reset on every call,
// which is the intended mitigation — keys with no TTL after a crash are
// eventually corrected on the next failure record).

/** Maximum consecutive download failures before an attachment is skipped on-demand */
export const MAX_ATTACHMENT_FAILURES = 3;

/** 7-day TTL for failure counters (allows recovery after Confluence fix) */
const ATTACHMENT_FAILURE_TTL = 7 * 24 * 3600;

function attachmentFailureKey(pageId: string, filename: string): string {
  // Encode filename to prevent Redis glob chars (*, ?, [, ]) from causing
  // false matches during SCAN pattern matching in clearAttachmentFailures.
  return `attach:fail:${pageId}:${encodeURIComponent(filename)}`;
}

/**
 * Increment the failure counter for an attachment.
 * Safe to call when Redis is null (no-op).
 */
export async function recordAttachmentFailure(
  redis: RedisClientType | null,
  pageId: string,
  filename: string,
): Promise<void> {
  if (!redis) return;
  try {
    const k = attachmentFailureKey(pageId, filename);
    await redis.incr(k);
    await redis.expire(k, ATTACHMENT_FAILURE_TTL);
  } catch (err) {
    logger.error({ err, pageId, filename }, 'Failed to record attachment failure');
  }
}

/**
 * Get the current failure count for an attachment.
 * Returns 0 when Redis is unavailable or the key does not exist.
 */
export async function getAttachmentFailureCount(
  redis: RedisClientType | null,
  pageId: string,
  filename: string,
): Promise<number> {
  if (!redis) return 0;
  try {
    const val = await redis.get(attachmentFailureKey(pageId, filename));
    if (val === null) return 0;
    const n = parseInt(val, 10);
    return Number.isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

/**
 * Clear all failure counters for a page (e.g. after a successful sync).
 * Uses a SCAN cursor loop to avoid blocking Redis with KEYS.
 * Safe to call when Redis is null (no-op).
 */
export async function clearAttachmentFailures(
  redis: RedisClientType | null,
  pageId: string,
): Promise<void> {
  if (!redis) return;
  try {
    const pattern = `attach:fail:${pageId}:*`;
    let cursor = '0';
    do {
      const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = String(result.cursor);
      if (result.keys.length > 0) {
        await redis.del(result.keys);
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.error({ err, pageId }, 'Failed to clear attachment failure counters');
  }
}

const TTL = {
  pages: 900,      // 15 minutes
  spaces: 900,     // 15 minutes
  search: 300,     // 5 minutes
  sync: 60,        // 1 minute (sync status)
  llm: 3600,       // 1 hour (LLM response cache)
} as const;

type CacheType = keyof typeof TTL;

function key(userId: string, type: CacheType, identifier: string): string {
  return `kb:${userId}:${type}:${identifier}`;
}

export class RedisCache {
  constructor(private redis: RedisClientType) {}

  async get<T>(userId: string, type: CacheType, identifier: string): Promise<T | null> {
    try {
      const data = await this.redis.get(key(userId, type, identifier));
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch (err) {
      logger.error({ err, key: key(userId, type, identifier) }, 'Redis cache get error');
      return null;
    }
  }

  async set(userId: string, type: CacheType, identifier: string, data: unknown, ttlOverride?: number): Promise<void> {
    try {
      await this.redis.setEx(
        key(userId, type, identifier),
        ttlOverride ?? TTL[type],
        JSON.stringify(data),
      );
    } catch (err) {
      logger.error({ err, key: key(userId, type, identifier) }, 'Redis cache set error');
    }
  }

  async invalidate(userId: string, type: CacheType, identifier?: string): Promise<void> {
    try {
      if (identifier) {
        await this.redis.del(key(userId, type, identifier));
      } else {
        // Invalidate all keys of this type for user using SCAN (O(1) per call vs O(N) KEYS)
        await this.scanAndDelete(`kb:${userId}:${type}:*`);
      }
    } catch (err) {
      logger.error({ err, userId, type }, 'Redis cache invalidate error');
    }
  }

  async invalidateAllForUser(userId: string): Promise<void> {
    try {
      await this.scanAndDelete(`kb:${userId}:*`);
    } catch (err) {
      logger.error({ err, userId }, 'Redis cache invalidate all error');
    }
  }

  /**
   * Cache-aside with stampede protection.
   *
   * On cache miss, acquires a short-lived NX lock so only one caller computes
   * the value. Other concurrent callers poll the cache for up to 5 seconds;
   * if the value still does not appear they fall through and compute it
   * themselves (safe fallback — better than hanging forever).
   */
  async getOrCompute<T>(
    cacheKey: string,
    computeFn: () => Promise<T>,
    ttl: number,
  ): Promise<T> {
    // 1. Fast path: cache hit
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached !== null) return JSON.parse(cached) as T;
    } catch {
      // Redis read failure — fall through to compute
    }

    // 2. Try to acquire a stampede lock
    const lockKey = `${cacheKey}:lock`;
    let lockAcquired = false;
    try {
      const result = await this.redis.set(lockKey, '1', { NX: true, EX: 30 });
      lockAcquired = result !== null;
    } catch {
      // Redis failure — proceed without lock
    }

    if (lockAcquired) {
      try {
        const value = await computeFn();
        try {
          await this.redis.setEx(cacheKey, ttl, JSON.stringify(value));
        } catch {
          // Cache store failed — not critical, value is still returned
        }
        return value;
      } finally {
        try {
          await this.redis.del(lockKey);
        } catch {
          // Lock cleanup failed — TTL will expire it
        }
      }
    }

    // 3. Another caller holds the lock — poll for the result
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached !== null) return JSON.parse(cached) as T;
      } catch {
        // Redis read failure during poll — keep trying until deadline
      }
    }

    // 4. Timeout waiting — compute it ourselves (safe fallback)
    const value = await computeFn();
    try {
      await this.redis.setEx(cacheKey, ttl, JSON.stringify(value));
    } catch {
      // Best-effort cache store
    }
    return value;
  }

  private async scanAndDelete(pattern: string): Promise<void> {
    let cursor = '0';
    do {
      const result = await this.redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = String(result.cursor);
      if (result.keys.length > 0) {
        await this.redis.del(result.keys);
      }
    } while (cursor !== '0');
  }
}
