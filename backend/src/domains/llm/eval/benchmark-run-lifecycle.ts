/**
 * The shared lifecycle of a `retrieval_benchmark_runs` row (091 + 092).
 *
 * TWO kinds of run live in this table and hold ONE slot between them: the
 * production retrieval benchmark (`config` carries no `kind`) and the #1260
 * shadow comparison (`config.kind = 'shadow-compare'`). They exclude each
 * other deliberately — both spend the shared LLM queue.
 *
 * Every statement that moves a run through queued → running → completed /
 * failed lives HERE, once. The comparison originally re-implemented all five
 * of them beside the benchmark's copies, and the two copies immediately
 * diverged in the two ways this module exists to make impossible:
 *
 *  - the stale sweep failed EVERY abandoned row with the benchmark's own
 *    wording, so a comparison killed by a pod restart told its admin to
 *    "start a new benchmark" — a run they never started, on another tab;
 *  - the fetch selected by id alone, so `GET /admin/retrieval-benchmark/:id`
 *    served a shadow-compare run (sampled production query text included) to
 *    a renderer that dereferences `report.baseline`.
 *
 * So `kind` is a parameter of the sweep's copy and a REQUIRED argument of the
 * fetch: a caller cannot read a row without saying which kind it expects.
 */
import { query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';

export type BenchmarkRunStatus = 'queued' | 'running' | 'completed' | 'failed';

/** `config->>'kind'` — null is the production benchmark, whose config carries none. */
export type BenchmarkRunKind = 'shadow-compare' | null;

export interface BenchmarkRunRecord<TConfig, TReport> {
  id: string;
  status: BenchmarkRunStatus;
  config: TConfig;
  progressDone: number;
  progressTotal: number;
  result: TReport | null;
  error: string | null;
  createdAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
}

/**
 * The 091 partial unique index refused the insert: another run already holds
 * the shared slot. `kind` names the HOLDER so each route can word its 409 by
 * what is actually running rather than by which route was asked.
 */
export class BenchmarkRunSlotBusyError extends Error {
  constructor(
    public readonly activeRunId: string,
    public readonly kind: BenchmarkRunKind = null,
  ) {
    super('A production retrieval benchmark is already running');
  }
}

const STALE_RUN_AFTER = '30 minutes';

/**
 * The stale-sweep copy, per kind. It is persisted as the run's `error` and
 * rendered verbatim by whichever card owns that kind, so it must name the
 * thing the admin actually started.
 */
const STALE_RUN_ERROR: Record<'shadow-compare' | 'benchmark', string> = {
  benchmark: 'The benchmark worker stopped before the run completed. Start a new benchmark.',
  'shadow-compare':
    'The comparison worker stopped before the run completed. Start a new comparison.',
};

export function staleRunError(kind: BenchmarkRunKind): string {
  return kind === 'shadow-compare' ? STALE_RUN_ERROR['shadow-compare'] : STALE_RUN_ERROR.benchmark;
}

/**
 * The 409 both routes send when the shared slot is taken, worded by the kind
 * of the run that actually HOLDS it — never by the route that was asked.
 *
 * It lives here, beside `staleRunError`, because both routes need it and a
 * route may not import another route (the `routes/llm` boundary). It used to
 * live in the compare route alone, so the exclusion was honest in one
 * direction and false in the other: a benchmark refused by a running
 * comparison was told "A production retrieval benchmark is already running" —
 * a run that did not exist, on the one surface an operator consults to find
 * out what is holding the slot. That the exclusion itself is acceptable, and
 * stated in both cards' copy, is the #1260 owner decision; wording it wrongly
 * is not part of that decision.
 */
export function slotBusyMessage(kind: BenchmarkRunKind): string {
  return kind === 'shadow-compare'
    ? 'A shadow model comparison is already running — wait for it to finish before starting another run'
    : 'A production retrieval benchmark is already running';
}

interface RunRow<TConfig, TReport> {
  id: string;
  status: BenchmarkRunStatus;
  config: TConfig;
  progress_done: number;
  progress_total: number;
  result: TReport | null;
  error: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}

function toRecord<TConfig, TReport>(row: RunRow<TConfig, TReport>): BenchmarkRunRecord<TConfig, TReport> {
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

function kindOf(config: unknown): BenchmarkRunKind {
  const kind = (config as { kind?: unknown } | null)?.kind;
  return kind === 'shadow-compare' ? 'shadow-compare' : null;
}

/**
 * Fail every run whose heartbeat has lapsed, each with its OWN kind's copy.
 * One statement, so the sweep cannot start reporting one kind as the other.
 */
export async function recoverStaleBenchmarkRuns(): Promise<void> {
  const result = await query<{ id: string; kind: string | null }>(
    `UPDATE retrieval_benchmark_runs
     SET status = 'failed',
         error = CASE WHEN config->>'kind' = 'shadow-compare' THEN $1 ELSE $2 END,
         completed_at = NOW(), last_heartbeat_at = NOW()
     WHERE status IN ('queued', 'running')
       AND last_heartbeat_at < NOW() - $3::interval
     RETURNING id, config->>'kind' AS kind`,
    [STALE_RUN_ERROR['shadow-compare'], STALE_RUN_ERROR.benchmark, STALE_RUN_AFTER],
  );
  if (result.rows.length > 0) {
    logger.warn(
      { runs: result.rows.map((row) => ({ id: row.id, kind: row.kind })) },
      'Recovered abandoned retrieval benchmark / shadow comparison runs',
    );
  }
}

/**
 * The run holding the shared slot, if any — after sweeping stale rows, which
 * is what keeps a killed worker from wedging the slot forever. Deliberately
 * NOT scoped by kind; `kind` is reported so the caller can name the holder.
 */
export async function activeBenchmarkRun(): Promise<{ id: string; kind: BenchmarkRunKind } | null> {
  await recoverStaleBenchmarkRuns();
  const result = await query<{ id: string; kind: string | null }>(
    `SELECT id, config->>'kind' AS kind FROM retrieval_benchmark_runs
     WHERE status IN ('queued', 'running')
     ORDER BY created_at ASC
     LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, kind: row.kind === 'shadow-compare' ? 'shadow-compare' : null };
}

/**
 * Insert a queued run. A 23505 from the one-active partial unique index
 * becomes `BenchmarkRunSlotBusyError` carrying the holder's id and kind — the
 * database constraint name never reaches a route.
 */
export async function insertBenchmarkRun(requestedBy: string, config: unknown): Promise<string> {
  try {
    const result = await query<{ id: string }>(
      `INSERT INTO retrieval_benchmark_runs (requested_by, status, config)
       VALUES ($1, 'queued', $2::jsonb)
       RETURNING id`,
      [requestedBy, JSON.stringify(config)],
    );
    return result.rows[0]!.id;
  } catch (err) {
    if (isUniqueActiveRunError(err)) {
      const active = await activeBenchmarkRun();
      if (active) throw new BenchmarkRunSlotBusyError(active.id, active.kind);
    }
    throw err;
  }
}

/**
 * Read one run, REFUSING a row of another kind — the argument is required
 * precisely so that a new surface cannot forget it and serve the other kind's
 * report to a renderer written for this one.
 *
 * `requestedBy`, when given, additionally scopes the read to the admin who
 * started the run. Reports carry page TITLES retrieved under that admin's own
 * ACL (`visiblePagesPredicate` admits their private standalone pages), so an
 * unscoped read hands admin B titles admin A can see and B cannot.
 */
export async function fetchBenchmarkRun<TConfig, TReport>(
  id: string,
  kind: BenchmarkRunKind,
  requestedBy?: string,
): Promise<BenchmarkRunRecord<TConfig, TReport> | null> {
  const result = await query<RunRow<TConfig, TReport>>(
    `SELECT id, status, config, progress_done, progress_total, result, error,
            created_at, started_at, completed_at
     FROM retrieval_benchmark_runs
     WHERE id = $1${requestedBy === undefined ? '' : ' AND requested_by = $2'}`,
    requestedBy === undefined ? [id] : [id, requestedBy],
  );
  const row = result.rows[0];
  if (!row || kindOf(row.config) !== kind) return null;
  return toRecord(row);
}

/**
 * The newest run of one kind started by this admin, whatever its status —
 * how a card that lost its `runId` (a tab switch, a reload) re-attaches to
 * its own in-flight run and to its finished report.
 *
 * `configContains` narrows the candidate set BEFORE the ordering, as a jsonb
 * containment predicate on `config` (a bind parameter — never interpolated).
 * That placement is the point (r2): a caller that filtered the single newest
 * row in JS instead discarded a perfectly good run whenever a NEWER run of the
 * same kind failed the filter, and the surface then re-spends the provider
 * calls that produced the report it already had.
 */
export async function latestBenchmarkRun<TConfig, TReport>(
  kind: BenchmarkRunKind,
  requestedBy: string,
  configContains?: Record<string, unknown>,
): Promise<BenchmarkRunRecord<TConfig, TReport> | null> {
  await recoverStaleBenchmarkRuns();
  const params: unknown[] = [requestedBy];
  if (configContains !== undefined) params.push(JSON.stringify(configContains));
  const result = await query<RunRow<TConfig, TReport>>(
    `SELECT id, status, config, progress_done, progress_total, result, error,
            created_at, started_at, completed_at
     FROM retrieval_benchmark_runs
     WHERE requested_by = $1
       AND ${kind === null ? "config->>'kind' IS NULL" : "config->>'kind' = 'shadow-compare'"}
       ${configContains === undefined ? '' : 'AND config @> $2::jsonb'}
     ORDER BY created_at DESC
     LIMIT 1`,
    params,
  );
  const row = result.rows[0];
  if (!row) return null;
  return toRecord(row);
}

/** The queued config, or null when the row is gone / already claimed. */
export async function readQueuedConfig<TConfig>(id: string): Promise<TConfig | null> {
  const row = await query<{ config: TConfig; status: BenchmarkRunStatus }>(
    `SELECT config, status FROM retrieval_benchmark_runs WHERE id = $1`,
    [id],
  );
  const found = row.rows[0];
  if (!found || found.status !== 'queued') return null;
  return found.config;
}

/** Move queued → running. False when another worker won the claim. */
export async function claimBenchmarkRun(id: string, progressTotal: number): Promise<boolean> {
  const claimed = await query(
    `UPDATE retrieval_benchmark_runs
     SET status = 'running', started_at = NOW(), progress_done = 0,
         progress_total = $2, error = NULL, last_heartbeat_at = NOW()
     WHERE id = $1 AND status = 'queued'`,
    [id, progressTotal],
  );
  return claimed.rowCount === 1;
}

/**
 * Progress + heartbeat, always together: 092's `last_heartbeat_at` is what
 * keeps `recoverStaleBenchmarkRuns` from failing a run that is working fine.
 */
export async function recordBenchmarkProgress(
  id: string,
  done: number,
  total?: number,
): Promise<void> {
  if (total === undefined) {
    await query(
      `UPDATE retrieval_benchmark_runs
       SET progress_done = $2, last_heartbeat_at = NOW()
       WHERE id = $1`,
      [id, done],
    );
    return;
  }
  await query(
    `UPDATE retrieval_benchmark_runs
     SET progress_done = $2, progress_total = $3, last_heartbeat_at = NOW()
     WHERE id = $1`,
    [id, done, total],
  );
}

export async function completeBenchmarkRun(id: string, report: unknown): Promise<void> {
  await query(
    `UPDATE retrieval_benchmark_runs
     SET status = 'completed', progress_done = progress_total,
         result = $2::jsonb, completed_at = NOW(), last_heartbeat_at = NOW()
     WHERE id = $1`,
    [id, JSON.stringify(report)],
  );
}

export async function failBenchmarkRun(id: string, message: string): Promise<void> {
  await query(
    `UPDATE retrieval_benchmark_runs
     SET status = 'failed', error = $2, completed_at = NOW(), last_heartbeat_at = NOW()
     WHERE id = $1`,
    [id, message],
  );
}

function isUniqueActiveRunError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}
