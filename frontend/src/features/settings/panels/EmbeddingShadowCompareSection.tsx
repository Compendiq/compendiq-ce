import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../../shared/lib/api';

/**
 * #1260 — "Compare on real queries", inside the shadow card's `ready` branch.
 *
 * Mode 1 of the shadow comparison: run the deployment's most frequent
 * recorded searches against both columns and list where the two models
 * disagree. Everything on this surface is an AGREEMENT statement — the copy
 * says so at rest, and the result's basis line repeats it — because without
 * labels the run cannot say which side is right, only how much retrieval
 * would move.
 *
 * A disagreement is a measurement, so the whole surface stays neutral;
 * amber appears only on a FAILED run (the failed-save strip recipe). The
 * poll matches the card's own 5s cadence: this section and the card's
 * status poll are two requests per interval against the 20/min admin rate
 * limit, so polling faster would starve the card's own controls.
 */

interface Props {
  /** The migration's candidate model — names the shadow side before a report exists. */
  candidateModel: string;
}

interface ComparedPages {
  pageIds: number[];
  pages: Array<{ pageId: number; title: string; spaceKey: string | null }>;
}

interface CompareQueryRow {
  id: string;
  query: string;
  live: ComparedPages;
  candidate: ComparedPages;
  top1Changed: boolean;
  jaccard: number;
  rbo: number;
}

interface CompareReport {
  topK: number;
  queryCount: number;
  live: { providerId: string; model: string };
  candidate: { providerId: string; model: string };
  agreement: {
    queryCount: number;
    top1ChangedQueries: number;
    top1ChangeRate: number;
    meanJaccard: number;
    meanRbo: number;
    disagreementCount: number;
  };
  queries: CompareQueryRow[];
}

interface CompareRun {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progressDone: number;
  progressTotal: number;
  result: CompareReport | null;
  error: string | null;
}

type JudgementSide = 'live' | 'candidate' | 'neither' | 'both';

interface JudgedVerdict {
  judgementCount: number;
  liveBetter: number;
  candidateBetter: number;
  both: number;
  neither: number;
  mcnemar: {
    wins: number;
    losses: number;
    pValue: number | null;
    significant: boolean;
    direction: 'improvement' | 'regression' | 'none';
  } | null;
  recall: { live: number; candidate: number } | null;
  mrr: { live: number; candidate: number } | null;
  minJudgementsForP: number;
}

interface JudgementsView {
  judgements: Record<string, JudgementSide>;
  verdict: JudgedVerdict;
}

const inputClass =
  'w-20 rounded-md border border-border-interactive bg-background/50 px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value || min));
}

