/**
 * Redis cache for fetched documentation and search results.
 */

import { createHash } from 'node:crypto';
import type { RedisClientType } from 'redis';
import { logger } from '../logger.js';

/**
 * Most markdown characters one document entry stores (#1770). It equals
 * fetch_url's ABSOLUTE_MAX_LENGTH — change the two together: no call can
 * return more, so the stored prefix answers every first page, while a download
 * of up to 5 MiB can no longer become a Redis value of that size. The instance
 * is shared with the BullMQ queues and runs `noeviction` (#658).
 */
const CACHE_MAX_CHARS = 100_000;

export interface CachedDoc {
  /** The first `storedLength` characters of the converted document. */
  markdown: string;
  title: string;
  url: string;
  fetchedAt: string;
  /** Length of the whole converted document; exceeds `markdown.length` when the entry is bounded. */
  contentLength: number;
  /** Characters held in `markdown`. Entries written before #1770 lack it and hold the whole document. */
  storedLength?: number;
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

/**
 * Versioned namespace: v2 keyed query + width, v3 adds the SearXNG categories
 * (#1769). A v2 entry would answer the same query and width for any category
 * list, so v2 keys are never read; they expire on their own TTL (never flush
 * shared Redis). `categories` cannot contain ':' (tool schema), so the three
 * parts stay unambiguous.
 */
function searchCacheKey(query: string, numResults: number, categories: string): string {
  const hash = createHash('sha256')
    .update(`${query.toLowerCase()}:${numResults}:${categories}`)
    .digest('hex')
    .slice(0, 16);
  return `mcp:docs:search:v3:${hash}`;
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

  /** Stores at most the first CACHE_MAX_CHARS characters of `doc.markdown` and records how many as `storedLength`. */
  async setCachedDoc(url: string, doc: CachedDoc): Promise<void> {
    if (!this.redis) return;
    const markdown = doc.markdown.slice(0, CACHE_MAX_CHARS);
    const entry: CachedDoc = { ...doc, markdown, storedLength: markdown.length };
    try {
      await this.redis.setEx(urlCacheKey(url), this.docTtl, JSON.stringify(entry));
    } catch (err) {
      logger.error({ err }, 'Cache set error');
    }
  }

  async getCachedSearch(query: string, numResults: number, categories: string): Promise<CachedSearch | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(searchCacheKey(query, numResults, categories));
      return raw ? (JSON.parse(raw) as CachedSearch) : null;
    } catch (err) {
      logger.error({ err }, 'Cache get error');
      return null;
    }
  }

  async setCachedSearch(
    query: string,
    numResults: number,
    categories: string,
    data: CachedSearch,
  ): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.setEx(
        searchCacheKey(query, numResults, categories),
        this.searchTtl,
        JSON.stringify(data),
      );
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
          if (!raw) continue;
          // Skip a single corrupted entry rather than letting it abort the whole
          // scan (the outer catch would otherwise truncate the list).
          let doc: CachedDoc;
          try {
            doc = JSON.parse(raw) as CachedDoc;
          } catch (err) {
            logger.warn({ err, key }, 'Skipping corrupted cache entry');
            continue;
          }
          if (!filter || doc.url.includes(filter) || doc.title.toLowerCase().includes(filter.toLowerCase())) {
            docs.push(doc);
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
