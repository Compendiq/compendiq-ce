import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockLogger, mockSampleAnalyticsQueries } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockLogger: { error: vi.fn(), warn: vi.fn() },
  mockSampleAnalyticsQueries: vi.fn(),
}));

vi.mock('../../../core/db/postgres.js', () => ({ query: mockQuery }));
vi.mock('../../../core/utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../services/rag-service.js', () => ({ hybridSearch: vi.fn() }));
vi.mock('../services/multi-query-search.js', () => ({ multiQuerySearch: vi.fn() }));
// #1520 — the sampler is SHARED with the #1260 shadow comparison and differs
// between the two harnesses only in `orderBy`, so the benchmark's choice of
// argument is the whole of its "what people ask NOW" claim. Spied, not
// exercised: the sampler's own suite covers both orders already; what nothing
// covered is which one this caller asks for.
vi.mock('./analytics-query-sampler.js', () => ({
  sampleAnalyticsQueries: mockSampleAnalyticsQueries,
}));

import {
  buildReport,
  getActiveProductionBenchmark,
  runProductionBenchmark,
  type ProductionBenchmarkQueryResult,
} from './production-benchmark.js';
import { hybridSearch } from '../services/rag-service.js';
import { multiQuerySearch } from '../services/multi-query-search.js';

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
    mockSampleAnalyticsQueries.mockReset();
    vi.mocked(hybridSearch).mockReset();
    vi.mocked(multiQuerySearch).mockReset();
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

  it('recovers stale active runs before checking for a conflicting run, naming each run\'s kind', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'stale-run', kind: null }, { id: 'stale-compare', kind: 'shadow-compare' }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(getActiveProductionBenchmark()).resolves.toBeNull();

    const sweep = mockQuery.mock.calls[0]!;
    expect(sweep[0]).toContain('last_heartbeat_at < NOW()');
    // One sweep, two kinds of copy: a comparison must never be failed with
    // "start a new benchmark", a run its admin never started.
    expect(sweep[0]).toContain("CASE WHEN config->>'kind' = 'shadow-compare'");
    expect(sweep[1]![0]).toMatch(/comparison worker stopped/i);
    expect(sweep[1]![1]).toMatch(/benchmark worker stopped/i);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      {
        runs: [
          { id: 'stale-run', kind: null },
          { id: 'stale-compare', kind: 'shadow-compare' },
        ],
      },
      'Recovered abandoned retrieval benchmark / shadow comparison runs',
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

  /**
   * #1520 — the benchmark's `orderBy` argument at the shared sampler.
   *
   * Before #1260 the ordering was hardcoded SQL inside this module; the
   * extraction into `analytics-query-sampler.ts` turned it into a one-word
   * argument, and the sampler's own suite exercises BOTH orders — so the
   * sampler is tested and this caller's choice was not. Flipping line 205 to
   * `'frequency'` left `production-benchmark.test.ts` +
   * `llm-retrieval-benchmark.test.ts` + `shadow-compare-service.integration
   * .test.ts` at 41 passed, while the mirror mutation on the comparison side
   * reds two integration cells: only the benchmark half was unpinned.
   *
   * `days` and `limit` are asserted in the same call object, because a window
   * silently taken from somewhere other than the admin's request would report
   * on a different period than the card names.
   */
  it("samples the RECENCY-ordered window — this benchmark reports on what people ask NOW (#1520)", async () => {
    // The run-row lifecycle: read the queued config, win the claim, then every
    // later statement (progress, heartbeat, completion) is a plain success.
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({
      rows: [{ config: { source: 'recent-queries', days: 14, limit: 5, topK: 3 }, status: 'queued' }],
    });
    mockSampleAnalyticsQueries.mockResolvedValue(['how do I rotate the confluence token']);
    vi.mocked(hybridSearch).mockResolvedValue([]);
    vi.mocked(multiQuerySearch).mockResolvedValue([]);

    await expect(runProductionBenchmark('run-id', 'admin-id')).resolves.toBeUndefined();

    // The run really completed — otherwise the assertion below could be
    // satisfied by a sampler call made on the way to a failure.
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockSampleAnalyticsQueries).toHaveBeenCalledTimes(1);
    expect(mockSampleAnalyticsQueries).toHaveBeenCalledWith({
      days: 14,
      limit: 5,
      orderBy: 'recency',
    });
  });

  /**
   * …and a CUSTOM suite must never reach the sampler: its queries are the
   * admin's own labelled set, and silently mixing analytics queries into it
   * would score recall against ground truth that belongs to other queries.
   */
  it('never samples analytics for a custom suite (#1520)', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        config: {
          source: 'custom', days: 30, limit: 25, topK: 3,
          queries: [{ query: 'where is the runbook', expectedPageIds: [7] }],
        },
        status: 'queued',
      }],
    });
    vi.mocked(hybridSearch).mockResolvedValue([]);
    vi.mocked(multiQuerySearch).mockResolvedValue([]);

    await expect(runProductionBenchmark('run-id', 'admin-id')).resolves.toBeUndefined();

    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockSampleAnalyticsQueries).not.toHaveBeenCalled();
  });
});
