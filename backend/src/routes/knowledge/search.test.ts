import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { searchRoutes } from './search.js';

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: vi.fn().mockResolvedValue(['TEST']),
}));

const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// Mocks for rag-service functions used in semantic/hybrid modes
const mockVectorSearch = vi.fn();
const mockHybridSearch = vi.fn();
const mockRecordAnalytics = vi.fn();
vi.mock('../../domains/llm/services/rag-service.js', () => ({
  vectorSearch: (...args: unknown[]) => mockVectorSearch(...args),
  hybridSearch: (...args: unknown[]) => mockHybridSearch(...args),
  recordSearchAnalytics: (...args: unknown[]) => mockRecordAnalytics(...args),
}));

const mockProviderGenerateEmbedding = vi.fn();

vi.mock('../../domains/llm/services/llm-provider-resolver.js', () => ({
  resolveUsecase: vi.fn().mockResolvedValue({
    config: {
      providerId: 'p1', id: 'p1', name: 'X',
      baseUrl: 'http://x/v1', apiKey: null,
      authType: 'none', verifySsl: true, defaultModel: 'bge-m3',
    },
    model: 'bge-m3',
  }),
}));

vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  // Ignore config+model; re-use the existing spy for assertions on texts.
  generateEmbedding: (_cfg: unknown, _model: string, text: string | string[]) =>
    mockProviderGenerateEmbedding('test-user', text),
  streamChat: vi.fn(),
  chat: vi.fn(),
  listModels: vi.fn(),
  checkHealth: vi.fn(),
  invalidateDispatcher: vi.fn(),
}));

// Shared SearchResult shape from rag-service
const makeSearchResult = (pageId: number, title: string) => ({
  pageId,
  confluenceId: `page-${pageId}`,
  chunkText: `Excerpt for ${title}`,
  pageTitle: title,
  sectionTitle: title,
  spaceKey: 'TEST',
  score: 0.8,
});

