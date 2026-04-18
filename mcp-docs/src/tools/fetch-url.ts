/**
 * fetch_url MCP tool: fetches a URL, converts HTML to Markdown.
 * GET-only outbound requests — no POST/PUT (data leakage prevention).
 */

import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import type { RedisClientType } from 'redis';
import { validateUrl } from '../security/ssrf-guard.js';
import { getDomainConfig, isDomainAllowed } from '../security/domain-filter.js';
import { logOutboundRequest } from '../security/audit-logger.js';
import { DocsCache, type CachedDoc } from '../cache/redis-cache.js';

const DEFAULT_MAX_LENGTH = 10_000;
const ABSOLUTE_MAX_LENGTH = 100_000;
const FETCH_TIMEOUT_MS = 30_000;
// Hard ceiling on bytes pulled into memory before HTML→Markdown conversion.
// The MCP spec doesn't pin a number; 5 MB matches the request body limit used
// by other Compendiq services and bounds heap usage by an obvious factor.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// Reusable turndown instance
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

// Strip nav, footer, sidebar, ads for cleaner content
turndown.remove(['nav', 'footer', 'aside', 'script', 'style', 'noscript']);

export interface FetchUrlResult {
  markdown: string;
  title: string;
  url: string;
  cached: boolean;
  contentLength: number;
  truncated: boolean;
}

export async function fetchUrl(
  url: string,
  redis: RedisClientType | null,
  options: { maxLength?: number; startIndex?: number; userId?: string; cacheTtl?: number } = {},
): Promise<FetchUrlResult> {
  const maxLength = Math.min(options.maxLength ?? DEFAULT_MAX_LENGTH, ABSOLUTE_MAX_LENGTH);
  const startIndex = options.startIndex ?? 0;

  // 1. Validate URL (SSRF protection)
  const parsed = validateUrl(url);

  // 2. Check domain filter
  const domainConfig = await getDomainConfig(redis);
  if (!isDomainAllowed(parsed.hostname, domainConfig)) {
    throw new Error(`Domain '${parsed.hostname}' is not allowed by the current domain policy`);
  }

  // 3. Check cache
  const cache = new DocsCache(redis, options.cacheTtl);
  const cached = await cache.getCachedDoc(url);
  if (cached) {
    logOutboundRequest({
      tool: 'fetch_url', url, userId: options.userId, cached: true,
      contentLength: cached.contentLength, timestamp: new Date().toISOString(),
    });

    const safeStartIndex = Math.min(Math.max(startIndex, 0), cached.contentLength);
    const endIndex = Math.min(safeStartIndex + maxLength, cached.contentLength);
    const content = cached.markdown.slice(safeStartIndex, endIndex);
    return {
      markdown: content,
      title: cached.title,
      url: cached.url,
      cached: true,
      contentLength: cached.contentLength,
      truncated: endIndex < cached.contentLength,
    };
  }

  // 4. Fetch — GET only, no redirects (SSRF + data leakage prevention)
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      'User-Agent': 'Compendiq-MCP-Docs/1.0',
      'Accept': 'text/html,application/xhtml+xml,text/plain,application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  // Block redirects — an allowed domain could redirect to an internal IP
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') ?? 'unknown';
    logOutboundRequest({
      tool: 'fetch_url', url, userId: options.userId, cached: false,
      statusCode: response.status, timestamp: new Date().toISOString(),
    });
    throw new Error(`Redirect to '${location}' blocked — redirects are not followed for security`);
  }

  if (!response.ok) {
    logOutboundRequest({
      tool: 'fetch_url', url, userId: options.userId, cached: false,
      statusCode: response.status, timestamp: new Date().toISOString(),
    });
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';

  // Bound in-memory body size: a hostile or misconfigured allowed-domain server
  // could otherwise exhaust the heap. Check the declared Content-Length first,
  // then verify the actual byte count once the body has been read.
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      logOutboundRequest({
        tool: 'fetch_url', url, userId: options.userId, cached: false,
        statusCode: response.status, timestamp: new Date().toISOString(),
      });
      throw new Error(`Response too large: ${declaredLength} bytes exceeds ${MAX_RESPONSE_BYTES}`);
    }
  }

  // Stream the body and abort the moment we cross the cap. This bounds peak
  // per-request memory to roughly MAX_RESPONSE_BYTES + one chunk, even when
  // the server omits Content-Length or lies about it (Transfer-Encoding:
  // chunked). reader.cancel() signals upstream to stop sending.
  if (!response.body) {
    throw new Error('Response body is not readable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel('Response too large');
        logOutboundRequest({
          tool: 'fetch_url', url, userId: options.userId, cached: false,
          statusCode: response.status, timestamp: new Date().toISOString(),
        });
        throw new Error(`Response too large: streamed >${MAX_RESPONSE_BYTES} bytes (cap exceeded)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new TextDecoder().decode(Buffer.concat(chunks));

  // 5. Convert to markdown
  let markdown: string;
  let title: string;

  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    const dom = new JSDOM(body, { url });
    const doc = dom.window.document;

    // Extract title
    title = doc.querySelector('title')?.textContent?.trim()
      ?? doc.querySelector('h1')?.textContent?.trim()
      ?? parsed.hostname;

    // Try to extract main content area
    const main = doc.querySelector('main, article, [role="main"], .content, .markdown-body, #content');
    const target = main ?? doc.body;

    markdown = turndown.turndown(target.innerHTML);
  } else {
    // Plain text, JSON, etc — use as-is
    title = parsed.pathname.split('/').pop() ?? parsed.hostname;
    markdown = body;
  }

  const fullLength = markdown.length;

  // 6. Cache the full document
  const docEntry: CachedDoc = {
    markdown, title, url,
    fetchedAt: new Date().toISOString(),
    contentLength: fullLength,
  };
  await cache.setCachedDoc(url, docEntry);

  // 7. Audit log
  logOutboundRequest({
    tool: 'fetch_url', url, userId: options.userId, cached: false,
    statusCode: response.status, contentLength: fullLength,
    timestamp: new Date().toISOString(),
  });

  // 8. Return truncated content
  const safeStartIndex = Math.min(Math.max(startIndex, 0), fullLength);
  const endIndex = Math.min(safeStartIndex + maxLength, fullLength);
  const content = markdown.slice(safeStartIndex, endIndex);
  return {
    markdown: content,
    title,
    url,
    cached: false,
    contentLength: fullLength,
    truncated: endIndex < fullLength,
  };
}
