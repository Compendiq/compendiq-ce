import { request } from 'undici';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { unlink } from 'fs/promises';
import { validateUrl } from '../utils/ssrf-guard.js';
import { logger } from '../utils/logger.js';
import { confluenceDispatcher } from '../utils/tls-config.js';

interface ConfluenceSpace {
  key: string;
  name: string;
  type: string;
  status: string;
  homepage?: { id: string; title: string };
}

interface ConfluencePage {
  id: string;
  title: string;
  status: string;
  type: string;
  version: { number: number; when: string; by?: { displayName: string } };
  body?: {
    storage?: { value: string };
  };
  ancestors?: Array<{ id: string; title: string }>;
  metadata?: { labels?: { results: Array<{ name: string }> } };
  _links?: { webui: string };
}

interface ConfluenceAttachment {
  id: string;
  title: string;
  mediaType: string;
  metadata?: { mediaType: string; comment?: string };
  extensions?: { mediaType: string; fileSize: number };
  _links?: { download: string };
  version?: { when: string };
}

interface PaginatedResponse<T> {
  results: T[];
  start: number;
  limit: number;
  size: number;
  _links?: { next?: string };
}

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Base delay in milliseconds before the first retry. Default: 1000 */
  baseDelay?: number;
}

export interface ConfluenceClientOptions {
  /** Retry configuration for transient errors. */
  retry?: RetryOptions;
}

export class ConfluenceClient {
  private baseUrl: string;
  private pat: string;
  private retryOpts: RetryOptions;

  constructor(baseUrl: string, pat: string, options?: ConfluenceClientOptions) {
    // Remove trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.pat = pat;
    this.retryOpts = options?.retry ?? {};
  }

  /**
   * Single-attempt HTTP request to the Confluence REST API.
   * On transient errors (429, 502, 503, 504), throws a ConfluenceError
   * with `retryAfterMs` populated from the Retry-After header when present.
   */
  private async fetchOnce<T>(path: string, options: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
  } = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    // SSRF protection: validate URL before every request
    validateUrl(url);

