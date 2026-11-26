/**
 * A loopback Confluence Data Center for route tests.
 *
 * The real `ConfluenceClient` talks to it over HTTP, so a test observes the
 * request the backend actually sent (method, path, bearer token, JSON or
 * multipart body) before it decides how Confluence answers: with a page, with
 * a real error body, or by dropping the connection after the request was read.
 * Reads, page updates and attachment uploads are decided, and can be held,
 * independently of one another.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type ConfluenceOperation = 'read' | 'update' | 'upload';

export interface ConfluenceFixtureRequest {
  operation: ConfluenceOperation;
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
  /** The Confluence content id in the path. */
  contentId: string;
  /** The parsed JSON body of a page update. */
  json: unknown;
  /** The `filename` of an attachment upload's multipart body. */
  filename: string | undefined;
}

/**
 * What Confluence does with a request: an HTTP answer, or `reset`, which reads
 * the whole request and then closes the connection without answering.
 */
export type ConfluenceFixtureReply = { status: number; body: unknown } | 'reset';

/** Decides one request. `undefined` lets the fixture answer as Confluence would. */
export type ConfluenceFixtureHandler = (
  request: ConfluenceFixtureRequest,
) => ConfluenceFixtureReply | undefined | void | Promise<ConfluenceFixtureReply | undefined | void>;

export interface ConfluenceFixturePage {
  id: string;
  title: string;
  version: number;
  storage: string;
}

export interface ConfluenceFixtureGate {
  /** Resolves with the held request once the backend has sent it. */
  arrived: Promise<ConfluenceFixtureRequest>;
  /** Let the held request be answered: as Confluence would, or with `reply`. */
  respond: (reply?: ConfluenceFixtureReply) => void;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export class ConfluenceHttpFixture {
  /** Every request the backend sent since the last `reset`, in arrival order. */
  readonly requests: ConfluenceFixtureRequest[] = [];
  /** Per-operation decisions of the current test. */
  handlers: Partial<Record<ConfluenceOperation, ConfluenceFixtureHandler>> = {};

  private readonly pages = new Map<string, ConfluenceFixturePage>();
  private readonly gates = new Map<ConfluenceOperation, Array<{
    arrived: (request: ConfluenceFixtureRequest) => void;
    reply: Promise<ConfluenceFixtureReply | undefined>;
  }>>();

  private constructor(private readonly server: Server, readonly url: string) {}

  static async start(): Promise<ConfluenceHttpFixture> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const fixture = new ConfluenceHttpFixture(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    server.on('request', (request, response) => {
      void fixture.serve(request, response).catch(() => response.destroy());
    });
    return fixture;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => { this.server.close(() => resolve()); });
  }

  /** Forget pages, requests, handlers and gates of the previous test. A test answers every gate it armed. */
  reset(): void {
    this.pages.clear();
    this.requests.length = 0;
    this.handlers = {};
    this.gates.clear();
  }

  /** The page as Confluence holds it. Mutate it to let someone else edit the page. */
  page(id: string): ConfluenceFixturePage {
    const page = this.pages.get(id);
    if (!page) throw new Error(`The Confluence fixture has no page ${id}`);
    return page;
  }

  addPage(page: ConfluenceFixturePage): void {
    this.pages.set(page.id, { ...page });
  }

  /** The requests of one kind the backend has sent so far. */
  sent(operation: ConfluenceOperation): ConfluenceFixtureRequest[] {
    return this.requests.filter((request) => request.operation === operation);
  }

  /**
   * Hold the next request of this kind after the fixture has read it. Each
   * operation has its own queue of gates, so an upload and a page update are
   * held and released independently.
   */
  gate(operation: ConfluenceOperation): ConfluenceFixtureGate {
    const arrived = deferred<ConfluenceFixtureRequest>();
    const reply = deferred<ConfluenceFixtureReply | undefined>();
    const queue = this.gates.get(operation) ?? [];
    queue.push({ arrived: arrived.resolve, reply: reply.promise });
    this.gates.set(operation, queue);
    return { arrived: arrived.promise, respond: (answer) => reply.resolve(answer) };
  }

