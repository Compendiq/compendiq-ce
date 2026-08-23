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
 * `config.kind = 'shadow-compare'`, and the row lifecycle itself — insert,
 * claim, progress + heartbeat, complete, fail, the stale sweep and the
 * kind-guarded fetch — is `eval/benchmark-run-lifecycle.ts`, shared with the
 * production benchmark. It is deliberately NOT a second copy of those five
 * statements: the first cut was, and the copies diverged within one review
 * round (the sweep failed comparisons with benchmark wording; the benchmark's
 * fetch served comparisons).
 *
 * Never calls `enqueueReembedAll`, never writes `llm_usecase_assignments` or
 * `admin_settings`. Queries and titles are real user data: admin-only routes
 * SCOPED TO THE ADMIN WHO STARTED THE RUN (the report's page titles were
 * retrieved under that admin's own ACL), page ids + titles only in the result
 * (no chunk text), nothing logged raw.
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
  BenchmarkRunSlotBusyError,
  claimBenchmarkRun,
  completeBenchmarkRun,
  failBenchmarkRun,
  fetchBenchmarkRun,
  insertBenchmarkRun,
  latestBenchmarkRun,
  readQueuedConfig,
  recordBenchmarkProgress,
  type BenchmarkRunRecord,
} from '../eval/benchmark-run-lifecycle.js';
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
  /** Queries actually COMPARED — the denominator of every agreement figure. */
  queryCount: number;
  /** Queries the sampler returned, compared + failed. */
  sampledQueryCount: number;
  /**
   * Queries dropped because an embedding or retrieval call failed (a 429, an
   * opened breaker, a queue timeout). Reported rather than fatal: throwing
   * away 46 completed comparisons because query 47 hit a rate limit re-spends
   * the whole N x 2 embedding budget for one transient failure.
   */
  failedQueries: number;
  live: { providerId: string; model: string };
  candidate: { providerId: string; model: string };
  agreement: AgreementSummary;
  /** Page ids and titles only — never chunk text; this JSON is persisted. */
  queries: ShadowCompareQueryResult[];
}

export type ShadowCompareRun = BenchmarkRunRecord<ShadowCompareConfig, ShadowCompareReport>;

/**
 * The migration moved out from under a running comparison — a swap, abort or
 * rollback landed mid-run. Always a clean, admin-readable failure: the
 * message is app-authored and safe to persist as the run's error.
 */
export class ShadowCompareWindowError extends Error {}

/**
 * Too many queries failed for the remainder to describe the two models.
 * App-authored and echoed to the admin, like the window errors.
 */
export class ShadowCompareUnusableError extends Error {}

/** The Mode 2 refusals, as TYPES. The route maps them by `instanceof`: a
 *  regex over English prose turns a copy edit into a 500 (r-external). */
export class CompareRunNotFoundError extends Error {
  constructor() {
    super('Comparison run not found');
  }
}
export class CompareRunIncompleteError extends Error {
  constructor() {
    super('Comparison run has not completed — judgements attach to a finished run');
  }
}
export class UnknownCompareQueryError extends Error {
  constructor() {
    super('Unknown query id for this comparison run');
  }
}

const WINDOW_CLOSED_MSG =
  'The shadow migration is not in the ready window — the comparison needs a fully backfilled candidate column';
const WINDOW_MOVED_MSG =
  'The shadow migration changed while the comparison ran (swap, abort or rollback) — start a new comparison from the current migration';
const NO_QUERIES_MSG = 'No production queries were available in the selected period';

/**
 * Above this share of failed queries the remainder is not a comparison of the
 * two models but a sample of whichever queries happened to get through, so
 * the run fails instead of publishing it. Below it the run completes and
 * `failedQueries` is stated on the report and on the card.
 */
const MAX_FAILED_QUERY_SHARE = 0.5;

export async function createShadowCompareRun(
  requestedBy: string,
  config: ShadowCompareConfig,
): Promise<string> {
  // The 091 one-active partial unique index is the cross-request guard,
  // shared with the production benchmark on purpose: both runs spend the same
  // LLM queue, so one at a time is the point, not a limitation.
  return insertBenchmarkRun(requestedBy, config);
}

