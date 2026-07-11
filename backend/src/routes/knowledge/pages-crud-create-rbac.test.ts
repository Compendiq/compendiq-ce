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
    invalidateAcrossUsers = vi.fn().mockResolvedValue(undefined);
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

describe('POST /api/pages RBAC space access checks (Confluence create)', () => {
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
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
    mockQueryFn.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('returns 403 when creating a Confluence page in a space the user cannot access, and createPage is not called', async () => {
    const mockCreatePage = vi.fn().mockResolvedValue({
      id: 'new-1',
      title: 'T',
      version: { number: 1 },
      body: { storage: { value: '<p>x</p>' } },
    });
    mockGetClientForUser.mockResolvedValue({ createPage: mockCreatePage });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'T',
        bodyHtml: '<p>x</p>',
        source: 'confluence',
        spaceKey: 'HR',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(mockGetUserAccessibleSpaces).toHaveBeenCalledWith(TEST_USER);
    // Critical security assertion: createPage must NOT be called for unauthorized spaces
    expect(mockCreatePage).not.toHaveBeenCalled();
  });

  it('allows creating a Confluence page in an accessible space', async () => {
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'HR']);
    const mockCreatePage = vi.fn().mockResolvedValue({
      id: 'new-1',
      title: 'T',
      version: { number: 1 },
      body: { storage: { value: '<p>x</p>' } },
    });
    mockGetClientForUser.mockResolvedValue({ createPage: mockCreatePage });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'T',
        bodyHtml: '<p>x</p>',
        source: 'confluence',
        spaceKey: 'DEV',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockCreatePage).toHaveBeenCalledWith('DEV', 'T', expect.any(String), undefined);
    const body = JSON.parse(response.payload);
    expect(body.source).toBe('confluence');
    expect(mockGetUserAccessibleSpaces).toHaveBeenCalledWith(TEST_USER);
  });

  it('does not run the RBAC space check for standalone create', async () => {
    // INSERT returns new page (standalone path)
    mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 42, title: 'T', version: 1 }] });
    // UPDATE path
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'T',
        bodyHtml: '<p>x</p>',
        source: 'standalone',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.source).toBe('standalone');
    // The Confluence-branch RBAC guard must not touch the standalone path
    expect(mockGetUserAccessibleSpaces).not.toHaveBeenCalled();
  });
});
