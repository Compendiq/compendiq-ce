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
import { query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';
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

interface BenchmarkRunRow {
  id: string;
  status: ProductionBenchmarkStatus;
  config: RetrievalBenchmarkRequest;
  progress_done: number;
  progress_total: number;
  result: ProductionBenchmarkReport | null;
  error: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}

export class ProductionBenchmarkAlreadyRunningError extends Error {
  constructor(
    public readonly activeRunId: string,
    /**
     * `config->>'kind'` of the run holding the one-active slot — null for a
     * plain production benchmark, whose config carries no kind. The slot is
     * shared with the #1260 shadow comparison, and the compare route words
     * its 409 by what is actually running: toasting "a production retrieval
     * benchmark is already running" for the admin's own comparison names a
     * run that does not exist (r3). The message here stays the benchmark
     * sentence — it is what the benchmark POST answers, per the #1260 owner
     * decision that the benchmark direction keeps its wording.
     */
    public readonly kind: string | null = null,
  ) {
    super('A production retrieval benchmark is already running');
  }
}

const STALE_BENCHMARK_AFTER = '30 minutes';
const STALE_BENCHMARK_ERROR = 'The benchmark worker stopped before the run completed. Start a new benchmark.';

/**
 * The run holding the shared one-active slot, if any. Deliberately NOT
 * scoped by kind — a #1260 shadow comparison and the production benchmark
 * exclude each other because both spend the shared LLM queue — but `kind`
 * is reported so each route can name what is actually running in its 409.
 */
export async function getActiveProductionBenchmark(): Promise<{
  id: string;
  kind: string | null;
} | null> {
  await recoverStaleProductionBenchmarks();
  const result = await query<{ id: string; kind: string | null }>(
    `SELECT id, config->>'kind' AS kind FROM retrieval_benchmark_runs
     WHERE status IN ('queued', 'running')
     ORDER BY created_at ASC
     LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

async function recoverStaleProductionBenchmarks(): Promise<void> {
  const result = await query<{ id: string }>(
    `UPDATE retrieval_benchmark_runs
     SET status = 'failed', error = $1, completed_at = NOW(), last_heartbeat_at = NOW()
     WHERE status IN ('queued', 'running')
       AND last_heartbeat_at < NOW() - $2::interval
     RETURNING id`,
    [STALE_BENCHMARK_ERROR, STALE_BENCHMARK_AFTER],
  );
  if (result.rows.length > 0) {
    logger.warn(
      { benchmarkRunIds: result.rows.map((row) => row.id) },
      'Recovered abandoned production retrieval benchmark runs',
    );
  }
}

export async function createProductionBenchmarkRun(
  requestedBy: string,
  config: RetrievalBenchmarkRequest,
): Promise<string> {
  try {
    const result = await query<{ id: string }>(
      `INSERT INTO retrieval_benchmark_runs (requested_by, status, config)
       VALUES ($1, 'queued', $2::jsonb)
       RETURNING id`,
      [requestedBy, JSON.stringify(config)],
    );
    return result.rows[0]!.id;
  } catch (err) {
    // The partial unique index is the cross-request/replica guard. Keep the
    // route's response stable and do not expose a database constraint name.
    if (isUniqueActiveRunError(err)) {
      const active = await getActiveProductionBenchmark();
      if (active) throw new ProductionBenchmarkAlreadyRunningError(active.id, active.kind);
    }
    throw err;
  }
}

export async function getProductionBenchmarkRun(id: string): Promise<ProductionBenchmarkRun | null> {
  const result = await query<BenchmarkRunRow>(
    `SELECT id, status, config, progress_done, progress_total, result, error,
            created_at, started_at, completed_at
     FROM retrieval_benchmark_runs WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return toPublicRun(row);
}

export async function runProductionBenchmark(id: string, userId: string): Promise<void> {
  try {
    // Keep the claim path inside the failure handler. If the process dies
    // after insertion but before this transition, the heartbeat recovery in
    // getActiveProductionBenchmark() will release the queued row later.
    const row = await query<Pick<BenchmarkRunRow, 'config' | 'status'>>(
      `SELECT config, status FROM retrieval_benchmark_runs WHERE id = $1`,
      [id],
    );
    const config = row.rows[0]?.config;
    if (!config || row.rows[0]?.status !== 'queued') return;

    const claimed = await query(
      `UPDATE retrieval_benchmark_runs
       SET status = 'running', started_at = NOW(), progress_done = 0,
           progress_total = $2, error = NULL, last_heartbeat_at = NOW()
       WHERE id = $1 AND status = 'queued'`,
      [id, config.source === 'custom' ? config.queries?.length ?? 0 : config.limit],
    );
    if (claimed.rowCount !== 1) return;

    const queries = await resolveBenchmarkQueries(config);
    await query(
      `UPDATE retrieval_benchmark_runs
       SET progress_total = $2, last_heartbeat_at = NOW()
       WHERE id = $1`,
      [id, queries.length],
    );

    if (queries.length === 0) {
      throw new Error('No production queries were available in the selected period');
    }

    const report = await executeBenchmark(queries, userId, config, async (done) => {
      await query(
        `UPDATE retrieval_benchmark_runs
         SET progress_done = $2, last_heartbeat_at = NOW()
         WHERE id = $1`,
        [id, done],
      );
    });

    await query(
      `UPDATE retrieval_benchmark_runs
       SET status = 'completed', progress_done = progress_total,
           result = $2::jsonb, completed_at = NOW(), last_heartbeat_at = NOW()
       WHERE id = $1`,
      [id, JSON.stringify(report)],
    );
  } catch (err) {
    logger.error({ err, benchmarkRunId: id }, 'Production retrieval benchmark failed');
    await query(
      `UPDATE retrieval_benchmark_runs
       SET status = 'failed', error = $2, completed_at = NOW(), last_heartbeat_at = NOW()
       WHERE id = $1`,
      [id, publicErrorMessage(err)],
    ).catch((updateErr) => logger.error({ err: updateErr, benchmarkRunId: id }, 'Failed to persist benchmark failure'));
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

function toPublicRun(row: BenchmarkRunRow): ProductionBenchmarkRun {
  return {
    id: row.id,
    status: row.status,
    config: row.config,
    progressDone: row.progress_done,
    progressTotal: row.progress_total,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
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

function isUniqueActiveRunError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === '23505';
}

function publicErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message === 'No production queries were available in the selected period') {
    return err.message;
  }
  return 'The benchmark could not complete. Check the provider and embedding configuration, then try again.';
}
