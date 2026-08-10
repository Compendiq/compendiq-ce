import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks must be declared before any vi.mock() calls
const mocks = vi.hoisted(() => {
  const mockClientQuery = vi.fn();
  const mockClient = {
    query: mockClientQuery,
    release: vi.fn(),
  };
  const mockPool = {
    connect: vi.fn().mockResolvedValue(mockClient),
  };
  const mockQuery = vi.fn();
  const mockGenerateEmbedding = vi.fn();
  const mockResolveUsecase = vi.fn().mockResolvedValue({
    config: {
      providerId: 'p1', id: 'p1', name: 'X',
      baseUrl: 'http://x/v1', apiKey: null,
      authType: 'none', verifySsl: true, defaultModel: 'bge-m3',
    },
    model: 'bge-m3',
  });
  const mockGetUserAccessibleSpaces = vi.fn();
  const mockToSql = vi.fn().mockReturnValue('[0.1,0.2]');

  return {
    mockClientQuery,
    mockClient,
    mockPool,
    mockQuery,
    mockGenerateEmbedding,
    mockResolveUsecase,
    mockGetUserAccessibleSpaces,
    mockToSql,
  };
});

vi.mock('../../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mocks.mockQuery(...args),
  getPool: () => mocks.mockPool,
  getVectorPool: () => mocks.mockPool,
}));

vi.mock('./llm-provider-resolver.js', () => ({
  resolveUsecase: (...args: unknown[]) => mocks.mockResolveUsecase(...args),
}));

vi.mock('./openai-compatible-client.js', () => ({
  generateEmbedding: (...args: unknown[]) => mocks.mockGenerateEmbedding(...args),
  streamChat: vi.fn(),
  chat: vi.fn(),
  listModels: vi.fn(),
  checkHealth: vi.fn(),
  invalidateDispatcher: vi.fn(),
}));

vi.mock('../../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mocks.mockGetUserAccessibleSpaces(...args),
  // The rag-service now imports the memoised wrapper (ADR-022). Tests here
  // exercise resolver behaviour, not the scope cache, so the wrapper just
  // delegates to the same mock.
  getUserAccessibleSpacesMemoized: (...args: unknown[]) => mocks.mockGetUserAccessibleSpaces(...args),
  // Issue #112 Phase D: the rag-service now calls `userCanAccessPage` in the
  // flag-on post-filter branch. Tests in this file exercise the flag-off path
  // (no license registered), so this stub is never called — but the symbol
  // must exist so the ESM import resolves.
  // Implementation form (`vi.fn(impl)`), NOT `.mockResolvedValue(...)`: several
  // describes call `vi.resetAllMocks()`, which wipes a queued resolved value
  // but keeps an implementation — with the queued form, every post-reset test
  // ran with userCanAccessPage returning undefined.
  userCanAccessPage: vi.fn(async () => true),
}));

vi.mock('pgvector', () => ({
  default: { toSql: (...args: unknown[]) => mocks.mockToSql(...args) },
}));

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../core/services/fts-language.js', () => ({
  // Implementation form so `vi.resetAllMocks()` cannot wipe it — with the
  // queued `.mockResolvedValue('simple')` form, every describe that resets
  // mocks built its keyword SQL with `plainto_tsquery('undefined', …)`, and
  // assertions against that SQL were exercising a string no deployment
  // produces. A test below pins the language survives into the SQL.
  getFtsLanguage: vi.fn(async () => 'simple'),
}));

import { buildRagContext, hybridSearch, RAG_EF_SEARCH, reciprocalRankFusion, rrfWorstCase, vectorSearch, keywordSearch, recordSearchAnalytics, resolveStageLimit, RAG_FETCH_WIDTH_DEFAULT, RAG_FETCH_WIDTH_MAX } from './rag-service.js';
import type { SearchResult } from './rag-service.js';
import { invalidateRagFetchWidthCache } from '../../../core/services/admin-settings-service.js';
import { CircuitBreakerOpenError } from '../../../core/services/circuit-breaker.js';

