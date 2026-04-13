import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesCrudRoutes } from './pages-crud.js';

// --- Mocks ---

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

const mockGetClientForUser = vi.fn();
vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: (...args: unknown[]) => mockGetClientForUser(...args),
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

const mockGetUserAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
}));

const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

const TEST_USER = 'user-1';

describe('DELETE /api/pages/:id RBAC space access checks', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: error.errors });
      }
      const statusCode = error.statusCode ?? 500;
      return reply.status(statusCode).send({ error: error.message });
    });

    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = TEST_USER;
      request.username = 'testuser';
      request.userRole = 'user';
    });
    app.decorate('requireAdmin', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = TEST_USER;
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
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
  });

  it('returns 403 when Confluence page is in a space the user cannot access, and deletePage is not called', async () => {
    const mockDeletePage = vi.fn().mockResolvedValue(undefined);
    mockGetClientForUser.mockResolvedValue({ deletePage: mockDeletePage });

    // Page exists in HR space (user only has DEV, OPS)
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('id, source, created_by_user_id')) {
        return Promise.resolve({
          rows: [{
            id: 10,
            source: 'confluence',
            created_by_user_id: null,
            confluence_id: 'page-100',
            space_key: 'HR',
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/pages/page-100',
    });

    expect(response.statusCode).toBe(403);
    // getUserAccessibleSpaces should have been called
    expect(mockGetUserAccessibleSpaces).toHaveBeenCalledWith(TEST_USER);
    // Critical security assertion: deletePage must NOT be called for unauthorized spaces
    expect(mockDeletePage).not.toHaveBeenCalled();
  });

  it('allows delete when Confluence page is in an accessible space', async () => {
    const mockDeletePage = vi.fn().mockResolvedValue(undefined);
    mockGetClientForUser.mockResolvedValue({ deletePage: mockDeletePage });

    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('id, source, created_by_user_id')) {
        return Promise.resolve({
          rows: [{
            id: 10,
            source: 'confluence',
            created_by_user_id: null,
            confluence_id: 'page-100',
            space_key: 'DEV',
          }],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/pages/page-100',
    });

    expect(response.statusCode).toBe(200);
    expect(mockDeletePage).toHaveBeenCalledWith('page-100');
    expect(mockGetUserAccessibleSpaces).toHaveBeenCalledWith(TEST_USER);
  });

  it('allows delete when Confluence page has null space_key (no space to check)', async () => {
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('id, source, created_by_user_id')) {
        return Promise.resolve({
          rows: [{
            id: 10,
            source: 'confluence',
            created_by_user_id: null,
            confluence_id: 'page-100',
            space_key: null,
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/pages/page-100',
    });

    // No space_key means no RBAC check — delete proceeds to Confluence API
    expect(response.statusCode).toBe(200);
  });

  it('still allows standalone page deletion by owner (no RBAC space check)', async () => {
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('id, source, created_by_user_id')) {
        return Promise.resolve({
          rows: [{
            id: 10,
            source: 'standalone',
            created_by_user_id: TEST_USER,
            confluence_id: null,
            space_key: null,
          }],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/pages/10',
    });

    expect(response.statusCode).toBe(200);
    // getUserAccessibleSpaces should NOT have been called for standalone pages
    expect(mockGetUserAccessibleSpaces).not.toHaveBeenCalled();
  });

  it('allows delete with numeric ID when page is in accessible space', async () => {
    const mockDeletePage = vi.fn().mockResolvedValue(undefined);
    mockGetClientForUser.mockResolvedValue({ deletePage: mockDeletePage });

    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('id, source, created_by_user_id')) {
        return Promise.resolve({
          rows: [{
            id: 42,
            source: 'confluence',
            created_by_user_id: null,
            confluence_id: 'page-42',
            space_key: 'OPS',
          }],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/pages/42',
    });

    expect(response.statusCode).toBe(200);
    expect(mockDeletePage).toHaveBeenCalledWith('page-42');
  });
});
