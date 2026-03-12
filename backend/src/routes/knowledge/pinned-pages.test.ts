import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pinnedPagesRoutes } from './pinned-pages.js';

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
  getClientForUser: vi.fn().mockResolvedValue({
    deletePage: vi.fn().mockResolvedValue(undefined),
    getPage: vi.fn().mockResolvedValue({
      id: 'page-1',
      title: 'Test Page',
      body: { storage: { value: '<p>content</p>' } },
      version: { number: 1 },
    }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
  }),
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

const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

describe('Pinned Pages API', () => {
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

    await app.register(pinnedPagesRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/pages/pinned', () => {
    it('should return pinned articles for the current user', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          {
            page_id: 'page-1',
            pin_order: 0,
            pinned_at: new Date('2025-06-01T00:00:00Z'),
            confluence_id: 'page-1',
            space_key: 'DEV',
            title: 'Getting Started',
            author: 'Alice',
            last_modified_at: new Date('2025-05-20T00:00:00Z'),
            body_text: 'This is a getting started guide for new developers joining the team.',
          },
        ],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/pinned',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].id).toBe('page-1');
      expect(body.items[0].title).toBe('Getting Started');
      expect(body.items[0].spaceKey).toBe('DEV');
      expect(body.items[0].author).toBe('Alice');
      expect(body.items[0].excerpt).toBe('This is a getting started guide for new developers joining the team.');
      expect(body.total).toBe(1);
    });

    it('should return empty list when no pins exist', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/pinned',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.items).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('should truncate excerpt to 200 characters', async () => {
      const longText = 'A'.repeat(500);
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          page_id: 'page-1',
          pin_order: 0,
          pinned_at: new Date(),
          confluence_id: 'page-1',
          space_key: 'DEV',
          title: 'Long Page',
          author: null,
          last_modified_at: null,
          body_text: longText,
        }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/pinned',
      });

      const body = JSON.parse(response.body);
      expect(body.items[0].excerpt).toHaveLength(200);
    });
  });

  describe('POST /api/pages/:id/pin', () => {
    it('should pin a page successfully', async () => {
      // page exists check
      mockQueryFn.mockResolvedValueOnce({ rows: [{ confluence_id: 'page-1' }], rowCount: 1 });
      // already-pinned check (not pinned)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // atomic insert (succeeded)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/page-1/pin',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Page pinned');
      expect(body.pageId).toBe('page-1');
    });

    it('should return 404 when page does not exist', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/nonexistent/pin',
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 400 when max pin limit is reached', async () => {
      // page exists
      mockQueryFn.mockResolvedValueOnce({ rows: [{ confluence_id: 'page-1' }], rowCount: 1 });
      // already-pinned check (not pinned)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // atomic insert returns 0 rows (count >= MAX_PINS in subquery)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/page-1/pin',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Maximum of 8 pinned articles');
    });

    it('should be idempotent when pinning an already-pinned page', async () => {
      // page exists
      mockQueryFn.mockResolvedValueOnce({ rows: [{ confluence_id: 'page-1' }], rowCount: 1 });
      // already-pinned check (already pinned — early return)
      mockQueryFn.mockResolvedValueOnce({ rows: [{ page_id: 'page-1' }], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/page-1/pin',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Page pinned');
      // Should not have attempted the INSERT (only 2 queries, not 3)
      expect(mockQueryFn).toHaveBeenCalledTimes(2);
    });

    it('should return 200 when re-pinning an already-pinned page at max capacity', async () => {
      // page exists
      mockQueryFn.mockResolvedValueOnce({ rows: [{ confluence_id: 'page-1' }], rowCount: 1 });
      // already-pinned check (already pinned — early return before count check)
      mockQueryFn.mockResolvedValueOnce({ rows: [{ page_id: 'page-1' }], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/page-1/pin',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Page pinned');
      expect(body.pageId).toBe('page-1');
      // Only page-exists and already-pinned queries ran, no INSERT attempted
      expect(mockQueryFn).toHaveBeenCalledTimes(2);
    });

    it('should use atomic INSERT with count subquery to prevent race conditions', async () => {
      // page exists
      mockQueryFn.mockResolvedValueOnce({ rows: [{ confluence_id: 'page-1' }], rowCount: 1 });
      // already-pinned check (not pinned)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // atomic insert
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await app.inject({
        method: 'POST',
        url: '/api/pages/page-1/pin',
      });

      // The third call should be the atomic INSERT with subquery count check
      const insertCall = mockQueryFn.mock.calls[2];
      expect(insertCall[0]).toContain('SELECT $1, $2');
      expect(insertCall[0]).toContain('WHERE (SELECT COUNT(*) FROM pinned_pages WHERE user_id = $1) < $3');
      expect(insertCall[1]).toEqual(['test-user-id', 'page-1', 8]);
    });
  });

  describe('DELETE /api/pages/:id/pin', () => {
    it('should unpin a page successfully', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/page-1/pin',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Page unpinned');
      expect(body.pageId).toBe('page-1');
    });

    it('should return 404 when pin does not exist', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/nonexistent/pin',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('Per-user isolation', () => {
    it('should pass the correct userId to pinned pages query', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await app.inject({
        method: 'GET',
        url: '/api/pages/pinned',
      });

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('WHERE pp.user_id = $1'),
        ['test-user-id'],
      );
    });

    it('should pass the correct userId to pin insert', async () => {
      // page exists
      mockQueryFn.mockResolvedValueOnce({ rows: [{ confluence_id: 'page-1' }], rowCount: 1 });
      // already-pinned check (not pinned)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // atomic insert
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await app.inject({
        method: 'POST',
        url: '/api/pages/page-1/pin',
      });

      // The insert query should use userId
      const insertCall = mockQueryFn.mock.calls[2];
      expect(insertCall[1]).toContain('test-user-id');
    });
  });

  describe('Page deletion cleans up pinned_pages', () => {
    it('should delete pinned_pages row when single-deleting a page', async () => {
      // deletePage mock is handled by sync-service mock
      // pinned_pages delete
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // cached_pages delete (page_embeddings cascade-deleted via FK)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/page-1',
      });

      expect(response.statusCode).toBe(200);
      // First query after Confluence deletePage should be pinned_pages cleanup
      expect(mockQueryFn.mock.calls[0][0]).toContain('DELETE FROM pinned_pages');
      expect(mockQueryFn.mock.calls[0][1]).toEqual(['test-user-id', 'page-1']);
    });

    it('should delete pinned_pages row when bulk-deleting pages', async () => {
      // Bulk delete uses batched queries: ownership check, then parallel cleanup (pinned_pages, cached_pages)
      // page_embeddings are cascade-deleted via FK on cached_pages
      // batch ownership check via JOIN user_space_selections
      mockQueryFn.mockResolvedValueOnce({ rows: [{ confluence_id: 'page-1' }], rowCount: 1 });
      // batched pinned_pages delete via ANY($2)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // batched cached_pages delete via ANY($1)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: ['page-1'] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(1);

      // Second query (index 1) should be batched pinned_pages cleanup (after ownership check at index 0)
      expect(mockQueryFn.mock.calls[1][0]).toContain('DELETE FROM pinned_pages');
      expect(mockQueryFn.mock.calls[1][1]).toEqual(['test-user-id', ['page-1']]);
    });
  });
});