export function EmbeddingShadowCompareSection({ candidateModel }: Props) {
  const queryClient = useQueryClient();
  const [days, setDays] = useState(30);
  const [limit, setLimit] = useState(50);
  const [topK, setTopK] = useState(10);
  const [runId, setRunId] = useState<string | null>(null);

  const {
    data: run,
    isError: pollFailed,
    refetch: refetchRun,
  } = useQuery<CompareRun>({
    queryKey: ['shadow-compare', runId],
    queryFn: () => apiFetch(`/admin/embedding/shadow-migration/compare/${runId}`),
    enabled: runId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      // 5s, never faster: see the module header — two admin-rate-limited
      // polls share this card while a run is under way.
      return status === 'queued' || status === 'running' ? 5_000 : false;
    },
  });

  // Mode 2 — fetched once the run completes; every judgement POST answers the
  // refreshed view, which replaces this cache entry rather than refetching.
  const { data: judgementView } = useQuery<JudgementsView>({
    queryKey: ['shadow-compare-judgements', runId],
    queryFn: () => apiFetch(`/admin/embedding/shadow-migration/compare/${runId}/judgements`),
    enabled: runId !== null && run?.status === 'completed',
  });

  const judge = useMutation({
    mutationFn: ({ queryId, side }: { queryId: string; side: JudgementSide }) =>
      apiFetch<JudgementsView>(`/admin/embedding/shadow-migration/compare/${runId}/judgements`, {
        method: 'POST',
        body: JSON.stringify({ queryId, side }),
      }),
    onSuccess: (view) => {
      queryClient.setQueryData(['shadow-compare-judgements', runId], view);
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Could not record the judgement'),
  });

  const start = useMutation({
    mutationFn: () =>
      apiFetch<{ runId: string }>('/admin/embedding/shadow-migration/compare', {
        method: 'POST',
        body: JSON.stringify({ days, limit, topK }),
      }),
    onSuccess: (data) => {
      setRunId(data.runId);
      toast.success('Comparison started');
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Could not start the comparison'),
  });

  const running = run?.status === 'queued' || run?.status === 'running';
  // A failed poll is a failure, not an idle section: a 202'd run may still be
  // live server-side, so Run stays disabled (a retry would 409 with the
  // misleading "already running" toast) and the strip says what is unknown.
  const pollUnavailable = runId !== null && pollFailed;

  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3" data-testid="shadow-compare-section">
      <p className="text-sm font-medium">Compare on real queries</p>
      <p className="text-xs text-muted-foreground" data-testid="shadow-compare-intro">
        Runs this deployment's most frequent recorded searches against the live index and the{' '}
        <b>{candidateModel}</b> shadow, and lists the queries where the two disagree. This measures
        agreement on the vector leg only — not answer quality, and not what users see after keyword
        fusion and rerank. It shares its single run slot with the production retrieval benchmark on
        the Retrieval tab; while either runs, the other reports &ldquo;already running&rdquo;.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span className="block">Look back (days)</span>
          <input
            type="number"
            min={1}
            max={90}
            value={days}
            onChange={(event) => setDays(clamp(Number(event.target.value), 1, 90))}
            className={inputClass}
            data-testid="shadow-compare-days"
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span className="block">Queries</span>
          <input
            type="number"
            min={1}
            max={100}
            value={limit}
            onChange={(event) => setLimit(clamp(Number(event.target.value), 1, 100))}
            className={inputClass}
            data-testid="shadow-compare-limit"
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span className="block">Top K</span>
          <input
            type="number"
            min={1}
            max={20}
            value={topK}
            onChange={(event) => setTopK(clamp(Number(event.target.value), 1, 20))}
            className={inputClass}
            data-testid="shadow-compare-topk"
          />
        </label>
        <button
          type="button"
          onClick={() => start.mutate()}
          disabled={start.isPending || running || pollUnavailable}
          className="nm-button-primary"
          data-testid="shadow-compare-start"
        >
          {start.isPending ? 'Starting…' : 'Run comparison'}
        </button>
      </div>

      {pollUnavailable && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-xs"
          data-testid="shadow-compare-poll-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <p>
            The comparison was started, but its status could not be fetched — it may still be
            running.{' '}
            <button type="button" className="underline" onClick={() => void refetchRun()}>
              Check again
            </button>
          </p>
        </div>
      )}
      {run && running && (
        <p className="text-xs text-muted-foreground" data-testid="shadow-compare-progress">
          Comparison {run.status} · {run.progressDone}/{run.progressTotal || '?'} queries
        </p>
      )}
      {run?.status === 'failed' && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-xs"
          data-testid="shadow-compare-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <p>{run.error ?? 'The comparison failed.'}</p>
        </div>
      )}
      {run?.status === 'completed' && run.result && (
        <CompareResult
          report={run.result}
          judgements={judgementView?.judgements ?? {}}
          verdict={judgementView?.verdict ?? null}
          judging={judge.isPending}
          onJudge={(queryId, side) => judge.mutate({ queryId, side })}
        />
      )}
    </div>
  );
}

