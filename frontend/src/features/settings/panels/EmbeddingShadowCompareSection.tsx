import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
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

const inputClass =
  'w-20 rounded-md border border-border-interactive bg-background/50 px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value || min));
}

export function EmbeddingShadowCompareSection({ candidateModel }: Props) {
  const [days, setDays] = useState(30);
  const [limit, setLimit] = useState(50);
  const [topK, setTopK] = useState(10);
  const [runId, setRunId] = useState<string | null>(null);

  const { data: run } = useQuery<CompareRun>({
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
          disabled={start.isPending || running}
          className="nm-button-primary"
          data-testid="shadow-compare-start"
        >
          {start.isPending ? 'Starting…' : 'Run comparison'}
        </button>
      </div>

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
      {run?.status === 'completed' && run.result && <CompareResult report={run.result} />}
    </div>
  );
}

function CompareResult({ report }: { report: CompareReport }) {
  // Rank-only disagreements (same set, different order) count: the head
  // moving IS the movement an admin needs to read.
  const disagreements = report.queries.filter((row) => row.top1Changed || row.jaccard < 1);
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
            </li>
          ))}
        </ul>
      )}
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
