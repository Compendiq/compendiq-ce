import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesRoutes } from './pages.js';

// Mock external dependencies
vi.mock('../services/redis-cache.js', () => {
  return {
    RedisCache: class MockRedisCache {
      get = vi.fn().mockResolvedValue(null);
      set = vi.fn().mockResolvedValue(undefined);
      invalidate = vi.fn().mockResolvedValue(undefined);
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

const defaultPageRow = {
  id: 1,
  confluence_id: 'page-1',
  space_key: 'DEV',
  title: 'Test Page',
  version: 1,
  parent_id: null,
  labels: ['howto'],
  author: 'Alice',
  last_modified_at: new Date('2025-01-15'),
  last_synced: new Date('2025-01-16'),
  embedding_dirty: false,
  embedding_status: 'embedded',
  embedded_at: new Date('2025-01-16'),
};

describe('Page Filters', () => {
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
    // Default: count query returns 1, data query returns one row
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
        return { rows: [{ count: '1' }] };
      }
      return { rows: [defaultPageRow], rowCount: 1 };
    });
  });

  describe('GET /api/pages with author filter', () => {
    it('should pass author parameter to SQL query', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages?author=Alice',
      });

      expect(response.statusCode).toBe(200);
      // Verify author was passed as a parameter
      const countCall = mockQueryFn.mock.calls.find((c: unknown[]) => (c[0] as string).includes('COUNT(*)'));
      expect(countCall).toBeDefined();
      expect((countCall![0] as string)).toContain('cp.author = $');
      expect(countCall![1] as unknown[]).toContain('Alice');
    });
  });

  describe('GET /api/pages with labels filter', () => {
    it('should filter by labels using array contains operator', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages?labels=howto,architecture',
      });

      expect(response.statusCode).toBe(200);
      const countCall = mockQueryFn.mock.calls.find((c: unknown[]) => (c[0] as string).includes('COUNT(*)'));
      expect(countCall).toBeDefined();
      expect((countCall![0] as string)).toContain('cp.labels @>');
      expect(countCall![1] as unknown[]).toContainEqual(['howto', 'architecture']);
    });
  });

  describe('GET /api/pages with freshness filter', () => {
    it('should add date range condition for fresh pages', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages?freshness=fresh',
      });

      expect(response.statusCode).toBe(200);
      const countCall = mockQueryFn.mock.calls.find((c: unknown[]) => (c[0] as string).includes('COUNT(*)'));
      expect((countCall![0] as string)).toContain("NOW() - INTERVAL '7 days'");
    });

    it('should add date range condition for stale pages', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages?freshness=stale',
      });

      expect(response.statusCode).toBe(200);
      const countCall = mockQueryFn.mock.calls.find((c: unknown[]) => (c[0] as string).includes('COUNT(*)'));
      expect((countCall![0] as string)).toContain("NOW() - INTERVAL '90 days'");
    });
  });

  describe('GET /api/pages with embeddingStatus filter', () => {
    it('should filter for pending embeddings', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages?embeddingStatus=pending',
      });

      expect(response.statusCode).toBe(200);
      const countCall = mockQueryFn.mock.calls.find((c: unknown[]) => (c[0] as string).includes('COUNT(*)'));
      expect((countCall![0] as string)).toContain('cp.embedding_dirty = $');
      expect(countCall![1] as unknown[]).toContain(true);
    });

    it('should filter for done embeddings', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages?embeddingStatus=done',
      });

      expect(response.statusCode).toBe(200);
      const countCall = mockQueryFn.mock.calls.find((c: unknown[]) => (c[0] as string).includes('COUNT(*)'));
      expect(countCall![1] as unknown[]).toContain(false);
    });
  });

  describe('GET /api/pages with date range filter', () => {
    it('should filter by dateFrom', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages?dateFrom=2025-01-01',
      });

      expect(response.statusCode).toBe(200);
      const countCall = mockQueryFn.mock.calls.find((c: unknown[]) => (c[0] as string).includes('COUNT(*)'));
      expect((countCall![0] as string)).toContain('cp.last_modified_at >=');
      expect(countCall![1] as unknown[]).toContain('2025-01-01');
    });

    it('should filter by dateTo', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages?dateTo=2025-12-31',
      });

      expect(response.statusCode).toBe(200);
      const countCall = mockQueryFn.mock.calls.find((c: unknown[]) => (c[0] as string).includes('COUNT(*)'));
      expect((countCall![0] as string)).toContain('cp.last_modified_at <=');
      expect(countCall![1] as unknown[]).toContain('2025-12-31');
    });

    it('should filter by both dateFrom and dateTo', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages?dateFrom=2025-01-01&dateTo=2025-12-31',
      });

      expect(response.statusCode).toBe(200);
      const countCall = mockQueryFn.mock.calls.find((c: unknown[]) => (c[0] as string).includes('COUNT(*)'));
      expect(countCall![1] as unknown[]).toContain('2025-01-01');
      expect(countCall![1] as unknown[]).toContain('2025-12-31');
    });
  });

  describe('GET /api/pages with combined filters', () => {
    it('should apply multiple filters simultaneously', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages?author=Alice&labels=howto&embeddingStatus=done',
      });

      expect(response.statusCode).toBe(200);
      const countCall = mockQueryFn.mock.calls.find((c: unknown[]) => (c[0] as string).includes('COUNT(*)'));
      const sql = countCall![0] as string;
      expect(sql).toContain('cp.author = $');
      expect(sql).toContain('cp.labels @>');
      expect(sql).toContain('cp.embedding_dirty = $');
    });
  });

  describe('GET /api/pages/filters', () => {
    it('should return distinct authors and labels', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('DISTINCT author')) {
          return { rows: [{ author: 'Alice' }, { author: 'Bob' }] };
        }
        if (typeof sql === 'string' && sql.includes('unnest(labels)')) {
          return { rows: [{ label: 'architecture' }, { label: 'howto' }] };
        }
        return { rows: [], rowCount: 0 };
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/filters',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.authors).toEqual(['Alice', 'Bob']);
      expect(body.labels).toEqual(['architecture', 'howto']);
    });
  });

  describe('GET /api/pages with invalid freshness value', () => {
    it('should reject invalid freshness value', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages?freshness=invalid',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/pages with invalid embeddingStatus value', () => {
    it('should reject invalid embeddingStatus value', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages?embeddingStatus=invalid',
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
