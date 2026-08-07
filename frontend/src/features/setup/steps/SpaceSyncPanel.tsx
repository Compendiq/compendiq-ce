import { useEffect, useState } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckSquare, Loader2, RefreshCw, Square } from 'lucide-react';
import { apiFetch } from '../../../shared/lib/api';
import { useSyncStatus } from '../../../shared/hooks/use-spaces';
import { cn } from '../../../shared/lib/cn';

interface AvailableSpace {
  key: string;
  name: string;
  type: string;
}

interface SyncedSpace {
  key: string;
  name: string;
  pageCount: number;
}

/**
 * #1127 — space picker + inline sync progress, revealed inside the wizard's
 * Confluence step once the connection probe passes.
 *
 * The point of the feature is that an admin finishes the wizard with pages
 * actually arriving, instead of landing on an empty app and having to discover
 * Settings → Spaces on their own. Two rules follow from that and are load-
 * bearing:
 *
 *  1. **Sync is fire-and-forget.** `POST /api/sync` returns as soon as the
 *     background run is queued (`routes/confluence/sync.ts` detaches
 *     `syncUser`), so nothing here may ever gate the wizard's Continue button.
 *     This panel renders progress; the step owns navigation and never consults
 *     this component's state.
 *  2. **Leaving mid-sync must not cancel it.** Nothing in here holds an
 *     AbortController — `apiFetch` doesn't take a signal — so unmounting simply
 *     stops the poll. Re-entering the step re-reads `GET /api/sync/status` and
 *     picks the progress back up.
 *
 * `steps.confluence` in `/api/health/setup-status` still means "≥1 confluence
 * page exists", untouched: a sync started here is exactly what eventually
 * flips it.
 */
