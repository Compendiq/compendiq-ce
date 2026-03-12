import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesRoutes } from './pages.js';

// Track cache calls so we can assert on TTL and keys
const mockCacheGet = vi.fn().mockResolvedValue(null);
const mockCacheSet = vi.fn().mockResolvedValue(undefined);
const mockCacheInvalidate = vi.fn().mockResolvedValue(undefined);

vi.mock('../core/services/redis-cache.js', () => {
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

vi.mock('../core/services/content-converter.js', () => ({
  htmlToConfluence: vi.fn().mockReturnValue('<p>content</p>'),
  confluenceToHtml: vi.fn().mockReturnValue('<p>content</p>'),
  htmlToText: vi.fn().mockReturnValue('content'),
}));

vi.mock('../services/attachment-handler.js', () => ({
  cleanPageAttachments: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../core/services/audit-service.js', () => ({
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
  processDirtyPages: vi.fn().mockResolvedValue({ processed: 0, errors: 0 }),
  isProcessingUser: vi.fn().mockReturnValue(false),
  computePageRelationships: vi.fn().mockResolvedValue(0),
}));

vi.mock('../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockQueryFn = vi.fn();
vi.mock('../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

/** Stub DB responses for a page list query (count + rows) */
function stubPageListQuery(rows: Record<string, unknown>[] = [], total = 0) {
  // First call: COUNT query
  mockQueryFn.mockResolvedValueOnce({ rows: [{ count: String(total) }] });
  // Second call: SELECT query
  mockQueryFn.mockResolvedValueOnce({ rows });
}

const sampleRow = {
  id: 1,
  confluence_id: 'page-1',
  space_key: 'DEV',
  title: 'Test Page',
  version: 1,
  parent_id: null,
  labels: [],
  author: 'admin',
  last_modified_at: new Date('2026-03-01'),
  last_synced: new Date('2026-03-01'),
  embedding_dirty: false,
  embedding_status: 'embedded',
  embedded_at: new Date('2026-03-01'),
  embedding_error: null,
};

describe('GET /api/pages — filtered query caching (#195)', () => {
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

  // ---------- Unfiltered queries ----------

  it('should cache unfiltered queries with 15-minute TTL', async () => {
    stubPageListQuery([sampleRow], 1);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages',
    });

    expect(response.statusCode).toBe(200);

    // cache.set should have been called with TTL 900 (15 min)
    expect(mockCacheSet).toHaveBeenCalledTimes(1);
    const [userId, type, cacheKeyArg, , ttl] = mockCacheSet.mock.calls[0];
    expect(userId).toBe('test-user-id');
    expect(type).toBe('pages');
    expect(cacheKeyArg).toContain('list:');
    expect(ttl).toBe(900);
  });

  it('should return cached result for unfiltered query on cache hit', async () => {
    const cachedResponse = { items: [], total: 0, page: 1, limit: 50, totalPages: 0 };
    mockCacheGet.mockResolvedValueOnce(cachedResponse);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual(cachedResponse);
    // DB should NOT have been queried
    expect(mockQueryFn).not.toHaveBeenCalled();
    // cache.set should NOT have been called (returned from cache)
    expect(mockCacheSet).not.toHaveBeenCalled();
  });

  // ---------- Filtered queries — search ----------

  it('should cache search-filtered queries with 2-minute TTL', async () => {
    stubPageListQuery([sampleRow], 1);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages?search=kubernetes',
    });

    expect(response.statusCode).toBe(200);

    expect(mockCacheSet).toHaveBeenCalledTimes(1);
    const [, , cacheKeyArg, , ttl] = mockCacheSet.mock.calls[0];
    expect(cacheKeyArg).toContain('kubernetes');
    expect(ttl).toBe(120);
  });

  it('should return cached result for search-filtered query on cache hit', async () => {
    const cachedResponse = { items: [{ id: 'page-1', title: 'K8s Guide' }], total: 1, page: 1, limit: 50, totalPages: 1 };
    mockCacheGet.mockResolvedValueOnce(cachedResponse);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages?search=kubernetes',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual(cachedResponse);
    expect(mockQueryFn).not.toHaveBeenCalled();
  });

  // ---------- Filtered queries — author ----------

  it('should cache author-filtered queries with 2-minute TTL', async () => {
    stubPageListQuery([], 0);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages?author=johndoe',
    });

    expect(response.statusCode).toBe(200);
    expect(mockCacheSet).toHaveBeenCalledTimes(1);
    const [, , cacheKeyArg, , ttl] = mockCacheSet.mock.calls[0];
    expect(cacheKeyArg).toContain('johndoe');
    expect(ttl).toBe(120);
  });

  // ---------- Filtered queries — labels ----------

  it('should cache label-filtered queries with 2-minute TTL', async () => {
    stubPageListQuery([], 0);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages?labels=architecture,howto',
    });

    expect(response.statusCode).toBe(200);
    expect(mockCacheSet).toHaveBeenCalledTimes(1);
    const [, , cacheKeyArg, , ttl] = mockCacheSet.mock.calls[0];
    expect(cacheKeyArg).toContain('architecture,howto');
    expect(ttl).toBe(120);
  });

  // ---------- Filtered queries — freshness ----------

  it('should cache freshness-filtered queries with 2-minute TTL', async () => {
    stubPageListQuery([], 0);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages?freshness=stale',
    });

    expect(response.statusCode).toBe(200);
    expect(mockCacheSet).toHaveBeenCalledTimes(1);
    const [, , , , ttl] = mockCacheSet.mock.calls[0];
    expect(ttl).toBe(120);
  });

  // ---------- Filtered queries — embeddingStatus ----------

  it('should cache embeddingStatus-filtered queries with 2-minute TTL', async () => {
    stubPageListQuery([], 0);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages?embeddingStatus=pending',
    });

    expect(response.statusCode).toBe(200);
    expect(mockCacheSet).toHaveBeenCalledTimes(1);
    const [, , , , ttl] = mockCacheSet.mock.calls[0];
    expect(ttl).toBe(120);
  });

  // ---------- Filtered queries — date range ----------

  it('should cache date-range-filtered queries with 2-minute TTL', async () => {
    stubPageListQuery([], 0);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages?dateFrom=2026-01-01&dateTo=2026-03-01',
    });

    expect(response.statusCode).toBe(200);
    expect(mockCacheSet).toHaveBeenCalledTimes(1);
    const [, , cacheKeyArg, , ttl] = mockCacheSet.mock.calls[0];
    expect(cacheKeyArg).toContain('2026-01-01');
    expect(cacheKeyArg).toContain('2026-03-01');
    expect(ttl).toBe(120);
  });

  // ---------- Combined filters ----------

  it('should cache combined-filter queries with 2-minute TTL', async () => {
    stubPageListQuery([sampleRow], 1);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages?spaceKey=DEV&search=test&author=admin&freshness=fresh',
    });

    expect(response.statusCode).toBe(200);
    expect(mockCacheSet).toHaveBeenCalledTimes(1);
    const [, , cacheKeyArg, , ttl] = mockCacheSet.mock.calls[0];
    expect(cacheKeyArg).toContain('DEV');
    expect(cacheKeyArg).toContain('test');
    expect(cacheKeyArg).toContain('admin');
    expect(cacheKeyArg).toContain('fresh');
    expect(ttl).toBe(120);
  });

  // ---------- Cache key differentiation ----------

  it('should produce different cache keys for different filter combinations', async () => {
    // First: search=foo
    stubPageListQuery([], 0);
    await app.inject({ method: 'GET', url: '/api/pages?search=foo' });

    // Second: search=bar
    stubPageListQuery([], 0);
    await app.inject({ method: 'GET', url: '/api/pages?search=bar' });

    expect(mockCacheSet).toHaveBeenCalledTimes(2);
    const key1 = mockCacheSet.mock.calls[0][2];
    const key2 = mockCacheSet.mock.calls[1][2];
    expect(key1).not.toBe(key2);
  });

  it('should produce different cache keys for different pagination', async () => {
    stubPageListQuery([], 0);
    await app.inject({ method: 'GET', url: '/api/pages?page=1&limit=10' });

    stubPageListQuery([], 0);
    await app.inject({ method: 'GET', url: '/api/pages?page=2&limit=10' });

    expect(mockCacheSet).toHaveBeenCalledTimes(2);
    const key1 = mockCacheSet.mock.calls[0][2];
    const key2 = mockCacheSet.mock.calls[1][2];
    expect(key1).not.toBe(key2);
  });

  // ---------- spaceKey-only is not a "filter" ----------

  it('should use 15-minute TTL when only spaceKey is provided (not a filter)', async () => {
    stubPageListQuery([], 0);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages?spaceKey=DEV',
    });

    expect(response.statusCode).toBe(200);
    expect(mockCacheSet).toHaveBeenCalledTimes(1);
    const [, , , , ttl] = mockCacheSet.mock.calls[0];
    expect(ttl).toBe(900);
  });
});
