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

  constructor(token: string, options: { baseUrl?: string } = {}) {
    this.token = token;
    this.baseUrl = (options.baseUrl ?? resolveNotionApiBaseUrl()).replace(/\/+$/, '');
    addAllowedBaseUrl(this.baseUrl);
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

    const { statusCode, body: responseBody } = await request(url, {
      method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
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
    if (statusCode >= 400) {
      logger.warn({ statusCode, path, body: safeExcerpt }, 'Notion API error');
      throw new NotionError(`Notion API error: HTTP ${statusCode}`, statusCode);
    }

    if (text.trim() === '') {
      return undefined as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      logger.warn({ statusCode, path, body: safeExcerpt }, 'Notion API returned non-JSON');
      throw new NotionError(`Notion API returned non-JSON response (HTTP ${statusCode})`, statusCode);
    }
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
      this.search({ ...params, startCursor: cursor ?? undefined }),
    );
  }

  async getPage(pageId: string): Promise<Record<string, unknown>> {
    return this.fetchJson(`/v1/pages/${encodeURIComponent(pageId)}`);
  }

  async getDatabase(databaseId: string): Promise<Record<string, unknown>> {
    return this.fetchJson(`/v1/databases/${encodeURIComponent(databaseId)}`);
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
}
