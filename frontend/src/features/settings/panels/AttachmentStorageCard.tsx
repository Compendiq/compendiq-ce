import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, Search, Trash2 } from 'lucide-react';
import type {
  AttachmentStorageStats,
  AttachmentStoreSweepStats,
  AttachmentSweepStatus,
  AttachmentSweepTriggerResponse,
} from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { formatRelativeTime } from '../../../shared/lib/format-relative-time';
import { ConfirmDialog } from '../../../shared/components/ConfirmDialog';

/**
 * #1349 — Settings → Spaces & Sync: attachment storage + the dry-run-first
 * orphan sweep. ImageIndexCard is the pattern of record.
 *
 * Three rules carried over from that card and from ADR-010:
 *
 *  - **A failed stats fetch is a failure, not zero bytes.** Reading `{ data }`
 *    alone would collapse a 500 into "0 B stored", which on THIS surface
 *    reads as "nothing to sweep" — the exact opposite of what an unreadable
 *    store means. Three states: pending (em-dashes), error (the destructive
 *    treatment, actions kept live — a status read failing is no reason to
 *    withhold the Dry run that would explain it), and data.
 *  - **Everything at rest is neutral.** Storage figures, orphan candidates
 *    and the missing-rows count are MEASUREMENTS (the QualityScoreBadge
 *    argument). Amber appears only for a last run that did not complete —
 *    `failed`, or `refused` (a mis-pointed ATTACHMENTS_DIR the sweep declined
 *    to delete against), both of which need an operator to look.
 *  - **Destroying files is the point of the live button**, so it is the
 *    filled destructive variant inside a confirm dialog that names what will
 *    be deleted and what never is — never a bare button.
 *
 * The GETs answer a persisted record and never walk the tree, so the figures
 * are as fresh as the last run; Dry run is the refresh. Both actions are
 * fire-and-forget 202s and the card polls `running` (read server-side from
 * the worker lock) at 5s — at, not under, the admin rate limit's comfort
 * zone — with ImageIndexCard's warm-up window, because the lock is taken
 * after the POST answers and one early refetch would otherwise cache
 * `running: false` and never re-arm the interval.
 */

const STATS_QUERY_KEY = ['admin', 'attachment-storage-stats'] as const;
const SWEEP_QUERY_KEY = ['admin', 'attachment-sweep'] as const;

/** ≥5s — the admin rate limit is 20/min per route and two routes poll. */
const POLL_MS = 5_000;
/** Poll floor after a kick, until the payload reports the lock. */
const KICK_WARMUP_MS = 20_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function orphanSummary(stats: AttachmentStoreSweepStats): string | null {
  const parts: string[] = [];
  if (stats.orphanDirectories > 0) {
    parts.push(`${stats.orphanDirectories} orphan director${stats.orphanDirectories === 1 ? 'y' : 'ies'}`);
  }
  if (stats.orphanFiles > 0) {
    parts.push(`${stats.orphanFiles} orphan file${stats.orphanFiles === 1 ? '' : 's'}`);
  }
  if (parts.length === 0) return null;
  const bytes = stats.orphanDirectoryBytes + stats.orphanFileBytes;
  return `${parts.join(', ')} (${formatBytes(bytes)})`;
}

