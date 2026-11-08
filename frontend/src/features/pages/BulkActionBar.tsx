import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { m } from 'framer-motion';
import { RefreshCw, Database, Gauge, Trash2, X, Loader2, Shield } from 'lucide-react';
import type { AiPolicy } from '@compendiq/contracts';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { Button } from '../../shared/components/Button';
import { bulkTrashConfirmCopy } from '../../shared/lib/trash-copy';
import { useBulkPageAction, type BulkAction } from '../../shared/hooks/use-bulk-page-actions';
import { useBulkUpdateAiPolicy, describeAiPolicyRefusal } from '../../shared/hooks/use-pages';
import { AI_POLICY_CHIP_LABEL, NO_AI_CONFIRMATION, bulkPolicyFailureMessage } from '../../shared/lib/article-ai-policy';
import { useKeyboardShortcuts, type ShortcutDefinition } from '../../shared/hooks/use-keyboard-shortcuts';

/**
 * #283 — what the bulk policy action can send for the current selection.
 * `items` are the rows whose policy and revision the list carried (internal
 * numeric page id + compare-and-set revision — NOT the Confluence wire ids
 * the other bulk routes take); `missing` counts selected rows it could not
 * build an item for. The action refuses to run while `missing > 0` rather
 * than send a partial request the server would treat as the whole selection.
 */
