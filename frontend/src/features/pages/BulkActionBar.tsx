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
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        role="region"
        aria-label={`Actions for ${count} selected ${noun}`}
        className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 nm-card-elevated flex items-center gap-2.5 rounded-xl px-3 sm:px-4 py-2 max-w-[calc(100vw-2rem)] max-sm:max-w-[calc(100vw-1rem)] max-sm:overflow-x-auto no-scrollbar"
        data-testid="bulk-action-bar"
      >
        {/* Visible copy of the count. Not itself the live region — announcing
            is `liveRegion`'s job, and marking both would say it twice. */}
        <span className="text-sm font-medium shrink-0" data-testid="bulk-selection-count">
          {count} {noun} selected
        </span>

        <span aria-hidden="true" className="h-4 w-px bg-border shrink-0" />

        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            type="button"
            onClick={() => run('embed')}
            disabled={bulk.isPending}
            variant="ghost"
            size="sm"
            className="nm-button-ghost"
            leftIcon={<Database size={14} aria-hidden="true" />}
            data-testid="bulk-embed-btn"
          >
            <span>Re-embed</span>
            <kbd className="ml-1.5 hidden rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline-flex">E</kbd>
          </Button>

          {confluenceCount > 0 && (
            <Button
              type="button"
              onClick={() => run('sync')}
              disabled={bulk.isPending}
              variant="ghost"
              size="sm"
              className="nm-button-ghost"
              leftIcon={<RefreshCw size={14} aria-hidden="true" />}
              data-testid="bulk-sync-btn"
            >
              <span>Re-sync {confluenceCount < count && `(${confluenceCount})`}</span>
              <kbd className="ml-1.5 hidden rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline-flex">S</kbd>
            </Button>
          )}

          <Button
            type="button"
            onClick={() => run('quality')}
            disabled={bulk.isPending}
            variant="ghost"
            size="sm"
            className="nm-button-ghost"
            leftIcon={<Gauge size={14} aria-hidden="true" />}
            data-testid="bulk-quality-btn"
          >
            <span>Re-analyze quality</span>
            <kbd className="ml-1.5 hidden rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline-flex">Q</kbd>
          </Button>

          <Button
            type="button"
            onClick={() => setPendingDelete(true)}
            disabled={bulk.isPending}
            variant="destructive-ghost"
            size="sm"
            className="nm-action-destructive"
            leftIcon={<Trash2 size={14} aria-hidden="true" />}
            data-testid="bulk-delete-btn"
          >
            <span>Move to trash</span>
            <kbd className="ml-1.5 hidden rounded border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 font-mono text-[11px] text-destructive sm:inline-flex">Del</kbd>
          </Button>
        </div>

        {bulk.isPending && (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            Working...
          </span>
        )}

        <Button
          type="button"
          onClick={onClear}
          variant="ghost"
          size="sm"
          className="nm-button-ghost ml-auto"
          leftIcon={<X size={14} aria-hidden="true" />}
          data-testid="bulk-clear-btn"
        >
          <span>Clear selection</span>
          <kbd className="ml-1.5 hidden rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline-flex">Esc</kbd>
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
