import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesEmbeddingRoutes } from './pages-embeddings.js';

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

const mockComputePageRelationships = vi.fn().mockResolvedValue(10);
vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  processDirtyPages: vi.fn().mockResolvedValue({ processed: 0, errors: 0 }),
  isProcessingUser: vi.fn().mockResolvedValue(false),
  computePageRelationships: (...args: unknown[]) => mockComputePageRelationships(...args),
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

describe('Knowledge Graph API', () => {
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

    await app.register(pagesEmbeddingRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/pages/graph', () => {
    it('should return nodes and edges for the knowledge graph', async () => {
      // Query 1: cached_pages (nodes)
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          {
            confluence_id: 'page-1',
            space_key: 'DEV',
            title: 'Getting Started',
            labels: ['howto'],
            embedding_status: 'embedded',
            last_modified_at: new Date('2026-03-01T00:00:00Z'),
          },
          {
            confluence_id: 'page-2',
            space_key: 'DEV',
            title: 'Architecture Guide',
            labels: ['architecture'],
            embedding_status: 'embedded',
            last_modified_at: new Date('2026-02-20T00:00:00Z'),
          },
        ],
        rowCount: 2,
      });

      // Query 2: page_embeddings counts
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          { confluence_id: 'page-1', count: '5' },
          { confluence_id: 'page-2', count: '3' },
        ],
        rowCount: 2,
      });

      // Query 3: page_relationships (edges)
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          {
            page_id_1: 'page-1',
            page_id_2: 'page-2',
            relationship_type: 'embedding_similarity',
            score: 0.85,
          },
        ],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/graph',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Validate nodes
      expect(body.nodes).toHaveLength(2);
      expect(body.nodes[0].id).toBe('page-1');
      expect(body.nodes[0].title).toBe('Getting Started');
      expect(body.nodes[0].spaceKey).toBe('DEV');
      expect(body.nodes[0].labels).toEqual(['howto']);
      expect(body.nodes[0].embeddingCount).toBe(5);
      expect(body.nodes[1].id).toBe('page-2');
      expect(body.nodes[1].embeddingCount).toBe(3);

      // Validate edges
      expect(body.edges).toHaveLength(1);
      expect(body.edges[0].source).toBe('page-1');
      expect(body.edges[0].target).toBe('page-2');
      expect(body.edges[0].type).toBe('embedding_similarity');
      expect(body.edges[0].score).toBe(0.85);
    });

    it('should return empty arrays when no pages exist', async () => {
      // nodes query
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // embedding counts query
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // edges query
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/graph',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.nodes).toHaveLength(0);
      expect(body.edges).toHaveLength(0);
    });

    it('should default embeddingCount to 0 for pages without embeddings', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          confluence_id: 'page-1',
          space_key: 'DEV',
          title: 'No Embeddings',
          labels: [],
          embedding_status: 'not_embedded',
          last_modified_at: null,
        }],
        rowCount: 1,
      });
      // No embedding counts
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // No edges
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/graph',
      });

      const body = JSON.parse(response.body);
      expect(body.nodes[0].embeddingCount).toBe(0);
    });

    it('should pass userId to per-user isolation queries', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await app.inject({
        method: 'GET',
        url: '/api/pages/graph',
      });

      // Nodes and embedding counts queries use userId for access control
      expect(mockQueryFn).toHaveBeenCalledTimes(3);
      // First two queries (nodes + embedding counts) should include userId
      expect(mockQueryFn.mock.calls[0][1]).toContain('test-user-id');
      expect(mockQueryFn.mock.calls[1][1]).toContain('test-user-id');
      // Third query (edges/relationships) is global (no user_id needed - no PII)
      expect(mockQueryFn.mock.calls[2][1]).toEqual([]);
    });

    it('should handle nodes with null labels gracefully', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          confluence_id: 'page-1',
          space_key: 'DEV',
          title: 'Null Labels Page',
          labels: null,
          embedding_status: 'embedded',
          last_modified_at: null,
        }],
        rowCount: 1,
      });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/graph',
      });

      const body = JSON.parse(response.body);
      expect(body.nodes[0].labels).toEqual([]);
    });
  });

  describe('POST /api/pages/graph/refresh', () => {
    it('should recompute page relationships and return edge count', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/graph/refresh',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Graph relationships refreshed');
      expect(body.edges).toBe(10);
      expect(mockComputePageRelationships).toHaveBeenCalledWith();
    });
  });
});