describe('RAG Service', () => {
  describe('RAG_EF_SEARCH config', () => {
    it('should default to 100', () => {
      // Since test-setup.ts does not set RAG_EF_SEARCH, it should default to 100
      expect(RAG_EF_SEARCH).toBe(100);
    });

    it('should be a positive integer', () => {
      expect(Number.isInteger(RAG_EF_SEARCH)).toBe(true);
      expect(RAG_EF_SEARCH).toBeGreaterThan(0);
    });

    it('should produce a safe number for SQL interpolation', () => {
      expect(Number(RAG_EF_SEARCH)).toBe(RAG_EF_SEARCH);
      expect(Number.isFinite(Number(RAG_EF_SEARCH))).toBe(true);
    });
  });

  describe('buildRagContext', () => {
    it('should return "no context" message for empty results', () => {
      const context = buildRagContext([]);
      expect(context).toBe('No relevant context found in the knowledge base.');
    });

    it('should format a single result', () => {
      const results: SearchResult[] = [
        {
          pageId: 1,
          confluenceId: 'page-1',
          chunkText: 'Some chunk text here.',
          pageTitle: 'Getting Started Guide',
          sectionTitle: 'Installation',
          spaceKey: 'DEV',
          score: 0.85,
        },
      ];

      const context = buildRagContext(results);
      expect(context).toContain('[Source 1:');
      expect(context).toContain('"Getting Started Guide"');
      expect(context).toContain('Space: DEV');
      expect(context).toContain('Section: Installation');
      expect(context).toContain('Some chunk text here.');
    });

    it('should format multiple results separated by ---', () => {
      const results: SearchResult[] = [
        {
          pageId: 1,
          confluenceId: 'page-1',
          chunkText: 'First chunk.',
          pageTitle: 'Page 1',
          sectionTitle: 'Section A',
          spaceKey: 'DEV',
          score: 0.9,
        },
        {
          pageId: 2,
          confluenceId: 'page-2',
          chunkText: 'Second chunk.',
          pageTitle: 'Page 2',
          sectionTitle: 'Section B',
          spaceKey: 'OPS',
          score: 0.8,
        },
      ];

      const context = buildRagContext(results);
      expect(context).toContain('[Source 1:');
      expect(context).toContain('[Source 2:');
      expect(context).toContain('---');
      expect(context).toContain('First chunk.');
      expect(context).toContain('Second chunk.');
    });

    it('should number sources sequentially', () => {
      const results: SearchResult[] = Array.from({ length: 5 }, (_, i) => ({
        pageId: i + 1,
        confluenceId: `page-${i}`,
        chunkText: `Chunk ${i}`,
        pageTitle: `Page ${i}`,
        sectionTitle: `Section ${i}`,
        spaceKey: 'DEV',
        score: 1 - i * 0.1,
      }));

      const context = buildRagContext(results);
      for (let i = 1; i <= 5; i++) {
        expect(context).toContain(`[Source ${i}:`);
      }
    });

    it('should show "Local" for standalone articles with null spaceKey', () => {
      const results: SearchResult[] = [
        {
          pageId: 10,
          confluenceId: 'standalone-1',
          chunkText: 'Standalone article content.',
          pageTitle: 'My Local Article',
          sectionTitle: 'Overview',
          spaceKey: null,
          score: 0.75,
        },
      ];

      const context = buildRagContext(results);
      expect(context).toContain('Space: Local');
      expect(context).toContain('"My Local Article"');
      expect(context).toContain('Standalone article content.');
    });

    it('should handle mixed confluence and standalone results', () => {
      const results: SearchResult[] = [
        {
          pageId: 1,
          confluenceId: 'page-1',
          chunkText: 'Confluence content.',
          pageTitle: 'Confluence Page',
          sectionTitle: 'Intro',
          spaceKey: 'DEV',
          score: 0.9,
        },
        {
          pageId: 11,
          confluenceId: 'standalone-1',
          chunkText: 'Standalone content.',
          pageTitle: 'Local Article',
          sectionTitle: 'Details',
          spaceKey: null,
          score: 0.8,
        },
      ];

      const context = buildRagContext(results);
      expect(context).toContain('Space: DEV');
      expect(context).toContain('Space: Local');
      expect(context).toContain('---');
    });
  });

  describe('RAG_EF_SEARCH bounds check', () => {
    it('should fall back to 100 for NaN input', async () => {
      vi.resetModules();
      vi.stubEnv('RAG_EF_SEARCH', 'garbage');

      const mod = await import('./rag-service.js');
      expect(mod.RAG_EF_SEARCH).toBe(100);
      vi.unstubAllEnvs();
    });

    it('should fall back to 100 for negative input', async () => {
      vi.resetModules();
      vi.stubEnv('RAG_EF_SEARCH', '-5');

      const mod = await import('./rag-service.js');
      expect(mod.RAG_EF_SEARCH).toBe(100);
      vi.unstubAllEnvs();
    });

    it('should fall back to 100 for zero', async () => {
      vi.resetModules();
      vi.stubEnv('RAG_EF_SEARCH', '0');

      const mod = await import('./rag-service.js');
      expect(mod.RAG_EF_SEARCH).toBe(100);
      vi.unstubAllEnvs();
    });

    it('should fall back to 100 for values exceeding 10000', async () => {
      vi.resetModules();
      vi.stubEnv('RAG_EF_SEARCH', '99999');

      const mod = await import('./rag-service.js');
      expect(mod.RAG_EF_SEARCH).toBe(100);
      vi.unstubAllEnvs();
    });

    it('should accept valid values within bounds', async () => {
      vi.resetModules();
      vi.stubEnv('RAG_EF_SEARCH', '200');

      const mod = await import('./rag-service.js');
      expect(mod.RAG_EF_SEARCH).toBe(200);
      vi.unstubAllEnvs();
    });
  });

  describe('vectorSearch (via hybridSearch)', () => {
    beforeEach(() => {
      vi.resetAllMocks();
      // The fetch-width TTL cache (admin-settings-service) is module state —
      // clear it so no test reads a width another test resolved.
      invalidateRagFetchWidthCache();
      // Restore pool mock after reset
      mocks.mockPool.connect.mockResolvedValue(mocks.mockClient);
      mocks.mockClient.release.mockResolvedValue(undefined);
      mocks.mockToSql.mockReturnValue('[0.1,0.2]');
      // Restore resolver mock default (resetAllMocks wipes it).
      mocks.mockResolveUsecase.mockResolvedValue({
        config: {
          providerId: 'p1', id: 'p1', name: 'X',
          baseUrl: 'http://x/v1', apiKey: null,
          authType: 'none', verifySsl: true, defaultModel: 'bge-m3',
        },
        model: 'bge-m3',
      });
    });

    it('should use pe.page_id = cp.id JOIN (not pe.confluence_id = cp.confluence_id)', async () => {
      // providerGenerateEmbedding returns one 1024-dim vector
      const fakeEmbedding = new Array(1024).fill(0.1);
      mocks.mockGenerateEmbedding.mockResolvedValue([[...fakeEmbedding]]);

      // getUserAccessibleSpaces
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

      // vectorSearch uses pool.connect -> BEGIN -> SET LOCAL -> main SELECT
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({ rows: [] }); // main vector SELECT (empty)
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      // keywordSearch uses query() -- return empty
      mocks.mockQuery.mockResolvedValue({ rows: [] });

      await hybridSearch('user-1', 'test query about embeddings');

      // Verify the vector SELECT SQL contains the corrected JOIN
      const vectorSelectCall = mocks.mockClientQuery.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes('page_embeddings'),
      );
      expect(vectorSelectCall).toBeDefined();
      const vectorSQL = vectorSelectCall![0] as string;
      expect(vectorSQL).toContain('pe.page_id = cp.id');
      expect(vectorSQL).not.toContain('pe.confluence_id = cp.confluence_id');
    });

    it('should return empty results when no embeddings exist', async () => {
      const fakeEmbedding = new Array(1024).fill(0.1);
      mocks.mockGenerateEmbedding.mockResolvedValue([[...fakeEmbedding]]);
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({ rows: [] }); // vector SELECT empty
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      // keyword search + analytics
      mocks.mockQuery.mockResolvedValue({ rows: [] });

      const results = await hybridSearch('user-1', 'test query');
      expect(results).toEqual([]);
    });

    it('should fall back to keyword-only when embedding generation fails', async () => {
      mocks.mockGenerateEmbedding.mockRejectedValue(new Error('Ollama unreachable'));
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

      // Route on SQL text, not call order: since #1117 the coverage probe runs
      // concurrently with keywordSearch, so a queued mockResolvedValueOnce can
      // be consumed by either.
      mocks.mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('ts_rank')) {
          return {
            rows: [{
              page_id: 1,
              confluence_id: 'page-1',
              title: 'Test Page',
              space_key: 'DEV',
              body_text: 'Some text content for search',
              rank: 0.5,
            }],
          };
        }
        if (sql.includes('COUNT(*)')) {
          return { rows: [{ embedded: 1, total: 1 }] };
        }
        return { rows: [] };
      });

      const results = await hybridSearch('user-1', 'test query');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].pageTitle).toBe('Test Page');
    });

    it('should re-throw CircuitBreakerOpenError instead of falling back', async () => {
      const cbError = new CircuitBreakerOpenError('LLM server temporarily unavailable');
      mocks.mockGenerateEmbedding.mockRejectedValue(cbError);
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

      // keyword search is started concurrently but the CB error should still propagate
      mocks.mockQuery.mockResolvedValue({ rows: [] });

      await expect(hybridSearch('user-1', 'test query')).rejects.toThrow(
        'LLM server temporarily unavailable',
      );
    });

    it('should not orphan the keyword promise when re-throwing CircuitBreakerOpenError', async () => {
      // Regression for #921: on the CircuitBreakerOpenError rethrow path the
      // in-flight keywordSearch promise is never awaited. If its underlying DB
      // query rejects, that rejection must still be observed — otherwise it
      // surfaces as an unhandledRejection that can crash the process.
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        const cbError = new CircuitBreakerOpenError('LLM server temporarily unavailable');
        mocks.mockGenerateEmbedding.mockRejectedValue(cbError);
        mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

        // keywordSearch's DB query rejects — this is the promise that gets
        // orphaned when the CB error short-circuits the function.
        mocks.mockQuery.mockRejectedValue(new Error('connection terminated'));

        await expect(hybridSearch('user-1', 'test query')).rejects.toThrow(
          'LLM server temporarily unavailable',
        );

        // Flush microtasks/timers so any orphaned rejection would fire.
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('should record keyword_fallback search type when embedding fails', async () => {
      mocks.mockGenerateEmbedding.mockRejectedValue(new Error('Ollama unreachable'));
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

      // Route on SQL text, not call order — see the fallback test above.
      mocks.mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('ts_rank')) {
          return {
            rows: [{
              page_id: 1,
              confluence_id: 'page-1',
              title: 'Fallback Page',
              space_key: 'DEV',
              body_text: 'Fallback content',
              rank: 0.4,
            }],
          };
        }
        if (sql.includes('COUNT(*)')) {
          return { rows: [{ embedded: 1, total: 1 }] };
        }
        return { rows: [] };
      });

      await hybridSearch('user-1', 'test query');

      // Find the analytics INSERT call
      const analyticsCalls = mocks.mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes('search_analytics'),
      );
      expect(analyticsCalls.length).toBeGreaterThanOrEqual(1);
      // The 5th parameter should be 'keyword_fallback', and the degraded
      // reason (#1117) 'embedding_failed' — the provider threw, whatever the
      // corpus coverage says.
      const analyticsParams = analyticsCalls[0][1] as unknown[];
      expect(analyticsParams[4]).toBe('keyword_fallback');
      expect(analyticsParams[6]).toBe('embedding_failed');
    });

    it('should record hybrid search type when both vector and keyword succeed', async () => {
      const fakeEmbedding = new Array(1024).fill(0.1);
      mocks.mockGenerateEmbedding.mockResolvedValue([[...fakeEmbedding]]);
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({
        rows: [{
          page_id: 1,
          confluence_id: 'page-1',
          chunk_text: 'Vector result content',
          metadata: { page_title: 'Vector Page', section_title: 'Intro', space_key: 'DEV' },
          distance: 0.2,
        }],
      }); // vector SELECT
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      // Route on SQL text, not call order — the fetch-width read (#1103) and
      // the coverage probe both go through query() before/alongside the
      // keyword leg, so a queued mockResolvedValueOnce could be consumed by
      // any of them.
      mocks.mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('ts_rank')) {
          return {
            rows: [{
              page_id: 2,
              confluence_id: 'page-2',
              title: 'Keyword Page',
              space_key: 'DEV',
              body_text: 'Keyword content',
              rank: 0.5,
            }],
          };
        }
        if (sql.includes('COUNT(*)')) {
          return { rows: [{ embedded: 1, total: 1 }] };
        }
        return { rows: [] };
      });

      await hybridSearch('user-1', 'test query');

      // Find the analytics INSERT call
      const analyticsCalls = mocks.mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes('search_analytics'),
      );
      expect(analyticsCalls.length).toBeGreaterThanOrEqual(1);
      const analyticsParams = analyticsCalls[0][1] as unknown[];
      expect(analyticsParams[4]).toBe('hybrid');
    });
  });

  describe('fetch width decoupled from topK (#1103)', () => {
    describe('resolveStageLimit', () => {
      it('uses the fetch width when it exceeds topK (chat path)', () => {
        // RAG chat asks for topK=5; the legs must still fetch the full
        // candidate budget so fusion/ranking has something to rank.
        expect(resolveStageLimit(5, 30, false)).toBe(30);
        expect(resolveStageLimit(5, 30, true)).toBe(30);
      });

      it('defaults to the legacy per-leg limit — over-fetch without a reranker is a measured regression', () => {
        // Width 30 with plain RRF measured Recall@5 0.7153 vs 0.8819 on
        // #1102's fixture (see RAG_FETCH_WIDTH_DEFAULT's JSDoc). The default
        // must stay at the legacy 10 until #1104's reranker consumes the
        // wider pool.
        expect(RAG_FETCH_WIDTH_DEFAULT).toBe(10);
      });

      it('never fetches fewer than topK (search path can satisfy ?limit=20)', () => {
        // /api/search?mode=hybrid&limit=20 with a small configured width used
        // to cap both legs at 10 rows — the requested limit was unsatisfiable.
        expect(resolveStageLimit(20, 10, false)).toBe(20);
      });

      it('ACL headroom only ever adds candidates, never removes them (#1263)', () => {
        // The old `aclEnforced ? ceil(topK*1.5) : default(10)` fetched 8/leg
        // on the EE chat path vs CE's 10 — compensation as a net under-fetch.
        for (const topK of [1, 3, 5, 7, 10, 20]) {
          for (const width of [1, 5, 10, 30, 50]) {
            expect(resolveStageLimit(topK, width, true)).toBeGreaterThanOrEqual(
              resolveStageLimit(topK, width, false),
            );
          }
        }
        // The concrete #1263 case: EE chat (topK=5) must not fetch fewer
        // candidates than CE did before this change.
        expect(resolveStageLimit(5, RAG_FETCH_WIDTH_DEFAULT, true)).toBeGreaterThanOrEqual(10);
      });

      it('keeps the 1.5x ACL floor when the width is small', () => {
        expect(resolveStageLimit(20, 10, true)).toBe(30); // ceil(20 * 1.5)
      });
    });

    describe('admin_settings-backed width (hybridSearch wiring)', () => {
      beforeEach(() => {
        vi.resetAllMocks();
        // Module-level TTL cache in admin-settings-service — without this,
        // the first test's width would serve every later test.
        invalidateRagFetchWidthCache();
        mocks.mockPool.connect.mockResolvedValue(mocks.mockClient);
        mocks.mockClient.release.mockResolvedValue(undefined);
        mocks.mockToSql.mockReturnValue('[0.1,0.2]');
        mocks.mockResolveUsecase.mockResolvedValue({
          config: {
            providerId: 'p1', id: 'p1', name: 'X',
            baseUrl: 'http://x/v1', apiKey: null,
            authType: 'none', verifySsl: true, defaultModel: 'bge-m3',
          },
          model: 'bge-m3',
        });
        mocks.mockGenerateEmbedding.mockResolvedValue([[0.1, 0.2]]);
        mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
        // vectorSearch transaction: BEGIN / SET LOCAL / SELECT / COMMIT
        mocks.mockClientQuery.mockImplementation(async (sql: string) => {
          if (typeof sql === 'string' && sql.includes('page_embeddings')) return { rows: [] };
          return undefined;
        });
      });

      /** Route query() by SQL text; `adminRows` answers the rag_fetch_width read. */
      function routeQueries(adminRows: Array<{ setting_value: string }>) {
        mocks.mockQuery.mockImplementation(async (sql: string) => {
          if (sql.includes('rag_fetch_width')) return { rows: adminRows };
          if (sql.includes('COUNT(*)')) return { rows: [{ embedded: 1, total: 1 }] };
          return { rows: [] };
        });
      }

      /** The LIMIT parameter handed to the vector leg's SELECT. */
      function vectorLimitParam(): number {
        const call = mocks.mockClientQuery.mock.calls.find(
          (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('page_embeddings'),
        );
        expect(call).toBeDefined();
        return (call![1] as unknown[])[2] as number;
      }

      /** The LIMIT parameter handed to the keyword leg's SELECT. */
      function keywordLimitParam(): number {
        const call = mocks.mockQuery.mock.calls.find(
          (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ts_rank'),
        );
        expect(call).toBeDefined();
        return (call![1] as unknown[])[2] as number;
      }

      it('defaults both legs to RAG_FETCH_WIDTH_DEFAULT when no admin row exists', async () => {
        routeQueries([]);
        await hybridSearch('user-1', 'test query');
        expect(vectorLimitParam()).toBe(RAG_FETCH_WIDTH_DEFAULT);
        expect(keywordLimitParam()).toBe(RAG_FETCH_WIDTH_DEFAULT);
      });

      it('honours an admin-configured width at runtime (no restart)', async () => {
        routeQueries([{ setting_value: '12' }]);
        await hybridSearch('user-1', 'test query');
        expect(vectorLimitParam()).toBe(12);
        expect(keywordLimitParam()).toBe(12);
      });

      it('falls back to the default on a garbage admin value', async () => {
        routeQueries([{ setting_value: 'banana' }]);
        await hybridSearch('user-1', 'test query');
        expect(vectorLimitParam()).toBe(RAG_FETCH_WIDTH_DEFAULT);
      });

      it('clamps an absurd admin value to RAG_FETCH_WIDTH_MAX', async () => {
        routeQueries([{ setting_value: '100000' }]);
        await hybridSearch('user-1', 'test query');
        expect(vectorLimitParam()).toBe(RAG_FETCH_WIDTH_MAX);
      });

      it('floors a sub-legacy width at the default — the knob must not recreate #1263', async () => {
        // A width below the legacy 10 has no upside and silently halves the
        // candidate pool; `'5'` and typo-shaped values that parseInt truncates
        // (`parseInt('1e3') === 1`) both fall back to the default.
        routeQueries([{ setting_value: '5' }]);
        await hybridSearch('user-1', 'test query');
        expect(vectorLimitParam()).toBe(RAG_FETCH_WIDTH_DEFAULT);

        vi.resetAllMocks();
        invalidateRagFetchWidthCache();
        mocks.mockPool.connect.mockResolvedValue(mocks.mockClient);
        mocks.mockToSql.mockReturnValue('[0.1,0.2]');
        mocks.mockResolveUsecase.mockResolvedValue({
          config: {
            providerId: 'p1', id: 'p1', name: 'X',
            baseUrl: 'http://x/v1', apiKey: null,
            authType: 'none', verifySsl: true, defaultModel: 'bge-m3',
          },
          model: 'bge-m3',
        });
        mocks.mockGenerateEmbedding.mockResolvedValue([[0.1, 0.2]]);
        mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
        mocks.mockClientQuery.mockImplementation(async (sql: string) => {
          if (typeof sql === 'string' && sql.includes('page_embeddings')) return { rows: [] };
          return undefined;
        });
        routeQueries([{ setting_value: '1e3' }]);
        await hybridSearch('user-1', 'test query');
        expect(vectorLimitParam()).toBe(RAG_FETCH_WIDTH_DEFAULT);
      });

      it('soft-fails to the default when the settings read errors', async () => {
        mocks.mockQuery.mockImplementation(async (sql: string) => {
          if (sql.includes('rag_fetch_width')) throw new Error('connection reset');
          if (sql.includes('COUNT(*)')) return { rows: [{ embedded: 1, total: 1 }] };
          return { rows: [] };
        });
        const results = await hybridSearch('user-1', 'test query');
        expect(results).toEqual([]);
        expect(vectorLimitParam()).toBe(RAG_FETCH_WIDTH_DEFAULT);
      });

      it('keeps hnsw.ef_search covering a width above RAG_EF_SEARCH', async () => {
        // HNSW returns at most ef_search rows regardless of LIMIT, so a raised
        // width must raise ef_search with it or the vector leg silently
        // plateaus at 100 while the keyword leg keeps widening.
        routeQueries([{ setting_value: '150' }]);
        await hybridSearch('user-1', 'test query');
        const setLocal = mocks.mockClientQuery.mock.calls.find(
          (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('SET LOCAL hnsw.ef_search'),
        );
        expect(setLocal).toBeDefined();
        expect(setLocal![0]).toContain('= 150');
        expect(vectorLimitParam()).toBe(150);
      });

      it('builds the keyword SQL with the real FTS language, not a wiped mock', async () => {
        // Guards the vi.resetAllMocks() footgun: with a queued
        // `.mockResolvedValue('simple')` the reset left getFtsLanguage
        // returning undefined and every SQL assertion in this describe ran
        // against `plainto_tsquery('undefined', …)`.
        routeQueries([]);
        await hybridSearch('user-1', 'test query');
        const kwCall = mocks.mockQuery.mock.calls.find(
          (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ts_rank'),
        );
        expect(kwCall).toBeDefined();
        expect(kwCall![0]).toContain("plainto_tsquery('simple'");
      });
    });
  });

  describe('reciprocalRankFusion', () => {
    // Deterministic pageId from confluence id string so the same id always
    // produces the same pageId (needed for RRF merge key).
    const idMap = new Map<string, number>();
    let nextId = 1;
    const stablePageId = (id: string): number => {
      if (!idMap.has(id)) idMap.set(id, nextId++);
      return idMap.get(id)!;
    };
    // Vector-shaped by default: `score` is a cosine similarity, mirrored into
    // `vectorScore`. Fusion derives the per-leg values from which ARGUMENT the
    // result arrived in, not from these fields, so a fixture passed as a keyword
    // result still comes back carrying `keywordRank` — see the #1117 block below.
    const makeResult = (id: string, chunk: string, overrides?: Partial<SearchResult>): SearchResult => ({
      pageId: stablePageId(id),
      confluenceId: id,
      chunkText: chunk,
      pageTitle: `Page ${id}`,
      sectionTitle: `Section ${id}`,
      spaceKey: 'DEV',
      score: 0.5,
      vectorScore: 0.5,
      keywordRank: null,
      ...overrides,
    });

    it('should combine results from vector and keyword search', () => {
      const vectorResults = [makeResult('page-1', 'Vector chunk 1'), makeResult('page-2', 'Vector chunk 2')];
      const keywordResults = [makeResult('page-3', 'Keyword chunk 3'), makeResult('page-1', 'Keyword chunk 1')];
      const combined = reciprocalRankFusion(vectorResults, keywordResults);
      expect(combined).toHaveLength(3);
    });

    it('should boost results that appear in both searches (even with different chunkText)', () => {
      const vectorChunk = 'Specific embedding chunk about Redis configuration options';
      const keywordChunk = 'First 500 chars of the full page body text about Redis...';
      const combined = reciprocalRankFusion(
        [makeResult('page-1', vectorChunk)],
        [makeResult('page-1', keywordChunk)],
      );
      const singleSource = reciprocalRankFusion(
        [makeResult('page-1', vectorChunk)],
        [],
      );
      // Same page from both methods must produce a higher combined RRF score
      expect(combined).toHaveLength(1);
      expect(combined[0].score).toBeGreaterThan(singleSource[0].score);
    });

    it('should always prefer vector chunk over keyword body text as representative', () => {
      // Vector chunks are purpose-built for LLM context; keyword results return raw body text.
      // Even if keyword ts_rank were numerically larger (different scale), vector chunk wins.
      const vectorResult = makeResult('page-1', 'High quality embedding chunk', { score: 0.9 });
      const keywordResult = makeResult('page-1', 'First 500 chars of body text', { score: 0.3 });
      const combined = reciprocalRankFusion([vectorResult], [keywordResult]);
      expect(combined).toHaveLength(1);
      expect(combined[0].chunkText).toBe('High quality embedding chunk');
    });

    it('should prefer vector chunk even when keyword score is numerically higher', () => {
      // ts_rank and cosine similarity are on different scales — never compare across methods.
      // Vector chunk always wins as the representative for LLM context.
      const vectorResult = makeResult('page-1', 'Low similarity chunk', { score: 0.2 });
      const keywordResult = makeResult('page-1', 'Highly relevant body text', { score: 0.8 });
      const combined = reciprocalRankFusion([vectorResult], [keywordResult]);
      expect(combined).toHaveLength(1);
      expect(combined[0].chunkText).toBe('Low similarity chunk');
    });

    it('should merge multiple vector chunks for the same page', () => {
      // Vector search can return multiple chunks from the same page
      const chunk1 = makeResult('page-1', 'First chunk from page', { score: 0.7 });
      const chunk2 = makeResult('page-1', 'Second chunk from page', { score: 0.9 });
      const keywordResult = makeResult('page-1', 'Body text of page', { score: 0.3 });
      const combined = reciprocalRankFusion([chunk1, chunk2], [keywordResult]);
      // All three entries for page-1 should merge into a single entry
      expect(combined).toHaveLength(1);
      // Representative should be the chunk with highest individual score (0.9)
      expect(combined[0].chunkText).toBe('Second chunk from page');
    });

    it('should handle empty vector results (keyword-only fallback)', () => {
      const keywordResults = [makeResult('page-1', 'Keyword result 1'), makeResult('page-2', 'Keyword result 2')];
      const combined = reciprocalRankFusion([], keywordResults);
      expect(combined).toHaveLength(2);
    });

    it('should handle both empty', () => {
      expect(reciprocalRankFusion([], [])).toHaveLength(0);
    });

    it('should sort by RRF score descending', () => {
      const vectorResults = [makeResult('page-a', 'Chunk A'), makeResult('page-b', 'Chunk B')];
      const keywordResults = [makeResult('page-b', 'Chunk B')]; // page-b in both
      const combined = reciprocalRankFusion(vectorResults, keywordResults);
      for (let i = 1; i < combined.length; i++) {
        expect(combined[i - 1].score).toBeGreaterThanOrEqual(combined[i].score);
      }
    });

    it('should not collapse standalone pages that share NULL confluenceId', () => {
      // Two standalone pages both have null confluenceId but distinct pageIds
      const standalone1: SearchResult = {
        pageId: 100,
        confluenceId: '',   // NULL from DB becomes empty string
        chunkText: 'Standalone article one',
        pageTitle: 'Article One',
        sectionTitle: 'Article One',
        spaceKey: null,
        score: 0.5,
        vectorScore: null,
        keywordRank: 0.5,
      };
      const standalone2: SearchResult = {
        pageId: 200,
        confluenceId: '',   // same empty confluenceId
        chunkText: 'Standalone article two',
        pageTitle: 'Article Two',
        sectionTitle: 'Article Two',
        spaceKey: null,
        score: 0.5,
        vectorScore: null,
        keywordRank: 0.5,
      };
      const combined = reciprocalRankFusion([], [standalone1, standalone2]);
      // Both should survive because RRF key uses pageId, not confluenceId
      expect(combined).toHaveLength(2);
    });

    // ── #1117: the documented bounds on `score`, made executable ─────────────
    //
    // `SearchResult.score`'s JSDoc quotes worst-case fusion values, and the
    // prose version has been wrong twice — once too low (it assumed one rank per
    // leg, ignoring that the vector leg is per-CHUNK so one page's contributions
    // sum) and once too narrow (it quoted the chat-path limit as if it were
    // global). These pin the figures so the next edit has to agree with
    // arithmetic rather than with a comment.
    describe('documented fusion bounds', () => {
      it('matches the closed form for a page occupying every vector slot', () => {
        // Ten chunks of ONE page is what `rrfWorstCase(10)` describes; assert the
        // helper against the function it documents rather than against itself.
        const chunks = Array.from({ length: 10 }, (_, i) =>
          makeResult('bound-page', `chunk ${i}`, { score: 0.5 - i * 0.01 }),
        );
        const combined = reciprocalRankFusion(chunks, []);
        expect(combined).toHaveLength(1);
        expect(combined[0].score).toBeCloseTo(rrfWorstCase(10), 12);
      });

      it('caps the chat path below the 0.4 confidence threshold at the default width', () => {
        // /llm/ask uses topK=5 → stage limit = the default fetch width (10),
        // under EE ACL too (max(10, ceil(5*1.5)=8) = 10 — the #1263 fix).
        // This is the bound that made "reading the fusion score as a cosine
        // always yields Low confidence" true in #1117's analysis.
        expect(rrfWorstCase(resolveStageLimit(5, RAG_FETCH_WIDTH_DEFAULT, false), true)).toBeLessThan(0.4);
        expect(rrfWorstCase(resolveStageLimit(5, RAG_FETCH_WIDTH_DEFAULT, true), true)).toBeLessThan(0.4);
        expect(rrfWorstCase(10, true)).toBeCloseTo(0.1694, 3);
      });

      it('pins the /api/search row at limit=20: ~0.302 plain, ~0.419 under EE ACL', () => {
        // Every row of the doc table gets a pin — its prose version has now
        // been wrong three times, most recently in this very PR (~0.304).
        expect(resolveStageLimit(20, RAG_FETCH_WIDTH_DEFAULT, false)).toBe(20);
        expect(rrfWorstCase(20, true)).toBeCloseTo(0.3020, 3);
        // Nothing thresholds the fusion score on that path, but the chat-path
        // bound must not be restated as a global one — this test is the
        // reason that distinction stays in the JSDoc.
        expect(resolveStageLimit(20, RAG_FETCH_WIDTH_DEFAULT, true)).toBe(30);
        expect(rrfWorstCase(30, true)).toBeGreaterThan(0.4);
        expect(rrfWorstCase(30, true)).toBeCloseTo(0.4191, 3);
      });

      it('an admin-raised width raises the bound with it — past 1.0 at the cap', () => {
        // The JSDoc's warning that the fusion value is not bounded near ~0.4
        // either: at the RAG_FETCH_WIDTH_MAX cap the worst case passes 1.
        expect(rrfWorstCase(RAG_FETCH_WIDTH_MAX, true)).toBeGreaterThan(1);
      });
    });

    // ── #1117 stage 1: raw per-leg scores survive fusion ─────────────────────
    //
    // Fusion overwrote `score` with the RRF value and discarded the cosine the
    // vector leg had measured. With k=60 over two legs the RRF value maxes out
    // near 1/61 + 1/61 ≈ 0.0328 for the common case — more when one page fills
    // several vector slots — and ConfidenceBadge reads that field as a
    // cosine similarity (>= 0.7 high / >= 0.4 medium) — so every hybrid answer
    // rendered "Low confidence". The fix carries the per-leg values alongside
    // the fusion score rather than replacing them.
    describe('raw per-leg score plumbing (#1117)', () => {
      it('carries the vector leg cosine as vectorScore, with no keywordRank', () => {
        const combined = reciprocalRankFusion([makeResult('p-v', 'chunk', { score: 0.83 })], []);
        expect(combined[0].vectorScore).toBe(0.83);
        expect(combined[0].keywordRank).toBeNull();
      });

      it('carries the keyword leg ts_rank as keywordRank, with no vectorScore', () => {
        const combined = reciprocalRankFusion([], [makeResult('p-k', 'body', { score: 0.11 })]);
        expect(combined[0].keywordRank).toBe(0.11);
        expect(combined[0].vectorScore).toBeNull();
      });

      it('carries both when a page is found by both legs', () => {
        const combined = reciprocalRankFusion(
          [makeResult('p-both', 'vector chunk', { score: 0.77 })],
          [makeResult('p-both', 'body text', { score: 0.09 })],
        );
        expect(combined).toHaveLength(1);
        expect(combined[0].vectorScore).toBe(0.77);
        expect(combined[0].keywordRank).toBe(0.09);
      });

      it('reports the best chunk cosine when one page has several vector chunks', () => {
        const combined = reciprocalRankFusion(
          [
            makeResult('p-multi', 'weaker chunk', { score: 0.40 }),
            makeResult('p-multi', 'stronger chunk', { score: 0.91 }),
          ],
          [],
        );
        expect(combined).toHaveLength(1);
        // Same chunk the existing best-chunk rule already picks as representative.
        expect(combined[0].chunkText).toBe('stronger chunk');
        expect(combined[0].vectorScore).toBe(0.91);
      });

      it('derives the leg from the argument, not from the fixture fields', () => {
        // makeResult is vector-shaped (vectorScore mirrors score). Passed as a
        // keyword result it must still come back as a keyword hit, otherwise a
        // keyword-only page would report a similarity it never had.
        const vectorShaped = makeResult('p-arg', 'body', { score: 0.31, vectorScore: 0.31 });
        const combined = reciprocalRankFusion([], [vectorShaped]);
        expect(combined[0].vectorScore).toBeNull();
        expect(combined[0].keywordRank).toBe(0.31);
      });

      it('leaves `score` as the RRF fusion value and does not reorder', () => {
        // Load-bearing: `score` stays the ranking quantity. If it were replaced
        // by the cosine, ordering would change and this PR would stop being a
        // reporting-only change.
        const vec = [makeResult('r-1', 'c1', { score: 0.10 }), makeResult('r-2', 'c2', { score: 0.99 })];
        const combined = reciprocalRankFusion(vec, []);
        // r-1 ranked first in the vector leg, so RRF puts it first even though
        // its cosine is far lower than r-2's.
        expect(combined.map((r) => r.chunkText)).toEqual(['c1', 'c2']);
        expect(combined[0].score).toBeCloseTo(1 / 61, 10);
        expect(combined[0].score).not.toBe(combined[0].vectorScore);
      });
    });
  });

  // ── Newly exported functions ────────────────────────────────────────────────

  describe('keywordSearch (exported)', () => {
    beforeEach(() => {
      vi.resetAllMocks();
      mocks.mockPool.connect.mockResolvedValue(mocks.mockClient);
      mocks.mockToSql.mockReturnValue('[0.1,0.2]');
    });

    it('returns empty array when query is empty', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      const results = await keywordSearch('user-1', '   ');
      expect(results).toEqual([]);
      // query() should NOT have been called
      expect(mocks.mockQuery).not.toHaveBeenCalled();
    });

    it('calls query() with plainto_tsquery parameterized SQL', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      mocks.mockQuery.mockResolvedValueOnce({ rows: [] });

      await keywordSearch('user-1', 'redis caching', 5);

      expect(mocks.mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mocks.mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('plainto_tsquery');
      expect(sql).toContain('pages cp');
      expect(params).toContain('redis caching');
      expect(params).toContain(5);
    });

    it('maps result rows to SearchResult shape', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [
          {
            page_id: 42,
            confluence_id: 'PAGE-42',
            title: 'Redis Overview',
            space_key: 'DEV',
            body_text: 'First 500 chars of body text here.',
            rank: 0.75,
          },
        ],
      });

      const results = await keywordSearch('user-1', 'redis', 10);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        pageId: 42,
        confluenceId: 'PAGE-42',
        pageTitle: 'Redis Overview',
        spaceKey: 'DEV',
        score: 0.75,
      });
      expect(results[0].chunkText).toBe('First 500 chars of body text here.');
      // #1117: the keyword leg declares its provenance. `vectorScore: null` is
      // load-bearing — a keyword hit measured no similarity, and a 0 here would
      // reach ConfidenceBadge as "measured, and terrible".
      expect(results[0].keywordRank).toBe(0.75);
      expect(results[0].vectorScore).toBeNull();
    });
  });

  describe('vectorSearch (exported)', () => {
    beforeEach(() => {
      vi.resetAllMocks();
      mocks.mockPool.connect.mockResolvedValue(mocks.mockClient);
      mocks.mockClient.release.mockResolvedValue(undefined);
      mocks.mockToSql.mockReturnValue('[0.1,0.2]');
    });

    it('uses BEGIN/SET LOCAL/COMMIT transaction pattern', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({ rows: [] }); // SELECT
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      await vectorSearch('user-1', new Array(1024).fill(0.1), 5);

      const queries = mocks.mockClientQuery.mock.calls.map((c: unknown[]) => c[0]);
      expect(queries[0]).toBe('BEGIN');
      expect(queries[1]).toMatch(/SET LOCAL hnsw.ef_search/);
      expect(queries[3]).toBe('COMMIT');
    });

    it('maps result rows to SearchResult shape with similarity score', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({
        rows: [
          {
            page_id: 7,
            confluence_id: 'PAGE-7',
            chunk_text: 'Sample chunk content',
            metadata: { page_title: 'Vector Page', section_title: 'Intro', space_key: 'DEV' },
            distance: 0.3,
          },
        ],
      }); // SELECT
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      const results = await vectorSearch('user-1', new Array(1024).fill(0.1), 5);
      expect(results).toHaveLength(1);
      expect(results[0].pageId).toBe(7);
      expect(results[0].score).toBeCloseTo(0.7); // 1 - 0.3
      expect(results[0].chunkText).toBe('Sample chunk content');
      // #1117: the vector leg reports the cosine in its own field too, so the
      // value survives RRF fusion overwriting `score`.
      expect(results[0].vectorScore).toBeCloseTo(0.7);
      expect(results[0].keywordRank).toBeNull();
    });

    it('reports a negative vectorScore rather than clamping it', async () => {
      // pgvector's `<=>` is a cosine DISTANCE with range [0,2], so `1 - distance`
      // is [-1,1]. Nothing clamps it; display sites must not assume [0,1].
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({
        rows: [
          {
            page_id: 8,
            confluence_id: 'PAGE-8',
            chunk_text: 'Opposing chunk',
            metadata: { page_title: 'Opposite', section_title: 'x', space_key: 'DEV' },
            distance: 1.4,
          },
        ],
      }); // SELECT
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      const results = await vectorSearch('user-1', new Array(1024).fill(0.1), 5);
      expect(results[0].vectorScore).toBeCloseTo(-0.4);
    });

    it('calls client.release() even on error', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockRejectedValueOnce(new Error('DB exploded')); // SELECT
      // ROLLBACK
      mocks.mockClientQuery.mockResolvedValueOnce(undefined);

      await expect(vectorSearch('user-1', new Array(1024).fill(0.1))).rejects.toThrow('DB exploded');
      expect(mocks.mockClient.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('recordSearchAnalytics (exported)', () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    it('calls query() with INSERT INTO search_analytics', async () => {
      mocks.mockQuery.mockResolvedValueOnce({ rows: [] });

      await recordSearchAnalytics('user-1', 'my query', 5, 0.9, 'keyword');

      expect(mocks.mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mocks.mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO search_analytics');
      expect(params).toContain('user-1');
      expect(params).toContain('my query');
      expect(params).toContain(5);
      expect(params).toContain('keyword');
    });

    it('swallows errors without throwing', async () => {
      mocks.mockQuery.mockRejectedValueOnce(new Error('analytics table gone'));

      // Should NOT throw
      await expect(recordSearchAnalytics('user-1', 'test', 0, null, 'hybrid')).resolves.toBeUndefined();
    });
  });
});
