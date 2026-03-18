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
    });

    it('should return duplicate candidates when source page exists and neighbors found', async () => {
      // Step 1: preliminary query — source page found
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [{ id: 42, title: 'Source Page' }],
      });
      // Step 2: client.query('BEGIN')
      mocks.mockClientQuery.mockResolvedValueOnce(undefined);
      // Step 3: client.query('SET LOCAL hnsw.ef_search = ...')
      mocks.mockClientQuery.mockResolvedValueOnce(undefined);
      // Step 4: CTE neighbor search
      mocks.mockClientQuery.mockResolvedValueOnce({
        rows: [
          {
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
        rows: [{ id: 42, title: 'Source Page' }],
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
        rows: [{ id: 99, title: 'Source Page' }],
      });
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({ rows: [] }); // CTE
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      await findDuplicates('user-1', 'conf-source', { limit: 5 });

      // The CTE query call is the 3rd client.query call (index 2)
      const cteCall = mocks.mockClientQuery.mock.calls[2];
      expect(cteCall[1]).toEqual([99, 15]); // [sourcePageId=99, limit*3=5*3=15]
      // First param should be integer 99 (not the string 'conf-source')
      expect(typeof cteCall[1][0]).toBe('number');

      // CTE SQL should use page_id, not confluence_id
      const cteSQL = cteCall[0] as string;
      // CTE should use page_id to join page_embeddings → pages (not the dropped confluence_id column)
      expect(cteSQL).toContain('page_id = $1');
      expect(cteSQL).toContain('pe2.page_id = cp2.id');
      // The old broken join referenced pe2.confluence_id — verify it's gone
      expect(cteSQL).not.toContain('pe2.confluence_id');
    });

    it('should filter out candidates exceeding distanceThreshold', async () => {
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [{ id: 42, title: 'Source Page' }],
      });
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      // CTE returns one close match and one far one
      mocks.mockClientQuery.mockResolvedValueOnce({
        rows: [
          { confluence_id: 'close-1', title: 'Close Neighbor', space_key: 'DEV', distance: 0.05 },
          { confluence_id: 'far-1', title: 'Far Neighbor', space_key: 'DEV', distance: 0.50 },
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

    it('should return pairs when duplicates are found', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      // Pages scan returns one page
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [{ confluence_id: 'page-a', title: 'Page A' }],
      });

      // findDuplicates for 'page-a': preliminary SELECT
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [{ id: 10, title: 'Page A' }],
      });
      // findDuplicates: BEGIN, SET LOCAL, CTE (1 neighbor), COMMIT
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockClientQuery.mockResolvedValueOnce({
        rows: [
          { confluence_id: 'page-b', title: 'Page B', space_key: 'DEV', distance: 0.08 },
        ],
      }); // CTE
      mocks.mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT

      const pairs = await scanAllDuplicates('user-1', { distanceThreshold: 0.15 });

      expect(pairs).toHaveLength(1);
      expect(pairs[0].page1.confluenceId).toBe('page-a');
      expect(pairs[0].page2.confluenceId).toBe('page-b');
    });

    it('should deduplicate A->B and B->A pairs', async () => {
      mocks.mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
      // Pages scan returns two pages
      mocks.mockQuery.mockResolvedValueOnce({
        rows: [
          { confluence_id: 'page-a', title: 'Page A' },
          { confluence_id: 'page-b', title: 'Page B' },
        ],
      });

      // findDuplicates for 'page-a' → finds page-b
      mocks.mockQuery.mockResolvedValueOnce({ rows: [{ id: 10, title: 'Page A' }] });
      mocks.mockClientQuery
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(undefined) // SET LOCAL
        .mockResolvedValueOnce({
          rows: [{ confluence_id: 'page-b', title: 'Page B', space_key: 'DEV', distance: 0.08 }],
        }) // CTE
        .mockResolvedValueOnce(undefined); // COMMIT

      // findDuplicates for 'page-b' → finds page-a (same pair, should be deduplicated)
      mocks.mockQuery.mockResolvedValueOnce({ rows: [{ id: 20, title: 'Page B' }] });
      mocks.mockClientQuery
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(undefined) // SET LOCAL
        .mockResolvedValueOnce({
          rows: [{ confluence_id: 'page-a', title: 'Page A', space_key: 'DEV', distance: 0.08 }],
        }) // CTE
        .mockResolvedValueOnce(undefined); // COMMIT

      const pairs = await scanAllDuplicates('user-1', { distanceThreshold: 0.15 });

      // Only 1 pair (A-B), not 2 (A-B and B-A)
      expect(pairs).toHaveLength(1);
    });
  });
});
