/**
 * Webhook emit-call-site tests for pages-crud (#114).
 *
 * Verifies that `emitWebhookEvent` fires with the expected event shape on the
 * success path AND is NOT called when the route bails before the canonical
 * mutation (validation, RBAC, not-found, conflict). The hook itself is a
 * no-op in CE — these tests just check that the route is wired to it.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesCrudRoutes } from './pages-crud.js';

// --- Mocks (mirror pages-crud-create.test.ts so imports resolve identically) ---

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

const mockEmitWebhookEvent = vi.fn();
vi.mock('../../core/services/webhook-emit-hook.js', () => ({
  emitWebhookEvent: (...args: unknown[]) => mockEmitWebhookEvent(...args),
}));

const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

const TEST_USER = 'user-1';

describe('pages-crud webhook emit call-sites', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: error.issues });
      }
      const statusCode = error.statusCode ?? 500;
      return reply.status(statusCode).send({ error: error.message });
    });

    app.decorate(
      'authenticate',
      async (request: { userId: string; username: string; userRole: string }) => {
        request.userId = TEST_USER;
        request.username = 'testuser';
        request.userRole = 'user';
      },
    );
    app.decorate(
      'requireAdmin',
      async (request: { userId: string; username: string; userRole: string }) => {
        request.userId = TEST_USER;
        request.username = 'testuser';
        request.userRole = 'admin';
      },
    );
    app.decorate('redis', {});

    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
  });

  // ── page.created ────────────────────────────────────────────────────────────

  describe('POST /api/pages — page.created', () => {
    it('emits page.created with isLocal=true on standalone create success', async () => {
      // INSERT returns new page
      mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 42, title: 'Hello', version: 1 }] });
      // Path/depth UPDATE
      mockQueryFn.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: { title: 'Hello', bodyHtml: '<p>Hello</p>', source: 'standalone' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockEmitWebhookEvent).toHaveBeenCalledTimes(1);
      const event = mockEmitWebhookEvent.mock.calls[0]![0];
      expect(event.eventType).toBe('page.created');
      expect(event.payload).toMatchObject({
        pageId: 42,
        title: 'Hello',
        isLocal: true,
        spaceKey: null,
      });
      expect(typeof event.payload.createdAt).toBe('string');
    });

    it('emits page.created with isLocal=false on Confluence create success', async () => {
      // Space lookup: confluence
      mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'confluence' }] });
      // INSERT (cache row) — UPDATE doesn't return rows for INSERT ... ON CONFLICT
      mockQueryFn.mockResolvedValueOnce({ rows: [] });

      mockGetClientForUser.mockResolvedValue({
        createPage: vi.fn().mockResolvedValue({
          id: 'conf-1',
          title: 'Hello',
          version: { number: 1 },
          body: { storage: { value: '<p>Hello</p>' } },
        }),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: { title: 'Hello', bodyHtml: '<p>Hello</p>', spaceKey: 'DEV', source: 'confluence' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockEmitWebhookEvent).toHaveBeenCalledTimes(1);
      const event = mockEmitWebhookEvent.mock.calls[0]![0];
      expect(event.eventType).toBe('page.created');
      expect(event.payload).toMatchObject({
        pageId: 'conf-1',
        title: 'Hello',
        isLocal: false,
        spaceKey: 'DEV',
      });
    });

    it('does NOT emit page.created when validation fails', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: { /* missing title */ bodyHtml: '<p>Hello</p>' },
      });

      expect(response.statusCode).toBe(400);
      expect(mockEmitWebhookEvent).not.toHaveBeenCalled();
    });

    it('does NOT emit page.created when parentId does not exist', async () => {
      // Parent lookup returns nothing
      mockQueryFn.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'Child',
          bodyHtml: '<p>Hello</p>',
          source: 'standalone',
          parentId: '999',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(mockEmitWebhookEvent).not.toHaveBeenCalled();
    });
  });

  // ── page.updated ────────────────────────────────────────────────────────────

  describe('PUT /api/pages/:id — page.updated', () => {
    it('emits page.updated on standalone update success', async () => {
      // SELECT existing page (standalone)
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          id: 7, version: 3, space_key: null, source: 'standalone',
          created_by_user_id: TEST_USER, visibility: 'shared',
          confluence_id: null, deleted_at: null, page_type: 'page',
        }],
      });
      // UPDATE
      mockQueryFn.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/7',
        payload: { title: 'New title', bodyHtml: '<p>updated</p>', version: 3 },
      });

      expect(response.statusCode).toBe(200);
      expect(mockEmitWebhookEvent).toHaveBeenCalledTimes(1);
      const event = mockEmitWebhookEvent.mock.calls[0]![0];
      expect(event.eventType).toBe('page.updated');
      expect(event.payload).toMatchObject({
        pageId: 7,
        title: 'New title',
        spaceKey: null,
      });
      expect(typeof event.payload.updatedAt).toBe('string');
    });

    it('emits page.updated on Confluence update success', async () => {
      // SELECT existing page (confluence)
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          id: 9, version: 5, space_key: 'OPS', source: 'confluence',
          created_by_user_id: null, visibility: 'shared',
          confluence_id: 'conf-9', deleted_at: null, page_type: 'page',
        }],
      });
      // UPDATE local cache after Confluence push
      mockQueryFn.mockResolvedValueOnce({ rows: [] });

      mockGetClientForUser.mockResolvedValue({
        updatePage: vi.fn().mockResolvedValue({
          version: { number: 6 },
          body: { storage: { value: '<p>updated</p>' } },
        }),
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/conf-9',
        payload: { title: 'New title', bodyHtml: '<p>updated</p>', version: 5 },
      });

      expect(response.statusCode).toBe(200);
      expect(mockEmitWebhookEvent).toHaveBeenCalledTimes(1);
      const event = mockEmitWebhookEvent.mock.calls[0]![0];
      expect(event.eventType).toBe('page.updated');
      expect(event.payload).toMatchObject({
        pageId: 9,
        title: 'New title',
        spaceKey: 'OPS',
      });
    });

    it('does NOT emit page.updated when version conflict occurs', async () => {
      // SELECT existing page with newer version than supplied
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          id: 7, version: 10, space_key: null, source: 'standalone',
          created_by_user_id: TEST_USER, visibility: 'shared',
          confluence_id: null, deleted_at: null, page_type: 'page',
        }],
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/7',
        payload: { title: 'Stale', bodyHtml: '<p>stale</p>', version: 3 },
      });

      expect(response.statusCode).toBe(409);
      expect(mockEmitWebhookEvent).not.toHaveBeenCalled();
    });

    it('does NOT emit page.updated when page is not found', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/99',
        payload: { title: 'Whatever', bodyHtml: '<p>x</p>' },
      });

      expect(response.statusCode).toBe(404);
      expect(mockEmitWebhookEvent).not.toHaveBeenCalled();
    });
  });

  // ── page.deleted ────────────────────────────────────────────────────────────

  describe('DELETE /api/pages/:id — page.deleted', () => {
    it('emits page.deleted with isHardDelete=false on standalone soft-delete', async () => {
      // SELECT existing page
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          id: 11, source: 'standalone', created_by_user_id: TEST_USER,
          confluence_id: null, space_key: null,
        }],
      });
      // UPDATE deleted_at
      mockQueryFn.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/11',
      });

      expect(response.statusCode).toBe(200);
      expect(mockEmitWebhookEvent).toHaveBeenCalledTimes(1);
      const event = mockEmitWebhookEvent.mock.calls[0]![0];
      expect(event.eventType).toBe('page.deleted');
      expect(event.payload).toEqual({ pageId: 11, isHardDelete: false });
    });

    it('emits page.deleted with isHardDelete=true on standalone permanent delete', async () => {
      // SELECT existing page
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          id: 12, source: 'standalone', created_by_user_id: TEST_USER,
          confluence_id: null, space_key: null,
        }],
      });
      // DELETE FROM pinned_pages, DELETE FROM pages
      mockQueryFn.mockResolvedValue({ rows: [] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/12?permanent=true',
      });

      expect(response.statusCode).toBe(200);
      expect(mockEmitWebhookEvent).toHaveBeenCalledTimes(1);
      const event = mockEmitWebhookEvent.mock.calls[0]![0];
      expect(event.eventType).toBe('page.deleted');
      expect(event.payload).toEqual({ pageId: 12, isHardDelete: true });
    });

    it('emits page.deleted with isHardDelete=true on Confluence delete success', async () => {
      // SELECT existing page (confluence)
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          id: 13, source: 'confluence', created_by_user_id: null,
          confluence_id: 'conf-13', space_key: 'DEV',
        }],
      });
      // DELETE FROM pinned_pages, DELETE FROM pages
      mockQueryFn.mockResolvedValue({ rows: [] });

      mockGetClientForUser.mockResolvedValue({
        deletePage: vi.fn().mockResolvedValue(undefined),
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/conf-13',
      });

      expect(response.statusCode).toBe(200);
      expect(mockEmitWebhookEvent).toHaveBeenCalledTimes(1);
      const event = mockEmitWebhookEvent.mock.calls[0]![0];
      expect(event.eventType).toBe('page.deleted');
      expect(event.payload).toEqual({ pageId: 13, isHardDelete: true });
    });

    it('does NOT emit page.deleted when page is not found', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/999',
      });

      expect(response.statusCode).toBe(404);
      expect(mockEmitWebhookEvent).not.toHaveBeenCalled();
    });

    it('does NOT emit page.deleted when caller is not the standalone owner', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          id: 15, source: 'standalone', created_by_user_id: 'someone-else',
          confluence_id: null, space_key: null,
        }],
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/15',
      });

      expect(response.statusCode).toBe(403);
      expect(mockEmitWebhookEvent).not.toHaveBeenCalled();
    });

    it('does NOT emit page.deleted when Confluence space access is denied', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          id: 16, source: 'confluence', created_by_user_id: null,
          confluence_id: 'conf-16', space_key: 'HR',
        }],
      });
      mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/conf-16',
      });

      expect(response.statusCode).toBe(403);
      expect(mockEmitWebhookEvent).not.toHaveBeenCalled();
    });
  });
});
