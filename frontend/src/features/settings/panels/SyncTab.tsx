import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SyncOverviewResponse, SyncOverviewSpace } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { useAuthStore } from '../../../stores/auth-store';
import { useSync, useForceResyncAll } from '../../../shared/hooks/use-spaces';
import { ConfirmDialog } from '../../../shared/components/ConfirmDialog';
import { SkeletonFormFields } from '../../../shared/components/feedback/Skeleton';
import { ErrorState } from '../../../shared/components/feedback/ErrorState';
import { AttachmentStorageCard } from './AttachmentStorageCard';

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
  const forceResyncMutation = useForceResyncAll();
  // Force Re-sync All guard (ConfirmDialog replaces native confirm()).
  const [confirmForceResyncOpen, setConfirmForceResyncOpen] = useState(false);
  const { data, isLoading, isFetching, isError, error, refetch } = useQuery<SyncOverviewResponse>({
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

  // Attachment storage + orphan sweep (#1349) — admin-only, like the rescan
  // triggers: a KB-wide file deletion is an operator concern, and the routes
  // behind the card are requireAdmin, so rendering it for a non-admin would
  // only paint two failing fetches.
  //
  // It is built HERE, above the two early returns, and rendered in all three
  // branches (fixer, external round). The card has its own queries, its own
  // failure copy and its own "a failed stats fetch is a failure, not zero
  // bytes" contract — and `if (isError) return <ErrorState/>` sitting above it
  // deleted the whole card on a backend outage, which is the one failure that
  // contract was written for. The overview's fetch says nothing about the
  // storage record's.
  const attachmentStorageSection = isAdmin ? (
    <section className="space-y-3" data-testid="attachment-storage-section">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">Attachment Storage</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Disk usage of the two attachment stores, and a dry-run-first sweep for files nothing
          references any more.
        </p>
      </div>
      <AttachmentStorageCard />
    </section>
  ) : null;

  // Distinguish a failed overview fetch from the loading state so a
  // 500/network error surfaces a retry instead of an infinite skeleton.
  if (isError) {
    return (
      <div className="space-y-6" data-testid="sync-tab-panel">
        <ErrorState
          title="Couldn't load sync overview"
          description={error instanceof Error ? error.message : undefined}
          onRetry={() => refetch()}
          testId="sync-tab-error"
          retryTestId="sync-tab-retry"
        />
        {attachmentStorageSection}
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-6" data-testid="sync-tab-panel">
        <SkeletonFormFields />
        {attachmentStorageSection}
      </div>
    );
  }

  // Force re-sync every Confluence-sourced page (UPDATE path — bypasses the
  // version-unchanged guard that incremental Sync Now respects). Heavy enough
  // to warrant a confirmation. The server caps filter-mode selections at 5000;
  // larger KBs need the per-space approach, so call that out before firing.
  //
  // We use sync-overview.totalPages as the *upper-bound* preview hint — it
  // also counts any standalone pages that happen to live in a Confluence
  // space, but those get filtered out server-side because the bulk request
  // sends `{ source: 'confluence' }`. The toast on completion reports the
  // actual succeeded count, so the dialog text deliberately doesn't promise
  // a precise number.
  const totalPages = data.totals.totalPages;
  /**
   * #1532's recipe on this panel's third action control (external review
   * round). Rendered as `aria-disabled` plus the refusing early return below,
   * never as a native `disabled`: `onConfirm` calls `runForceResyncAll()`
   * synchronously, so `forceResyncMutation.isPending` lands in the very commit
   * that closes the `ConfirmDialog`. As a native `disabled` that commit takes
   * the trigger out of the focusable set BEFORE Radix dispatches
   * close-auto-focus, so #1531's restore aims `focus()` at a control that
   * cannot take it and the keyboard restarts the ~28-stop panel walk
   * (WCAG 2.4.3) — measured in a real browser on `a820e9b7`, checklist items
   * 3 and 11.
   *
   * Scope, stated exactly (review r1): the five controls this PR converts —
   * this trigger plus `attachment-sweep-dry-run`, `attachment-sweep-delete`,
   * `image-index-process` and `image-index-rescan` — carry the same shape and
   * behave identically. That is NOT panel-wide. `sync-overview-sync-now`
   * below still holds a native `disabled` over the very same
   * `data.sync.status === 'syncing'` window, so a keyboard operator standing
   * on it when a sync starts is still blurred to `<body>`: #1532's defect on
   * a control outside this PR's scope, recorded as an open question rather
   * than converted here. Probe at this head, overview forced to `syncing`:
   * force `{native:false, aria:"true", keepsFocus:true}`,
   * syncNow `{native:true, aria:null, keepsFocus:false}`.
   */
  const forceResyncDisabled =
    forceResyncMutation.isPending || data.sync.status === 'syncing' || totalPages === 0;
  const handleForceResyncAll = () => {
    // The refusal `aria-disabled` cannot perform — it blocks no events. A
    // second press during a running re-sync would otherwise re-open the
    // dialog and queue a second KB-wide re-fetch.
    if (forceResyncDisabled) return;
    if (totalPages > 5000) {
      toast.error(
        `Selection exceeds server cap (${totalPages} > 5000). Re-sync per space instead.`,
      );
      return;
    }
    // Heavy-but-safe operation: confirmation via ConfirmDialog below.
    setConfirmForceResyncOpen(true);
  };

  const runForceResyncAll = () => {
    forceResyncMutation.mutate(totalPages, {
      onSuccess: (res) => {
        if (res.failed === 0) {
          toast.success(`Re-synced ${res.succeeded} pages from Confluence.`);
        } else {
          toast.warning(
            `Re-synced ${res.succeeded}; ${res.failed} failed.${
              res.errors[0] ? ` First error: ${res.errors[0]}` : ''
            }`,
          );
        }
      },
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : 'Force re-sync failed.'),
    });
  };

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
          {/* Admin-only — same gate as the Force Rescan triggers in the
              Quality / Summary sections below. The endpoint itself is not
              admin-restricted (a regular user with bulk access can run it
              per-article), but a KB-wide re-fetch on every Confluence page
              is an operator concern, not a personal action. */}
          {isAdmin && (
            <button
              onClick={handleForceResyncAll}
              aria-disabled={forceResyncDisabled || undefined}
              // The busy palette the removed `:disabled` rule used to paint,
              // keyed off `aria-disabled` instead — the same class set the
              // four converted card buttons carry, so all five converted
              // controls dim, refuse and hover identically (the adjacent
              // `sync-overview-sync-now` is NOT one of them; see the scope
              // note above `forceResyncDisabled`).
              // `active:` as well as `hover:`, because
              // `nm-button-ghost` paints a pressed background on `:active` and
              // a keyboard hold on the focused button matches `:active` with
              // no `:hover`: without the pin the press the handler refuses
              // would still paint as accepted.
              className="nm-button-ghost aria-disabled:cursor-not-allowed aria-disabled:opacity-90 aria-disabled:hover:bg-transparent aria-disabled:active:bg-transparent"
              title="Re-fetch every Confluence page even when its version hasn't changed"
              data-testid="sync-overview-force-resync-all"
            >
              {forceResyncMutation.isPending ? 'Re-syncing...' : 'Force Re-sync All'}
            </button>
          )}
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
              className="rounded-xl border border-border bg-foreground/[0.03] p-4"
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
          <div className="rounded-xl border border-success/30 bg-success/10 p-4 text-sm text-success" data-testid="sync-overview-empty">
            No missing images or draw.io exports were detected in the selected spaces.
          </div>
        ) : (
          <div className="space-y-3">
            {data.issues.map((issue) => (
              <div
                key={issue.pageId}
                className="rounded-xl border border-destructive/30 bg-destructive/10 p-4"
                data-testid={`sync-overview-issue-${issue.pageId}`}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="font-medium">{issue.pageTitle}</div>
                    <div className="text-sm text-muted-foreground">{issue.spaceKey}</div>
                  </div>
                  <div className="text-sm text-destructive">
                    {issue.missingImages} image missing, {issue.missingDrawio} draw.io missing
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {issue.missingFiles.map((filename) => (
                    <span
                      key={filename}
                      className="rounded-full border border-destructive/30 bg-black/10 px-2.5 py-1 text-xs text-destructive"
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

      {attachmentStorageSection}

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
              Background worker that scores each page on completeness, clarity, structure, accuracy, and readability.
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
              <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">Page Summaries</h2>
              {summaryStatus && (
                <StatusBadge
                  label={summaryStatus.isProcessing ? 'Summarizing' : 'Idle'}
                  classes={summaryStatus.isProcessing ? workerBadgeClasses.processing : workerBadgeClasses.idle}
                  testId="summary-worker-status"
                />
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Background worker that generates concise summaries for each page using the LLM.
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

      {/* Force Re-sync All guard. Copy mirrors POST /pages/bulk/sync with
          { source: 'confluence' }: a re-fetch of every Confluence page plus
          embedding_dirty = TRUE — heavy, but nothing is deleted, so no
          destructive styling and no false destruction claims. */}
      <ConfirmDialog
        open={confirmForceResyncOpen}
        title="Force re-sync every Confluence page?"
        description="This re-fetches every page from Confluence even if its Confluence version is unchanged, and marks all embeddings for re-embedding. It may take several minutes."
        confirmLabel="Force re-sync"
        onConfirm={() => {
          setConfirmForceResyncOpen(false);
          runForceResyncAll();
        }}
        onCancel={() => setConfirmForceResyncOpen(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers (used only by SyncTab)
// ---------------------------------------------------------------------------

const syncBadgeClasses: Record<'idle' | 'syncing' | 'embedding' | 'error', string> = {
  idle: 'border-success/30 bg-success/10 text-success',
  syncing: 'border-warning/30 bg-warning/10 text-warning',
  // The one hueless pill, and the only one that breaks the /30 + /10 + ink
  // shape its siblings share. `--color-status-embedding` used to be Steel and
  // is body ink now — it had been byte-identical to `--color-primary`, so
  // ambient pipeline telemetry wore the colour reserved for "you can act on
  // this". The alphas therefore had to be re-measured against INK (WCAG on an
  // sRGB-space, byte-rounded composite, the way a browser blends):
  //
  //   fill at 10%  1.225:1 (Paper) / 1.278:1 (Graphite) against Pane — keeps
  //                the siblings' alpha, because at ink strength this is
  //                already the measured neutral-chip tint.
  //   border       `border-border`, not the token: a border tint composites
  //                ON TOP of that fill, so even an 8% ink border reaches
  //                1.439:1 / 1.592:1 at the pill's outer edge, past
  //                `--color-border` (1.414 / 1.264) in both themes — 26% past
  //                it in Graphite, where a status pill would then out-weigh
  //                every structural hairline on the page. The quiet hairline
  //                token IS that ceiling, so it is what the pill wears.
  //
  // Hue is no longer a channel here; `syncLabel` above is. The four statuses
  // read "Idle" / "Syncing <space>" / "Embedding" / "Error", so nothing is
  // carried by colour alone.
  embedding: 'border-border bg-status-embedding/10 text-status-embedding',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
};

const spaceBadgeClasses: Record<SyncOverviewSpace['status'], string> = {
  healthy: 'border-success/30 bg-success/10 text-success',
  degraded: 'border-destructive/30 bg-destructive/10 text-destructive',
  syncing: 'border-warning/30 bg-warning/10 text-warning',
  not_synced: 'border-status-inactive/30 bg-status-inactive/10 text-status-inactive',
};

const workerBadgeClasses = {
  processing: 'border-status-ai/30 bg-status-ai/10 text-status-ai',
  idle: 'border-success/30 bg-success/10 text-success',
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
    <div className="rounded-xl border border-border bg-foreground/[0.03] p-4" data-testid={testId}>
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
