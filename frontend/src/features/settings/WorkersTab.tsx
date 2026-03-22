import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Play, RotateCcw, AlertTriangle, CheckCircle, Clock, Loader2 } from 'lucide-react';
import { m, useReducedMotion } from 'framer-motion';
import { apiFetch } from '../../shared/lib/api';
import { AnimatedCounter } from '../../shared/components/effects/AnimatedCounter';
import { cn } from '../../shared/lib/cn';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NormalizedStatus {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  skipped: number;
  total: number;
  isProcessing: boolean;
  lastRunAt: string | null;
  intervalMinutes: number;
  model: string;
}

type StatusNormalizer = (data: Record<string, unknown>) => NormalizedStatus;

// ---------------------------------------------------------------------------
// Normalizers — map backend shapes to unified NormalizedStatus
// ---------------------------------------------------------------------------

const normalizeQuality: StatusNormalizer = (d) => ({
  pending: Number(d.pendingPages ?? 0),
  processing: Number(d.analyzingPages ?? 0),
  completed: Number(d.analyzedPages ?? 0),
  failed: Number(d.failedPages ?? 0),
  skipped: Number(d.skippedPages ?? 0),
  total: Number(d.totalPages ?? 0),
  isProcessing: Boolean(d.isProcessing),
  lastRunAt: (d.lastRunAt as string) ?? null,
  intervalMinutes: Number(d.intervalMinutes ?? 0),
  model: (d.model as string) ?? '',
});

const normalizeSummary: StatusNormalizer = (d) => ({
  pending: Number(d.pendingPages ?? 0),
  processing: Number(d.summarizingPages ?? 0),
  completed: Number(d.summarizedPages ?? 0),
  failed: Number(d.failedPages ?? 0),
  skipped: Number(d.skippedPages ?? 0),
  total: Number(d.totalPages ?? 0),
  isProcessing: Boolean(d.isProcessing),
  lastRunAt: (d.lastRunAt as string) ?? null,
  intervalMinutes: Number(d.intervalMinutes ?? 0),
  model: (d.model as string) ?? '',
});

