import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { searchRoutes } from './search.js';
// The real class, not the mocked client module below — llm-http-error.js
// lives in its own module precisely so tests that mock the client keep it.
import { LlmHttpError } from '../../domains/llm/services/llm-http-error.js';
// Same reasoning: circuit-breaker.js is never mocked, so instanceof checks
// in the route (and here, to construct rejections) see the real class.
import { CircuitBreakerOpenError } from '../../core/services/circuit-breaker.js';
import { resolveUsecase } from '../../domains/llm/services/llm-provider-resolver.js';

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: vi.fn().mockResolvedValue(['TEST']),
  // The search route now imports the memoised wrapper (ADR-022). For these
  // tests, the scope cache is irrelevant; both forms resolve the same set.
  getUserAccessibleSpacesMemoized: vi.fn().mockResolvedValue(['TEST']),
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
const mockGetEmbeddingCoverage = vi.fn();
vi.mock('../../domains/llm/services/rag-service.js', async () => {
  // Keep the pure helpers real: the route derives its degraded verdict with
  // deriveDegradedReason, and stubbing that here would let route and service
  // drift apart on the one semantic they must share.
  const actual = await vi.importActual<typeof import('../../domains/llm/services/rag-service.js')>(
    '../../domains/llm/services/rag-service.js',
  );
  return {
    vectorSearch: (...args: unknown[]) => mockVectorSearch(...args),
    hybridSearch: (...args: unknown[]) => mockHybridSearch(...args),
    recordSearchAnalytics: (...args: unknown[]) => mockRecordAnalytics(...args),
    getEmbeddingCoverage: (...args: unknown[]) => mockGetEmbeddingCoverage(...args),
    deriveDegradedReason: actual.deriveDegradedReason,
    resolveStageLimit: actual.resolveStageLimit,
    DEGRADED_COVERAGE_THRESHOLD: actual.DEGRADED_COVERAGE_THRESHOLD,
  };
});

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

