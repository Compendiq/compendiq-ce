import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesCrudRoutes } from './pages-crud.js';
import { ConfluenceError } from '../../domains/confluence/services/confluence-client.js';
import { cleanPageAttachments } from '../../domains/confluence/services/attachment-handler.js';

// --- Mocks ---

// Shared spies so tests can assert which invalidation path a delete took (#893).
const mockCacheInvalidate = vi.fn();
const mockCacheInvalidateAcrossUsers = vi.fn();
vi.mock('../../core/services/redis-cache.js', () => ({
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = (...args: unknown[]) => mockCacheInvalidate(...args);
    // Confluence deletes clear every user's cache (#893).
    invalidateAcrossUsers = (...args: unknown[]) => mockCacheInvalidateAcrossUsers(...args);
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

const mockQueryFn = vi.fn();
// Transaction client returned by getPool().connect() — since #766 the delete
// route finishes local cleanup in a BEGIN…COMMIT on a dedicated client.
const mockTxQueryFn = vi.fn();
const mockTxRelease = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({
    connect: () =>
      Promise.resolve({
        query: (...args: unknown[]) => mockTxQueryFn(...args),
        release: (...args: unknown[]) => mockTxRelease(...args),
      }),
  }),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

const TEST_USER = 'user-1';

describe('DELETE /api/pages/:id RBAC space access checks', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: error.errors });
      }
      const statusCode = error.statusCode ?? 500;
      return reply.status(statusCode).send({ error: error.message });
    });

    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = TEST_USER;
      request.username = 'testuser';
      request.userRole = 'user';
    });
    app.decorate('requireAdmin', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = TEST_USER;
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
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
    mockTxQueryFn.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('returns 403 when Confluence page is in a space the user cannot access, and deletePage is not called', async () => {
    const mockDeletePage = vi.fn().mockResolvedValue(undefined);
    mockGetClientForUser.mockResolvedValue({ deletePage: mockDeletePage });

    // Page exists in HR space (user only has DEV, OPS)
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('id, source, created_by_user_id')) {
        return Promise.resolve({
          rows: [{
            id: 10,
            source: 'confluence',
            created_by_user_id: null,
            confluence_id: 'page-100',
            space_key: 'HR',
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/pages/page-100',
    });

    expect(response.statusCode).toBe(403);
    // getUserAccessibleSpaces should have been called
    expect(mockGetUserAccessibleSpaces).toHaveBeenCalledWith(TEST_USER);
    // Critical security assertion: deletePage must NOT be called for unauthorized spaces
    expect(mockDeletePage).not.toHaveBeenCalled();
  });

  it('allows delete when Confluence page is in an accessible space', async () => {
    const mockDeletePage = vi.fn().mockResolvedValue(undefined);
    mockGetClientForUser.mockResolvedValue({ deletePage: mockDeletePage });

    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('id, source, created_by_user_id')) {
        return Promise.resolve({
          rows: [{
            id: 10,
            source: 'confluence',
            created_by_user_id: null,
            confluence_id: 'page-100',
            space_key: 'DEV',
          }],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/pages/page-100',
    });

    expect(response.statusCode).toBe(200);
    expect(mockDeletePage).toHaveBeenCalledWith('page-100');
    expect(mockGetUserAccessibleSpaces).toHaveBeenCalledWith(TEST_USER);
  });

  it('allows delete when Confluence page has null space_key (no space to check)', async () => {
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('id, source, created_by_user_id')) {
        return Promise.resolve({
          rows: [{
            id: 10,
            source: 'confluence',
            created_by_user_id: null,
            confluence_id: 'page-100',
            space_key: null,
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/pages/page-100',
    });

    // No space_key means no RBAC check — delete proceeds to Confluence API
    expect(response.statusCode).toBe(200);
  });

  it('still allows standalone page deletion by owner (no RBAC space check)', async () => {
    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('id, source, created_by_user_id')) {
        return Promise.resolve({
          rows: [{
            id: 10,
            source: 'standalone',
            created_by_user_id: TEST_USER,
            confluence_id: null,
            space_key: null,
          }],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/pages/10',
    });

    expect(response.statusCode).toBe(200);
    // getUserAccessibleSpaces should NOT have been called for standalone pages
    expect(mockGetUserAccessibleSpaces).not.toHaveBeenCalled();
  });

  it('allows delete with numeric ID when page is in accessible space', async () => {
    const mockDeletePage = vi.fn().mockResolvedValue(undefined);
    mockGetClientForUser.mockResolvedValue({ deletePage: mockDeletePage });

    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('id, source, created_by_user_id')) {
        return Promise.resolve({
          rows: [{
            id: 42,
            source: 'confluence',
            created_by_user_id: null,
            confluence_id: 'page-42',
            space_key: 'OPS',
          }],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/pages/42',
    });

    expect(response.statusCode).toBe(200);
    expect(mockDeletePage).toHaveBeenCalledWith('page-42');
  });

  // ── #893: cross-user cache invalidation on delete ──────────────────────────
  // A Confluence or shared standalone page is visible to other users, so its
  // deletion must clear every user's cached lists/trees — not just the deleter's.

  describe('cache invalidation (#893)', () => {
    it('invalidates pages AND spaces caches across all users on a Confluence delete', async () => {
      const mockDeletePage = vi.fn().mockResolvedValue(undefined);
      mockGetClientForUser.mockResolvedValue({ deletePage: mockDeletePage });

      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('id, source, created_by_user_id')) {
          return Promise.resolve({
            rows: [{
              id: 10,
              source: 'confluence',
              created_by_user_id: null,
              confluence_id: 'page-100',
              space_key: 'DEV',
              visibility: 'shared',
            }],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/page-100',
      });

      expect(response.statusCode).toBe(200);
      expect(mockCacheInvalidateAcrossUsers).toHaveBeenCalledWith('pages');
      // Deleting a Confluence page may drop its space, and the cached spaces
      // payload carries per-space pageCount — clear it for everyone too.
      expect(mockCacheInvalidateAcrossUsers).toHaveBeenCalledWith('spaces');
      expect(mockCacheInvalidate).not.toHaveBeenCalled();
    });

    it('invalidates the pages cache across all users when deleting a shared standalone page', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('id, source, created_by_user_id')) {
          return Promise.resolve({
            rows: [{
              id: 10,
              source: 'standalone',
              created_by_user_id: TEST_USER,
              confluence_id: null,
              space_key: null,
              visibility: 'shared',
            }],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/10',
      });

      expect(response.statusCode).toBe(200);
      expect(mockCacheInvalidateAcrossUsers).toHaveBeenCalledWith('pages');
      // Standalone pages never drop a Confluence space — the spaces cache stays.
      expect(mockCacheInvalidateAcrossUsers).not.toHaveBeenCalledWith('spaces');
    });

    it('keeps per-user invalidation when deleting a private standalone page', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('id, source, created_by_user_id')) {
          return Promise.resolve({
            rows: [{
              id: 10,
              source: 'standalone',
              created_by_user_id: TEST_USER,
              confluence_id: null,
              space_key: null,
              visibility: 'private',
            }],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/10',
      });

      expect(response.statusCode).toBe(200);
      expect(mockCacheInvalidateAcrossUsers).not.toHaveBeenCalled();
      expect(mockCacheInvalidate).toHaveBeenCalledWith(TEST_USER, 'pages');
    });
  });

  // ── #706: tolerate a Confluence page already deleted remotely ──────────────

  it('succeeds and cleans up locally when the Confluence page is already gone (404)', async () => {
    // deletePage rejects with a 404 — the remote page no longer exists.
    const mockDeletePage = vi.fn().mockRejectedValue(new ConfluenceError('Resource not found', 404));
    mockGetClientForUser.mockResolvedValue({ deletePage: mockDeletePage });

    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('id, source, created_by_user_id')) {
        return Promise.resolve({
          rows: [{
            id: 10,
            source: 'confluence',
            created_by_user_id: null,
            confluence_id: 'page-100',
            space_key: 'DEV',
          }],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/pages/page-100',
    });

    // A 404 means the desired end state (gone from Confluence) is already true —
    // the delete must succeed rather than surface "Resource not found".
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).message).toBe(
      'Page was already removed in Confluence — removed locally',
    );
    expect(mockDeletePage).toHaveBeenCalledWith('page-100');

    // Local cleanup must still run: the page row, pins and attachments are removed.
    // Since #766 the hard cleanup runs inside one transaction on a dedicated client.
    const pageDelete = mockTxQueryFn.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('DELETE FROM pages WHERE id = $1'),
    );
    expect(pageDelete).toBeDefined();
    const pinDelete = mockTxQueryFn.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('DELETE FROM pinned_pages'),
    );
    expect(pinDelete).toBeDefined();
    expect(mockTxQueryFn).toHaveBeenCalledWith('BEGIN');
    expect(mockTxQueryFn).toHaveBeenCalledWith('COMMIT');
    expect(cleanPageAttachments).toHaveBeenCalledWith(TEST_USER, 'page-100');
  });

  it('surfaces a non-404 Confluence error and does NOT delete locally (no data loss)', async () => {
    // deletePage rejects with a 5xx — Confluence genuinely failed.
    const mockDeletePage = vi.fn().mockRejectedValue(
      new ConfluenceError('Confluence API error: HTTP 503', 503),
    );
    mockGetClientForUser.mockResolvedValue({ deletePage: mockDeletePage });

    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('id, source, created_by_user_id')) {
        return Promise.resolve({
          rows: [{
            id: 10,
            source: 'confluence',
            created_by_user_id: null,
            confluence_id: 'page-100',
            space_key: 'DEV',
          }],
        });
      }
      // The #766 delete-intent soft-delete reports it updated the row.
      if (typeof sql === 'string' && sql.includes('UPDATE pages SET deleted_at = NOW()')) {
        return Promise.resolve({ rows: [{ id: 10 }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/pages/page-100',
    });

    // The error surfaces (any non-2xx) — it is not swallowed.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(mockDeletePage).toHaveBeenCalledWith('page-100');

    // Critical: the local row must NOT be deleted when the remote delete failed
    // for any reason other than 404 — otherwise we silently lose the page.
    const pageDelete = mockTxQueryFn.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('DELETE FROM pages WHERE id = $1'),
    );
    expect(pageDelete).toBeUndefined();
    expect(cleanPageAttachments).not.toHaveBeenCalled();

    // #766: the delete intent recorded before the upstream call is rolled back,
    // so the article stays fully live — neither side changed.
    const intentRestore = mockQueryFn.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('UPDATE pages SET deleted_at = NULL'),
    );
    expect(intentRestore).toBeDefined();
    expect(intentRestore![1]).toEqual([10]);
  });

  // ── #766: delete intent ordering + post-upstream failure containment ───────

  it('records the local delete intent (soft-delete) BEFORE calling Confluence', async () => {
    const mockDeletePage = vi.fn().mockResolvedValue(undefined);
    mockGetClientForUser.mockResolvedValue({ deletePage: mockDeletePage });

    let intentOrder = -1;
    let callIndex = 0;
    mockQueryFn.mockImplementation((sql: string) => {
      callIndex++;
      if (typeof sql === 'string' && sql.includes('id, source, created_by_user_id')) {
        return Promise.resolve({
          rows: [{ id: 10, source: 'confluence', created_by_user_id: null, confluence_id: 'page-100', space_key: 'DEV' }],
        });
      }
      if (typeof sql === 'string' && sql.includes('UPDATE pages SET deleted_at = NOW()')) {
        intentOrder = callIndex;
        // The upstream call must not have happened yet at this point.
        expect(mockDeletePage).not.toHaveBeenCalled();
        return Promise.resolve({ rows: [{ id: 10 }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const response = await app.inject({ method: 'DELETE', url: '/api/pages/page-100' });

    expect(response.statusCode).toBe(200);
    expect(intentOrder).toBeGreaterThan(0); // the intent soft-delete actually ran
    expect(mockDeletePage).toHaveBeenCalledWith('page-100');
  });

  it('leaves the row soft-deleted (hidden, NOT live) when local cleanup fails after a successful upstream delete', async () => {
    const mockDeletePage = vi.fn().mockResolvedValue(undefined);
    mockGetClientForUser.mockResolvedValue({ deletePage: mockDeletePage });

    mockQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('id, source, created_by_user_id')) {
        return Promise.resolve({
          rows: [{ id: 10, source: 'confluence', created_by_user_id: null, confluence_id: 'page-100', space_key: 'DEV' }],
        });
      }
      if (typeof sql === 'string' && sql.includes('UPDATE pages SET deleted_at = NOW()')) {
        return Promise.resolve({ rows: [{ id: 10 }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    // The hard-cleanup transaction blows up on the page row delete.
    mockTxQueryFn.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('DELETE FROM pages')) {
        return Promise.reject(new Error('connection terminated'));
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const response = await app.inject({ method: 'DELETE', url: '/api/pages/page-100' });

    // The user-visible outcome (page gone on both sides) is achieved — the row is
    // soft-deleted (hidden) and sync purges it later; the request succeeds.
    expect(response.statusCode).toBe(200);
    expect(mockTxQueryFn).toHaveBeenCalledWith('ROLLBACK');

    // Crucially the delete intent is NOT rolled back — the row must stay hidden,
    // never resurface as a live orphan (#766).
    const intentRestore = mockQueryFn.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('UPDATE pages SET deleted_at = NULL'),
    );
    expect(intentRestore).toBeUndefined();
  });
});
