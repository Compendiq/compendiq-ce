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
}));

const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

describe('Folder pages (#414)', () => {
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

  describe('POST /api/pages - folder creation', () => {
    it('should create a folder page with empty body', async () => {
      // INSERT returns new page
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 100, title: 'My Folder', version: 1 }],
      });
      // UPDATE path
      mockQueryFn.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'My Folder',
          bodyHtml: '<p>should be ignored</p>',
          pageType: 'folder',
          source: 'standalone',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.id).toBe(100);
      expect(body.pageType).toBe('folder');

      // The INSERT call should have empty body_html for folders
      const insertCall = mockQueryFn.mock.calls[0];
      const insertSql = insertCall[0] as string;
      expect(insertSql).toContain('INSERT INTO pages');
      // body_html (2nd param) should be empty string
      const insertParams = insertCall[1] as unknown[];
      expect(insertParams[1]).toBe(''); // effectiveBodyHtml
      expect(insertParams[2]).toBe(''); // bodyText
      expect(insertParams[7]).toBe('folder'); // page_type
    });

    it('should default to page type when pageType is not specified', async () => {
      // INSERT returns new page
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 101, title: 'Regular Page', version: 1 }],
      });
      // UPDATE path
      mockQueryFn.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'Regular Page',
          bodyHtml: '<p>Content here</p>',
          source: 'standalone',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.pageType).toBe('page');
    });
  });

  describe('PUT /api/pages/:id - folder update restrictions', () => {
    it('should reject body content updates on folder pages', async () => {
      // Existing page is a folder
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          id: 100,
          version: 1,
          space_key: null,
          source: 'standalone',
          created_by_user_id: 'test-user-id',
          visibility: 'shared',
          confluence_id: null,
          deleted_at: null,
          page_type: 'folder',
        }],
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/100',
        payload: {
          title: 'My Folder Updated',
          bodyHtml: '<p>This body should be rejected</p>',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toContain('Folder pages cannot have body content');
    });

    it('should allow title-only updates on folder pages', async () => {
      // Existing page is a folder
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          id: 100,
          version: 1,
          space_key: null,
          source: 'standalone',
          created_by_user_id: 'test-user-id',
          visibility: 'shared',
          confluence_id: null,
          deleted_at: null,
          page_type: 'folder',
        }],
      });
      // UPDATE query
      mockQueryFn.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/100',
        payload: {
          title: 'My Folder Renamed',
          bodyHtml: '',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.title).toBe('My Folder Renamed');
    });
  });

  describe('GET /api/pages/:id - folder response', () => {
    it('should return pageType in the response', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          id: 100,
          confluence_id: null,
          space_key: null,
          title: 'My Folder',
          page_type: 'folder',
          body_storage: '',
          body_html: '',
          body_text: '',
          version: 1,
          parent_id: null,
          labels: [],
          author: null,
          last_modified_at: null,
          last_synced: new Date(),
          embedding_dirty: false,
          embedding_status: 'not_embedded',
          embedded_at: null,
          embedding_error: null,
          has_children: true,
          quality_score: null,
          quality_status: null,
          quality_completeness: null,
          quality_clarity: null,
          quality_structure: null,
          quality_accuracy: null,
          quality_readability: null,
          quality_summary: null,
          quality_analyzed_at: null,
          quality_error: null,
          summary_html: null,
          summary_status: 'pending',
          summary_generated_at: null,
          summary_model: null,
          summary_error: null,
          source: 'standalone',
          visibility: 'shared',
          created_by_user_id: 'test-user-id',
          has_draft: false,
          draft_updated_at: null,
        }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/100',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.pageType).toBe('folder');
      expect(body.bodyHtml).toBe('');
    });
  });

  describe('GET /api/pages/tree - folder type in tree', () => {
    it('should include pageType in tree response items', async () => {
      // First query: local spaces lookup
      mockQueryFn.mockResolvedValueOnce({ rows: [] });
      // Second query: tree data
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          { id: 100, confluence_id: null, space_key: 'DEV', title: 'My Folder', page_type: 'folder', parent_numeric_id: null, labels: [], last_modified_at: null, embedding_dirty: false, embedding_status: 'not_embedded', embedded_at: null, embedding_error: null },
          { id: 101, confluence_id: null, space_key: 'DEV', title: 'Child Page', page_type: 'page', parent_numeric_id: 100, labels: [], last_modified_at: null, embedding_dirty: false, embedding_status: 'not_embedded', embedded_at: null, embedding_error: null },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/tree',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.items).toHaveLength(2);
      expect(body.items[0].pageType).toBe('folder');
      expect(body.items[1].pageType).toBe('page');
    });
  });
});