// Shared SearchResult shape from rag-service. The mocks below are bare
// `vi.fn()`s, so nothing type-checks this against the real interface — keep the
// per-leg fields present by hand or the route's `similarity` silently
// serializes to `undefined` and every assertion here passes against a body the
// real pipeline cannot produce (#1117).
const makeSearchResult = (
  pageId: number,
  title: string,
  overrides?: { score?: number; vectorScore?: number | null; keywordRank?: number | null },
) => ({
  pageId,
  confluenceId: `page-${pageId}`,
  chunkText: `Excerpt for ${title}`,
  pageTitle: title,
  sectionTitle: title,
  spaceKey: 'TEST',
  score: 0.8,
  vectorScore: 0.8,
  keywordRank: null,
  ...overrides,
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
      // Mirror app.ts:398's policy: a 500 never echoes the underlying
      // error's message to the client — only non-500 statuses (deliberately
      // thrown, e.g. Fastify sensible httpErrors) do. This route test
      // registers its own minimal error handler rather than the app's real
      // one, so it must reproduce that sanitization or a rethrown DB/unknown
      // error (#1223) would leak here even though search.ts itself no
      // longer formats it into the response.
      const statusCode = error.statusCode ?? 500;
      reply.status(statusCode).send({
        error: statusCode === 500 ? 'InternalServerError' : error.name,
        message: statusCode === 500 ? 'Internal Server Error' : error.message,
        statusCode,
      });
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
    // Default: fully-embedded corpus (healthy). Tests for the degraded signal
    // override this per case.
    mockGetEmbeddingCoverage.mockResolvedValue({ embeddedPages: 3, totalPages: 3, coverage: 1 });
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
      mockQueryFn.mockResolvedValue({ rows: [] });

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

    it('semantic mode fetches the stage limit, not the return limit, and slices after dedupe (#1103)', async () => {
      // The vector leg counts CHUNKS while `limit` counts pages-after-dedup:
      // fetching exactly `limit` rows under-delivered whenever one page's
      // chunks occupied several top slots. The route now fetches
      // resolveStageLimit(limit, width, false) chunks and slices to `limit`
      // after dedupe.
      mockQueryFn.mockResolvedValue({ rows: [] });
      const fakeEmbedding = new Array(768).fill(0.1);
      mockProviderGenerateEmbedding.mockResolvedValue([[...fakeEmbedding]]);
      // Five chunks of page 1 dominate, then pages 2 and 3 — dedupe collapses
      // the first five into one item.
      mockVectorSearch.mockResolvedValue([
        makeSearchResult(1, 'Long page'),
        makeSearchResult(1, 'Long page'),
        makeSearchResult(1, 'Long page'),
        makeSearchResult(1, 'Long page'),
        makeSearchResult(1, 'Long page'),
        makeSearchResult(2, 'Second page'),
        makeSearchResult(3, 'Third page'),
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=semantic&limit=2',
      });

      expect(response.statusCode).toBe(200);
      // Fetch width: max(default width 10, limit 2) = 10 chunks requested.
      expect(mockVectorSearch).toHaveBeenCalledTimes(1);
      expect(mockVectorSearch.mock.calls[0]?.[2]).toBe(10);
      // Return width: sliced to the caller's limit AFTER dedupe-by-page.
      const body = response.json();
      expect(body.items).toHaveLength(2);
      expect(body.items.map((i: { id: number }) => i.id)).toEqual([1, 2]);
      expect(body.limit).toBe(2);
    });

    it('semantic mode with no embeddings → falls back to keyword', async () => {
      // Coverage probe: embeddable pages exist, none embedded (#1117)
      mockGetEmbeddingCoverage.mockResolvedValue({ embeddedPages: 0, totalPages: 3, coverage: 0 });
      mockQueryFn.mockImplementation((sql: string) => {
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


    it('semantic/hybrid mode consults the coverage probe, not a first-page EXISTS (#1117)', async () => {
      // The old boolean EXISTS probe flipped healthy the moment ONE visible
      // page had an embedding row, so 1% coverage looked like 100%. The route
      // must consult getEmbeddingCoverage and must not run its own probe SQL.
      mockProviderGenerateEmbedding.mockResolvedValue([new Array(768).fill(0.1)]);
      mockVectorSearch.mockResolvedValue([]);
      mockQueryFn.mockResolvedValue({ rows: [] });

      await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=semantic',
      });

      expect(mockGetEmbeddingCoverage).toHaveBeenCalledWith('test-user-id');
      const probeCall = mockQueryFn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('page_embeddings'),
      );
      expect(probeCall).toBeUndefined();
    });

    it('keyword mode skips the coverage probe entirely', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] });

      await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=keyword',
      });

      expect(mockGetEmbeddingCoverage).not.toHaveBeenCalled();
    });

    // ── hybrid mode ──────────────────────────────────────────────────────────

    it('hybrid mode calls hybridSearch from rag-service', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] }); // embeddings exist

      mockHybridSearch.mockResolvedValue([
        makeSearchResult(1, 'Vector Result'),
        makeSearchResult(2, 'Keyword Result'),
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=hybrid',
      });

      expect(response.statusCode).toBe(200);
      // 4th arg: the route's own coverage reading, handed over so hybridSearch
      // does not probe a second time (review r1).
      expect(mockHybridSearch).toHaveBeenCalledWith(
        'test-user-id',
        'test',
        10,
        { embeddedPages: 3, totalPages: 3, coverage: 1 },
      );
      const body = response.json();
      expect(body.mode).toBe('hybrid');
      expect(body.hasEmbeddings).toBe(true);
      expect(body.items).toHaveLength(2);
    });

    // ── Degraded-retrieval signal on the wire (#1117 stage 2) ────────────

    it('reports full coverage as healthy: embeddingCoverage 1, no degradedReason', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] });
      mockHybridSearch.mockResolvedValue([makeSearchResult(1, 'Hit')]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=hybrid',
      });

      const body = response.json();
      expect(body.hasEmbeddings).toBe(true);
      expect(body.embeddingCoverage).toBe(1);
      expect(body.degradedReason).toBeNull();
    });

    it('reports partial coverage without downgrading the mode', async () => {
      mockGetEmbeddingCoverage.mockResolvedValue({ embeddedPages: 5, totalPages: 10, coverage: 0.5 });
      mockQueryFn.mockResolvedValue({ rows: [] });
      mockHybridSearch.mockResolvedValue([makeSearchResult(1, 'Hit')]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=hybrid',
      });

      const body = response.json();
      // Half the corpus still answers — the mode must keep running, degraded,
      // not silently fall back to keyword.
      expect(body.mode).toBe('hybrid');
      expect(body.hasEmbeddings).toBe(true);
      expect(body.embeddingCoverage).toBe(0.5);
      expect(body.degradedReason).toBe('partial_embeddings');
      expect(mockHybridSearch).toHaveBeenCalled();
    });

    it('reports zero coverage as no_embeddings and downgrades to keyword', async () => {
      mockGetEmbeddingCoverage.mockResolvedValue({ embeddedPages: 0, totalPages: 4, coverage: 0 });
      mockQueryFn.mockResolvedValue({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=hybrid',
      });

      const body = response.json();
      expect(body.mode).toBe('keyword');
      expect(body.hasEmbeddings).toBe(false);
      expect(body.embeddingCoverage).toBe(0);
      expect(body.degradedReason).toBe('no_embeddings');
      expect(body.warning).toContain('No embeddings');
      expect(mockHybridSearch).not.toHaveBeenCalled();
    });

    it('keyword mode reports the signal as unmeasured, not healthy', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=keyword',
      });

      const body = response.json();
      expect(body.embeddingCoverage).toBeNull();
      expect(body.degradedReason).toBeNull();
    });

    it('the degraded warning never claims 0% and floors true percentages (review r2)', async () => {
      // Near-zero coverage must read "less than 1%" (0% is the sibling
      // no-embeddings state), and 29/100 embedded must say 29%, not 28 —
      // Math.floor(0.29 * 100) is 28 in binary floating point.
      mockGetEmbeddingCoverage.mockResolvedValue({ embeddedPages: 1, totalPages: 300, coverage: 1 / 300 });
      mockQueryFn.mockResolvedValue({ rows: [] });
      mockHybridSearch.mockResolvedValue([makeSearchResult(1, 'Hit')]);

      let response = await app.inject({ method: 'GET', url: '/api/search?q=test&mode=hybrid' });
      expect(response.json().warning).toContain('less than 1%');
      expect(response.json().warning).not.toContain(' 0%');

      mockGetEmbeddingCoverage.mockResolvedValue({ embeddedPages: 29, totalPages: 100, coverage: 0.29 });
      response = await app.inject({ method: 'GET', url: '/api/search?q=test&mode=hybrid' });
      expect(response.json().warning).toContain('29%');
    });

    it('a probe failure degrades the signal to null, never the search (review r1)', async () => {
      // The design contract in 09-flow-rag-chat.md — hybridSearchInner already
      // honors it; the route must too, not answer a 500 for the whole search.
      mockGetEmbeddingCoverage.mockRejectedValue(new Error('statement timeout'));
      mockQueryFn.mockResolvedValue({ rows: [] });
      mockHybridSearch.mockResolvedValue([makeSearchResult(1, 'Hit')]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=hybrid',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // Unmeasured, not healthy and not fatal: optimistic mode keeps running.
      expect(body.mode).toBe('hybrid');
      expect(body.hasEmbeddings).toBe(true);
      expect(body.embeddingCoverage).toBeNull();
      expect(body.degradedReason).toBeNull();
      expect(mockHybridSearch).toHaveBeenCalled();
    });

    it('a downgraded-to-keyword search still records the measured signal (review r1)', async () => {
      // The zero-coverage downgrade is the WORST degradation state — during a
      // re-embed window every hybrid search lands here. Recording it as a
      // plain healthy 'keyword' row would hide exactly what migration 088
      // exists to make visible.
      mockGetEmbeddingCoverage.mockResolvedValue({ embeddedPages: 0, totalPages: 4, coverage: 0 });
      mockQueryFn.mockResolvedValue({ rows: [] });

      await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=hybrid',
      });

      expect(mockRecordAnalytics).toHaveBeenCalledWith(
        'test-user-id',
        'test',
        expect.any(Number),
        null,
        'keyword',
        { degradedReason: 'no_embeddings', embeddingCoverage: 0 },
      );
    });

    it('hybrid mode probes coverage once and hands the reading to hybridSearch (review r1)', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] });
      mockHybridSearch.mockResolvedValue([makeSearchResult(1, 'Hit')]);

      await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=hybrid',
      });

      expect(mockGetEmbeddingCoverage).toHaveBeenCalledTimes(1);
      expect(mockHybridSearch).toHaveBeenCalledWith(
        'test-user-id',
        'test',
        10,
        { embeddedPages: 3, totalPages: 3, coverage: 1 },
      );
    });

    it('semantic mode records coverage extras on the analytics row', async () => {
      mockGetEmbeddingCoverage.mockResolvedValue({ embeddedPages: 5, totalPages: 10, coverage: 0.5 });
      mockProviderGenerateEmbedding.mockResolvedValue([new Array(768).fill(0.1)]);
      mockVectorSearch.mockResolvedValue([makeSearchResult(1, 'Vector Result')]);

      await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=semantic',
      });

      expect(mockRecordAnalytics).toHaveBeenCalledWith(
        'test-user-id',
        'test',
        1,
        expect.any(Number),
        'semantic',
        { degradedReason: 'partial_embeddings', embeddingCoverage: 0.5 },
      );
    });

    // ── Score semantics (#1117) ──────────────────────────────────────────
    //
    // `rank` carries whatever unit the mode produced; `similarity` is the
    // cosine and is the only field a UI may render. Before #1117 both `rank`
    // and `score` were fed the identical value, so hybrid rows reported an RRF
    // artefact as a percentage.

    it('hybrid mode: exposes the cosine as `similarity`, distinct from the fusion `rank`', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] });
      mockHybridSearch.mockResolvedValue([
        makeSearchResult(1, 'Both legs', { score: 0.0328, vectorScore: 0.74, keywordRank: 0.09 }),
      ]);

      const response = await app.inject({ method: 'GET', url: '/api/search?q=test&mode=hybrid' });

      expect(response.statusCode).toBe(200);
      const item = response.json().items[0];
      expect(item.similarity).toBe(0.74);
      expect(item.rank).toBe(0.0328);
    });

    it('hybrid mode: a full-text-only row reports a null similarity, not a zero', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] });
      mockHybridSearch.mockResolvedValue([
        makeSearchResult(2, 'Keyword only', { score: 0.0164, vectorScore: null, keywordRank: 0.12 }),
      ]);

      const response = await app.inject({ method: 'GET', url: '/api/search?q=test&mode=hybrid' });

      const item = response.json().items[0];
      expect(item.similarity).toBeNull();
      expect(item.rank).toBe(0.0164);
    });

    it('semantic mode: `similarity` is present and equals the cosine', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] });
      // The suite's beforeEach only calls vi.clearAllMocks(), which clears calls
      // but not implementations — so a semantic test that omits this silently
      // inherits whichever embedding mock an earlier test happened to leave
      // behind, and fails the moment the file is run with a -t filter.
      mockProviderGenerateEmbedding.mockResolvedValue([[new Array(768).fill(0.1)]]);
      mockVectorSearch.mockResolvedValue([
        makeSearchResult(3, 'Semantic', { score: 0.66, vectorScore: 0.66 }),
      ]);

      const response = await app.inject({ method: 'GET', url: '/api/search?q=test&mode=semantic' });

      expect(response.statusCode).toBe(200);
      const item = response.json().items[0];
      expect(item.similarity).toBe(0.66);
    });

    it('semantic mode: `similarity` is really emitted, not silently undefined', async () => {
      // Guards the fixture trap this suite fell into: the rag-service mocks are
      // untyped, so a fixture missing `vectorScore` makes the route emit
      // `undefined` and every other assertion here still passes.
      mockQueryFn.mockResolvedValue({ rows: [] });
      mockProviderGenerateEmbedding.mockResolvedValue([[new Array(768).fill(0.1)]]);
      mockVectorSearch.mockResolvedValue([makeSearchResult(4, 'Present')]);

      const response = await app.inject({ method: 'GET', url: '/api/search?q=test&mode=semantic' });

      // Assert the status first: without it a 502 surfaces as an opaque
      // TypeError on items[0] rather than naming the real failure.
      expect(response.statusCode).toBe(200);
      expect(Object.keys(response.json().items[0])).toContain('similarity');
    });

    it('semantic mode: providerGenerateEmbedding failure → 502', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] }); // embeddings exist
      mockProviderGenerateEmbedding.mockRejectedValue(new Error('Ollama unreachable'));

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=semantic',
      });

      expect(response.statusCode).toBe(502);
    });

    // ── #1214 regression: provider error bodies stay out of search 502s ──────
    // Since #1185 generateEmbedding throws the real LlmHttpError: the
    // provider's raw body (third-party text that can echo request fragments
    // and internal topology) lives on `.detail`, never on `.message`. #1223
    // went further and replaced the route's own `err.message` formatting
    // with `toUserFacingEmbeddingError` — a fixed, categorized constant —
    // for genuine embedding-provider failures, so these now pin that no
    // input to that helper can ever surface raw provider text either.
    it('semantic mode 502 keeps the provider error body out of the client-visible message (#1214, #1223)', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] }); // embeddings exist
      mockProviderGenerateEmbedding.mockRejectedValue(
        new LlmHttpError('generateEmbedding', 500, 'SECRET_PROVIDER_BODY_XYZ internal-host=10.0.4.12'),
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=semantic',
      });

      expect(response.statusCode).toBe(502);
      const body = response.json();
      expect(body.error).toBe('EmbeddingFailed');
      // toUserFacingEmbeddingError's fixed fallback constant — nothing from
      // the caught error is interpolated in.
      expect(body.message).toBe('Embedding failed due to a provider error. See server logs for details.');
      // Belt and braces: the marker appears nowhere in the raw payload.
      expect(response.body).not.toContain('SECRET_PROVIDER_BODY_XYZ');
    });

    // #1223: hybridSearch (rag-service.ts) rethrows only CircuitBreakerOpenError
    // and swallows its own embedding failures internally, so an LlmHttpError
    // reaching this catch is not the expected shape any more — treat it like
    // any other non-circuit-breaker error and rethrow to the global handler
    // for a sanitized 500, rather than re-labeling it EmbeddingFailed/502.
    it('hybrid mode rethrows a non-circuit-breaker error to a sanitized 500, provider body absent (#1214, #1223)', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] }); // embeddings exist
      mockHybridSearch.mockRejectedValue(
        new LlmHttpError('generateEmbedding', 500, 'SECRET_PROVIDER_BODY_XYZ internal-host=10.0.4.12'),
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=hybrid',
      });

      expect(response.statusCode).toBe(500);
      const body = response.json();
      expect(body.message).toBe('Internal Server Error');
      expect(response.body).not.toContain('SECRET_PROVIDER_BODY_XYZ');
    });

    // ── #1223: hybrid catch no longer echoes err.message into a 502 ──────────
    // What actually reaches this catch in production is predominantly a
    // DATABASE error (keywordSearch, the ACL post-filter — see rag-service.ts,
    // which swallows only its own embedding-path failures). A raw Postgres
    // connection-phase message (role names, pg_hba entries, internal hosts)
    // must never reach the client; it should be rethrown and sanitized by the
    // global handler exactly like any other uncaught DB error on this route.
    it('hybrid mode: DB error reaching the catch is sanitized, marker absent (#1223)', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] }); // embeddings exist
      mockHybridSearch.mockRejectedValue(
        new Error('password authentication failed for user "SECRET_DB_MARKER_ROLE"'),
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=hybrid',
      });

      expect(response.statusCode).toBe(500);
      const body = response.json();
      expect(body.message).toBe('Internal Server Error');
      expect(response.body).not.toContain('SECRET_DB_MARKER_ROLE');
    });

    it('hybrid mode: CircuitBreakerOpenError → 503 with retry-shortly semantics (#1223)', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] }); // embeddings exist
      mockHybridSearch.mockRejectedValue(new CircuitBreakerOpenError('breaker open for provider p1'));

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=hybrid',
      });

      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.message).toContain('try again');
      expect(response.body).not.toContain('breaker open for provider p1');
    });

    // ── semantic mode twin (search.ts:69, the AI review's required scope
    // addition) — same class of leak, same fix. ────────────────────────────
    it('semantic mode: embedding-path error carrying a marker stays out of the 502 (#1223)', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] }); // embeddings exist
      mockProviderGenerateEmbedding.mockRejectedValue(
        new Error('provider said SECRET_EMBED_MARKER_ABC while talking to internal-host'),
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=semantic',
      });

      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain('SECRET_EMBED_MARKER_ABC');
    });

    it('semantic mode: DB-shaped error resolving the embedding provider is sanitized to 500 (#1223)', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] }); // embeddings exist
      vi.mocked(resolveUsecase).mockRejectedValueOnce(
        new Error('no pg_hba.conf entry for host "SECRET_DB_HOST_MARKER"'),
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=semantic',
      });

      expect(response.statusCode).toBe(500);
      const body = response.json();
      expect(body.message).toBe('Internal Server Error');
      expect(response.body).not.toContain('SECRET_DB_HOST_MARKER');
      // The provider call itself must never have been reached.
      expect(mockProviderGenerateEmbedding).not.toHaveBeenCalled();
    });

    it('semantic mode: CircuitBreakerOpenError on the embedding call → 503 (#1223)', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] }); // embeddings exist
      mockProviderGenerateEmbedding.mockRejectedValue(new CircuitBreakerOpenError('breaker open for provider p1'));

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=semantic',
      });

      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.message).toContain('try again');
      expect(response.body).not.toContain('breaker open for provider p1');
    });

    // #1223 review follow-up: a provider that "succeeds" with an empty
    // embeddings array previously fell through `embeddings[0] ?? null` to
    // `null`, which the caller treats as "already replied" and returns
    // without ever calling reply.send — a 200 with an empty body, not an
    // error at all. Empty/missing is a failed embedding: reply the existing
    // 502 EmbeddingFailed shape with a fixed constant (there is no error
    // object here, so nothing is interpolated and toUserFacingEmbeddingError
    // is not involved).
    it('semantic mode: empty embeddings array from the provider is a 502, not a bodiless 200 (#1223)', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] }); // embeddings exist
      mockProviderGenerateEmbedding.mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=semantic',
      });

      expect(response.statusCode).toBe(502);
      const body = response.json();
      expect(body.error).toBe('EmbeddingFailed');
      expect(body.message).toBe('Embedding generation returned no result.');
    });

    it('semantic mode: a zero-length inner vector is also treated as no result (#1223)', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] }); // embeddings exist
      // Outer array has an entry, but it is itself an empty vector — `!embedding`
      // alone would miss this since `[]` is truthy in JS.
      mockProviderGenerateEmbedding.mockResolvedValue([[]]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=test&mode=semantic',
      });

      expect(response.statusCode).toBe(502);
      const body = response.json();
      expect(body.error).toBe('EmbeddingFailed');
      expect(body.message).toBe('Embedding generation returned no result.');
    });

    it('recordSearchAnalytics is called once per request for semantic mode', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] }); // embeddings exist
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

    it('should scope suggestions to the requesting user (#895)', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/search/suggestions?q=redis',
      });

      expect(response.statusCode).toBe(200);
      const [sql, params] = mockQueryFn.mock.calls[0];
      expect(sql).toMatch(/user_id\s*=\s*\$2/);
      expect(params).toEqual(['redis', 'test-user-id']);
    });
  });
});
