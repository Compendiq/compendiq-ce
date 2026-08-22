import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesIconRoutes } from './pages-icon.js';

const mockInvalidate = vi.fn().mockResolvedValue(undefined);
const mockInvalidateAcrossUsers = vi.fn().mockResolvedValue(undefined);
vi.mock('../../core/services/redis-cache.js', () => ({
  RedisCache: class MockRedisCache {
    invalidate = mockInvalidate;
    invalidateAcrossUsers = mockInvalidateAcrossUsers;
  },
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockGetUserAccessibleSpaces = vi.fn().mockResolvedValue(['DEV']);
const mockUserCanAccessPage = vi.fn().mockResolvedValue(true);
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
  userCanAccessPage: (...args: unknown[]) => mockUserCanAccessPage(...args),
}));

const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
}));

const mockWrite = vi.fn();
const mockDelete = vi.fn().mockResolvedValue(undefined);
const mockRead = vi.fn();
vi.mock('../../core/services/page-icon-store.js', () => ({
  writePageIconImage: (...args: unknown[]) => mockWrite(...args),
  deletePageIconImage: (...args: unknown[]) => mockDelete(...args),
  readPageIconImage: (...args: unknown[]) => mockRead(...args),
  MAX_ICON_BYTES: 512 * 1024,
  PageIconStoreError: class PageIconStoreError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'PageIconStoreError';
    }
  },
}));

const pageRow = {
  id: 42,
  source: 'standalone',
  created_by_user_id: 'test-user-id',
  visibility: 'shared',
  space_key: 'NOTES',
  deleted_at: null,
  icon_kind: null,
  icon_value: null,
};

describe('PATCH /api/pages/:id/icon', () => {
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
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = 'test-user-id';
    });
    app.decorateRequest('userId', '');
    app.decorate('redis', {});
    await app.register(pagesIconRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, source')) {
        return { rows: [pageRow] };
      }
      return { rows: [], rowCount: 1 };
    });
  });

  it('sets an emoji mark and invalidates the pages cache', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/pages/42/icon',
      payload: { icon: { kind: 'emoji', value: '🚀' } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ icon: { kind: 'emoji', value: '🚀' } });
    expect(mockDelete).toHaveBeenCalledWith(42);
    expect(mockInvalidateAcrossUsers).toHaveBeenCalledWith('pages');
  });

  it('clears the mark', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/pages/42/icon',
      payload: { icon: null },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ icon: null });
    expect(mockDelete).toHaveBeenCalledWith(42);
  });

  it('accepts a catalogue brand slug', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/pages/42/icon',
      payload: { icon: { kind: 'brand', value: 'docker' } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ icon: { kind: 'brand', value: 'docker' } });
  });

  it('rejects an unknown lucide id', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/pages/42/icon',
      payload: { icon: { kind: 'lucide', value: 'globe' } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 when the page is missing', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [] });
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/pages/99/icon',
      payload: { icon: { kind: 'emoji', value: '📚' } },
    });
    expect(response.statusCode).toBe(404);
  });

  it('forbids editing someone else’s private page', async () => {
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, source')) {
        return {
          rows: [{ ...pageRow, visibility: 'private', created_by_user_id: 'other-user' }],
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/pages/42/icon',
      payload: { icon: { kind: 'emoji', value: '📚' } },
    });
    expect(response.statusCode).toBe(403);
  });
});
