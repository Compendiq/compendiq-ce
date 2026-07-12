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
  const mockGetUserAccessibleSpaces = vi.fn();

  return {
    mockClientQuery,
    mockClient,
    mockPool,
    mockQuery,
    mockGetUserAccessibleSpaces,
  };
});

vi.mock('../../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mocks.mockQuery(...args),
  getPool: () => mocks.mockPool,
}));

vi.mock('../../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mocks.mockGetUserAccessibleSpaces(...args),
  getUserAccessibleSpacesMemoized: (...args: unknown[]) => mocks.mockGetUserAccessibleSpaces(...args),
}));

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { tokenJaccardSimilarity, findDuplicates, scanAllDuplicates } from './duplicate-detector.js';

describe('DuplicateDetector', () => {
  describe('tokenJaccardSimilarity', () => {
    it('should return 1 for identical strings', () => {
      expect(tokenJaccardSimilarity('hello world', 'hello world')).toBe(1);
    });

    it('should return 0 for completely different strings', () => {
      expect(tokenJaccardSimilarity('foo bar', 'baz qux')).toBe(0);
    });

    it('should return a value between 0 and 1 for partially similar strings', () => {
      const sim = tokenJaccardSimilarity('getting started guide', 'getting started tutorial');
      expect(sim).toBeGreaterThan(0);
      expect(sim).toBeLessThan(1);
      // "getting" and "started" overlap out of 4 unique tokens
      // intersection=2, union=4, so 2/4=0.5
      expect(sim).toBeCloseTo(0.5, 1);
    });

    it('should be case-insensitive', () => {
      expect(tokenJaccardSimilarity('Hello World', 'hello world')).toBe(1);
    });

    it('should ignore punctuation', () => {
      expect(tokenJaccardSimilarity("hello, world!", "hello world")).toBe(1);
    });

    it('should return 1 for two empty strings', () => {
      expect(tokenJaccardSimilarity('', '')).toBe(1);
    });

    it('should return 0 when one string is empty', () => {
      expect(tokenJaccardSimilarity('hello', '')).toBe(0);
    });

    it('should handle multi-word overlapping titles', () => {
      const sim = tokenJaccardSimilarity(
        'How to Deploy to Production',
        'Deploy to Production Guide',
      );
      // Overlap: deploy, to, production (3), union: deploy, to, production, how, guide (5) => 3/5 = 0.6
      expect(sim).toBeCloseTo(0.6, 1);
    });
  });

  describe('findDuplicates', () => {
    beforeEach(() => {
      vi.resetAllMocks();
      // Restore pool mock after reset
      mocks.mockPool.connect.mockResolvedValue(mocks.mockClient);
      mocks.mockClient.release.mockResolvedValue(undefined);
      // #733: findDuplicates now resolves the caller's accessible spaces
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
    });

    it('should return duplicate candidates when source page exists and neighbors found', async () => {
      // Step 1: preliminary query — source page found
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [{ id: 42, title: 'Source Page', space_key: 'DEV' }],
      });
      // Step 2: client.query('BEGIN')
      mocks.mockClientQuery.mockResolvedValueOnce(undefined);
      // Step 3: client.query('SET LOCAL hnsw.ef_search = ...')
      mocks.mockClientQuery.mockResolvedValueOnce(undefined);
      // Step 4: CTE neighbor search
      mocks.mockClientQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 101,
            confluence_id: 'neighbor-1',
            title: 'Neighbor Page',
            space_key: 'DEV',
            distance: 0.05,
          },
        ],
      });
      // Step 5: client.query('COMMIT')
      mocks.mockClientQuery.mockResolvedValueOnce(undefined);

      const result = await findDuplicates('user-1', 'conf-source', { distanceThreshold: 0.15, limit: 10 });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(101);
      expect(result[0].confluenceId).toBe('neighbor-1');
      expect(result[0].title).toBe('Neighbor Page');
      expect(result[0].spaceKey).toBe('DEV');
      expect(result[0].embeddingDistance).toBe(0.05);
      expect(result[0].combinedScore).toBeGreaterThan(0);

      // Verify pool.connect was called (client path taken)
      expect(mocks.mockPool.connect).toHaveBeenCalledTimes(1);
      expect(mocks.mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should return [] when source page is not found (instead of throwing)', async () => {
      // Preliminary query returns no rows
      mocks.mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await findDuplicates('user-1', 'nonexistent-page');

      expect(result).toEqual([]);
      // Pool should NOT be connected when page is not found
      expect(mocks.mockPool.connect).not.toHaveBeenCalled();
    });

    it('should return [] when source page has no embeddings (CTE returns empty)', async () => {
      // Step 1: preliminary query — source page found
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [{ id: 42, title: 'Source Page', space_key: 'DEV' }],
      });
      // Step 2: client.query('BEGIN')
      mocks.mockClientQuery.mockResolvedValueOnce(undefined);
      // Step 3: client.query('SET LOCAL hnsw.ef_search = ...')
      mocks.mockClientQuery.mockResolvedValueOnce(undefined);
      // Step 4: CTE returns no neighbors (no embeddings for source)
      mocks.mockClientQuery.mockResolvedValueOnce({ rows: [] });
      // Step 5: client.query('COMMIT')
      mocks.mockClientQuery.mockResolvedValueOnce(undefined);

      const result = await findDuplicates('user-1', 'conf-source-no-embeddings');

      expect(result).toEqual([]);
      expect(mocks.mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should use sourcePageId (integer) in CTE params, not confluenceId string', async () => {
      // Source page found with id=99
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [{ id: 99, title: 'Source Page', space_key: 'DEV' }],
      });
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({ rows: [] }); // CTE
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      await findDuplicates('user-1', 'conf-source', { limit: 5 });

      // The CTE query call is the 3rd client.query call (index 2)
      const cteCall = mocks.mockClientQuery.mock.calls[2];
      // [sourcePageId=99, limit*3=15, accessibleSpaces, userId] (#733)
      expect(cteCall[1]).toEqual([99, 15, ['DEV'], 'user-1']);
      // First param should be integer 99 (not the string 'conf-source')
      expect(typeof cteCall[1][0]).toBe('number');

      // CTE SQL should use page_id, not confluence_id
      const cteSQL = cteCall[0] as string;
      // CTE should use page_id to join page_embeddings → pages (not the dropped confluence_id column)
      expect(cteSQL).toContain('page_id = $1');
      expect(cteSQL).toContain('pe2.page_id = cp2.id');
      // The old broken join referenced pe2.confluence_id — verify it's gone
      expect(cteSQL).not.toContain('pe2.confluence_id');
      // Dedup on the page PK (cp2.id), not the nullable confluence_id —
      // otherwise standalone pages (confluence_id IS NULL) collapse into one row.
      expect(cteSQL).toContain('DISTINCT ON (cp2.id)');
      expect(cteSQL).not.toContain('DISTINCT ON (cp2.confluence_id)');
      expect(cteSQL).toContain('ORDER BY cp2.id, pe2.embedding');
    });

    // ── #733 RBAC regressions ───────────────────────────────────────────

    it('returns [] when the source page is in an inaccessible space (#733)', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [{ id: 42, title: 'Restricted Page', space_key: 'SECRET' }],
      });

      const result = await findDuplicates('user-1', 'conf-restricted');

      expect(result).toEqual([]);
      // Critical: the kNN query must never run for an inaccessible source.
      expect(mocks.mockPool.connect).not.toHaveBeenCalled();
    });

    it('applies the RBAC space/visibility filter to the kNN query (#733)', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [{ id: 42, title: 'Source Page', space_key: 'DEV' }],
      });
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({ rows: [] }); // CTE
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      await findDuplicates('user-1', 'conf-source');

      const cteCall = mocks.mockClientQuery.mock.calls[2];
      const cteSQL = cteCall[0] as string;
      // Same retrieval scope as rag-service: Confluence pages restricted to
      // accessible spaces; standalone pages by shared/own-private visibility.
      expect(cteSQL).toContain("cp2.source = 'confluence' AND cp2.space_key = ANY($3::text[])");
      expect(cteSQL).toContain("cp2.source = 'standalone' AND cp2.visibility = 'shared'");
      expect(cteSQL).toContain("cp2.visibility = 'private' AND cp2.created_by_user_id = $4");
      expect(cteCall[1]).toEqual([42, 30, ['DEV', 'OPS'], 'user-1']);
    });

    it('should filter out candidates exceeding distanceThreshold', async () => {
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [{ id: 42, title: 'Source Page', space_key: 'DEV' }],
      });
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      // CTE returns one close match and one far one
      mocks.mockClientQuery.mockResolvedValueOnce({
        rows: [
          { id: 1, confluence_id: 'close-1', title: 'Close Neighbor', space_key: 'DEV', distance: 0.05 },
          { id: 2, confluence_id: 'far-1', title: 'Far Neighbor', space_key: 'DEV', distance: 0.50 },
        ],
      });
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      const result = await findDuplicates('user-1', 'conf-source', { distanceThreshold: 0.15 });

      expect(result).toHaveLength(1);
      expect(result[0].confluenceId).toBe('close-1');
    });
  });

  describe('scanAllDuplicates', () => {
    beforeEach(() => {
      vi.resetAllMocks();
      mocks.mockPool.connect.mockResolvedValue(mocks.mockClient);
      mocks.mockClient.release.mockResolvedValue(undefined);
    });

    it('should use corrected JOIN (pe.page_id = cp.id) when querying pages with embeddings', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      // Main pages query returns empty (no pages to scan — keeps test minimal)
      mocks.mockQuery.mockResolvedValueOnce({ rows: [] });

      await scanAllDuplicates('user-1');

      // The first query is the pages scan — verify its SQL uses the corrected JOIN
      expect(mocks.mockQuery).toHaveBeenCalledTimes(1);
      const scanSQL = mocks.mockQuery.mock.calls[0][0] as string;
      expect(scanSQL).toContain('pe.page_id = cp.id');
      expect(scanSQL).not.toContain('cp.confluence_id = pe.confluence_id');
    });

    it('should return pairs from the single self-join pass', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      // The rewritten scan issues one self-join query returning candidate pairs.
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [
          {
            page1_id: 10, page1_confluence_id: 'page-a', page1_title: 'Page A',
            page2_id: 20, page2_confluence_id: 'page-b', page2_title: 'Page B',
            page2_space_key: 'DEV', distance: 0.08,
          },
        ],
      });

      const pairs = await scanAllDuplicates('user-1', { distanceThreshold: 0.15 });

      expect(pairs).toHaveLength(1);
      expect(pairs[0].page1.confluenceId).toBe('page-a');
      expect(pairs[0].page1.sourceId).toBe('page-a');
      expect(pairs[0].page2.confluenceId).toBe('page-b');
      expect(pairs[0].page2.spaceKey).toBe('DEV');
      expect(pairs[0].page2.embeddingDistance).toBe(0.08);
      expect(pairs[0].page2.combinedScore).toBeGreaterThan(0);
    });

    it('restricts both pair members to the caller-readable set and binds the threshold (#733/#907)', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV', 'OPS']);
      mocks.mockQuery.mockResolvedValueOnce({ rows: [] });

      await scanAllDuplicates('user-1', { distanceThreshold: 0.2 });

      expect(mocks.mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mocks.mockQuery.mock.calls[0];
      const scanSQL = sql as string;
      // Same visibility scope as findDuplicates, applied inside the averaging CTE…
      expect(scanSQL).toContain("cp.source = 'confluence' AND cp.space_key = ANY($1::text[])");
      expect(scanSQL).toContain("cp.source = 'standalone' AND cp.visibility = 'shared'");
      expect(scanSQL).toContain("cp.visibility = 'private' AND cp.created_by_user_id = $2");
      // …with each unordered pair returned exactly once via the self-join.
      expect(scanSQL).toContain('a.page_id < b.page_id');
      // Params: [accessibleSpaces, userId, distanceThreshold]
      expect(params).toEqual([['DEV', 'OPS'], 'user-1', 0.2]);
    });

    it('caps how many pairs a single page may appear in (maxPairsPerPage)', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      // Page 10 forms a near-duplicate pair with 20, 30 and 40. With
      // maxPairsPerPage=2 only its two strongest (closest) pairs survive.
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [
          { page1_id: 10, page1_confluence_id: 'a', page1_title: 'A', page2_id: 20, page2_confluence_id: 'b', page2_title: 'B', page2_space_key: 'DEV', distance: 0.02 },
          { page1_id: 10, page1_confluence_id: 'a', page1_title: 'A', page2_id: 30, page2_confluence_id: 'c', page2_title: 'C', page2_space_key: 'DEV', distance: 0.03 },
          { page1_id: 10, page1_confluence_id: 'a', page1_title: 'A', page2_id: 40, page2_confluence_id: 'd', page2_title: 'D', page2_space_key: 'DEV', distance: 0.04 },
        ],
      });

      const pairs = await scanAllDuplicates('user-1', { distanceThreshold: 0.15, maxPairsPerPage: 2 });

      expect(pairs).toHaveLength(2);
      // The two closest (highest-scoring) partners of page 10 are kept.
      expect(pairs.map((p) => p.page2.confluenceId)).toEqual(['b', 'c']);
    });

    it('resolves accessible spaces once and scans in a single query pass (#907)', async () => {
      // The rewritten scan issues ONE self-join query and resolves the caller's
      // readable spaces ONCE. The old per-page loop paid an RBAC lookup plus a
      // dedicated kNN transaction for EVERY page (O(N) round trips + O(N×M)
      // chunk-distance evals) — this asserts those are collapsed to a single pass.
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      mocks.mockQuery.mockResolvedValue({
        rows: [
          {
            page1_id: 10, page1_confluence_id: 'page-a', page1_title: 'Page A',
            page2_id: 20, page2_confluence_id: 'page-b', page2_title: 'Page B',
            page2_space_key: 'DEV', distance: 0.05,
          },
          {
            page1_id: 10, page1_confluence_id: 'page-a', page1_title: 'Page A',
            page2_id: 30, page2_confluence_id: 'page-c', page2_title: 'Page C',
            page2_space_key: 'DEV', distance: 0.06,
          },
        ],
      });

      const pairs = await scanAllDuplicates('user-1', { distanceThreshold: 0.15 });

      // One RBAC resolution for the whole scan (was 1 + N).
      expect(mocks.mockGetUserAccessibleSpaces).toHaveBeenCalledTimes(1);
      // One SQL pass — no per-page preliminary SELECT, no per-page transaction.
      expect(mocks.mockQuery).toHaveBeenCalledTimes(1);
      expect(mocks.mockPool.connect).not.toHaveBeenCalled();

      // Each unordered pair is reported once, mapped from the self-join rows.
      expect(pairs).toHaveLength(2);
      expect(pairs[0].page1.confluenceId).toBe('page-a');
      expect(pairs.map((p) => p.page2.confluenceId).sort()).toEqual(['page-b', 'page-c']);
    });
  });
});
