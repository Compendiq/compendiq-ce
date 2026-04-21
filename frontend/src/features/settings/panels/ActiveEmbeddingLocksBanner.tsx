import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AdminEmbeddingLocksResponse, EmbeddingLockSnapshot } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';

/**
 * ActiveEmbeddingLocksBanner — admin-only panel component (issue #257 plan
 * §2.9 / §2.10 / §3.3).
 *
 * Polls `GET /api/admin/embedding/locks` every 5 seconds. When one or more
 * locks are held (the synthetic `__reembed_all__` system lock is already
 * filtered server-side) it renders a per-user row with a "Force release"
 * button, behind an inline confirm — matching the pattern used by
 * `BulkOperations.tsx` delete rather than introducing a new modal primitive.
 *
 * On successful force-release the next 5-second poll drops the row; on a
 * non-2xx response a toast surfaces the error and the row remains in place.
 */
export function ActiveEmbeddingLocksBanner() {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-embedding-locks'],
    queryFn: () => apiFetch<AdminEmbeddingLocksResponse>('/admin/embedding/locks'),
    refetchInterval: 5_000,
  });

  const forceRelease = useMutation({
    mutationFn: (userId: string) =>
      apiFetch<{ released: boolean; userId: string }>(
        `/admin/embedding/locks/${encodeURIComponent(userId)}/release`,
        { method: 'POST' },
      ),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['admin-embedding-locks'] });
      if (res.released) {
        toast.success(`Released embedding lock for "${res.userId}"`);
      } else {
        toast.message(`Lock for "${res.userId}" was already gone`);
      }
      setConfirming(null);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to release lock');
      // Keep confirming-state so the row stays visible with the inline confirm
      // open, giving the admin a chance to retry or cancel.
    },
  });

  if (isLoading) return null;
  const locks = data?.locks ?? [];
  if (locks.length === 0) return null;

  const userList = locks.map((l) => l.userId).join(', ');

  return (
    <div
      className="glass-card border-yellow-500/30 p-3 text-sm"
      data-testid="active-embedding-locks-banner"
    >
      <p className="mb-2 text-yellow-300">
        <b>Embedding in progress:</b> {userList} — per-user triggers and
        re-embed-all will queue until these complete.
      </p>
      <ul className="space-y-1">
        {locks.map((lock: EmbeddingLockSnapshot) => {
          // Approximate "held for" = TTL_cap - remaining. EMBEDDING_LOCK_TTL
          // is 1 hour per redis-cache.ts, i.e. 3_600_000 ms.
          const heldSecs = Math.max(
            0,
            Math.round((3_600_000 - lock.ttlRemainingMs) / 1000),
          );
          const isConfirming = confirming === lock.userId;
          return (
            <li
              key={lock.userId}
              className="flex items-center justify-between gap-2"
              data-testid={`embedding-lock-row-${lock.userId}`}
            >
              <span className="text-xs text-muted-foreground">
                {lock.userId} — holding for {heldSecs}s
              </span>
              {isConfirming ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-destructive">
                    Force release &quot;{lock.userId}&quot;?
                  </span>
                  <button
                    onClick={() => forceRelease.mutate(lock.userId)}
                    disabled={forceRelease.isPending}
                    className="rounded-md bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                    data-testid={`force-release-confirm-${lock.userId}`}
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => setConfirming(null)}
                    className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                    data-testid={`force-release-cancel-${lock.userId}`}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirming(lock.userId)}
                  className="rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                  data-testid={`force-release-btn-${lock.userId}`}
                >
                  Force release
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground/70">
        Force-release abandons any in-flight embedding for the user. Their
        worker may continue writing a few more rows before detecting the
        release (holder-epoch guard checks every 20 pages). No duplicate
        embeddings will be produced — safe for stuck workers.
      </p>
    </div>
  );
}
