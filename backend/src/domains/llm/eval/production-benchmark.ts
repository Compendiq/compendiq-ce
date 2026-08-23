/**
 * Production retrieval benchmark.
 *
 * This is intentionally separate from the destructive #1102 fixture runner.
 * It reads the deployment's current pages and embeddings through the same
 * retrieval functions the chat path uses, then compares ordinary retrieval
 * with per-request deep search. It never seeds, truncates, re-embeds, changes
 * settings, or records synthetic analytics rows.
 */
import type { RetrievalBenchmarkQuery, RetrievalBenchmarkRequest } from '@compendiq/contracts';
import { logger } from '../../../core/utils/logger.js';
// One run-row lifecycle, shared with the #1260 shadow comparison: the two
// kinds hold ONE slot between them, and two private copies of these five
// statements is exactly how the stale sweep started reporting a comparison as
// a benchmark and the fetch started serving one kind's report to the other's
// renderer.
import {
  BenchmarkRunSlotBusyError,
  activeBenchmarkRun,
  claimBenchmarkRun,
  completeBenchmarkRun,
  failBenchmarkRun,
  fetchBenchmarkRun,
  insertBenchmarkRun,
  readQueuedConfig,
  recordBenchmarkProgress,
  type BenchmarkRunKind,
} from './benchmark-run-lifecycle.js';
import {
  hybridSearch,
  type SearchResult,
} from '../services/rag-service.js';
import { multiQuerySearch, type ExpansionOutcome } from '../services/multi-query-search.js';
import { sampleAnalyticsQueries } from './analytics-query-sampler.js';
// One definition, shared with the #1114 latency benchmark: two byte-identical
// copies of a percentile rule is how two "p95" figures in one repo stop
// meaning the same thing (review r2).
import { percentile, round } from './latency-stats.js';

export type ProductionBenchmarkStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ProductionBenchmarkRun {
  id: string;
  status: ProductionBenchmarkStatus;
  config: RetrievalBenchmarkRequest;
  progressDone: number;
  progressTotal: number;
  result: ProductionBenchmarkReport | null;
  error: string | null;
  createdAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
}

interface BenchmarkQuery extends RetrievalBenchmarkQuery {
  id: string;
}

interface VariantQueryResult {
  pageIds: number[];
  pages: Array<{ pageId: number; title: string; spaceKey: string | null }>;
  latencyMs: number;
}

export interface ProductionBenchmarkQueryResult {
  id: string;
  query: string;
  expectedPageIds?: number[];
  baseline: VariantQueryResult;
  deepSearch: VariantQueryResult & { expansion: 'expanded' | 'skipped' | 'unavailable' };
}

export interface ProductionBenchmarkVariantSummary {
  queryCount: number;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  emptyResultQueries: number;
  /** Present only when a query supplied expected page ids. */
  labeledQueryCount: number;
  recallAtK: Record<string, number> | null;
  mrr: number | null;
}

export interface ProductionBenchmarkReport {
  source: RetrievalBenchmarkRequest['source'];
  generatedAt: string;
  queryCount: number;
  topK: number;
  baseline: ProductionBenchmarkVariantSummary;
  deepSearch: ProductionBenchmarkVariantSummary & {
    expansionParticipatingQueries: number;
    expansionSkippedQueries: number;
    expansionUnavailableQueries: number;
  };
  paired: {
    top1ChangedQueries: number;
    topKChangedQueries: number;
    averageTopKOverlap: number;
    deepOnlyPagesAtK: number;
    baselineOnlyPagesAtK: number;
  };
  queries: ProductionBenchmarkQueryResult[];
}

/**
 * Re-exported under its historical name: the slot is SHARED with the #1260
 * shadow comparison, so the error is the lifecycle module's, and `kind` names
 * the holder. The default message stays the benchmark sentence — it is what
 * the benchmark POST answers, per the #1260 owner decision that the benchmark
 * direction keeps its wording; the compare route words its own 409 by `kind`.
 */
export { BenchmarkRunSlotBusyError as ProductionBenchmarkAlreadyRunningError };

/**
 * The run holding the shared one-active slot, if any. Deliberately NOT
 * scoped by kind — a #1260 shadow comparison and the production benchmark
 * exclude each other because both spend the shared LLM queue — but `kind`
 * is reported so each route can name what is actually running in its 409.
 */
export async function getActiveProductionBenchmark(): Promise<{
  id: string;
  kind: BenchmarkRunKind;
} | null> {
  return activeBenchmarkRun();
}

export async function createProductionBenchmarkRun(
  requestedBy: string,
  config: RetrievalBenchmarkRequest,
): Promise<string> {
  return insertBenchmarkRun(requestedBy, config);
}

