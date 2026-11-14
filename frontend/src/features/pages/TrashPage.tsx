import { useState, useMemo, useRef, useEffect, useId, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import type { RestorePageBody } from '@compendiq/contracts';
import { m, AnimatePresence } from 'framer-motion';
import { ArrowLeft, RotateCcw, Trash2, Search, X, CheckSquare, Square, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTrash, useRestorePage, useLocalSpaces } from '../../shared/hooks/use-standalone';
import { HeaderHost } from '../../shared/components/layout/header-slot';
import { Button, IconButton } from '../../shared/components/Button';
import { ApiError } from '../../shared/lib/api';
import { useNoticeRetry } from '../../shared/hooks/use-notice-retry';

/**
 * The server's reason, when there is one. A restore can be REFUSED with a
 * specific, actionable sentence (#1636: 409 `Restore "<parent>" first`), and a
 * flat "Failed to restore page" tells the person looking at the Trash nothing
 * about what to do next. The fallback stays for a genuinely message-less
 * failure.
 */
function restoreFailureMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Failed to restore page';
}

/**
 * #1636 — the restore route answers 409 when the target's ANCESTOR is still in
 * the trash (restoring it alone would put it back at the tree root). Inside a
 * bulk restore that ancestor is usually part of the same selection, so the
 * refusal is transient, not a failure.
 *
 * Only an ancestor refusal can be resolved by another selected restore. Missing
 * spaces, import conflicts and ambiguity remain permanent bulk failures; a
 * missing space requires a separate, deliberate single-page recovery.
 */
const ANCESTOR_TRASHED_REASON = 'restore_ancestor_trashed';

function isAncestorConflict(error: unknown): boolean {
  return error instanceof ApiError && error.reason === ANCESTOR_TRASHED_REASON;
}

interface RestoreTargetRequest {
  pageId: string;
  title: string;
  message: string;
  targetSpaceKey: string;
}

function canChooseRestoreTarget(error: unknown): boolean {
  if (!(error instanceof ApiError)
    || error.statusCode !== 409
    || error.reason !== 'restore_space_missing') return false;
  const body = error.body;
  return typeof body === 'object'
    && body !== null
    && !Array.isArray(body)
    && 'canChooseTarget' in body
    && body.canChooseTarget === true;
}

