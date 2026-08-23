import { useCallback, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../../shared/lib/api';
import { cn } from '../../../shared/lib/cn';

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
 * A disagreement is a measurement, so the whole surface stays neutral; amber
 * appears only on a run that failed UNDER THIS ADMIN'S HAND (the failed-save
 * strip recipe). A failure adopted from an earlier sitting says the same
 * sentence quietly — it would otherwise re-render its strip on every fresh
 * mount until another comparison replaced it, and standing amber at rest is
 * how the reserved colour stops meaning anything. The poll matches the card's
 * own 5s cadence: this section and the card's status poll are two requests per
 * interval against the 20/min admin rate limit, so polling faster would starve
 * the card's own controls.
 *
 * The run id is NOT only component state. A tab switch, a route change or a
 * reload unmounts this section, and a comparison outlives all three: without
 * a way back the report, its disagreement list and the whole Mode 2 workflow
 * (twenty judgements across sittings) would be unreachable while the run
 * itself still held the one-active slot against a replacement. So the section
 * asks the server for this admin's most recent comparison on mount and
 * re-attaches to it — and the server answers only a run recorded against the
 * candidate pair that is live NOW, so an aborted migration's report can never
 * be presented inside the current migration's card.
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
  /** Both absent on a report written before per-query failure tolerance. */
  sampledQueryCount?: number;
  failedQueries?: number;
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
  /** The live/candidate picks — the only ones a p-value can come from. */
  scoredJudgementCount?: number;
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