export { BenchmarkRunSlotBusyError };

/**
 * Null for an unknown id, for a run of another kind (the compare surface must
 * not serve or poll production-benchmark runs) AND for another admin's run:
 * the report's page titles came out of `visiblePagesPredicate` scoped to the
 * admin who started it, private standalone pages included, so an unscoped
 * read hands admin B titles only admin A can see.
 */
export async function getShadowCompareRun(
  id: string,
  requestedBy: string,
): Promise<ShadowCompareRun | null> {
  return fetchBenchmarkRun<ShadowCompareConfig, ShadowCompareReport>(
    id,
    'shadow-compare',
    requestedBy,
  );
}

/**
 * This admin's most recent comparison, in any status. The card's `runId` is
 * plain component state, so a tab switch, a route change or a reload loses
 * it — and with no way back the finished report, its disagreement list and
 * the whole Mode 2 workflow (twenty judgements across sittings) would be
 * unreachable while the slot the run holds refuses a replacement.
 */
export async function getLatestShadowCompareRun(
  requestedBy: string,
): Promise<ShadowCompareRun | null> {
  return latestBenchmarkRun<ShadowCompareConfig, ShadowCompareReport>(
    'shadow-compare',
    requestedBy,
  );
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
    const config = await readQueuedConfig<ShadowCompareConfig>(id);
    if (!config || config.kind !== 'shadow-compare') return;

    if (!(await claimBenchmarkRun(id, config.limit))) return;

    const report = await executeShadowCompare(config, adminUserId, async (done, total) => {
      await recordBenchmarkProgress(id, done, total);
    });

    await completeBenchmarkRun(id, report);
  } catch (err) {
    // Counts only — the sampled queries are real user data and must not
    // reach the log through an error object's context.
    logger.error({ err, compareRunId: id }, 'Shadow embedding comparison failed');
    await failBenchmarkRun(id, publicErrorMessage(err)).catch((updateErr) =>
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
  let failed = 0;
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
      // Anything else — a 429, an opened breaker, a shared-queue timeout —
      // costs THIS query, not the run. The comparisons already computed are
      // N x 2 provider calls that would otherwise be spent again.
      failed++;
      logger.warn(
        { err, failedQueries: failed, comparedQueries: rows.length },
        'Shadow comparison skipped a query after a retrieval failure',
      );
      done++;
      await onProgress(done, queries.length);
      continue;
    }

    const livePages = topPages(liveResults, config.topK);
    const candidatePages = topPages(candidateResults, config.topK);
    rows.push({
      id: `query-${rows.length + 1}`,
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

  if (failed > queries.length * MAX_FAILED_QUERY_SHARE) {
    throw new ShadowCompareUnusableError(
      `${failed} of ${queries.length} queries could not be embedded or retrieved, so the remainder does not describe the two models. Check the provider and try again.`,
    );
  }

  return {
    kind: 'shadow-compare',
    generatedAt: new Date().toISOString(),
    topK: config.topK,
    queryCount: rows.length,
    sampledQueryCount: queries.length,
    failedQueries: failed,
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
  if (err instanceof ShadowCompareWindowError || err instanceof ShadowCompareUnusableError) {
    return err.message;
  }
  if (err instanceof Error && err.message === NO_QUERIES_MSG) return err.message;
  return 'The comparison could not complete. Check the provider and embedding configuration, then try again.';
}

// ── Mode 2 — side-by-side judgements ─────────────────────────────────────
//
// Where Mode 1 shows a disagreement, the admin can record which side
// answered better. Judgements live in `embedding_compare_judgements` (099),
// keyed by (normalised query hash, live PAIR, candidate PAIR) — NOT by run —
// so the fixture accumulates across runs and even across migrations of the
// same pair, and re-judging a query replaces its row instead of stacking
// votes. The PROVIDER is half of each key: "the same model name behind a
// different provider" is a different index, so pooling those judgements would
// score one migration's evidence into another migration's verdict.

/**
 * No p-value is quoted below this many SCORED judgements for the pair.
 * McNemar is exact at any N, but a p over a handful of clicks reads as a
 * verdict the evidence cannot carry — the issue's own bar. Counted over the
 * live/candidate picks the test actually consumes, never over every stored
 * row: fourteen ties plus six picks is six clicks, and gating on twenty would
 * publish "significant, favouring the candidate" from them.
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
  /** The 'live'/'candidate' picks — the only ones the p-value is computed from. */
  scoredJudgementCount: number;
  liveBetter: number;
  candidateBetter: number;
  both: number;
  neither: number;
  /**
   * Sign test over the scored judgements ('live'/'candidate' picks only —
   * 'both' and 'neither' are declared ties). `pValue` is withheld (null,
   * significant false, direction 'none') below MIN_JUDGEMENTS_FOR_P SCORED
   * judgements. Null when nothing has been scored at all.
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
  const report = await completedCompareReport(runId, judgedBy);
  const row = report.queries.find((item) => item.id === queryId);
  if (!row) throw new UnknownCompareQueryError();
  await query(
    `INSERT INTO embedding_compare_judgements
       (query_hash, query_text, live_provider_id, live_model, candidate_provider_id, candidate_model,
        judged_side, live_page_ids, candidate_page_ids, judged_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (query_hash, live_provider_id, live_model, candidate_provider_id, candidate_model)
     DO UPDATE SET query_text = EXCLUDED.query_text,
                   judged_side = EXCLUDED.judged_side,
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
  return judgementsForReport(report);
}

export async function getShadowCompareJudgements(
  runId: string,
  requestedBy: string,
): Promise<ShadowCompareJudgementsView> {
  return judgementsForReport(await completedCompareReport(runId, requestedBy));
}

async function completedCompareReport(
  runId: string,
  requestedBy: string,
): Promise<ShadowCompareReport> {
  const run = await getShadowCompareRun(runId, requestedBy);
  if (!run) throw new CompareRunNotFoundError();
  if (run.status !== 'completed' || !run.result) throw new CompareRunIncompleteError();
  return run.result;
}

interface JudgementRow {
  query_hash: string;
  judged_side: ShadowCompareJudgementSide;
  live_page_ids: number[];
  candidate_page_ids: number[];
}

async function judgementsForReport(
  report: ShadowCompareReport,
): Promise<ShadowCompareJudgementsView> {
  // Both PAIRS, not both model names: 099's identity is the provider beside
  // the model, and reading by name alone would pool a different provider's
  // migration into this verdict — page-id arrays from a different index.
  const stored = await query<JudgementRow>(
    `SELECT query_hash, judged_side, live_page_ids, candidate_page_ids
     FROM embedding_compare_judgements
     WHERE live_provider_id = $1 AND live_model = $2
       AND candidate_provider_id = $3 AND candidate_model = $4`,
    [report.live.providerId, report.live.model, report.candidate.providerId, report.candidate.model],
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
    // Exhaustive by construction — the 099 CHECK constraint admits exactly
    // these four. An `else neither++` tail would silently count a fifth side
    // as a tie, which is the one bucket that changes no number and therefore
    // hides the bug (r-external).
    switch (row.judged_side) {
      case 'live':
        liveBetter++;
        break;
      case 'candidate':
        candidateBetter++;
        break;
      case 'both':
        both++;
        break;
      case 'neither':
        neither++;
        break;
      default:
        logger.warn(
          { judgedSide: row.judged_side },
          'Ignoring an embedding_compare_judgements row with an unrecognised side',
        );
        continue;
    }
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

  const scoredCount = baseline.length;
  const scored = scoredCount > 0;
  const significance = scored
    ? pairedSignificance(baseline, candidate, (run) => recallAtK([run], JUDGEMENT_SCORE_DEPTH))
    : null;
  // The floor counts the SCORED rows, never every stored row: ties consume no
  // McNemar cell, so gating on the total would quote a p computed from six
  // picks the moment fourteen ties sit beside them (r-external).
  const quoteP = significance !== null && scoredCount >= MIN_JUDGEMENTS_FOR_P;
  return {
    judgementCount: rows.length,
    scoredJudgementCount: scoredCount,
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
