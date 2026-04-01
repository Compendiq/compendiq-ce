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

vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: vi.fn().mockResolvedValue(['DEV', 'OPS']),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

describe('GET /api/pages/:id/children', () => {
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

  it('should return child pages for a given page', async () => {
    // First query: resolve the page by id
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 10, confluence_id: 'parent-conf-id' }],
    });
    // Second query: fetch children
    mockQueryFn.mockResolvedValueOnce({
      rows: [
        { id: 20, confluence_id: 'child-1', title: 'Child One', space_key: 'DEV' },
        { id: 30, confluence_id: 'child-2', title: 'Child Two', space_key: 'DEV' },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/10/children',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.children).toHaveLength(2);
    expect(body.children[0]).toEqual({
      id: 20,
      confluenceId: 'child-1',
      title: 'Child One',
      spaceKey: 'DEV',
    });
    expect(body.children[1]).toEqual({
      id: 30,
      confluenceId: 'child-2',
      title: 'Child Two',
      spaceKey: 'DEV',
    });
  });

  it('should return empty children array when page has no children', async () => {
    // Resolve page
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 5, confluence_id: 'page-5' }],
    });
    // No children
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/5/children',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.children).toHaveLength(0);
  });

  it('should return 404 when page does not exist', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/999/children',
    });

    expect(response.statusCode).toBe(404);
  });

  it('should respect depth parameter for recursive children', async () => {
    // Resolve page
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 1, confluence_id: 'root' }],
    });
    // Level 1 children
    mockQueryFn.mockResolvedValueOnce({
      rows: [
        { id: 2, confluence_id: 'child-1', title: 'Child 1', space_key: 'DEV' },
      ],
    });
    // Level 2 children (of child-1)
    mockQueryFn.mockResolvedValueOnce({
      rows: [
        { id: 3, confluence_id: 'grandchild-1', title: 'Grandchild 1', space_key: 'DEV' },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/1/children?depth=2',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.children).toHaveLength(1);
    expect(body.children[0].title).toBe('Child 1');
    expect(body.children[0].children).toHaveLength(1);
    expect(body.children[0].children[0].title).toBe('Grandchild 1');
  });

  it('should resolve confluence_id string parameter', async () => {
    // Resolve page by confluence_id
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 10, confluence_id: 'my-conf-page' }],
    });
    // Children
    mockQueryFn.mockResolvedValueOnce({
      rows: [
        { id: 20, confluence_id: 'child-1', title: 'Child One', space_key: 'DEV' },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/my-conf-page/children',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.children).toHaveLength(1);

    // Verify the first query used confluence_id (not numeric)
    const firstCallSql = mockQueryFn.mock.calls[0][0] as string;
    expect(firstCallSql).toContain('confluence_id');
  });

  it('should validate query parameters', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/1/children?depth=5',
    });

    // depth > 3 should fail validation
    expect(response.statusCode).toBe(400);
  });

  it('should use default sort and order when not specified', async () => {
    // Resolve page
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 1, confluence_id: 'root' }],
    });
    // Children
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    await app.inject({
      method: 'GET',
      url: '/api/pages/1/children',
    });

    // Verify children query uses default sort (title ASC)
    const childrenQuerySql = mockQueryFn.mock.calls[1][0] as string;
    expect(childrenQuerySql).toContain('ORDER BY title ASC');
  });
});
