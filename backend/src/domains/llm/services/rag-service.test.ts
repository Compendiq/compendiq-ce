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
  const mockResolveRerank = vi.fn(async () => null);
  const mockRerank = vi.fn(async () => []);
  // Implementation form on purpose (see the rbac note below): these must
  // survive the `vi.resetAllMocks()` several describes run.
  const mockFilterAccessiblePages = vi.fn(async (_u: unknown, ids: number[]) => new Set(ids));
  // Default false = community edition, which is what every test but the
  // #1273 fork F5 ACL case wants.
  const mockIsFeatureEnabled = vi.fn(() => false);

  return {
    mockClientQuery,
    mockClient,
    mockPool,
    mockQuery,
    mockGenerateEmbedding,
    mockResolveUsecase,
    mockGetUserAccessibleSpaces,
    mockToSql,
    mockResolveRerank,
    mockRerank,
    mockFilterAccessiblePages,
    mockIsFeatureEnabled,
  };
});

vi.mock('../../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mocks.mockQuery(...args),
  getPool: () => mocks.mockPool,
  getVectorPool: () => mocks.mockPool,
}));

vi.mock('./llm-provider-resolver.js', () => ({
  resolveUsecase: (...args: unknown[]) => mocks.mockResolveUsecase(...args),
  // #1104: unassigned by default — the rerank stage stays off unless a test
  // configures it.
  resolveRerankUsecase: (...args: unknown[]) => mocks.mockResolveRerank(...args),
  // #1115 P3: same story for the image leg. `null` is the ordinary
  // deployment state (no VL model assigned), so the leg does not run and this
  // unit suite keeps describing the two text legs. Its own behaviour is
  // `image-leg-search.integration.test.ts`'s subject, against real Postgres.
  resolveImageEmbeddingUsecase: vi.fn(async () => null),
}));

// The rerank boundary is stubbed whole so rerank-client's own imports (the
// provider-request infra) never load in this unit environment.
vi.mock('./rerank-client.js', () => ({
  rerank: (...args: unknown[]) => mocks.mockRerank(...args),
  RERANK_DOC_MAX_CHARS: 2000,
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
  // #1104: the batched ACL filter; default = everything accessible.
  filterAccessiblePages: (...args: unknown[]) => mocks.mockFilterAccessiblePages(...(args as [unknown, number[]])),
}));

// Only `isFeatureEnabled` is overridden — importOriginal keeps every other
// export real, so mocking the loader here cannot change what the rest of
// the import graph sees.
vi.mock('../../../core/enterprise/loader.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isFeatureEnabled: (...args: unknown[]) => mocks.mockIsFeatureEnabled(...(args as [])),
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
  // mocks built its keyword SQL with `websearch_to_tsquery('undefined', …)`, and
  // assertions against that SQL were exercising a string no deployment
  // produces. A test below pins the language survives into the SQL.
  getFtsLanguage: vi.fn(async () => 'simple'),
}));

import { buildRagContext, hybridSearch, reciprocalRankFusion, fuseWithStableHead, rrfWorstCase, vectorSearch, keywordSearch, recordSearchAnalytics, resolveStageLimit, computeRetrievalConfidence, RAG_FETCH_WIDTH_DEFAULT, truncateAtDistinctPages, PAGE_FANOUT, VECTOR_RAW_LIMIT_CAP, vectorRawLimit, IDENTIFIER_LOOKUP_CANDIDATES } from './rag-service.js';
import type { SearchResult } from './rag-service.js';
import { invalidateRagEfSearchCache, invalidateRagFetchWidthCache, invalidateRagRerankCandidatesCache, invalidateRagContextCharsCache, invalidateRagPinIdentifiersCache, invalidateRagMmrCache, invalidateRagRankingPriorCache, RAG_CONTEXT_CHARS_DEFAULT, RAG_RERANK_CANDIDATES_MIN } from '../../../core/services/admin-settings-service.js';
import { CircuitBreakerOpenError } from '../../../core/services/circuit-breaker.js';

