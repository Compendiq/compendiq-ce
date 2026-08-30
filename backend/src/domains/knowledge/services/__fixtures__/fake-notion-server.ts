/**
 * Local Notion REST stand-in for Vitest. Production code never imports this
 * module; tests bind `NotionClient` to `baseUrl` so nothing talks to
 * api.notion.com (#1462).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

export interface FakeNotionRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  notionVersion: string | undefined;
  body: string;
}

export interface FakeNotionState {
  validToken: string;
  me?: Record<string, unknown>;
  /** Concatenated search results; served in `pageSize` slices. */
  searchResults?: Array<Record<string, unknown>>;
  pages?: Record<string, Record<string, unknown>>;
  databases?: Record<string, Record<string, unknown>>;
  blockChildren?: Record<string, Array<Record<string, unknown>>>;
  /** GET /v1/blocks/:id (parent-chain lookup). */
  blocks?: Record<string, Record<string, unknown>>;
  /** Status to return for GET /v1/blocks/:id instead of the block object. */
  blockErrors?: Record<string, number>;
  /** Status to return for GET /v1/pages/:id instead of the page object. */
  pageErrors?: Record<string, number>;
  /** Status to return for GET /v1/blocks/:id/children instead of a list. */
  blockChildrenErrors?: Record<string, number>;
  /**
   * Row pages served from `POST /v1/databases/:id/query`. The importer reads
   * these when a database is imported as a table or as row pages, and when it
   * enumerates an inline `child_database`.
   */
  databaseQueryResults?: Record<string, Array<Record<string, unknown>>>;
  /** Status to return for the query endpoint instead of a row list. */
  databaseQueryErrors?: Record<string, number>;
  /** GET paths (e.g. `/files/img.png`) served as attachment bytes. */
  files?: Record<string, { contentType: string; body: Buffer | string }>;
  /** Pause GET page/database/block lookups so tests can observe in-flight concurrency. */
  lookupDelayMs?: number;
  beforeFileResponse?: (path: string) => Promise<void>;
  /**
   * Consume-once failures applied after auth, before routing. Used to
   * exercise Notion 429/529 retries without permanently breaking the
   * resource.
   */
  transientFailures?: Array<{ status: number; retryAfter?: string }>;
}

export interface FakeNotionServer {
  baseUrl: string;
  requests: FakeNotionRequest[];
  state: FakeNotionState;
  peakConcurrentLookups: number;
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(
  res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (b: string) => void },
  status: number,
  payload: unknown,
  extraHeaders?: Record<string, string>,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  const retryable = status === 429 || status === 529 || status === 500 || status === 502 || status === 503 || status === 504;
  if (retryable) {
    res.setHeader('Retry-After', extraHeaders?.['Retry-After'] ?? '0');
  }
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (key === 'Retry-After' && retryable) continue;
      res.setHeader(key, value);
    }
  }
  res.end(JSON.stringify(payload));
}

function unauthorized() {
  return {
    object: 'error',
    status: 401,
    code: 'unauthorized',
    message: 'API token is invalid.',
  };
}

