/**
 * Thin Notion REST client for selective import (#1462 / #1459).
 *
 * Version is pinned to `2022-06-28` so search still returns `database`
 * objects (the product language of "databases stay in Notion"). The 2025-09-03
 * split into `data_source` is out of v1.
 *
 * There is deliberately no `queryDatabase` / data-source query: child B
 * must not invent row-pages by querying a database.
 *
 * Rate limiting and retries belong to this client, not its callers: it paces
 * request *starts* against Notion's 3 req/s average and climbs its own retry
 * ladder. Callers keep their own `pLimit` concurrency (#1553).
 *
 * Tests bind `baseUrl` to a local fake server. Production talks only to
 * `https://api.notion.com`.
 */
import { request } from 'undici';
import { addAllowedBaseUrl, validateUrl } from '../../../core/utils/ssrf-guard.js';
import { logger } from '../../../core/utils/logger.js';
import { createTlsDispatcher } from '../../../core/utils/tls-config.js';

export const DEFAULT_NOTION_API_BASE_URL = 'https://api.notion.com';
/** Notion-Version header. See module doc. */
export const NOTION_VERSION = '2022-06-28';
/**
 * Notion request-limits: retry 429/529 (and idempotent 5xx) this many
 * times including the first attempt.
 * @see https://developers.notion.com/reference/request-limits
 */
export const NOTION_RATE_LIMIT_MAX_ATTEMPTS = 6;
/** ~3 requests/second — Notion's documented per-connection average. */
const NOTION_MIN_INTERVAL_MS = 334;
/** First backoff step when a retryable response carries no `Retry-After`. */
export const NOTION_BACKOFF_BASE_MS = 1000;
/**
 * Ceiling on a single backoff, `Retry-After` included. Notion sends small
 * values, but this sleep sits outside `AbortSignal.timeout`, so one absurd
 * header would otherwise park a whole import past every request timeout.
 */
export const NOTION_MAX_BACKOFF_MS = 60_000;
/** Spreads concurrent lanes that came off the same 429. */
const NOTION_RETRY_JITTER_MS = 250;
const NOTION_RETRY_STATUSES = new Set([429, 529]);
const NOTION_IDEMPOTENT_RETRY_STATUSES = new Set([500, 502, 503, 504]);
/**
 * POST endpoints that only read. This client issues no writes at all, and a
 * transient 5xx midway through a paginated search or database walk is exactly
 * the failure the ladder exists for. A future write POST must stay out.
 */
const NOTION_IDEMPOTENT_POST_PATHS = [/^\/v1\/search$/, /^\/v1\/databases\/[^/]+\/query$/];

const notionDispatcher = createTlsDispatcher();

let testBaseUrl: string | null = null;

/** Test-only. Production always uses {@link DEFAULT_NOTION_API_BASE_URL}. */
export function setNotionApiBaseUrlForTests(url: string | null): void {
  testBaseUrl = url;
}

export function resolveNotionApiBaseUrl(): string {
  return (testBaseUrl ?? DEFAULT_NOTION_API_BASE_URL).replace(/\/+$/, '');
}

export interface NotionListResponse<T> {
  object: 'list';
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface NotionBotUser {
  id: string;
  name: string | null;
  type: string;
  workspaceName: string | null;
}

export type NotionSearchFilter = {
  property: 'object';
  value: 'page' | 'database' | 'data_source';
};

export interface NotionSearchParams {
  query?: string;
  startCursor?: string;
  pageSize?: number;
  filter?: NotionSearchFilter;
}

export class NotionError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'NotionError';
  }
}

function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' ? raw : undefined;
}

/** Notion `Retry-After` is an integer number of seconds. */
function parseRetryAfterMs(header: string | undefined): number | undefined {
  if (header == null || header === '') return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}

