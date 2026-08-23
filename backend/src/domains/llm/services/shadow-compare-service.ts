/**
 * #1260 — compare the shadow candidate embedding model against the live one
 * on REAL queries, during the #1116 window in which both models' vectors
 * exist on the same chunk rows.
 *
 * Mode 1 (this run): sample the most frequent `search_analytics` queries,
 * embed each once per model — candidate via `getActiveShadowTarget()`, live
 * via `resolveUsecase('embedding')`, #1329/#1114 instruction prefix applied
 * PER MODEL — retrieve top-K pages from `embedding` and `embedding_next`
 * through the same `vectorSearch` probe, and report where they disagree.
 * That is an AGREEMENT statement, never a quality one: without labels the run
 * can say how much retrieval would move, not which side is right.
 *
 * The retrieval arm is the pure VECTOR LEG per column, page-denominated —
 * the cleanest model signal, and literally what the issue asks for. It is
 * NOT what users see after keyword fusion and rerank; every surface showing
 * these numbers says so.
 *
 * Run records reuse `retrieval_benchmark_runs` (091/092) with
 * `config.kind = 'shadow-compare'`: same status machine, same one-active
 * partial unique index (a compare and a production benchmark deliberately
 * exclude each other — both spend the shared LLM queue), same 30-minute
 * heartbeat recovery, which is why every per-query progress write also
 * touches `last_heartbeat_at`.
 *
 * Never calls `enqueueReembedAll`, never writes `llm_usecase_assignments` or
 * `admin_settings`. Queries and titles are real user data: admin-only routes,
 * page ids + titles only in the result (no chunk text), nothing logged raw.
 */
import { createHash } from 'node:crypto';
import type { ShadowCompareRequest, ShadowCompareJudgementSide } from '@compendiq/contracts';
import { query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';
import { resolveUsecase } from './llm-provider-resolver.js';
import { generateEmbedding } from './openai-compatible-client.js';
import { formatQueryForEmbedding } from './query-instruction.js';
import { vectorSearch, type SearchResult } from './rag-service.js';
import {
  getShadowMigrationState,
  getShadowMigrationStatus,
  getActiveShadowTarget,
  shadowStateFingerprint,
} from './shadow-migration-service.js';
import { sampleAnalyticsQueries } from '../eval/analytics-query-sampler.js';
import {
  jaccardOverlap,
  rankBiasedOverlap,
  summarizeAgreement,
  top1Changed,
  type AgreementSummary,
} from '../eval/agreement-metrics.js';
import {
  getActiveProductionBenchmark,
  ProductionBenchmarkAlreadyRunningError,
} from '../eval/production-benchmark.js';
import {
  meanReciprocalRank,
  pairedSignificance,
  recallAtK,
  type QueryRun,
} from '../eval/metrics.js';

export type ShadowCompareStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ShadowCompareConfig extends ShadowCompareRequest {
  kind: 'shadow-compare';
}

interface ComparedPages {
  pageIds: number[];
  pages: Array<{ pageId: number; title: string; spaceKey: string | null }>;
}

export interface ShadowCompareQueryResult {
  id: string;
  query: string;
  live: ComparedPages;
  candidate: ComparedPages;
  top1Changed: boolean;
  jaccard: number;
  rbo: number;
}

export interface ShadowCompareReport {
  kind: 'shadow-compare';
  generatedAt: string;
  topK: number;
  queryCount: number;
  live: { providerId: string; model: string };
  candidate: { providerId: string; model: string };
  agreement: AgreementSummary;
  /** Page ids and titles only — never chunk text; this JSON is persisted. */
  queries: ShadowCompareQueryResult[];
}

export interface ShadowCompareRun {
  id: string;
  status: ShadowCompareStatus;
  config: ShadowCompareConfig;
  progressDone: number;
  progressTotal: number;
  result: ShadowCompareReport | null;
  error: string | null;
  createdAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
}

/**
 * The migration moved out from under a running comparison — a swap, abort or
 * rollback landed mid-run. Always a clean, admin-readable failure: the
 * message is app-authored and safe to persist as the run's error.
 */
export class ShadowCompareWindowError extends Error {}

const WINDOW_CLOSED_MSG =
  'The shadow migration is not in the ready window — the comparison needs a fully backfilled candidate column';
const WINDOW_MOVED_MSG =
  'The shadow migration changed while the comparison ran (swap, abort or rollback) — start a new comparison from the current migration';
const NO_QUERIES_MSG = 'No production queries were available in the selected period';

interface CompareRunRow {
  id: string;
  status: ShadowCompareStatus;
  config: ShadowCompareConfig;
  progress_done: number;
  progress_total: number;
  result: ShadowCompareReport | null;
  error: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}

export async function createShadowCompareRun(
  requestedBy: string,
  config: ShadowCompareConfig,
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
    // The 091 one-active partial unique index is the cross-request guard,
    // shared with the production benchmark on purpose: both runs spend the
    // same LLM queue, so one at a time is the point, not a limitation.
    if ((err as { code?: unknown })?.code === '23505') {
      const active = await getActiveProductionBenchmark();
      if (active) throw new ProductionBenchmarkAlreadyRunningError(active.id, active.kind);
    }
    throw err;
  }
}