describe('RAG Service', () => {
  // #1285 — the `RAG_EF_SEARCH` module constant is gone. The floor is
  // `admin_settings.rag_ef_search`, so its parsing, bounds and env-bootstrap
  // cascade are tested where the reader lives
  // (`core/services/admin-settings-service.test.ts`), the 2x-headroom
  // arithmetic in `hnsw-ef-search.test.ts`, and what the vector leg actually
  // writes into `SET LOCAL` in the fetch-width describe below.

  describe('buildRagContext', () => {
    it('prefers the assembled contextText and drops the Section clause for multi-section windows (#1106 PR 2)', () => {
      const results = [
        {
          pageId: 1, confluenceId: 'p1', chunkText: 'best chunk only',
          contextText: 'merged sibling window', mergedChunkCount: 3,
          contextSpansSections: true,
          pageTitle: 'Merged', sectionTitle: 'One Section', spaceKey: 'DEV',
          score: 0.03, vectorScore: 0.5, keywordRank: null,
        },
        {
          pageId: 2, confluenceId: 'p2', chunkText: 'plain chunk',
          pageTitle: 'Plain', sectionTitle: 'Sec', spaceKey: 'DEV',
          score: 0.02, vectorScore: 0.4, keywordRank: null,
        },
      ];
      const ctx = buildRagContext(results);
      expect(ctx).toContain('merged sibling window');
      expect(ctx).not.toContain('best chunk only');
      // A single section label must not claim a three-section window…
      expect(ctx).not.toContain('Section: One Section');
      // …while single-chunk rows keep their honest section header.
      expect(ctx).toContain('Section: Sec');
    });

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

  describe('vectorSearch (via hybridSearch)', () => {
    beforeEach(() => {
      vi.resetAllMocks();
      // The fetch-width TTL cache (admin-settings-service) is module state —
      // clear it so no test reads a width another test resolved.
      invalidateRagFetchWidthCache();
      invalidateRagEfSearchCache();
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

    // ── #1114 query-instruction prefix ───────────────────────────────────────
    //
    // The formatter itself is unit-tested in query-instruction.test.ts. These
    // pin that it is actually WIRED to the query path and keyed off the
    // resolved model — a correct formatter nobody calls is the failure mode
    // unit tests cannot see.

    async function runSearchWith(model: string, question: string) {
      mocks.mockResolveUsecase.mockResolvedValue({
        config: {
          providerId: 'p1', id: 'p1', name: 'X',
          baseUrl: 'http://x/v1', apiKey: null,
          authType: 'none', verifySsl: true, defaultModel: model,
        },
        model,
      });
      mocks.mockGenerateEmbedding.mockResolvedValue([[...new Array(1024).fill(0.1)]]);
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      mocks.mockClientQuery.mockResolvedValue({ rows: [] });
      mocks.mockQuery.mockResolvedValue({ rows: [] });
      await hybridSearch('user-1', question);
      // generateEmbedding(config, model, text) — the text is arg 3.
      return mocks.mockGenerateEmbedding.mock.calls[0]?.[2] as string;
    }

    it('#1114: sends the query bare to a non-instruction model', async () => {
      const sent = await runSearchWith('bge-m3', 'how do I rotate the PAT?');
      expect(sent).toBe('how do I rotate the PAT?');
    });

    it('#1114: prefixes the query for an instruction-aware model, exact format', async () => {
      const sent = await runSearchWith('qwen3-embedding-4b', 'how do I rotate the PAT?');
      expect(sent).toContain('Instruct: ');
      // No space after `Query:` — the one detail the epic body got wrong.
      expect(sent).toContain('\nQuery:how do I rotate the PAT?');
      expect(sent).not.toContain('Query: how');
    });

    it('#1114: the prefix follows the resolved model, so it flips at a swap', async () => {
      // Same question, two models, one process — this is what a shadow swap
      // does to the live assignment, and nothing else has to be changed for
      // the query side to follow it.
      const before = await runSearchWith('bge-m3', 'q');
      mocks.mockGenerateEmbedding.mockClear();
      const after = await runSearchWith('qwen3-embedding-4b', 'q');
      expect(before).toBe('q');
      expect(after).not.toBe('q');
      expect(after).toContain('Instruct: ');
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

    // Deliberately UNCHANGED by #1114's prerequisite: the ROUTE now refuses
    // the turn on `embedding_failed`, but the SEARCH still runs its keyword
    // leg and still files this row. The refusal is only auditable because
    // the marker keeps being written — see _gap-predicate.ts's re-derivation.
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

    it('hands degradedReason and searchType to onRetrievalMeta — the #1105 gate reads health from here, not analytics', async () => {
      mocks.mockGenerateEmbedding.mockRejectedValue(new Error('Ollama unreachable'));
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      // Keyword leg ALSO empty: the callback is the only way the route can
      // tell this outage-shaped empty from a healthy "KB has nothing".
      mocks.mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('COUNT(*)')) return { rows: [{ embedded: 1, total: 1 }] };
        return { rows: [] };
      });

      const seen: Array<Record<string, unknown>> = [];
      const results = await hybridSearch('user-1', 'test query', 5, undefined, {
        onRetrievalMeta: (meta) => seen.push(meta as unknown as Record<string, unknown>),
      });

      expect(results).toEqual([]);
      // searchType 'hybrid' also covers "both legs empty" — documented on
      // RetrievalMeta: it means "not a keyword fallback", nothing more.
      expect(seen).toEqual([{
        degradedReason: 'embedding_failed',
        healthCaveat: 'embedding_failed',
        searchType: 'hybrid',
        embeddingCoverage: 1,
        aclEmptied: false,
      }]);
    });

    it('a throwing onRetrievalMeta observer does not fail the search', async () => {
      mocks.mockGenerateEmbedding.mockRejectedValue(new Error('Ollama unreachable'));
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      mocks.mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('COUNT(*)')) return { rows: [{ embedded: 1, total: 1 }] };
        return { rows: [] };
      });

      const results = await hybridSearch('user-1', 'test query', 5, undefined, {
        onRetrievalMeta: () => {
          throw new Error('metrics consumer bug');
        },
      });
      expect(results).toEqual([]);
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

    // ── #1351: HybridSearchOptions.spaceKey threads to BOTH legs ──────────
    it('scopes both the vector and keyword legs when opts.spaceKey is set', async () => {
      const fakeEmbedding = new Array(1024).fill(0.1);
      mocks.mockGenerateEmbedding.mockResolvedValue([[...fakeEmbedding]]);
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);

      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({ rows: [] }); // vector SELECT empty
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT
      mocks.mockQuery.mockResolvedValue({ rows: [] }); // keyword SELECT + analytics

      await hybridSearch('user-1', 'test query', 5, undefined, { spaceKey: 'DEV' });

      const vectorSelectCall = mocks.mockClientQuery.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('page_embeddings'),
      );
      expect(vectorSelectCall![0]).toContain('AND cp.space_key = $5');
      expect(vectorSelectCall![1]).toContain('DEV');

      const keywordSelectCall = mocks.mockQuery.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('ts_rank'),
      );
      expect(keywordSelectCall![0]).toContain('AND cp.space_key = $5');
      expect(keywordSelectCall![1]).toContain('DEV');
    });

    it('leaves both legs unscoped when opts is omitted (no-op default for existing callers)', async () => {
      const fakeEmbedding = new Array(1024).fill(0.1);
      mocks.mockGenerateEmbedding.mockResolvedValue([[...fakeEmbedding]]);
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);

      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({ rows: [] }); // vector SELECT empty
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT
      mocks.mockQuery.mockResolvedValue({ rows: [] }); // keyword SELECT + analytics

      // Exactly what RAG chat / deep search / the eval harness call today —
      // no 5th arg at all.
      await hybridSearch('user-1', 'test query');

      const vectorSelectCall = mocks.mockClientQuery.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('page_embeddings'),
      );
      expect(vectorSelectCall![0]).not.toContain('cp.space_key = $');

      const keywordSelectCall = mocks.mockQuery.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('ts_rank'),
      );
      // The SELECT list always names `cp.space_key` as a returned column
      // (used to populate `SearchResult.spaceKey`); it is the scoping
      // PREDICATE that must be absent.
      expect(keywordSelectCall![0]).not.toContain('cp.space_key = $');
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
        invalidateRagEfSearchCache();
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

      /**
       * Route query() by SQL text; `adminRows` answers the rag_fetch_width
       * read and `efRows` (#1285) the rag_ef_search one. Both default to an
       * absent row, so each getter resolves to its own default.
       */
      function routeQueries(
        adminRows: Array<{ setting_value: string }>,
        efRows: Array<{ setting_value: string }> = [],
      ) {
        mocks.mockQuery.mockImplementation(async (sql: string) => {
          if (sql.includes('rag_fetch_width')) return { rows: adminRows };
          if (sql.includes('rag_ef_search')) return { rows: efRows };
          if (sql.includes('COUNT(*)')) return { rows: [{ embedded: 1, total: 1 }] };
          return { rows: [] };
        });
      }

      /** The `SET LOCAL hnsw.ef_search = N` the vector leg's transaction ran. */
      function efSearchStatement(): string {
        const call = mocks.mockClientQuery.mock.calls.find(
          (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('SET LOCAL hnsw.ef_search'),
        );
        expect(call).toBeDefined();
        return call![0] as string;
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
        // #1106: the SQL LIMIT is the RAW chunk fetch — PAGE_FANOUT x the page width.
        expect(vectorLimitParam()).toBe(PAGE_FANOUT * RAG_FETCH_WIDTH_DEFAULT);
        expect(keywordLimitParam()).toBe(RAG_FETCH_WIDTH_DEFAULT);
      });

      it('honours an admin-configured width at runtime (no restart)', async () => {
        routeQueries([{ setting_value: '12' }]);
        await hybridSearch('user-1', 'test query');
        expect(vectorLimitParam()).toBe(PAGE_FANOUT * 12);
        expect(keywordLimitParam()).toBe(12);
      });

      it('falls back to the default on a garbage admin value', async () => {
        routeQueries([{ setting_value: 'banana' }]);
        await hybridSearch('user-1', 'test query');
        // #1106: the SQL LIMIT is the RAW chunk fetch — PAGE_FANOUT x the page width.
        expect(vectorLimitParam()).toBe(PAGE_FANOUT * RAG_FETCH_WIDTH_DEFAULT);
      });

      it('clamps an absurd admin value to RAG_FETCH_WIDTH_MAX', async () => {
        routeQueries([{ setting_value: '100000' }]);
        await hybridSearch('user-1', 'test query');
        // #1106: width clamps to 200, and the RAW fetch then hits its own
        // cap — min(4 x 200, 500) = 500, the exact value that keeps 2x ef
        // headroom inside pgvector's 1000 ceiling.
        expect(vectorLimitParam()).toBe(VECTOR_RAW_LIMIT_CAP);
      });

      it('floors a sub-legacy width at the default — the knob must not recreate #1263', async () => {
        // A width below the legacy 10 has no upside and silently halves the
        // candidate pool; `'5'` and typo-shaped values that parseInt truncates
        // (`parseInt('1e3') === 1`) both fall back to the default.
        routeQueries([{ setting_value: '5' }]);
        await hybridSearch('user-1', 'test query');
        // #1106: the SQL LIMIT is the RAW chunk fetch — PAGE_FANOUT x the page width.
        expect(vectorLimitParam()).toBe(PAGE_FANOUT * RAG_FETCH_WIDTH_DEFAULT);

        vi.resetAllMocks();
        invalidateRagFetchWidthCache();
        invalidateRagEfSearchCache();
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
        // #1106: the SQL LIMIT is the RAW chunk fetch — PAGE_FANOUT x the page width.
        expect(vectorLimitParam()).toBe(PAGE_FANOUT * RAG_FETCH_WIDTH_DEFAULT);
      });

      it('soft-fails to the default when the settings read errors', async () => {
        mocks.mockQuery.mockImplementation(async (sql: string) => {
          if (sql.includes('rag_fetch_width')) throw new Error('connection reset');
          if (sql.includes('COUNT(*)')) return { rows: [{ embedded: 1, total: 1 }] };
          return { rows: [] };
        });
        const results = await hybridSearch('user-1', 'test query');
        expect(results).toEqual([]);
        // #1106: the SQL LIMIT is the RAW chunk fetch — PAGE_FANOUT x the page width.
        expect(vectorLimitParam()).toBe(PAGE_FANOUT * RAG_FETCH_WIDTH_DEFAULT);
      });

      it('keeps hnsw.ef_search covering a width above the configured floor', async () => {
        // HNSW returns at most ef_search rows regardless of LIMIT, so a raised
        // width must raise ef_search with it or the vector leg silently
        // plateaus at 100 while the keyword leg keeps widening. 2x the limit,
        // not 1x — ef_search == k is HNSW's worst recall setting. Since
        // #1106 the covered quantity is the RAW chunk fetch: width 150 →
        // raw min(4 x 150, 500) = 500 → ef exactly at the 1000 clamp.
        routeQueries([{ setting_value: '150' }]);
        await hybridSearch('user-1', 'test query');
        expect(efSearchStatement()).toContain('= 1000');
        expect(vectorLimitParam()).toBe(VECTOR_RAW_LIMIT_CAP);
      });

      it('takes the ef_search FLOOR from the rag_ef_search knob (#1285)', async () => {
        // The knob's whole point: an admin who widened the fetch used to have
        // the recall they expected bounded by an env var read at module load,
        // which they may never have set and could not change without a
        // restart. At the default width the floor IS the value written, so a
        // raised row has to show up here verbatim.
        routeQueries([], [{ setting_value: '400' }]);
        await hybridSearch('user-1', 'test query');
        expect(efSearchStatement()).toContain('= 400');
      });

      it('keeps the 2x headroom over a LOWERED floor rather than under-covering the fetch', async () => {
        // A floor below the raw fetch must not cap the scan below its own
        // LIMIT: `efSearchFor` still hands the probe 2x its raw row count.
        // width 12 → raw 4 x 12 = 48 → ef = max(40, 96) = 96.
        routeQueries([{ setting_value: '12' }], [{ setting_value: '40' }]);
        await hybridSearch('user-1', 'test query');
        expect(efSearchStatement()).toContain('= 96');
      });

      it('soft-fails the floor to 100 when the rag_ef_search read errors', async () => {
        // Same direction as the fetch width: a failed admin_settings read must
        // degrade the tuning, never the search.
        mocks.mockQuery.mockImplementation(async (sql: string) => {
          if (sql.includes('rag_ef_search')) throw new Error('connection reset');
          if (sql.includes('COUNT(*)')) return { rows: [{ embedded: 1, total: 1 }] };
          return { rows: [] };
        });
        const results = await hybridSearch('user-1', 'test query');
        expect(results).toEqual([]);
        expect(efSearchStatement()).toContain('= 100');
      });

      it('resolves the floor BEFORE it checks a vector-pool client out (#1285 r1)', async () => {
        // Review r2 — r1's fix was unguarded: moving `await efSearchFor(…)`
        // back below `getVectorPool().connect()` left this whole suite green,
        // because the position-indexed mocks only ever look at statements
        // INSIDE the transaction and cannot see an admin_settings SELECT
        // issued on the main pool while a client is held.
        //
        // What that regression costs is invisible in a result: on a cache
        // miss the read is a nested acquire, so under saturation the probe
        // waits out `connectionTimeoutMillis`, soft-fails to the default
        // floor, caches THAT for a TTL and holds its own scarce vector-pool
        // client for the whole stall. Only the ORDER shows it, so assert the
        // order. (#1260 adds a fifth probe against this callsite.)
        routeQueries([], [{ setting_value: '400' }]);
        await hybridSearch('user-1', 'test query');

        const efReadIndex = mocks.mockQuery.mock.calls.findIndex(
          (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('rag_ef_search'),
        );
        expect(efReadIndex, 'the floor read must have happened').toBeGreaterThanOrEqual(0);
        expect(mocks.mockPool.connect.mock.invocationCallOrder.length).toBeGreaterThan(0);
        expect(
          mocks.mockQuery.mock.invocationCallOrder[efReadIndex],
          'rag_ef_search must be read before the vector pool hands out a client',
        ).toBeLessThan(mocks.mockPool.connect.mock.invocationCallOrder[0]);
        // …and the value still reaches the transaction, so this is an
        // ordering guard on a working probe rather than on a skipped one.
        expect(efSearchStatement()).toContain('= 400');
      });

      it('builds the keyword SQL with the real FTS language, not a wiped mock', async () => {
        // Guards the vi.resetAllMocks() footgun: with a queued
        // `.mockResolvedValue('simple')` the reset left getFtsLanguage
        // returning undefined and every SQL assertion in this describe ran
        // against `websearch_to_tsquery('undefined', …)`.
        routeQueries([]);
        await hybridSearch('user-1', 'test query');
        const kwCall = mocks.mockQuery.mock.calls.find(
          (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ts_rank'),
        );
        expect(kwCall).toBeDefined();
        expect(kwCall![0]).toContain("websearch_to_tsquery('simple'");
      });
    });
  });

  describe('computeRetrievalConfidence (#1105)', () => {
    const base = {
      pageId: 1, confluenceId: 'p', chunkText: 't', pageTitle: 'T',
      sectionTitle: 'S', spaceKey: 'DEV', score: 0.03,
    };

    it('a PINNED head is never measurable — a verified exact match must never be auto-refused (#1273 B3)', () => {
      // The MOVED-pin case is the one that used to break the claim: the
      // row keeps its measured cosine, and position 0 is exactly what the
      // vector-led rule reads — pinning could CAUSE a refusal the unpinned
      // ranking would not have produced.
      const moved = [
        { ...base, vectorScore: 0.24, keywordRank: null, pinned: true as const },
        { ...base, pageId: 2, vectorScore: 0.9, keywordRank: null },
      ];
      expect(computeRetrievalConfidence(moved)).toEqual({ score: null, basis: 'none' });
      // Same guard covers the rerank basis (a moved pin keeps rerankScore).
      const movedReranked = [
        { ...base, vectorScore: 0.24, keywordRank: null, rerankScore: 0.05, pinned: true as const },
        { ...base, pageId: 2, vectorScore: 0.9, keywordRank: null, rerankScore: 0.9 },
      ];
      expect(computeRetrievalConfidence(movedReranked)).toEqual({ score: null, basis: 'none' });
    });

    it('empty result set from HEALTHY retrieval scores 0 with basis none — the one unmeasured case that refuses', () => {
      expect(computeRetrievalConfidence([])).toEqual({ score: 0, basis: 'none' });
      expect(computeRetrievalConfidence([], null)).toEqual({ score: 0, basis: 'none' });
    });

    it('empty result set under a degraded reason is an outage symptom: null, never refusable (#1268 B1)', () => {
      // "The KB has nothing on this" is only a measurement when retrieval
      // actually ran. Vector leg down or corpus unembedded → unmeasurable.
      expect(computeRetrievalConfidence([], 'embedding_failed')).toEqual({ score: null, basis: 'none' });
      expect(computeRetrievalConfidence([], 'no_embeddings')).toEqual({ score: null, basis: 'none' });
    });

    it('a degraded reason with NON-empty results still measures normally', () => {
      // Degradation exempts only the empty set: results that did come back
      // carry whatever signal they carry.
      const results = [{ ...base, vectorScore: 0.44, keywordRank: null }];
      expect(computeRetrievalConfidence(results, 'embedding_failed')).toEqual({ score: 0.44, basis: 'similarity' });
    });

    it('rerank evidence wins over similarity when every row was scored', () => {
      const results = [
        { ...base, vectorScore: 0.9, keywordRank: null, rerankScore: 0.4 },
        { ...base, pageId: 2, vectorScore: 0.2, keywordRank: null, rerankScore: 0.7 },
      ];
      expect(computeRetrievalConfidence(results)).toEqual({ score: 0.7, basis: 'rerank' });
    });

    it('PARTIAL rerank coverage downgrades to similarity — one measured score must not speak for unscored rows', () => {
      // A truncating/malformed provider leaves unscored rows appended after
      // the scored ones (#1104's mixed-set path). The lone 0.12 below must
      // not gate a set whose unscored row carries cosine 0.88.
      const results = [
        { ...base, vectorScore: 0.3, keywordRank: null, rerankScore: 0.12 },
        { ...base, pageId: 2, vectorScore: 0.88, keywordRank: null },
      ];
      expect(computeRetrievalConfidence(results)).toEqual({ score: 0.88, basis: 'similarity' });
    });

    it('a KEYWORD-LED set is unmeasurable even when a stray vector row exists (#1268 review)', () => {
      // Mid re-embed, the vector leg returns one marginal chunk that RRF
      // ranks BELOW several strong FTS matches. The prompt is grounded by
      // rows the vector leg never measured — gating on the stray cosine
      // would refuse a set whose zero-vector twin answers.
      const results = [
        { ...base, vectorScore: null, keywordRank: 0.6 },
        { ...base, pageId: 2, vectorScore: null, keywordRank: 0.5 },
        { ...base, pageId: 3, vectorScore: 0.09, keywordRank: null },
      ];
      expect(computeRetrievalConfidence(results)).toEqual({ score: null, basis: 'none' });
    });

    it("empty set under 'coverage_unknown' (probe failed) is unmeasurable — health that could not be verified must not refuse", () => {
      expect(computeRetrievalConfidence([], 'coverage_unknown')).toEqual({ score: null, basis: 'none' });
    });

    it("'coverage_unknown' with NON-empty vector-led results still measures normally", () => {
      const results = [{ ...base, vectorScore: 0.44, keywordRank: null }];
      expect(computeRetrievalConfidence(results, 'coverage_unknown')).toEqual({ score: 0.44, basis: 'similarity' });
    });

    it('partial rerank coverage with no vector signal anywhere is unmeasurable, not rerank-gated', () => {
      const results = [
        { ...base, vectorScore: null, keywordRank: 0.4, rerankScore: 0.12 },
        { ...base, pageId: 2, vectorScore: null, keywordRank: 0.3 },
      ];
      expect(computeRetrievalConfidence(results)).toEqual({ score: null, basis: 'none' });
    });

    it('falls back to max cosine when nothing was reranked', () => {
      const results = [
        { ...base, vectorScore: 0.31, keywordRank: null },
        { ...base, pageId: 2, vectorScore: 0.58, keywordRank: 0.2 },
      ];
      expect(computeRetrievalConfidence(results)).toEqual({ score: 0.58, basis: 'similarity' });
    });

    it('clamps a negative cosine to 0 — a threshold in [0,1) must still catch it', () => {
      const results = [{ ...base, vectorScore: -0.2, keywordRank: null }];
      expect(computeRetrievalConfidence(results)).toEqual({ score: 0, basis: 'similarity' });
    });

    it('keyword-only results are unmeasurable: null score, basis none', () => {
      const results = [{ ...base, vectorScore: null, keywordRank: 0.5 }];
      expect(computeRetrievalConfidence(results)).toEqual({ score: null, basis: 'none' });
    });

    // ── #1115 P3: the image leg is invisible to this formula ──────────────
    // ADR-025 §5 left P3 the ruling on whether a synthesised row may carry a
    // rerankScore in here. It may not, in either direction — see the argument
    // in `retrieval-confidence.ts`.

    it('an image-ONLY set is unmeasurable, exactly like a keyword-only one', () => {
      const results = [
        { ...base, vectorScore: null, keywordRank: null, imageOnly: true as const },
        { ...base, pageId: 2, vectorScore: null, keywordRank: null, imageOnly: true as const, imageTextSynthesized: true as const },
      ];
      // NOT `{score: 0}`: that is the empty-corpus verdict, and a threshold
      // gate would refuse it. Pages came back; nothing measurable did.
      expect(computeRetrievalConfidence(results)).toEqual({ score: null, basis: 'none' });
    });

    it('an image-only row does not LOWER the number of a set beside it', () => {
      const measured = [{ ...base, vectorScore: 0.72, keywordRank: null }];
      const withImage = [
        ...measured,
        { ...base, pageId: 2, vectorScore: null, keywordRank: null, imageOnly: true as const },
      ];
      expect(computeRetrievalConfidence(withImage)).toEqual(
        computeRetrievalConfidence(measured),
      );
    });

    it('an unreranked image-only row does not demote a fully reranked set to similarity', () => {
      // The sharpest edge: `allReranked` is what picks the rerank basis, and
      // ONE unscored row flips it. An image-only row that the provider never
      // saw would silently change which threshold the ask route applies.
      const reranked = [
        { ...base, vectorScore: 0.3, keywordRank: null, rerankScore: 0.91 },
        { ...base, pageId: 2, vectorScore: 0.2, keywordRank: null, rerankScore: 0.44 },
      ];
      const withImage = [
        ...reranked,
        { ...base, pageId: 3, vectorScore: null, keywordRank: null, imageOnly: true as const },
      ];
      expect(computeRetrievalConfidence(reranked)).toEqual({ score: 0.91, basis: 'rerank' });
      expect(computeRetrievalConfidence(withImage)).toEqual({ score: 0.91, basis: 'rerank' });
    });

    it('a SCORED image-only row cannot become the rerank basis', () => {
      // The rerank stage scores `chunkText`, and an image-only row's
      // chunkText is a lede (or a title) that no leg matched — so a score
      // over it rates the answer on text retrieval never looked at. Here the
      // synthesised row scores HIGHER than the real evidence: left in, it
      // would raise the number past a threshold the real row fails.
      const results = [
        { ...base, vectorScore: 0.3, keywordRank: null, rerankScore: 0.2 },
        { ...base, pageId: 2, vectorScore: null, keywordRank: null, rerankScore: 0.95, imageOnly: true as const, imageTextSynthesized: true as const },
      ];
      expect(computeRetrievalConfidence(results)).toEqual({ score: 0.2, basis: 'rerank' });
    });

    it('an image-only row at position 0 does not make a vector-led set unmeasurable', () => {
      // The vector-led rule reads the best MEASURABLE row, not `results[0]`:
      // an image row fusing one rank higher is not evidence the vector leg
      // failed to lead.
      const results = [
        { ...base, vectorScore: null, keywordRank: null, imageOnly: true as const },
        { ...base, pageId: 2, vectorScore: 0.66, keywordRank: null },
      ];
      expect(computeRetrievalConfidence(results)).toEqual({ score: 0.66, basis: 'similarity' });
    });

    it('a page found by BOTH the image leg and a text leg stays in the sample', () => {
      // `imageHits` without `imageOnly` is a measured page that happens to
      // carry pictures. Excluding it would throw away a real cosine.
      const results = [
        {
          ...base, vectorScore: 0.51, keywordRank: null,
          imageHits: [{ source: 'confluence' as const, key: 'a.png', similarity: 0.6, attachmentUrl: '/api/attachments/1/a.png' }],
        },
      ];
      expect(computeRetrievalConfidence(results)).toEqual({ score: 0.51, basis: 'similarity' });
    });
  });

  describe('rerank stage (#1104)', () => {
    const RERANK_CFG = {
      config: {
        providerId: 'rr-1', id: 'rr-1', name: 'Reranker',
        baseUrl: 'http://rr/v1', apiKey: null,
        authType: 'none', verifySsl: true, defaultModel: 'bge-reranker-v2-m3',
      },
      model: 'bge-reranker-v2-m3',
    };

    beforeEach(() => {
      vi.resetAllMocks();
      invalidateRagFetchWidthCache();
      invalidateRagEfSearchCache();
      invalidateRagRerankCandidatesCache();
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
      mocks.mockResolveRerank.mockResolvedValue(null);
      mocks.mockRerank.mockResolvedValue([]);
      mocks.mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('COUNT(*)')) return { rows: [{ embedded: 3, total: 3 }] };
        return { rows: [] };
      });
      // Vector leg: three distinct pages, fused order p1 > p2 > p3.
      mocks.mockClientQuery.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('page_embeddings')) {
          return {
            rows: [1, 2, 3].map((n) => ({
              page_id: n,
              confluence_id: `page-${n}`,
              chunk_text: `chunk text for page ${n}`,
              metadata: { page_title: `Page ${n}`, section_title: `Sec ${n}`, space_key: 'DEV' },
              distance: 0.1 * n,
            })),
          };
        }
        return undefined;
      });
    });

    function analyticsParams(): unknown[] {
      const call = mocks.mockQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('search_analytics'),
      );
      expect(call).toBeDefined();
      return call![1] as unknown[];
    }

    function vectorLimit(): number {
      const call = mocks.mockClientQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('page_embeddings'),
      );
      return (call![1] as unknown[])[2] as number;
    }

    it('never even resolves the stage when the caller did not request it', async () => {
      await hybridSearch('user-1', 'question');
      expect(mocks.mockResolveRerank).not.toHaveBeenCalled();
      expect(mocks.mockRerank).not.toHaveBeenCalled();
    });

    it('is a no-op when requested but unassigned — legs stay at the width, analytics stay hybrid', async () => {
      await hybridSearch('user-1', 'question', 5, undefined, { rerank: true });
      expect(mocks.mockResolveRerank).toHaveBeenCalled();
      expect(mocks.mockRerank).not.toHaveBeenCalled();
      expect(vectorLimit()).toBe(PAGE_FANOUT * RAG_FETCH_WIDTH_DEFAULT);
      expect(analyticsParams()[4]).toBe('hybrid');
      expect(analyticsParams()[5]).toBeNull();
    });

    it('widens the legs to the rerank candidate pool when the stage is live', async () => {
      mocks.mockResolveRerank.mockResolvedValue(RERANK_CFG);
      await hybridSearch('user-1', 'question', 5, undefined, { rerank: true });
      // Default pool 30 > width 10 — #1103's headroom finally spent; since
      // #1106 the SQL LIMIT is the raw chunk fetch over that pool (4 x 30).
      expect(vectorLimit()).toBe(PAGE_FANOUT * 30);
    });

    it('takes a caller-supplied pool over the configured one, and never past the knob\'s own clamp (#1112)', async () => {
      mocks.mockResolveRerank.mockResolvedValue(RERANK_CFG);
      await hybridSearch('user-1', 'question', 5, undefined, { rerank: true, rerankCandidatesOverride: 60 });
      expect(vectorLimit()).toBe(PAGE_FANOUT * 60);

      // The clamp is the operator's, not the caller's: a per-request option
      // must not be able to ship more documents to the rerank provider (and,
      // under EE ACL, more access checks) than rag_rerank_candidates allows.
      mocks.mockClientQuery.mockClear();
      invalidateRagRerankCandidatesCache();
      await hybridSearch('user-1', 'question', 5, undefined, { rerank: true, rerankCandidatesOverride: 500 });
      expect(vectorLimit()).toBe(Math.min(PAGE_FANOUT * 100, VECTOR_RAW_LIMIT_CAP));
    });

    it('the override may LOWER a configured pool — a multi-leg caller divides the budget (#1112)', async () => {
      // The reason this replaced a floor. `rag_rerank_candidates` bounds ONE
      // retrieval's rerank cost; deep search runs three concurrently against a
      // single RERANK_TIMEOUT_MS, so a floor multiplied the operator's ceiling
      // by the leg count and every leg blew the budget (measured: 3 x 60 docs
      // = 14.9s against 5s). Dividing is the only direction that keeps one
      // gesture's cost comparable to one search's.
      mocks.mockResolveRerank.mockResolvedValue(RERANK_CFG);
      mocks.mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('rag_rerank_candidates')) return { rows: [{ setting_value: '80' }] };
        if (sql.includes('COUNT(*)')) return { rows: [{ embedded: 3, total: 3 }] };
        return { rows: [] };
      });
      invalidateRagRerankCandidatesCache();
      await hybridSearch('user-1', 'question', 5, undefined, { rerank: true, rerankCandidatesOverride: 20 });
      expect(vectorLimit()).toBe(PAGE_FANOUT * 20);
      invalidateRagRerankCandidatesCache();
    });

    it('puts the override through the operator\'s own lower clamp too (#1112)', async () => {
      // Symmetry with the ceiling: the caller's number is clamped into
      // [RAG_RERANK_CANDIDATES_MIN, MAX] exactly as the operator's is, so a
      // per-request value cannot degenerate the stage into rescoring nothing.
      mocks.mockResolveRerank.mockResolvedValue(RERANK_CFG);
      await hybridSearch('user-1', 'question', 5, undefined, { rerank: true, rerankCandidatesOverride: 1 });
      expect(vectorLimit()).toBe(PAGE_FANOUT * RAG_RERANK_CANDIDATES_MIN);
    });

    it('writes NO analytics row when the caller suppresses it (#1112 paraphrase legs)', async () => {
      // A deep-search leg's query text was written by a model. Recorded as an
      // ordinary row it would show up in top-searches and in the
      // knowledge-gap predicate as a question a user asked; the wrapper files
      // one row for the merged set instead.
      await hybridSearch('user-1', 'a model\'s paraphrase', 5, undefined, { recordAnalytics: false });
      expect(
        mocks.mockQuery.mock.calls.find(
          (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('search_analytics'),
        ),
      ).toBeUndefined();

      // …and the default is still to write one.
      await hybridSearch('user-1', 'the user\'s own question', 5);
      expect(analyticsParams()[1]).toBe('the user\'s own question');
    });

    it('returns relevance order, stamps rerankScore, and records hybrid_rerank + rerank_score', async () => {
      mocks.mockResolveRerank.mockResolvedValue(RERANK_CFG);
      // Reverse the fused order: page 3 most relevant.
      mocks.mockRerank.mockResolvedValue([
        { index: 2, relevanceScore: 0.92 },
        { index: 1, relevanceScore: 0.4 },
        { index: 0, relevanceScore: 0.1 },
      ]);
      const results = await hybridSearch('user-1', 'question', 3, undefined, { rerank: true });
      expect(results.map((r) => r.pageId)).toEqual([3, 2, 1]);
      expect(results.map((r) => r.rerankScore)).toEqual([0.92, 0.4, 0.1]);
      // The fused `score` field survives untouched — max_score keeps its unit.
      expect(analyticsParams()[4]).toBe('hybrid_rerank');
      expect(analyticsParams()[5]).toBe(0.92);
      // The reranker got one document per pool candidate.
      const [, , , docs] = mocks.mockRerank.mock.calls[0]!;
      expect(docs).toHaveLength(3);
      expect(docs[0]).toContain('chunk text for page 1');
    });

    it('bypasses honestly on failure — fused order, hybrid analytics, no faked score', async () => {
      mocks.mockResolveRerank.mockResolvedValue(RERANK_CFG);
      mocks.mockRerank.mockRejectedValue(new Error('rerank endpoint down'));
      const results = await hybridSearch('user-1', 'question', 3, undefined, { rerank: true });
      expect(results.map((r) => r.pageId)).toEqual([1, 2, 3]);
      expect(results.every((r) => r.rerankScore == null)).toBe(true);
      expect(analyticsParams()[4]).toBe('hybrid');
      expect(analyticsParams()[5]).toBeNull();
    });

    it('never reranks a keyword-fallback result set', async () => {
      mocks.mockResolveRerank.mockResolvedValue(RERANK_CFG);
      mocks.mockGenerateEmbedding.mockRejectedValue(new Error('embedder down'));
      mocks.mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('ts_rank')) {
          return {
            rows: [{
              page_id: 7, confluence_id: 'p7', title: 'KW', space_key: 'DEV',
              body_text: 'keyword only row', rank: 0.5,
            }],
          };
        }
        if (sql.includes('COUNT(*)')) return { rows: [{ embedded: 3, total: 3 }] };
        return { rows: [] };
      });
      await hybridSearch('user-1', 'question', 3, undefined, { rerank: true });
      expect(mocks.mockRerank).not.toHaveBeenCalled();
      expect(analyticsParams()[4]).toBe('keyword_fallback');
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

    // ── #1103: stable-head fusion ────────────────────────────────────────────
    //
    // When the topK floor pushes the fetch beyond the ranking width, plain RRF
    // over the deep legs dilutes the head (measured: Recall@1 0.3889 → 0.2222
    // at retrieval topK=20). fuseWithStableHead takes the head's ORDER from
    // fusion over the width-prefix of each leg, its ENTRIES from the wide
    // fusion (full evidence), and APPENDS the extras. The discriminating
    // tests below plant a page deep in BOTH legs — under plain wide RRF its
    // summed contribution (~2/73) jumps the head (that is the measured
    // dilution mechanism), so they fail against a plain-RRF implementation,
    // not merely pass against this one.
    describe('fuseWithStableHead (#1103)', () => {
      const vecLegs = (n: number) =>
        Array.from({ length: n }, (_, i) => makeResult(`v-${i}`, `vec chunk ${i}`, { score: 0.9 - i * 0.01 }));
      const kwLegs = (n: number) =>
        Array.from({ length: n }, (_, i) => makeResult(`k-${i}`, `kw body ${i}`, { score: 0.8 - i * 0.01, vectorScore: null, keywordRank: 0.8 - i * 0.01 }));
      /** Legs of 20 with one page planted deep (rank 12) in BOTH legs. */
      const legsWithDeepIntruder = () => {
        const v = vecLegs(20);
        const k = kwLegs(20);
        v[11] = makeResult('both-legs-deep', 'deep chunk', { score: 0.9 - 11 * 0.01 });
        k[11] = makeResult('both-legs-deep', 'deep body', { score: 0.8 - 11 * 0.01, vectorScore: null, keywordRank: 0.1 });
        return { v, k };
      };
      const deepIntruderId = makeResult('both-legs-deep', '').pageId;

      it('is plain RRF when the legs fit within the rank width', () => {
        const v = vecLegs(8);
        const k = kwLegs(8);
        expect(fuseWithStableHead(v, k, 10)).toEqual(reciprocalRankFusion(v, k));
      });

      it('never reorders the head when the legs run deeper than the rank width', () => {
        const { v, k } = legsWithDeepIntruder();
        const narrowOrder = reciprocalRankFusion(v.slice(0, 10), k.slice(0, 10)).map((r) => r.pageId);
        const fused = fuseWithStableHead(v, k, 10);
        // The head PAGE SEQUENCE is what a narrower request returns — the
        // deep both-legs intruder must not have jumped in (plain wide RRF
        // fails this: the intruder outranks the single-leg rank-1 pages).
        expect(fused.slice(0, narrowOrder.length).map((r) => r.pageId)).toEqual(narrowOrder);
        expect(fused.findIndex((r) => r.pageId === deepIntruderId)).toBeGreaterThanOrEqual(narrowOrder.length);
      });

      it('head entries carry the wide fusion evidence, not the narrow prefix view', () => {
        // Page found by the keyword leg at rank 2 (inside the width) whose
        // best VECTOR chunk sits at leg rank 12 (outside it). Its head slot
        // must still surface the vector evidence the deeper fetch paid for:
        // similarity on the wire, and the purpose-built vector chunk for the
        // LLM — not the keyword body-excerpt fallback.
        const v = vecLegs(20);
        const k = kwLegs(20);
        v[11] = makeResult('evidence-page', 'purpose-built vec chunk', { score: 0.77, vectorScore: 0.77 });
        k[1] = makeResult('evidence-page', 'kw body excerpt', { score: 0.6, vectorScore: null, keywordRank: 0.6 });
        const fused = fuseWithStableHead(v, k, 10);
        const entry = fused.find((r) => r.pageId === makeResult('evidence-page', '').pageId);
        expect(entry).toBeDefined();
        expect(entry!.vectorScore).toBe(0.77);
        expect(entry!.chunkText).toBe('purpose-built vec chunk');
        // And it sits in the head — it was retrievable at the narrow width.
        expect(fused.findIndex((r) => r.pageId === entry!.pageId)).toBeLessThan(10);
      });

      it('appends the deep-fetch extras after the head, losing none', () => {
        // Safety property of the new function (plain RRF trivially satisfies
        // it — the set-preservation is what future edits must not break).
        const { v, k } = legsWithDeepIntruder();
        const fused = fuseWithStableHead(v, k, 10);
        const wide = reciprocalRankFusion(v, k);
        expect(new Set(fused.map((r) => r.pageId))).toEqual(new Set(wide.map((r) => r.pageId)));
        expect(new Set(fused.map((r) => r.pageId)).size).toBe(fused.length);
      });

      it('a page surfacing only in the deep tail cannot displace a head entry', () => {
        const { v, k } = legsWithDeepIntruder();
        const fused = fuseWithStableHead(v, k, 10);
        const kwRank1 = kwLegs(1)[0]!.pageId;
        const kwRank1Pos = fused.findIndex((r) => r.pageId === kwRank1);
        expect(kwRank1Pos).toBeGreaterThanOrEqual(0);
        expect(fused.findIndex((r) => r.pageId === deepIntruderId)).toBeGreaterThan(kwRank1Pos);
      });
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
      it('a page occupying every vector slot scores its BEST chunk only — summing is gone (#1106 v2)', () => {
        // Ten chunks of ONE page used to sum ten reciprocal ranks; measured
        // on the rig, that let chunk count crush chunk quality once the raw
        // window widened (candidate-v1: R@1 0.4028→0.3333). The page now
        // earns exactly its best chunk's contribution.
        const chunks = Array.from({ length: 10 }, (_, i) =>
          makeResult('bound-page', `chunk ${i}`, { score: 0.5 - i * 0.01 }),
        );
        const combined = reciprocalRankFusion(chunks, []);
        expect(combined).toHaveLength(1);
        expect(combined[0].score).toBeCloseTo(rrfWorstCase(), 12);
        expect(combined[0].score).toBeCloseTo(1 / 61, 12);
        // The representative text and vectorScore still come from the best chunk.
        expect(combined[0].chunkText).toBe('chunk 0');
        expect(combined[0].vectorScore).toBeCloseTo(0.5, 12);
      });

      it('later siblings add no score but a page found by BOTH legs still earns both legs', () => {
        // Cross-leg contribution survives the cap — that dilution axis is
        // fuseWithStableHead's job, not this one's.
        const vec = [makeResult('p1', 'v1'), makeResult('p1', 'v2', { score: 0.4 })];
        const kw = [makeResult('p1', 'k1', { score: 2.0, vectorScore: null, keywordRank: 2.0 })];
        const combined = reciprocalRankFusion(vec, kw);
        expect(combined).toHaveLength(1);
        expect(combined[0].score).toBeCloseTo(2 / 61, 12);
        expect(combined[0].score).toBeCloseTo(rrfWorstCase(true), 12);
      });

      it('the ceiling is width-invariant: ~0.0328 with both legs, at every reachable configuration', () => {
        // Pre-#1106 the worst case tracked the stage limit (0.1694 at width
        // 10, past 1.0 at the 200 cap) because per-chunk summing existed.
        // Best-chunk-only makes 2/(k+1) the global bound — the stage limit,
        // the rerank pool and the raw window no longer appear in the formula.
        expect(rrfWorstCase(true)).toBeCloseTo(2 / 61, 12);
        expect(rrfWorstCase(true)).toBeCloseTo(0.0328, 4);
        expect(rrfWorstCase(false)).toBeCloseTo(1 / 61, 12);
        // resolveStageLimit still floors the POOL (satisfiability), it just
        // no longer moves the score ceiling.
        expect(resolveStageLimit(5, RAG_FETCH_WIDTH_DEFAULT, false)).toBe(10);
        expect(resolveStageLimit(5, RAG_FETCH_WIDTH_DEFAULT, true)).toBe(10);
      });

      it('the /api/search and EE ACL pool floors survive — they size the POOL, not the score', () => {
        expect(resolveStageLimit(20, RAG_FETCH_WIDTH_DEFAULT, false)).toBe(20);
        expect(resolveStageLimit(20, RAG_FETCH_WIDTH_DEFAULT, true)).toBe(30);
      });

      it('#1115 P3 — a third leg raises the ceiling to 3/(k+1), and only when it is passed', () => {
        // The default is unchanged, so nothing that existed before this leg
        // reads a different bound; a page all three legs found reaches 3/61.
        expect(rrfWorstCase(true)).toBeCloseTo(2 / 61, 12);
        expect(rrfWorstCase(true, 60, true)).toBeCloseTo(3 / 61, 12);
        expect(rrfWorstCase(false, 60, true)).toBeCloseTo(2 / 61, 12);
      });
    });

    describe('the image leg (#1115 P3)', () => {
      const imageRow = (id: string, overrides?: Partial<SearchResult>): SearchResult =>
        makeResult(id, `chunk for ${id}`, {
          vectorScore: null,
          keywordRank: null,
          score: 0,
          imageHits: [{
            source: 'confluence', key: `${id}.png`, similarity: 0.6,
            attachmentUrl: `/api/attachments/1/${id}.png`,
          }],
          ...overrides,
        });

      it('adds a third contribution to a page the text legs also found', () => {
        const combined = reciprocalRankFusion(
          [makeResult('p1', 'v1')],
          [makeResult('p1', 'k1', { score: 2, vectorScore: null, keywordRank: 2 })],
          [imageRow('p1')],
        );
        expect(combined).toHaveLength(1);
        expect(combined[0].score).toBeCloseTo(3 / 61, 12);
      });

      it('never replaces the row a text leg produced — it only attaches hits', () => {
        // The vector chunk is purpose-built for LLM context; an image-leg row
        // carrying a lede must not overwrite it.
        const combined = reciprocalRankFusion(
          [makeResult('p1', 'the vector chunk')],
          [],
          [imageRow('p1', { chunkText: 'a lede nobody matched', imageOnly: true as const })],
        );
        expect(combined[0].chunkText).toBe('the vector chunk');
        expect(combined[0].vectorScore).toBeCloseTo(0.5, 12);
        expect(combined[0].imageOnly).toBeUndefined();
        expect(combined[0].imageHits).toHaveLength(1);
      });

      it('an image-only page enters the fused set carrying its hits', () => {
        const combined = reciprocalRankFusion(
          [makeResult('p1', 'v1')],
          [],
          [imageRow('p2', { imageOnly: true as const })],
        );
        expect(combined.map((r) => r.confluenceId)).toEqual(['p1', 'p2']);
        expect(combined[1].imageOnly).toBe(true);
        expect(combined[1].score).toBeCloseTo(1 / 61, 12);
        expect(combined[1].vectorScore).toBeNull();
      });

      it('ties break toward the measured leg — an image-only page never displaces a vector head', () => {
        // Load-bearing for #1105: `computeRetrievalConfidence` reads the
        // vector-led property off the best measurable row, and the ORDER here
        // is what keeps a measured row at the head of the array the ask route
        // logs, cites and sends.
        const combined = reciprocalRankFusion(
          [makeResult('vec', 'v1')],
          [makeResult('kw', 'k1', { score: 2, vectorScore: null, keywordRank: 2 })],
          [imageRow('img', { imageOnly: true as const })],
        );
        expect(combined.map((r) => r.confluenceId)).toEqual(['vec', 'kw', 'img']);
        expect(combined.every((r) => Math.abs(r.score - 1 / 61) < 1e-12)).toBe(true);
      });

      it('is a no-op when omitted — every pre-#1115 caller fuses identically', () => {
        const v = [makeResult('p1', 'v1'), makeResult('p2', 'v2')];
        const k = [makeResult('p3', 'k1', { score: 1, vectorScore: null, keywordRank: 1 })];
        expect(reciprocalRankFusion(v, k, [])).toEqual(reciprocalRankFusion(v, k));
      });

      it('fuseWithStableHead threads it through both the narrow head and the wide tail', () => {
        // rankWidth 1: the head is reconstructed from each leg's first page,
        // and the image leg's own narrow reconstruction is a plain prefix
        // because it is already one row per page.
        const v = [makeResult('v1', 'a'), makeResult('v2', 'b')];
        const i = [imageRow('i1', { imageOnly: true as const }), imageRow('v2', {})];
        const fused = fuseWithStableHead(v, [], 1, i);
        // Head = fusion over {v1} and {i1}; the tail appends v2 (which the
        // wide fusion also credits with an image rank).
        expect(fused.map((r) => r.confluenceId)).toEqual(['v1', 'i1', 'v2']);
        expect(fused.find((r) => r.confluenceId === 'v2')!.imageHits).toHaveLength(1);
      });

      it('reconstructs the narrow image leg from the RAW window, not a plain prefix', () => {
        // #1103/#1269's guarantee applied to the third leg. The image leg is
        // page-denominated, but it was denominated FROM a raw image-row
        // stream — so a narrow request (stage limit = rankWidth) reads only
        // `imageRawLimit(rankWidth)` raw rows, and on a page-crowded window
        // (two pages carrying `rag_images_per_page_max` pictures each fill the
        // default 40-row narrow window between them) the wide result's first
        // `rankWidth` pages are NOT the pages a narrow request had.
        //
        // rankWidth 2 → imageRawLimit(2) = 8, so `iFar` (best image at raw row
        // 9) is outside a narrow request's window and belongs in the APPENDED
        // tail, behind `vC` — which the wide fusion credits with two legs
        // (2/63) against `iFar`'s one (1/62). Put `iFar` in the head instead
        // and it takes its NARROW rank, jumping ahead of the better-evidenced
        // page: the head dilution #1103 measured, arriving through the leg
        // this PR adds.
        //
        // Mutation check: restore `imageResults.slice(0, rankWidth)` and the
        // last two entries swap.
        const v = [makeResult('vA', 'a'), makeResult('vB', 'b'), makeResult('vC', 'c')];
        const k = [
          makeResult('kA', 'x', { score: 2, vectorScore: null, keywordRank: 2 }),
          makeResult('kB', 'y', { score: 1, vectorScore: null, keywordRank: 1 }),
          makeResult('vC', 'c', { score: 1, vectorScore: null, keywordRank: 1 }),
        ];
        const i = [
          imageRow('iNear', { imageOnly: true as const, imageRawIndex: 0 }),
          imageRow('iFar', { imageOnly: true as const, imageRawIndex: 9 }),
        ];
        expect(fuseWithStableHead(v, k, 2, i).map((r) => r.confluenceId))
          .toEqual(['vA', 'kA', 'iNear', 'vB', 'kB', 'vC', 'iFar']);
      });

      it('falls back to array position when no raw index was recorded', () => {
        // A hand-built row carries no raw index, and so does any future
        // producer that is already one row per raw hit — the reconstruction
        // must then behave as an uncrowded window, i.e. exactly the plain
        // prefix it replaced.
        const v = [makeResult('vA', 'a'), makeResult('vB', 'b'), makeResult('vC', 'c')];
        const k = [
          makeResult('kA', 'x', { score: 2, vectorScore: null, keywordRank: 2 }),
          makeResult('kB', 'y', { score: 1, vectorScore: null, keywordRank: 1 }),
          makeResult('vC', 'c', { score: 1, vectorScore: null, keywordRank: 1 }),
        ];
        const i = [
          imageRow('iNear', { imageOnly: true as const }),
          imageRow('iFar', { imageOnly: true as const }),
        ];
        expect(fuseWithStableHead(v, k, 2, i).map((r) => r.confluenceId))
          .toEqual(['vA', 'kA', 'iNear', 'vB', 'kB', 'iFar', 'vC']);
      });
    });

    describe('page-denominated vector fetch (#1106 PR 1)', () => {
      const row = (pageId: number, chunk: string) => makeResult(`p-${pageId}`, chunk, { pageId });

      describe('truncateAtDistinctPages', () => {
        it('cuts at the FIRST appearance of the Nth distinct page, keeping earlier repeat chunks', () => {
          // P1c1, P2c1, P1c2, P3c1, P2c2 at maxPages 3: the cut lands ON
          // P3c1 — P1's second chunk (above the cut) survives, P2's second
          // (below it) does not. Fan-out is bounded to "chunks ranking above
          // the Nth page's entry", which is the whole point.
          const rows = [row(1, 'a'), row(2, 'b'), row(1, 'c'), row(3, 'd'), row(2, 'e')];
          expect(truncateAtDistinctPages(rows, 3)).toEqual(rows.slice(0, 4));
        });

        it('shortfall passes everything through — today is the floor, a named degradation guarantee', () => {
          const rows = [row(1, 'a'), row(1, 'b'), row(2, 'c')];
          expect(truncateAtDistinctPages(rows, 5)).toEqual(rows);
        });

        it('non-positive page budget yields an empty set', () => {
          expect(truncateAtDistinctPages([row(1, 'a')], 0)).toEqual([]);
          expect(truncateAtDistinctPages([row(1, 'a')], -1)).toEqual([]);
        });

        it('is a PREFIX operation: result at w1 is a prefix of result at w2 for w1 < w2', () => {
          // fuseWithStableHead's append-only widening leans on this — the
          // page-prefix must inherit the row-prefix property.
          const rows = [row(1, 'a'), row(2, 'b'), row(2, 'c'), row(3, 'd'), row(1, 'e'), row(4, 'f')];
          for (let w1 = 1; w1 < 4; w1++) {
            for (let w2 = w1 + 1; w2 <= 4; w2++) {
              const p1 = truncateAtDistinctPages(rows, w1);
              const p2 = truncateAtDistinctPages(rows, w2);
              expect(p2.slice(0, p1.length)).toEqual(p1);
            }
          }
        });
      });

      describe('fuseWithStableHead page-denominated rankWidth', () => {
        it('engages on DISTINCT-PAGE count, not row count — 40 rows over 8 pages at rankWidth 10 is plain RRF', () => {
          // Pre-#1106 this leg (40 rows > 10) split into head+extras and the
          // pages beyond row 10 could never enter head ranking. Eight
          // distinct pages fit inside the rank window regardless of their
          // chunk fan-out, so fusion must run plain over everything.
          const vec: ReturnType<typeof row>[] = [];
          for (let i = 0; i < 40; i++) vec.push(row((i % 8) + 1, `c${i}`));
          const out = fuseWithStableHead(vec, [], 10);
          expect(out).toEqual(reciprocalRankFusion(vec, []));
        });

        it('head order derives from the page-prefix of a multi-chunk leg', () => {
          // 12 distinct pages, each as two adjacent chunks (24 rows), rank
          // width 10: the head must be fusion over rows spanning the first
          // 10 DISTINCT pages (20 rows), with pages 11-12 appended after —
          // not fusion over the first 10 ROWS (5 pages).
          const vec: ReturnType<typeof row>[] = [];
          for (let p = 1; p <= 12; p++) { vec.push(row(p, `p${p}c1`)); vec.push(row(p, `p${p}c2`)); }
          const out = fuseWithStableHead(vec, [], 10);
          const headIds = out.slice(0, 10).map((r) => r.pageId);
          expect(headIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
          expect(out.slice(10).map((r) => r.pageId)).toEqual([11, 12]);
        });

        it('for a per-page leg the page-prefix is exactly the row slice (keyword leg unchanged)', () => {
          const kw = Array.from({ length: 15 }, (_, i) => row(i + 1, `k${i}`));
          expect(truncateAtDistinctPages(kw, 10)).toEqual(kw.slice(0, 10));
        });

        it('widening stays append-only under TWO INDEPENDENT FETCHES, narrow one shortfalling (#1269 B1)', () => {
          // The previous version of this test derived the narrow leg from
          // the wide array (`truncateAtDistinctPages(vec, 10)`) — by
          // construction the exact page-prefix, so the divergence it exists
          // to catch was unrepresentable. A faithful model runs the REAL
          // per-request pipeline twice over one raw stream: each request
          // takes its own raw window (vectorRawLimit) and truncates at its
          // own page budget. The fixture makes the narrow request SHORTFALL
          // (5 distinct pages in its 40-row window — the long-multi-chunk
          // corpus #1106 exists for) while the wide request reaches full
          // pages; the un-reconstructed page-prefix head provably reorders
          // the top here (verified numerically in the review).
          const raw: ReturnType<typeof row>[] = [];
          for (let c = 0; c < 8; c++) for (let p = 1; p <= 5; p++) raw.push(row(p, `p${p}c${c}`));
          for (let p = 6; p <= 20; p++) raw.push(row(p, `p${p}c0`));
          // The SHARED helper, not an inline re-derivation — the whole point
          // of vectorRawLimit is that the fetch and the reconstruction (and
          // this model of them) cannot drift apart.
          const vectorLeg = (limit: number) =>
            truncateAtDistinctPages(raw.slice(0, vectorRawLimit(limit)), limit);
          const kwAll = [6, 1, 2, 3, 4, 5, ...Array.from({ length: 14 }, (_, i) => i + 7)].map((p) => row(p, `k${p}`));
          const keywordLeg = (limit: number) => kwAll.slice(0, limit);

          // rankWidth 10 both sides (the configured width): narrow request =
          // stage limit 10, wide request = stage limit 20 (a larger topK).
          const narrow = fuseWithStableHead(vectorLeg(10), keywordLeg(10), 10);
          const wide = fuseWithStableHead(vectorLeg(20), keywordLeg(20), 10);
          expect(wide.slice(0, narrow.length).map((r) => r.pageId)).toEqual(narrow.map((r) => r.pageId));
          // And widening genuinely added something after the stable head.
          expect(wide.length).toBeGreaterThan(narrow.length);
        });

        it('append-only holds on the PLAIN branch too — heavy fan-out inside the rank width (#1269 B1-residual)', () => {
          // The residual case: both wide legs total <= rankWidth distinct
          // pages, so the old distinct-page-count fast path fused the WIDE
          // legs directly — yet the wide raw window holds a page (the
          // 40-chunk page 9 below) the narrow request's 40-row window never
          // reached. Page 9 earns only its keyword rank narrowly but gains a
          // vector contribution widely, displacing a head page. The fast
          // path must be taken only when reconstruction is the identity.
          const raw: ReturnType<typeof row>[] = [];
          for (let c = 0; c < 5; c++) for (let p = 1; p <= 8; p++) raw.push(row(p, `p${p}c${c}`));
          for (let c = 0; c < 40; c++) raw.push(row(9, `p9c${c}`));
          const vectorLeg = (limit: number) =>
            truncateAtDistinctPages(raw.slice(0, vectorRawLimit(limit)), limit);
          const kwAll = [row(9, 'k9'), row(2, 'k2')];
          const keywordLeg = (limit: number) => kwAll.slice(0, limit);

          const narrow = fuseWithStableHead(vectorLeg(10), keywordLeg(10), 10);
          const wide = fuseWithStableHead(vectorLeg(20), keywordLeg(20), 10);
          expect(wide.slice(0, narrow.length).map((r) => r.pageId)).toEqual(narrow.map((r) => r.pageId));
        });
      });

      describe('raw fetch arithmetic', () => {
        beforeEach(() => {
          // Mock-call indexes below are per-test; without this reset they
          // read the PREVIOUS test's accumulated calls.
          vi.resetAllMocks();
          mocks.mockPool.connect.mockResolvedValue(mocks.mockClient);
          mocks.mockClient.release.mockResolvedValue(undefined);
          mocks.mockToSql.mockReturnValue('[0.1,0.2]');
        });

        it('PAGE_FANOUT and the raw cap hold the ef headroom rule at every reachable width', () => {
          // The cap IS the arithmetic: 2 x 500 = 1000 is exactly pgvector's
          // ef_search ceiling, so 2x headroom survives at the width-200 knob
          // cap; without the cap, width 200 would want ef 1600 and silently
          // clamp below coverage.
          expect(PAGE_FANOUT).toBe(4);
          expect(VECTOR_RAW_LIMIT_CAP).toBe(500);
          expect(2 * VECTOR_RAW_LIMIT_CAP).toBe(1000);
          expect(Math.min(PAGE_FANOUT * 10, VECTOR_RAW_LIMIT_CAP)).toBe(40);   // chat, no rerank
          expect(Math.min(PAGE_FANOUT * 30, VECTOR_RAW_LIMIT_CAP)).toBe(120);  // chat, rerank pool
          expect(Math.min(PAGE_FANOUT * 200, VECTOR_RAW_LIMIT_CAP)).toBe(500); // width cap
        });

        it('vectorSearch fetches rawLimit chunk rows, sets ef over the RAW limit, and truncates to `limit` distinct pages', async () => {
          mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
          mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
          mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
          // 12 rows over 4 pages: pages 1,1,2,2,3,3,4,4,... — at limit 3 the
          // cut lands on page 3's first row (index 4).
          mocks.mockClientQuery.mockResolvedValueOnce({
            rows: Array.from({ length: 12 }, (_, i) => ({
              page_id: Math.floor(i / 2) + 1,
              confluence_id: `page-${Math.floor(i / 2) + 1}`,
              chunk_text: `chunk ${i}`,
              chunk_index: i % 2,
              metadata: { page_title: 'T', section_title: 'S', space_key: 'DEV' },
              distance: 0.1 + i * 0.01,
            })),
          }); // SELECT
          mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

          const out = await vectorSearch('user-1', new Array(1024).fill(0.1), 3);

          const setLocal = mocks.mockClientQuery.mock.calls[1]![0] as string;
          // rawLimit = 4x3 = 12; ef = max(100, 2x12) = 100 (the `rag_ef_search`
          // floor, absent here so the reader's default stands).
          expect(setLocal).toContain('= 100');
          const selectParams = mocks.mockClientQuery.mock.calls[2]![1] as unknown[];
          expect(selectParams[2]).toBe(12);
          // Truncated at the 3rd distinct page's first row: pages 1,1,2,2,3.
          expect(out.map((r) => r.pageId)).toEqual([1, 1, 2, 2, 3]);
          // chunk_index rides along for #1106 PR 2's assembly anchor.
          expect(out[0]!.chunkIndex).toBe(0);
        });

        it('a raised width rides the RAW limit into ef: width 150 -> raw 500 (cap) -> ef 1000 (clamp)', async () => {
          mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
          mocks.mockClientQuery.mockResolvedValueOnce(undefined);
          mocks.mockClientQuery.mockResolvedValueOnce(undefined);
          mocks.mockClientQuery.mockResolvedValueOnce({ rows: [] });
          mocks.mockClientQuery.mockResolvedValueOnce(undefined);

          await vectorSearch('user-1', new Array(1024).fill(0.1), 150);

          const setLocal = mocks.mockClientQuery.mock.calls[1]![0] as string;
          expect(setLocal).toContain('= 1000');
          const selectParams = mocks.mockClientQuery.mock.calls[2]![1] as unknown[];
          expect(selectParams[2]).toBe(500);
        });
      });
    });

    // ── #1117 stage 1: raw per-leg scores survive fusion ─────────────────────
    //
    // Fusion overwrote `score` with the RRF value and discarded the cosine the
    // vector leg had measured. With k=60 over two legs the RRF value maxes out
    // near 1/61 + 1/61 ≈ 0.0328 for the common case — an exact bound since
    // #1106's best-chunk-only rule — and ConfidenceBadge reads that field as a
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

    it('calls query() with websearch_to_tsquery parameterized SQL (#1110)', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      mocks.mockQuery.mockResolvedValueOnce({ rows: [] });

      await keywordSearch('user-1', 'redis caching', 5);

      expect(mocks.mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mocks.mockQuery.mock.calls[0] as [string, unknown[]];
      // websearch_to_tsquery, not plainto: the leading `-` in a query like
      // "delay accepting -logging" parses as an exclusion rather than as a
      // required term. The parser is fed a sanitised query — on its own it
      // raises XX000 on a long hyphen run (see lexical-query.ts).
      expect(sql).toContain('websearch_to_tsquery');
      expect(sql).not.toContain('plainto_tsquery');
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

    // ── #1351: spaceKey narrows the keyword leg ───────────────────────────
    it('applies an additional cp.space_key predicate when opts.spaceKey is set', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      mocks.mockQuery.mockResolvedValueOnce({ rows: [] });

      await keywordSearch('user-1', 'redis caching', 5, { spaceKey: 'DEV' });

      const [sql, params] = mocks.mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('AND cp.space_key = $5');
      expect(params[4]).toBe('DEV');
    });

    it('omits the space_key predicate when opts.spaceKey is undefined (no-op default)', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      mocks.mockQuery.mockResolvedValueOnce({ rows: [] });

      await keywordSearch('user-1', 'redis caching', 5);

      const [sql, params] = mocks.mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).not.toContain('cp.space_key = $');
      expect(params).toHaveLength(4);
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

    // ── #1351: spaceKey narrows the vector leg ────────────────────────────
    it('applies an additional cp.space_key predicate when opts.spaceKey is set', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({ rows: [] }); // SELECT
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      await vectorSearch('user-1', new Array(1024).fill(0.1), 5, { spaceKey: 'DEV' });

      const [sql, params] = mocks.mockClientQuery.mock.calls[2] as [string, unknown[]];
      expect(sql).toContain('AND cp.space_key = $5');
      // visiblePagesPredicate ($1/$4) stays in place — the scope is an
      // additional narrowing condition, not a replacement for ACL.
      expect(sql).toContain('space_key = ANY($1::text[])');
      expect(params[4]).toBe('DEV');
    });

    it('omits the space_key predicate when opts.spaceKey is undefined (no-op default)', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({ rows: [] }); // SELECT
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      // Every existing caller (RAG chat, deep search, eval harness) omits
      // opts entirely — this pins that call shape stays byte-identical.
      await vectorSearch('user-1', new Array(1024).fill(0.1), 5);

      const [sql, params] = mocks.mockClientQuery.mock.calls[2] as [string, unknown[]];
      expect(sql).not.toContain('cp.space_key = $');
      expect(params).toHaveLength(4);
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

describe('sibling-chunk context assembly stage (#1106 PR 2)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    invalidateRagFetchWidthCache();
    invalidateRagEfSearchCache();
    invalidateRagRerankCandidatesCache();
    invalidateRagContextCharsCache();
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
    mocks.mockResolveRerank.mockResolvedValue(null);
    mocks.mockRerank.mockResolvedValue([]);
    // Vector leg: two pages, one chunk each (page 1 anchored at chunk 2).
    mocks.mockClientQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('page_embeddings')) {
        return {
          rows: [1, 2].map((n) => ({
            page_id: n,
            confluence_id: `page-${n}`,
            chunk_text: `best chunk of page ${n}`,
            chunk_index: n === 1 ? 2 : 0,
            metadata: { page_title: `Page ${n}`, section_title: `Sec ${n}`, space_key: 'DEV' },
            distance: 0.1 * n,
          })),
        };
      }
      return undefined;
    });
  });

  function routeMainQueries(opts: {
    budget?: string;
    siblings?: Array<{ page_id: number; chunk_index: number; chunk_text: string; section_title?: string | null }> | 'throw';
  }) {
    mocks.mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('rag_context_chars_per_page')) {
        return opts.budget === undefined ? { rows: [] } : { rows: [{ setting_value: opts.budget }] };
      }
      if (typeof sql === 'string' && sql.includes('unnest(')) {
        if (opts.siblings === 'throw') throw new Error('sibling fetch died');
        return { rows: opts.siblings ?? [] };
      }
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
        return { rows: [{ embedded: 2, total: 2 }] };
      }
      return { rows: [] };
    });
  }

  function siblingFetchCalls(): number {
    return mocks.mockQuery.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('unnest('),
    ).length;
  }

  it('assembles contextText anchored at the representative chunk; chunkText stays the best chunk', async () => {
    routeMainQueries({
      siblings: [
        { page_id: 1, chunk_index: 1, chunk_text: 'before', section_title: 'Alpha' },
        { page_id: 1, chunk_index: 2, chunk_text: 'best chunk of page 1', section_title: 'Beta' },
        { page_id: 1, chunk_index: 3, chunk_text: 'after', section_title: 'Beta' },
        { page_id: 2, chunk_index: 0, chunk_text: 'best chunk of page 2', section_title: 'Solo' },
      ],
    });
    const out = await hybridSearch('user-1', 'q', 5, undefined, { assembleContext: true });
    expect(out[0]!.contextText).toBe('before\n\nbest chunk of page 1\n\nafter');
    expect(out[0]!.mergedChunkCount).toBe(3);
    expect(out[0]!.chunkText).toBe('best chunk of page 1');
    // Two distinct section titles in the window → spans (#1270 F4).
    expect(out[0]!.contextSpansSections).toBe(true);
    expect(out[1]!.contextText).toBe('best chunk of page 2');
    expect(out[1]!.mergedChunkCount).toBe(1);
    expect(out[1]!.contextSpansSections).toBe(false);
  });

  it('soft-fails to chunk-level rows when the sibling fetch throws — same shape, no contextText', async () => {
    routeMainQueries({ siblings: 'throw' });
    const out = await hybridSearch('user-1', 'q', 5, undefined, { assembleContext: true });
    expect(out).toHaveLength(2);
    expect(out[0]!.contextText).toBeUndefined();
    expect(out[0]!.chunkText).toBe('best chunk of page 1');
  });

  it('a page with no fetchable siblings degrades alone — the other page still assembles', async () => {
    routeMainQueries({
      siblings: [{ page_id: 2, chunk_index: 0, chunk_text: 'best chunk of page 2', section_title: 'S' }],
    });
    const out = await hybridSearch('user-1', 'q', 5, undefined, { assembleContext: true });
    expect(out[0]!.contextText).toBeUndefined();
    expect(out[1]!.contextText).toBe('best chunk of page 2');
  });

  it('a re-embedded anchor (position resolves, TEXT differs) does not assemble — unmeasured content never ships (#1270 F3)', async () => {
    routeMainQueries({
      siblings: [
        { page_id: 1, chunk_index: 2, chunk_text: 'DIFFERENT text after re-embed', section_title: 'S' },
        { page_id: 2, chunk_index: 0, chunk_text: 'best chunk of page 2', section_title: 'S' },
      ],
    });
    const out = await hybridSearch('user-1', 'q', 5, undefined, { assembleContext: true });
    expect(out[0]!.contextText).toBeUndefined();
    expect(out[1]!.contextText).toBe('best chunk of page 2');
  });

  it('budget 0 is the kill switch — no sibling fetch is even issued', async () => {
    routeMainQueries({ budget: '0' });
    await hybridSearch('user-1', 'q', 5, undefined, { assembleContext: true });
    expect(siblingFetchCalls()).toBe(0);
  });

  it('without the flag nothing happens — no fetch, no fields', async () => {
    routeMainQueries({});
    const out = await hybridSearch('user-1', 'q', 5);
    expect(siblingFetchCalls()).toBe(0);
    expect(out[0]!.contextText).toBeUndefined();
  });

  it('rerankScore survives assembly — the spread rebuilds rows without touching ranking fields', async () => {
    mocks.mockResolveRerank.mockResolvedValue({
      config: {
        providerId: 'rr-1', id: 'rr-1', name: 'Reranker',
        baseUrl: 'http://rr/v1', apiKey: null,
        authType: 'none', verifySsl: true, defaultModel: 'bge-reranker-v2-m3',
      },
      model: 'bge-reranker-v2-m3',
    });
    mocks.mockRerank.mockResolvedValue([
      { index: 0, relevanceScore: 0.9 },
      { index: 1, relevanceScore: 0.4 },
    ]);
    routeMainQueries({
      siblings: [
        { page_id: 1, chunk_index: 2, chunk_text: 'best chunk of page 1', section_title: 'S' },
        { page_id: 2, chunk_index: 0, chunk_text: 'best chunk of page 2', section_title: 'S' },
      ],
    });
    const out = await hybridSearch('user-1', 'q', 5, undefined, { rerank: true, assembleContext: true });
    expect(out[0]!.rerankScore).toBe(0.9);
    expect(out[0]!.contextText).toBe('best chunk of page 1');
  });
});

