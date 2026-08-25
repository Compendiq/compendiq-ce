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
  /** Status to return for GET /v1/blocks/:id/children instead of a list. */
  blockChildrenErrors?: Record<string, number>;
  /**
   * Rows returned ONLY if a caller POSTs `/v1/databases/:id/query`.
   * Child B must never hit this — row-pages are search page objects or they stay skipped.
   */
  databaseQueryResults?: Record<string, Array<Record<string, unknown>>>;
}

export interface FakeNotionServer {
  baseUrl: string;
  requests: FakeNotionRequest[];
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

function send(res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (b: string) => void }, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
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
      const page = state.pages?.[pageMatch[1]!];
      if (!page) {
        send(res, 404, { object: 'error', status: 404, code: 'object_not_found', message: 'Not found' });
        return;
      }
      send(res, 200, page);
      return;
    }

    const dbQueryMatch = /^\/v1\/databases\/([^/]+)\/query$/.exec(path);
    if (method === 'POST' && dbQueryMatch) {
      const dbId = dbQueryMatch[1]!;
      send(res, 200, {
        object: 'list',
        results: state.databaseQueryResults?.[dbId] ?? [],
        next_cursor: null,
        has_more: false,
      });
      return;
    }

    const dbMatch = /^\/v1\/databases\/([^/]+)$/.exec(path);
    if (method === 'GET' && dbMatch) {
      const db = state.databases?.[dbMatch[1]!];
      if (!db) {
        send(res, 404, { object: 'error', status: 404, code: 'object_not_found', message: 'Not found' });
        return;
      }
      send(res, 200, db);
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
      const block = state.blocks?.[blockMatch[1]!];
      if (!block) {
        send(res, 404, { object: 'error', status: 404, code: 'object_not_found', message: 'Not found' });
        return;
      }
      send(res, 200, block);
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
    close: () =>
      new Promise((resolve, reject) => {
        // Undici keep-alive holds pooled sockets; `close()` alone waits on
        // them (openai-compatible-client.test.ts). Drop them first.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
