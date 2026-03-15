import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesCrudRoutes } from './pages-crud.js';

// Mock external dependencies
vi.mock('../../core/services/redis-cache.js', () => {
  return {
    RedisCache: class MockRedisCache {
      get = vi.fn().mockResolvedValue(null);
      set = vi.fn().mockResolvedValue(undefined);
      invalidate = vi.fn().mockResolvedValue(undefined);
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

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: vi.fn().mockResolvedValue(['DEV']),
}));

const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

const listPageRow = {
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
  source: 'confluence',
  visibility: 'shared',
};

const detailPageRow = {
  ...listPageRow,
  body_storage: '<p>XHTML storage content</p>',
  body_html: '<p>Clean HTML content</p>',
  body_text: 'Plain text content',
  created_by_user_id: null,
  deleted_at: null,
  has_children: false,
};

describe('Page list vs detail response shapes (#179)', () => {
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

  describe('GET /api/pages (list)', () => {
    it('should NOT include body_html, body_text, or body_storage in the response', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
          return { rows: [{ count: '1' }] };
        }
        return { rows: [listPageRow], rowCount: 1 };
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items).toHaveLength(1);

      const item = body.items[0];
      // Body fields must NOT be present in list items
      expect(item).not.toHaveProperty('bodyHtml');
      expect(item).not.toHaveProperty('bodyText');
      expect(item).not.toHaveProperty('bodyStorage');
      expect(item).not.toHaveProperty('body_html');
      expect(item).not.toHaveProperty('body_text');
      expect(item).not.toHaveProperty('body_storage');

      // Summary fields MUST be present
      expect(item).toHaveProperty('id', 1);
      expect(item).toHaveProperty('confluenceId', 'page-1');
      expect(item).toHaveProperty('spaceKey', 'DEV');
      expect(item).toHaveProperty('title', 'Test Page');
      expect(item).toHaveProperty('version', 1);
      expect(item).toHaveProperty('labels', ['howto']);
      expect(item).toHaveProperty('author', 'Alice');
      expect(item).toHaveProperty('embeddingDirty', false);
    });

    it('should NOT select body columns in the SQL query', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
          return { rows: [{ count: '1' }] };
        }
        return { rows: [listPageRow], rowCount: 1 };
      });

      await app.inject({
        method: 'GET',
        url: '/api/pages',
      });

      // Find the SELECT query (not the COUNT query)
      const selectCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT cp.id'),
      );
      expect(selectCall).toBeDefined();

      const sql = selectCall![0] as string;
      // Extract SELECT clause only (before FROM) to avoid false positives from WHERE clause
      const selectClause = sql.substring(0, sql.indexOf('FROM'));
      expect(selectClause).not.toContain('body_html');
      expect(selectClause).not.toContain('body_text');
      expect(selectClause).not.toContain('body_storage');
    });

    it('should NOT select body columns even when search filter uses body_text in WHERE', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
          return { rows: [{ count: '1' }] };
        }
        return { rows: [listPageRow], rowCount: 1 };
      });

      await app.inject({
        method: 'GET',
        url: '/api/pages?search=test+query',
      });

      // Find the SELECT query (not the COUNT query)
      const selectCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT cp.id'),
      );
      expect(selectCall).toBeDefined();

      const sql = selectCall![0] as string;
      // The WHERE clause will reference body_text for full-text search, but the SELECT must not
      const selectClause = sql.substring(0, sql.indexOf('FROM'));
      expect(selectClause).not.toContain('body_html');
      expect(selectClause).not.toContain('body_text');
      expect(selectClause).not.toContain('body_storage');

      // Confirm the WHERE does reference body_text for search
      const whereClause = sql.substring(sql.indexOf('WHERE'));
      expect(whereClause).toContain('body_text');
    });

    it('should include pagination metadata', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
          return { rows: [{ count: '3' }] };
        }
        return { rows: [listPageRow], rowCount: 1 };
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages?page=1&limit=10',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('total', 3);
      expect(body).toHaveProperty('page', 1);
      expect(body).toHaveProperty('limit', 10);
      expect(body).toHaveProperty('totalPages', 1);
    });
  });

  describe('GET /api/pages/:id (detail)', () => {
    it('should include bodyHtml and bodyText in the response', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('roles') && sql.includes('editor')) {
          return { rows: [{ id: 3 }], rowCount: 1 };
        }
        return { rows: [detailPageRow], rowCount: 1 };
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/page-1',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Detail response MUST include body fields
      expect(body).toHaveProperty('bodyHtml', '<p>Clean HTML content</p>');
      expect(body).toHaveProperty('bodyText', 'Plain text content');

      // And also include summary fields
      expect(body).toHaveProperty('id', 1);
      expect(body).toHaveProperty('confluenceId', 'page-1');
      expect(body).toHaveProperty('spaceKey', 'DEV');
      expect(body).toHaveProperty('title', 'Test Page');
      expect(body).toHaveProperty('version', 1);
    });

    it('should select body_html and body_text in the detail SQL query', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('roles') && sql.includes('editor')) {
          return { rows: [{ id: 3 }], rowCount: 1 };
        }
        return { rows: [detailPageRow], rowCount: 1 };
      });

      await app.inject({
        method: 'GET',
        url: '/api/pages/page-1',
      });

      const selectCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('body_storage'),
      );
      expect(selectCall).toBeDefined();

      const sql = selectCall![0] as string;
      expect(sql).toContain('body_html');
      expect(sql).toContain('body_text');
      expect(sql).toContain('body_storage');
    });
  });
});
