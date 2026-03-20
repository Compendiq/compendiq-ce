import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesCrudRoutes } from './pages-crud.js';

vi.mock('../../core/services/redis-cache.js', () => ({
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../core/services/content-converter.js', () => ({
  htmlToConfluence: vi.fn((html: string) => html),
  confluenceToHtml: vi.fn((html: string) => html),
  htmlToText: vi.fn((html: string) => html.replace(/<[^>]*>/g, '')),
}));

vi.mock('../../domains/confluence/services/attachment-handler.js', () => ({
  cleanPageAttachments: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  processDirtyPages: vi.fn().mockResolvedValue(undefined),
  isProcessingUser: vi.fn().mockReturnValue(false),
}));

const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

describe('POST /api/pages - parentId validation', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        reply.status(400).send({
          error: 'ValidationError',
          message: error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          statusCode: 400,
        });
        return;
      }
      reply.status(error.statusCode ?? 500).send({
        error: error.message,
        statusCode: error.statusCode ?? 500,
      });
    });

    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'test-user-id';
      request.username = 'testuser';
      request.userRole = 'user';
    });
    app.decorate('requireAdmin', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'test-user-id';
      request.username = 'testuser';
      request.userRole = 'admin';
    });
    app.decorate('redis', {});

    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a standalone page without parentId', async () => {
    // INSERT returns new page
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 42, title: 'Test Page', version: 1 }],
    });
    // UPDATE path
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Test Page',
        bodyHtml: '<p>Hello</p>',
        source: 'standalone',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.id).toBe(42);
    expect(body.source).toBe('standalone');
  });

  it('should return 400 when parentId does not exist', async () => {
    // Parent lookup returns nothing
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Child Page',
        bodyHtml: '<p>Hello</p>',
        source: 'standalone',
        parentId: '999',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toContain('Parent page not found');
  });

  it('should return 400 when parent belongs to a different space', async () => {
    // Space check: body.spaceKey is MYSPACE and it's a local space
    mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'local' }] });
    // Parent lookup: parent exists but in a different space
    mockQueryFn.mockResolvedValueOnce({ rows: [{ path: '/5', space_key: 'OTHER_SPACE' }] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Child Page',
        bodyHtml: '<p>Hello</p>',
        source: 'standalone',
        spaceKey: 'MYSPACE',
        parentId: '5',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toContain('same space');
  });

  it('should create a page with valid parentId in the same space', async () => {
    // Space check: MYSPACE is local
    mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'local' }] });
    // Parent lookup: parent exists in MYSPACE
    mockQueryFn.mockResolvedValueOnce({ rows: [{ path: '/5', space_key: 'MYSPACE' }] });
    // INSERT returns new page
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 43, title: 'Child Page', version: 1 }],
    });
    // UPDATE path
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Child Page',
        bodyHtml: '<p>Hello</p>',
        source: 'standalone',
        spaceKey: 'MYSPACE',
        parentId: '5',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.id).toBe(43);
  });

  it('should allow parentId without spaceKey (no cross-space check needed)', async () => {
    // Parent lookup: parent exists (no spaceKey in body so no cross-space check)
    mockQueryFn.mockResolvedValueOnce({ rows: [{ path: '/10', space_key: 'ANY' }] });
    // INSERT returns new page
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 44, title: 'Orphan Child', version: 1 }],
    });
    // UPDATE path
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Orphan Child',
        bodyHtml: '<p>Hello</p>',
        source: 'standalone',
        parentId: '10',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.id).toBe(44);
  });

  it('should return 400 when spaceKey does not exist in spaces table', async () => {
    // Space lookup returns no rows (unknown space)
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Page In Unknown Space',
        bodyHtml: '<p>Hello</p>',
        spaceKey: 'NONEXISTENT',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toContain("Space 'NONEXISTENT' not found");
  });

  it('should stay standalone when explicit source is standalone even with Confluence spaceKey', async () => {
    // Space lookup: space exists and is confluence
    mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'confluence' }] });
    // INSERT returns new page (standalone path, no Confluence API call)
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 50, title: 'Standalone Override', version: 1 }],
    });
    // UPDATE path
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Standalone Override',
        bodyHtml: '<p>Hello</p>',
        source: 'standalone',
        spaceKey: 'CONFSPACE',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.id).toBe(50);
    expect(body.source).toBe('standalone');
  });

  it('should auto-detect confluence when source is omitted and space is confluence', async () => {
    // Space lookup: space exists and is confluence
    mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'confluence' }] });

    // Ensure getClientForUser returns null (no Confluence configured)
    const { getClientForUser } = await import('../../domains/confluence/services/sync-service.js');
    vi.mocked(getClientForUser).mockResolvedValueOnce(null);

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Auto Detect Confluence',
        bodyHtml: '<p>Hello</p>',
        // source intentionally omitted — should auto-detect from space
        spaceKey: 'CONFSPACE',
      },
    });

    // Goes down confluence path; getClientForUser returns null → 400
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toContain('Confluence not configured');
  });

  it('should auto-detect standalone when source is omitted and space is local', async () => {
    // Space lookup: space exists and is local
    mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'local' }] });
    // INSERT returns new page (standalone path)
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 60, title: 'Auto Detect Local', version: 1 }],
    });
    // UPDATE path
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Auto Detect Local',
        bodyHtml: '<p>Hello</p>',
        // source intentionally omitted — should auto-detect from space
        spaceKey: 'LOCALSPACE',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.id).toBe(60);
    expect(body.source).toBe('standalone');
  });

  it('should auto-detect standalone when source is omitted and no spaceKey', async () => {
    // No space lookup needed (no spaceKey)
    // INSERT returns new page (standalone path)
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 61, title: 'No Space Auto', version: 1 }],
    });
    // UPDATE path
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'No Space Auto',
        bodyHtml: '<p>Hello</p>',
        // source AND spaceKey both omitted — defaults to standalone
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.id).toBe(61);
    expect(body.source).toBe('standalone');
  });

  it('should treat __local__ sentinel as standalone and skip space lookup', async () => {
    // No space lookup — __local__ is a sentinel, not a real space key.
    // INSERT returns new page (standalone path)
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 70, title: 'Local Sentinel Page', version: 1 }],
    });
    // UPDATE path
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Local Sentinel Page',
        bodyHtml: '<p>Hello from local</p>',
        spaceKey: '__local__',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.id).toBe(70);
    expect(body.source).toBe('standalone');

    // Verify the INSERT was called with null space_key (6th param)
    const insertCall = mockQueryFn.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO pages'),
    );
    expect(insertCall).toBeDefined();
    // space_key is the 6th parameter ($6) in the INSERT
    expect(insertCall![1][5]).toBeNull();
  });

  it('should use confluence when explicit source is confluence', async () => {
    // Space lookup: space exists and is local
    mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'local' }] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Confluence Override',
        bodyHtml: '<p>Hello</p>',
        source: 'confluence',
        spaceKey: 'LOCALSPACE',
      },
    });

    // This will fail with 400 because getClientForUser mock returns null (no Confluence configured)
    // but the important thing is it did NOT go down the standalone path
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toContain('Confluence not configured');
  });
});
