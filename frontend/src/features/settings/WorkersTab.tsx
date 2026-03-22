import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Play, RotateCcw, AlertTriangle, CheckCircle, Clock, Loader2 } from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';

interface NormalizedStatus {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  skipped: number;
  total: number;
}

type StatusNormalizer = (data: Record<string, unknown>) => NormalizedStatus;

const normalizeQuality: StatusNormalizer = (d) => ({
  pending: Number(d.pendingPages ?? 0),
  processing: Number(d.analyzingPages ?? 0),
  completed: Number(d.analyzedPages ?? 0),
  failed: Number(d.failedPages ?? 0),
  skipped: Number(d.skippedPages ?? 0),
  total: Number(d.totalPages ?? 0),
});

const normalizeSummary: StatusNormalizer = (d) => ({
  pending: Number(d.pendingPages ?? 0),
  processing: Number(d.summarizingPages ?? 0),
  completed: Number(d.summarizedPages ?? 0),
  failed: Number(d.failedPages ?? 0),
  skipped: Number(d.skippedPages ?? 0),
  total: Number(d.totalPages ?? 0),
});

const normalizeEmbedding: StatusNormalizer = (d) => ({
  pending: Number(d.dirtyCount ?? d.pendingPages ?? 0),
  processing: Number(d.embeddingCount ?? 0),
  completed: Number(d.embeddedCount ?? d.embeddedPages ?? 0),
  failed: Number(d.failedCount ?? d.failedPages ?? 0),
  skipped: 0,
  total: Number(d.totalCount ?? d.totalPages ?? 0),
});

function useWorkerStatus(key: string, endpoint: string, normalize: StatusNormalizer) {
  return useQuery<NormalizedStatus>({
    queryKey: ['worker-status', key],
    queryFn: async () => {
      const raw = await apiFetch<Record<string, unknown>>(endpoint);
      return normalize(raw);
    },
    refetchInterval: 10_000,
  });
}

function useWorkerAction(endpoint: string, successMsg: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch(endpoint, { method: 'POST' }),
    onSuccess: () => {
      toast.success(successMsg);
      queryClient.invalidateQueries({ queryKey: ['worker-status'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Action failed'),
  });
}

function StatusPill({ count, label, icon: Icon, color }: {
  count: number;
  label: string;
  icon: typeof CheckCircle;
  color: string;
}) {
  if (count === 0) return null;
  return (
    <div className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ${color}`}>
      <Icon size={12} />
      <span>{count}</span>
      <span className="text-muted-foreground/60">{label}</span>
    </div>
  );
}

function WorkerCard({ title, statusKey, statusEndpoint, runEndpoint, rescanEndpoint, resetFailedEndpoint, normalize }: {
  title: string;
  statusKey: string;
  statusEndpoint: string;
  runEndpoint: string;
  rescanEndpoint: string;
  resetFailedEndpoint?: string;
  normalize: StatusNormalizer;
}) {
  const { data: status, isLoading } = useWorkerStatus(statusKey, statusEndpoint, normalize);
  const runNow = useWorkerAction(runEndpoint, `${title} batch triggered`);
  const rescan = useWorkerAction(rescanEndpoint, `${title} rescan started`);
  const resetFailed = resetFailedEndpoint
    ? useWorkerAction(resetFailedEndpoint, 'Failed items reset to pending')
    : null;

  return (
    <div className="glass-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => runNow.mutate()}
            disabled={runNow.isPending}
            className="flex items-center gap-1 rounded-lg bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
            title="Process pending items now"
          >
            {runNow.isPending ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            Run Now
          </button>
          <button
            onClick={() => {
              if (window.confirm(`Reset all pages for ${title.toLowerCase()} re-processing?`)) {
                rescan.mutate();
              }
            }}
            disabled={rescan.isPending}
            className="flex items-center gap-1 rounded-lg bg-foreground/5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-foreground/10 transition-colors disabled:opacity-50"
            title="Reset all pages to re-process"
          >
            {rescan.isPending ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
            Rescan All
          </button>
          {resetFailed && status && status.failed > 0 && (
            <button
              onClick={() => resetFailed.mutate()}
              disabled={resetFailed.isPending}
              className="flex items-center gap-1 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20 transition-colors disabled:opacity-50"
              title="Retry failed items"
            >
              {resetFailed.isPending ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
              Retry Failed
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="h-8 animate-pulse rounded-lg bg-foreground/5" />
      ) : status ? (
        <div className="flex flex-wrap gap-2">
          <StatusPill count={status.pending} label="Pending" icon={Clock} color="bg-amber-500/10 text-amber-600" />
          <StatusPill count={status.processing} label="Processing" icon={Loader2} color="bg-blue-500/10 text-blue-600" />
          <StatusPill count={status.completed} label="Done" icon={CheckCircle} color="bg-emerald-500/10 text-emerald-600" />
          <StatusPill count={status.skipped} label="Skipped" icon={Clock} color="bg-foreground/5 text-muted-foreground" />
          <StatusPill count={status.failed} label="Failed" icon={AlertTriangle} color="bg-destructive/10 text-destructive" />
        </div>
      ) : null}
    </div>
  );
}

export function WorkersTab() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Background Workers</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Monitor and manually trigger quality analysis, summary generation, and embedding processing.
        </p>
      </div>

      <WorkerCard
        title="Quality Analysis"
        statusKey="quality"
        statusEndpoint="/llm/quality-status"
        runEndpoint="/llm/quality-run-now"
        rescanEndpoint="/llm/quality-rescan"
        normalize={normalizeQuality}
      />

      <WorkerCard
        title="Summary Generation"
        statusKey="summary"
        statusEndpoint="/llm/summary-status"
        runEndpoint="/llm/summary-run-now"
        rescanEndpoint="/llm/summary-rescan"
        normalize={normalizeSummary}
      />

      <WorkerCard
        title="Embedding Processing"
        statusKey="embedding"
        statusEndpoint="/llm/embedding-status"
        runEndpoint="/llm/embedding-run-now"
        rescanEndpoint="/llm/embedding-rescan"
        resetFailedEndpoint="/llm/embedding-reset-failed"
        normalize={normalizeEmbedding}
      />
    </div>
  );
}