function isIdempotent(method: string, path: string): boolean {
  if (method === 'GET' || method === 'DELETE') return true;
  if (method !== 'POST') return false;
  const routePath = path.split('?')[0]!;
  return NOTION_IDEMPOTENT_POST_PATHS.some((pattern) => pattern.test(routePath));
}

function isRetryableStatus(status: number, method: string, path: string): boolean {
  if (NOTION_RETRY_STATUSES.has(status)) return true;
  return isIdempotent(method, path) && NOTION_IDEMPOTENT_RETRY_STATUSES.has(status);
}

/**
 * `Retry-After` when the server sent one, else exponential backoff. Always
 * jittered, never shorter than one pacing slot (a proxy answering
 * `Retry-After: 0` must not turn the ladder into a hot loop) and always
 * capped at {@link NOTION_MAX_BACKOFF_MS}.
 */
export function computeNotionRetryDelayMs(
  attempt: number,
  retryAfterHeader: string | undefined,
  options: { baseMs?: number; floorMs?: number } = {},
): number {
  const baseMs = options.baseMs ?? NOTION_BACKOFF_BASE_MS;
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  const wanted = retryAfterMs ?? baseMs * 2 ** attempt;
  const floored = Math.max(wanted, options.floorMs ?? 0);
  return Math.min(floored + Math.random() * NOTION_RETRY_JITTER_MS, NOTION_MAX_BACKOFF_MS);
}

/** A retryable failure. Anything an attempt throws instead is final. */
interface NotionRetrySignal {
  error: NotionError;
  retryAfter: string | undefined;
  /** Redacted response excerpt, logged only if the ladder is exhausted. */
  body?: string;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Walk cursor pagination until `has_more` is false. Caps pages so a
 * stuck cursor cannot loop forever. Used by later import PRs.
 */
export async function paginateAll<T>(
  fetchPage: (cursor: string | null) => Promise<NotionListResponse<T>>,
  options: { maxPages?: number } = {},
): Promise<T[]> {
  const maxPages = options.maxPages ?? 1000;
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const batch: NotionListResponse<T> = await fetchPage(cursor);
    items.push(...batch.results);
    if (!batch.has_more || !batch.next_cursor || batch.results.length === 0) break;
    cursor = batch.next_cursor;
  }
  return items;
}

