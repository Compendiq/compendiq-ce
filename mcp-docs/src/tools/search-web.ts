/**
 * search_web MCP tool: web search via SearXNG (self-hosted, no API key).
 * Only sends short keyword queries — no article content (data leakage prevention).
 */

import type { RedisClientType } from 'redis';
import { sanitizeSearchQuery } from '../security/query-sanitizer.js';
import { logOutboundRequest } from '../security/audit-logger.js';
import { DocsCache, type CachedSearch } from '../cache/redis-cache.js';
import { logger } from '../logger.js';

const SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 10;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function searchWeb(
  query: string,
  redis: RedisClientType | null,
  options: { numResults?: number; userId?: string; searxngUrl?: string } = {},
): Promise<SearchResult[]> {
  // 1. Sanitize query (data leakage prevention layer 4)
  const sanitized = sanitizeSearchQuery(query);
  const numResults = Math.min(options.numResults ?? DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const searxngUrl = options.searxngUrl ?? process.env.SEARXNG_URL ?? 'http://searxng:8080';

  // 2. Check cache
  const cache = new DocsCache(redis);
  const cached = await cache.getCachedSearch(sanitized);
  if (cached) {
    logOutboundRequest({
      tool: 'search_web', query: sanitized, userId: options.userId,
      cached: true, timestamp: new Date().toISOString(),
    });
    return cached.results.slice(0, numResults);
  }

  // 3. Call SearXNG JSON API — GET only
  const searchUrl = new URL('/search', searxngUrl);
  searchUrl.searchParams.set('q', sanitized);
  searchUrl.searchParams.set('format', 'json');
  searchUrl.searchParams.set('categories', 'general');

  let results: SearchResult[] = [];

  try {
    const response = await fetch(searchUrl.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`SearXNG returned ${response.status}`);
    }

    const data = await response.json() as {
      results: Array<{ title: string; url: string; content: string }>;
    };

    results = (data.results ?? []).slice(0, numResults).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.content ?? '',
    }));
  } catch (err) {
    logger.warn({ err, query: sanitized }, 'SearXNG search failed');
    // Return empty results rather than failing the tool call
    results = [];
  }

  // 4. Cache results
  await cache.setCachedSearch(sanitized, {
    results, query: sanitized, fetchedAt: new Date().toISOString(),
  });

  // 5. Audit log
  logOutboundRequest({
    tool: 'search_web', query: sanitized, userId: options.userId,
    cached: false, contentLength: results.length,
    timestamp: new Date().toISOString(),
  });

  return results;
}