export function AttachmentStorageCard() {
  const qc = useQueryClient();
  const [kickedAt, setKickedAt] = useState<number | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const pollWhile = (running: boolean | undefined) => {
    if (running) return POLL_MS;
    if (kickedAt !== null && Date.now() - kickedAt < KICK_WARMUP_MS) return POLL_MS;
    return false;
  };

  const stats = useQuery<AttachmentStorageStats>({
    queryKey: STATS_QUERY_KEY,
    queryFn: () => apiFetch<AttachmentStorageStats>('/admin/attachments/stats'),
    retry: false,
    refetchInterval: (q) => pollWhile(q.state.data?.running),
  });

  const sweep = useQuery<AttachmentSweepStatus>({
    queryKey: SWEEP_QUERY_KEY,
    queryFn: () => apiFetch<AttachmentSweepStatus>('/admin/attachments/sweep'),
    retry: false,
    refetchInterval: (q) => pollWhile(q.state.data?.running),
  });

  const trigger = useMutation({
    mutationFn: (dryRun: boolean) =>
      apiFetch<AttachmentSweepTriggerResponse>('/admin/attachments/sweep', {
        method: 'POST',
        body: JSON.stringify({ dryRun }),
      }),
    onSuccess: (result, dryRun) => {
      if (result.alreadyRunning) {
        // Neither success nor failure: the press was a no-op against a sweep
        // that already holds the lock (ImageIndexCard's neutral precedent).
        toast.message('A sweep is already running — the results will appear here when it finishes.');
      } else {
        toast.success(
          dryRun
            ? 'Dry run started — figures update here when the walk finishes.'
            : 'Deleting orphans — the run re-checks every candidate before removing it.',
        );
      }
      setKickedAt(Date.now());
      void qc.invalidateQueries({ queryKey: STATS_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: SWEEP_QUERY_KEY });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const running = (stats.data?.running ?? false) || (sweep.data?.running ?? false);
  const isPending = stats.isPending || sweep.isPending;
  const isError = stats.isError && sweep.isError;
  const lastRun = sweep.data?.lastRun ?? null;
  const stores = stats.data?.stores ?? null;
  const noRunYet = !isPending && !isError && stores === null && lastRun === null;
  // The actions stay live on a failed READ — Dry run is the remedy that
  // refreshes the very record the failed GET could not deliver. Only the
  // pending paint (nothing known yet) and a running sweep disable them.
  const actionsDisabled = isPending || running || trigger.isPending;

  return (
    <div className="nm-card space-y-3 p-3 text-sm" data-testid="attachment-storage-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Attachment storage</h3>
        {running && (
          <span
            data-testid="attachment-sweep-running"
            className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
          >
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            Sweeping…
          </span>
        )}
      </div>

      {isError ? (
        <p className="text-destructive text-xs" data-testid="attachment-storage-error">
          The storage figures could not be read. The files on disk are unaffected — retry, or run a
          dry run to rebuild the record.
        </p>
      ) : isPending ? (
        <p className="text-muted-foreground text-xs" data-testid="attachment-storage-pending">
          Reading storage record…
        </p>
      ) : noRunYet ? (
        <p className="text-muted-foreground text-xs" data-testid="attachment-storage-empty">
          No sweep has run yet — press Dry run to measure both stores and list orphan candidates
          without touching any files.
        </p>
      ) : stores ? (
        <dl
          className="text-muted-foreground grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2"
          data-testid="attachment-storage-counters"
        >
          <div className="space-y-0.5">
            <dt className="text-foreground font-medium">Confluence cache</dt>
            <dd data-testid="attachment-storage-confluence-bytes">
              <span className="text-foreground font-mono">{formatBytes(stores.confluence.bytes)}</span>{' '}
              · {stores.confluence.files} files in {stores.confluence.directories} directories
            </dd>
            {orphanSummary(stores.confluence) && (
              <dd data-testid="attachment-storage-confluence-orphans">
                Candidates: {orphanSummary(stores.confluence)}
              </dd>
            )}
          </div>
          <div className="space-y-0.5">
            <dt className="text-foreground font-medium">Local store</dt>
            <dd data-testid="attachment-storage-local-bytes">
              <span className="text-foreground font-mono">{formatBytes(stores.local.bytes)}</span>{' '}
              · {stores.local.files} files in {stores.local.directories} directories
            </dd>
            {orphanSummary(stores.local) && (
              <dd data-testid="attachment-storage-local-orphans">
                Candidates: {orphanSummary(stores.local)}
              </dd>
            )}
          </div>
        </dl>
      ) : null}

      {!isPending && !isError && (stats.data?.missingLocalFiles ?? 0) > 0 && (
        <p className="text-muted-foreground text-xs" data-testid="attachment-storage-missing-rows">
          {stats.data!.missingLocalFiles} local attachment record
          {stats.data!.missingLocalFiles === 1 ? ' points' : 's point'} at a file that is not on
          disk — counted, never deleted, in case the attachments directory is mis-mounted.
        </p>
      )}

      {lastRun && lastRun.status === 'completed' && (
        <p className="text-muted-foreground text-xs" data-testid="attachment-sweep-last-run">
          Last {lastRun.dryRun ? 'dry run' : 'sweep'} {formatRelativeTime(lastRun.at)} ·{' '}
          <span className="text-foreground font-mono">{lastRun.candidatesTotal}</span> candidate
          {lastRun.candidatesTotal === 1 ? '' : 's'}
          {lastRun.deleted && (
            <>
              {' '}
              · deleted <span className="text-foreground font-mono">{lastRun.deleted.files}</span>{' '}
              file{lastRun.deleted.files === 1 ? '' : 's'} and{' '}
              <span className="text-foreground font-mono">{lastRun.deleted.directories}</span>{' '}
              director{lastRun.deleted.directories === 1 ? 'y' : 'ies'} (
              {formatBytes(lastRun.deleted.bytes)})
              {lastRun.deleted.imageEmbeddingRows > 0 &&
                `, pruned ${lastRun.deleted.imageEmbeddingRows} image-index row${lastRun.deleted.imageEmbeddingRows === 1 ? '' : 's'}`}
            </>
          )}
        </p>
      )}

      {/*
        Amber only here: a run that did not complete needs an operator to
        look — an unreadable root or a store that is empty while the database
        references it (the mis-mount refusal). role="status" so the verdict
        reaches assistive tech without interrupting (the failed-save recipe).
      */}
      {lastRun && lastRun.status !== 'completed' && (
        <p
          role="status"
          className="text-warning inline-flex items-start gap-1.5 text-xs"
          data-testid="attachment-sweep-last-run-problem"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            The last {lastRun.dryRun ? 'dry run' : 'sweep'} {formatRelativeTime(lastRun.at)}{' '}
            {lastRun.status === 'refused' ? 'refused to proceed' : 'failed'}
            {lastRun.note ? `: ${lastRun.note}` : ''}. No files were deleted.
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="attachment-sweep-dry-run"
          className="nm-button-ghost px-2.5 py-1 text-xs"
          disabled={actionsDisabled}
          onClick={() => trigger.mutate(true)}
          aria-describedby="attachment-sweep-note"
        >
          <Search size={12} aria-hidden="true" />
          Dry run
        </button>
        <button
          type="button"
          data-testid="attachment-sweep-delete"
          className="nm-action-destructive px-2.5 py-1 text-xs"
          disabled={actionsDisabled}
          onClick={() => setConfirmDeleteOpen(true)}
          aria-describedby="attachment-sweep-note"
        >
          <Trash2 size={12} aria-hidden="true" />
          Delete orphans
        </button>
      </div>

      <p id="attachment-sweep-note" className="text-muted-foreground text-xs" data-testid="attachment-sweep-note">
        Dry run walks both stores and lists candidates without touching disk. Delete orphans removes
        only files no page, draft, version, template or comment references, older than 24 hours,
        re-checked at delete time; matching image-index rows are pruned with them.
      </p>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title="Delete orphaned attachment files?"
        description="This permanently removes files that no page, draft, retained version, pending sync version, template or comment references and that are older than 24 hours. Every candidate is re-checked at delete time, matching image-index rows are pruned, and affected pages are re-queued for image indexing. Files referenced anywhere are never touched. This cannot be undone — run a dry run first if you have not."
        confirmLabel="Delete orphans"
        destructive
        onConfirm={() => {
          setConfirmDeleteOpen(false);
          trigger.mutate(false);
        }}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}