function CompareResult({
  report,
  judgements,
  verdict,
  judging,
  onJudge,
}: {
  report: CompareReport;
  judgements: Record<string, JudgementSide>;
  verdict: JudgedVerdict | null;
  judging: boolean;
  onJudge: (queryId: string, side: JudgementSide) => void;
}) {
  // ANY difference between the lists counts — head moved, sets differ, or the
  // same set in a different order (rbo < 1, which only RBO can see): drop a
  // disjunct and the list under-reports movement while the "full agreement"
  // sentence contradicts an RBO chip reading < 1.00. Mirrors
  // `summarizeAgreement`'s predicate; the two must stay in lockstep.
  const disagreements = report.queries.filter(
    (row) => row.top1Changed || row.jaccard < 1 || row.rbo < 1,
  );
  return (
    <div className="space-y-2" data-testid="shadow-compare-result">
      <p className="text-xs font-medium text-foreground" data-testid="shadow-compare-basis">
        Agreement between {report.live.model} (live) and {report.candidate.model} (candidate) on{' '}
        {report.queryCount} real queries — how much results would move, not which model is better.
      </p>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <CompareMetric
          label="Top result changed"
          value={`${report.agreement.top1ChangedQueries}/${report.queryCount} queries`}
        />
        <CompareMetric
          label={`Top-${report.topK} overlap (Jaccard)`}
          value={`${Math.round(report.agreement.meanJaccard * 100)}%`}
        />
        <CompareMetric label="Rank agreement (RBO)" value={report.agreement.meanRbo.toFixed(2)} />
        <CompareMetric
          label="Queries that disagree"
          value={`${report.agreement.disagreementCount}/${report.queryCount}`}
        />
      </div>
      {/* The zero-judgement prompt says "pick the better side on a
          disagreement below" — suppressed when no disagreement rows render,
          or it points at controls that do not exist. A pair with judgements
          accumulated from earlier runs keeps its verdict either way. */}
      {verdict && (verdict.judgementCount > 0 || disagreements.length > 0) && (
        <VerdictLine verdict={verdict} />
      )}
      {disagreements.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Both models returned the same pages in the same order for every sampled query.
        </p>
      ) : (
        <ul className="space-y-2">
          {disagreements.map((row) => (
            <li
              key={row.id}
              className="rounded-md border border-border bg-background/40 p-3"
              data-testid="shadow-compare-disagreement"
            >
              <p className="break-words text-xs font-medium text-foreground">{row.query}</p>
              <div className="mt-2 grid gap-3 text-xs sm:grid-cols-2">
                <ResultSide label={`Live · ${report.live.model}`} pages={row.live.pages} />
                <ResultSide
                  label={`Candidate · ${report.candidate.model}`}
                  pages={row.candidate.pages}
                />
              </div>
              <JudgementRow
                query={row.query}
                judged={judgements[row.id]}
                judging={judging}
                onJudge={(side) => onJudge(row.id, side)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The Mode 2 verdict line. It names its own basis (N judgements for this
 * model pair), and quotes McNemar's p ONLY when the server did — below the
 * floor it states how many judgements are still needed, because a p over a
 * handful of clicks reads as a verdict the evidence cannot carry.
 */
function VerdictLine({ verdict }: { verdict: JudgedVerdict }) {
  if (verdict.judgementCount === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="shadow-compare-verdict">
        No judgements yet for this model pair — pick the better side on a disagreement below to
        start building a judged verdict.
      </p>
    );
  }
  const n = verdict.judgementCount;
  const p = verdict.mcnemar?.pValue;
  return (
    <p className="text-xs text-muted-foreground" data-testid="shadow-compare-verdict">
      <span className="font-medium text-foreground">
        Judged: {n} {n === 1 ? 'judgement' : 'judgements'} for this model pair
      </span>{' '}
      — candidate better on {verdict.candidateBetter}, live better on {verdict.liveBetter}
      {verdict.both > 0 ? `, both good on ${verdict.both}` : ''}
      {verdict.neither > 0 ? `, neither on ${verdict.neither}` : ''}.{' '}
      {p !== null && p !== undefined && verdict.mcnemar
        ? `McNemar p = ${p < 0.001 ? '< 0.001' : p.toFixed(3)}${
            verdict.mcnemar.significant
              ? verdict.mcnemar.direction === 'improvement'
                ? ' — significant, favouring the candidate'
                : ' — significant, favouring the live model'
              : ' — not significant'
          }.`
        : verdict.mcnemar === null
          ? // All recorded judgements are 'both'/'neither': the server scored
            // nothing, so no amount of further ties reaches a p — counting
            // down "N of 20" here would misstate why no p is shown.
            'No live or candidate picks yet — ties alone cannot produce a p-value.'
          : `${n} of ${verdict.minJudgementsForP} judgements before a p-value is quoted.`}
    </p>
  );
}

function JudgementRow({
  query,
  judged,
  judging,
  onJudge,
}: {
  query: string;
  judged: JudgementSide | undefined;
  judging: boolean;
  onJudge: (side: JudgementSide) => void;
}) {
  const captionId = useId();
  const sides: Array<{ side: JudgementSide; label: string }> = [
    { side: 'live', label: 'Live' },
    { side: 'candidate', label: 'Candidate' },
    { side: 'neither', label: 'Neither' },
    { side: 'both', label: 'Both' },
  ];
  return (
    <div
      role="group"
      aria-label={`Which answered better: ${query}`}
      className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2"
    >
      <span id={captionId} className="text-xs text-muted-foreground">
        Which answered better?
      </span>
      {sides.map(({ side, label }) => (
        <button
          key={side}
          type="button"
          className="nm-button-ghost"
          aria-pressed={judged === side}
          // Never `disabled` while the POST is in flight: Chromium drops
          // focus to <body> when the focused element is disabled, so a
          // keyboard admin judging twenty rows would re-Tab from the top of
          // the panel after every single pick (WCAG 2.4.3 — the same focus
          // drop the sibling card's cancelCleanupRef engineers around).
          // Re-entry is guarded in the handler; `aria-disabled` announces
          // the momentary unavailability without removing focusability.
          aria-disabled={judging || undefined}
          onClick={() => {
            if (judging) return;
            onJudge(side);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function CompareMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background/40 px-3 py-2">
      <span>{label}: </span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

function ResultSide({
  label,
  pages,
}: {
  label: string;
  pages: Array<{ pageId: number; title: string; spaceKey: string | null }>;
}) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      {pages.length === 0 ? (
        <p className="mt-1 text-muted-foreground">No results</p>
      ) : (
        <ol className="mt-1 list-inside list-decimal space-y-0.5 text-foreground">
          {pages.map((page) => (
            <li key={page.pageId} className="break-words">
              {page.title}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