export interface BulkAiPolicySelection {
  items: Array<{ pageId: number; expectedRevision: number; aiPolicy: AiPolicy }>;
  missing: number;
}

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
  /** #283 bulk policy items; omitted by callers that have no policy data. */
  policySelection?: BulkAiPolicySelection;
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
export function BulkActionBar({ selectedIds, confluenceCount, policySelection, onClear }: BulkActionBarProps) {
  const [pendingDelete, setPendingDelete] = useState(false);
  const bulk = useBulkPageAction(onClear);

  // #283 bulk AI policy. The draft policy is local until the server commits;
  // the result (success or the typed refusal) is reported from the response,
  // and a refusal keeps the selection and the draft so the user can refresh
  // and review rather than lose their place.
  const policyBulk = useBulkUpdateAiPolicy();
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyDraft, setPolicyDraft] = useState<AiPolicy>('all');
  const [policyConfirm, setPolicyConfirm] = useState(false);
  const [policyNotice, setPolicyNotice] = useState('');
  const policyButtonRef = useRef<HTMLButtonElement | null>(null);
  const policyItems = useMemo(() => policySelection?.items ?? [], [policySelection?.items]);
  const policyMissing = policySelection?.missing ?? 0;
  const policyAvailable = policySelection !== undefined && policyItems.length > 0 && policyMissing === 0;

  const count = selectedIds.length;
  const noun = count === 1 ? 'page' : 'pages';
  const run = useCallback((action: BulkAction) => bulk.mutate({ action, ids: selectedIds }), [bulk, selectedIds]);
  const deleteCopy = bulkTrashConfirmCopy(count, confluenceCount);

  const submitPolicy = useCallback(() => {
    setPolicyConfirm(false);
    if (!policyAvailable || policyBulk.isPending) return;
    setPolicyNotice('');
    policyBulk.mutate(
      {
        aiPolicy: policyDraft,
        items: policyItems.map(({ pageId, expectedRevision }) => ({ pageId, expectedRevision })),
      },
      {
        onSuccess: () => {
          setPolicyNotice(`AI policy set to ${AI_POLICY_CHIP_LABEL[policyDraft]} on ${policyItems.length} ${policyItems.length === 1 ? 'page' : 'pages'}.`);
          setPolicyOpen(false);
          onClear();
        },
        onError: (error) => {
          setPolicyNotice(bulkPolicyFailureMessage(describeAiPolicyRefusal(error), policyItems.length));
        },
      },
    );
  }, [policyAvailable, policyBulk, policyDraft, policyItems, onClear]);

  // Closing the policy panel (Escape, Cancel, success) returns focus to the
  // trigger so a keyboard user is not dropped onto <body>.
  const closePolicy = useCallback(() => {
    setPolicyOpen(false);
    queueMicrotask(() => policyButtonRef.current?.focus());
  }, []);
  useEffect(() => {
    if (count === 0) { setPolicyOpen(false); setPolicyNotice(''); }
  }, [count]);

  const shortcuts = useMemo<ShortcutDefinition[]>(() => {
    if (count === 0 || bulk.isPending || pendingDelete || policyOpen || policyBulk.isPending) return [];
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
  }, [count, bulk.isPending, pendingDelete, policyOpen, policyBulk.isPending, confluenceCount, onClear, run]);

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
        className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 nm-popover-glass flex items-center gap-1.5 sm:gap-2.5 rounded-2xl px-2 py-1.5 sm:px-3 sm:py-2 max-w-[calc(100vw-1.5rem)] overflow-x-auto no-scrollbar"
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
            <kbd className="ml-1.5 hidden rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground xl:inline-flex">E</kbd>
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
              <kbd className="ml-1.5 hidden rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground xl:inline-flex">S</kbd>
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
            <kbd className="ml-1.5 hidden rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground xl:inline-flex">Q</kbd>
          </Button>

          {/* #283 bulk AI policy. Offered only when the caller supplied
              policy data; `aria-disabled` (not `disabled`) when the selection
              cannot be sent whole, so the reason stays reachable by keyboard. */}
          {policySelection !== undefined && (
            <Button
              type="button"
              ref={policyButtonRef}
              onClick={() => { if (policyAvailable) setPolicyOpen((v) => !v); }}
              aria-disabled={!policyAvailable || bulk.isPending}
              aria-expanded={policyOpen}
              aria-controls="bulk-ai-policy-panel"
              aria-describedby={policyAvailable ? undefined : 'bulk-ai-policy-unavailable'}
              variant="ghost"
              size="sm"
              className="nm-button-ghost h-7 px-2 sm:px-2.5 text-xs shrink-0"
              leftIcon={<Shield size={13} aria-hidden="true" />}
              data-testid="bulk-ai-policy-btn"
              aria-label={`Set AI policy for ${policyItems.length} selected ${policyItems.length === 1 ? 'page' : 'pages'}`}
            >
              <span>AI policy</span>
            </Button>
          )}

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
            <kbd className="ml-1.5 hidden rounded border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 font-mono text-[11px] text-destructive xl:inline-flex">Del</kbd>
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
          <kbd className="ml-1.5 hidden rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground xl:inline-flex">Esc</kbd>
        </Button>
      </m.div>

      {/* #283 bulk AI policy. The unavailable reason is real text wired via
          aria-describedby, so a keyboard/touch user learns WHY without a
          hover tooltip. The notice is a live region that persists while the
          selection does; a refusal names how many rows, never which. */}
      {policySelection !== undefined && (
        <div className="sr-only" id="bulk-ai-policy-unavailable">
          {policyMissing > 0
            ? `AI policy cannot be changed for this selection: ${policyMissing} selected ${policyMissing === 1 ? 'row does' : 'rows do'} not carry a current policy revision. Browse the list (not search results) and refresh, then select again.`
            : policyItems.length === 0 ? 'No selected page carries a policy revision.' : ''}
        </div>
      )}
      <span className="sr-only" role="status" aria-live="polite" data-testid="bulk-ai-policy-notice-live">{policyNotice}</span>
      {policySelection !== undefined && policyNotice && !policyOpen && (
        <p
          className="fixed bottom-24 left-1/2 z-40 -translate-x-1/2 max-w-[calc(100vw-1.5rem)] rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground"
          data-testid="bulk-ai-policy-notice"
        >
          {policyNotice}
        </p>
      )}
      {policyOpen && policyAvailable && (
        <div
          id="bulk-ai-policy-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="bulk-ai-policy-title"
          className="nm-card-elevated fixed bottom-24 left-1/2 z-40 w-[min(28rem,calc(100vw-1.5rem))] -translate-x-1/2 space-y-3 rounded-xl p-4 text-xs"
          data-testid="bulk-ai-policy-panel"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closePolicy(); } }}
        >
          <h3 id="bulk-ai-policy-title" className="text-sm font-semibold">
            Set AI policy on {policyItems.length} selected {policyItems.length === 1 ? 'page' : 'pages'}
          </h3>
          <p className="text-muted-foreground">
            All-or-nothing: the server applies the change to every selected page or to none. Pages you are
            not authorized to change, or whose policy changed since this list was read, refuse the whole request.
          </p>
          <label className="block">
            New policy
            <select
              className="nm-select-md mt-1 w-full"
              value={policyDraft}
              disabled={policyBulk.isPending}
              onChange={(e) => setPolicyDraft(e.target.value as AiPolicy)}
              data-testid="bulk-ai-policy-select"
              autoFocus
            >
              {(Object.keys(AI_POLICY_CHIP_LABEL) as AiPolicy[]).map((value) => (
                <option key={value} value={value}>{AI_POLICY_CHIP_LABEL[value]}</option>
              ))}
            </select>
          </label>
          {policyNotice && <p role="alert" data-testid="bulk-ai-policy-notice">{policyNotice}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" className="nm-button-ghost h-8 px-3 text-xs" onClick={closePolicy} disabled={policyBulk.isPending}>
              Cancel
            </button>
            <button
              type="button"
              className="nm-button-primary h-8 px-3 text-xs"
              aria-disabled={policyBulk.isPending}
              data-testid="bulk-ai-policy-apply"
              onClick={() => {
                if (policyBulk.isPending) return;
                if (policyDraft === 'none') setPolicyConfirm(true); else submitPolicy();
              }}
            >
              {policyBulk.isPending ? 'Applying…' : `Apply ${AI_POLICY_CHIP_LABEL[policyDraft]}`}
            </button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={policyConfirm}
        title={`${NO_AI_CONFIRMATION.title.replace('this article', `${policyItems.length} selected ${policyItems.length === 1 ? 'page' : 'pages'}`)}`}
        description={`The committed change removes ${NO_AI_CONFIRMATION.removes.join(', ')} on every selected page. It keeps ${NO_AI_CONFIRMATION.remains.join(', ')}. ${NO_AI_CONFIRMATION.limits.join(' ')}`}
        confirmLabel={NO_AI_CONFIRMATION.confirmLabel}
        onConfirm={submitPolicy}
        onCancel={() => setPolicyConfirm(false)}
      />

      {/* The copy lives in `trash-copy.ts` because three surfaces confirm the
          same two cascading deletes — this bar, the article inspector and the
          page view — and a fourth hand-written variant is how one of them ends
          up promising a restore the request will not give. */}
      <ConfirmDialog
        open={pendingDelete}
        title={deleteCopy.title}
        description={deleteCopy.description}
        confirmLabel={deleteCopy.confirmLabel}
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
