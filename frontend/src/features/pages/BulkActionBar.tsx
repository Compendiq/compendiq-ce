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

  const count = selectedIds.length;
  const noun = count === 1 ? 'page' : 'pages';
  const run = (action: BulkAction) => bulk.mutate({ action, ids: selectedIds });

  // Mounted whether or not anything is selected. A live region that appears at
  // the same moment as its own text is not announced by most screen readers —
  // the region has to already exist and then change — so the first selection,
  // the one that reveals the bar, was silent.
  const liveRegion = (
    <span className="sr-only" aria-live="polite" data-testid="bulk-selection-live">
      {count > 0 ? `${count} ${noun} selected` : ''}
    </span>
  );

  if (count === 0) return liveRegion;

  return (
    <>
      {liveRegion}
      <div
        role="region"
        aria-label={`Actions for ${count} selected ${noun}`}
        className="flex flex-wrap items-center gap-2 py-1"
        data-testid="bulk-action-bar"
      >
        {/* Visible copy of the count. Not itself the live region — announcing
            is `liveRegion`'s job, and marking both would say it twice. */}
        <span className="text-sm font-medium" data-testid="bulk-selection-count">
          {count} {noun} selected
        </span>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => run('embed')}
            disabled={bulk.isPending}
            className="nm-button-ghost h-8 gap-1.5 px-2.5 text-sm disabled:opacity-50"
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
              className="nm-button-ghost h-8 gap-1.5 px-2.5 text-sm disabled:opacity-50"
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
            className="nm-button-ghost h-8 gap-1.5 px-2.5 text-sm disabled:opacity-50"
            data-testid="bulk-quality-btn"
          >
            <Gauge size={14} aria-hidden="true" />
            Re-analyze quality
          </button>

          <button
            type="button"
            onClick={() => setPendingDelete(true)}
            disabled={bulk.isPending}
            className="nm-action-destructive inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm"
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
          className="nm-button-ghost ml-auto h-8 gap-1.5 px-2.5 text-sm"
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
