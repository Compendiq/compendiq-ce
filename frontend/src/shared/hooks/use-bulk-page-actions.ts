import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch } from '../lib/api';

/**
 * Frontend for the four `/pages/bulk/*` endpoints, which shipped on the
 * backend with no UI at all — a power user re-embedding 200 pages had to click
 * through them one row at a time while the capability sat finished on the
 * server (July-2026 design critique).
 *
 * All four take `{ ids }` in the legacy wire shape. The resolver matches on
 * `pages.id OR pages.confluence_id`, so the integer PK the page list already
 * carries resolves correctly for both standalone and Confluence-sourced pages.
 */

export interface BulkActionResult {
  /** Rows the server actually acted on. */
  succeeded?: number;
  failed?: number;
  notFoundIds?: string[];
  [key: string]: unknown;
}

/** Reads a count out of the varied shapes the four bulk routes return. */
export function bulkAffectedCount(result: BulkActionResult, fallback: number): number {
  for (const key of ['succeeded', 'deleted', 'queued', 'embedded', 'synced', 'updated']) {
    const value = result[key];
    if (typeof value === 'number') return value;
  }
  return fallback;
}

export type BulkAction = 'delete' | 'sync' | 'embed' | 'quality';

const ENDPOINTS: Record<BulkAction, string> = {
  delete: '/pages/bulk/delete',
  sync: '/pages/bulk/sync',
  embed: '/pages/bulk/embed',
  quality: '/pages/bulk/quality',
};

const PAST_TENSE: Record<BulkAction, string> = {
  delete: 'moved to trash',
  sync: 'queued for re-sync',
  embed: 'queued for embedding',
  quality: 'queued for quality analysis',
};

export function useBulkPageAction(onSettled?: () => void) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ action, ids }: { action: BulkAction; ids: string[] }) => {
      const result = await apiFetch<BulkActionResult>(ENDPOINTS[action], {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      return { action, ids, result };
    },
    onSuccess: ({ action, ids, result }) => {
      const count = bulkAffectedCount(result, ids.length);
      toast.success(`${count} ${count === 1 ? 'page' : 'pages'} ${PAST_TENSE[action]}`);

      // notFoundIds is the server telling us part of the selection was stale —
      // silently reporting only the success count would overstate what happened.
      if (result.notFoundIds?.length) {
        toast.warning(
          `${result.notFoundIds.length} ${result.notFoundIds.length === 1 ? 'page' : 'pages'} could not be found — they may have been deleted already.`,
        );
      }

      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['embedding-status'] });
      if (action === 'delete') queryClient.invalidateQueries({ queryKey: ['trash'] });
      onSettled?.();
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Bulk action failed');
    },
  });
}