  private pageJson(page: ConfluenceFixturePage): Record<string, unknown> {
    return {
      id: page.id,
      type: 'page',
      status: 'current',
      title: page.title,
      version: { number: page.version, when: '2026-11-24T00:00:00.000Z' },
      body: { storage: { value: page.storage, representation: 'storage' } },
      ancestors: [],
      metadata: { labels: { results: [] } },
    };
  }

  /** What Confluence Data Center answers when nothing in the test says otherwise. */
  private defaultReply(request: ConfluenceFixtureRequest): ConfluenceFixtureReply {
    const page = this.pages.get(request.contentId);
    if (!page) return { status: 404, body: { statusCode: 404, message: 'No content found with id' } };
    if (request.operation === 'read') {
      const historical = request.query.get('status') === 'historical';
      if (historical && Number(request.query.get('version')) !== page.version) {
        return { status: 404, body: { statusCode: 404, message: 'No historical version found' } };
      }
      return { status: 200, body: this.pageJson(page) };
    }
    if (request.operation === 'upload') {
      return {
        status: 200,
        body: {
          results: [{
            id: `att-${request.filename}`,
            type: 'attachment',
            status: 'current',
            title: request.filename,
            mediaType: 'image/png',
            version: { number: 1, when: '2026-11-24T00:00:01.000Z' },
          }],
          size: 1,
        },
      };
    }
    const update = request.json as {
      title?: unknown;
      version?: { number?: unknown };
      body?: { storage?: { value?: unknown } };
    } | null;
    const storage = update?.body?.storage?.value;
    if (typeof update?.title !== 'string' || typeof storage !== 'string') {
      return { status: 400, body: { statusCode: 400, message: 'Malformed page update' } };
    }
    if (update.version?.number !== page.version + 1) {
      // The body Confluence Data Center sends for a stale version number.
      return {
        status: 409,
        body: {
          statusCode: 409,
          data: { authorized: false, valid: true, errors: [], successful: false },
          message: `Version must be incremented on update. Current version is: ${page.version}`,
          reason: 'Conflict',
        },
      };
    }
    page.title = update.title;
    page.storage = storage;
    page.version += 1;
    return { status: 200, body: this.pageJson(page) };
  }

  private async serve(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(incoming.url ?? '/', this.url);
    const method = incoming.method ?? 'GET';
    const body = await readBody(incoming);
    const match = /^\/rest\/api\/content\/([^/]+)(\/child\/attachment)?$/.exec(url.pathname);
    const operation: ConfluenceOperation | null = !match
      ? null
      : match[2] && method === 'POST' ? 'upload'
        : !match[2] && method === 'PUT' ? 'update'
          : !match[2] && method === 'GET' ? 'read'
            : null;
    if (!match || !operation) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ statusCode: 400, message: `Unexpected Confluence request ${method} ${url.pathname}` }));
      return;
    }
    const text = body.toString('utf8');
    const request: ConfluenceFixtureRequest = {
      operation,
      method,
      path: url.pathname,
      query: url.searchParams,
      authorization: incoming.headers.authorization,
      contentId: decodeURIComponent(match[1]!),
      json: operation === 'update' ? JSON.parse(text) as unknown : null,
      filename: operation === 'upload' ? /filename="([^"]+)"/.exec(text)?.[1] : undefined,
    };
    // Observed first: whatever happens to the answer, the request was sent.
    this.requests.push(request);

    let reply: ConfluenceFixtureReply | undefined;
    const gate = this.gates.get(operation)?.shift();
    if (gate) {
      gate.arrived(request);
      reply = await gate.reply;
    }
    reply ??= (await this.handlers[operation]?.(request)) ?? undefined;
    reply ??= this.defaultReply(request);

    if (reply === 'reset') {
      response.destroy();
      return;
    }
    response.writeHead(reply.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply.body));
  }
}
