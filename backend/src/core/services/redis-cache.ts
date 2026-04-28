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

/**
 * Redis Set that mirrors the active set of per-user embedding lock keys.
 * Maintained atomically alongside the `embedding:lock:<userId>` string keys
 * so `listActiveEmbeddingLocks()` can resolve the current holders via one
 * O(N) SMEMBERS + one pipelined batch of GET/PTTL, rather than a SCAN walk
 * over the whole Redis keyspace. See issue #265.
 */
const LOCKS_ACTIVE_SET = 'embedding:locks:active';

function embeddingLockKey(userId: string): string {
  return `embedding:lock:${userId}`;
}

/**
 * Acquire Lua — atomically SET NX EX the per-user lock key AND, on success,
 * SADD the userId into the active-locks set. If SET NX fails (key already
 * held) the SADD MUST NOT run, which is why conditional logic requires Lua
 * rather than MULTI/EXEC. Returns the lockId on success and nil otherwise.
 *
 *   KEYS[1] = embedding:lock:<userId>
 *   KEYS[2] = embedding:locks:active
 *   ARGV[1] = lockId (UUID)
 *   ARGV[2] = userId
 *   ARGV[3] = TTL seconds (stringified)
 */
const ACQUIRE_LOCK_SCRIPT = `if redis.call("set", KEYS[1], ARGV[1], "NX", "EX", ARGV[3]) then redis.call("sadd", KEYS[2], ARGV[2]) return ARGV[1] end return nil`;

/**
 * Attempt to acquire the embedding processing lock for a user.
 * Executes a single Lua script that performs `SET NX EX` + conditional `SADD`
 * atomically. Returns a unique lock identifier if acquired, or null if already
 * held. The identifier must be passed to releaseEmbeddingLock to prove
 * ownership. Falls back to a generated identifier if Redis is not available.
 */
export async function acquireEmbeddingLock(userId: string): Promise<string | null> {
  const lockId = randomUUID();
  if (!_redisClient) {
    logger.warn({ userId }, 'Redis not available for embedding lock, proceeding without lock');
    return lockId;
  }
  try {
    const result = await _redisClient.eval(ACQUIRE_LOCK_SCRIPT, {
      keys: [embeddingLockKey(userId), LOCKS_ACTIVE_SET],
      arguments: [lockId, userId, String(EMBEDDING_LOCK_TTL)],
    });
    return typeof result === 'string' ? result : null;
  } catch (err) {
    logger.error({ err, userId }, 'Failed to acquire embedding lock');
    return null;
  }
}

/**
 * Release Lua — only delete the lock if the caller owns it (value matches).
 * Prevents a process from deleting a lock that was re-acquired by another
 * process after the original lock's TTL expired. On successful DEL the
 * active-locks set is SREM'd in the same atomic script so the set cannot
 * lag behind the authoritative lock keys.
 *
 *   KEYS[1] = embedding:lock:<userId>
 *   KEYS[2] = embedding:locks:active
 *   ARGV[1] = lockId (UUID)
 *   ARGV[2] = userId
 */
