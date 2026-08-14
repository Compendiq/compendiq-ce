import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockLogger } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockLogger: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../../core/db/postgres.js', () => ({ query: mockQuery }));
vi.mock('../../../core/utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../services/rag-service.js', () => ({ hybridSearch: vi.fn() }));
vi.mock('../services/multi-query-search.js', () => ({ multiQuerySearch: vi.fn() }));

import {
  buildReport,
  getActiveProductionBenchmark,
  runProductionBenchmark,
  type ProductionBenchmarkQueryResult,
} from './production-benchmark.js';

function row(
  id: string,
  baselineIds: number[],
  deepIds: number[],
  expansion: 'expanded' | 'skipped' | 'unavailable',
  expectedPageIds?: number[],
): ProductionBenchmarkQueryResult {
  const variant = (pageIds: number[], latencyMs: number) => ({
    pageIds,
    pages: pageIds.map((pageId) => ({ pageId, title: `Page ${pageId}`, spaceKey: 'ENG' })),
    latencyMs,
  });
  return {
    id,
    query: `question ${id}`,
    ...(expectedPageIds ? { expectedPageIds } : {}),
    baseline: variant(baselineIds, 10),
    deepSearch: { ...variant(deepIds, 20), expansion },
  };
}

describe('production retrieval benchmark report', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockLogger.error.mockReset();
    mockLogger.warn.mockReset();
  });

  it('compares paired result movement and latency without inventing recall labels', () => {
    const report = buildReport([
      row('one', [1, 2, 3], [1, 2, 3], 'skipped'),
      row('two', [4, 5, 6], [7, 5, 6], 'expanded'),
    ], 'recent-queries', 3);

    expect(report.queryCount).toBe(2);
    expect(report.baseline.averageLatencyMs).toBe(10);
    expect(report.deepSearch.p95LatencyMs).toBe(20);
    expect(report.deepSearch.expansionParticipatingQueries).toBe(1);
    expect(report.deepSearch.expansionSkippedQueries).toBe(1);
    expect(report.deepSearch.expansionUnavailableQueries).toBe(0);
    expect(report.paired.top1ChangedQueries).toBe(1);
    expect(report.paired.topKChangedQueries).toBe(1);
    expect(report.paired.averageTopKOverlap).toBeCloseTo(0.75);
    expect(report.baseline.recallAtK).toBeNull();
    expect(report.deepSearch.mrr).toBeNull();
  });

  it('scores recall only for explicitly labelled custom queries', () => {
    const report = buildReport([
      row('one', [8, 2], [2, 8], 'expanded', [2]),
      row('two', [4, 5], [4, 5], 'skipped'),
    ], 'custom', 2);

    expect(report.baseline.labeledQueryCount).toBe(1);
    expect(report.deepSearch.labeledQueryCount).toBe(1);
    expect(report.baseline.recallAtK).toEqual({ '@1': 0 });
    expect(report.deepSearch.recallAtK).toEqual({ '@1': 1 });
  });

  it('recovers stale active runs before checking for a conflicting run', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'stale-run' }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(getActiveProductionBenchmark()).resolves.toBeNull();

    expect(mockQuery.mock.calls[0]![0]).toContain('last_heartbeat_at < NOW()');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { benchmarkRunIds: ['stale-run'] },
      'Recovered abandoned production retrieval benchmark runs',
    );
  });

  it('handles a startup failure without rejecting the background task', async () => {
    mockQuery
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(runProductionBenchmark('run-id', 'admin-id')).resolves.toBeUndefined();

    expect(mockQuery.mock.calls[1]![0]).toContain("SET status = 'failed'");
    expect(mockLogger.error).toHaveBeenCalled();
  });
});
