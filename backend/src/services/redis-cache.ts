import type { RedisClientType } from 'redis';
import { randomUUID } from 'node:crypto';
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

const EMBEDDING_LOCK_TTL = 3600; // 1 hour safety TTL prevents permanent lock on crash

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
