import { createHash } from 'crypto';
import type { RedisClientType } from 'redis';
import { logger } from '../utils/logger.js';

const LLM_CACHE_TTL = parseInt(process.env.LLM_CACHE_TTL ?? '3600', 10); // 1 hour default
const KEY_PREFIX = 'kb:llm:';

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
  options?: { includeSubPages?: boolean; pageId?: string },
): string {
  const sortedIds = [...docIds].sort().join(',');
  const subPageSuffix = options?.includeSubPages && options?.pageId
    ? `subpages:${options.pageId}`
    : '';
  return KEY_PREFIX + hashLlmInputs(model, question, sortedIds, subPageSuffix);
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
