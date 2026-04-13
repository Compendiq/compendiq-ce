/**
 * list_cached MCP tool: lists previously fetched and cached documents.
 */

import type { RedisClientType } from 'redis';
import { DocsCache, type CachedDoc } from '../cache/redis-cache.js';

export interface CachedDocSummary {
  title: string;
  url: string;
  fetchedAt: string;
  contentLength: number;
}

export async function listCached(
  redis: RedisClientType | null,
  filter?: string,
): Promise<CachedDocSummary[]> {
  const cache = new DocsCache(redis);
  const docs = await cache.listCachedDocs(filter);

  return docs.map((d: CachedDoc) => ({
    title: d.title,
    url: d.url,
    fetchedAt: d.fetchedAt,
    contentLength: d.contentLength,
  }));
}