const normalizeEmbedding: StatusNormalizer = (d) => ({
  pending: Number(d.dirtyPages ?? 0),
  processing: 0,
  completed: Number(d.embeddedPages ?? 0),
  failed: 0,
  skipped: 0,
  total: Number(d.totalPages ?? 0),
  isProcessing: Boolean(d.isProcessing),
  lastRunAt: (d.lastRunAt as string) ?? null,
  intervalMinutes: 0, // embedding is on-demand, no scheduled interval
  model: (d.model as string) ?? '',
});

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useWorkerStatus(key: string, endpoint: string, normalize: StatusNormalizer) {
  return useQuery<NormalizedStatus>({
    queryKey: ['worker-status', key],
    queryFn: async () => {
      const raw = await apiFetch<Record<string, unknown>>(endpoint);
      return normalize(raw);
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 5000;
      if (data.isProcessing || data.processing > 0) return 3000;
      if (data.pending > 0) return 10_000;
      return 30_000;
    },
    refetchIntervalInBackground: false,
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

// ---------------------------------------------------------------------------
// Relative time helper
// ---------------------------------------------------------------------------

function relativeTime(isoString: string | null): string {
  if (!isoString) return 'Never';
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 0) return 'Just now';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Status badge — Running / Idle / Queued / Error
// ---------------------------------------------------------------------------

type WorkerState = 'running' | 'queued' | 'idle' | 'error';

function deriveWorkerState(status: NormalizedStatus): WorkerState {
  if (status.isProcessing || status.processing > 0) return 'running';
  if (status.failed > 0 && status.pending === 0) return 'error';
  if (status.pending > 0) return 'queued';
  return 'idle';
}

const stateConfig: Record<WorkerState, { label: string; dotClass: string; textClass: string }> = {
  running: {
    label: 'Running',
    dotClass: 'bg-emerald-500 animate-pulse',
    textClass: 'text-emerald-600 dark:text-emerald-400',
  },
  queued: {
    label: 'Queued',
    dotClass: 'bg-amber-500',
    textClass: 'text-amber-600 dark:text-amber-400',
  },
  idle: {
    label: 'Idle',
    dotClass: 'bg-muted-foreground/40',
    textClass: 'text-muted-foreground',
  },
  error: {
    label: 'Error',
    dotClass: 'bg-destructive',
    textClass: 'text-destructive',
  },
};

function StatusBadge({ state }: { state: WorkerState }) {
  const cfg = stateConfig[state];
  return (
    <div className={cn('flex items-center gap-1.5 text-xs font-medium', cfg.textClass)} data-testid="worker-state-badge">
      <span className={cn('inline-block h-2 w-2 rounded-full', cfg.dotClass)} />
      {cfg.label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status pill with animated counter
// ---------------------------------------------------------------------------

function StatusPill({ count, label, icon: Icon, color }: {
  count: number;
  label: string;
  icon: typeof CheckCircle;
  color: string;
}) {
  if (count === 0) return null;
  return (
    <div className={cn('flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium', color)}>
      <Icon size={12} />
      <AnimatedCounter value={count} className="tabular-nums" />
      <span className="text-muted-foreground/60">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const shouldReduce = useReducedMotion();
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="flex items-center gap-3" data-testid="progress-bar">
      <div className="h-1.5 flex-1 rounded-full bg-foreground/10 overflow-hidden">
        <m.div
          className="h-full rounded-full bg-primary"
          animate={{ width: `${percentage}%` }}
          transition={shouldReduce ? { duration: 0 } : { type: 'spring', stiffness: 100, damping: 20 }}
        />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
        {percentage}%
        <span className="ml-1.5 text-muted-foreground/60">
          {completed} of {total}
        </span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Worker card
// ---------------------------------------------------------------------------

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

  const workerState = status ? deriveWorkerState(status) : 'idle';

  return (
    <div className="glass-card p-4 space-y-3" data-testid={`worker-card-${statusKey}`}>
      {/* Header: title, status badge, action buttons */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          {status && <StatusBadge state={workerState} />}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => runNow.mutate()}
            disabled={runNow.isPending}
            className="flex items-center gap-1 rounded-lg bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
            title="Process pending items now"
            data-testid={`${statusKey}-run-now`}
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
            data-testid={`${statusKey}-rescan`}
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
              data-testid={`${statusKey}-retry-failed`}
            >
              {resetFailed.isPending ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
              Retry Failed
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <div className="h-1.5 animate-pulse rounded-full bg-foreground/5" />
          <div className="h-8 animate-pulse rounded-lg bg-foreground/5" />
        </div>
      ) : status ? (
        <>
          {/* Progress bar */}
          <ProgressBar completed={status.completed} total={status.total} />

          {/* Status pills */}
          <div className="flex flex-wrap gap-2">
            <StatusPill count={status.pending} label="Pending" icon={Clock} color="bg-amber-500/10 text-amber-600 dark:text-amber-400" />
            <StatusPill count={status.processing} label="Processing" icon={Loader2} color="bg-blue-500/10 text-blue-600 dark:text-blue-400" />
            <StatusPill count={status.completed} label="Done" icon={CheckCircle} color="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" />
            <StatusPill count={status.skipped} label="Skipped" icon={Clock} color="bg-foreground/5 text-muted-foreground" />
            <StatusPill count={status.failed} label="Failed" icon={AlertTriangle} color="bg-destructive/10 text-destructive" />
          </div>

          {/* Timing row: model, interval, last run */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="timing-row">
            {status.model && (
              <span>
                Model: <span className="font-medium text-foreground/80">{status.model}</span>
              </span>
            )}
            {status.intervalMinutes > 0 && (
              <span>
                Every <span className="font-medium text-foreground/80">{status.intervalMinutes} min</span>
              </span>
            )}
            <span>
              Last run: <span className="font-medium text-foreground/80">{relativeTime(status.lastRunAt)}</span>
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exported tab
// ---------------------------------------------------------------------------

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