export async function startFakeNotionServer(state: FakeNotionState): Promise<FakeNotionServer> {
  const requests: FakeNotionRequest[] = [];
  const lookupStats = { inFlight: 0, peak: 0 };

  async function runLookup<T>(fn: () => T | Promise<T>): Promise<T> {
    lookupStats.inFlight += 1;
    if (lookupStats.inFlight > lookupStats.peak) lookupStats.peak = lookupStats.inFlight;
    try {
      if (state.lookupDelayMs) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, state.lookupDelayMs);
        });
      }
      return await fn();
    } finally {
      lookupStats.inFlight -= 1;
    }
  }
  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? '/';
    const method = (req.method ?? 'GET').toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? '' : await readBody(req);
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    const notionVersion = typeof req.headers['notion-version'] === 'string' ? req.headers['notion-version'] : undefined;

    requests.push({ method, url, authorization, notionVersion, body });

    if (authorization !== `Bearer ${state.validToken}`) {
      send(res, 401, unauthorized());
      return;
    }

    const transient = state.transientFailures?.shift();
    if (transient) {
      const status = transient.status;
      send(
        res,
        status,
        {
          object: 'error',
          status,
          code: status === 529 ? 'service_overload' : status >= 500 ? 'internal_server_error' : 'rate_limited',
          message: 'upstream',
        },
        transient.retryAfter !== undefined ? { 'Retry-After': transient.retryAfter } : undefined,
      );
      return;
    }

    const parsed = new URL(url, 'http://127.0.0.1');
    const path = parsed.pathname.replace(/\/+$/, '') || '/';

    if (method === 'GET' && path === '/v1/users/me') {
      send(res, 200, state.me ?? {
        object: 'user',
        id: 'bot-user-id',
        name: 'Compendiq Import',
        avatar_url: null,
        type: 'bot',
        bot: {
          owner: { type: 'workspace', workspace: true },
          workspace_name: 'Acme Wiki',
          workspace_id: 'ws-1',
          workspace_limits: { max_file_upload_size_in_bytes: 5_000_000 },
        },
      });
      return;
    }

    if (method === 'POST' && path === '/v1/search') {
      let payload: { start_cursor?: string; page_size?: number } = {};
      try {
        payload = body ? JSON.parse(body) as { start_cursor?: string; page_size?: number } : {};
      } catch {
        send(res, 400, { object: 'error', status: 400, code: 'invalid_json', message: 'Invalid JSON' });
        return;
      }
      const all = state.searchResults ?? [];
      const pageSize = Math.min(Math.max(payload.page_size ?? 100, 1), 100);
      const start = payload.start_cursor ? Number.parseInt(payload.start_cursor, 10) : 0;
      const slice = all.slice(start, start + pageSize);
      const next = start + slice.length;
      const hasMore = next < all.length;
      send(res, 200, {
        object: 'list',
        type: 'page_or_database',
        page_or_database: {},
        results: slice,
        next_cursor: hasMore ? String(next) : null,
        has_more: hasMore,
      });
      return;
    }

    const pageMatch = /^\/v1\/pages\/([^/]+)$/.exec(path);
    if (method === 'GET' && pageMatch) {
      await runLookup(() => {
        const errorStatus = state.pageErrors?.[pageMatch[1]!];
        if (errorStatus) {
          send(res, errorStatus, {
            object: 'error',
            status: errorStatus,
            code: errorStatus >= 500 ? 'internal_server_error' : 'rate_limited',
            message: 'upstream',
          });
          return;
        }
        const page = state.pages?.[pageMatch[1]!];
        if (!page) {
          send(res, 404, { object: 'error', status: 404, code: 'object_not_found', message: 'Not found' });
          return;
        }
        send(res, 200, page);
      });
      return;
    }

    const dbQueryMatch = /^\/v1\/databases\/([^/]+)\/query$/.exec(path);
    if (method === 'POST' && dbQueryMatch) {
      const dbId = dbQueryMatch[1]!;
      const errorStatus = state.databaseQueryErrors?.[dbId];
      if (errorStatus) {
        send(res, errorStatus, {
          object: 'error',
          status: errorStatus,
          code: errorStatus >= 500 ? 'internal_server_error' : 'rate_limited',
          message: 'upstream',
        });
        return;
      }
      let payload: { start_cursor?: string; page_size?: number } = {};
      try {
        payload = body ? JSON.parse(body) as { start_cursor?: string; page_size?: number } : {};
      } catch {
        send(res, 400, { object: 'error', status: 400, code: 'invalid_json', message: 'Invalid JSON' });
        return;
      }
      const all = state.databaseQueryResults?.[dbId] ?? [];
      const pageSize = Math.min(Math.max(payload.page_size ?? 100, 1), 100);
      const start = payload.start_cursor ? Number.parseInt(payload.start_cursor, 10) : 0;
      const slice = all.slice(start, start + pageSize);
      const next = start + slice.length;
      const hasMore = next < all.length;
      send(res, 200, {
        object: 'list',
        results: slice,
        next_cursor: hasMore ? String(next) : null,
        has_more: hasMore,
      });
      return;
    }

    const dbMatch = /^\/v1\/databases\/([^/]+)$/.exec(path);
    if (method === 'GET' && dbMatch) {
      await runLookup(() => {
        const db = state.databases?.[dbMatch[1]!];
        if (!db) {
          send(res, 404, { object: 'error', status: 404, code: 'object_not_found', message: 'Not found' });
          return;
        }
        send(res, 200, db);
      });
      return;
    }

    const blocksMatch = /^\/v1\/blocks\/([^/]+)\/children$/.exec(path);
    if (method === 'GET' && blocksMatch) {
      const errorStatus = state.blockChildrenErrors?.[blocksMatch[1]!];
      if (errorStatus) {
        send(res, errorStatus, {
          object: 'error',
          status: errorStatus,
          code: errorStatus >= 500 ? 'internal_server_error' : 'rate_limited',
          message: 'upstream',
        });
        return;
      }
      const all = state.blockChildren?.[blocksMatch[1]!] ?? [];
      const pageSize = Math.min(Number.parseInt(parsed.searchParams.get('page_size') ?? '100', 10) || 100, 100);
      const start = parsed.searchParams.get('start_cursor')
        ? Number.parseInt(parsed.searchParams.get('start_cursor')!, 10)
        : 0;
      const slice = all.slice(start, start + pageSize);
      const next = start + slice.length;
      const hasMore = next < all.length;
      send(res, 200, {
        object: 'list',
        type: 'block',
        block: {},
        results: slice,
        next_cursor: hasMore ? String(next) : null,
        has_more: hasMore,
      });
      return;
    }

    const blockMatch = /^\/v1\/blocks\/([^/]+)$/.exec(path);
    if (method === 'GET' && blockMatch) {
      await runLookup(() => {
        const errorStatus = state.blockErrors?.[blockMatch[1]!];
        if (errorStatus) {
          send(res, errorStatus, {
            object: 'error',
            status: errorStatus,
            code: errorStatus >= 500 ? 'internal_server_error' : 'rate_limited',
            message: 'upstream',
          });
          return;
        }
        const block = state.blocks?.[blockMatch[1]!];
        if (!block) {
          send(res, 404, { object: 'error', status: 404, code: 'object_not_found', message: 'Not found' });
          return;
        }
        send(res, 200, block);
      });
      return;
    }

    const file = state.files?.[path] ?? state.files?.[url.split('?')[0] ?? path];
    if (method === 'GET' && file) {
      await state.beforeFileResponse?.(path);
      const bytes = typeof file.body === 'string' ? Buffer.from(file.body) : file.body;
      res.statusCode = 200;
      res.setHeader('Content-Type', file.contentType);
      res.end(bytes);
      return;
    }

    send(res, 404, { object: 'error', status: 404, code: 'object_not_found', message: 'Not found' });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    requests,
    state,
    get peakConcurrentLookups() {
      return lookupStats.peak;
    },
    close: () =>
      new Promise((resolve, reject) => {
        // Undici keep-alive holds pooled sockets; `close()` alone waits on
        // them (openai-compatible-client.test.ts). Drop them first.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
