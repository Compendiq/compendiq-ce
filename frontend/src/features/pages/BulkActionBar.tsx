import { useState } from 'react';
import { RefreshCw, Database, Gauge, Trash2, X, Loader2 } from 'lucide-react';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { useBulkPageAction, type BulkAction } from '../../shared/hooks/use-bulk-page-actions';

interface BulkActionBarProps {
  /**
   * Ids already mapped to the bulk-route wire shape via `bulkWireId` — the
   * `confluence_id` for synced pages, the PK for standalone ones. These are
   * posted verbatim, so they are not interchangeable with the row ids the
   * selection Set is keyed by.
   */
  selectedIds: string[];
  /** How many of the selected pages came from Confluence — re-sync needs them. */
  confluenceCount: number;
  onClear: () => void;
}

/**
 * Appears once at least one page is selected. Four bulk endpoints existed on
 * the backend with no way to reach them from the UI; this is that way.
 *
 * Re-sync is hidden rather than disabled when nothing selected is
 * Confluence-sourced: a permanently greyed control on a local-only knowledge
 * base is noise, not information.
 */
export function BulkActionBar({ selectedIds, confluenceCount, onClear }: BulkActionBarProps) {
  const [pendingDelete, setPendingDelete] = useState(false);
  const bulk = useBulkPageAction(onClear);

  if (selectedIds.length === 0) return null;

  const count = selectedIds.length;
  const noun = count === 1 ? 'page' : 'pages';
  const run = (action: BulkAction) => bulk.mutate({ action, ids: selectedIds });

  return (
    <>
      <div
        role="region"
        aria-label={`Actions for ${count} selected ${noun}`}
        className="flex flex-wrap items-center gap-3 rounded-xl border border-action/40 bg-action/[0.06] px-4 py-3"
        data-testid="bulk-action-bar"
      >
        <span className="text-sm font-medium" aria-live="polite" data-testid="bulk-selection-count">
          {count} {noun} selected
        </span>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => run('embed')}
            disabled={bulk.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 px-3 py-1.5 text-sm transition-colors hover:bg-foreground/5 disabled:opacity-50"
            data-testid="bulk-embed-btn"
          >
            <Database size={14} aria-hidden="true" />
            Re-embed
          </button>

          {confluenceCount > 0 && (
            <button
              type="button"
              onClick={() => run('sync')}
              disabled={bulk.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 px-3 py-1.5 text-sm transition-colors hover:bg-foreground/5 disabled:opacity-50"
              data-testid="bulk-sync-btn"
            >
              <RefreshCw size={14} aria-hidden="true" />
              Re-sync {confluenceCount < count && `(${confluenceCount})`}
            </button>
          )}

          <button
            type="button"
            onClick={() => run('quality')}
            disabled={bulk.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 px-3 py-1.5 text-sm transition-colors hover:bg-foreground/5 disabled:opacity-50"
            data-testid="bulk-quality-btn"
          >
            <Gauge size={14} aria-hidden="true" />
            Re-analyze quality
          </button>

          <button
            type="button"
            onClick={() => setPendingDelete(true)}
            disabled={bulk.isPending}
            className="nm-button-destructive inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
            data-testid="bulk-delete-btn"
          >
            <Trash2 size={14} aria-hidden="true" />
            Move to trash
          </button>
        </div>

        {bulk.isPending && (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            Working...
          </span>
        )}

        <button
          type="button"
          onClick={onClear}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          data-testid="bulk-clear-btn"
        >
          <X size={14} aria-hidden="true" />
          Clear selection
        </button>
      </div>

      {/* Matches the single-page delete dialog's wording: name the action, the
          reversibility window, and the terminal consequence. */}
      <ConfirmDialog
        open={pendingDelete}
        title={`Move ${count} ${noun} to trash?`}
        description={`${count === 1 ? 'It' : 'They'} can be restored from Trash for 30 days, then ${count === 1 ? 'it is' : 'they are'} permanently deleted.`}
        confirmLabel={`Move ${count} ${noun} to trash`}
        destructive
        onConfirm={() => {
          setPendingDelete(false);
          run('delete');
        }}
        onCancel={() => setPendingDelete(false)}
      />
    </>
  );
}
