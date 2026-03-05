import type { RedisClientType } from 'redis';
import { logger } from '../utils/logger.js';

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

  async set(userId: string, type: CacheType, identifier: string, data: unknown): Promise<void> {
    try {
      await this.redis.setEx(
        key(userId, type, identifier),
        TTL[type],
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