describe('MMR diversity narrow (#1109)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    invalidateRagMmrCache();
    invalidateRagFetchWidthCache();
    invalidateRagEfSearchCache();
    invalidateRagRerankCandidatesCache();
    invalidateRagContextCharsCache();
    mocks.mockPool.connect.mockResolvedValue(mocks.mockClient);
    mocks.mockClient.release.mockResolvedValue(undefined);
    mocks.mockToSql.mockReturnValue('[0.1,0.2]');
    mocks.mockResolveUsecase.mockResolvedValue({
      config: { providerId: 'p1', id: 'p1', name: 'X', baseUrl: 'http://x/v1', apiKey: null, authType: 'none', verifySsl: true, defaultModel: 'bge-m3' },
      model: 'bge-m3',
    });
    mocks.mockGenerateEmbedding.mockResolvedValue([[0.1, 0.2]]);
    mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
    mocks.mockResolveRerank.mockResolvedValue(null);
    mocks.mockRerank.mockResolvedValue([]);
    // Four near-identical runbooks then one distinct page.
    const RUNBOOK = (t: string) => `${t} deployment runbook. Check the freeze calendar. Tag the release. Watch the canary ten minutes. Promote the fleet.`;
    mocks.mockClientQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('page_embeddings')) {
        const rows = [1, 2, 3, 4].map((n) => ({
          page_id: n, confluence_id: `p${n}`, chunk_text: RUNBOOK(`Team${n}`), chunk_index: 0,
          metadata: { page_title: `Team${n} Runbook`, section_title: 's', space_key: 'DEV' }, distance: 0.1 * n,
        }));
        rows.push({
          page_id: 9, confluence_id: 'p9',
          chunk_text: 'Halt the promotion, select the previous known-good image digest, run the rollback action.',
          chunk_index: 0,
          metadata: { page_title: 'Rollback Procedure', section_title: 's', space_key: 'DEV' }, distance: 0.9,
        });
        return { rows };
      }
      return undefined;
    });
    mocks.mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) return { rows: [{ embedded: 5, total: 5 }] };
      return { rows: [] };
    });
  });
  afterEach(() => { invalidateRagMmrCache(); });

  it('is OFF by default — a context optimisation must be asked for', async () => {
    const out = await hybridSearch('user-1', 'how do we deploy', 3);
    // Pure rank order: the three near-identical runbooks.
    expect(out.map((r) => r.pageId)).toEqual([1, 2, 3]);
  });

  it('when enabled, swaps a redundant copy for the distinct page and keeps the head', async () => {
    mocks.mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('rag_mmr')) {
        return { rows: [{ setting_key: 'rag_mmr_enabled', setting_value: '1' }, { setting_key: 'rag_mmr_lambda', setting_value: '0.3' }] };
      }
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) return { rows: [{ embedded: 5, total: 5 }] };
      return { rows: [] };
    });
    const out = await hybridSearch('user-1', 'how do we deploy', 3);
    expect(out[0]!.pageId).toBe(1);           // head never moves
    expect(out.map((r) => r.pageId)).toContain(9); // distinct page recovered
    expect(out).toHaveLength(3);
  });

  it('a malformed lambda leaves the stage off rather than zeroing relevance', async () => {
    mocks.mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('rag_mmr')) {
        return { rows: [{ setting_key: 'rag_mmr_enabled', setting_value: '1' }, { setting_key: 'rag_mmr_lambda', setting_value: 'aggressive' }] };
      }
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) return { rows: [{ embedded: 5, total: 5 }] };
      return { rows: [] };
    });
    // Falls back to the 0.5 default, which still keeps the head.
    const out = await hybridSearch('user-1', 'how do we deploy', 3);
    expect(out[0]!.pageId).toBe(1);
  });
});

