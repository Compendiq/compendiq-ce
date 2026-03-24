/**
 * Redis cache for fetched documentation and search results.
 */

import { createHash } from 'node:crypto';
import type { RedisClientType } from 'redis';
import { logger } from '../logger.js';

export interface CachedDoc {
  markdown: string;
  title: string;
  url: string;
  fetchedAt: string;
  contentLength: number;
}

export interface CachedSearch {
  results: Array<{ title: string; url: string; snippet: string }>;
  query: string;
  fetchedAt: string;
}

function urlCacheKey(url: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  return `mcp:docs:url:${hash}`;
}

function searchCacheKey(query: string): string {
  const hash = createHash('sha256').update(query.toLowerCase()).digest('hex').slice(0, 16);
  return `mcp:docs:search:${hash}`;
}

export class DocsCache {
  constructor(
    private redis: RedisClientType | null,
    private docTtl: number = 3600,
    private searchTtl: number = 1800,
  ) {}

  async getCachedDoc(url: string): Promise<CachedDoc | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(urlCacheKey(url));
      return raw ? (JSON.parse(raw) as CachedDoc) : null;
    } catch (err) {
      logger.error({ err }, 'Cache get error');
      return null;
    }
  }

  async setCachedDoc(url: string, doc: CachedDoc): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.setEx(urlCacheKey(url), this.docTtl, JSON.stringify(doc));
    } catch (err) {
      logger.error({ err }, 'Cache set error');
    }
  }

  async getCachedSearch(query: string): Promise<CachedSearch | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(searchCacheKey(query));
      return raw ? (JSON.parse(raw) as CachedSearch) : null;
    } catch (err) {
      logger.error({ err }, 'Cache get error');
      return null;
    }
  }

  async setCachedSearch(query: string, data: CachedSearch): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.setEx(searchCacheKey(query), this.searchTtl, JSON.stringify(data));
    } catch (err) {
      logger.error({ err }, 'Cache set error');
    }
  }

  async listCachedDocs(filter?: string): Promise<CachedDoc[]> {
    if (!this.redis) return [];
    const docs: CachedDoc[] = [];
    try {
      let cursor = '0';
      do {
        const result = await this.redis.scan(cursor, { MATCH: 'mcp:docs:url:*', COUNT: 100 });
        cursor = String(result.cursor);
        for (const key of result.keys) {
          const raw = await this.redis.get(key);
          if (raw) {
            const doc = JSON.parse(raw) as CachedDoc;
            if (!filter || doc.url.includes(filter) || doc.title.toLowerCase().includes(filter.toLowerCase())) {
              docs.push(doc);
            }
          }
        }
      } while (cursor !== '0');
    } catch (err) {
      logger.error({ err }, 'Cache list error');
    }
    return docs;
  }

  async clearAll(): Promise<number> {
    if (!this.redis) return 0;
    let deleted = 0;
    try {
      for (const pattern of ['mcp:docs:url:*', 'mcp:docs:search:*']) {
        let cursor = '0';
        do {
          const result = await this.redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
          cursor = String(result.cursor);
          if (result.keys.length > 0) {
            await this.redis.del(result.keys);
            deleted += result.keys.length;
          }
        } while (cursor !== '0');
      }
    } catch (err) {
      logger.error({ err }, 'Cache clear error');
    }
    return deleted;
  }
}