/**
 * A production-benchmark run and NOTHING else. The kind argument is what
 * stops this surface serving a shadow comparison — whose report has no
 * `baseline`, so `BenchmarkSummary` throws on it and blanks the Retrieval
 * panel — and whose `queries[]` carries sampled production query text.
 */
export async function getProductionBenchmarkRun(id: string): Promise<ProductionBenchmarkRun | null> {
  return fetchBenchmarkRun<RetrievalBenchmarkRequest, ProductionBenchmarkReport>(id, null);
}

export async function runProductionBenchmark(id: string, userId: string): Promise<void> {
  try {
    // Keep the claim path inside the failure handler. If the process dies
    // after insertion but before this transition, the heartbeat recovery in
    // getActiveProductionBenchmark() will release the queued row later.
    const config = await readQueuedConfig<RetrievalBenchmarkRequest>(id);
    if (!config) return;

    const claimed = await claimBenchmarkRun(
      id,
      config.source === 'custom' ? config.queries?.length ?? 0 : config.limit,
    );
    if (!claimed) return;

    const queries = await resolveBenchmarkQueries(config);
    await recordBenchmarkProgress(id, 0, queries.length);

    if (queries.length === 0) {
      throw new Error('No production queries were available in the selected period');
    }

    const report = await executeBenchmark(queries, userId, config, async (done) => {
      await recordBenchmarkProgress(id, done);
    });

    await completeBenchmarkRun(id, report);
  } catch (err) {
    logger.error({ err, benchmarkRunId: id }, 'Production retrieval benchmark failed');
    await failBenchmarkRun(id, publicErrorMessage(err)).catch((updateErr) =>
      logger.error({ err: updateErr, benchmarkRunId: id }, 'Failed to persist benchmark failure'),
    );
  }
}

async function resolveBenchmarkQueries(config: RetrievalBenchmarkRequest): Promise<BenchmarkQuery[]> {
  if (config.source === 'custom') {
    return (config.queries ?? []).map((item, index) => ({
      ...item,
      id: item.id ?? `custom-${index + 1}`,
    }));
  }

  // Deliberately RECENCY-ordered — this benchmark reports on what people ask
  // now. The shadow comparison (#1260) shares the sampler with
  // `orderBy: 'frequency'` instead; only the ORDER differs.
  const queries = await sampleAnalyticsQueries({
    days: config.days,
    limit: config.limit,
    orderBy: 'recency',
  });
  return queries.map((text, index) => ({
    id: `recent-${index + 1}`,
    query: text,
  }));
}

async function executeBenchmark(
  queries: BenchmarkQuery[],
  userId: string,
  config: RetrievalBenchmarkRequest,
  onProgress: (done: number) => Promise<void>,
): Promise<ProductionBenchmarkReport> {
  const rows: ProductionBenchmarkQueryResult[] = [];
  let done = 0;

  for (const item of queries) {
    let expansion: 'expanded' | 'skipped' | 'unavailable' = 'unavailable';
    const baseline = await timedSearch(() => hybridSearch(userId, item.query, config.topK, undefined, {
      rerank: true,
      assembleContext: true,
      pinIdentifiers: true,
      recordAnalytics: false,
    }));
    const deepSearch = await timedSearch(() => multiQuerySearch(userId, item.query, config.topK, undefined, {
      rerank: true,
      assembleContext: true,
      pinIdentifiers: true,
      recordAnalytics: false,
      onExpansion: (outcome: ExpansionOutcome) => {
        expansion = outcome.expanded ? 'expanded' : outcome.reason === 'unavailable' ? 'unavailable' : 'skipped';
      },
    }));

    rows.push({
      id: item.id,
      query: item.query,
      ...(item.expectedPageIds ? { expectedPageIds: item.expectedPageIds } : {}),
      baseline,
      deepSearch: { ...deepSearch, expansion },
    });
    done++;
    await onProgress(done);
  }

  return buildReport(rows, config.source, config.topK);
}

async function timedSearch(search: () => Promise<SearchResult[]>): Promise<VariantQueryResult> {
  const started = performance.now();
  const results = await search();
  return {
    pageIds: results.map((item) => item.pageId),
    pages: results.map((item) => ({
      pageId: item.pageId,
      title: item.pageTitle,
      spaceKey: item.spaceKey,
    })),
    latencyMs: roundMs(performance.now() - started),
  };
}

