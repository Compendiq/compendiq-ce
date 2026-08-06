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
export function EmbeddingShadowMigrationCard({ pending }: Props) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ShadowStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingCleanup, setConfirmingCleanup] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    pollRef.current = setInterval(() => void refresh(), 3_000);
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
      void queryClient.invalidateQueries({ queryKey: ['llm-usecases'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['llm', 'usecase-default'] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'request failed');
    } finally {
      setBusy(false);
      setConfirmingCleanup(false);
    }
  }

  const migration = status?.active ? status.migration : null;

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
    return (
      <div className="nm-card border-blue-500/30 p-3 text-sm" data-testid="shadow-migration-card">
        <p>
          Zero-downtime re-embed to <b>{migration.model}</b> ({migration.dimensions} dims):{' '}
          <b>
            {migration.backfilledPages}/{migration.totalPages}
          </b>{' '}
          pages backfilled. Search is unaffected — the current index keeps serving.
        </p>
        <div className="mt-2 flex gap-2">
          {migration.stragglerPages > 0 && (
            <button
              className="nm-button-primary"
              disabled={busy}
              onClick={() => void post('/admin/embedding/shadow-migration/backfill', 'Backfill re-enqueued')}
            >
              Re-run backfill
            </button>
          )}
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
          vectors and the new index is built. Swapping is a sub-second rename; the old vectors
          stay available for rollback until cleanup.
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
        <p className="mt-2 text-warning">
          Cleanup permanently deletes the old vectors — rolling back afterwards requires a full
          re-embed. Continue?
        </p>
      )}
      <div className="mt-2 flex gap-2">
        {confirmingCleanup ? (
          <>
            <button className="nm-button-ghost" disabled={busy} onClick={() => setConfirmingCleanup(false)}>
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
