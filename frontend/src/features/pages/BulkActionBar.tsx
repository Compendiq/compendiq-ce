import { useState, useMemo, useCallback } from 'react';
import { m } from 'framer-motion';
import { RefreshCw, Database, Gauge, Trash2, X, Loader2 } from 'lucide-react';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { Button } from '../../shared/components/Button';
import { useBulkPageAction, type BulkAction } from '../../shared/hooks/use-bulk-page-actions';
import { useKeyboardShortcuts, type ShortcutDefinition } from '../../shared/hooks/use-keyboard-shortcuts';

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
 * Floating bottom dock keeps actions accessible wherever the user scrolls.
 * Re-sync is hidden rather than disabled when nothing selected is
 * Confluence-sourced: a permanently greyed control on a local-only knowledge
 * base is noise, not information.
 */
export function BulkActionBar({ selectedIds, confluenceCount, onClear }: BulkActionBarProps) {
  const [pendingDelete, setPendingDelete] = useState(false);
  const bulk = useBulkPageAction(onClear);

  const count = selectedIds.length;
  const noun = count === 1 ? 'page' : 'pages';
  const run = useCallback((action: BulkAction) => bulk.mutate({ action, ids: selectedIds }), [bulk, selectedIds]);

  const shortcuts = useMemo<ShortcutDefinition[]>(() => {
    if (count === 0 || bulk.isPending || pendingDelete) return [];
    const list: ShortcutDefinition[] = [
      {
        key: 'e',
        keys: ['e', 'E'],
        description: 'Re-embed selected pages',
        category: 'actions',
        action: () => run('embed'),
      },
      {
        key: 'q',
        keys: ['q', 'Q'],
        description: 'Re-analyze quality of selected pages',
        category: 'actions',
        action: () => run('quality'),
      },
      {
        key: 'Delete',
        keys: ['Delete', 'Backspace'],
        description: 'Move selected pages to trash',
        category: 'actions',
        action: () => setPendingDelete(true),
      },
      {
        key: 'Escape',
        keys: ['Escape'],
        description: 'Clear page selection',
        category: 'actions',
        action: onClear,
      },
    ];
    if (confluenceCount > 0) {
      list.push({
        key: 's',
        keys: ['s', 'S'],
        description: 'Re-sync selected Confluence pages',
        category: 'actions',
        action: () => run('sync'),
      });
    }
    return list;
  }, [count, bulk.isPending, pendingDelete, confluenceCount, onClear, run]);

  useKeyboardShortcuts(shortcuts);

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
      <m.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 16 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        role="region"
        aria-label={`Actions for ${count} selected ${noun}`}
        className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 nm-card-elevated flex items-center gap-1.5 sm:gap-2.5 rounded-2xl px-2 py-1.5 sm:px-3 sm:py-2 max-w-[calc(100vw-1.5rem)] shadow-overlay border border-border overflow-x-auto no-scrollbar"
        data-testid="bulk-action-bar"
      >
        {/* Selection count badge */}
        <div className="flex items-center gap-1.5 rounded-lg bg-muted/80 px-2 sm:px-2.5 py-1 text-foreground shrink-0 select-none">
          <span className="text-xs font-semibold tabular-nums" data-testid="bulk-selection-count">
            {count} {noun} selected
          </span>
        </div>

        <span aria-hidden="true" className="h-4 w-px bg-border shrink-0" />

        {/* Bulk action buttons */}
        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          <Button
            type="button"
            onClick={() => run('embed')}
            disabled={bulk.isPending}
            variant="ghost"
            size="sm"
            className="nm-button-ghost h-7 px-2 sm:px-2.5 text-xs shrink-0"
            leftIcon={<Database size={13} aria-hidden="true" />}
            data-testid="bulk-embed-btn"
            title="Re-embed selected pages (E)"
            aria-label="Re-embed selected pages"
          >
            <span>Re-embed</span>
            <kbd className="ml-1.5 hidden rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground xl:inline-flex">E</kbd>
          </Button>

          {confluenceCount > 0 && (
            <Button
              type="button"
              onClick={() => run('sync')}
              disabled={bulk.isPending}
              variant="ghost"
              size="sm"
              className="nm-button-ghost h-7 px-2 sm:px-2.5 text-xs shrink-0"
              leftIcon={<RefreshCw size={13} aria-hidden="true" />}
              data-testid="bulk-sync-btn"
              title="Re-sync selected Confluence pages (S)"
              aria-label="Re-sync selected Confluence pages"
            >
              <span>Re-sync{confluenceCount < count ? ` (${confluenceCount})` : ''}</span>
              <kbd className="ml-1.5 hidden rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground xl:inline-flex">S</kbd>
            </Button>
          )}

          <Button
            type="button"
            onClick={() => run('quality')}
            disabled={bulk.isPending}
            variant="ghost"
            size="sm"
            className="nm-button-ghost h-7 px-2 sm:px-2.5 text-xs shrink-0"
            leftIcon={<Gauge size={13} aria-hidden="true" />}
            data-testid="bulk-quality-btn"
            title="Re-analyze quality of selected pages (Q)"
            aria-label="Re-analyze quality of selected pages"
          >
            <span><span className="hidden lg:inline">Re-analyze </span>Quality</span>
            <kbd className="ml-1.5 hidden rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground xl:inline-flex">Q</kbd>
          </Button>

          <Button
            type="button"
            onClick={() => setPendingDelete(true)}
            disabled={bulk.isPending}
            variant="destructive-ghost"
            size="sm"
            className="nm-action-destructive h-7 px-2 sm:px-2.5 text-xs shrink-0"
            leftIcon={<Trash2 size={13} aria-hidden="true" />}
            data-testid="bulk-delete-btn"
            title="Move selected pages to trash (Del)"
            aria-label="Move selected pages to trash"
          >
            <span><span className="hidden md:inline">Move to </span>Trash</span>
            <kbd className="ml-1.5 hidden rounded border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 font-mono text-[10px] text-destructive xl:inline-flex">Del</kbd>
          </Button>
        </div>

        {bulk.isPending && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0 px-1" role="status" aria-live="polite">
            <Loader2 size={13} className="animate-spin text-action" aria-hidden="true" />
            <span className="hidden sm:inline font-medium">Working…</span>
          </div>
        )}

        <Button
          type="button"
          onClick={onClear}
          variant="ghost"
          size="sm"
          className="nm-button-ghost h-7 px-2 sm:px-2.5 text-xs shrink-0 ml-auto"
          leftIcon={<X size={13} aria-hidden="true" />}
          data-testid="bulk-clear-btn"
          title="Clear selection (Esc)"
          aria-label="Clear selection"
        >
          <span>Clear<span className="hidden sm:inline"> selection</span></span>
          <kbd className="ml-1.5 hidden rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground xl:inline-flex">Esc</kbd>
        </Button>
      </m.div>

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