export function SpaceSyncPanel() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Latches on the first successful dispatch. Drives the "did this admin
  // already kick off a sync?" branch — a settled status alone can't tell the
  // difference between "finished" and "never started".
  const [dispatched, setDispatched] = useState(false);

  const {
    data: availableSpaces,
    isLoading: loadingSpaces,
    isError: spacesFailed,
    refetch: refetchSpaces,
  } = useQuery<AvailableSpace[]>({
    queryKey: ['spaces', 'available'],
    queryFn: () => apiFetch('/spaces/available'),
    retry: false,
  });

  const { data: syncStatus } = useSyncStatus();
  const isSyncing = syncStatus?.status === 'syncing' || syncStatus?.status === 'embedding';
  const settled = dispatched && !isSyncing;

  // Page counts for the "what you actually got" summary. Shares the `['spaces']`
  // key with `useSpaces()` so the cache stays coherent app-wide, but only
  // fetches once a run has settled — before the first sync the table is empty
  // and the call would return [].
  const { data: syncedSpaces } = useQuery<SyncedSpace[]>({
    queryKey: ['spaces'],
    queryFn: () => apiFetch('/spaces'),
    enabled: settled,
  });

  // A run that just finished has written pages, spaces and embeddings the rest
  // of the app caches. Refresh them once on the syncing → settled edge rather
  // than on every poll tick.
  useEffect(() => {
    if (!settled) return;
    queryClient.invalidateQueries({ queryKey: ['spaces'] });
    queryClient.invalidateQueries({ queryKey: ['pages'] });
  }, [settled, queryClient]);

  const startSync = useMutation({
    mutationFn: async (spaceKeys: string[]) => {
      // Persist the selection first: `syncUser` reads the spaces to sync from
      // the user's RBAC assignments, which is what PUT /settings writes.
      await apiFetch('/settings', {
        method: 'PUT',
        body: JSON.stringify({ selectedSpaces: spaceKeys }),
      });
      return apiFetch('/sync', { method: 'POST' });
    },
    onSuccess: () => {
      setDispatched(true);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      // Kicks `useSyncStatus` off its 2s poll — the backend has already flipped
      // the status to 'syncing' by the time POST /sync responds.
      queryClient.invalidateQueries({ queryKey: ['sync', 'status'] });
    },
  });

  function toggleSpace(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const spaceNames = new Map((availableSpaces ?? []).map((s) => [s.key, s.name]));
  const syncingSpaceName = syncStatus?.progress?.space
    ? spaceNames.get(syncStatus.progress.space) ?? syncStatus.progress.space
    : null;
  const current = syncStatus?.progress?.current ?? 0;
  const total = syncStatus?.progress?.total ?? 0;
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;

  const settledSpaces = (syncedSpaces ?? []).filter((s) => selected.has(s.key));
  const settledPages = settledSpaces.reduce((sum, s) => sum + s.pageCount, 0);

  const syncLabel = settled
    ? 'Sync again'
    : selected.size === 0
      ? 'Sync spaces'
      : `Sync ${selected.size} space${selected.size === 1 ? '' : 's'}`;

  return (
    <m.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="mt-6 border-t border-border pt-6"
      aria-labelledby="space-picker-heading"
      data-testid="space-sync-panel"
    >
      <h3 id="space-picker-heading" className="text-sm font-semibold">
        Choose spaces to sync
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Compendiq indexes the spaces you pick here. Syncing runs in the background — you can
        continue setup right away, and change this later in Settings → Spaces.
      </p>

      {loadingSpaces && (
        <div className="mt-4 space-y-1.5" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[3.25rem] animate-pulse rounded-lg bg-foreground/5" />
          ))}
        </div>
      )}

      {spacesFailed && (
        <div
          className="mt-4 rounded-lg border border-status-disconnected/30 bg-status-disconnected/10 p-3"
          role="alert"
          data-testid="spaces-load-error"
        >
          <p className="text-sm font-medium text-status-disconnected">
            Couldn&apos;t load spaces from Confluence
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Your connection is saved — retry, or continue setup and pick spaces later in
            Settings → Spaces.
          </p>
          <button
            type="button"
            onClick={() => void refetchSpaces()}
            className="nm-button-ghost mt-2 px-3 py-1.5 text-xs"
            data-testid="retry-spaces-btn"
          >
            <RefreshCw size={13} />
            Retry
          </button>
        </div>
      )}

      {!loadingSpaces && !spacesFailed && availableSpaces?.length === 0 && (
        <p
          className="mt-4 rounded-lg border border-border bg-foreground/5 px-4 py-6 text-center text-sm text-muted-foreground"
          data-testid="spaces-empty"
        >
          Your personal access token can&apos;t see any spaces yet. Ask a Confluence admin for
          access, then sync from Settings → Spaces.
        </p>
      )}

      {!!availableSpaces?.length && (
        <div
          className="mt-4 max-h-56 space-y-1.5 overflow-y-auto pr-1"
          role="group"
          aria-label="Confluence spaces"
          data-testid="space-picker"
        >
          {availableSpaces.map((space) => {
            const isSelected = selected.has(space.key);
            return (
              <button
                key={space.key}
                type="button"
                onClick={() => toggleSpace(space.key)}
                aria-pressed={isSelected}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isSelected
                    ? 'border-action/40 bg-action/10'
                    : 'border-border-interactive bg-foreground/5 hover:bg-foreground/10',
                )}
                data-testid={`space-option-${space.key}`}
              >
                {isSelected ? (
                  <CheckSquare size={18} className="shrink-0 text-action" />
                ) : (
                  <Square size={18} className="shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{space.name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{space.key}</p>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <AnimatePresence mode="wait">
        {isSyncing ? (
          <m.div
            key="progress"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="mt-4 rounded-lg border border-status-syncing/30 bg-status-syncing/10 p-3"
            data-testid="sync-progress"
          >
            <div className="flex items-center gap-2">
              <span
                className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-status-syncing"
                aria-hidden="true"
              />
              {/* Live region on the headline only: it changes once per space,
                  whereas the page counter below ticks every poll and would
                  make a screen reader unusable. */}
              <p className="text-sm font-medium text-status-syncing" role="status">
                {syncingSpaceName ? `Syncing ${syncingSpaceName}` : 'Starting sync'}
              </p>
            </div>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="sync-progress-count">
              {total > 0 ? `${current} of ${total} pages` : 'Counting pages…'}
            </p>
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-foreground/10"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={total > 0 ? percent : undefined}
              aria-label="Sync progress"
            >
              <div
                className="h-full rounded-full bg-status-syncing transition-[width] duration-300 ease-out"
                style={{ width: `${total > 0 ? percent : 8}%` }}
              />
            </div>
          </m.div>
        ) : settled && !startSync.isError ? (
          <m.div
            key="settled"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-4 rounded-lg border border-status-connected/30 bg-status-connected/10 p-3"
            data-testid="sync-complete"
          >
            <div className="flex items-center gap-2">
              <span
                className="h-2 w-2 shrink-0 rounded-full bg-status-connected"
                aria-hidden="true"
              />
              <p className="text-sm font-medium text-status-connected" role="status">
                Sync complete
              </p>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {settledPages > 0
                ? `${settledPages} page${settledPages === 1 ? '' : 's'} indexed across ${settledSpaces.length} space${settledSpaces.length === 1 ? '' : 's'}.`
                : 'Compendiq is finishing up in the background.'}
            </p>
            {settledSpaces.length > 0 && (
              <ul className="mt-2 space-y-1">
                {settledSpaces.map((space) => (
                  <li
                    key={space.key}
                    className="flex items-center justify-between gap-3 text-xs"
                    data-testid={`synced-space-${space.key}`}
                  >
                    <span className="truncate text-foreground">{space.name}</span>
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {space.pageCount} pages
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </m.div>
        ) : null}
      </AnimatePresence>

      {startSync.isError && (
        <div
          className="mt-4 rounded-lg border border-status-disconnected/30 bg-status-disconnected/10 p-3"
          role="alert"
          data-testid="sync-error"
        >
          <p className="text-sm font-medium text-status-disconnected">Couldn&apos;t start the sync</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {startSync.error instanceof Error ? startSync.error.message : 'The request failed.'}{' '}
            Your connection is saved — you can continue setup and sync from Settings → Spaces.
          </p>
          <button
            type="button"
            onClick={() => startSync.mutate(Array.from(selected))}
            disabled={startSync.isPending}
            className="nm-button-ghost mt-2 px-3 py-1.5 text-xs"
            data-testid="retry-sync-btn"
          >
            <RefreshCw size={13} />
            Try again
          </button>
        </div>
      )}

      {!isSyncing && (
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => startSync.mutate(Array.from(selected))}
            disabled={selected.size === 0 || startSync.isPending}
            className="nm-button-ghost px-4 py-2 text-sm"
            data-testid="start-sync-btn"
          >
            {startSync.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            {syncLabel}
          </button>
          {selected.size === 0 && !settled && (
            <p className="text-xs text-muted-foreground">
              Pick at least one space, or skip — you can sync later.
            </p>
          )}
        </div>
      )}
    </m.section>
  );
}