function RestoreTargetDialog({
  request,
  busy,
  contentRef,
  onTargetChange,
  onRestore,
  onCancel,
  onCloseAutoFocus,
}: {
  request: RestoreTargetRequest;
  busy: boolean;
  contentRef: RefObject<HTMLDivElement | null>;
  onTargetChange: (targetSpaceKey: string) => void;
  onRestore: (targetSpaceKey: string) => void;
  onCancel: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { data: spaces, isPending, isError, refetch } = useLocalSpaces();
  const helpRef = useRef<HTMLParagraphElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const { retryInFlight, onRetry } = useNoticeRetry(refetch, isError, helpRef);
  const selectId = useId();
  const messageId = useId();
  const helpId = useId();
  const localSpaces = useMemo(
    () => (spaces ?? []).filter((space) => space.source === 'local' && space.key !== '__local__'),
    [spaces],
  );
  const selectedTarget = request.targetSpaceKey === '__local__'
    || localSpaces.some((space) => space.key === request.targetSpaceKey)
    ? request.targetSpaceKey
    : '';

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          ref={contentRef}
          className="nm-card-elevated fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col p-5 outline-none"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            selectRef.current?.focus();
          }}
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}
        >
          <div className="min-h-0 space-y-4 overflow-y-auto">
            <div className="space-y-2">
              <Dialog.Title className="text-base font-semibold">Restore article</Dialog.Title>
              <p className="break-words text-sm font-medium">{request.title}</p>
              <Dialog.Description
                className="text-sm text-muted-foreground"
                aria-live="polite"
                aria-atomic="true"
              >
                <span id={messageId}>{request.message}</span>
              </Dialog.Description>
            </div>

            <div className="space-y-2">
              <label htmlFor={selectId} className="block text-sm font-medium">Local space</label>
              <select
                ref={selectRef}
                id={selectId}
                value={selectedTarget}
                aria-describedby={`${messageId} ${helpId}`}
                aria-disabled={busy}
                onChange={(event) => { if (!busy) onTargetChange(event.currentTarget.value); }}
                className="nm-select-md w-full"
              >
                <option value="">Choose a space…</option>
                <option value="__local__">No space — a personal article</option>
                {localSpaces.map((space) => (
                  <option key={space.key} value={space.key}>{space.name} ({space.key})</option>
                ))}
              </select>
              <p ref={helpRef} id={helpId} tabIndex={-1} className="text-xs text-muted-foreground">
                Choose a local space or no space, then retry restore.
              </p>
            </div>

            {(isError || retryInFlight) ? (
              <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>
                  {spaces
                    ? 'Could not refresh local spaces. Showing the last loaded spaces, which may be out of date.'
                    : 'Could not load local spaces. Please try again.'}
                </span>
                <button
                  type="button"
                  className="underline aria-disabled:cursor-default aria-disabled:opacity-70"
                  aria-disabled={retryInFlight}
                  onClick={onRetry}
                >
                  {retryInFlight ? 'Retrying…' : 'Retry'}
                </button>
              </div>
            ) : isPending ? (
              <p role="status" className="text-sm text-muted-foreground">Loading local spaces…</p>
            ) : localSpaces.length === 0 ? (
              <p className="text-sm text-muted-foreground">No local spaces are available. You can choose no space.</p>
            ) : null}
            {busy && <p role="status" className="text-sm text-muted-foreground">Restoring article…</p>}
          </div>

          <div className="mt-5 flex shrink-0 justify-end gap-2">
            <Button
              variant="secondary"
              aria-disabled={busy}
              onClick={() => { if (!busy) onCancel(); }}
            >
              Cancel
            </Button>
            <Button
              aria-disabled={busy || !selectedTarget}
              aria-busy={busy || undefined}
              className="aria-disabled:cursor-default aria-disabled:opacity-70"
              leftIcon={busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : undefined}
              onClick={() => { if (!busy && selectedTarget) onRestore(selectedTarget); }}
            >
              Retry restore
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function TrashPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: trashData, isLoading, isError, refetch } = useTrash();
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const { retryInFlight, onRetry } = useNoticeRetry(refetch, isError, descriptionRef);
  const restoreMutation = useRestorePage();
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  const restoreControlsRef = useRef(new Map<string, HTMLButtonElement>());
  const bulkRestoreRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dialogOriginRef = useRef<string | null>(null);
  const focusRecoveryRef = useRef<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkRestoring, setIsBulkRestoring] = useState(false);
  const [restoringPageId, setRestoringPageId] = useState<string | null>(null);
  const [rehomeRequest, setRehomeRequest] = useState<RestoreTargetRequest | null>(null);
  const selectionRef = useRef(selectedIds);
  const restoreBusy = restoringPageId !== null || isBulkRestoring;

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => { selectionRef.current = selectedIds; }, [selectedIds]);

  const items = useMemo(() => trashData?.items ?? [], [trashData?.items]);

  useEffect(() => {
    const pageId = focusRecoveryRef.current;
    if (!pageId || items.some((item) => item.id === pageId)) return;
    focusRecoveryRef.current = null;
    if (document.activeElement === document.body) descriptionRef.current?.focus();
  }, [items, rehomeRequest, restoringPageId]);

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const query = searchQuery.toLowerCase().trim();
    return items.filter((item) => item.title.toLowerCase().includes(query));
  }, [items, searchQuery]);

  const handleRestore = async (pageId: string, title: string, body?: RestorePageBody) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setRestoringPageId(pageId);
    const active = document.activeElement;
    const ownedFocus = active === restoreControlsRef.current.get(pageId)
      || (active !== null && dialogRef.current?.contains(active) === true);
    try {
      await restoreMutation.mutateAsync({ pageId, body });
      if (ownedFocus) focusRecoveryRef.current = pageId;
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(pageId);
        return next;
      });
      setRehomeRequest(null);
      toast.success('Page restored');
    } catch (error) {
      const message = restoreFailureMessage(error);
      if (canChooseRestoreTarget(error)) {
        dialogOriginRef.current = pageId;
        setRehomeRequest({ pageId, title, message, targetSpaceKey: '' });
      } else if (body && rehomeRequest?.pageId === pageId
        && error instanceof ApiError && error.statusCode === 409
        && error.reason === 'restore_target_space_invalid') {
        setRehomeRequest({ pageId, title, message, targetSpaceKey: '' });
        void queryClient.invalidateQueries({ queryKey: ['local-spaces'] });
      } else {
        setRehomeRequest(null);
        toast.error(message);
      }
    } finally {
      busyRef.current = false;
      setRestoringPageId(null);
    }
  };

  const handleBulkRestore = async () => {
    if (selectedIds.size === 0 || busyRef.current) return;
    busyRef.current = true;
    setIsBulkRestoring(true);
    const ids = Array.from(selectedIds);
    try {
      const restoredIds = new Set<string>();
      // Keyed by id so a later pass can retract an earlier refusal: the same id
      // must not be reported as failed once it has actually come back.
      const failures = new Map<string, unknown>();

      // One cascade puts a parent and its sub-articles in ONE batch, and one
      // request per selected row means whichever lands first restores the whole
      // batch — so a sibling is refused (409) for an ancestor that is itself in
      // this selection. Those refusals are transient and have to be re-asked.
      //
      // Re-asking is a LOOP of passes, not one extra pass, because one pass can
      // only clear one level: with A -> B -> C each trashed by a separate action
      // (three distinct `deleted_at` batches, so three separate restores), pass
      // 1 restores A while B and C are both refused, and firing B and C
      // together again lets C observe B still trashed. Ids inside a pass stay
      // concurrent; it is the passes that must be serialised.
      //
      // The loop stops the moment a pass fails to shrink the refused set. That
      // is a genuine block — an ancestor outside this selection — and another
      // identical pass would only re-ask the server for a decision it has
      // already made. Each pass therefore either shrinks `pending` or ends the
      // loop, so the number of passes is bounded by the selection size.
      let pending = ids;
      while (pending.length > 0) {
        const results = await Promise.allSettled(
          pending.map((pageId) => restoreMutation.mutateAsync({ pageId })),
        );
        const refused: string[] = [];
        pending.forEach((id, index) => {
          const result = results[index]!;
          if (result.status === 'fulfilled') {
            restoredIds.add(id);
            failures.delete(id);
            return;
          }
          failures.set(id, result.reason);
          if (isAncestorConflict(result.reason)) refused.push(id);
        });
        if (refused.length >= pending.length) break;
        pending = refused;
      }

      // Reported in selection order, so the sentence the user reads does not
      // depend on which request happened to settle first.
      const failureReasons = ids.filter((id) => failures.has(id)).map((id) => failures.get(id));

      // Prune exactly what came back, in BOTH outcomes. A partial restore used
      // to leave the succeeded ids selected while their rows left the list (the
      // mutation invalidates `['trash']`), so the floating bar kept a stale
      // count, `toggleSelectAll`'s size comparison went wrong, and pressing
      // Restore Selected again re-POSTed already-live ids — answered 200
      // `restored: false` — under a toast that claimed a fresh restore. The
      // failed ids stay selected on purpose: they are exactly what a retry is.
      if (restoredIds.size > 0) {
        const currentSelection = selectionRef.current;
        if (document.activeElement === bulkRestoreRef.current
          && currentSelection.size > 0
          && Array.from(currentSelection).every((id) => restoredIds.has(id))) {
          descriptionRef.current?.focus();
        }
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const id of restoredIds) next.delete(id);
          return next;
        });
      }

      if (failureReasons.length === 0) {
        toast.success(`Restored ${ids.length} ${ids.length === 1 ? 'page' : 'pages'}`);
      } else {
        // Say what actually happened, then why: a partial restore that reports
        // only the failure reads as "nothing worked".
        const reason = restoreFailureMessage(failureReasons[0]);
        toast.error(
          restoredIds.size > 0
            ? `Restored ${restoredIds.size} of ${ids.length} pages. ${reason}`
            : `Failed to restore ${ids.length === 1 ? 'the page' : 'the selected pages'}. ${reason}`,
        );
      }
    } finally {
      busyRef.current = false;
      setIsBulkRestoring(false);
    }
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredItems.length && filteredItems.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredItems.map((item) => item.id)));
    }
  };

  const toggleSelectItem = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const daysUntilPurge = (autoPurgeAt: string) => {
    const now = new Date();
    const purge = new Date(autoPurgeAt);
    const diff = Math.ceil((purge.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return Math.max(0, diff);
  };

  const allFilteredSelected =
    filteredItems.length > 0 && selectedIds.size === filteredItems.length;

  return (
    <div className="space-y-6">
      <HeaderHost fallbackClassName="flex items-center gap-3">
        <IconButton onClick={() => navigate('/')} label="Back to Pages" icon={<ArrowLeft size={18} />} />
        <h1 className="text-[15px] font-semibold sm:text-lg">Trash</h1>
      </HeaderHost>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p ref={descriptionRef} tabIndex={-1} className="text-sm text-muted-foreground">
          Deleted pages are automatically purged 30 days after deletion
        </p>

        {items.length > 0 && (
          <div className="relative w-full sm:w-64">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="text"
              placeholder="Search trash…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="nm-input h-9 w-full pl-9 pr-8 text-sm"
              data-testid="trash-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      {(isError || retryInFlight) && (
        <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>
            {trashData
              ? 'Could not refresh trash. Showing the last loaded results, which may be out of date.'
              : 'Could not load trash. Please try again.'}
          </span>
          <button
            type="button"
            className="underline aria-disabled:cursor-default aria-disabled:opacity-70"
            aria-disabled={retryInFlight}
            onClick={onRetry}
          >
            {retryInFlight ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      {/* Trash list */}
      {!trashData && (isError || retryInFlight) ? null : isLoading ? (
        <div className="space-y-3" role="status" aria-label="Loading trash">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="nm-card h-16 animate-pulse" />
          ))}
        </div>
      ) : !items.length ? (
        <div className="nm-card flex flex-col items-center justify-center py-16 text-center" data-testid="trash-empty">
          <Trash2 size={48} className="mb-4 text-muted-foreground" />
          <p className="text-lg font-medium">No pages in trash</p>
          <p className="text-sm text-muted-foreground">
            Deleted local pages will appear here
          </p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="nm-card flex flex-col items-center justify-center py-12 text-center" data-testid="trash-no-match">
          <p className="text-sm font-medium text-foreground">No matching deleted pages</p>
          <p className="mt-1 text-xs text-muted-foreground">Try clearing the search filter</p>
        </div>
      ) : (
        <div className="space-y-3" data-testid="trash-list">
          <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
            <button
              type="button"
              onClick={toggleSelectAll}
              className="flex items-center gap-2 font-medium hover:text-foreground"
              data-testid="trash-select-all"
            >
              {allFilteredSelected ? (
                <CheckSquare size={16} className="text-action" />
              ) : (
                <Square size={16} />
              )}
              <span>Select all ({filteredItems.length})</span>
            </button>
          </div>

          <div className="space-y-2">
            {filteredItems.map((item, i) => {
              const isSelected = selectedIds.has(item.id);
              return (
                <m.div
                  key={item.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                >
                  <div
                    className={`nm-card-interactive flex w-full items-center gap-4 p-4 transition-colors ${
                      isSelected ? 'border-primary/50 bg-primary/[0.03]' : ''
                    }`}
                    data-testid={`trash-item-${item.id}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSelectItem(item.id)}
                      aria-label={`Select ${item.title}`}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      data-testid={`trash-checkbox-${item.id}`}
                    >
                      {isSelected ? (
                        <CheckSquare size={18} className="text-action" />
                      ) : (
                        <Square size={18} />
                      )}
                    </button>

                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{item.title}</p>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>Deleted {new Date(item.deletedAt).toLocaleDateString()}</span>
                        <span>by {item.deletedBy}</span>
                        <span className="text-warning">
                          {daysUntilPurge(item.autoPurgeAt)} days until auto-purge
                        </span>
                      </div>
                      {item.spaceMissing && (
                        <p className="mt-1 text-xs text-muted-foreground">Original space no longer exists</p>
                      )}
                    </div>

                    <div className="flex shrink-0 gap-2">
                      <Button
                        ref={(node) => {
                          if (node) restoreControlsRef.current.set(item.id, node);
                          else restoreControlsRef.current.delete(item.id);
                        }}
                        onClick={() => handleRestore(item.id, item.title)}
                        aria-label={`Restore ${item.title}`}
                        aria-disabled={restoreBusy}
                        aria-busy={restoringPageId === item.id || undefined}
                        variant="secondary"
                        size="sm"
                        leftIcon={restoringPageId === item.id
                          ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                          : <RotateCcw size={14} aria-hidden="true" />}
                        data-testid={`restore-btn-${item.id}`}
                      >
                        {restoringPageId === item.id ? 'Restoring…' : 'Restore'}
                      </Button>
                    </div>
                  </div>
                </m.div>
              );
            })}
          </div>
        </div>
      )}

      {/* Floating Bulk Action Bar */}
      <AnimatePresence>
        {selectedIds.size > 0 && (
          <m.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 nm-popover-glass flex items-center gap-3 rounded-2xl px-4 py-2.5"
            data-testid="trash-bulk-bar"
          >
            <span className="text-xs font-medium text-foreground" data-testid="trash-bulk-count">
                {selectedIds.size} {selectedIds.size === 1 ? 'page' : 'pages'} selected
              </span>

              <div className="h-4 w-px bg-border" />

              <Button
                ref={bulkRestoreRef}
                onClick={handleBulkRestore}
                aria-disabled={restoreBusy}
                aria-busy={isBulkRestoring || undefined}
                variant="primary"
                size="sm"
                leftIcon={isBulkRestoring
                  ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  : <RotateCcw size={14} aria-hidden="true" />}
                data-testid="trash-bulk-restore-btn"
              >
                Restore Selected
              </Button>

              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                aria-label="Clear selection"
                className="text-muted-foreground hover:text-foreground"
                data-testid="trash-bulk-clear-btn"
              >
                <X size={16} />
              </button>
          </m.div>
        )}
      </AnimatePresence>
      {rehomeRequest && (
        <RestoreTargetDialog
          request={rehomeRequest}
          busy={restoreBusy}
          contentRef={dialogRef}
          onTargetChange={(targetSpaceKey) => {
            setRehomeRequest((current) => current ? { ...current, targetSpaceKey } : null);
          }}
          onRestore={(targetSpaceKey) => {
            void handleRestore(rehomeRequest.pageId, rehomeRequest.title, { targetSpaceKey });
          }}
          onCancel={() => { if (!busyRef.current) setRehomeRequest(null); }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!aliveRef.current || document.activeElement !== document.body) return;
            const origin = dialogOriginRef.current;
            dialogOriginRef.current = null;
            (origin ? restoreControlsRef.current.get(origin) : null)?.focus();
            if (document.activeElement === document.body) descriptionRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
