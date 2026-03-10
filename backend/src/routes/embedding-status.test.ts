import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesRoutes } from './pages.js';

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

describe('Embedding Status in API responses', () => {
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
  });

  describe('GET /api/pages/:id', () => {
    it('should return embeddingStatus and embeddedAt for an embedded page', async () => {
      const embeddedAt = new Date('2026-03-01T12:00:00Z');
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          confluence_id: 'page-1',
          space_key: 'DEV',
          title: 'Test Page',
          body_storage: '<p>content</p>',
          body_html: '<p>content</p>',
          body_text: 'content',
          version: 3,
          parent_id: null,
          labels: ['docs'],
          author: 'testuser',
          last_modified_at: new Date('2026-02-28'),
          last_synced: new Date('2026-03-01'),
          embedding_dirty: false,
          embedding_status: 'embedded',
          embedded_at: embeddedAt,
          embedding_error: null,
        }],
      });
      // Mock the children count query
      mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '0' }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/page-1',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.embeddingStatus).toBe('embedded');
      expect(body.embeddedAt).toBe(embeddedAt.toISOString());
      expect(body.embeddingDirty).toBe(false);
    });

    it('should return embeddingStatus "not_embedded" for a new page', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          confluence_id: 'page-2',
          space_key: 'DEV',
          title: 'New Page',
          body_storage: '<p>new</p>',
          body_html: '<p>new</p>',
          body_text: 'new',
          version: 1,
          parent_id: null,
          labels: [],
          author: 'testuser',
          last_modified_at: new Date('2026-03-10'),
          last_synced: new Date('2026-03-10'),
          embedding_dirty: true,
          embedding_status: 'not_embedded',
          embedded_at: null,
          embedding_error: null,
        }],
      });
      // Mock the children count query
      mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '0' }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/page-2',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.embeddingStatus).toBe('not_embedded');
      expect(body.embeddedAt).toBeNull();
      expect(body.embeddingDirty).toBe(true);
    });

    it('should return embeddingStatus "failed" with null error when no error stored', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          confluence_id: 'page-3',
          space_key: 'DEV',
          title: 'Failed Page',
          body_storage: '<p>fail</p>',
          body_html: '<p>fail</p>',
          body_text: 'fail',
          version: 2,
          parent_id: null,
          labels: [],
          author: 'testuser',
          last_modified_at: new Date('2026-03-05'),
          last_synced: new Date('2026-03-05'),
          embedding_dirty: true,
          embedding_status: 'failed',
          embedded_at: null,
          embedding_error: null,
        }],
      });
      // Mock the children count query
      mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '0' }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/page-3',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.embeddingStatus).toBe('failed');
      expect(body.embeddingError).toBeNull();
    });

    it('should return embeddingError with the error message for a failed embedding', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          confluence_id: 'page-3b',
          space_key: 'DEV',
          title: 'Failed Page With Error',
          body_storage: '<p>fail</p>',
          body_html: '<p>fail</p>',
          body_text: 'fail',
          version: 2,
          parent_id: null,
          labels: [],
          author: 'testuser',
          last_modified_at: new Date('2026-03-05'),
          last_synced: new Date('2026-03-05'),
          embedding_dirty: true,
          embedding_status: 'failed',
          embedded_at: null,
          embedding_error: 'Model nomic-embed-text not found',
        }],
      });
      // Mock the children count query
      mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '0' }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/page-3b',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.embeddingStatus).toBe('failed');
      expect(body.embeddingError).toBe('Model nomic-embed-text not found');
    });

    it('should return embeddingStatus "embedding" for a page being processed', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          confluence_id: 'page-4',
          space_key: 'DEV',
          title: 'Processing Page',
          body_storage: '<p>processing</p>',
          body_html: '<p>processing</p>',
          body_text: 'processing',
          version: 2,
          parent_id: null,
          labels: [],
          author: 'testuser',
          last_modified_at: new Date('2026-03-08'),
          last_synced: new Date('2026-03-08'),
          embedding_dirty: true,
          embedding_status: 'embedding',
          embedded_at: null,
          embedding_error: null,
        }],
      });
      // Mock the children count query
      mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '0' }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/page-4',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.embeddingStatus).toBe('embedding');
    });
  });

  describe('GET /api/pages (list)', () => {
    it('should include embeddingStatus and embeddedAt in list items', async () => {
      const embeddedAt = new Date('2026-03-01T12:00:00Z');
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
          return { rows: [{ count: '2' }] };
        }
        return {
          rows: [
            {
              id: 1,
              confluence_id: 'page-1',
              space_key: 'DEV',
              title: 'Embedded Page',
              version: 3,
              parent_id: null,
              labels: [],
              author: 'Alice',
              last_modified_at: new Date('2026-02-28'),
              last_synced: new Date('2026-03-01'),
              embedding_dirty: false,
              embedding_status: 'embedded',
              embedded_at: embeddedAt,
              embedding_error: null,
            },
            {
              id: 2,
              confluence_id: 'page-2',
              space_key: 'DEV',
              title: 'Not Embedded Page',
              version: 1,
              parent_id: null,
              labels: [],
              author: 'Bob',
              last_modified_at: new Date('2026-03-10'),
              last_synced: new Date('2026-03-10'),
              embedding_dirty: true,
              embedding_status: 'not_embedded',
              embedded_at: null,
              embedding_error: null,
            },
          ],
        };
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items).toHaveLength(2);

      expect(body.items[0].embeddingStatus).toBe('embedded');
      expect(body.items[0].embeddedAt).toBe(embeddedAt.toISOString());

      expect(body.items[1].embeddingStatus).toBe('not_embedded');
      expect(body.items[1].embeddedAt).toBeNull();
    });
  });

  describe('GET /api/pages/tree', () => {
    it('should include embeddingStatus and embeddedAt in tree items', async () => {
      const embeddedAt = new Date('2026-03-01T12:00:00Z');
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          {
            confluence_id: 'page-1',
            space_key: 'DEV',
            title: 'Root',
            parent_id: null,
            labels: [],
            last_modified_at: new Date('2026-03-01'),
            embedding_dirty: false,
            embedding_status: 'embedded',
            embedded_at: embeddedAt,
            embedding_error: null,
          },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/tree',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items[0].embeddingStatus).toBe('embedded');
      expect(body.items[0].embeddedAt).toBe(embeddedAt.toISOString());
    });
  });
});
