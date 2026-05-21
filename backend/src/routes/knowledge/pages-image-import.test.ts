import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { pagesCrudRoutes } from './pages-crud.js';

// Mocks mirror the setup in pages-image-upload.test.ts so the two routes
// share their test plumbing.
const mockWriteAttachmentCache = vi.fn();
vi.mock('../../domains/confluence/services/attachment-handler.js', () => ({
  cleanPageAttachments: vi.fn(),
  writeAttachmentCache: (...args: unknown[]) => mockWriteAttachmentCache(...args),
}));

vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: vi.fn().mockResolvedValue(['DEV', 'OPS']),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

const mockQuery = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getPool: vi.fn().mockReturnValue({
    connect: vi.fn().mockResolvedValue({ query: vi.fn(), release: vi.fn() }),
  }),
}));

vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../core/services/content-converter.js', () => ({
  htmlToConfluence: vi.fn(), confluenceToHtml: vi.fn(),
}));
vi.mock('../../core/services/audit-service.js', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  processDirtyPages: vi.fn(), isProcessingUser: vi.fn().mockReturnValue(false),
}));
vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/services/redis-cache.js', () => {
  class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
  }
  return { RedisCache: MockRedisCache, getRedisClient: vi.fn().mockReturnValue(null) };
});

// SSRF guard: allow `https://cdn.example.com`-style URLs and reject the
// rest, so we can exercise both code paths deterministically.
const mockAssertNonSsrfUrl = vi.fn();
vi.mock('../../core/utils/ssrf-guard.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/utils/ssrf-guard.js')>(
    '../../core/utils/ssrf-guard.js',
  );
  return {
    ...actual,
    assertNonSsrfUrl: (url: string) => mockAssertNonSsrfUrl(url),
  };
});

// Tiny valid PNG (8-byte signature plus a minimal IHDR) — used as the
// upstream response body. Just needs `content-type: image/png` and a
// non-empty body; the route doesn't currently magic-byte-check imports
// (the SSRF + content-type gates carry the trust, plus the storage layer
// is the same as for paste uploads where we already do PNG sniffing).
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0xfa, 0xcf, 0x00, 0x00,
  0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

function mockUpstream(
  options: {
    ok?: boolean;
    status?: number;
    contentType?: string;
    contentLength?: number;
    body?: Buffer;
  } = {},
): Response {
  const body = options.body ?? TINY_PNG;
  const headers = new Headers();
  headers.set('content-type', options.contentType ?? 'image/png');
  if (options.contentLength !== undefined) {
    headers.set('content-length', String(options.contentLength));
  } else {
    headers.set('content-length', String(body.length));
  }
  return new Response(body, {
    status: options.status ?? 200,
    headers,
  });
}

