import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch } from '../../../shared/lib/api';

interface Pending {
  providerId: string;
  model: string;
}

interface Props {
  /** The unsaved embedding provider/model change, when one exists (same value the destructive banner receives). */
  pending: Pending | null;
  /**
   * Called after any lifecycle action that repoints the embedding assignment
   * server-side. Invalidating the query is not enough — the parent holds a
   * local working copy behind a one-shot hydration guard, and only it can
   * drop that guard so the form re-seeds (review r7).
   */
  onLifecycleChange?: () => void;
  /**
   * Reports whether a migration exists, so the parent can stop offering the
   * destructive path this card replaces while one is under way (review r9).
   */
  onActiveChange?: (active: boolean) => void;
}

interface ShadowStatus {
  active: boolean;
  migration: null | {
    phase: 'backfilling' | 'ready' | 'swapped' | 'aborting';
    model: string;
    dimensions: number;
    totalPages: number;
    backfilledPages: number;
    stragglerPages: number;
    indexed: boolean;
    indexReady: boolean;
    startedAt: string;
  };
}

/**
 * #1116 — the zero-downtime re-embed lifecycle. Search serves the live
 * vectors throughout: start probes the pair server-side and backfills a
 * shadow column in the background, swap is one bounded-lock rename, rollback
 * stays available until cleanup deletes the old vectors. Sits beside the
 * destructive EmbeddingReembedBanner as the recommended path for model
 * changes.
 */
/** Coarse on purpose: an ETA to the minute would imply precision this has none of. */
function formatEta(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = ms / 3_600_000;
  return hours < 10 ? `${hours.toFixed(1)} h` : `${Math.round(hours)} h`;
}

