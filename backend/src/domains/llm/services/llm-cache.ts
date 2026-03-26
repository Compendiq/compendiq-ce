import { createHash } from 'crypto';
import type { RedisClientType } from 'redis';
import { logger } from '../../../core/utils/logger.js';

const LLM_CACHE_TTL = parseInt(process.env.LLM_CACHE_TTL ?? '3600', 10); // 1 hour default
const KEY_PREFIX = 'kb:llm:';
const LOCK_PREFIX = 'llm:lock:';
const LOCK_TTL = 120; // seconds — safety net if holder crashes
const LOCK_POLL_INTERVAL_MS = 1_000; // 1 second between polls
const LOCK_POLL_TIMEOUT_MS = 60_000; // give up waiting after 60 seconds

export interface CachedLlmResponse {
  content: string;
  cachedAt: number;
}

/**
 * Create a deterministic SHA-256 hash from LLM input parameters.
 * Used as the cache key for non-streaming LLM calls.
 */
export function hashLlmInputs(...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\x00'); // null byte separator to avoid collisions
  }
  return hash.digest('hex');
}

/**
 * Build a cache key for a standard LLM call (improve, generate, summarize).
 * Based on: model + system_prompt + user_content
 */
export function buildLlmCacheKey(model: string, systemPrompt: string, userContent: string): string {
  return KEY_PREFIX + hashLlmInputs(model, systemPrompt, userContent);
}

/**
 * Build a cache key for a RAG Q&A call.
 * Based on: model + question + sorted top-K doc IDs + optional sub-page context.
 * This means the cache automatically invalidates when documents are re-embedded
 * (because the top-K results will change).
 *
 * The `includeSubPages` and `pageId` parameters ensure that identical questions
 * produce different cache keys when sub-page context is toggled on/off.
 */
export function buildRagCacheKey(
  model: string,
  question: string,
  docIds: string[],
  options?: { includeSubPages?: boolean; pageId?: string; externalUrls?: string[]; searchWeb?: boolean },
): string {
  const sortedIds = [...docIds].sort().join(',');
  const subPageSuffix = options?.includeSubPages && options?.pageId
    ? `subpages:${options.pageId}`
    : '';
  const externalSuffix = options?.externalUrls?.length
    ? `ext:${[...options.externalUrls].sort().join(',')}`
    : '';
  const webSuffix = options?.searchWeb ? 'web:1' : '';
  return KEY_PREFIX + hashLlmInputs(model, question, sortedIds, subPageSuffix, externalSuffix, webSuffix);
}

export class LlmCache {
  constructor(private redis: RedisClientType) {}

  /**
   * Get a cached LLM response by cache key.
   */
  async getCachedResponse(cacheKey: string): Promise<CachedLlmResponse | null> {
    try {
      const data = await this.redis.get(cacheKey);
      if (!data) return null;
      return JSON.parse(data) as CachedLlmResponse;
    } catch (err) {
      logger.error({ err, cacheKey }, 'LLM cache get error');
      return null;
    }
  }

  /**
   * Store an LLM response in the cache.
   */
  async setCachedResponse(
    cacheKey: string,
    content: string,
    ttl: number = LLM_CACHE_TTL,
  ): Promise<void> {
    try {
      const cached: CachedLlmResponse = {
        content,
        cachedAt: Date.now(),
      };
      await this.redis.setEx(cacheKey, ttl, JSON.stringify(cached));
    } catch (err) {
      logger.error({ err, cacheKey }, 'LLM cache set error');
    }
  }

  /**
   * Acquire a Redis-based lock for a cache key using SET NX EX.
   * Returns true if the lock was acquired, false if another holder has it.
   */
  async acquireLock(cacheKey: string, ttl: number = LOCK_TTL): Promise<boolean> {
    try {
      const lockKey = LOCK_PREFIX + cacheKey;
      // SET key value NX EX ttl — atomic "set if not exists" with expiry
      const result = await this.redis.set(lockKey, '1', { NX: true, EX: ttl });
      return result !== null;
    } catch (err) {
      logger.error({ err, cacheKey }, 'LLM lock acquire error');
      // On Redis failure, allow the caller to proceed (degrade gracefully)
      return true;
    }
  }

  /**
   * Release the Redis lock for a cache key.
   * Safe to call even if the lock was not held (no-op).
   */
  async releaseLock(cacheKey: string): Promise<void> {
    try {
      await this.redis.del(LOCK_PREFIX + cacheKey);
    } catch (err) {
      logger.error({ err, cacheKey }, 'LLM lock release error');
    }
  }

  /**
   * Poll for a cached response to appear (written by the lock holder).
   * Returns the cached response if it appears within the timeout, or null
   * if the timeout expires (caller should then generate its own response).
   */
  async waitForCachedResponse(
    cacheKey: string,
    pollIntervalMs: number = LOCK_POLL_INTERVAL_MS,
    timeoutMs: number = LOCK_POLL_TIMEOUT_MS,
  ): Promise<CachedLlmResponse | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const cached = await this.getCachedResponse(cacheKey);
      if (cached) return cached;

      // Check if the lock is still held — if not, the holder may have failed
      try {
        const lockKey = LOCK_PREFIX + cacheKey;
        const lockExists = await this.redis.exists(lockKey);
        if (!lockExists) {
          logger.debug({ cacheKey }, 'Lock released but no cached response — proceeding with generation');
          return null;
        }
      } catch {
        // Redis error during exists check — keep polling
      }

      await sleep(pollIntervalMs);
    }

    logger.warn({ cacheKey }, 'Timed out waiting for locked LLM cache — proceeding with generation');
    return null;
  }

  /**
   * Clear all LLM cache entries using SCAN (O(1) per call).
   */
  async clearAll(): Promise<number> {
    let cursor = '0';
    let deleted = 0;
    try {
      do {
        const result = await this.redis.scan(cursor, {
          MATCH: `${KEY_PREFIX}*`,
          COUNT: 100,
        });
        cursor = String(result.cursor);
        if (result.keys.length > 0) {
          await this.redis.del(result.keys);
          deleted += result.keys.length;
        }
      } while (cursor !== '0');
    } catch (err) {
      logger.error({ err }, 'LLM cache clear error');
    }
    return deleted;
  }
}

/** Promise-based sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