/**
 * `Number.isFinite`, never a truthiness test: `value || min` treats a cleared
 * field (Number('') === 0) as "use the minimum" and REWRITES the input to it,
 * so the field can never be emptied to retype — backspacing 50 → '' gave 1,
 * and typing 25 after it gave 125 → clamped to the maximum, the opposite of
 * what was typed.
 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function EmbeddingShadowCompareSection({ candidateModel }: Props) {
  const queryClient = useQueryClient();
  const titleId = useId();
  // The fields hold the RAW string while the admin types; clamping happens on
  // blur and at submit, so a half-typed or empty field is never rewritten
  // under the caret.
  const [days, setDays] = useState('30');
  const [limit, setLimit] = useState('50');
  const [topK, setTopK] = useState('10');
  const [startedRunId, setStartedRunId] = useState<string | null>(null);

  // This admin's most recent comparison OF THE LIVE MIGRATION (the server
  // refuses a run recorded against another candidate pair) — the
  // re-attachment path after an unmount. A run started in this session wins
  // over it.
  //
  // `refetchOnMount: 'always'` is what makes that work for the two cases the
  // module header names (r1). The section unmounts on a Settings sub-tab
  // switch, the app's QueryClient keeps an unobserved entry for five minutes,
  // and `staleTime: Infinity` alone suppressed the refetch — so the FIRST
  // mount's `{ run: null }` was served to the second one, showing no run, no
  // progress and an enabled Run button that then 409s. Only a full reload (a
  // new QueryClient) recovered. `start.onSuccess` seeds the same entry, so
  // the remount re-attaches from cache without a round trip first.
  const {
    data: latest,
    isError: latestFailed,
    refetch: refetchLatest,
  } = useQuery<{ run: CompareRun | null }>({
    queryKey: ['shadow-compare-latest'],
    queryFn: () => apiFetch('/admin/embedding/shadow-migration/compare'),
    staleTime: Infinity,
    refetchOnMount: 'always',
  });
  const runId = startedRunId ?? latest?.run?.id ?? null;
  /** A run this session started, as opposed to one adopted on mount. The two
   *  get different treatment when something goes wrong: an in-session failure
   *  is news, a week-old one is history. */
  const startedHere = startedRunId !== null;

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

  // Judgement writes are SERIALISED, never dropped. One POST is in flight at
  // a time (two concurrent writes race in `setQueryData` and one view can
  // erase the other's row from the table), but a deliberate pick on another
  // row while one is saving is QUEUED rather than silently discarded — the
  // admin is working down twenty rows, and a swallowed click leaves them
  // believing a judgement exists that the verdict's N will never show. The
  // queue is keyed by queryId, so a change of mind about one row replaces its
  // pending write instead of stacking a second one.
  const queued = useRef(new Map<string, JudgementSide>());
  const inFlight = useRef<{ queryId: string; side: JudgementSide } | null>(null);
  // The pick is shown pressed the instant it is made, before the round trip,
  // so what the admin sees always matches what they clicked.
  const [optimistic, setOptimistic] = useState<Record<string, JudgementSide>>({});

  // `pump` is created before the mutation it drives (the mutation's own
  // `onSettled` drains the queue), so it reaches `mutate` through a ref
  // rather than closing over a binding declared below it.
  const mutateRef = useRef<(vars: { queryId: string; side: JudgementSide }) => void>(() => {});
  const pump = useCallback(() => {
    if (inFlight.current) return;
    const next = queued.current.entries().next();
    if (next.done) return;
    const [queryId, side] = next.value;
    queued.current.delete(queryId);
    inFlight.current = { queryId, side };
    mutateRef.current({ queryId, side });
  }, []);

  const judge = useMutation({
    mutationFn: ({ queryId, side }: { queryId: string; side: JudgementSide }) =>
      apiFetch<JudgementsView>(`/admin/embedding/shadow-migration/compare/${runId}/judgements`, {
        method: 'POST',
        body: JSON.stringify({ queryId, side }),
      }),
    onSuccess: (view, variables) => {
      queryClient.setQueryData(['shadow-compare-judgements', runId], view);
      setOptimistic((prev) => {
        // Keep the overlay when a newer pick for the same row is still queued
        // — dropping it would flash the row back to the superseded side.
        if (queued.current.has(variables.queryId)) return prev;
        if (view.judgements[variables.queryId] !== variables.side) return prev;
        const next = { ...prev };
        delete next[variables.queryId];
        return next;
      });
    },
    onError: (err, variables) => {
      setOptimistic((prev) => {
        if (queued.current.has(variables.queryId)) return prev;
        const next = { ...prev };
        delete next[variables.queryId];
        return next;
      });
      toast.error(err instanceof Error ? err.message : 'Could not record the judgement');
    },
    onSettled: () => {
      inFlight.current = null;
      pump();
    },
  });
  mutateRef.current = judge.mutate;

  const start = useMutation({
    mutationFn: () =>
      apiFetch<{ runId: string }>('/admin/embedding/shadow-migration/compare', {
        method: 'POST',
        body: JSON.stringify({
          days: clamp(Number(days), 1, 90),
          limit: clamp(Number(limit), 1, 100),
          topK: clamp(Number(topK), 1, 20),
        }),
      }),
    onSuccess: (data) => {
      setStartedRunId(data.runId);
      setOptimistic({});
      // Seed the lookup this section re-attaches through, or the cached
      // `{ run: null }` from this mount is what the next one reads back.
      queryClient.setQueryData<{ run: CompareRun | null }>(['shadow-compare-latest'], {
        run: {
          id: data.runId,
          status: 'queued',
          progressDone: 0,
          progressTotal: 0,
          result: null,
          error: null,
        },
      });
      toast.success('Comparison started');
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Could not start the comparison'),
  });

  const running = run?.status === 'queued' || run?.status === 'running';
  // A failed poll is a failure, not an idle section — but WHICH failure
  // depends on whose run it is (r1). A run this session 202'd may still be
  // live server-side, so Run stays disabled (a retry would just 409) and the
  // strip says what is unknown. A poll that fails on a run merely ADOPTED on
  // mount says nothing about the slot: that run may have finished last week,
  // and disabling the section's only action under "it may still be running"
  // leaves the admin unable to start a comparison at all. The server's own
  // 409 is the authority on the shared slot, so that case reports what could
  // not be loaded and leaves Run available.
  const pollUnavailable = startedHere && pollFailed;
  const adoptedRunUnreadable = !startedHere && runId !== null && pollFailed;

  const storedJudgements = judgementView?.judgements ?? {};
  const judgedSide = (queryId: string): JudgementSide | undefined =>
    optimistic[queryId] ?? storedJudgements[queryId];

  const onJudge = (queryId: string, side: JudgementSide) => {
    // A repeat of the side already shown for this row changes nothing — this
    // is the double-click, and the same-frame case the ref pair closes.
    if (judgedSide(queryId) === side && !queued.current.has(queryId)) return;
    setOptimistic((prev) => ({ ...prev, [queryId]: side }));
    queued.current.set(queryId, side);
    pump();
  };

  return (
    // A REGION with a real heading, not a bare div with a <p> for a title
    // (r2). This is the longest interactive block on the tab — a completed run
    // renders four judgement buttons per disagreeing query, up to the
    // hundred-query cap — and it sits above the use-case assignments, their
    // Save and the runtime-limits card in both tab order and reading order.
    // Every sibling settings block already does this (`ProviderListSection`,
    // the Retrieval tab's benchmark section this one is modelled on).
    <section
      aria-labelledby={titleId}
      className="mt-3 space-y-2 border-t border-border pt-3"
      data-testid="shadow-compare-section"
    >
      <h3 id={titleId} className="text-sm font-semibold">
        Compare on real queries
      </h3>
      <p className="text-xs text-muted-foreground" data-testid="shadow-compare-intro">
        Runs this deployment's most frequent recorded searches against the live index and the{' '}
        <b>{candidateModel}</b> shadow, and lists the queries where the two disagree. This measures
        agreement on the vector leg only — not answer quality, and not what users see after keyword
        fusion and rerank. Each run makes two embedding calls per query through the same queue that
        embeds live questions, so answers may be slower while it runs. It shares its single run slot
        with the production retrieval benchmark on the Retrieval tab; while either runs, the other
        reports &ldquo;already running&rdquo;.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span className="block">Look back (days)</span>
          <input
            type="number"
            min={1}
            max={90}
            value={days}
            onChange={(event) => setDays(event.target.value)}
            onBlur={() => setDays(String(clamp(Number(days), 1, 90)))}
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
            onChange={(event) => setLimit(event.target.value)}
            onBlur={() => setLimit(String(clamp(Number(limit), 1, 100)))}
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
            onChange={(event) => setTopK(event.target.value)}
            onBlur={() => setTopK(String(clamp(Number(topK), 1, 20)))}
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
      {latestFailed && (
        // A failed lookup is a failure, not "there is no earlier comparison":
        // absence would silently hide a finished report, its disagreement list
        // and an accumulated Mode 2 workflow, and a re-run costs another N x 2
        // provider calls. Muted rather than amber — nothing is wrong with the
        // migration, and this notice can appear on any mount.
        <MutedNotice testId="shadow-compare-latest-error" onRetry={() => void refetchLatest()}>
          Could not check whether an earlier comparison exists.
        </MutedNotice>
      )}
      {adoptedRunUnreadable && (
        <MutedNotice testId="shadow-compare-adopted-error" onRetry={() => void refetchRun()}>
          The last comparison could not be loaded.
        </MutedNotice>
      )}
      {run && running && (
        <p className="text-xs text-muted-foreground" data-testid="shadow-compare-progress">
          Comparison {run.status} · {run.progressDone}/{run.progressTotal || '?'} queries
        </p>
      )}
      {run?.status === 'failed' &&
        (startedHere ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-xs"
            data-testid="shadow-compare-error"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <p>{run.error ?? 'The comparison failed.'}</p>
          </div>
        ) : (
          // The same failure ADOPTED on mount is history, not news, and it
          // re-renders on every fresh mount until another comparison replaces
          // it. Standing amber at rest is what teaches an admin to ignore
          // amber, so the adopted case states the same sentence quietly
          // (r1); the run that failed under this admin's hand keeps the strip.
          <p
            className="text-xs text-muted-foreground"
            data-testid="shadow-compare-error-adopted"
          >
            Last comparison: {run.error ?? 'it failed.'}
          </p>
        ))}
      {run?.status === 'completed' && run.result && (
        <CompareResult
          report={run.result}
          judgedSide={judgedSide}
          savingQueryId={judge.isPending ? (judge.variables?.queryId ?? null) : null}
          verdict={judgementView?.verdict ?? null}
          onJudge={onJudge}
        />
      )}
    </section>
  );
}