describe('POST /api/pages/:id/images/import', () => {
  let app: ReturnType<typeof Fastify>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let originalFetch: any;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = 'test-user';
    });
    app.decorateRequest('userId', '');
    app.decorate('redis', null);
    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockWriteAttachmentCache.mockReset();
    mockWriteAttachmentCache.mockResolvedValue(undefined);
    mockAssertNonSsrfUrl.mockReset();
    mockAssertNonSsrfUrl.mockResolvedValue(undefined); // allow by default
    if (!originalFetch) originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('imports a valid PNG and returns the internal /api/attachments URL', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockUpstream());

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images/import',
      payload: { url: 'https://cdn.example.com/hero.png' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.url).toMatch(/^\/api\/attachments\/42\/hero\.png$/);
    expect(mockAssertNonSsrfUrl).toHaveBeenCalledWith('https://cdn.example.com/hero.png');
    expect(mockWriteAttachmentCache).toHaveBeenCalledWith('test-user', '42', 'hero.png', expect.any(Buffer));
  });

  it('rejects URLs blocked by SSRF guard with 400 (does not leak the reason)', async () => {
    mockAssertNonSsrfUrl.mockRejectedValueOnce(
      Object.assign(new Error('SSRF blocked: cannot connect to internal/private network'), { name: 'SsrfError' }),
    );
    // Real SsrfError instances are produced by the guard; the route catches
    // `instanceof SsrfError`. We import the real class so the instanceof
    // check fires in the route.
    const { SsrfError } = await vi.importActual<typeof import('../../core/utils/ssrf-guard.js')>(
      '../../core/utils/ssrf-guard.js',
    );
    mockAssertNonSsrfUrl.mockReset();
    mockAssertNonSsrfUrl.mockRejectedValueOnce(new SsrfError('blocked'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images/import',
      payload: { url: 'http://127.0.0.1/admin' },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).message).toMatch(/not reachable or not allowed/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockWriteAttachmentCache).not.toHaveBeenCalled();
  });

  it('rejects non-image content-types with 415', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockUpstream({ contentType: 'text/html', body: Buffer.from('<html>nope</html>') }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images/import',
      payload: { url: 'https://example.com/index.html' },
    });

    expect(response.statusCode).toBe(415);
    expect(JSON.parse(response.payload).message).toMatch(/must be an image/i);
    expect(mockWriteAttachmentCache).not.toHaveBeenCalled();
  });

  it('rejects unsupported image MIME types (e.g. SVG, BMP) with 415', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockUpstream({ contentType: 'image/svg+xml', body: Buffer.from('<svg/>') }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images/import',
      payload: { url: 'https://example.com/diagram.svg' },
    });

    expect(response.statusCode).toBe(415);
    expect(JSON.parse(response.payload).message).toMatch(/not supported.*svg/i);
  });

  it('rejects oversized responses up front via the declared Content-Length', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockUpstream({ contentLength: 50 * 1024 * 1024 }), // 50 MB declared
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images/import',
      payload: { url: 'https://cdn.example.com/huge.png' },
    });

    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.payload).message).toMatch(/exceeds maximum size/i);
  });

  it('returns 502 when the upstream responds non-2xx', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockUpstream({ status: 404, body: Buffer.alloc(0) }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images/import',
      payload: { url: 'https://cdn.example.com/missing.png' },
    });

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.payload).message).toMatch(/HTTP 404/);
  });

  it('returns 502 when the upstream returns an empty body', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockUpstream({ body: Buffer.alloc(0), contentLength: 0 }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images/import',
      payload: { url: 'https://cdn.example.com/empty.png' },
    });

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.payload).message).toMatch(/empty body/i);
  });

  it('returns 502 when fetch throws (timeout, DNS, connection refused, …)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError('fetch failed'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images/import',
      payload: { url: 'https://cdn.example.com/down.png' },
    });

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.payload).message).toMatch(/failed to fetch/i);
  });

  it('returns 404 when the page does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/999/images/import',
      payload: { url: 'https://cdn.example.com/x.png' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 403 when the user does not own a standalone page', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'other-user', space_key: null }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images/import',
      payload: { url: 'https://cdn.example.com/x.png' },
    });

    expect(response.statusCode).toBe(403);
    expect(mockWriteAttachmentCache).not.toHaveBeenCalled();
  });

  it('rejects malformed URLs with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images/import',
      payload: { url: 'not-a-real-url' },
    });

    expect(response.statusCode).toBe(400);
    expect(mockAssertNonSsrfUrl).not.toHaveBeenCalled(); // Zod rejects before we call the guard
  });

  it('generates a filename when the URL has no usable basename', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockUpstream());

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images/import',
      payload: { url: 'https://cdn.example.com/' }, // empty path
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.url).toMatch(/^\/api\/attachments\/42\/imported-\d+-[0-9a-f]+\.png$/);
  });

  it('re-validates redirect Location headers against SSRF guard (chain bypass fix)', async () => {
    // Regression test for the SSRF-via-redirect bypass found in code review:
    // before the fix, fetch(url, {redirect: 'follow'}) would silently follow
    // a 302 → http://192.168.1.1 even though the SSRF guard would have
    // blocked that URL if submitted directly. The route now uses manual
    // redirect mode and re-validates each hop.
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });
    const { SsrfError } = await vi.importActual<typeof import('../../core/utils/ssrf-guard.js')>(
      '../../core/utils/ssrf-guard.js',
    );

    // First call (the initial URL) passes the guard…
    mockAssertNonSsrfUrl.mockResolvedValueOnce(undefined);
    // …upstream returns 302 → private IP.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://192.168.1.1/admin' } }),
    );
    // …the second guard call (for the Location target) rejects.
    mockAssertNonSsrfUrl.mockRejectedValueOnce(new SsrfError('SSRF blocked: cannot connect to internal/private network'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images/import',
      payload: { url: 'https://cdn.example.com/redir.png' },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).message).toMatch(/redirects to a disallowed/i);
    // Critical: fetch was called for the FIRST URL but NOT for the private IP.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://cdn.example.com/redir.png', expect.anything());
    expect(mockWriteAttachmentCache).not.toHaveBeenCalled();
  });

  it('follows safe redirect chains (re-validates and re-fetches the final URL)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });

    // Both hops pass SSRF — the chain is public-to-public.
    mockAssertNonSsrfUrl.mockResolvedValueOnce(undefined);
    mockAssertNonSsrfUrl.mockResolvedValueOnce(undefined);

    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://final.example.com/hero.png' } }))
      .mockResolvedValueOnce(mockUpstream());

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images/import',
      payload: { url: 'https://short.example.com/r' },
    });

    expect(response.statusCode).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(mockAssertNonSsrfUrl).toHaveBeenCalledTimes(2);
    expect(mockAssertNonSsrfUrl.mock.calls[1]![0]).toBe('https://final.example.com/hero.png');
  });

  it('aborts when the body exceeds the size cap mid-stream (lying Content-Length)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });

    // Build a ReadableStream that emits chunks summing past 10 MB, while
    // claiming Content-Length: 100 in the header. Defends against
    // upstreams that lie about size to bypass the up-front content-length
    // check.
    const CHUNK_BYTES = 1024 * 1024; // 1 MB chunks
    const CHUNK_COUNT = 15;          // → ~15 MB total
    const stream = new ReadableStream({
      async start(controller) {
        for (let i = 0; i < CHUNK_COUNT; i++) {
          controller.enqueue(new Uint8Array(CHUNK_BYTES));
          // Yield so the consumer can interleave reads with the cap check.
          await new Promise((r) => setTimeout(r, 0));
        }
        controller.close();
      },
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '100' },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images/import',
      payload: { url: 'https://cdn.example.com/lying.png' },
    });

    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.payload).message).toMatch(/exceeds maximum size/i);
    expect(mockWriteAttachmentCache).not.toHaveBeenCalled();
  });

  it('rejects bodies whose magic bytes do not match the declared Content-Type', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, source: 'standalone', confluence_id: null, created_by_user_id: 'test-user', space_key: null }],
    });

    // Upstream returns `Content-Type: image/png` but the body is plain HTML
    // bytes (no PNG signature). The route must reject this — otherwise an
    // attacker can stash anything in our attachment store under a PNG MIME.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(Buffer.from('<!doctype html><script>alert(1)</script>'), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '40' },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/images/import',
      payload: { url: 'https://attacker.example.com/fake.png' },
    });

    expect(response.statusCode).toBe(415);
    expect(JSON.parse(response.payload).message).toMatch(/does not match declared/i);
    expect(mockWriteAttachmentCache).not.toHaveBeenCalled();
  });

  it('allows Confluence-spaced pages when the user has access to the space (RBAC)', async () => {
    // Coverage for the non-standalone branch — `getUserAccessibleSpaces`
    // returns `['DEV', 'OPS']` per the mock at the top of the file.
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 100, source: 'confluence', confluence_id: 'CONFL-100', created_by_user_id: null, space_key: 'DEV' }],
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockUpstream());

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/CONFL-100/images/import',
      payload: { url: 'https://cdn.example.com/space-shot.png' },
    });

    expect(response.statusCode).toBe(200);
    expect(mockWriteAttachmentCache).toHaveBeenCalledWith(
      'test-user', 'CONFL-100', 'space-shot.png', expect.any(Buffer),
    );
  });

  it('denies Confluence-spaced pages when the user does not have access', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 200, source: 'confluence', confluence_id: 'CONFL-200', created_by_user_id: null, space_key: 'SECRET' }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/CONFL-200/images/import',
      payload: { url: 'https://cdn.example.com/x.png' },
    });

    expect(response.statusCode).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