describe('Search Routes', () => {
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

    await app.register(searchRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: recordAnalytics is a no-op
    mockRecordAnalytics.mockResolvedValue(undefined);
  });

  describe('GET /api/search', () => {
    it('should return search results with facets', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('UNION ALL')) {
          return {
            rows: [
              { facet: 'space', value: 'DEV', count: '1' },
              { facet: 'space', value: 'OPS', count: '1' },
              { facet: 'author', value: 'Alice', count: '1' },
              { facet: 'author', value: 'Bob', count: '1' },
              { facet: 'tag', value: 'howto', count: '1' },
              { facet: 'tag', value: 'architecture', count: '1' },
            ],
          };
        }
        if (typeof sql === 'string' && sql.includes('ts_rank')) {
          return {
            rows: [
              {
                id: 1,
                confluence_id: 'page-1',
                title: 'Redis Guide',
                space_key: 'DEV',
                author: 'Alice',
                last_modified_at: new Date('2025-01-15'),
                labels: ['howto'],
                rank: 0.85,
                snippet: 'How to use <mark>Redis</mark> caching',
                total_count: '2',
              },
              {
                id: 2,
                confluence_id: 'page-2',
                title: 'Redis Config',
                space_key: 'OPS',
                author: 'Bob',
                last_modified_at: new Date('2025-02-10'),
                labels: ['architecture'],
                rank: 0.72,
                snippet: 'Configure <mark>Redis</mark> for production',
                total_count: '2',
              },
            ],
          };
        }
        // trgm title query
        if (typeof sql === 'string' && sql.includes('similarity')) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 0 };
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=Redis',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items).toHaveLength(2);
      expect(body.total).toBe(2);
      expect(body.page).toBe(1);
      expect(body.limit).toBe(10);
      expect(body.totalPages).toBe(1);
      expect(body.facets.spaces).toHaveLength(2);
      expect(body.facets.authors).toHaveLength(2);
      expect(body.facets.tags).toHaveLength(2);
      expect(body.items[0].title).toBe('Redis Guide');
      expect(body.items[0].snippet).toContain('<mark>');
      // New fields
      expect(body.mode).toBe('keyword');
      expect(body.hasEmbeddings).toBeDefined();
    });

    it('should require query parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/search',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should include access control JOIN and deleted_at filter', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] });

      await app.inject({
        method: 'GET',
        url: '/api/search?q=test',
      });

      // Access control is in the FTS data query (which now includes COUNT(*) OVER())
      const dataCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ts_rank'),
      );
      expect(dataCall).toBeDefined();
      const sql = dataCall![0] as string;
      expect(sql).toContain('cp.space_key = ANY');
      expect(sql).toContain('cp.deleted_at IS NULL');
      expect(sql).toContain('cp.source');
      expect(sql).toContain('cp.visibility');
    });

    it('should filter by spaceKey', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] });

      await app.inject({
        method: 'GET',
        url: '/api/search?q=test&spaceKey=DEV',
      });

      const dataCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ts_rank'),
      );
      expect(dataCall).toBeDefined();
      expect(dataCall![0] as string).toContain('cp.space_key = $');
      expect(dataCall![1] as unknown[]).toContain('DEV');
    });

    it('should filter by author', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] });

      await app.inject({
        method: 'GET',
        url: '/api/search?q=test&author=Alice',
      });

      const dataCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ts_rank'),
      );
      expect(dataCall![0] as string).toContain('cp.author = $');
      expect(dataCall![1] as unknown[]).toContain('Alice');
    });

    it('should filter by date range', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] });

      await app.inject({
        method: 'GET',
        url: '/api/search?q=test&dateFrom=2025-01-01&dateTo=2025-12-31',
      });

      const dataCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ts_rank'),
      );
      expect(dataCall![0] as string).toContain('cp.last_modified_at >=');
      expect(dataCall![0] as string).toContain('cp.last_modified_at <=');
      expect(dataCall![1] as unknown[]).toContain('2025-01-01');
      expect(dataCall![1] as unknown[]).toContain('2025-12-31');
    });

    it('should filter by tags', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] });

      await app.inject({
        method: 'GET',
        url: '/api/search?q=test&tags=howto,architecture',
      });

      const dataCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ts_rank'),
      );
      expect(dataCall![0] as string).toContain('cp.labels @>');
      expect(dataCall![1] as unknown[]).toContainEqual(['howto', 'architecture']);
    });

    it('should support sort by modified date', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] });

      await app.inject({
        method: 'GET',
        url: '/api/search?q=test&sort=modified',
      });

      const dataCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ts_rank'),
      );
      expect(dataCall).toBeDefined();
      expect(dataCall![0] as string).toContain('cp.last_modified_at DESC');
    });

    it('should paginate results correctly', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('ts_rank')) {
          return {
            rows: [{ id: 1, confluence_id: 'p-1', title: 'T', space_key: 'DEV', author: null, last_modified_at: null, labels: [], rank: 0.5, snippet: 's', total_count: '50' }],
          };
        }
        return { rows: [] };
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&page=2&limit=10',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(50);
      expect(body.page).toBe(2);
      expect(body.limit).toBe(10);
      expect(body.totalPages).toBe(5);

      // Verify OFFSET was calculated correctly (page 2 with limit 10 = offset 10)
      const dataCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('OFFSET'),
      );
      expect(dataCall).toBeDefined();
      const params = dataCall![1] as unknown[];
      // Last two params should be limit and offset
      expect(params[params.length - 2]).toBe(10); // limit
      expect(params[params.length - 1]).toBe(10); // offset = (2-1)*10
    });

    // ── keyword mode: trgm title merge ──────────────────────────────────────

    it('keyword mode runs trgm title query separately from FTS', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('similarity')) {
          return {
            rows: [
              {
                id: 99,
                confluence_id: 'page-99',
                title: 'Redis Tuning',
                space_key: 'DEV',
                body_text: 'Tuning advice',
                rank: 0.8,
              },
            ],
          };
        }
        if (typeof sql === 'string' && sql.includes('ts_rank')) {
          return {
            rows: [{
              id: 1,
              confluence_id: 'page-1',
              title: 'Redis Guide',
              space_key: 'DEV',
              author: 'Alice',
              last_modified_at: null,
              labels: [],
              rank: 0.9,
              snippet: 'Redis intro',
              total_count: '1',
            }],
          };
        }
        if (typeof sql === 'string' && sql.includes('UNION ALL')) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=Redis&mode=keyword',
      });

      expect(response.statusCode).toBe(200);

      // Verify both FTS and trgm queries were called
      const trgmCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('similarity'),
      );
      expect(trgmCall).toBeDefined();

      const ftsCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ts_rank'),
      );
      expect(ftsCall).toBeDefined();
    });

    // ── semantic mode ────────────────────────────────────────────────────────

    it('semantic mode calls providerGenerateEmbedding + vectorSearch', async () => {
      // Embeddings exist check → EXISTS = true
      mockQueryFn.mockResolvedValue({ rows: [{ exists: true }] });

      const fakeEmbedding = new Array(768).fill(0.1);
      mockProviderGenerateEmbedding.mockResolvedValue([[...fakeEmbedding]]);
      mockVectorSearch.mockResolvedValue([makeSearchResult(1, 'Vector Result')]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=semantic',
      });

      expect(response.statusCode).toBe(200);
      // The embedding path now resolves the provider internally; we only
      // assert that an embedding was requested for the search query text.
      expect(mockProviderGenerateEmbedding).toHaveBeenCalled();
      expect(mockProviderGenerateEmbedding.mock.calls[0]?.[1]).toBe('test');
      expect(mockVectorSearch).toHaveBeenCalledTimes(1);
      const body = response.json();
      expect(body.mode).toBe('semantic');
      expect(body.hasEmbeddings).toBe(true);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].title).toBe('Vector Result');
    });

    it('semantic mode with no embeddings → falls back to keyword', async () => {
      // Embeddings exist check → EXISTS = false
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('page_embeddings')) {
          return { rows: [{ exists: false }] };
        }
        if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
          return { rows: [{ count: '1' }] };
        }
        if (typeof sql === 'string' && sql.includes('ts_rank')) {
          return {
            rows: [{
              id: 1,
              confluence_id: 'page-1',
              title: 'Keyword Result',
              space_key: 'DEV',
              author: null,
              last_modified_at: null,
              labels: [],
              rank: 0.5,
              snippet: 'result snippet',
            }],
          };
        }
        if (typeof sql === 'string' && sql.includes('UNION ALL')) {
          return { rows: [] };
        }
        if (typeof sql === 'string' && sql.includes('similarity')) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=semantic',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.hasEmbeddings).toBe(false);
      expect(body.mode).toBe('keyword');
      expect(body.warning).toBeDefined();
      expect(body.warning).toContain('No embeddings');
      // Should NOT have called vector search
      expect(mockVectorSearch).not.toHaveBeenCalled();
      expect(mockProviderGenerateEmbedding).not.toHaveBeenCalled();
    });


    it('semantic/hybrid mode uses EXISTS instead of COUNT(*) for embeddings check', async () => {
      mockQueryFn.mockResolvedValue({ rows: [{ exists: true }] });
      mockProviderGenerateEmbedding.mockResolvedValue([[new Array(768).fill(0.1)]]);
      mockVectorSearch.mockResolvedValue([]);

      await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=semantic',
      });

      const embCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('page_embeddings'),
      );
      expect(embCall).toBeDefined();
      const sql = embCall![0] as string;
      // Should use EXISTS, not COUNT(*)
      expect(sql).toContain('SELECT EXISTS');
      expect(sql).not.toContain('COUNT(*)');
    });

    // ── hybrid mode ──────────────────────────────────────────────────────────

    it('hybrid mode calls hybridSearch from rag-service', async () => {
      mockQueryFn.mockResolvedValue({ rows: [{ exists: true }] }); // embeddings exist

      mockHybridSearch.mockResolvedValue([
        makeSearchResult(1, 'Vector Result'),
        makeSearchResult(2, 'Keyword Result'),
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=hybrid',
      });

      expect(response.statusCode).toBe(200);
      expect(mockHybridSearch).toHaveBeenCalledWith('test-user-id', 'test', 10);
      const body = response.json();
      expect(body.mode).toBe('hybrid');
      expect(body.hasEmbeddings).toBe(true);
      expect(body.items).toHaveLength(2);
    });

    it('semantic mode: providerGenerateEmbedding failure → 502', async () => {
      mockQueryFn.mockResolvedValue({ rows: [{ exists: true }] }); // embeddings exist
      mockProviderGenerateEmbedding.mockRejectedValue(new Error('Ollama unreachable'));

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=semantic',
      });

      expect(response.statusCode).toBe(502);
    });

    it('recordSearchAnalytics is called once per request for semantic mode', async () => {
      mockQueryFn.mockResolvedValue({ rows: [{ exists: true }] }); // embeddings exist
      mockProviderGenerateEmbedding.mockResolvedValue([[new Array(768).fill(0.1)]]);
      mockVectorSearch.mockResolvedValue([]);

      await app.inject({
        method: 'GET',
        url: '/api/search?q=analytics-test&mode=semantic',
      });

      expect(mockRecordAnalytics).toHaveBeenCalledTimes(1);
      const [calledUserId, calledQuery, , , calledType] =
        mockRecordAnalytics.mock.calls[0] as [string, string, number, number | null, string];
      expect(calledUserId).toBe('test-user-id');
      expect(calledQuery).toBe('analytics-test');
      expect(calledType).toBe('semantic');
    });
  });

  describe('GET /api/search — includeFacets parameter', () => {
    it('should skip facet query when includeFacets=false', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('ts_rank')) {
          return {
            rows: [{
              id: 1,
              confluence_id: 'page-1',
              title: 'Redis Guide',
              space_key: 'DEV',
              author: 'Alice',
              last_modified_at: null,
              labels: [],
              rank: 0.8,
              snippet: 'Redis snippet',
              total_count: '1',
            }],
          };
        }
        if (typeof sql === 'string' && sql.includes('similarity')) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=Redis&includeFacets=false',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Facets should be an empty object with empty arrays
      expect(body.facets).toEqual({ spaces: [], authors: [], tags: [] });

      // The UNION ALL facet query should NOT have been called
      const facetCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UNION ALL'),
      );
      expect(facetCall).toBeUndefined();
    });

    it('should include facets by default (includeFacets omitted)', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('UNION ALL')) {
          return {
            rows: [
              { facet: 'space', value: 'DEV', count: '3' },
              { facet: 'author', value: 'Alice', count: '2' },
            ],
          };
        }
        if (typeof sql === 'string' && sql.includes('ts_rank')) {
          return {
            rows: [{
              id: 1,
              confluence_id: 'page-1',
              title: 'Test',
              space_key: 'DEV',
              author: 'Alice',
              last_modified_at: null,
              labels: [],
              rank: 0.5,
              snippet: 'snippet',
              total_count: '1',
            }],
          };
        }
        if (typeof sql === 'string' && sql.includes('similarity')) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Facets should be populated
      expect(body.facets.spaces).toHaveLength(1);
      expect(body.facets.authors).toHaveLength(1);

      // The UNION ALL facet query should have been called
      const facetCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UNION ALL'),
      );
      expect(facetCall).toBeDefined();
    });

    it('should include facets when includeFacets=true', async () => {
      mockQueryFn.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('UNION ALL')) {
          return {
            rows: [
              { facet: 'tag', value: 'howto', count: '5' },
            ],
          };
        }
        if (typeof sql === 'string' && sql.includes('ts_rank')) {
          return { rows: [] };
        }
        if (typeof sql === 'string' && sql.includes('similarity')) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&includeFacets=true',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.facets.tags).toHaveLength(1);
      expect(body.facets.tags[0].value).toBe('howto');
    });
  });

  describe('POST /api/search/log', () => {
    it('should log a search query', async () => {
      mockQueryFn.mockResolvedValue({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/search/log',
        payload: { query: 'kubernetes deployment', resultCount: 0 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO search_analytics'),
        ['test-user-id', 'kubernetes deployment', 0],
      );
    });

    it('should reject empty query', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/search/log',
        payload: { query: '', resultCount: 0 },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/search/suggestions', () => {
    it('should return autocomplete suggestions', async () => {
      mockQueryFn.mockResolvedValue({
        rows: [
          { query_text: 'redis caching', frequency: '15' },
          { query_text: 'redis configuration', frequency: '8' },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/search/suggestions?q=redis',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.suggestions).toHaveLength(2);
      expect(body.suggestions[0].query).toBe('redis caching');
      expect(body.suggestions[0].frequency).toBe(15);
    });

    it('should require q parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/search/suggestions',
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
