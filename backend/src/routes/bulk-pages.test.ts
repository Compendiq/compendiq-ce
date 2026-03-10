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

const mockProcessDirtyPages = vi.fn().mockResolvedValue({ processed: 2, errors: 0 });
const mockIsProcessingUser = vi.fn().mockReturnValue(false);
vi.mock('../services/embedding-service.js', () => ({
  processDirtyPages: (...args: unknown[]) => mockProcessDirtyPages(...args),
  isProcessingUser: (...args: unknown[]) => mockIsProcessingUser(...args),
}));

// Mock the database with a function we can control per test
const mockQueryFn = vi.fn();
vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

import { getClientForUser } from '../services/sync-service.js';

describe('Bulk Pages Routes', () => {
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

    await app.register(pagesRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: page exists for ownership check
    mockQueryFn.mockResolvedValue({ rows: [{ confluence_id: 'page-1', labels: ['existing-tag'] }], rowCount: 1 });
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

    it('should report failures for pages not owned by user', async () => {
      // First call: page not found, second call: page found
      mockQueryFn
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ confluence_id: 'page-2' }], rowCount: 1 });

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
  });

  describe('POST /api/pages/bulk/sync', () => {
    it('should re-sync multiple pages', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/sync',
        payload: { ids: ['page-1'] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(1);
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
  });

  describe('POST /api/pages/bulk/embed', () => {
    it('should mark pages as embedding dirty and trigger processing', async () => {
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
      mockQueryFn.mockResolvedValue({ rowCount: 0 });

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
      mockQueryFn.mockResolvedValueOnce({ rowCount: 0 });

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
      mockIsProcessingUser.mockReturnValueOnce(true);

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/embed',
        payload: { ids: ['page-1'] },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('already in progress');
    });
  });

  describe('POST /api/pages/bulk/tag', () => {
    it('should add tags to multiple pages', async () => {
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
  });
});