describe('quality/recency ranking prior (#1111)', () => {
  /**
   * The unit tests in `ranking-prior.test.ts` cover the formula. These cover
   * the WIRING, which is where a ranking stage actually goes wrong: whether
   * the signals are fetched at all, whether the weight knob reaches the
   * stage, and whether a failure demotes anything.
   *
   * **The stage ships DISABLED**, so an absent `rag_ranking_prior_weight` row
   * is now the NO-OP case — `settingAbsent` in the helper below, with its own
   * test. Every other test here is exercising the opt-in path, so the helper
   * writes an explicit `ENABLED_WEIGHT` row for them.
   */
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

  /** What an operator sets to turn the stage on — `RANKING_PRIOR_WEIGHT_TUNED`. */
  const ENABLED_WEIGHT = '0.003';

  /**
   * Signal rows keyed by page id, answered to the prior's batched SELECT.
   * `opts.settingAbsent` leaves `admin_settings` with no row, which is the
   * shipped deployment and resolves to weight 0.
   */
  function routePriorQueries(
    signals: Record<number, { quality_score: number | null; last_modified_at: Date | null }>,
    opts: { weight?: string; settingAbsent?: boolean; throwOnSignals?: boolean } = {},
  ) {
    mocks.mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('rag_ranking_prior_weight')) {
        return { rows: opts.settingAbsent ? [] : [{ setting_value: opts.weight ?? ENABLED_WEIGHT }] };
      }
      if (typeof sql === 'string' && sql.includes('quality_score') && sql.includes('ANY')) {
        if (opts.throwOnSignals) throw new Error('signal lookup died');
        const ids = (params?.[0] ?? []) as number[];
        return {
          rows: ids
            .filter((id) => signals[id] !== undefined)
            .map((id) => ({ id, ...signals[id]! })),
        };
      }
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) return { rows: [{ embedded: 4, total: 4 }] };
      return { rows: [] };
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    invalidateRagRankingPriorCache();
    invalidateRagFetchWidthCache();
    invalidateRagEfSearchCache();
    invalidateRagRerankCandidatesCache();
    invalidateRagContextCharsCache();
    invalidateRagMmrCache();
    mocks.mockPool.connect.mockResolvedValue(mocks.mockClient);
    mocks.mockClient.release.mockResolvedValue(undefined);
    mocks.mockToSql.mockReturnValue('[0.1,0.2]');
    mocks.mockResolveUsecase.mockResolvedValue({
      config: { providerId: 'p1', id: 'p1', name: 'X', baseUrl: 'http://x/v1', apiKey: null, authType: 'none', verifySsl: true, defaultModel: 'bge-m3' },
      model: 'bge-m3',
    });
    mocks.mockGenerateEmbedding.mockResolvedValue([[0.1, 0.2]]);
    mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
    mocks.mockResolveRerank.mockResolvedValue(null);
    mocks.mockRerank.mockResolvedValue([]);
    // One leg only, so every candidate sits in the SAME RRF tier — which is
    // exactly where the prior is designed to be able to reorder.
    mocks.mockClientQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('page_embeddings')) {
        return {
          rows: [1, 2, 3, 4].map((n) => ({
            page_id: n, confluence_id: `p${n}`, chunk_text: `deployment runbook ${n}`, chunk_index: 0,
            metadata: { page_title: `Runbook ${n}`, section_title: 's', space_key: 'DEV' }, distance: 0.1 * n,
          })),
        };
      }
      return undefined;
    });
  });
  afterEach(() => { invalidateRagRankingPriorCache(); });

  it('promotes the well-scored, fresh page over stale low-scoring ones in the same tier', async () => {
    routePriorQueries({
      1: { quality_score: 32, last_modified_at: daysAgo(1100) },
      2: { quality_score: 45, last_modified_at: daysAgo(700) },
      3: { quality_score: 88, last_modified_at: daysAgo(30) },
      4: { quality_score: 61, last_modified_at: daysAgo(400) },
    });
    const out = await hybridSearch('user-1', 'how do we deploy', 4);
    expect(out[0]!.pageId).toBe(3);
  });

  it('never drops a page — demote is not exclude', async () => {
    routePriorQueries({
      1: { quality_score: 0, last_modified_at: daysAgo(4000) },
      3: { quality_score: 100, last_modified_at: daysAgo(0) },
    });
    const out = await hybridSearch('user-1', 'how do we deploy', 4);
    expect(new Set(out.map((r) => r.pageId))).toEqual(new Set([1, 2, 3, 4]));
  });

  it('leaves an UNSCORED page ranked on retrieval merit alone', async () => {
    // Pages 2 and 4 carry no row at all — the freshly-synced case. The
    // scored pages may pass them on merit, but nothing is SUBTRACTED for
    // lacking a score: page 2 keeps its lead over page 4.
    routePriorQueries({
      1: { quality_score: 10, last_modified_at: daysAgo(2000) },
      3: { quality_score: 20, last_modified_at: daysAgo(2000) },
    });
    const out = await hybridSearch('user-1', 'how do we deploy', 4);
    const order = out.map((r) => r.pageId);
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(4));
  });

  it('SHIPS INERT — no admin_settings row means no reorder and no signal query', async () => {
    // The default this PR ships. Signals that WOULD reorder the set (page 4
    // is last on the vector leg but perfectly scored and freshly edited) are
    // never even read: the stage short-circuits on weight 0, so a deployment
    // that has not opted in pays nothing for it either.
    routePriorQueries(
      { 4: { quality_score: 100, last_modified_at: daysAgo(0) } },
      { settingAbsent: true },
    );
    const out = await hybridSearch('user-1', 'how do we deploy', 4);
    expect(out.map((r) => r.pageId)).toEqual([1, 2, 3, 4]);
    const sqls = mocks.mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('quality_score') && s.includes('ANY'))).toBe(false);
  });

  it('weight 0 in admin_settings turns the stage off entirely', async () => {
    routePriorQueries(
      { 4: { quality_score: 100, last_modified_at: daysAgo(0) } },
      { weight: '0' },
    );
    const out = await hybridSearch('user-1', 'how do we deploy', 4);
    // Untouched fused order, and the signal SELECT is never even issued.
    expect(out.map((r) => r.pageId)).toEqual([1, 2, 3, 4]);
    const sqls = mocks.mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('quality_score') && s.includes('ANY'))).toBe(false);
  });

  it('a failed signal lookup serves the fused order rather than failing the search', async () => {
    routePriorQueries({}, { throwOnSignals: true });
    const out = await hybridSearch('user-1', 'how do we deploy', 4);
    expect(out.map((r) => r.pageId)).toEqual([1, 2, 3, 4]);
  });

  it('cannot lift a single-leg page over one BOTH legs found', async () => {
    // The guarantee the weight is sized for. Page 4 arrives on the KEYWORD
    // leg as well, so it outscores every vector-only page by ~0.0164 — five
    // times the maximum prior — despite being the worst-scored and stalest.
    // It sits LAST on the vector leg so only leg agreement can explain a win.
    const signals = {
      4: { quality_score: 0, last_modified_at: daysAgo(5000) },
      1: { quality_score: 100, last_modified_at: daysAgo(0) },
      2: { quality_score: 100, last_modified_at: daysAgo(0) },
      3: { quality_score: 100, last_modified_at: daysAgo(0) },
    };
    mocks.mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('ts_rank')) {
        return { rows: [{ page_id: 4, confluence_id: 'p4', title: 'Runbook 4', space_key: 'DEV', body_text: 'deployment runbook 4', rank: 0.9 }] };
      }
      if (typeof sql === 'string' && sql.includes('rag_ranking_prior_weight')) {
        return { rows: [{ setting_value: ENABLED_WEIGHT }] };
      }
      if (typeof sql === 'string' && sql.includes('quality_score') && sql.includes('ANY')) {
        const ids = (params?.[0] ?? []) as number[];
        return { rows: ids.filter((id) => id in signals).map((id) => ({ id, ...signals[id as keyof typeof signals] })) };
      }
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) return { rows: [{ embedded: 4, total: 4 }] };
      return { rows: [] };
    });
    const out = await hybridSearch('user-1', 'how do we deploy', 4);
    expect(out[0]!.pageId).toBe(4);
  });
});

