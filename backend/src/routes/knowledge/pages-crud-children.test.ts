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
  getUserAccessibleSpaces: vi.fn().mockResolvedValue(['TEST']),
}));

vi.mock('../../core/services/fts-language.js', () => ({
  getFtsLanguage: vi.fn().mockResolvedValue('simple'),
}));

const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({ connect: vi.fn() }),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

describe('GET /api/pages/:id/children - recursive CTE', () => {
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

  it('should use a recursive CTE instead of N+1 queries', async () => {
    // 1st query: resolve page
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 10, confluence_id: 'conf-10', space_key: 'TEST', source: 'confluence', visibility: 'shared', created_by_user_id: null }],
    });

    // 2nd query: recursive CTE result (flat rows with depth)
    mockQueryFn.mockResolvedValueOnce({
      rows: [
        { id: 20, confluence_id: 'conf-20', title: 'Child A', space_key: 'TEST', parent_id: 'conf-10', depth: 1 },
        { id: 21, confluence_id: 'conf-21', title: 'Child B', space_key: 'TEST', parent_id: 'conf-10', depth: 1 },
        { id: 30, confluence_id: 'conf-30', title: 'Grandchild A1', space_key: 'TEST', parent_id: 'conf-20', depth: 2 },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/10/children?depth=2',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // Should have 2 root children
    expect(body.children).toHaveLength(2);
    expect(body.children[0].title).toBe('Child A');
    expect(body.children[1].title).toBe('Child B');

    // Child A should have 1 grandchild
    expect(body.children[0].children).toHaveLength(1);
    expect(body.children[0].children[0].title).toBe('Grandchild A1');

    // Child B should have no children
    expect(body.children[1].children).toBeUndefined();

    // Verify the CTE query was used (WITH RECURSIVE)
    const cteCall = mockQueryFn.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('WITH RECURSIVE'),
    );
    expect(cteCall).toBeDefined();

    // Should only be 2 queries total (page resolve + CTE), not N+1
    expect(mockQueryFn).toHaveBeenCalledTimes(2);
  });

  it('should return 404 when page does not exist', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/999/children',
    });

    expect(response.statusCode).toBe(404);
  });

  it('should return empty children for leaf nodes', async () => {
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 10, confluence_id: 'conf-10', space_key: 'TEST', source: 'confluence', visibility: 'shared', created_by_user_id: null }],
    });
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/10/children',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.children).toHaveLength(0);
  });
});