export function EmbeddingShadowMigrationCard({ pending, onLifecycleChange, onActiveChange }: Props) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ShadowStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingCleanup, setConfirmingCleanup] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelCleanupRef = useRef<HTMLButtonElement | null>(null);
  // Through a ref so an inline arrow prop cannot re-fire the effect each render.
  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;

  const refresh = useCallback(async () => {
    try {
      const s = await apiFetch<ShadowStatus>('/admin/embedding/shadow-migration');
      setStatus(s);
    } catch {
      // transient — keep the last known state
    }
  }, []);

  useEffect(() => {
    void refresh();
    // 5s matches ActiveEmbeddingLocksBanner's cadence and stays under the
    // default 20/min per-route admin rate limit (3s sat exactly at it).
    pollRef.current = setInterval(() => void refresh(), 5_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  async function post(path: string, okMessage: string, body?: object) {
    setBusy(true);
    try {
      await apiFetch(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      toast.success(okMessage);
      await refresh();
      // Swap/rollback/cleanup repoint the embedding assignment and
      // dimensions server-side — the sibling panels (assignments section,
      // destructive banner) read them through these caches and would keep
      // showing pre-migration state until a full reload otherwise.
      // AWAITED, and the callback runs after it: invalidate() only marks the
      // entry stale, so a parent re-seeding synchronously would read the OLD
      // document and re-arm its hydration guard against it — leaving the form
      // on the pre-swap pair and re-raising the destructive banner over a
      // migration that just succeeded (review r8). This is the same ordering
      // LlmTab's own save.onSuccess uses, and for the same reason.
      await queryClient.invalidateQueries({ queryKey: ['llm-usecases'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['llm', 'usecase-default'] });
      onLifecycleChange?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'request failed');
    } finally {
      setBusy(false);
      setConfirmingCleanup(false);
    }
  }

  useEffect(() => {
    // Arming unmounts the button that had focus, dropping it to <body>
    // (WCAG 2.4.3). Land on Cancel rather than Confirm: what is armed here
    // deletes the old vectors permanently, and Enter must not finish it by
    // momentum.
    if (confirmingCleanup) cancelCleanupRef.current?.focus();
  }, [confirmingCleanup]);

  const migration = status?.active ? status.migration : null;

  useEffect(() => {
    onActiveChangeRef.current?.(migration !== null);
  }, [migration]);

  if (!migration && !pending) return null;
  if (status === null) return null; // first poll not resolved yet

  if (!migration && pending) {
    return (
      <div className="nm-card border-blue-500/30 p-3 text-sm" data-testid="shadow-migration-card">
        <p>
          Embedding model change detected (<b>{pending.model}</b>). The zero-downtime path
          backfills the new vectors in the background — search keeps serving the current
          index until you swap, and the swap is reversible until cleanup.
        </p>
        <div className="mt-2 flex gap-2">
          <button
            className="nm-button-primary"
            disabled={busy}
            onClick={() => pending && void post('/admin/embedding/shadow-migration', 'Shadow backfill started', pending)}
          >
            {busy ? 'Starting…' : 'Start zero-downtime re-embed (recommended)'}
          </button>
        </div>
      </div>
    );
  }

  if (!migration) return null;

  if (migration.phase === 'aborting') {
    return (
      <div className="nm-card border-blue-500/30 p-3 text-sm" data-testid="shadow-migration-card">
        <p>
          A previous abort did not finish — the shadow columns may still exist.
          Retry to complete it; nothing else can start until it does.
        </p>
        <div className="mt-2 flex gap-2">
          <button
            className="nm-button-primary"
            disabled={busy}
            onClick={() => void post('/admin/embedding/shadow-migration/rollback', 'Abort completed')}
          >
            Retry abort
          </button>
        </div>
      </div>
    );
  }

  if (migration.phase === 'backfilling') {
    // The issue asks for progress AND an ETA. Extrapolate from measured
    // throughput rather than guessing: elapsed ÷ done × remaining. It is
    // suppressed below 5 pages, where the sample is too small to mean
    // anything, and once the pages are done — the index build that follows
    // has no page counter to extrapolate from, so the card names that phase
    // instead of showing a countdown it cannot honour (review r9).
    const buildingIndex = migration.stragglerPages === 0 && !migration.indexReady;
    const elapsedMs = Date.now() - new Date(migration.startedAt).getTime();
    const eta =
      !buildingIndex && migration.backfilledPages >= 5 && migration.backfilledPages < migration.totalPages
        ? formatEta((elapsedMs / migration.backfilledPages) * (migration.totalPages - migration.backfilledPages))
        : null;

    return (
      <div className="nm-card border-blue-500/30 p-3 text-sm" data-testid="shadow-migration-card">
        <p>
          Zero-downtime re-embed to <b>{migration.model}</b> ({migration.dimensions} dims):{' '}
          <b>
            {migration.backfilledPages}/{migration.totalPages}
          </b>{' '}
          pages backfilled{eta ? ` — about ${eta} remaining` : ''}. Search is unaffected — the
          current index keeps serving.
        </p>
        {buildingIndex && (
          <p className="mt-1 text-muted-foreground">
            All pages carry shadow vectors; <b>building the vector index</b>. This is usually the
            longest phase and reports no page-level progress — writes to the embedding table queue
            behind it.
          </p>
        )}
        <div className="mt-2 flex gap-2">
          {/* Always offered while backfilling: it also recovers a worker
              that crashed during the final index build (zero stragglers), and
              the server refuses honestly if the job is still running. */}
          <button
            className="nm-button-primary"
            disabled={busy}
            onClick={() => void post('/admin/embedding/shadow-migration/backfill', 'Backfill re-enqueued')}
          >
            Re-run backfill
          </button>
          <button
            className="nm-button-ghost"
            disabled={busy}
            onClick={() => void post('/admin/embedding/shadow-migration/rollback', 'Shadow migration aborted')}
          >
            Abort
          </button>
        </div>
      </div>
    );
  }

  if (migration.phase === 'ready') {
    return (
      <div className="nm-card border-blue-500/30 p-3 text-sm" data-testid="shadow-migration-card">
        <p>
          Backfill complete — <b>{migration.totalPages}</b> pages carry <b>{migration.model}</b>{' '}
          vectors
          {migration.indexed ? (
            ' and the new index is built'
          ) : (
            <span className="text-warning">
              {' '}
              with <b>no vector index</b> — pgvector cannot index past 4000 dimensions, so search
              will scan sequentially once you swap
            </span>
          )}
          . Swapping is a sub-second rename; the old vectors stay available for rollback until
          cleanup.
        </p>
        <div className="mt-2 flex gap-2">
          <button
            className="nm-button-primary"
            disabled={busy}
            onClick={() => void post('/admin/embedding/shadow-migration/swap', 'Swapped — new model is live')}
          >
            {busy ? 'Swapping…' : 'Swap to the new model'}
          </button>
          <button
            className="nm-button-ghost"
            disabled={busy}
            onClick={() => void post('/admin/embedding/shadow-migration/rollback', 'Shadow migration aborted')}
          >
            Abort
          </button>
        </div>
      </div>
    );
  }

  // swapped
  return (
    <div className="nm-card border-blue-500/30 p-3 text-sm" data-testid="shadow-migration-card">
      <p>
        <b>{migration.model}</b> is live. Validate search quality, then clean up — or roll back
        to the previous model. Cleanup <b>deletes the old vectors</b> and ends the rollback
        window.
      </p>
      {confirmingCleanup && (
        <p className="mt-2 text-warning" role="alert">
          Cleanup permanently deletes the old vectors — rolling back afterwards requires a full
          re-embed. Continue?
        </p>
      )}
      <div className="mt-2 flex gap-2">
        {confirmingCleanup ? (
          <>
            <button
              ref={cancelCleanupRef}
              className="nm-button-ghost"
              disabled={busy}
              onClick={() => setConfirmingCleanup(false)}
            >
              Cancel
            </button>
            <button
              className="nm-button-primary"
              disabled={busy}
              onClick={() => void post('/admin/embedding/shadow-migration/cleanup', 'Cleaned up — migration complete')}
            >
              Confirm cleanup
            </button>
          </>
        ) : (
          <>
            <button className="nm-button-primary" disabled={busy} onClick={() => setConfirmingCleanup(true)}>
              Clean up
            </button>
            <button
              className="nm-button-ghost"
              disabled={busy}
              onClick={() => void post('/admin/embedding/shadow-migration/rollback', 'Rolled back — previous model is live')}
            >
              Roll back
            </button>
          </>
        )}
      </div>
    </div>
  );
}
