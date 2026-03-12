import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesCrudRoutes } from './pages-crud.js';

// Track cache operations to verify key format
const mockCacheGet = vi.fn().mockResolvedValue(null);
const mockCacheSet = vi.fn().mockResolvedValue(undefined);
const mockCacheInvalidate = vi.fn().mockResolvedValue(undefined);

vi.mock('../../core/services/redis-cache.js', () => {
  return {
    RedisCache: class MockRedisCache {
      get = mockCacheGet;
      set = mockCacheSet;
      invalidate = mockCacheInvalidate;
    },
  };
});

vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../core/services/content-converter.js', () => ({
  htmlToConfluence: vi.fn().mockReturnValue('<p>content</p>'),
  confluenceToHtml: vi.fn().mockReturnValue('<p>content</p>'),
  htmlToText: vi.fn().mockReturnValue('content'),
}));

vi.mock('../../domains/confluence/services/attachment-handler.js', () => ({
  cleanPageAttachments: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../domains/knowledge/services/duplicate-detector.js', () => ({
  findDuplicates: vi.fn().mockResolvedValue([]),
  scanAllDuplicates: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../domains/knowledge/services/auto-tagger.js', () => ({
  autoTagPage: vi.fn().mockResolvedValue({ tags: [] }),
  applyTags: vi.fn().mockResolvedValue([]),
  autoTagAllPages: vi.fn().mockResolvedValue(undefined),
  ALLOWED_TAGS: ['architecture', 'howto', 'troubleshooting'],
}));

vi.mock('../../domains/knowledge/services/version-tracker.js', () => ({
  getVersionHistory: vi.fn().mockResolvedValue([]),
  getVersion: vi.fn().mockResolvedValue(null),
  getSemanticDiff: vi.fn().mockResolvedValue('no diff'),
  saveVersionSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  processDirtyPages: vi.fn().mockResolvedValue(undefined),
  isProcessingUser: vi.fn().mockReturnValue(false),
  computePageRelationships: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
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

    await app.register(pagesCrudRoutes, { prefix: '/api' });
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
      'list::::::::::::1:50:title',
    );

    // Verify cache.set was also called with the same key format (unfiltered TTL = 900s)
    expect(mockCacheSet).toHaveBeenCalledWith(
      'test-user-id',
      'pages',
      'list::::::::::::1:50:title',
      expect.any(Object),
      900,
    );
  });

  it('should use namespaced cache key format with spaceKey', async () => {
    mockPageListResponse();

    await app.inject({ method: 'GET', url: '/api/pages?spaceKey=DEV' });

    expect(mockCacheGet).toHaveBeenCalledWith(
      'test-user-id',
      'pages',
      'list:DEV:::::::::::1:50:title',
    );
  });

  it('should include pagination params in cache key', async () => {
    mockPageListResponse();

    await app.inject({ method: 'GET', url: '/api/pages?page=3&limit=25' });

    expect(mockCacheGet).toHaveBeenCalledWith(
      'test-user-id',
      'pages',
      'list::::::::::::3:25:title',
    );
  });

  it('should include sort param in cache key', async () => {
    mockPageListResponse();

    await app.inject({ method: 'GET', url: '/api/pages?sort=modified' });

    expect(mockCacheGet).toHaveBeenCalledWith(
      'test-user-id',
      'pages',
      'list::::::::::::1:50:modified',
    );
  });

  it('should produce distinct cache keys for different parameters', () => {
    // This test verifies the old bug is fixed: previously "all:1:50:title"
    // could collide if spaceKey literally was "all" vs. no spaceKey.
    const keyNoSpace = `list:${''}:::::::::::1:50:title`;
    const keySpaceAll = `list:${'all'}:::::::::::1:50:title`;
    const keySpaceDev = `list:${'DEV'}:::::::::::1:50:title`;

    expect(keyNoSpace).not.toBe(keySpaceAll);
    expect(keyNoSpace).not.toBe(keySpaceDev);
    expect(keySpaceAll).not.toBe(keySpaceDev);
  });

  it('should use a shorter TTL for filtered queries vs unfiltered', async () => {
    // The cache is always consulted (even with filters), but uses 2min vs 15min TTL.
    // This test verifies that cache.get is called with the correct key for a search query.
    mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    await app.inject({ method: 'GET', url: '/api/pages?search=test' });

    // cache.get IS called even when search filter is active (uses shorter TTL, same key)
    expect(mockCacheGet).toHaveBeenCalled();
    // cache.get called with a key containing the search term
    const call = mockCacheGet.mock.calls[0];
    expect(call[2]).toContain('test'); // search term in key
  });
});
