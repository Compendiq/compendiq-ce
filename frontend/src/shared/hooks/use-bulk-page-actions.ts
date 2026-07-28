import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch } from '../lib/api';

/**
 * Frontend for the four `/pages/bulk/*` endpoints, which shipped on the
 * backend with no UI at all — a power user re-embedding 200 pages had to click
 * through them one row at a time while the capability sat finished on the
 * server (July-2026 design critique).
 *
 * All four take `{ ids }` in the legacy *mixed* wire shape: the `confluence_id`
 * for synced pages, the integer PK for standalone ones. See `bulkWireId` — the
 * page list carries the PK for both, so the mapping is not a no-op.
 */

/** The subset of a page-list row needed to address it in a bulk request. */
export interface BulkAddressablePage {
  id: string;
  confluenceId?: string | null;
  source?: string;
}

/**
 * Maps a page-list row to the id the bulk routes expect.
 *
 * `GET /pages` returns the integer PK as `id` for every row, but the bulk
 * resolver runs ids-mode in 'mixed' mode: it matches on
 * `pages.id OR pages.confluence_id`, then maps each row it found back to
 * `confluence_id` for anything not standalone. Sending the PK for a synced
 * page therefore resolved and acted on the row, but the id never matched on
 * the way back — so the server counted every synced page as not-found and
 * reported it in `failed`/`errors` on an operation that had in fact succeeded.
 *
 * Mirrors the server's own branch (`bulk-page-selection.ts`) rather than a
 * plain `confluenceId ?? id`, so a standalone row that somehow carries a
 * `confluenceId` is still addressed by PK.
 */
export function bulkWireId(page: BulkAddressablePage): string {
  if (page.source === 'standalone') return page.id;
  return page.confluenceId ?? page.id;
}

/**
 * What all four bulk routes return, verified against every handler in
 * `backend/src/routes/knowledge/pages-crud.ts`.
 *
 * Deliberately has no index signature: the previous shape guessed at optional
 * `notFoundIds`/`deleted`/`queued` keys that no route sends, and the catch-all
 * let that mismatch typecheck. `errors` is the only place a partial failure is
 * ever described, so it must not be dropped.
 */
export interface BulkActionResult {
  succeeded?: number;
  failed?: number;
  errors?: string[];
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

function plural(count: number): string {
  return count === 1 ? 'page' : 'pages';
}

export function useBulkPageAction(onSettled?: () => void) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ action, ids }: { action: BulkAction; ids: string[] }) =>
      apiFetch<BulkActionResult>(ENDPOINTS[action], {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),
    onSuccess: (result, { action }) => {
      const succeeded = result.succeeded ?? 0;
      const failed = result.failed ?? 0;

      if (succeeded > 0) {
        toast.success(`${succeeded} ${plural(succeeded)} ${PAST_TENSE[action]}`);
      }

      // `failed` + `errors` are the only channel these routes have for a
      // partial failure: a bulk delete rejects pages the user doesn't own, a
      // bulk sync fails per page, a bulk delete hits "Confluence not
      // configured". Reporting the success count alone told the user
      // everything had worked.
      if (failed > 0) {
        const base = `${failed} ${plural(failed)} could not be ${PAST_TENSE[action]}`;
        const detail = result.errors?.[0];
        toast.warning(detail ? `${base} — ${detail}` : `${base}.`);
      }

      // Neither succeeded nor failed: the server accepted the request and did
      // nothing. Re-embed does this for a selection with no Confluence-sourced
      // pages, since embedding requires a confluence_id. Silence would read as
      // success.
      if (succeeded === 0 && failed === 0) {
        toast.warning(`No pages were ${PAST_TENSE[action]}.`);
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
