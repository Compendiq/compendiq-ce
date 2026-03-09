import { request } from 'undici';
import { validateUrl } from '../utils/ssrf-guard.js';
import { logger } from '../utils/logger.js';
import { confluenceDispatcher } from '../utils/tls-config.js';

interface ConfluenceSpace {
  key: string;
  name: string;
  type: string;
  status: string;
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

export class ConfluenceClient {
  private baseUrl: string;
  private pat: string;

  constructor(baseUrl: string, pat: string) {
    // Remove trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.pat = pat;
  }

  private async fetch<T>(path: string, options: {
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

    const { statusCode, body: responseBody } = await request(url, opts as Parameters<typeof request>[1]);

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
      throw new ConfluenceError(`Confluence API error: HTTP ${statusCode}`, statusCode);
    }

    return JSON.parse(text) as T;
  }

  async getSpaces(start = 0, limit = 100): Promise<PaginatedResponse<ConfluenceSpace>> {
    return this.fetch(`/rest/api/space?start=${start}&limit=${limit}&type=global`);
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
    return this.fetch(
      `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment?limit=100`,
    );
  }

  async downloadAttachment(downloadPath: string): Promise<Buffer> {
    const url = `${this.baseUrl}${downloadPath}`;

    // SSRF protection: validate URL before download
    validateUrl(url);

    const opts: Record<string, unknown> = {
      headers: { 'Authorization': `Bearer ${this.pat}` },
      signal: AbortSignal.timeout(60_000),
    };
    if (confluenceDispatcher) {
      opts.dispatcher = confluenceDispatcher;
    }

    const { statusCode, body } = await request(url, opts as Parameters<typeof request>[1]);

    if (statusCode !== 200) {
      throw new ConfluenceError(`Failed to download attachment: HTTP ${statusCode}`, statusCode);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async searchPages(cql: string, start = 0, limit = 50): Promise<PaginatedResponse<ConfluencePage>> {
    return this.fetch(
      `/rest/api/content/search?cql=${encodeURIComponent(cql)}&start=${start}&limit=${limit}&expand=version,ancestors`,
    );
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

export class ConfluenceError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'ConfluenceError';
  }
}

export type { ConfluenceSpace, ConfluencePage, ConfluenceAttachment, PaginatedResponse };
