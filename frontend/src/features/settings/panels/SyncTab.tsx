import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SyncOverviewResponse, SyncOverviewSpace } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { useAuthStore } from '../../../stores/auth-store';
import { useSync } from '../../../shared/hooks/use-spaces';
import { SkeletonFormFields } from '../../../shared/components/feedback/Skeleton';

interface QualityStatusResponse {
  totalPages: number;
  analyzedPages: number;
  pendingPages: number;
  failedPages: number;
  skippedPages: number;
  averageScore: number | null;
  isProcessing: boolean;
}

interface SummaryStatusResponse {
  totalPages: number;
  summarizedPages: number;
  pendingPages: number;
  failedPages: number;
  skippedPages: number;
  isProcessing: boolean;
}

export function SyncTab() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';

  const syncMutation = useSync();
  const { data, isLoading, isFetching, refetch } = useQuery<SyncOverviewResponse>({
    queryKey: ['settings', 'sync-overview'],
    queryFn: () => apiFetch('/settings/sync-overview'),
    refetchInterval: (query) => {
      const status = query.state.data?.sync.status;
      return status === 'syncing' || status === 'embedding' ? 2000 : false;
    },
  });

  const { data: qualityStatus } = useQuery<QualityStatusResponse>({
    queryKey: ['quality-status'],
    queryFn: () => apiFetch('/llm/quality-status'),
    refetchInterval: (query) => {
      return query.state.data?.isProcessing ? 3000 : false;
    },
  });

  const qualityRescanMutation = useMutation({
    mutationFn: () => apiFetch<{ message: string; pagesReset: number }>('/llm/quality-rescan', { method: 'POST' }),
    onSuccess: (data) => {
      toast.success(data.message);
      queryClient.invalidateQueries({ queryKey: ['quality-status'] });
    },
    onError: (err) => toast.error(err.message),
  });

  const { data: summaryStatus } = useQuery<SummaryStatusResponse>({
    queryKey: ['summary-status'],
    queryFn: () => apiFetch('/llm/summary-status'),
    refetchInterval: (query) => {
      return query.state.data?.isProcessing ? 3000 : false;
    },
  });

  const summaryRescanMutation = useMutation({
    mutationFn: () => apiFetch<{ message: string; resetCount: number }>('/llm/summary-rescan', { method: 'POST' }),
    onSuccess: (data) => {
      toast.success(data.message);
      queryClient.invalidateQueries({ queryKey: ['summary-status'] });
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading || !data) {
    return <SkeletonFormFields />;
  }

  const syncLabel = data.sync.status === 'syncing'
    ? `Syncing${data.sync.progress?.space ? ` ${data.sync.progress.space}` : ''}`
    : data.sync.status === 'embedding'
      ? 'Embedding'
      : data.sync.status === 'error'
        ? 'Error'
        : 'Idle';

  return (
    <div className="space-y-6" data-testid="sync-tab-panel">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              label={syncLabel}
              classes={syncBadgeClasses[data.sync.status]}
              testId="sync-overview-status"
            />
            {data.sync.progress && data.sync.status === 'syncing' && (
              <span className="text-sm text-muted-foreground">
                {data.sync.progress.current}/{data.sync.progress.total} pages
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Last completed sync: {formatTimestamp(data.sync.lastSynced)}
          </p>
          {data.sync.error && (
            <p className="text-sm text-destructive" data-testid="sync-overview-error">{data.sync.error}</p>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="nm-button-ghost"
            data-testid="sync-overview-refresh"
          >
            {isFetching ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || data.sync.status === 'syncing'}
            className="nm-button-primary"
            data-testid="sync-overview-sync-now"
          >
            {data.sync.status === 'syncing' ? 'Syncing...' : syncMutation.isPending ? 'Starting...' : 'Sync Now'}
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Selected Spaces"
          value={String(data.totals.selectedSpaces)}
          hint={`${data.totals.totalPages} cached pages`}
          testId="sync-metric-spaces"
        />
        <MetricCard
          label="Pages With Assets"
          value={String(data.totals.pagesWithAssets)}
          hint={`${data.totals.healthyPages} healthy, ${data.totals.pagesWithIssues} with gaps`}
          testId="sync-metric-pages"
        />
        <MetricCard
          label="Images"
          value={`${data.totals.images.cached}/${data.totals.images.expected}`}
          hint={data.totals.images.missing > 0 ? `${data.totals.images.missing} missing` : 'All cached'}
          testId="sync-metric-images"
        />
        <MetricCard
          label="Draw.io"
          value={`${data.totals.drawio.cached}/${data.totals.drawio.expected}`}
          hint={data.totals.drawio.missing > 0 ? `${data.totals.drawio.missing} missing` : 'All cached'}
          testId="sync-metric-drawio"
        />
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">Spaces</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Health by selected Confluence space, including images and draw.io exports expected from cached pages.
          </p>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          {data.spaces.map((space) => (
            <div
              key={space.spaceKey}
              className="rounded-xl border border-border/40 bg-foreground/[0.03] p-4"
              data-testid={`sync-overview-space-${space.spaceKey}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-base font-semibold">{space.spaceName}</div>
                  <div className="text-sm text-muted-foreground">{space.spaceKey}</div>
                </div>
                <StatusBadge label={space.status.replace('_', ' ')} classes={spaceBadgeClasses[space.status]} />
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Pages</div>
                  <div className="mt-1 text-lg font-medium">{space.pageCount}</div>
                  <div className="text-sm text-muted-foreground">{space.pagesWithAssets} with assets</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Last Synced</div>
                  <div className="mt-1 text-sm">{formatTimestamp(space.lastSynced)}</div>
                  <div className="text-sm text-muted-foreground">{space.pagesWithIssues} pages need attention</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Images</div>
                  <div className="mt-1 text-lg font-medium">{space.images.cached}/{space.images.expected}</div>
                  <div className="text-sm text-muted-foreground">{space.images.missing} missing</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Draw.io</div>
                  <div className="mt-1 text-lg font-medium">{space.drawio.cached}/{space.drawio.expected}</div>
                  <div className="text-sm text-muted-foreground">{space.drawio.missing} missing</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">Missing Assets</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pages listed here still have missing local files, which is the most likely source of image 404s.
          </p>
        </div>

        {data.issues.length === 0 ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-300" data-testid="sync-overview-empty">
            No missing images or draw.io exports were detected in the selected spaces.
          </div>
        ) : (
          <div className="space-y-3">
            {data.issues.map((issue) => (
              <div
                key={issue.pageId}
                className="rounded-xl border border-red-500/30 bg-red-500/10 p-4"
                data-testid={`sync-overview-issue-${issue.pageId}`}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="font-medium">{issue.pageTitle}</div>
                    <div className="text-sm text-muted-foreground">{issue.spaceKey}</div>
                  </div>
                  <div className="text-sm text-red-200">
                    {issue.missingImages} image missing, {issue.missingDrawio} draw.io missing
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {issue.missingFiles.map((filename) => (
                    <span
                      key={filename}
                      className="rounded-full border border-red-400/30 bg-black/10 px-2.5 py-1 text-xs text-red-100"
                    >
                      {filename}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Quality Analysis Worker */}
      <section className="space-y-3" data-testid="quality-worker-section">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">Quality Analysis</h2>
              {qualityStatus && (
                <StatusBadge
                  label={qualityStatus.isProcessing ? 'Analyzing' : 'Idle'}
                  classes={qualityStatus.isProcessing ? workerBadgeClasses.processing : workerBadgeClasses.idle}
                  testId="quality-worker-status"
                />
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Background worker that scores each article on completeness, clarity, structure, accuracy, and readability.
            </p>
          </div>

          {isAdmin && (
            <button
              onClick={() => qualityRescanMutation.mutate()}
              disabled={qualityRescanMutation.isPending}
              className="nm-button-ghost whitespace-nowrap"
              data-testid="quality-force-rescan"
            >
              {qualityRescanMutation.isPending ? 'Rescanning...' : 'Force Rescan'}
            </button>
          )}
        </div>

        {qualityStatus && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <MetricCard
              label="Analyzed"
              value={String(qualityStatus.analyzedPages)}
              hint={`of ${qualityStatus.totalPages} total pages`}
              testId="quality-metric-analyzed"
            />
            <MetricCard
              label="Pending"
              value={String(qualityStatus.pendingPages)}
              hint="Waiting for analysis"
              testId="quality-metric-pending"
            />
            <MetricCard
              label="Failed"
              value={String(qualityStatus.failedPages)}
              hint="Analysis encountered errors"
              testId="quality-metric-failed"
            />
            <MetricCard
              label="Skipped"
              value={String(qualityStatus.skippedPages)}
              hint="Content too short"
              testId="quality-metric-skipped"
            />
            <MetricCard
              label="Avg Score"
              value={qualityStatus.averageScore !== null ? String(qualityStatus.averageScore) : '—'}
              hint={qualityStatus.averageScore !== null ? 'Out of 100' : 'No scores yet'}
              testId="quality-metric-avg-score"
            />
          </div>
        )}
      </section>

      {/* Summary Worker */}
      <section className="space-y-3" data-testid="summary-worker-section">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">Article Summaries</h2>
              {summaryStatus && (
                <StatusBadge
                  label={summaryStatus.isProcessing ? 'Summarizing' : 'Idle'}
                  classes={summaryStatus.isProcessing ? workerBadgeClasses.processing : workerBadgeClasses.idle}
                  testId="summary-worker-status"
                />
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Background worker that generates concise summaries for each article using the LLM.
            </p>
          </div>

          {isAdmin && (
            <button
              onClick={() => summaryRescanMutation.mutate()}
              disabled={summaryRescanMutation.isPending}
              className="nm-button-ghost whitespace-nowrap"
              data-testid="summary-force-rescan"
            >
              {summaryRescanMutation.isPending ? 'Rescanning...' : 'Force Rescan'}
            </button>
          )}
        </div>

        {summaryStatus && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Summarized"
              value={String(summaryStatus.summarizedPages)}
              hint={`of ${summaryStatus.totalPages} total pages`}
              testId="summary-metric-summarized"
            />
            <MetricCard
              label="Pending"
              value={String(summaryStatus.pendingPages)}
              hint="Waiting for summarization"
              testId="summary-metric-pending"
            />
            <MetricCard
              label="Failed"
              value={String(summaryStatus.failedPages)}
              hint="Summarization encountered errors"
              testId="summary-metric-failed"
            />
            <MetricCard
              label="Skipped"
              value={String(summaryStatus.skippedPages)}
              hint="No content to summarize"
              testId="summary-metric-skipped"
            />
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers (used only by SyncTab)
// ---------------------------------------------------------------------------

const syncBadgeClasses: Record<'idle' | 'syncing' | 'embedding' | 'error', string> = {
  idle: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  syncing: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  embedding: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  error: 'border-red-500/30 bg-red-500/10 text-red-300',
};

const spaceBadgeClasses: Record<SyncOverviewSpace['status'], string> = {
  healthy: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  degraded: 'border-red-500/30 bg-red-500/10 text-red-300',
  syncing: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  not_synced: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
};

const workerBadgeClasses = {
  processing: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  idle: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
};

function formatTimestamp(value?: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString();
}

function MetricCard({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint: string;
  testId?: string;
}) {
  return (
    <div className="rounded-xl border border-border/40 bg-foreground/[0.03] p-4" data-testid={testId}>
      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-sm text-muted-foreground">{hint}</div>
    </div>
  );
}

function StatusBadge({
  label,
  classes,
  testId,
}: {
  label: string;
  classes: string;
  testId?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium uppercase tracking-[0.14em] ${classes}`}
      data-testid={testId}
    >
      {label}
    </span>
  );
}
