import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesEmbeddingRoutes } from './pages-embeddings.js';
import { getUserAccessibleSpaces } from '../../core/services/rbac-service.js';

// Track cache set calls to verify TTL
const mockCacheSet = vi.fn().mockResolvedValue(undefined);

// Mock external dependencies
vi.mock('../../core/services/redis-cache.js', () => {
  return {
    RedisCache: class MockRedisCache {
      get = vi.fn().mockResolvedValue(null);
      set = mockCacheSet;
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
  // #359: `computePageRelationships` returns the SUM across all registered
  // producers (similarity + label_overlap + explicit_link, etc.). The route
  // no longer calls a separate explicit-link producer.
  computePageRelationships: (...args: unknown[]) => mockComputePageRelationships(...args),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

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
      // Query 1: pages (nodes)
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            confluence_id: 'page-1',
            space_key: 'DEV',
            title: 'Getting Started',
            labels: ['howto'],
            embedding_status: 'embedded',
            last_modified_at: new Date('2026-03-01T00:00:00Z'),
            parent_id: null,
          },
          {
            id: 2,
            confluence_id: 'page-2',
            space_key: 'DEV',
            title: 'Architecture Guide',
            labels: ['architecture'],
            embedding_status: 'embedded',
            last_modified_at: new Date('2026-02-20T00:00:00Z'),
            parent_id: null,
          },
        ],
        rowCount: 2,
      });

      // Query 2: page_embeddings counts
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          { page_id: 1, count: '5' },
          { page_id: 2, count: '3' },
        ],
        rowCount: 2,
      });

      // Query 3: page_relationships (edges)
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          {
            page_id_1: 1,
            page_id_2: 2,
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

      // Validate nodes (id is now string of integer PK)
      expect(body.nodes).toHaveLength(2);
      expect(body.nodes[0].id).toBe('1');
      expect(body.nodes[0].confluenceId).toBe('page-1');
      expect(body.nodes[0].title).toBe('Getting Started');
      expect(body.nodes[0].spaceKey).toBe('DEV');
      expect(body.nodes[0].labels).toEqual(['howto']);
      expect(body.nodes[0].embeddingCount).toBe(5);
      expect(body.nodes[1].id).toBe('2');
      expect(body.nodes[1].embeddingCount).toBe(3);

      // Validate edges
      expect(body.edges).toHaveLength(1);
      expect(body.edges[0].source).toBe('1');
      expect(body.edges[0].target).toBe('2');
      expect(body.edges[0].type).toBe('embedding_similarity');
      expect(body.edges[0].score).toBe(0.85);

      // #358: meta block powers the differentiated empty states.
      expect(body.meta).toEqual({
        pagesTotal: 2,
        pagesEmbedded: 2,
        relationshipsTotal: 1,
        relationshipsByType: { embedding_similarity: 1 },
      });
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

      // #358: meta block must be present (with zeros) so the UI can render
      // the differentiated empty state without a second roundtrip.
      expect(body.meta).toEqual({
        pagesTotal: 0,
        pagesEmbedded: 0,
        relationshipsTotal: 0,
        relationshipsByType: {},
      });
    });

    it('should short-circuit with zero-meta when RBAC grants no spaces', async () => {
      // #358: when getUserAccessibleSpaces returns [] (user has no granted
      // spaces), the route must skip the main query path entirely and emit
      // the same meta-block contract the UI expects for the
      // "No accessible pages in your spaces" empty state.
      vi.mocked(getUserAccessibleSpaces).mockResolvedValueOnce([]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/graph',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.nodes).toEqual([]);
      expect(body.edges).toEqual([]);
      expect(body.meta).toEqual({
        pagesTotal: 0,
        pagesEmbedded: 0,
        relationshipsTotal: 0,
        relationshipsByType: {},
      });

      // The short-circuit must NOT hit the database — no nodes/edges/embeddings
      // queries should run, otherwise we are leaking work for users with
      // zero accessible spaces.
      expect(mockQueryFn).not.toHaveBeenCalled();
    });

    it('should default embeddingCount to 0 for pages without embeddings', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          id: 1,
          confluence_id: 'page-1',
          space_key: 'DEV',
          title: 'No Embeddings',
          labels: [],
          embedding_status: 'not_embedded',
          last_modified_at: null,
          parent_id: null,
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

    it('should use RBAC space keys for access control', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await app.inject({
        method: 'GET',
        url: '/api/pages/graph',
      });

      // Nodes and embedding counts queries use RBAC space keys for access control
      expect(mockQueryFn).toHaveBeenCalledTimes(3);
      expect(mockQueryFn.mock.calls[0][0]).toContain('space_key = ANY');
      expect(mockQueryFn.mock.calls[1][0]).toContain('space_key = ANY');
    });

    it('should handle nodes with null labels gracefully', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          id: 1,
          confluence_id: 'page-1',
          space_key: 'DEV',
          title: 'Null Labels Page',
          labels: null,
          embedding_status: 'embedded',
          last_modified_at: null,
          parent_id: null,
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

    it('should filter edges to only include accessible node pairs', async () => {
      // Two nodes accessible to user
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          { id: 1, confluence_id: 'page-1', space_key: 'DEV', title: 'Page 1', labels: [], embedding_status: 'embedded', last_modified_at: null, parent_id: null },
          { id: 2, confluence_id: 'page-2', space_key: 'DEV', title: 'Page 2', labels: [], embedding_status: 'embedded', last_modified_at: null, parent_id: null },
        ],
        rowCount: 2,
      });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // Edges include one with a node (id=99) not in the result set
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          { page_id_1: 1, page_id_2: 2, relationship_type: 'embedding_similarity', score: 0.9 },
          { page_id_1: 1, page_id_2: 99, relationship_type: 'label_overlap', score: 0.5 },
        ],
        rowCount: 2,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/graph',
      });

      const body = JSON.parse(response.body);
      // Only the edge between accessible nodes should be included
      expect(body.edges).toHaveLength(1);
      expect(body.edges[0].source).toBe('1');
      expect(body.edges[0].target).toBe('2');
    });

    it('should accept view=clustered query parameter', async () => {
      // Cluster query (ancestors CTE)
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          {
            root_id: 1,
            root_title: 'Root Section',
            space_key: 'DEV',
            article_count: '3',
            page_ids: [1, 2, 3],
          },
        ],
        rowCount: 1,
      });
      // Orphan query
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // Cross-cluster edges
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/graph?view=clustered',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.nodes).toHaveLength(1);
      expect(body.nodes[0].id).toBe('cluster-1');
      expect(body.nodes[0].type).toBe('cluster');
      expect(body.nodes[0].articleCount).toBe(3);
    });

    it('should accept spaceKey query parameter for filtering', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/graph?spaceKey=DEV',
      });

      expect(response.statusCode).toBe(200);
    });

    it('should use short TTL (300s) for graph cache', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await app.inject({
        method: 'GET',
        url: '/api/pages/graph',
      });

      // The cache.set call should use 300 (5 min) TTL override
      expect(mockCacheSet).toHaveBeenCalledWith(
        expect.any(String),
        'pages',
        expect.stringContaining('graph:'),
        expect.any(Object),
        300,
      );
    });
  });

  describe('GET /api/pages/:id/graph/local', () => {
    it('should return local neighborhood graph for a page', async () => {
      // Query 1: resolve page ID
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, space_key: 'DEV' }],
        rowCount: 1,
      });
      // Query 2: recursive neighbor CTE
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          { page_id: 1, hop: 0 },
          { page_id: 2, hop: 1 },
        ],
        rowCount: 2,
      });
      // Query 3: node data
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          { id: 1, confluence_id: 'page-1', space_key: 'DEV', title: 'Center', labels: [], embedding_status: 'embedded', last_modified_at: null, parent_id: null },
          { id: 2, confluence_id: 'page-2', space_key: 'DEV', title: 'Neighbor', labels: ['howto'], embedding_status: 'embedded', last_modified_at: null, parent_id: null },
        ],
        rowCount: 2,
      });
      // Query 4: embedding counts
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          { page_id: 1, count: '3' },
          { page_id: 2, count: '2' },
        ],
        rowCount: 2,
      });
      // Query 5: edges
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          { page_id_1: 1, page_id_2: 2, relationship_type: 'embedding_similarity', score: 0.88 },
        ],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/1/graph/local?hops=2',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.centerId).toBe('1');
      expect(body.nodes).toHaveLength(2);
      expect(body.edges).toHaveLength(1);
    });

    it('should return empty graph for non-existent page', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/999/graph/local',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.nodes).toHaveLength(0);
      expect(body.edges).toHaveLength(0);
    });

    it('should default hops to 2', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, space_key: 'DEV' }],
        rowCount: 1,
      });
      mockQueryFn.mockResolvedValueOnce({ rows: [{ page_id: 1, hop: 0 }], rowCount: 1 });
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, confluence_id: 'c1', space_key: 'DEV', title: 'P1', labels: [], embedding_status: 'embedded', last_modified_at: null, parent_id: null }],
        rowCount: 1,
      });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/1/graph/local',
      });

      expect(response.statusCode).toBe(200);
      // Check that the recursive CTE was called with hops=2
      const neighborQuery = mockQueryFn.mock.calls[1];
      expect(neighborQuery[1]).toContain(2); // default hops
    });
  });

  // #360: query-param filters on /graph/local. The whitelist for `edgeTypes`
  // is the security boundary — values outside the audited set MUST be
  // dropped at the schema layer and never reach SQL parameters. The
  // assertions below inspect what `mockQueryFn` was actually called with so
  // a regression that lets a bogus value through fails loudly.
  describe('GET /api/pages/:id/graph/local — #360 filter params', () => {
    function primeFiveQueriesForLocalGraph() {
      // Q1: id resolution
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, space_key: 'DEV' }],
        rowCount: 1,
      });
      // Q2: neighbor BFS
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          { page_id: 1, hop: 0 },
          { page_id: 2, hop: 1 },
        ],
        rowCount: 2,
      });
      // Q3: node data
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          { id: 1, confluence_id: 'page-1', space_key: 'DEV', title: 'Center', labels: [], embedding_status: 'embedded', last_modified_at: null, parent_id: null },
          { id: 2, confluence_id: 'page-2', space_key: 'DEV', title: 'Neighbor', labels: ['howto'], embedding_status: 'embedded', last_modified_at: null, parent_id: null },
        ],
        rowCount: 2,
      });
      // Q4: embedding counts
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // Q5: edges
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ page_id_1: 1, page_id_2: 2, relationship_type: 'embedding_similarity', score: 0.88 }],
        rowCount: 1,
      });
    }

    it('drops unknown edgeTypes values — they NEVER reach SQL parameters (security)', async () => {
      primeFiveQueriesForLocalGraph();

      // `foo` and `bar` are not in the whitelist; the literal SQL injection
      // attempt with `;DROP TABLE` must also be filtered out.
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/1/graph/local?edgeTypes=foo,bar,embedding_similarity%3BDROP%20TABLE%20pages',
      });

      expect(response.statusCode).toBe(200);

      // The neighbor BFS (call 2 — index 1) and the edges query (call 5 —
      // index 4) both bind `edgeTypes` as a parameterised text[]. The
      // unsafe values must be filtered to undefined => null.
      const neighborCallParams = mockQueryFn.mock.calls[1]![1] as unknown[];
      const edgesCallParams = mockQueryFn.mock.calls[4]![1] as unknown[];

      // None of the unsafe substrings should appear in any bound param of
      // any query in the request.
      const allBoundValues = mockQueryFn.mock.calls.flatMap((c) => (c[1] as unknown[] | undefined) ?? []);
      const flat = JSON.stringify(allBoundValues);
      expect(flat).not.toContain('foo');
      expect(flat).not.toContain('bar');
      expect(flat).not.toContain('DROP TABLE');
      expect(flat).not.toContain(';');

      // Specifically, the edgeTypes filter slot should be null when every
      // supplied value was rejected by the whitelist.
      expect(neighborCallParams[2]).toBeNull();
      expect(edgesCallParams[1]).toBeNull();
    });

    it('mixes valid and invalid edgeTypes — keeps only the whitelisted values', async () => {
      primeFiveQueriesForLocalGraph();

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/1/graph/local?edgeTypes=embedding_similarity,evil,explicit_link',
      });

      expect(response.statusCode).toBe(200);

      const neighborCallParams = mockQueryFn.mock.calls[1]![1] as unknown[];
      expect(neighborCallParams[2]).toEqual(['embedding_similarity', 'explicit_link']);

      const edgesCallParams = mockQueryFn.mock.calls[4]![1] as unknown[];
      expect(edgesCallParams[1]).toEqual(['embedding_similarity', 'explicit_link']);
    });

    it('passes valid edgeTypes (happy path) through to SQL as a bound text[]', async () => {
      primeFiveQueriesForLocalGraph();

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/1/graph/local?edgeTypes=embedding_similarity,parent_child',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.centerId).toBe('1');
      expect(body.nodes).toHaveLength(2);

      const neighborCallParams = mockQueryFn.mock.calls[1]![1] as unknown[];
      expect(neighborCallParams[2]).toEqual(['embedding_similarity', 'parent_child']);
    });

    it('passes empty/missing edgeTypes through as null (default — no filter)', async () => {
      primeFiveQueriesForLocalGraph();

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/1/graph/local',
      });

      expect(response.statusCode).toBe(200);

      const neighborCallParams = mockQueryFn.mock.calls[1]![1] as unknown[];
      const edgesCallParams = mockQueryFn.mock.calls[4]![1] as unknown[];
      // Null in the filter slot tells the SQL CTE "no edge-type filter"
      // (the WHERE clause has `($3::text[] IS NULL OR …)`).
      expect(neighborCallParams[2]).toBeNull();
      expect(edgesCallParams[1]).toBeNull();
    });

    it('treats whitespace-only edgeTypes as empty (no filter)', async () => {
      primeFiveQueriesForLocalGraph();

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/1/graph/local?edgeTypes=%20%2C%20%2C%20', // " , , "
      });

      expect(response.statusCode).toBe(200);
      const neighborCallParams = mockQueryFn.mock.calls[1]![1] as unknown[];
      // Trim + filter(Boolean) yields an empty array; the route maps an
      // empty array back to null so the SQL CTE skips the filter.
      expect(neighborCallParams[2]).toBeNull();
    });
  });

  // #360: spaceKey is now multi-select. Unlike edgeTypes, the values are
  // user-defined (space keys come from Confluence) so there's no static
  // whitelist — the security gate is the intersection with RBAC-accessible
  // spaces inside the route handler.
  describe('GET /api/pages/graph — #360 multi-spaceKey', () => {
    it('accepts a single spaceKey (back-compat)', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/graph?spaceKey=DEV',
      });

      expect(response.statusCode).toBe(200);
      // RBAC mock yields ['DEV', 'OPS']; the intersection with ['DEV'] is
      // ['DEV'] — that's what the nodes/edges queries bind.
      const nodesCallParams = mockQueryFn.mock.calls[0]![1] as unknown[];
      expect(nodesCallParams[0]).toEqual(['DEV']);
    });

    it('accepts a comma-separated list of spaceKeys and intersects with RBAC', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/graph?spaceKey=DEV,OPS',
      });

      expect(response.statusCode).toBe(200);
      const nodesCallParams = mockQueryFn.mock.calls[0]![1] as unknown[];
      // RBAC = [DEV, OPS]; user = [DEV, OPS]; intersection = [DEV, OPS].
      expect(nodesCallParams[0]).toEqual(['DEV', 'OPS']);
    });

    it('drops spaceKey values the user can NOT access (RBAC enforcement)', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      // `SECRET` isn't in the user's accessible space set ([DEV, OPS]) — it
      // must be dropped before reaching SQL.
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/graph?spaceKey=DEV,SECRET',
      });

      expect(response.statusCode).toBe(200);
      const nodesCallParams = mockQueryFn.mock.calls[0]![1] as unknown[];
      expect(nodesCallParams[0]).toEqual(['DEV']);

      // Belt-and-suspenders: SECRET must not appear in any bound param.
      const flat = JSON.stringify(mockQueryFn.mock.calls);
      expect(flat).not.toContain('SECRET');
    });

    it('returns empty graph when every requested spaceKey is filtered out by RBAC', async () => {
      // No DB queries should fire — the route short-circuits when
      // effectiveSpaces is empty.
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/graph?spaceKey=SECRET,UNKNOWN',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.nodes).toEqual([]);
      expect(body.edges).toEqual([]);
      expect(mockQueryFn).not.toHaveBeenCalled();
    });

    it('treats whitespace-only spaceKey as no filter', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/graph?spaceKey=%20%2C%20', // " , "
      });

      expect(response.statusCode).toBe(200);
      const nodesCallParams = mockQueryFn.mock.calls[0]![1] as unknown[];
      // Empty list => no filter => full RBAC set.
      expect(nodesCallParams[0]).toEqual(['DEV', 'OPS']);
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
