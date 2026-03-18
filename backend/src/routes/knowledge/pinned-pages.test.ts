import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pinnedPagesRoutes } from './pinned-pages.js';
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

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  processDirtyPages: vi.fn().mockResolvedValue({ processed: 0, errors: 0 }),
  isProcessingUser: vi.fn().mockReturnValue(false),
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

import { getUserAccessibleSpaces as mockGetUserAccessibleSpaces } from '../../core/services/rbac-service.js';

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
    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/pages/pinned', () => {
    it('should return pinned articles using integer PK as id', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          {
            page_id: 42,
            pin_order: 0,
            pinned_at: new Date('2025-06-01T00:00:00Z'),
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
      expect(body.items[0].id).toBe('42');
      expect(body.items[0].title).toBe('Getting Started');
      expect(body.items[0].spaceKey).toBe('DEV');
      expect(body.items[0].author).toBe('Alice');
      expect(body.items[0].excerpt).toBe('This is a getting started guide for new developers joining the team.');
      expect(body.total).toBe(1);
    });

    it('should JOIN on pages.id instead of confluence_id', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await app.inject({
        method: 'GET',
        url: '/api/pages/pinned',
      });

      const sql = mockQueryFn.mock.calls[0][0] as string;
      expect(sql).toContain('JOIN pages cp ON cp.id = pp.page_id');
      expect(sql).not.toContain('cp.confluence_id = pp.page_id');
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
          page_id: 42,
          pin_order: 0,
          pinned_at: new Date(),
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
    it('should pin a page by integer PK', async () => {
      // page exists check (uses integer PK)
      mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 });
      // already-pinned check (not pinned)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // atomic insert (succeeded)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/42/pin',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Page pinned');
      expect(body.pageId).toBe('42');

      // Verify the page existence query uses integer PK
      const existsQuery = mockQueryFn.mock.calls[0][0] as string;
      expect(existsQuery).toContain('cp.id = $2');
      expect(existsQuery).not.toContain('confluence_id');

      // Verify the insert stores the integer PK
      expect(mockQueryFn.mock.calls[2][1]).toEqual(['test-user-id', 42, 8]);
    });

    it('should return 404 when page does not exist', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/999/pin',
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 400 for non-numeric page ID', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/not-a-number/pin',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 when max pin limit is reached', async () => {
      // page exists
      mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 });
      // already-pinned check (not pinned)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // atomic insert returns 0 rows (count >= MAX_PINS in subquery)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/42/pin',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Maximum of 8 pinned articles');
    });

    it('should be idempotent when pinning an already-pinned page', async () => {
      // page exists
      mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 });
      // already-pinned check (already pinned — early return)
      mockQueryFn.mockResolvedValueOnce({ rows: [{ page_id: 42 }], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/42/pin',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Page pinned');
      // Should not have attempted the INSERT (only 2 queries, not 3)
      expect(mockQueryFn).toHaveBeenCalledTimes(2);
    });

    it('should return 200 when re-pinning an already-pinned page at max capacity', async () => {
      // page exists
      mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 });
      // already-pinned check (already pinned — early return before count check)
      mockQueryFn.mockResolvedValueOnce({ rows: [{ page_id: 42 }], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/42/pin',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Page pinned');
      expect(body.pageId).toBe('42');
      // Only page-exists and already-pinned queries ran, no INSERT attempted
      expect(mockQueryFn).toHaveBeenCalledTimes(2);
    });

    it('should filter out soft-deleted pages', async () => {
      // page exists check returns nothing (page is soft-deleted, excluded by deleted_at IS NULL)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/42/pin',
      });

      expect(response.statusCode).toBe(404);
      // Verify the query includes deleted_at filter
      const sql = mockQueryFn.mock.calls[0][0] as string;
      expect(sql).toContain('deleted_at IS NULL');
    });

    it('should use atomic INSERT with count subquery to prevent race conditions', async () => {
      // page exists
      mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 });
      // already-pinned check (not pinned)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // atomic insert
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await app.inject({
        method: 'POST',
        url: '/api/pages/42/pin',
      });

      // The third call should be the atomic INSERT with subquery count check
      const insertCall = mockQueryFn.mock.calls[2];
      expect(insertCall[0]).toContain('SELECT $1, $2');
      expect(insertCall[0]).toContain('WHERE (SELECT COUNT(*) FROM pinned_pages WHERE user_id = $1) < $3');
      expect(insertCall[1]).toEqual(['test-user-id', 42, 8]);
    });
  });

  describe('DELETE /api/pages/:id/pin', () => {
    it('should unpin a page by integer PK', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/42/pin',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Page unpinned');
      expect(body.pageId).toBe('42');

      // Verify the delete uses integer PK directly (no confluence_id resolution)
      expect(mockQueryFn.mock.calls[0][1]).toEqual(['test-user-id', 42]);
    });

    it('should return 404 when pin does not exist', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/999/pin',
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 400 for non-numeric page ID', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/not-a-number/pin',
      });

      expect(response.statusCode).toBe(400);
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
      mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 });
      // already-pinned check (not pinned)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // atomic insert
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await app.inject({
        method: 'POST',
        url: '/api/pages/42/pin',
      });

      // The insert query should use userId
      const insertCall = mockQueryFn.mock.calls[2];
      expect(insertCall[1]).toContain('test-user-id');
    });
  });

  describe('RBAC integration (#409)', () => {
    it('should use getUserAccessibleSpaces for page existence check when pinning', async () => {
      // getUserAccessibleSpaces returns ['DEV', 'OPS'] by default
      // page exists in DEV space — should succeed
      mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/42/pin',
      });

      expect(response.statusCode).toBe(200);
      // The page existence query should filter by RBAC-accessible spaces
      const pageQuery = mockQueryFn.mock.calls[0][0] as string;
      expect(pageQuery).toContain('space_key = ANY($1::text[])');
      expect(mockGetUserAccessibleSpaces).toHaveBeenCalledWith('test-user-id');
    });

    it('should return 404 when user has no RBAC-accessible spaces', async () => {
      // Override the mock to return empty spaces
      (mockGetUserAccessibleSpaces as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      // No page matches empty space list
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/42/pin',
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 when page is not in users accessible spaces', async () => {
      // getUserAccessibleSpaces returns ['DEV', 'OPS'] but page is in 'HR'
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/42/pin',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('Standalone page pinning (no confluence_id)', () => {
    it('should pin a standalone page that has no confluence_id', async () => {
      // Standalone page found by integer PK (confluence_id is NULL)
      mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 100 }], rowCount: 1 });
      // Not already pinned
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // Insert succeeds
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/100/pin',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Page pinned');
      expect(body.pageId).toBe('100');

      // Verify the insert stores the integer PK
      expect(mockQueryFn.mock.calls[2][1]).toEqual(['test-user-id', 100, 8]);
    });

    it('should unpin a standalone page that has no confluence_id', async () => {
      // Direct delete by integer PK — no confluence_id resolution needed
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/100/pin',
      });

      expect(response.statusCode).toBe(200);
      expect(mockQueryFn.mock.calls[0][1]).toEqual(['test-user-id', 100]);
    });
  });

  describe('Page deletion cleans up pinned_pages', () => {
    it('should delete pinned_pages row when single-deleting a page', async () => {
      // First query: load page to determine source (new standalone-aware lookup)
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 42, source: 'confluence', created_by_user_id: null, confluence_id: 'page-1' }],
        rowCount: 1,
      });
      // pinned_pages delete
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // pages delete (page_embeddings cascade-deleted via FK)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/page-1',
      });

      expect(response.statusCode).toBe(200);
      // Second query (after page lookup) should be pinned_pages cleanup
      expect(mockQueryFn.mock.calls[1][0]).toContain('DELETE FROM pinned_pages');
      expect(mockQueryFn.mock.calls[1][1]).toEqual(['test-user-id', 42]);
    });

    it('should delete pinned_pages row when bulk-deleting pages', async () => {
      // Bulk delete uses batched queries: ownership check, then parallel cleanup (pinned_pages, pages)
      // page_embeddings are cascade-deleted via FK on pages
      // batch ownership check via RBAC space access
      mockQueryFn.mockResolvedValueOnce({ rows: [{ confluence_id: 'page-1', space_key: 'DEV' }], rowCount: 1 });
      // batched pinned_pages delete via ANY($2)
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // batched pages delete via ANY($1)
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