/** Null for an unknown id AND for a run of another kind — the compare routes
 *  must not leak (or poll) production-benchmark runs through this surface. */
export async function getShadowCompareRun(id: string): Promise<ShadowCompareRun | null> {
  const result = await query<CompareRunRow>(
    `SELECT id, status, config, progress_done, progress_total, result, error,
            created_at, started_at, completed_at
     FROM retrieval_benchmark_runs WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row || (row.config as { kind?: string })?.kind !== 'shadow-compare') return null;
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

/**
 * The async worker behind `POST …/compare`. Failure handling mirrors
 * `runProductionBenchmark`: any throw marks the run failed with a public
 * message, and every progress write renews `last_heartbeat_at` so a killed
 * process is recovered by the 30-minute stale sweep rather than wedging the
 * one-active slot forever.
 */
export async function runShadowCompare(id: string, adminUserId: string): Promise<void> {
  try {
    const row = await query<Pick<CompareRunRow, 'config' | 'status'>>(
      `SELECT config, status FROM retrieval_benchmark_runs WHERE id = $1`,
      [id],
    );
    const config = row.rows[0]?.config;
    if (!config || config.kind !== 'shadow-compare' || row.rows[0]?.status !== 'queued') return;

    const claimed = await query(
      `UPDATE retrieval_benchmark_runs
       SET status = 'running', started_at = NOW(), progress_done = 0,
           progress_total = $2, error = NULL, last_heartbeat_at = NOW()
       WHERE id = $1 AND status = 'queued'`,
      [id, config.limit],
    );
    if (claimed.rowCount !== 1) return;

    const report = await executeShadowCompare(config, adminUserId, async (done, total) => {
      await query(
        `UPDATE retrieval_benchmark_runs
         SET progress_done = $2, progress_total = $3, last_heartbeat_at = NOW()
         WHERE id = $1`,
        [id, done, total],
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
    // Counts only — the sampled queries are real user data and must not
    // reach the log through an error object's context.
    logger.error({ err, compareRunId: id }, 'Shadow embedding comparison failed');
    await query(
      `UPDATE retrieval_benchmark_runs
       SET status = 'failed', error = $2, completed_at = NOW(), last_heartbeat_at = NOW()
       WHERE id = $1`,
      [id, publicErrorMessage(err)],
    ).catch((updateErr) =>
      logger.error({ err: updateErr, compareRunId: id }, 'Failed to persist comparison failure'),
    );
  }
}

async function executeShadowCompare(
  config: ShadowCompareConfig,
  adminUserId: string,
  onProgress: (done: number, total: number) => Promise<void>,
): Promise<ShadowCompareReport> {
  // Re-verify the window HERE, not only at the route: this runs detached,
  // and the route's check is stale by the time the worker claims the row.
  const status = await getShadowMigrationStatus();
  if (!status || status.status !== 'active' || status.phase !== 'ready') {
    throw new ShadowCompareWindowError(WINDOW_CLOSED_MSG);
  }
  const fingerprint = shadowStateFingerprint(status);

  const target = await getActiveShadowTarget();
  if (!target) throw new ShadowCompareWindowError(WINDOW_CLOSED_MSG);
  const live = await resolveUsecase('embedding');

  const queries = await sampleAnalyticsQueries({
    days: config.days,
    limit: config.limit,
    orderBy: 'frequency',
  });
  if (queries.length === 0) throw new Error(NO_QUERIES_MSG);
  await onProgress(0, queries.length);

  const rows: ShadowCompareQueryResult[] = [];
  let done = 0;
  for (const text of queries) {
    // Re-read the migration fingerprint per query: a swap/abort/rollback
    // landing mid-run must become a clean failure, and catching it here is
    // cheaper and clearer than first tripping over a dropped column below.
    if (shadowStateFingerprint(await getShadowMigrationState()) !== fingerprint) {
      throw new ShadowCompareWindowError(WINDOW_MOVED_MSG);
    }

    let liveResults: SearchResult[];
    let candidateResults: SearchResult[];
    try {
      // Per-model query embedding, prefix included per model: Qwen3 is
      // instruction-aware and bge-m3 is not, and prefixing the wrong side
      // silently handicaps one arm (`query-instruction.test.ts` pins these
      // call sites). Two queue slots per query — the shared LLM queue and
      // per-provider breakers apply as for any outbound call.
      const [liveVector] = await generateEmbedding(
        live.config,
        live.model,
        formatQueryForEmbedding(live.model, text),
      );
      const [candidateVector] = await generateEmbedding(
        target.cfg,
        target.model,
        formatQueryForEmbedding(target.model, text),
      );
      if (!liveVector || !candidateVector) {
        throw new Error('The embedding provider answered without a vector');
      }
      // The same probe both times — SQL, ACL (`visiblePagesPredicate` scoped
      // to the requesting admin), ef_search — differing ONLY in the column.
      liveResults = await vectorSearch(adminUserId, liveVector, config.topK);
      candidateResults = await vectorSearch(adminUserId, candidateVector, config.topK, {
        column: 'embedding_next',
      });
    } catch (err) {
      // 42703 = undefined column: an abort dropped `embedding_next` after
      // this run's fingerprint check. Confirm against the state row so a
      // 42703 with the migration still standing stays the bug it would be.
      if (
        (err as { code?: string })?.code === '42703' &&
        shadowStateFingerprint(await getShadowMigrationState()) !== fingerprint
      ) {
        throw new ShadowCompareWindowError(WINDOW_MOVED_MSG);
      }
      throw err;
    }

    const livePages = topPages(liveResults, config.topK);
    const candidatePages = topPages(candidateResults, config.topK);
    rows.push({
      id: `query-${done + 1}`,
      query: text,
      live: livePages,
      candidate: candidatePages,
      top1Changed: top1Changed(livePages.pageIds, candidatePages.pageIds),
      jaccard: jaccardOverlap(livePages.pageIds, candidatePages.pageIds),
      rbo: rankBiasedOverlap(livePages.pageIds, candidatePages.pageIds),
    });
    done++;
    await onProgress(done, queries.length);
  }

  return {
    kind: 'shadow-compare',
    generatedAt: new Date().toISOString(),
    topK: config.topK,
    queryCount: rows.length,
    live: { providerId: live.config.providerId, model: live.model },
    candidate: { providerId: target.cfg.providerId, model: target.model },
    agreement: summarizeAgreement(
      rows.map((row) => ({ live: row.live.pageIds, candidate: row.candidate.pageIds })),
    ),
    queries: rows,
  };
}

/** Chunk rows → distinct pages in rank order, capped at topK. Page ids and
 *  titles only: the persisted result must carry no chunk text. */
function topPages(results: SearchResult[], topK: number): ComparedPages {
  const seen = new Set<number>();
  const pages: ComparedPages['pages'] = [];
  for (const row of results) {
    if (seen.has(row.pageId)) continue;
    seen.add(row.pageId);
    pages.push({ pageId: row.pageId, title: row.pageTitle, spaceKey: row.spaceKey });
    if (pages.length >= topK) break;
  }
  return { pageIds: pages.map((page) => page.pageId), pages };
}

function publicErrorMessage(err: unknown): string {
  if (err instanceof ShadowCompareWindowError) return err.message;
  if (err instanceof Error && err.message === NO_QUERIES_MSG) return err.message;
  return 'The comparison could not complete. Check the provider and embedding configuration, then try again.';
}

// ── Mode 2 — side-by-side judgements ─────────────────────────────────────
//
// Where Mode 1 shows a disagreement, the admin can record which side
// answered better. Judgements live in `embedding_compare_judgements` (099),
// keyed by (normalised query hash, live model, candidate model) — NOT by
// run — so the fixture accumulates across runs and even across migrations of
// the same pair, and re-judging a query replaces its row instead of stacking
// votes.

/**
 * No p-value is quoted below this many judgements for the pair. McNemar is
 * exact at any N, but a p over a handful of clicks reads as a verdict the
 * evidence cannot carry — the issue's own bar.
 */
export const MIN_JUDGEMENTS_FOR_P = 20;

/**
 * Depth for the judged-top-page containment score: the contract's topK
 * ceiling, so it always covers the whole stored list.
 */
const JUDGEMENT_SCORE_DEPTH = 20;

export interface JudgedVerdict {
  /** Every judgement recorded for this model pair, all four sides. */
  judgementCount: number;
  liveBetter: number;
  candidateBetter: number;
  both: number;
  neither: number;
  /**
   * Sign test over the scored judgements ('live'/'candidate' picks only —
   * 'both' and 'neither' are declared ties). `pValue` is withheld (null,
   * significant false, direction 'none') below MIN_JUDGEMENTS_FOR_P. Null
   * when nothing has been scored at all.
   */
  mcnemar: {
    wins: number;
    losses: number;
    pValue: number | null;
    significant: boolean;
    direction: 'improvement' | 'regression' | 'none';
  } | null;
  /** Recall/MRR per side, expected = the judged-better side's TOP page. */
  recall: { live: number; candidate: number } | null;
  mrr: { live: number; candidate: number } | null;
  minJudgementsForP: number;
}

export interface ShadowCompareJudgementsView {
  /** run queryId → recorded side, for the queries of THIS run. */
  judgements: Record<string, ShadowCompareJudgementSide>;
  /** Computed over every stored judgement for the run's model pair. */
  verdict: JudgedVerdict;
}

/** The sampler's own dedup key: respellings converge on one judgement row. */
function queryHash(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
}

export async function recordShadowCompareJudgement(
  runId: string,
  queryId: string,
  side: ShadowCompareJudgementSide,
  judgedBy: string,
): Promise<ShadowCompareJudgementsView> {
  const { run, report } = await completedCompareRun(runId);
  const row = report.queries.find((item) => item.id === queryId);
  if (!row) throw new Error('Unknown query id for this comparison run');
  await query(
    `INSERT INTO embedding_compare_judgements
       (query_hash, query_text, live_provider_id, live_model, candidate_provider_id, candidate_model,
        judged_side, live_page_ids, candidate_page_ids, judged_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (query_hash, live_model, candidate_model)
     DO UPDATE SET judged_side = EXCLUDED.judged_side,
                   live_page_ids = EXCLUDED.live_page_ids,
                   candidate_page_ids = EXCLUDED.candidate_page_ids,
                   judged_by = EXCLUDED.judged_by,
                   created_at = NOW()`,
    [
      queryHash(row.query),
      row.query,
      report.live.providerId,
      report.live.model,
      report.candidate.providerId,
      report.candidate.model,
      side,
      row.live.pageIds,
      row.candidate.pageIds,
      judgedBy,
    ],
  );
  return judgementsForReport(run.id, report);
}

export async function getShadowCompareJudgements(runId: string): Promise<ShadowCompareJudgementsView> {
  const { run, report } = await completedCompareRun(runId);
  return judgementsForReport(run.id, report);
}

async function completedCompareRun(
  runId: string,
): Promise<{ run: ShadowCompareRun; report: ShadowCompareReport }> {
  const run = await getShadowCompareRun(runId);
  if (!run) throw new Error('Comparison run not found');
  if (run.status !== 'completed' || !run.result) {
    throw new Error('Comparison run has not completed — judgements attach to a finished run');
  }
  return { run, report: run.result };
}

interface JudgementRow {
  query_hash: string;
  judged_side: ShadowCompareJudgementSide;
  live_page_ids: number[];
  candidate_page_ids: number[];
}

async function judgementsForReport(
  _runId: string,
  report: ShadowCompareReport,
): Promise<ShadowCompareJudgementsView> {
  const stored = await query<JudgementRow>(
    `SELECT query_hash, judged_side, live_page_ids, candidate_page_ids
     FROM embedding_compare_judgements
     WHERE live_model = $1 AND candidate_model = $2`,
    [report.live.model, report.candidate.model],
  );
  const byHash = new Map(stored.rows.map((row) => [row.query_hash, row]));
  const judgements: Record<string, ShadowCompareJudgementSide> = {};
  for (const item of report.queries) {
    const hit = byHash.get(queryHash(item.query));
    if (hit) judgements[item.id] = hit.judged_side;
  }
  return { judgements, verdict: computeJudgedVerdict(stored.rows) };
}

/**
 * The verdict, from `metrics.ts` and nothing else. Expected set per scored
 * judgement = the judged-better side's TOP page: the winner contains its own
 * pick by construction, so a discordant pair exists exactly when the losing
 * side did not retrieve the page the human preferred — a conservative
 * reading (a preference between two lists that both contain the page counts
 * as a tie for McNemar, while MRR still sees the rank difference).
 */
function computeJudgedVerdict(rows: JudgementRow[]): JudgedVerdict {
  let liveBetter = 0;
  let candidateBetter = 0;
  let both = 0;
  let neither = 0;
  const baseline: QueryRun[] = [];
  const candidate: QueryRun[] = [];
  for (const row of rows) {
    if (row.judged_side === 'live') liveBetter++;
    else if (row.judged_side === 'candidate') candidateBetter++;
    else if (row.judged_side === 'both') both++;
    else neither++;
    if (row.judged_side !== 'live' && row.judged_side !== 'candidate') continue;
    const expectedTop =
      row.judged_side === 'live' ? row.live_page_ids[0] : row.candidate_page_ids[0];
    // A side judged better while showing nothing carries no page evidence.
    if (expectedTop === undefined) continue;
    baseline.push({ queryId: row.query_hash, retrieved: row.live_page_ids, expected: [expectedTop] });
    candidate.push({
      queryId: row.query_hash,
      retrieved: row.candidate_page_ids,
      expected: [expectedTop],
    });
  }

  const scored = baseline.length > 0;
  const significance = scored
    ? pairedSignificance(baseline, candidate, (run) => recallAtK([run], JUDGEMENT_SCORE_DEPTH))
    : null;
  const n = rows.length;
  const quoteP = significance !== null && n >= MIN_JUDGEMENTS_FOR_P;
  return {
    judgementCount: n,
    liveBetter,
    candidateBetter,
    both,
    neither,
    mcnemar: significance
      ? {
          wins: significance.wins,
          losses: significance.losses,
          pValue: quoteP ? significance.pValue : null,
          significant: quoteP ? significance.significant : false,
          direction: quoteP ? significance.direction : 'none',
        }
      : null,
    recall: scored
      ? {
          live: recallAtK(baseline, JUDGEMENT_SCORE_DEPTH),
          candidate: recallAtK(candidate, JUDGEMENT_SCORE_DEPTH),
        }
      : null,
    mrr: scored
      ? { live: meanReciprocalRank(baseline), candidate: meanReciprocalRank(candidate) }
      : null,
    minJudgementsForP: MIN_JUDGEMENTS_FOR_P,
  };
}
