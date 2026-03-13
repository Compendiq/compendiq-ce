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
    mockQueryFn.mockResolvedValue({
      rows: [
        { confluence_id: 'page-1', space_key: 'OPS', labels: ['existing-tag'] },
        { confluence_id: 'page-2', space_key: 'ENG', labels: ['existing-tag'] },
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
        rows: [{ confluence_id: 'page-2' }],
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

    it('should return 400 when Confluence not configured', async () => {
      (getClientForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: ['page-1'] },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should use batch DELETE queries with ANY()', async () => {
      // Single page owned
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ confluence_id: 'page-1' }],
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
      expect(pinnedDelete![0]).toContain('ANY($2)');
    });

    it('should call cleanPageAttachments for each deleted page', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ confluence_id: 'page-1' }, { confluence_id: 'page-2' }],
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

    it('should handle partial Confluence delete failures', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ confluence_id: 'page-1' }, { confluence_id: 'page-2' }],
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
      // Override default mock to return only page-1 for this single-ID test
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ confluence_id: 'page-1', labels: ['existing-tag'] }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: {
          ids: ['page-1'],
          addTags: ['new-tag-1', 'new-tag-2'],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(1);
    });

    it('should remove tags from multiple pages', async () => {
      // Override default mock to return only page-1 for this single-ID test
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ confluence_id: 'page-1', labels: ['existing-tag'] }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: {
          ids: ['page-1'],
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
        rows: [{ confluence_id: 'page-1', labels: ['existing-tag'] }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: {
          ids: ['page-1'],
          addTags: ['new-tag'],
        },
      });

      expect(response.statusCode).toBe(200);
      const client = await vi.mocked(getClientForUser).mock.results[0].value;
      expect(client.addLabels).toHaveBeenCalledWith('page-1', ['new-tag']);
    });

    it('should sync removed tags to Confluence', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ confluence_id: 'page-1', labels: ['existing-tag'] }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: {
          ids: ['page-1'],
          removeTags: ['existing-tag'],
        },
      });

      expect(response.statusCode).toBe(200);
      const client = await vi.mocked(getClientForUser).mock.results[0].value;
      expect(client.removeLabel).toHaveBeenCalledWith('page-1', 'existing-tag');
    });

    it('should use batch label fetch with ANY()', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ confluence_id: 'page-1', labels: ['existing-tag'] }],
        rowCount: 1,
      });

      await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: {
          ids: ['page-1'],
          addTags: ['new-tag'],
        },
      });

      // First query should be the batch label fetch
      const firstCall = mockQueryFn.mock.calls[0];
      expect(firstCall[0]).toContain('ANY($2)');
      expect(firstCall[0]).toContain('labels');
    });

    it('should report not-found pages in tag operation', async () => {
      // Batch query returns only page-1 (page-999 not found)
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ confluence_id: 'page-1', labels: ['existing-tag'] }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: {
          ids: ['page-1', 'page-999'],
          addTags: ['new-tag'],
        },
      });

      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(1);
      expect(body.failed).toBe(1);
      expect(body.errors[0]).toContain('page-999');
      expect(body.errors[0]).toContain('not found');
    });
  });
});
