import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesCrudRoutes } from './pages-crud.js';

const mockConfluenceToHtml = vi.fn().mockReturnValue('<p>content</p>');

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
      title: 'Updated Title',
      body: { storage: { value: '<p>new content</p>' } },
      version: { number: 2 },
    }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../core/services/content-converter.js', () => ({
  htmlToConfluence: vi.fn().mockReturnValue('<p>content</p>'),
  confluenceToHtml: (...args: unknown[]) => mockConfluenceToHtml(...args),
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

const mockProcessDirtyPages = vi.fn().mockResolvedValue({ processed: 2, errors: 0 });
const mockIsProcessingUser = vi.fn().mockResolvedValue(false);
vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  processDirtyPages: (...args: unknown[]) => mockProcessDirtyPages(...args),
  isProcessingUser: (...args: unknown[]) => mockIsProcessingUser(...args),
  computePageRelationships: vi.fn().mockResolvedValue(0),
}));

// Mock the database with a function we can control per test
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: vi.fn().mockResolvedValue(['DEV', 'OPS']),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import { cleanPageAttachments } from '../../domains/confluence/services/attachment-handler.js';

describe('Bulk Pages Routes (Parallelized)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    // Match production error handler for Zod validation errors
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

    // Decorate with mock auth and redis
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
    mockConfluenceToHtml.mockReturnValue('<p>content</p>');
    // Default: batch ownership query returns both pages
    // Note: confluence_id matches the IDs sent by delete/sync tests ('page-1', 'page-2')
    // Tag tests override this default with their own mocks using integer PKs
    mockQueryFn.mockResolvedValue({
      rows: [
        { id: 1, confluence_id: 'page-1', space_key: 'OPS', source: 'confluence', labels: ['existing-tag'] },
        { id: 2, confluence_id: 'page-2', space_key: 'ENG', source: 'confluence', labels: ['existing-tag'] },
      ],
      rowCount: 2,
    });
  });

  describe('POST /api/pages/bulk/delete', () => {
    it('should delete multiple pages', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: ['page-1', 'page-2'] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(2);
      expect(body.failed).toBe(0);
      expect(body.errors).toEqual([]);
    });

    it('should return 400 for empty ids', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [] },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should report not-found pages from batch ownership check', async () => {
      // Batch query returns only page-2 (not-found is missing)
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 2, confluence_id: 'page-2', source: 'confluence' }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: ['not-found', 'page-2'] },
      });

      const body = JSON.parse(response.body);
      expect(body.failed).toBe(1);
      expect(body.succeeded).toBe(1);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toContain('not found');
    });

    it('should report Confluence pages as failed when Confluence not configured', async () => {
      (getClientForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, confluence_id: 'page-1', source: 'confluence', space_key: 'DEV' }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: ['page-1'] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(0);
      expect(body.failed).toBe(1);
      expect(body.errors[0]).toContain('Confluence not configured');
    });

    it('should delete standalone pages without Confluence configured', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 42, confluence_id: null, source: 'standalone', space_key: null }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: ['42'] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(1);
      expect(body.failed).toBe(0);
      expect(getClientForUser).not.toHaveBeenCalled();
    });

    it('should use batch DELETE queries with ANY()', async () => {
      // Single page owned
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, confluence_id: 'page-1', source: 'confluence', space_key: 'OPS' }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: ['page-1'] },
      });

      expect(response.statusCode).toBe(200);

      // Verify pages DELETE uses ANY($1) (no user_id in shared table)
      // and pinned_pages DELETE uses ANY($2) (user_id=$1, page_id=ANY($2))
      const cachedPageDelete = mockQueryFn.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' &&
          (call[0] as string).includes('DELETE FROM pages'),
      );
      expect(cachedPageDelete).toBeDefined();
      expect(cachedPageDelete![0]).toContain('ANY($1)');

      const pinnedDelete = mockQueryFn.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' &&
          (call[0] as string).includes('DELETE FROM pinned_pages'),
      );
      expect(pinnedDelete).toBeDefined();
      expect(pinnedDelete![0]).toContain('page_id = ANY($2');
    });

    it('should call cleanPageAttachments for each deleted page', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, confluence_id: 'page-1', source: 'confluence' }, { id: 2, confluence_id: 'page-2', source: 'confluence' }],
        rowCount: 2,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: ['page-1', 'page-2'] },
      });

      expect(response.statusCode).toBe(200);
      expect(cleanPageAttachments).toHaveBeenCalledTimes(2);
      expect(cleanPageAttachments).toHaveBeenCalledWith('test-user-id', 'page-1');
      expect(cleanPageAttachments).toHaveBeenCalledWith('test-user-id', 'page-2');
    });

    it('should delete mixed standalone and Confluence pages in one request', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          { id: 42, confluence_id: null, source: 'standalone', space_key: null },
          { id: 1, confluence_id: 'page-1', source: 'confluence', space_key: 'OPS' },
        ],
        rowCount: 2,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: ['42', 'page-1'] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(2);
      expect(body.failed).toBe(0);

      // Standalone page should be soft-deleted
      const softDelete = mockQueryFn.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('UPDATE pages SET deleted_at'),
      );
      expect(softDelete).toBeDefined();

      // Confluence page should be hard-deleted
      const hardDelete = mockQueryFn.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('DELETE FROM pages'),
      );
      expect(hardDelete).toBeDefined();
    });

    it('should handle partial Confluence delete failures', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, confluence_id: 'page-1', source: 'confluence' }, { id: 2, confluence_id: 'page-2', source: 'confluence' }],
        rowCount: 2,
      });

      // Set up a new client mock where deletePage fails on the second call
      let callCount = 0;
      const failingClient = {
        deletePage: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 2) return Promise.reject(new Error('Confluence error'));
          return Promise.resolve(undefined);
        }),
        getPage: vi.fn(),
        addLabels: vi.fn(),
        removeLabel: vi.fn(),
      };
      (getClientForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce(failingClient);

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: ['page-1', 'page-2'] },
      });

      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(1);
      expect(body.failed).toBe(1);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toContain('Confluence error');
    });
  });

  describe('POST /api/pages/bulk/sync', () => {
    it('should re-sync multiple pages', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/sync',
        payload: { ids: ['page-1', 'page-2'] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(2);
      expect(body.failed).toBe(0);
    });

    it('should return 400 for empty ids', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/sync',
        payload: { ids: [] },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should report not-found pages in sync', async () => {
      // Batch query returns only page-1 (page-999 not found)
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ confluence_id: 'page-1' }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/sync',
        payload: { ids: ['page-1', 'page-999'] },
      });

      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(1);
      expect(body.failed).toBe(1);
      expect(body.errors[0]).toContain('page-999');
      expect(body.errors[0]).toContain('not found');
    });

    it('should use batch ownership query with ANY()', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ confluence_id: 'page-1', space_key: 'OPS' }],
        rowCount: 1,
      });

      await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/sync',
        payload: { ids: ['page-1'] },
      });

      // First query call should be the batch ownership check
      const firstCall = mockQueryFn.mock.calls[0];
      expect(firstCall[0]).toContain('ANY($2)');
    });

    it('passes cached space keys into confluenceToHtml during bulk sync', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/sync',
        payload: { ids: ['page-1', 'page-2'] },
      });

      expect(response.statusCode).toBe(200);
      expect(mockConfluenceToHtml).toHaveBeenCalledWith('<p>new content</p>', 'page-1', 'OPS');
      expect(mockConfluenceToHtml).toHaveBeenCalledWith('<p>new content</p>', 'page-2', 'ENG');
    });
  });

  describe('POST /api/pages/bulk/embed', () => {
    it('should mark pages as embedding dirty and trigger processing', async () => {
      // The new code uses UPDATE...RETURNING, so mock must return rows
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ confluence_id: 'page-1' }, { confluence_id: 'page-2' }],
        rowCount: 2,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/embed',
        payload: { ids: ['page-1', 'page-2'] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(2);

      // Verify processDirtyPages was called fire-and-forget
      await vi.waitFor(() => {
        expect(mockProcessDirtyPages).toHaveBeenCalledWith('test-user-id');
      });
    });

    it('should not trigger processing when no pages succeeded', async () => {
      mockQueryFn.mockResolvedValue({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/embed',
        payload: { ids: ['nonexistent'] },
      });

      const body = JSON.parse(response.body);
      expect(body.failed).toBe(1);
      expect(mockProcessDirtyPages).not.toHaveBeenCalled();
    });

    it('should report failure for non-existent page', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/embed',
        payload: { ids: ['nonexistent'] },
      });

      const body = JSON.parse(response.body);
      expect(body.failed).toBe(1);
      expect(body.errors[0]).toContain('not found');
    });

    it('should return 409 when embedding is already in progress', async () => {
      mockIsProcessingUser.mockResolvedValueOnce(true);

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/embed',
        payload: { ids: ['page-1'] },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('already in progress');
    });

    it('should use single batch UPDATE with ANY() and RETURNING', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ confluence_id: 'page-1' }],
        rowCount: 1,
      });

      await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/embed',
        payload: { ids: ['page-1'] },
      });

      // The embed endpoint now issues a single UPDATE...RETURNING query
      // ids are ANY($1), userId is $2 in subquery for space_key access control
      const embedCall = mockQueryFn.mock.calls[0];
      expect(embedCall[0]).toContain('ANY($1)');
      expect(embedCall[0]).toContain('RETURNING');
    });
  });

  describe('POST /api/pages/bulk/tag', () => {
    it('should add tags to multiple pages', async () => {
      // Override default mock to return only page 1 for this single-ID test
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, confluence_id: 'conf-1', labels: ['existing-tag'] }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: {
          ids: ['1'],
          addTags: ['new-tag-1', 'new-tag-2'],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(1);
    });

    it('should remove tags from multiple pages', async () => {
      // Override default mock to return only page 1 for this single-ID test
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, confluence_id: 'conf-1', labels: ['existing-tag'] }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: {
          ids: ['1'],
          removeTags: ['existing-tag'],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(1);
    });

    it('should reject when neither addTags nor removeTags provided', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: { ids: ['page-1'] },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject empty ids', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: { ids: [], addTags: ['tag'] },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should sync added tags to Confluence', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, confluence_id: 'conf-1', labels: ['existing-tag'] }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: {
          ids: ['1'],
          addTags: ['new-tag'],
        },
      });

      expect(response.statusCode).toBe(200);
      const client = await vi.mocked(getClientForUser).mock.results[0].value;
      expect(client.addLabels).toHaveBeenCalledWith('conf-1', ['new-tag']);
    });

    it('should sync removed tags to Confluence', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, confluence_id: 'conf-1', labels: ['existing-tag'] }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: {
          ids: ['1'],
          removeTags: ['existing-tag'],
        },
      });

      expect(response.statusCode).toBe(200);
      const client = await vi.mocked(getClientForUser).mock.results[0].value;
      expect(client.removeLabel).toHaveBeenCalledWith('conf-1', 'existing-tag');
    });

    it('should use batch label fetch with ANY()', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, confluence_id: 'conf-1', labels: ['existing-tag'] }],
        rowCount: 1,
      });

      await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: {
          ids: ['1'],
          addTags: ['new-tag'],
        },
      });

      // First query should be the batch label fetch using integer PK
      const firstCall = mockQueryFn.mock.calls[0];
      expect(firstCall[0]).toContain('ANY($2');
      expect(firstCall[0]).toContain('labels');
    });

    it('should report not-found pages in tag operation', async () => {
      // Batch query returns only page 1 (page 999 not found)
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, confluence_id: 'conf-1', labels: ['existing-tag'] }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: {
          ids: ['1', '999'],
          addTags: ['new-tag'],
        },
      });

      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(1);
      expect(body.failed).toBe(1);
      expect(body.errors[0]).toContain('999');
      expect(body.errors[0]).toContain('not found');
    });

    it('should report non-numeric IDs as not found in bulk tag operation', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, confluence_id: 'conf-1', labels: ['existing-tag'] }],
        rowCount: 1,
      });
      // Mock UPDATE query
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: {
          ids: ['1', 'abc', 'not-a-number'],
          addTags: ['new-tag'],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      // Non-numeric IDs are filtered out and reported as not found
      expect(body.succeeded).toBe(1);
      expect(body.failed).toBe(2);
      expect(body.errors).toHaveLength(2);
      expect(body.errors.some((e: string) => e.includes('abc'))).toBe(true);
      expect(body.errors.some((e: string) => e.includes('not-a-number'))).toBe(true);
    });

    it('should handle standalone pages (no confluence_id) without Confluence sync (#442)', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 50, confluence_id: null, labels: [] }],
        rowCount: 1,
      });
      // Mock UPDATE query
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: {
          ids: ['50'],
          addTags: ['standalone-tag'],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(1);
      expect(body.failed).toBe(0);

      // Verify UPDATE used integer PK
      const updateCall = mockQueryFn.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('UPDATE pages SET labels'),
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![0]).toContain('WHERE id = $1');
    });

    // EE #117 — confirm the additive bulk/tag route now emits exactly one
    // BULK_PAGE_TAGGED audit event per request (not per row). Audit-volume
    // mitigation per epic v0.4 §3.6 / R8.
    it('emits exactly one BULK_PAGE_TAGGED audit event for the whole request', async () => {
      const { logAuditEvent } = await import('../../core/services/audit-service.js');
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          { id: 1, confluence_id: 'conf-1', labels: ['existing-tag'] },
          { id: 2, confluence_id: 'conf-2', labels: [] },
          { id: 3, confluence_id: 'conf-3', labels: [] },
        ],
        rowCount: 3,
      });

      await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: { ids: ['1', '2', '3'], addTags: ['shared'] },
      });

      const calls = vi.mocked(logAuditEvent).mock.calls;
      const bulkTaggedCalls = calls.filter((c) => c[1] === 'BULK_PAGE_TAGGED');
      expect(bulkTaggedCalls).toHaveLength(1);
      const meta = bulkTaggedCalls[0]?.[4] as Record<string, unknown>;
      expect(meta.bulkIds).toEqual(['1', '2', '3']);
      expect(meta.addTags).toEqual(['shared']);
      expect(meta.succeeded).toBe(3);
      expect(meta.failed).toBe(0);
    });
  });

  describe('POST /api/pages/bulk/replace-tags', () => {
    it('should replace the entire tag set on the targeted pages', async () => {
      // Page 1 has existing labels ['old-a', 'old-b'] → after replace they are
      // wiped and ['kept'] survives only because the input contains it.
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, confluence_id: 'conf-1', labels: ['old-a', 'old-b'] }],
        rowCount: 1,
      });
      // UPDATE query
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/replace-tags',
        payload: { ids: ['1'], tags: ['kept'] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(1);
      expect(body.failed).toBe(0);
      expect(body.cancelled).toBe(false);

      // The UPDATE should write the new tag set to the page
      const updateCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE pages SET labels'),
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toEqual([1, ['kept']]);
    });

    it('normalises tags (lowercase, trim, dedupe) before persisting', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, confluence_id: null, labels: [] }],
        rowCount: 1,
      });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/replace-tags',
        payload: {
          ids: ['1'],
          tags: ['  Bug  ', 'BUG', 'feature', 'feature', '   '],
        },
      });

      expect(response.statusCode).toBe(200);
      const updateCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE pages SET labels'),
      );
      expect(updateCall![1]).toEqual([1, ['bug', 'feature']]);
    });

    it('syncs the diff to Confluence: adds new tags, removes dropped ones', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, confluence_id: 'conf-1', labels: ['old-a', 'old-b'] }],
        rowCount: 1,
      });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/replace-tags',
        payload: { ids: ['1'], tags: ['old-a', 'new'] },
      });

      const client = await vi.mocked(getClientForUser).mock.results[0].value;
      expect(client.addLabels).toHaveBeenCalledWith('conf-1', ['new']);
      expect(client.removeLabel).toHaveBeenCalledWith('conf-1', 'old-b');
    });

    it('reports not-found pages without aborting the request', async () => {
      // RBAC fetch returns only page 1; page 999 is not found.
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, confluence_id: null, labels: [] }],
        rowCount: 1,
      });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/replace-tags',
        payload: { ids: ['1', '999'], tags: ['t'] },
      });

      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(1);
      expect(body.failed).toBe(1);
      expect(body.errors[0]).toContain('999');
      expect(body.errors[0]).toContain('not found');
    });

    it('rejects empty ids', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/replace-tags',
        payload: { ids: [], tags: ['t'] },
      });
      expect(response.statusCode).toBe(400);
    });

    // Audit-count invariant: one BULK_PAGE_TAGS_REPLACED event per request,
    // never per affected page (epic v0.4 §3.6 / R8).
    it('emits exactly one BULK_PAGE_TAGS_REPLACED audit event for the whole request', async () => {
      const { logAuditEvent } = await import('../../core/services/audit-service.js');
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          { id: 1, confluence_id: 'conf-1', labels: ['old-a'] },
          { id: 2, confluence_id: 'conf-2', labels: ['old-b'] },
          { id: 3, confluence_id: null, labels: [] },
        ],
        rowCount: 3,
      });
      mockQueryFn.mockResolvedValue({ rows: [], rowCount: 1 });

      await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/replace-tags',
        payload: { ids: ['1', '2', '3'], tags: ['shared'] },
      });

      const calls = vi.mocked(logAuditEvent).mock.calls;
      const replacedCalls = calls.filter((c) => c[1] === 'BULK_PAGE_TAGS_REPLACED');
      expect(replacedCalls).toHaveLength(1);
      const meta = replacedCalls[0]?.[4] as Record<string, unknown>;
      expect(meta.tags).toEqual(['shared']);
      expect(meta.succeeded).toBe(3);
      expect(meta.failed).toBe(0);
      expect(meta.cancelled).toBe(false);
    });

    it('partial-apply: emits ONE audit event whose metadata reflects the failure count', async () => {
      // Two pages eligible from RBAC; the first UPDATE rejects (simulated DB
      // failure) so we expect succeeded=1, failed=1 in the single audit row.
      const { logAuditEvent } = await import('../../core/services/audit-service.js');
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          { id: 1, confluence_id: 'conf-1', labels: [] },
          { id: 2, confluence_id: 'conf-2', labels: [] },
        ],
        rowCount: 2,
      });
      // First UPDATE rejects, second succeeds.
      let updateCallIdx = 0;
      mockQueryFn.mockImplementation((sql: string) => {
        if (sql.includes('UPDATE pages SET labels')) {
          updateCallIdx++;
          if (updateCallIdx === 1) {
            return Promise.reject(new Error('simulated DB failure'));
          }
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/replace-tags',
        payload: { ids: ['1', '2'], tags: ['new'] },
      });

      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(1);
      expect(body.failed).toBe(1);
      expect(body.errors.some((e: string) => e.includes('simulated DB failure'))).toBe(true);

      const replacedCalls = vi.mocked(logAuditEvent).mock.calls.filter((c) => c[1] === 'BULK_PAGE_TAGS_REPLACED');
      expect(replacedCalls).toHaveLength(1);
      const meta = replacedCalls[0]?.[4] as Record<string, unknown>;
      expect(meta.succeeded).toBe(1);
      expect(meta.failed).toBe(1);
    });
  });
});