/** A quiet "could not be read" line with the one action that can fix it.
 *  Muted, not amber: this is a failed READ of history, not a degraded
 *  migration, and it can appear on any mount. */
function MutedNotice({
  testId,
  onRetry,
  children,
}: {
  testId: string;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  return (
    <p role="status" className="text-xs text-muted-foreground" data-testid={testId}>
      {children}{' '}
      <button type="button" className="underline" onClick={onRetry}>
        Check again
      </button>
    </p>
  );
}

function CompareResult({
  report,
  judgedSide,
  savingQueryId,
  verdict,
  onJudge,
}: {
  report: CompareReport;
  judgedSide: (queryId: string) => JudgementSide | undefined;
  savingQueryId: string | null;
  verdict: JudgedVerdict | null;
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
  const failed = report.failedQueries ?? 0;
  const sampled = report.sampledQueryCount ?? report.queryCount + failed;
  const failedShare = sampled > 0 ? failed / sampled : 0;
  /** A fifth of the sample gone is where "annotated" stops being enough and
   *  the coverage of the figures has to read as part of the claim. */
  const heavilyThinned = failedShare >= 0.2;
  return (
    <div className="space-y-2" data-testid="shadow-compare-result">
      <p className="text-xs font-medium text-foreground" data-testid="shadow-compare-basis">
        Agreement between {report.live.model} (live) and {report.candidate.model} (candidate) on{' '}
        {report.queryCount} real queries — how much results would move, not which model is better.
      </p>
      {failed > 0 && (
        // A measurement about the run's own coverage, so it stays NEUTRAL like
        // the figures beside it (amber is reserved for a failed run — the lane
        // decision) — but it must be stated, or the denominator silently
        // shrinks and nobody knows the sample was thinned. The run may skip up
        // to half its sample, so the treatment is proportional to the claim
        // (r1): past a fifth skipped the sentence takes foreground weight and
        // quotes the share, because "25 of 50" read with the same emphasis as
        // "1 of 50" on a surface whose output is swap go/no-go evidence.
        <p
          className={cn(
            'text-xs',
            heavilyThinned ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}
          data-testid="shadow-compare-failed-queries"
        >
          {failed} of {sampled} sampled {failed === 1 ? 'query was' : 'queries were'} skipped after
          an embedding or retrieval failure ({Math.round(failedShare * 100)}%), and{' '}
          {failed === 1 ? 'is' : 'are'} not in the figures below.
        </p>
      )}
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
                judged={judgedSide(row.id)}
                saving={savingQueryId === row.id}
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
  // The countdown counts the SCORED picks, because that is what the server's
  // floor counts: quoting "24 of 20" beside a withheld p (24 judgements, six
  // of them picks) would read as a server bug rather than as the floor doing
  // its job.
  const scored = verdict.scoredJudgementCount ?? n;
  const quotesP = p !== null && p !== undefined && verdict.mcnemar !== null;
  return (
    <>
      <p className="text-xs text-muted-foreground" data-testid="shadow-compare-verdict">
        <span className="font-medium text-foreground">
          Judged: {n} {n === 1 ? 'judgement' : 'judgements'} for this model pair
        </span>{' '}
        — candidate better on {verdict.candidateBetter}, live better on {verdict.liveBetter}
        {verdict.both > 0 ? `, both good on ${verdict.both}` : ''}
        {verdict.neither > 0 ? `, neither on ${verdict.neither}` : ''}.{' '}
        {quotesP && verdict.mcnemar
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
            : `${scored} of ${verdict.minJudgementsForP} live-or-candidate picks before a p-value is quoted.`}
      </p>
      {/* The two quality figures the judgements actually buy. They come off
          the same scored picks as the p, so they appear with it and are
          withheld with it (r2) — publishing the quality half of a verdict the
          server has declined to state is the failure the floor exists to
          prevent. Both are computed against the judged-better side's TOP page
          rather than a labelled fixture, so the label says which page it
          means; NEUTRAL, because these are measurements, not states. */}
      {quotesP && verdict.recall && verdict.mrr && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="shadow-compare-verdict-metrics"
        >
          Recall of the judged page:{' '}
          <span className="font-medium text-foreground">
            live {verdict.recall.live.toFixed(2)} → candidate {verdict.recall.candidate.toFixed(2)}
          </span>{' '}
          · MRR:{' '}
          <span className="font-medium text-foreground">
            live {verdict.mrr.live.toFixed(2)} → candidate {verdict.mrr.candidate.toFixed(2)}
          </span>
        </p>
      )}
    </>
  );
}

function JudgementRow({
  query,
  judged,
  saving,
  onJudge,
}: {
  query: string;
  judged: JudgementSide | undefined;
  saving: boolean;
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
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
      <span id={captionId} className="text-xs text-muted-foreground">
        Which answered better?
      </span>
      {/* The segmented recipe, not a pressed `nm-button-ghost` (r1). A ghost
          button already carries `--color-border-interactive` and the
          foreground ink at REST, so a pressed rule adding both changed
          nothing, and its only real delta — `background: transparent` to
          `--color-background`, over the row's own `bg-background/40` — measured
          1.03:1 in Graphite and 1.02:1 in Paper, with the two states byte
          identical on hover and indistinguishable under `forced-colors`. The
          only feedback that a judgement registered was therefore invisible.
          This is what CLAUDE.md means by "selected is the neutral pressed
          recipe": `NewPagePage`'s track — a `bg-muted` ground, unselected
          siblings borderless and muted, the chosen one `nm-pill-active` (card
          fill + a 1px border + weight 500 + foreground ink). The border and
          the weight are signals the resting state does not already have, and
          both survive `forced-colors`. Still neutral, never Steel: four
          toggles lighting up the accent read as four primary buttons. */}
      <div
        role="group"
        aria-label={`Which answered better: ${query}`}
        // The row is saving, not unavailable: every button stays operable and
        // every click is recorded, so this announces work in progress rather
        // than claiming the control cannot be used.
        aria-busy={saving || undefined}
        className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted p-0.5"
      >
        {sides.map(({ side, label }) => (
          <button
            key={side}
            type="button"
            className={cn(
              'rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
              judged === side ? 'nm-pill-active' : 'text-muted-foreground hover:text-foreground',
            )}
            aria-pressed={judged === side}
            // The visible caption is what these four bare labels mean; without
            // it "Live" is the whole accessible name of twenty buttons.
            aria-describedby={captionId}
            // Never `disabled`, and never a no-op: Chromium drops focus to
            // <body> when the focused element is disabled, so a keyboard admin
            // judging twenty rows would re-Tab from the top of the panel after
            // every single pick (WCAG 2.4.3 — the same focus drop the sibling
            // card's cancelCleanupRef engineers around). Writes are serialised
            // and queued in the parent instead, so a deliberate pick on another
            // row mid-save is accepted rather than silently dropped.
            onClick={() => onJudge(side)}
          >
            {label}
          </button>
        ))}
      </div>
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