export function buildReport(
  rows: ProductionBenchmarkQueryResult[],
  source: RetrievalBenchmarkRequest['source'],
  topK: number,
): ProductionBenchmarkReport {
  const baseline = summarizeVariant(rows, 'baseline', topK);
  const deepSearch = summarizeVariant(rows, 'deepSearch', topK);
  const expansionParticipatingQueries = rows.filter((row) => row.deepSearch.expansion === 'expanded').length;
  const expansionSkippedQueries = rows.filter((row) => row.deepSearch.expansion === 'skipped').length;
  const expansionUnavailableQueries = rows.filter((row) => row.deepSearch.expansion === 'unavailable').length;

  let top1ChangedQueries = 0;
  let topKChangedQueries = 0;
  let overlapTotal = 0;
  let deepOnlyPagesAtK = 0;
  let baselineOnlyPagesAtK = 0;
  for (const row of rows) {
    if (row.baseline.pageIds[0] !== row.deepSearch.pageIds[0]) top1ChangedQueries++;
    const base = new Set(row.baseline.pageIds.slice(0, topK));
    const deep = new Set(row.deepSearch.pageIds.slice(0, topK));
    if (!sameIds(base, deep)) topKChangedQueries++;
    const union = new Set([...base, ...deep]);
    overlapTotal += union.size === 0 ? 1 : intersectionSize(base, deep) / union.size;
    deepOnlyPagesAtK += [...deep].filter((id) => !base.has(id)).length;
    baselineOnlyPagesAtK += [...base].filter((id) => !deep.has(id)).length;
  }

  return {
    source,
    generatedAt: new Date().toISOString(),
    queryCount: rows.length,
    topK,
    baseline,
    deepSearch: {
      ...deepSearch,
      expansionParticipatingQueries,
      expansionSkippedQueries,
      expansionUnavailableQueries,
    },
    paired: {
      top1ChangedQueries,
      topKChangedQueries,
      averageTopKOverlap: rows.length === 0 ? 0 : round(overlapTotal / rows.length),
      deepOnlyPagesAtK,
      baselineOnlyPagesAtK,
    },
    // Keep the page ids and titles so an admin can inspect what moved. Do not
    // persist chunk text: the benchmark is a ranking report, not an export.
    queries: rows,
  };
}

function summarizeVariant(
  rows: ProductionBenchmarkQueryResult[],
  key: 'baseline' | 'deepSearch',
  topK: number,
): ProductionBenchmarkVariantSummary {
  const values = rows.map((row) => row[key]);
  const labeledRows = rows.filter((row) => row.expectedPageIds && row.expectedPageIds.length > 0);
  const recallRuns = labeledRows.map((row) => ({
    retrieved: row[key].pageIds,
    expected: row.expectedPageIds!,
  }));
  return {
    queryCount: rows.length,
    averageLatencyMs: average(values.map((value) => value.latencyMs)),
    p50LatencyMs: percentile(values.map((value) => value.latencyMs), 0.5),
    p95LatencyMs: percentile(values.map((value) => value.latencyMs), 0.95),
    emptyResultQueries: values.filter((value) => value.pageIds.length === 0).length,
    labeledQueryCount: labeledRows.length,
    recallAtK: labeledRows.length === 0 ? null : Object.fromEntries(
      [1, 3, 5, 10].filter((k) => k <= topK).map((k) => [`@${k}`, recallAtK(recallRuns, k)]),
    ),
    mrr: labeledRows.length === 0 ? null : meanReciprocalRank(recallRuns),
  };
}

function recallAtK(runs: Array<{ retrieved: number[]; expected: number[] }>, k: number): number {
  if (runs.length === 0) return 0;
  return runs.reduce((sum, run) => {
    const retrieved = new Set(run.retrieved.slice(0, k));
    const expected = new Set(run.expected);
    return sum + [...expected].filter((id) => retrieved.has(id)).length / expected.size;
  }, 0) / runs.length;
}

function meanReciprocalRank(runs: Array<{ retrieved: number[]; expected: number[] }>): number {
  if (runs.length === 0) return 0;
  return runs.reduce((sum, run) => {
    const expected = new Set(run.expected);
    const rank = run.retrieved.findIndex((id) => expected.has(id));
    return sum + (rank < 0 ? 0 : 1 / (rank + 1));
  }, 0) / runs.length;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function roundMs(value: number): number {
  return round(value);
}

function sameIds(a: Set<number>, b: Set<number>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

function intersectionSize(a: Set<number>, b: Set<number>): number {
  return [...a].filter((id) => b.has(id)).length;
}

function publicErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message === 'No production queries were available in the selected period') {
    return err.message;
  }
  return 'The benchmark could not complete. Check the provider and embedding configuration, then try again.';
}
