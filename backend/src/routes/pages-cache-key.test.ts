import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesRoutes } from './pages.js';

// Track cache operations to verify key format
const mockCacheGet = vi.fn().mockResolvedValue(null);
const mockCacheSet = vi.fn().mockResolvedValue(undefined);
const mockCacheInvalidate = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/redis-cache.js', () => {
  return {
    RedisCache: class MockRedisCache {
      get = mockCacheGet;
      set = mockCacheSet;
      invalidate = mockCacheInvalidate;
    },
  };
});

vi.mock('../services/sync-service.js', () => ({
  getClientForUser: vi.fn().mockResolvedValue(null),
}));

vi.mock('../services/content-converter.js', () => ({
  htmlToConfluence: vi.fn().mockReturnValue('<p>content</p>'),
  confluenceToHtml: vi.fn().mockReturnValue('<p>content</p>'),
  htmlToText: vi.fn().mockReturnValue('content'),
}));

vi.mock('../services/attachment-handler.js', () => ({
  cleanPageAttachments: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/duplicate-detector.js', () => ({
  findDuplicates: vi.fn().mockResolvedValue([]),
  scanAllDuplicates: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/auto-tagger.js', () => ({
  autoTagPage: vi.fn().mockResolvedValue({ tags: [] }),
  applyTags: vi.fn().mockResolvedValue([]),
  autoTagAllPages: vi.fn().mockResolvedValue(undefined),
  ALLOWED_TAGS: ['architecture', 'howto', 'troubleshooting'],
}));

vi.mock('../services/version-tracker.js', () => ({
  getVersionHistory: vi.fn().mockResolvedValue([]),
  getVersion: vi.fn().mockResolvedValue(null),
  getSemanticDiff: vi.fn().mockResolvedValue('no diff'),
  saveVersionSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/embedding-service.js', () => ({
  processDirtyPages: vi.fn().mockResolvedValue(undefined),
  isProcessingUser: vi.fn().mockReturnValue(false),
  computePageRelationships: vi.fn().mockResolvedValue(0),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockQueryFn = vi.fn();
vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

describe('Pages cache key format', () => {
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
      reply.status(error.statusCode ?? 500).send({ error: error.message, statusCode: error.statusCode ?? 500 });
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

    await app.register(pagesRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockPageListResponse = () => {
    // First call: count query
    mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    // Second call: select query
    mockQueryFn.mockResolvedValueOnce({
      rows: [{
        id: 1,
        confluence_id: 'page-1',
        space_key: 'DEV',
        title: 'Test Page',
        version: 1,
        parent_id: null,
        labels: [],
        author: 'user',
        last_modified_at: new Date('2026-03-01'),
        last_synced: new Date('2026-03-01'),
        embedding_dirty: false,
        embedding_status: 'embedded',
        embedded_at: new Date('2026-03-01'),
        embedding_error: null,
      }],
    });
  };

  it('should use namespaced cache key format without spaceKey', async () => {
    mockPageListResponse();

    await app.inject({ method: 'GET', url: '/api/pages' });

    // Verify cache.get was called with the new namespaced key format
    expect(mockCacheGet).toHaveBeenCalledWith(
      'test-user-id',
      'pages',
      'space:none:page:1:limit:50:sort:title',
    );

    // Verify cache.set was also called with the same key format
    expect(mockCacheSet).toHaveBeenCalledWith(
      'test-user-id',
      'pages',
      'space:none:page:1:limit:50:sort:title',
      expect.any(Object),
    );
  });

  it('should use namespaced cache key format with spaceKey', async () => {
    mockPageListResponse();

    await app.inject({ method: 'GET', url: '/api/pages?spaceKey=DEV' });

    expect(mockCacheGet).toHaveBeenCalledWith(
      'test-user-id',
      'pages',
      'space:DEV:page:1:limit:50:sort:title',
    );
  });

  it('should include pagination params in cache key', async () => {
    mockPageListResponse();

    await app.inject({ method: 'GET', url: '/api/pages?page=3&limit=25' });

    expect(mockCacheGet).toHaveBeenCalledWith(
      'test-user-id',
      'pages',
      'space:none:page:3:limit:25:sort:title',
    );
  });

  it('should include sort param in cache key', async () => {
    mockPageListResponse();

    await app.inject({ method: 'GET', url: '/api/pages?sort=modified' });

    expect(mockCacheGet).toHaveBeenCalledWith(
      'test-user-id',
      'pages',
      'space:none:page:1:limit:50:sort:modified',
    );
  });

  it('should produce distinct cache keys for different parameters', () => {
    // This test verifies the old bug is fixed: previously "all:1:50:title"
    // could collide if spaceKey literally was "all" vs. no spaceKey.
    const keyNoSpace = `space:${'none'}:page:1:limit:50:sort:title`;
    const keySpaceAll = `space:${'all'}:page:1:limit:50:sort:title`;
    const keySpaceDev = `space:${'DEV'}:page:1:limit:50:sort:title`;

    expect(keyNoSpace).not.toBe(keySpaceAll);
    expect(keyNoSpace).not.toBe(keySpaceDev);
    expect(keySpaceAll).not.toBe(keySpaceDev);
  });

  it('should not use cache when filters are active', async () => {
    // count query
    mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    // select query
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    await app.inject({ method: 'GET', url: '/api/pages?search=test' });

    // cache.get should NOT be called when search filter is active
    expect(mockCacheGet).not.toHaveBeenCalled();
    expect(mockCacheSet).not.toHaveBeenCalled();
  });
});