    const { method = 'GET', body, signal } = options;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.pat}`,
      'Accept': 'application/json',
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const opts: Record<string, unknown> = {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ?? AbortSignal.timeout(30_000),
    };
    if (confluenceDispatcher) {
      opts.dispatcher = confluenceDispatcher;
    }

    const { statusCode, headers: responseHeaders, body: responseBody } = await request(url, opts as Parameters<typeof request>[1]);

    const text = await responseBody.text();

    if (statusCode === 401) {
      throw new ConfluenceError('Invalid or expired PAT', 401);
    }
    if (statusCode === 403) {
      throw new ConfluenceError('Insufficient permissions', 403);
    }
    if (statusCode === 404) {
      throw new ConfluenceError('Resource not found', 404);
    }
    if (statusCode >= 400) {
      logger.error({ statusCode, url, body: text.slice(0, 500) }, 'Confluence API error');
      // Extract Confluence error message from response for actionable diagnostics
      let detail: string;
      try {
        const parsed = JSON.parse(text);
        detail = parsed.message || parsed.reason || '';
      } catch {
        // Response may not be JSON; use raw excerpt
        detail = text.slice(0, 200);
      }
      const suffix = detail ? `: ${detail}` : '';
      const error = new ConfluenceError(`Confluence API error: HTTP ${statusCode}${suffix}`, statusCode);

      // Attach Retry-After delay for 429 responses so the retry wrapper can honour it
      if (statusCode === 429) {
        error.retryAfterMs = parseRetryAfter(responseHeaders['retry-after']);
      }

      throw error;
    }

    return JSON.parse(text) as T;
  }

  /**
   * HTTP request with automatic retry on transient errors.
   * Wraps `fetchOnce` with exponential backoff (max 3 attempts).
   */
  private async fetch<T>(path: string, options: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
  } = {}): Promise<T> {
    return withRetry(() => this.fetchOnce<T>(path, options), this.retryOpts);
  }

  async getSpaces(start = 0, limit = 100): Promise<PaginatedResponse<ConfluenceSpace>> {
    return this.fetch(`/rest/api/space?start=${start}&limit=${limit}&type=global&expand=homepage`);
  }

  async getAllSpaces(): Promise<ConfluenceSpace[]> {
    const spaces: ConfluenceSpace[] = [];
    let start = 0;
    const limit = 100;

    while (true) {
      const response = await this.getSpaces(start, limit);
      spaces.push(...response.results);
      if (response.size < limit || !response._links?.next) break;
      start += limit;
    }

    return spaces;
  }

  async getPages(spaceKey: string, start = 0, limit = 50): Promise<PaginatedResponse<ConfluencePage>> {
    return this.fetch(
      `/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&type=page&start=${start}&limit=${limit}&expand=version,ancestors,metadata.labels`,
    );
  }

  async getPage(id: string): Promise<ConfluencePage> {
    return this.fetch(
      `/rest/api/content/${encodeURIComponent(id)}?expand=body.storage,version,ancestors,metadata.labels`,
    );
  }

  async getPageAttachments(pageId: string): Promise<PaginatedResponse<ConfluenceAttachment>> {
    const limit = 100;
    const allResults: ConfluenceAttachment[] = [];
    let start = 0;

    while (true) {
      const page = await this.fetch<PaginatedResponse<ConfluenceAttachment>>(
        `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment?limit=${limit}&start=${start}`,
      );
      allResults.push(...page.results);
      if (page.results.length < limit) break;
      start += limit;
    }

    return {
      results: allResults,
      start: 0,
      limit,
      size: allResults.length,
    };
  }

  async downloadAttachment(downloadPath: string): Promise<Buffer> {
    return withRetry(() => this.downloadAttachmentOnce(downloadPath), this.retryOpts);
  }

  /**
   * Single-attempt attachment download. Separated from `downloadAttachment`
   * so that `withRetry` can re-execute the full HTTP request on transient failures.
   *
   * Uses a multi-strategy approach: tries the properly encoded URL first,
   * then falls back to the raw URL (preserving Confluence's own encoding),
   * then tries without query parameters. This handles edge cases where
   * Confluence's `_links.download` encoding doesn't round-trip through
   * decode/re-encode, or where version/modificationDate params cause 500s.
   */
  private async downloadAttachmentOnce(downloadPath: string): Promise<Buffer> {
    const urls = buildDownloadUrlCandidates(downloadPath, this.baseUrl);

    let lastError: Error | undefined;
    for (const url of urls) {
      try {
        return await this.fetchAttachmentBuffer(url);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // On 429 (rate-limit), throw immediately — don't try fallback URLs
        if (err instanceof ConfluenceError && err.statusCode === 429) throw err;
        logger.debug(
          { url, error: lastError.message },
          'Attachment download attempt failed, trying next URL strategy',
        );
      }
    }
    throw lastError!;
  }

  /**
   * Low-level HTTP GET that returns the response body as a Buffer.
   * Follows redirects (up to 10 hops) and validates the URL for SSRF.
   */
  private async fetchAttachmentBuffer(url: string): Promise<Buffer> {
    validateUrl(url);

    const opts: Record<string, unknown> = {
      headers: { 'Authorization': `Bearer ${this.pat}` },
      signal: AbortSignal.timeout(60_000),
      maxRedirections: 10,
    };
    if (confluenceDispatcher) {
      opts.dispatcher = confluenceDispatcher;
    }

    const { statusCode, headers: responseHeaders, body } = await request(url, opts as Parameters<typeof request>[1]);

    if (statusCode !== 200) {
      // Drain body to release the socket
      const bodyText = await body.text().catch(() => '');
      const error = new ConfluenceError(
        `Failed to download attachment: HTTP ${statusCode}`,
        statusCode,
      );
      if (statusCode === 429) {
        error.retryAfterMs = parseRetryAfter(responseHeaders['retry-after']);
      }
      if (statusCode >= 500) {
        logger.warn({ url, statusCode, body: bodyText.slice(0, 200) }, 'Confluence returned server error for attachment download');
      }
      throw error;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /**
   * Stream an attachment directly to a file on disk instead of buffering in memory.
   * Enforces a maximum file size to prevent disk exhaustion.
   * Cleans up partial files on error.
   *
   * @param downloadPath - The Confluence download path (e.g. /download/attachments/123/file.pdf)
   * @param outputPath - Local filesystem path to write the file to
   * @param maxSizeBytes - Maximum allowed file size in bytes (default 50 MB)
   */
  async downloadAttachmentToFile(
    downloadPath: string,
    outputPath: string,
    maxSizeBytes = 50 * 1024 * 1024,
  ): Promise<void> {
    const urls = buildDownloadUrlCandidates(downloadPath, this.baseUrl);

    let lastError: Error | undefined;
    for (const url of urls) {
      try {
        return await this.streamAttachmentToFile(url, outputPath, maxSizeBytes);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (err instanceof ConfluenceError && err.statusCode === 429) throw err;
        logger.debug(
          { url, error: lastError.message },
          'Streamed attachment download attempt failed, trying next URL strategy',
        );
      }
    }
    throw lastError!;
  }

  /**
   * Low-level streaming download to file. Follows redirects, validates SSRF,
   * enforces max size, and cleans up partial files on error.
   */
  private async streamAttachmentToFile(
    url: string,
    outputPath: string,
    maxSizeBytes: number,
  ): Promise<void> {
    validateUrl(url);

    const opts: Record<string, unknown> = {
      headers: { 'Authorization': `Bearer ${this.pat}` },
      signal: AbortSignal.timeout(120_000),
      maxRedirections: 10,
    };
    if (confluenceDispatcher) {
      opts.dispatcher = confluenceDispatcher;
    }

    const { statusCode, headers, body } = await request(url, opts as Parameters<typeof request>[1]);

    if (statusCode !== 200) {
      body.destroy();
      throw new ConfluenceError(`Failed to download attachment: HTTP ${statusCode}`, statusCode);
    }

    // Check Content-Length header upfront if available
    const contentLengthHeader = headers['content-length'];
    const contentLength = typeof contentLengthHeader === 'string'
      ? parseInt(contentLengthHeader, 10)
      : 0;
    if (contentLength > maxSizeBytes) {
      body.destroy();
      throw new AttachmentTooLargeError(
        `Attachment too large: ${contentLength} bytes exceeds limit of ${maxSizeBytes} bytes`,
        contentLength,
        maxSizeBytes,
      );
    }

    // Stream to disk with size tracking
    let bytesWritten = 0;
    const writeStream = createWriteStream(outputPath);

    try {
      await pipeline(
        body,
        async function* (source) {
          for await (const chunk of source) {
            bytesWritten += chunk.length;
            if (bytesWritten > maxSizeBytes) {
              throw new AttachmentTooLargeError(
                `Attachment too large: exceeded limit of ${maxSizeBytes} bytes during download`,
                bytesWritten,
                maxSizeBytes,
              );
            }
            yield chunk;
          }
        },
        writeStream,
      );
    } catch (err) {
      // Clean up partial file on any error
      try {
        await unlink(outputPath);
      } catch {
        // File may not exist if write never started
      }
      throw err;
    }

    logger.debug(
      { url, outputPath, bytesWritten },
      'Streamed attachment to file',
    );
  }

  async searchPages(cql: string, start = 0, limit = 50): Promise<PaginatedResponse<ConfluencePage>> {
    return this.fetch(
      `/rest/api/content/search?cql=${encodeURIComponent(cql)}&start=${start}&limit=${limit}&expand=version,ancestors`,
    );
  }

  async findPageByTitle(spaceKey: string | null | undefined, title: string): Promise<ConfluencePage | null> {
    const escapedTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const cql = `${spaceKey ? `space="${spaceKey}" AND ` : ''}type=page AND title="${escapedTitle}"`;
    const response = await this.searchPages(cql, 0, 1);
    return response.results[0] ?? null;
  }

  async getModifiedPages(since: Date, spaceKey: string): Promise<ConfluencePage[]> {
    const dateStr = since.toISOString().split('T')[0];
    const cql = `space="${spaceKey}" AND type=page AND lastmodified>="${dateStr}" ORDER BY lastmodified DESC`;
    const pages: ConfluencePage[] = [];
    let start = 0;
    const limit = 50;

    while (true) {
      const response = await this.searchPages(cql, start, limit);
      pages.push(...response.results);
      if (response.size < limit || !response._links?.next) break;
      start += limit;
    }

    return pages;
  }

  async createPage(spaceKey: string, title: string, body: string, parentId?: string): Promise<ConfluencePage> {
    const data: Record<string, unknown> = {
      type: 'page',
      title,
      space: { key: spaceKey },
      body: {
        storage: { value: body, representation: 'storage' },
      },
    };

    if (parentId) {
      data.ancestors = [{ id: parentId }];
    }

    return this.fetch('/rest/api/content', { method: 'POST', body: data });
  }

  async updatePage(id: string, title: string, body: string, version: number): Promise<ConfluencePage> {
    return this.fetch(`/rest/api/content/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: {
        type: 'page',
        title,
        version: { number: version + 1 },
        body: {
          storage: { value: body, representation: 'storage' },
        },
      },
    });
  }

  async deletePage(id: string): Promise<void> {
    await this.fetch(`/rest/api/content/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async getLabels(pageId: string): Promise<string[]> {
    const response = await this.fetch<{ results: Array<{ name: string }> }>(
      `/rest/api/content/${encodeURIComponent(pageId)}/label`,
    );
    return response.results.map((l) => l.name);
  }

  async addLabels(pageId: string, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    const body = labels.map((name) => ({ prefix: 'global', name }));
    await this.fetch(`/rest/api/content/${encodeURIComponent(pageId)}/label`, {
      method: 'POST',
      body,
    });
  }

  async removeLabel(pageId: string, label: string): Promise<void> {
    await this.fetch(
      `/rest/api/content/${encodeURIComponent(pageId)}/label/${encodeURIComponent(label)}`,
      { method: 'DELETE' },
    );
  }

  async setLabels(pageId: string, desiredLabels: string[]): Promise<void> {
    const currentLabels = await this.getLabels(pageId);
    const currentSet = new Set(currentLabels);
    const desiredSet = new Set(desiredLabels);

    const toAdd = desiredLabels.filter((l) => !currentSet.has(l));
    const toRemove = currentLabels.filter((l) => !desiredSet.has(l));

    // Remove labels that shouldn't be there
    for (const label of toRemove) {
      await this.removeLabel(pageId, label);
    }

    // Add missing labels
    if (toAdd.length > 0) {
      await this.addLabels(pageId, toAdd);
    }
  }

  async getChildPages(parentId: string, start = 0, limit = 50): Promise<PaginatedResponse<ConfluencePage>> {
    return this.fetch(
      `/rest/api/content/${encodeURIComponent(parentId)}/child/page?start=${start}&limit=${limit}&expand=version,ancestors,metadata.labels,body.storage`,
    );
  }

  async getAllChildPages(parentId: string): Promise<ConfluencePage[]> {
    const pages: ConfluencePage[] = [];
    let start = 0;
    const limit = 50;

    while (true) {
      const response = await this.getChildPages(parentId, start, limit);
      pages.push(...response.results);
      if (response.size < limit || !response._links?.next) break;
      start += limit;
    }

    return pages;
  }

  /**
   * Recursively fetch all descendant pages of a given parent page.
   * Returns the flat list of all descendants (not including the parent itself).
   * @param maxPages - Maximum number of descendant pages to return (default 200).
   *                   Prevents runaway traversal on large page trees.
   */
  async getDescendantPages(parentId: string, maxPages = 200): Promise<ConfluencePage[]> {
    const allDescendants: ConfluencePage[] = [];
    const queue: string[] = [parentId];

    while (queue.length > 0) {
      if (allDescendants.length >= maxPages) {
        logger.warn({ parentId, maxPages, collected: allDescendants.length }, 'getDescendantPages hit maxPages limit');
        break;
      }
      const currentId = queue.shift()!;
      const children = await this.getAllChildPages(currentId);
      for (const child of children) {
        allDescendants.push(child);
        if (allDescendants.length >= maxPages) {
          logger.warn({ parentId, maxPages, collected: allDescendants.length }, 'getDescendantPages hit maxPages limit');
          break;
        }
        queue.push(child.id);
      }
    }

    return allDescendants;
  }

  async getAllPagesInSpace(spaceKey: string): Promise<ConfluencePage[]> {
    const pages: ConfluencePage[] = [];
    let start = 0;
    const limit = 50;

    while (true) {
      const response = await this.getPages(spaceKey, start, limit);
      pages.push(...response.results);
      if (response.size < limit || !response._links?.next) break;
      start += limit;
    }

    return pages;
  }
}

/**
 * Parses the HTTP `Retry-After` header value into milliseconds.
 * Supports both delay-seconds (e.g. "5") and HTTP-date formats.
 * Returns `undefined` if the header is missing or unparseable.
 */
export function parseRetryAfter(header: string | string[] | undefined): number | undefined {
  if (header == null) return undefined;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;

  // Try numeric seconds first (most common for 429 responses)
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) {
    // Negative values are invalid per RFC 7231; treat as unparseable
    return seconds >= 0 ? seconds * 1000 : undefined;
  }

  // Try HTTP-date (e.g. "Wed, 21 Oct 2015 07:28:00 GMT")
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    return delayMs > 0 ? delayMs : 0;
  }

  return undefined;
}

/**
 * Build a fully-qualified download URL from a Confluence `_links.download` path.
 *
 * Confluence filenames may contain characters (colons, spaces, brackets, etc.)
 * that are technically valid in URL paths per RFC 3986 but cause Confluence DC
 * to return HTTP 500 when not percent-encoded. `new URL()` alone won't encode
 * colons or other sub-delimiters in paths.
 *
 * This function encodes each path segment with `encodeURIComponent` to handle
 * all special characters. Already percent-encoded segments are decoded first
 * to avoid double-encoding.
 */
export function buildDownloadUrl(downloadPath: string, baseUrl: string): string {
  const qIdx = downloadPath.indexOf('?');
  const pathPart = qIdx >= 0 ? downloadPath.slice(0, qIdx) : downloadPath;
  const queryPart = qIdx >= 0 ? downloadPath.slice(qIdx) : '';

  const encodedPath = pathPart
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      // Decode first to normalise already-encoded segments (%XX → char).
      // Also treat `+` as space: while `+` only means space in
      // application/x-www-form-urlencoded (not in URL paths per RFC 3986),
      // Confluence DC encodes spaces as `+` in some _links.download paths.
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment.replace(/\+/g, ' '));
      } catch {
        decoded = segment;
      }
      return encodeURIComponent(decoded);
    })
    .join('/');

  return `${baseUrl}${encodedPath}${queryPart}`;
}

/**
 * Generate a list of candidate download URLs to try, in priority order.
 *
 * Different Confluence DC versions and configurations may expect different URL
 * encodings. This function returns up to 3 unique URL strategies:
 *
 * 1. **Encoded URL** — fully percent-encoded path segments (handles colons, spaces, etc.)
 * 2. **Raw URL** — `_links.download` path appended as-is to the base URL, preserving
 *    whatever encoding Confluence already applied (e.g. `+` for spaces)
 * 3. **Encoded URL without query params** — some Confluence versions return HTTP 500
 *    when `version` / `modificationDate` query params reference stale metadata;
 *    stripping the query string can work as a last resort
 *
 * Duplicate URLs are removed so we never retry the same URL twice.
 */
export function buildDownloadUrlCandidates(downloadPath: string, baseUrl: string): string[] {
  // Raw URL: preserve Confluence's encoding (e.g. `+` for spaces), only fix literal spaces
  const rawUrl = `${baseUrl}${downloadPath.replace(/ /g, '%20')}`;
  const encodedUrl = buildDownloadUrl(downloadPath, baseUrl);

  const qIdx = downloadPath.indexOf('?');
  const pathOnly = qIdx >= 0 ? downloadPath.slice(0, qIdx) : downloadPath;
  const rawNoQuery = `${baseUrl}${pathOnly.replace(/ /g, '%20')}`;

  // De-duplicate while preserving priority order
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const url of [rawUrl, encodedUrl, rawNoQuery]) {
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

export class ConfluenceError extends Error {
  /** Parsed Retry-After value in milliseconds (present on 429 responses) */
  public retryAfterMs?: number;

  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'ConfluenceError';
  }
}

export class AttachmentTooLargeError extends Error {
  constructor(
    message: string,
    public actualSize: number,
    public maxSize: number,
  ) {
    super(message);
    this.name = 'AttachmentTooLargeError';
  }
}

/** Status codes that indicate a transient server-side or proxy error worth retrying. */
const TRANSIENT_STATUS_CODES = new Set([429, 502, 503, 504]);

/**
 * Determines whether an error is transient and the request should be retried.
 * Returns true for:
 *  - ConfluenceError with status 429, 502, 503, or 504
 *  - Network-level errors (ECONNRESET, ETIMEDOUT, UND_ERR_CONNECT_TIMEOUT)
 * Returns false for client errors (400, 401, 403, 404) and other non-transient failures.
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof ConfluenceError) {
    return TRANSIENT_STATUS_CODES.has(err.statusCode);
  }
  if (err instanceof Error) {
    const msg = err.message;
    return (
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('UND_ERR_CONNECT_TIMEOUT')
    );
  }
  return false;
}

/**
 * Retries an async operation with exponential backoff and jitter.
 *
 * Delay formula: `baseDelay * 2^attempt + random(0..500)ms`
 * For 429 responses with a Retry-After header, the server-specified delay is used instead.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const { maxAttempts = 3, baseDelay = 1000 } = opts ?? {};
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !isTransientError(err)) {
        throw err;
      }

      // Use Retry-After header delay if the server provided one (429 responses)
      let delay: number;
      if (err instanceof ConfluenceError && err.retryAfterMs != null) {
        delay = err.retryAfterMs;
      } else {
        delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
      }

      logger.warn(
        {
          attempt: attempt + 1,
          maxAttempts,
          delayMs: Math.round(delay),
          error: err instanceof Error ? err.message : String(err),
        },
        'Confluence API transient error, retrying',
      );

      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // TypeScript requires a return; this line is unreachable because the last
  // iteration always throws (isLastAttempt === true).
  throw new Error('withRetry: unreachable');
}

export type { ConfluenceSpace, ConfluencePage, ConfluenceAttachment, PaginatedResponse };