describe('exact-identifier pin stage (#1107)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    invalidateRagFetchWidthCache();
    invalidateRagEfSearchCache();
    invalidateRagRerankCandidatesCache();
    invalidateRagContextCharsCache();
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
    mocks.mockResolveRerank.mockResolvedValue(null);
    mocks.mockRerank.mockResolvedValue([]);
    // Vector leg: two ordinary pages.
    mocks.mockClientQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('page_embeddings')) {
        return {
          rows: [1, 2].map((n) => ({
            page_id: n,
            confluence_id: `page-${n}`,
            chunk_text: `chunk of page ${n}`,
            chunk_index: 0,
            metadata: { page_title: `Page ${n}`, section_title: `Sec ${n}`, space_key: 'DEV' },
            distance: 0.1 * n,
          })),
        };
      }
      return undefined;
    });
  });

  function routePinQueries(pinRow?: { page_id: number; confluence_id: string | null; title: string; space_key: string; excerpt: string } | 'throw') {
    mocks.mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('substring(cp.body_text, 1, $5)')) {
        if (pinRow === 'throw') throw new Error('lookup died');
        return { rows: pinRow ? [pinRow] : [] };
      }
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) return { rows: [{ embedded: 2, total: 2 }] };
      return { rows: [] };
    });
  }

  it('a VERIFIED issue key pins a new record at the head; the fused order below is untouched', async () => {
    routePinQueries({ page_id: 42, confluence_id: 'inc-page', title: 'INC-2203 postmortem', space_key: 'DEV', excerpt: 'incident details' });
    const out = await hybridSearch('user-1', 'what is INC-2203 about', 5, undefined, { pinIdentifiers: true });
    expect(out[0]!.pageId).toBe(42);
    expect(out[0]!.pinned).toBe(true);
    expect(out[0]!.vectorScore).toBeNull();
    expect(out.slice(1).map((r) => r.pageId)).toEqual([1, 2]);
  });

  it('a pinned page already in the fused set MOVES to the head keeping its enriched row', async () => {
    routePinQueries({ page_id: 2, confluence_id: 'page-2', title: 'Page 2', space_key: 'DEV', excerpt: 'x' });
    const out = await hybridSearch('user-1', 'what is INC-2203 about', 5, undefined, { pinIdentifiers: true });
    expect(out.map((r) => r.pageId)).toEqual([2, 1]);
    expect(out[0]!.pinned).toBe(true);
    // The enriched retrieval row survives — its measured cosine included.
    expect(out[0]!.vectorScore).not.toBeNull();
  });

  it('an UNVERIFIED detection pins nothing — detection is necessary, never sufficient', async () => {
    routePinQueries(undefined);
    const out = await hybridSearch('user-1', 'what is INC-9999 about', 5, undefined, { pinIdentifiers: true });
    expect(out.map((r) => r.pageId)).toEqual([1, 2]);
    expect(out[0]!.pinned).toBeUndefined();
  });

  it('a natural-language query issues NO lookup at all — the guards are structural', async () => {
    routePinQueries({ page_id: 42, confluence_id: 'x', title: 'X', space_key: 'DEV', excerpt: 'x' });
    await hybridSearch('user-1', 'how does the deployment process work here exactly', 5, undefined, { pinIdentifiers: true });
    const lookups = mocks.mockQuery.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('substring(cp.body_text, 1, $5)'),
    );
    expect(lookups).toHaveLength(0);
  });

  it('a lookup error soft-fails to the fused order', async () => {
    routePinQueries('throw');
    const out = await hybridSearch('user-1', 'what is INC-2203 about', 5, undefined, { pinIdentifiers: true });
    expect(out.map((r) => r.pageId)).toEqual([1, 2]);
  });

  it('without the flag nothing happens', async () => {
    routePinQueries({ page_id: 42, confluence_id: 'x', title: 'X', space_key: 'DEV', excerpt: 'x' });
    const out = await hybridSearch('user-1', 'what is INC-2203 about', 5);
    expect(out[0]!.pinned).toBeUndefined();
  });

  // #1351: the pin stage's SQL has no space_key predicate of its own (see
  // the `inScope` note at its call site) — opts.spaceKey is enforced as a
  // post-filter on the verified candidate, the same way the ACL check
  // already is.
  it('opts.spaceKey refuses to pin a VERIFIED identifier from a different space', async () => {
    routePinQueries({ page_id: 42, confluence_id: 'inc-page', title: 'INC-2203 postmortem', space_key: 'OPS', excerpt: 'incident details' });
    const out = await hybridSearch('user-1', 'what is INC-2203 about', 5, undefined, {
      pinIdentifiers: true,
      spaceKey: 'DEV',
    });
    // The out-of-scope match must not surface at all — not pinned, and not
    // silently admitted into the fused order either (it was never a fused
    // candidate; vectorSearch/keywordSearch already scoped those legs).
    expect(out.some((r) => r.pageId === 42)).toBe(false);
    expect(out.map((r) => r.pageId)).toEqual([1, 2]);
  });

  it('opts.spaceKey still pins a VERIFIED identifier that IS in the scoped space', async () => {
    routePinQueries({ page_id: 42, confluence_id: 'inc-page', title: 'INC-2203 postmortem', space_key: 'DEV', excerpt: 'incident details' });
    const out = await hybridSearch('user-1', 'what is INC-2203 about', 5, undefined, {
      pinIdentifiers: true,
      spaceKey: 'DEV',
    });
    expect(out[0]!.pageId).toBe(42);
    expect(out[0]!.pinned).toBe(true);
  });

  it('the operator kill switch disables the stage — no detection, no lookup (#1273 M11)', async () => {
    invalidateRagPinIdentifiersCache();
    mocks.mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('rag_pin_identifiers')) return { rows: [{ setting_value: '0' }] };
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) return { rows: [{ embedded: 2, total: 2 }] };
      return { rows: [] };
    });
    const out = await hybridSearch('user-1', 'what is INC-2203 about', 5, undefined, { pinIdentifiers: true });
    expect(out[0]!.pinned).toBeUndefined();
    const lookups = mocks.mockQuery.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('substring(cp.body_text, 1, $5)'),
    );
    expect(lookups).toHaveLength(0);
    invalidateRagPinIdentifiersCache();
  });

  it('a LIVE-CUE short query with a prose-trap number issues no lookup — the guard is in the detector, not luck (#1273 M3)', async () => {
    routePinQueries({ page_id: 42, confluence_id: 'x', title: 'X', space_key: 'DEV', excerpt: 'x' });
    await hybridSearch('user-1', 'what does page 7 say', 5, undefined, { pinIdentifiers: true });
    const lookups = mocks.mockQuery.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('substring(cp.body_text, 1, $5)'),
    );
    expect(lookups).toHaveLength(0);
  });

  it('a pinned-only head writes max_score NULL, never 0 — analytics unit contract (#1273 M8)', async () => {
    // topK 1 with a NEW pin displacing everything: the analytics row must
    // not claim a fused score of 0.
    routePinQueries({ page_id: 42, confluence_id: 'inc-page', title: 'INC-2203 postmortem', space_key: 'DEV', excerpt: 'x' });
    await hybridSearch('user-1', 'what is INC-2203 about', 1, undefined, { pinIdentifiers: true });
    const analytics = mocks.mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('search_analytics'),
    );
    expect(analytics).toBeDefined();
    expect((analytics![1] as unknown[])[3]).toBeNull();
  });

  it('an issue-key lookup probes TITLES only — a body MENTION never pins (#1273 fork F1)', async () => {
    // The shape that admits INC-2203 also admits SHA-256/UTF-8/ISO-8601,
    // so verifying against body text pinned an arbitrary mentioning page
    // at rank 1 for any short query carrying a hyphenated uppercase token.
    routePinQueries(undefined);
    await hybridSearch('user-1', 'SHA-256 vs MD5', 5, undefined, { pinIdentifiers: true });
    const lookupSql = mocks.mockQuery.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((s: unknown): s is string => typeof s === 'string' && s.includes('substring(cp.body_text, 1, $5)'));
    expect(lookupSql.length).toBeGreaterThan(0);
    expect(lookupSql.every((s) => !s.includes('phraseto_tsquery'))).toBe(true);
    expect(lookupSql.every((s) => !s.includes('cp.tsv'))).toBe(true);
  });

  it('the excerpt is sized to the per-page context budget, not a hardcoded lede (#1273 fork F9)', async () => {
    routePinQueries({ page_id: 42, confluence_id: 'inc-page', title: 'INC-2203 postmortem', space_key: 'DEV', excerpt: 'x' });
    await hybridSearch('user-1', 'what is INC-2203 about', 5, undefined, { pinIdentifiers: true });
    const call = mocks.mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('substring(cp.body_text, 1, $5)'),
    );
    expect(call).toBeDefined();
    expect((call![1] as unknown[])[4]).toBe(RAG_CONTEXT_CHARS_DEFAULT);
  });

  it('a verified page that fused just OUTSIDE topK keeps its enriched row (#1273 fork F12)', async () => {
    // Page 2 is in `candidates` but sliced off by topK 1. Pinning it must
    // recover the scored chunk, not re-enter it as a bare excerpt — this
    // IS the diluted-exact-match case the feature exists for.
    routePinQueries({ page_id: 2, confluence_id: 'page-2', title: 'Page 2', space_key: 'DEV', excerpt: 'bare excerpt' });
    const out = await hybridSearch('user-1', 'what is INC-2203 about', 1, undefined, { pinIdentifiers: true });
    expect(out.map((r) => r.pageId)).toEqual([2]);
    expect(out[0]!.pinned).toBe(true);
    expect(out[0]!.vectorScore).not.toBeNull();
    expect(out[0]!.chunkText).toBe('chunk of page 2');
  });

  it('one failing lookup skips only ITS pin — a second verified identifier still lands (#1273 fork F8)', async () => {
    // 'page 43561 "Runbook"' detects pageId + title. The pageId probe dies;
    // the independently verified title pin must survive.
    mocks.mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('substring(cp.body_text, 1, $5)')) {
        // `cp.confluence_id = $2` is the pageId PREDICATE; the bare column
        // name appears in every branch's SELECT list.
        if (sql.includes('cp.confluence_id = $2')) throw new Error('lookup died');
        if (sql.includes('cp.title %')) {
          return { rows: [{ page_id: 77, confluence_id: 'rb', title: 'Runbook', space_key: 'DEV', excerpt: 'r' }] };
        }
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) return { rows: [{ embedded: 2, total: 2 }] };
      return { rows: [] };
    });
    const out = await hybridSearch('user-1', 'page 43561 "Runbook"', 5, undefined, { pinIdentifiers: true });
    expect(out[0]!.pageId).toBe(77);
    expect(out[0]!.pinned).toBe(true);
  });

  it('ACL filtering picks the accessible candidate instead of suppressing the pin (#1273 fork F5)', async () => {
    // Two same-titled pages, restricted one first. The single-row lookup
    // let the restricted row win the slot and then dropped it, so the page
    // the user CAN read pinned nothing.
    mocks.mockIsFeatureEnabled.mockReturnValue(true);
    // Everything the fused legs found stays readable; only the restricted
    // same-titled page (99) is not.
    mocks.mockFilterAccessiblePages.mockResolvedValue(new Set([1, 2, 88]));
    mocks.mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('substring(cp.body_text, 1, $5)')) {
        return {
          rows: [
            { page_id: 99, confluence_id: 'hr', title: 'Deployment Runbook', space_key: 'HR', excerpt: 'restricted' },
            { page_id: 88, confluence_id: 'eng', title: 'Deployment Runbook', space_key: 'DEV', excerpt: 'readable' },
          ],
        };
      }
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) return { rows: [{ embedded: 2, total: 2 }] };
      return { rows: [] };
    });
    const out = await hybridSearch('user-1', 'find "Deployment Runbook"', 5, undefined, { pinIdentifiers: true });
    expect(out[0]!.pageId).toBe(88);
    expect(out[0]!.pinned).toBe(true);
    expect(out.some((r) => r.pageId === 99)).toBe(false);
  });

  it('two detections resolving to the SAME page pin it once — never a substitute neighbour', async () => {
    // The candidate list is everything above pg_trgm's 0.3 threshold, so
    // row 2 is a near-title NEIGHBOUR, not a second answer. Sliding onto it
    // when row 1 is already pinned looks like de-duplication and is not:
    // one gesture would pin an unrelated page as a verified exact match,
    // ahead of every fused result.
    mocks.mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('substring(cp.body_text, 1, $5)')) {
        return {
          rows: [
            { page_id: 55, confluence_id: 'faq', title: 'FAQ', space_key: 'DEV', excerpt: 'the real one' },
            { page_id: 56, confluence_id: 'faq2', title: 'FAQs archive', space_key: 'DEV', excerpt: 'a neighbour' },
          ],
        };
      }
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) return { rows: [{ embedded: 2, total: 2 }] };
      return { rows: [] };
    });
    // pageId + title: two detections, both resolving to page 55 here.
    const out = await hybridSearch('user-1', 'page 43561 "FAQ"', 5, undefined, { pinIdentifiers: true });
    expect(out.filter((r) => r.pinned).map((r) => r.pageId)).toEqual([55]);
    expect(out.some((r) => r.pageId === 56)).toBe(false);
  });

  it('a pin recovered from outside topK keeps its RERANK score, not just its chunk', async () => {
    // The rerank stage builds NEW row objects and never mutates the fused
    // candidate array, so recovering an out-of-topK page from `candidates`
    // silently dropped the relevance score the recovery exists to preserve.
    // Recovery reads the reranked pool; this is that difference.
    mocks.mockResolveRerank.mockResolvedValue({
      config: { providerId: 'r1', id: 'r1', name: 'R', baseUrl: 'http://r/v1', apiKey: null, authType: 'none', verifySsl: true, defaultModel: 'bge-reranker' },
      model: 'bge-reranker',
    });
    // Page 2 must be SCORED but land OUTSIDE topK — that is the only
    // arrangement that exercises the fallback. Scoring it top instead put
    // it back inside topResults, and the test passed with the pool change
    // reverted (caught by mutating the source, not by reading it).
    mocks.mockRerank.mockResolvedValue([
      { index: 0, relevanceScore: 0.95 },
      { index: 1, relevanceScore: 0.42 },
    ]);
    routePinQueries({ page_id: 2, confluence_id: 'page-2', title: 'Page 2', space_key: 'DEV', excerpt: 'bare excerpt' });
    const out = await hybridSearch('user-1', 'what is INC-2203 about', 1, undefined, { pinIdentifiers: true, rerank: true });
    expect(out.map((r) => r.pageId)).toEqual([2]);
    expect(out[0]!.pinned).toBe(true);
    expect(out[0]!.rerankScore).toBe(0.42);
    expect(out[0]!.chunkText).toBe('chunk of page 2');
  });

  it('the lookup asks for a CANDIDATE LIST, never a single row — ACL runs before the winner is chosen', async () => {
    routePinQueries({ page_id: 42, confluence_id: 'inc-page', title: 'INC-2203 postmortem', space_key: 'DEV', excerpt: 'x' });
    await hybridSearch('user-1', 'what is INC-2203 about', 5, undefined, { pinIdentifiers: true });
    const call = mocks.mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('substring(cp.body_text, 1, $5)'),
    );
    expect(call![0] as string).not.toMatch(/LIMIT 1\b/);
    expect((call![1] as unknown[])).toContain(IDENTIFIER_LOOKUP_CANDIDATES);
  });
});