const RELEASE_LOCK_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then redis.call("del", KEYS[1]) redis.call("srem", KEYS[2], ARGV[2]) return 1 else return 0 end`;

/**
 * Release the embedding processing lock for a user.
 * Uses a Lua script to verify lock ownership before deleting, preventing
 * stale lock deletion when the TTL has expired and another process has
 * re-acquired the lock. On successful release the active-locks set is
 * scrubbed atomically.
 * Safe to call even if Redis is not available (no-op).
 */
export async function releaseEmbeddingLock(userId: string, lockId: string): Promise<void> {
  if (!_redisClient) return;
  try {
    await _redisClient.eval(RELEASE_LOCK_SCRIPT, {
      keys: [embeddingLockKey(userId), LOCKS_ACTIVE_SET],
      arguments: [lockId, userId],
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
 * Resolves the active-holder set via one `SMEMBERS embedding:locks:active`
 * call followed by a pipelined batch of GET + PTTL per member (one network
 * round-trip for the whole batch via node-redis `.multi().exec()`, which
 * wraps in MULTI/EXEC by default — fine for read-only commands).
 *
 * This replaces the previous `SCAN MATCH embedding:lock:*` implementation
 * which degraded with unrelated Redis keyspace growth. The set is maintained
 * atomically by the acquire / release / forceRelease Lua scripts.
 *
 * Returns `[]` when Redis is unavailable or any call fails.
 *
 * Self-healing. If a set member points to a lock key that no longer exists
 * (crash in between DEL and SREM, or external flush), the reader treats the
 * null GET reply as stale and fires a fire-and-forget SREM to drop the drift.
 * The stale entry is still returned in the snapshot (with `holderEpoch: ''`
 * and `ttlRemainingMs: -2`, matching the parity semantics of the old SCAN
 * implementation) so callers always see a deterministic reply-for-reply view
 * of the current set state; on the next call the member will be gone.
 *
 * Consumers:
 *   1. Admin UI (`GET /api/admin/embedding/locks`) — renders "alice, bob".
 *   2. `runReembedAllJob` wait-on-locks loop (worker back-pressure).
 */
export async function listActiveEmbeddingLocks(): Promise<EmbeddingLockSnapshot[]> {
  if (!_redisClient) return [];
  try {
    const userIds = await _redisClient.sMembers(LOCKS_ACTIVE_SET);
    if (userIds.length === 0) return [];

    const pipeline = _redisClient.multi();
    for (const uid of userIds) {
      pipeline.get(embeddingLockKey(uid));
      pipeline.pTTL(embeddingLockKey(uid));
    }
    const replies = (await pipeline.exec()) as unknown as Array<string | number | null>;

    const out: EmbeddingLockSnapshot[] = [];
    const staleMembers: string[] = [];
    for (let i = 0; i < userIds.length; i++) {
      const uid = userIds[i]!;
      const holderEpoch = replies[i * 2] as string | null;
      const pttl = replies[i * 2 + 1];

      if (holderEpoch === null) {
        // Lock key expired but the SREM in the release/forceRelease Lua
        // never fired (e.g. process crash between acquire and release).
        // Emit the SCAN-parity placeholder (`-2` = no key / no TTL) and
        // schedule the set entry for scrubbing.
        staleMembers.push(uid);
        out.push({ userId: uid, holderEpoch: '', ttlRemainingMs: -2 });
        continue;
      }
      out.push({
        userId: uid,
        holderEpoch,
        ttlRemainingMs: typeof pttl === 'number' ? pttl : -2,
      });
    }

    if (staleMembers.length > 0) {
      // Fire-and-forget lazy self-heal — don't block the admin poll or the
      // reembed-all wait-loop on a scrubbing round-trip.
      _redisClient
        .sRem(LOCKS_ACTIVE_SET, staleMembers)
        .catch((err) =>
          logger.warn(
            { err, staleMembers },
            'Lazy SREM of stale embedding-lock set members failed',
          ),
        );
    }

    return out;
  } catch (err) {
    logger.error({ err }, 'Failed to list active embedding locks');
    return [];
  }
}

/**
 * Force-release Lua — atomic unconditional DEL of the per-user lock key plus
 * SREM of the active-locks set. The SREM runs even when the key was already
 * gone so any drift (e.g. a crashed worker that left a set entry behind) is
 * scrubbed on the same call that the admin already decided was authoritative.
 *
 *   KEYS[1] = embedding:lock:<userId>
 *   KEYS[2] = embedding:locks:active
 *   ARGV[1] = userId
 *
 * Returns the previous holder epoch on DEL, otherwise nil.
 */
const FORCE_RELEASE_SCRIPT = `local prev = redis.call("get", KEYS[1]) if prev then redis.call("del", KEYS[1]) redis.call("srem", KEYS[2], ARGV[1]) return prev end redis.call("srem", KEYS[2], ARGV[1]) return nil`;

/**
 * Admin escape hatch — force-delete a per-user embedding lock regardless of
 * holder. Unlike `releaseEmbeddingLock(userId, lockId)` (which refuses to
 * delete unless the caller's lockId matches the stored value via Lua), this
 * one unconditionally DELs the key. Use ONLY from admin-authenticated routes;
 * log to the audit trail on every call.
 *
 * The DEL and the SREM of `embedding:locks:active` are performed in a single
 * Lua script so a racing `listActiveEmbeddingLocks()` cannot observe the
 * partial state where the key is gone but the set still advertises the
 * member. The SREM also runs when the key was already gone, so this function
 * doubles as a drift-scrubber for stale set entries.
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
    const prev = await _redisClient.eval(FORCE_RELEASE_SCRIPT, {
      keys: [embeddingLockKey(userId), LOCKS_ACTIVE_SET],
      arguments: [userId],
    });
    return {
      released: prev !== null && prev !== undefined,
      previousHolderEpoch: typeof prev === 'string' ? prev : null,
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
   * Invalidate every user's cache of the given type.
   *
   * Used when an admin/space-owner mutation changes data that is visible to
   * all users (e.g. setting a space's custom home page — #352). The per-user
   * `invalidate(userId, type)` only clears the calling admin's cache and
   * leaves every other user reading stale data for up to TTL seconds.
   *
   * Implemented as a single SCAN cursor walk over `kb:*:{type}:*` against the
   * shared Redis. Works in single-pod and multi-pod deployments without
   * needing pub/sub — Redis is the authoritative store, so deleting the keys
   * is sufficient; subsequent reads from any pod miss and re-populate.
   */
  async invalidateAcrossUsers(type: CacheType): Promise<void> {
    try {
      await this.scanAndDelete(`kb:*:${type}:*`);
    } catch (err) {
      logger.error({ err, type }, 'Redis cache invalidate across users error');
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