export class NotionClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private nextSlotAt = 0;

  constructor(token: string, options: { baseUrl?: string; minIntervalMs?: number } = {}) {
    this.token = token;
    this.baseUrl = (options.baseUrl ?? resolveNotionApiBaseUrl()).replace(/\/+$/, '');
    addAllowedBaseUrl(this.baseUrl);
    this.minIntervalMs = options.minIntervalMs ?? (
      this.baseUrl === DEFAULT_NOTION_API_BASE_URL ? NOTION_MIN_INTERVAL_MS : 0
    );
  }

  /**
   * Reserve the next start slot. This paces *starts*, and the reservation is
   * synchronous — taken before any `await` — so concurrent callers each get
   * their own slot and the tree's / importer's `pLimit(5)` still overlaps.
   * Never serialize on completion instead: that caps the client at
   * 1/(interval + latency) rather than 1/interval and makes every caller-side
   * `pLimit` inert.
   */
  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = start + this.minIntervalMs;
    await sleep(start - now);
  }

  /**
   * Run `attempt` up to {@link NOTION_RATE_LIMIT_MAX_ATTEMPTS} times. It
   * returns `{ value }` on success or a {@link NotionRetrySignal}; anything it
   * throws is final. `paced` is false for URLs outside Notion's request
   * budget, which must neither take a slot nor push one.
   */
  private async withRetry<T>(
    logContext: Record<string, string>,
    paced: boolean,
    attempt: (index: number) => Promise<{ value: T } | NotionRetrySignal>,
  ): Promise<T> {
    for (let index = 0; ; index++) {
      if (paced) await this.waitForSlot();
      const outcome = await attempt(index);
      if ('value' in outcome) return outcome.value;
      if (index === NOTION_RATE_LIMIT_MAX_ATTEMPTS - 1) {
        logger.warn(
          { statusCode: outcome.error.statusCode, ...logContext, body: outcome.body },
          'Notion API error',
        );
        throw outcome.error;
      }
      const delayMs = computeNotionRetryDelayMs(index, outcome.retryAfter, {
        floorMs: this.minIntervalMs,
      });
      // Raise, never lower: sibling lanes hold later reservations already, and
      // a 429 is integration-wide, so it has to push all of them out.
      if (paced) this.nextSlotAt = Math.max(this.nextSlotAt, Date.now() + delayMs);
      logger.warn(
        { statusCode: outcome.error.statusCode, ...logContext, attempt: index + 1, delayMs: Math.round(delayMs) },
        'Notion API transient error, retrying',
      );
      await sleep(delayMs);
    }
  }

  private async fetchJson<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    validateUrl(url);

    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      'Notion-Version': NOTION_VERSION,
    };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const body = init.body !== undefined ? JSON.stringify(init.body) : undefined;

    return this.withRetry<T>({ path }, true, async () => {
      const { statusCode, headers: resHeaders, body: responseBody } = await request(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(30_000),
        dispatcher: notionDispatcher,
      });

      const text = await responseBody.text();
      const safeExcerpt = redact(text.slice(0, 500), this.token);

      if (statusCode === 401) {
        throw new NotionError('Invalid Notion token', 401);
      }
      if (statusCode === 403) {
        throw new NotionError('Notion access denied', 403);
      }
      if (statusCode === 404) {
        throw new NotionError('Notion resource not found', 404);
      }
      // GET /v1/pages/:id on a database is 400 validation_error, not 404.
      // classifySelection / tree parent lookup fall back to getDatabase.
      if (statusCode === 400 && method === 'GET' && path.startsWith('/v1/pages/')) {
        throw new NotionError(`Notion API error: HTTP ${statusCode}`, 400);
      }
      if (statusCode >= 400) {
        const error = new NotionError(`Notion API error: HTTP ${statusCode}`, statusCode);
        if (!isRetryableStatus(statusCode, method, path)) {
          logger.warn({ statusCode, path, body: safeExcerpt }, 'Notion API error');
          throw error;
        }
        return { error, retryAfter: headerValue(resHeaders, 'retry-after'), body: safeExcerpt };
      }

      if (text.trim() === '') {
        return { value: undefined as T };
      }

      try {
        return { value: JSON.parse(text) as T };
      } catch {
        logger.warn({ statusCode, path, body: safeExcerpt }, 'Notion API returned non-JSON');
        throw new NotionError(`Notion API returned non-JSON response (HTTP ${statusCode})`, statusCode);
      }
    });
  }

  async probe(): Promise<NotionBotUser> {
    const raw = await this.fetchJson<{
      id?: string;
      name?: string | null;
      type?: string;
      bot?: { workspace_name?: string | null };
    }>('/v1/users/me');
    return {
      id: raw.id ?? '',
      name: raw.name ?? null,
      type: raw.type ?? 'bot',
      workspaceName: raw.bot?.workspace_name ?? null,
    };
  }

  async search(params: NotionSearchParams = {}): Promise<NotionListResponse<Record<string, unknown>>> {
    const body: Record<string, unknown> = {};
    if (params.query !== undefined) body.query = params.query;
    if (params.startCursor !== undefined) body.start_cursor = params.startCursor;
    if (params.pageSize !== undefined) body.page_size = params.pageSize;
    if (params.filter !== undefined) body.filter = params.filter;
    return this.fetchJson('/v1/search', { method: 'POST', body });
  }

  async searchAll(params: Omit<NotionSearchParams, 'startCursor'> = {}): Promise<Array<Record<string, unknown>>> {
    return paginateAll((cursor) =>
      this.search({ pageSize: 100, ...params, startCursor: cursor ?? undefined }),
    );
  }

  async getPage(pageId: string): Promise<Record<string, unknown>> {
    return this.fetchJson(`/v1/pages/${encodeURIComponent(pageId)}`);
  }

  async getDatabase(databaseId: string): Promise<Record<string, unknown>> {
    return this.fetchJson(`/v1/databases/${encodeURIComponent(databaseId)}`);
  }

  async queryDatabase(
    databaseId: string,
    params: { startCursor?: string; pageSize?: number } = {},
  ): Promise<NotionListResponse<Record<string, unknown>>> {
    const body: Record<string, unknown> = {};
    if (params.startCursor !== undefined) body.start_cursor = params.startCursor;
    if (params.pageSize !== undefined) body.page_size = params.pageSize;
    return this.fetchJson(`/v1/databases/${encodeURIComponent(databaseId)}/query`, {
      method: 'POST',
      body,
    });
  }

  /**
   * Every row page of a database. Valid on the pinned `2022-06-28`
   * Notion-Version — this endpoint is deprecated only for `2025-09-03` and
   * later, where data sources replace it.
   */
  async queryDatabaseAll(databaseId: string): Promise<Array<Record<string, unknown>>> {
    return paginateAll((cursor) =>
      this.queryDatabase(databaseId, { startCursor: cursor ?? undefined, pageSize: 100 }),
    );
  }

  async getBlock(blockId: string): Promise<Record<string, unknown>> {
    return this.fetchJson(`/v1/blocks/${encodeURIComponent(blockId)}`);
  }

  async getBlockChildren(
    blockId: string,
    params: { startCursor?: string; pageSize?: number } = {},
  ): Promise<NotionListResponse<Record<string, unknown>>> {
    const qs = new URLSearchParams();
    if (params.pageSize !== undefined) qs.set('page_size', String(params.pageSize));
    if (params.startCursor !== undefined) qs.set('start_cursor', params.startCursor);
    const query = qs.toString();
    const suffix = query ? `?${query}` : '';
    return this.fetchJson(`/v1/blocks/${encodeURIComponent(blockId)}/children${suffix}`);
  }

  async getAllBlockChildren(blockId: string): Promise<Array<Record<string, unknown>>> {
    return paginateAll((cursor) =>
      this.getBlockChildren(blockId, { startCursor: cursor ?? undefined, pageSize: 100 }),
    );
  }

  /**
   * Download attachment bytes. Auth is sent only when the URL is on this
   * client's Notion API origin (fake server files, Notion-hosted media);
   * external file URLs are fetched without the secret and, because
   * Notion-hosted media lives on S3 rather than the API, without a pacing
   * slot — they are not part of the integration's 3 req/s budget.
   */
  async fetchMedia(url: string): Promise<{ bytes: Buffer; contentType: string }> {
    validateUrl(url);
    const onNotionApi = url.startsWith(`${this.baseUrl}/`) || url === this.baseUrl;
    const headers: Record<string, string> = { Accept: '*/*' };
    if (onNotionApi) {
      headers.Authorization = `Bearer ${this.token}`;
      headers['Notion-Version'] = NOTION_VERSION;
    }

    return this.withRetry<{ bytes: Buffer; contentType: string }>(
      { url: redact(url, this.token) },
      onNotionApi,
      async () => {
        const { statusCode, headers: resHeaders, body } = await request(url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(30_000),
          dispatcher: notionDispatcher,
        });
        const bytes = Buffer.from(await body.arrayBuffer());
        if (statusCode < 400) {
          const rawType = resHeaders['content-type'];
          const contentType =
            typeof rawType === 'string' ? rawType.split(';')[0]!.trim() : 'application/octet-stream';
          return { value: { bytes, contentType } };
        }
        const error = new NotionError(`Notion API error: HTTP ${statusCode}`, statusCode);
        if (!isRetryableStatus(statusCode, 'GET', url)) throw error;
        return { error, retryAfter: headerValue(resHeaders, 'retry-after') };
      },
    );
  }
}
