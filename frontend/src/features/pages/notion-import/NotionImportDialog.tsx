/**
 * One-shot Notion import wizard (#1466 / #1459).
 *
 * Connects with an internal integration token (never echoed), picks pages
 * from B’s tree (databases stay labelled and unselectable), confirms skip
 * of databases including their rows, and creates standalone pages via D.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, Check, ChevronDown, ChevronRight, ExternalLink, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { NotionImportItem, NotionTreeNode } from '@compendiq/contracts';
import { ApiError } from '../../../shared/lib/api';
import { cn } from '../../../shared/lib/cn';
import { LocationPicker, type LocationSelection } from '../../../shared/components/LocationPicker';
import { useLocalSpaces } from '../../../shared/hooks/use-standalone';
import {
  calculateBatchCount,
  canContinueNotionPick,
  chunkPageIds,
  documentPageIds,
  exceedsImportPageCap,
  filterTreeNodes,
  formatConfirmCopy,
  formatNodeBadge,
  groupSelectionState,
  isSelectablePage,
  NOTION_IMPORT_MAX_PAGES,
  selectableIdsInGroup,
  selectablePageIds,
  notionTitleById,
  shouldCommitImportResult,
  summarizeImport,
  toggleSelectedPageGroup,
  unimportedPageIds,
  type NotionImportStep,
} from './notion-import-selection';
import {
  useConnectNotion,
  useDisconnectNotion,
  useNotionConnection,
  useNotionTree,
  useRunNotionImport,
} from './use-notion-import';

export interface NotionImportDialogProps {
  open: boolean;
  onClose: () => void;
}

type Visibility = 'private' | 'shared';

const NOTION_ROOT_BATCH_SIZE = 50;

export function NotionImportPickFooter({
  importCount,
  importPending,
  onCancel,
  onContinue,
}: {
  importCount: number;
  importPending: boolean;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const overPageCap = exceedsImportPageCap(importCount);
  const batchCount = calculateBatchCount(importCount);
  return (
    <>
      {overPageCap ? (
        <p data-testid="notion-import-page-cap" className="mr-auto text-xs text-muted-foreground">
          Select at most {NOTION_IMPORT_MAX_PAGES} pages.
        </p>
      ) : importCount > 0 ? (
        <p className="mr-auto text-xs text-muted-foreground">
          {importCount} page{importCount === 1 ? '' : 's'} selected
          {batchCount > 1 ? ` · ${batchCount} batches` : ''}
        </p>
      ) : null}
      <button type="button" className="nm-button-ghost h-8 px-3 text-xs" onClick={onCancel}>
        Cancel
      </button>
      <button
        type="button"
        className="nm-button-primary h-8 px-3 text-xs"
        disabled={!canContinueNotionPick(importCount) || importPending}
        onClick={onContinue}
      >
        {batchCount > 1 ? `Continue (${batchCount} batches)` : 'Continue'}
      </button>
    </>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

function isLocationPickerTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-location-picker-content]'));
}

function TreeRetryButton({ inFlight, onRetry }: { inFlight: boolean; onRetry: () => void }) {
  return (
    <button
      type="button"
      className="nm-button-ghost mt-2 h-8 px-2 text-xs aria-disabled:opacity-70"
      aria-disabled={inFlight || undefined}
      onClick={onRetry}
    >
      {inFlight ? 'Retrying…' : 'Retry'}
    </button>
  );
}

function resultStatusLabel(status: NotionImportItem['status']): string {
  if (status === 'already_imported') return 'already imported';
  if (status === 'success') return 'imported';
  return status;
}

function TreeNodeRow({
  node,
  selected,
  onToggle,
  depth,
  locked,
  expandedIds,
  onToggleExpanded,
}: {
  node: NotionTreeNode;
  selected: ReadonlySet<string>;
  onToggle: (node: NotionTreeNode) => void;
  depth: number;
  locked: boolean;
  expandedIds: ReadonlySet<string>;
  onToggleExpanded: (id: string) => void;
}) {
  const selectable = isSelectablePage(node);
  const groupIds = selectableIdsInGroup(node);
  const selectableCount = groupIds.length;
  const hasChildren = node.children.length > 0;
  const isExpanded = hasChildren && expandedIds.has(node.id);
  const selectionState = groupSelectionState(node, selected);
  const checkboxRef = useRef<HTMLInputElement | null>(null);
  const badgeLabel = formatNodeBadge(node);

  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = selectionState === 'some';
  }, [selectionState]);

  const handleTreeKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!hasChildren) return;
    if (event.key === 'ArrowRight' && !isExpanded) {
      event.preventDefault();
      onToggleExpanded(node.id);
    } else if (event.key === 'ArrowLeft' && isExpanded) {
      event.preventDefault();
      onToggleExpanded(node.id);
    }
  };

  return (
    <li data-testid={`notion-node-${node.id}`}>
      <div
        className="relative flex min-h-7 items-start gap-2 rounded-md py-1 pr-2 text-[13px] hover:bg-accent"
        style={{ paddingLeft: depth * 12 + 28 }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="absolute top-0.5 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            style={{ left: depth * 12 }}
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${node.title}`}
            onClick={() => onToggleExpanded(node.id)}
            aria-expanded={isExpanded}
          >
            {isExpanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          </button>
        ) : null}
        {selectable ? (
          <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
            <input
              ref={checkboxRef}
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-border-interactive accent-primary"
              checked={selectionState === 'all'}
              disabled={locked}
              onChange={() => onToggle(node)}
              onKeyDown={handleTreeKeyDown}
              aria-label={node.title}
            />
            <span className="min-w-0 break-words text-foreground">{node.title}</span>
            {node.isDatabaseRow ? (
              <span
                className="inline-flex items-center rounded border border-border/40 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                title="Row in a Notion database"
              >
                Row
              </span>
            ) : null}
            {node.alreadyImported ? (
              <span
                data-testid={`notion-imported-badge-${node.id}`}
                className="inline-flex items-center gap-0.5 rounded border border-success/30 bg-success/10 px-1.5 py-0.5 text-[11px] font-medium text-success"
              >
                <Check size={11} aria-hidden />
                Imported
              </span>
            ) : null}
          </label>
        ) : selectableCount > 0 ? (
          <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
            <input
              ref={checkboxRef}
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-border-interactive accent-primary"
              checked={selectionState === 'all'}
              disabled={locked}
              onChange={() => onToggle(node)}
              onKeyDown={handleTreeKeyDown}
              aria-label={`Select all ${selectableCount} pages in ${node.title}`}
            />
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="min-w-0 break-words font-medium text-foreground">{node.title}</span>
              {badgeLabel ? (
                <span className="inline-flex items-center rounded border border-border/70 bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {badgeLabel}
                </span>
              ) : null}
              <span className="text-xs text-muted-foreground">
                Database stays in Notion · {selectableCount} page{selectableCount === 1 ? '' : 's'} can be imported
              </span>
            </div>
          </label>
        ) : (
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-muted-foreground">{node.title}</span>
            {badgeLabel ? (
              <span className="inline-flex items-center rounded border border-border/50 bg-muted/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                {badgeLabel}
              </span>
            ) : null}
            <span className="text-xs text-muted-foreground">{node.skipReason}</span>
          </div>
        )}
      </div>
      {hasChildren && isExpanded ? (
        <ul className="list-none p-0">
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.id}
              node={child}
              selected={selected}
              onToggle={onToggle}
              depth={depth + 1}
              locked={locked}
              expandedIds={expandedIds}
              onToggleExpanded={onToggleExpanded}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function NotionImportDialog({ open, onClose }: NotionImportDialogProps) {
  const connection = useNotionConnection(open);
  const connect = useConnectNotion();
  const disconnect = useDisconnectNotion();
  const hasToken = connection.data?.hasToken === true;
  const tree = useNotionTree(open && hasToken);
  const runImport = useRunNotionImport();
  const {
    data: localSpaces,
    isError: localSpacesError,
    isPending: localSpacesPending,
  } = useLocalSpaces(open);

  const [step, setStepState] = useState<NotionImportStep>('connect');
  const [token, setToken] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [spaceKey, setSpaceKey] = useState('');
  const [parentId, setParentId] = useState<string | undefined>();
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [resultItems, setResultItems] = useState<NotionImportItem[] | null>(null);
  const [treeRetryInFlight, setTreeRetryInFlight] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [visibleRootCount, setVisibleRootCount] = useState(NOTION_ROOT_BATCH_SIZE);
  const [selectionLimitMessage, setSelectionLimitMessage] = useState<string | null>(null);
  const [hideImported, setHideImported] = useState(false);
  const [hideDatabaseRows, setHideDatabaseRows] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{
    current: number;
    total: number;
    processed: number;
    totalPages: number;
  } | null>(null);
  const stepRef = useRef(step);
  const setStep = useCallback((next: NotionImportStep) => {
    stepRef.current = next;
    setStepState(next);
  }, []);
  const openRef = useRef(open);
  openRef.current = open;
  const importPending = runImport.isPending;
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const treeRegionRef = useRef<HTMLElement | null>(null);
  const setTreeRegionRef = (node: HTMLElement | null) => {
    treeRegionRef.current = node;
  };
  const visibilityGroupRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusAfterImport = useRef(false);
  const restoreFocusAfterTreeRetry = useRef(false);
  const loadMoreRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    if (!hasToken) {
      setStep('connect');
      return;
    }
    if (stepRef.current === 'connect') setStep('pick');
  }, [open, hasToken, setStep]);

  useEffect(() => {
    if (open) return;
    setToken('');
    setSelected(new Set());
    setExpandedIds(new Set());
    setVisibleRootCount(NOTION_ROOT_BATCH_SIZE);
    setSelectionLimitMessage(null);
    setSpaceKey('');
    setParentId(undefined);
    setVisibility('private');
    setResultItems(null);
    setStep('connect');
    setTreeRetryInFlight(false);
    restoreFocusAfterImport.current = false;
    restoreFocusAfterTreeRetry.current = false;
  }, [open, setStep]);

  const nodes = useMemo(() => tree.data?.nodes ?? [], [tree.data?.nodes]);
  const titlesById = useMemo(() => notionTitleById(nodes), [nodes]);
  useEffect(() => {
    setSelected((current) => {
      const validSelection = selectablePageIds(nodes, current);
      return validSelection.length === current.size ? current : new Set(validSelection);
    });
    setSelectionLimitMessage(null);
  }, [nodes]);
  const summary = useMemo(() => summarizeImport(nodes, selected), [nodes, selected]);
  const confirmCopy = formatConfirmCopy(summary);
  const filteredNodes = useMemo(
    () => filterTreeNodes(nodes, { hideImported, hideDatabaseRows }),
    [nodes, hideImported, hideDatabaseRows],
  );
  const visibleNodes = filteredNodes.slice(0, visibleRootCount);
  const remainingRootCount = Math.max(0, filteredNodes.length - visibleRootCount);

  useEffect(() => {
    setVisibleRootCount(NOTION_ROOT_BATCH_SIZE);
  }, [nodes]);
  const showMoreRoots = useCallback(() => {
    setVisibleRootCount((count) => Math.min(nodes.length, count + NOTION_ROOT_BATCH_SIZE));
  }, [nodes.length]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || remainingRootCount === 0 || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) showMoreRoots();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [remainingRootCount, showMoreRoots]);

  const handleToggle = useCallback(
    (node: NotionTreeNode) => {
      if (runImport.isPending) return;
      const result = toggleSelectedPageGroup(selected, node);
      setSelected(result.selected);
      setSelectionLimitMessage(
        result.limitExceeded
          ? `That group exceeds the ${NOTION_IMPORT_MAX_PAGES}-page import limit. Expand it and choose a smaller group.`
          : null,
      );
    },
    [runImport.isPending, selected],
  );

  const handleToggleExpanded = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleConnect = async () => {
    const pasted = token.trim();
    if (!pasted) return;
    try {
      await connect.mutateAsync(pasted);
      setToken('');
      setSelected(new Set());
      setExpandedIds(new Set());
      setSelectionLimitMessage(null);
      setStep('pick');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect.mutateAsync();
      setSelected(new Set());
      setExpandedIds(new Set());
      setSelectionLimitMessage(null);
      setStep('connect');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleImport = async () => {
    if (importPending || !spaceKey || summary.importIds.length === 0) return;
    const batches = chunkPageIds(summary.importIds);
    const allItems: NotionImportItem[] = [];
    let processed = 0;

    setBatchProgress({
      current: 1,
      total: batches.length,
      processed: 0,
      totalPages: summary.importIds.length,
    });

    try {
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i]!;
        setBatchProgress({
          current: i + 1,
          total: batches.length,
          processed,
          totalPages: summary.importIds.length,
        });

        const response = await runImport.mutateAsync({
          pageIds: batch,
          spaceKey,
          parentId,
          visibility,
        });

        allItems.push(...response.items);
        processed += batch.length;
      }

      if (!shouldCommitImportResult(stepRef.current, openRef.current)) return;
      restoreFocusAfterImport.current = true;
      setResultItems(allItems);
      setStep('result');
    } catch (err) {
      if (allItems.length > 0) {
        setResultItems(allItems);
        setStep('result');
      }
      toast.error(errorMessage(err));
    } finally {
      setBatchProgress(null);
    }
  };
  const handleSelectPagesOnly = useCallback(() => {
    if (runImport.isPending) return;
    const docIds = documentPageIds(nodes, hideImported);
    setSelected(new Set(docIds));
  }, [nodes, hideImported, runImport.isPending]);

  const handleSelectAll = useCallback(() => {
    if (runImport.isPending) return;
    const allIds = hideDatabaseRows
      ? documentPageIds(nodes, hideImported)
      : hideImported
        ? unimportedPageIds(nodes)
        : selectablePageIds(nodes, new Set(nodes.map((n) => n.id)));
    setSelected(new Set(allIds));
  }, [nodes, hideImported, hideDatabaseRows, runImport.isPending]);

  const handleSelectUnimported = useCallback(() => {
    if (runImport.isPending) return;
    const unimported = unimportedPageIds(nodes);
    setSelected(new Set(unimported));
  }, [nodes, runImport.isPending]);

  const handleClearSelection = useCallback(() => {
    if (runImport.isPending) return;
    setSelected(new Set());
  }, [runImport.isPending]);

  const handleLocationSelect = useCallback((selection: LocationSelection) => {
    setParentId(selection.parentId);
  }, []);

  const requestClose = useCallback(() => {
    if (runImport.isPending) return;
    onClose();
  }, [onClose, runImport.isPending]);

  const retryTree = () => {
    if (treeRetryInFlight) return;
    restoreFocusAfterTreeRetry.current = true;
    setTreeRetryInFlight(true);
    void tree.refetch().finally(() => setTreeRetryInFlight(false));
  };

  useEffect(() => {
    if (!restoreFocusAfterImport.current || step !== 'result') return;
    restoreFocusAfterImport.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    titleRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (!restoreFocusAfterTreeRetry.current) return;
    if (treeRetryInFlight) return;
    if (tree.isError && !tree.data) return;
    restoreFocusAfterTreeRetry.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    treeRegionRef.current?.focus();
  }, [treeRetryInFlight, tree.isError, tree.data]);

  const canImport = Boolean(spaceKey) && canContinueNotionPick(summary.importCount);
  const importDisabled = !canImport || importPending;
  const treeFailed = tree.isError || treeRetryInFlight;
  const treeHasCache = Boolean(tree.data);
  const spacesEmpty = !localSpacesPending && !localSpacesError && (localSpaces ?? []).length === 0;

  const title =
    step === 'connect'
      ? 'Connect Notion'
      : step === 'pick'
        ? 'Choose pages'
        : step === 'confirm'
          ? 'Confirm import'
          : 'Import finished';

  const dismissUnlessPickerOrImport = (event: { preventDefault: () => void; target: EventTarget | null }) => {
    if (importPending || isLocationPickerTarget(event.target)) event.preventDefault();
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content
          className="nm-card-elevated fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden outline-none"
          data-testid="notion-import-dialog"
          onPointerDownOutside={dismissUnlessPickerOrImport}
          onFocusOutside={dismissUnlessPickerOrImport}
          onInteractOutside={dismissUnlessPickerOrImport}
          onEscapeKeyDown={(event) => {
            if (importPending) event.preventDefault();
          }}
        >
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title
                ref={titleRef}
                tabIndex={-1}
                className="text-base font-semibold text-foreground outline-none"
              >
                {title}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                One-shot migrate into a local space. Databases stay in Notion.
              </Dialog.Description>
            </div>
            <button
              type="button"
              className="nm-icon-button shrink-0"
              aria-label="Close"
              aria-disabled={importPending || undefined}
              onClick={requestClose}
            >
              <X size={15} aria-hidden />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {step === 'connect' && (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleConnect();
                }}
              >
                <label htmlFor="notion-token" className="block text-sm font-medium text-foreground">
                  Internal integration token
                </label>
                <input
                  id="notion-token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  className="nm-input"
                  placeholder="Paste the token"
                  aria-describedby="notion-token-hint notion-token-share notion-token-never-echo"
                />
                <div className="space-y-1.5 text-xs text-muted-foreground">
                  <p id="notion-token-hint">
                    Create an internal connection in Notion (workspace owners only) and paste the
                    Installation access token from its Configuration tab. Not an OAuth app, not a
                    personal access token.
                  </p>
                  <p>
                    <a
                      href="https://www.notion.so/my-integrations"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-action underline underline-offset-2"
                      data-testid="notion-token-link"
                    >
                      Create a token in Notion
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  </p>
                  <p id="notion-token-share">
                    Then share the pages you want to import with that connection — a new connection
                    can see nothing until you do.
                  </p>
                  <p id="notion-token-never-echo">
                    Stored encrypted. It is never shown again and is not a live sync.
                  </p>
                </div>
                <button
                  type="submit"
                  className="nm-button-primary h-8 px-3 text-xs"
                  disabled={!token.trim() || connect.isPending}
                >
                  {connect.isPending ? 'Connecting…' : 'Connect'}
                </button>
              </form>
            )}

            {step === 'pick' && (
              <div className="space-y-3">
                {hasToken && (
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">Connected. Token is not shown.</p>
                    <button
                      type="button"
                      className="nm-button-ghost h-8 px-2 text-xs"
                      onClick={() => void handleDisconnect()}
                      disabled={disconnect.isPending || importPending}
                    >
                      Disconnect
                    </button>
                  </div>
                )}

                {treeFailed && !treeHasCache ? (
                  <div
                    role="alert"
                    data-testid="notion-import-tree-error"
                    className="flex items-start gap-2 text-sm text-destructive"
                  >
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
                    <div>
                      <p>{errorMessage(tree.error)}</p>
                      <TreeRetryButton inFlight={treeRetryInFlight} onRetry={retryTree} />
                    </div>
                  </div>
                ) : !hasToken || (tree.isLoading && !treeHasCache) ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 size={14} className="animate-spin" aria-hidden />
                    Loading workspace…
                  </p>
                ) : nodes.length === 0 ? (
                  <div
                    ref={setTreeRegionRef}
                    tabIndex={-1}
                    data-testid="notion-import-tree-empty"
                    className="text-sm text-muted-foreground outline-none"
                  >
                    <p>No pages are visible to this integration. Share pages with it in Notion, then retry.</p>
                    <TreeRetryButton inFlight={treeRetryInFlight} onRetry={retryTree} />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2 text-xs">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          className="nm-button-ghost h-7 px-2 text-xs font-medium"
                          onClick={handleSelectPagesOnly}
                          disabled={importPending}
                          title="Select all standard document pages, excluding database rows"
                        >
                          Pages only (no DB rows)
                        </button>
                        <button
                          type="button"
                          className="nm-button-ghost h-7 px-2 text-xs"
                          onClick={handleSelectUnimported}
                          disabled={importPending}
                        >
                          Select unimported
                        </button>
                        <button
                          type="button"
                          className="nm-button-ghost h-7 px-2 text-xs"
                          onClick={handleSelectAll}
                          disabled={importPending}
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          className="nm-button-ghost h-7 px-2 text-xs text-muted-foreground"
                          onClick={handleClearSelection}
                          disabled={importPending || selected.size === 0}
                        >
                          Deselect all
                        </button>
                      </div>
                      <div className="flex items-center gap-3">
                        <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground select-none">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 rounded border-border-interactive accent-primary"
                            checked={hideDatabaseRows}
                            onChange={(e) => setHideDatabaseRows(e.target.checked)}
                            disabled={importPending}
                          />
                          <span>Exclude database rows</span>
                        </label>
                        <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground select-none">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 rounded border-border-interactive accent-primary"
                            checked={hideImported}
                            onChange={(e) => setHideImported(e.target.checked)}
                            disabled={importPending}
                          />
                          <span>Hide imported</span>
                        </label>
                      </div>
                    </div>
                    {treeFailed && treeHasCache ? (
                      <div
                        role="status"
                        data-testid="notion-import-tree-degraded"
                        className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-foreground"
                      >
                        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                        <div className="min-w-0">
                          <p>Could not refresh the Notion tree. Showing the last loaded pages.</p>
                          <TreeRetryButton inFlight={treeRetryInFlight} onRetry={retryTree} />
                        </div>
                      </div>
                    ) : null}
                    {selectionLimitMessage ? (
                      <p role="status" className="text-xs text-warning">
                        {selectionLimitMessage}
                      </p>
                    ) : null}
                    <ul
                      ref={setTreeRegionRef}
                      tabIndex={-1}
                      data-testid="notion-import-tree"
                      className="list-none rounded-md border border-border bg-card px-2 py-1 outline-none"
                    >
                      {visibleNodes.map((node) => (
                        <TreeNodeRow
                          key={node.id}
                          node={node}
                          selected={selected}
                          onToggle={handleToggle}
                          depth={0}
                          locked={importPending}
                          expandedIds={expandedIds}
                          onToggleExpanded={handleToggleExpanded}
                        />
                      ))}
                    </ul>
                    {remainingRootCount > 0 ? (
                      <button
                        ref={loadMoreRef}
                        type="button"
                        className="nm-button-ghost h-8 w-full px-3 text-xs"
                        onClick={showMoreRoots}
                      >
                        Show {Math.min(NOTION_ROOT_BATCH_SIZE, remainingRootCount)} more{' '}
                        {Math.min(NOTION_ROOT_BATCH_SIZE, remainingRootCount) === 1 ? 'page' : 'pages'}
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            )}

            {step === 'confirm' && (
              <div className="space-y-4">
                {batchProgress && (
                  <div className="space-y-1.5 rounded-md border border-primary/30 bg-primary/5 p-3" role="status">
                    <div className="flex items-center justify-between text-xs text-foreground">
                      <span className="flex items-center gap-1.5 font-medium">
                        <Loader2 size={12} className="animate-spin text-primary" aria-hidden />
                        Importing batch {batchProgress.current} of {batchProgress.total}…
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {batchProgress.processed} / {batchProgress.totalPages} pages
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-primary transition-all duration-300"
                        style={{
                          width: `${Math.round((batchProgress.processed / batchProgress.totalPages) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
                <p data-testid="notion-import-confirm-copy" className="text-sm text-foreground">
                  {confirmCopy}
                </p>
                {summary.skippedUnsupportedCount > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {summary.skippedUnsupportedCount === 1
                      ? '1 other unsupported item is labelled and will stay in Notion.'
                      : `${summary.skippedUnsupportedCount} other unsupported items are labelled and will stay in Notion.`}
                  </p>
                )}

                <div className="space-y-3">
                  <div>
                    <label htmlFor="notion-import-space" className="mb-1.5 block text-sm font-medium">
                      Space
                    </label>
                    <select
                      id="notion-import-space"
                      className="nm-input"
                      value={spaceKey}
                      disabled={importPending}
                      onChange={(e) => {
                        setSpaceKey(e.target.value);
                        setParentId(undefined);
                      }}
                      aria-label="Space"
                      aria-describedby={
                        localSpacesError
                          ? 'notion-import-spaces-error'
                          : spacesEmpty
                            ? 'notion-import-spaces-empty'
                            : undefined
                      }
                    >
                      <option value="">Select a local space…</option>
                      {(localSpaces ?? []).map((space) => (
                        <option key={space.key} value={space.key}>
                          {space.name}
                        </option>
                      ))}
                    </select>
                    {localSpacesError ? (
                      <p
                        id="notion-import-spaces-error"
                        data-testid="notion-import-spaces-error"
                        className="mt-1.5 text-xs text-muted-foreground"
                      >
                        Local spaces could not be read. Import needs a local destination, not Confluence.
                      </p>
                    ) : spacesEmpty ? (
                      <p
                        id="notion-import-spaces-empty"
                        data-testid="notion-import-spaces-empty"
                        className="mt-1.5 text-xs text-muted-foreground"
                      >
                        No local space yet. Create one first — import cannot use Confluence.
                      </p>
                    ) : null}
                  </div>

                  <div>
                    <span className="mb-1.5 block text-sm font-medium" id="notion-import-visibility-label">
                      Visibility
                    </span>
                    <div
                      ref={visibilityGroupRef}
                      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted p-0.5"
                      role="radiogroup"
                      aria-labelledby="notion-import-visibility-label"
                      onKeyDown={(event) => {
                        if (importPending) return;
                        if (
                          event.key !== 'ArrowRight' &&
                          event.key !== 'ArrowLeft' &&
                          event.key !== 'ArrowUp' &&
                          event.key !== 'ArrowDown'
                        ) {
                          return;
                        }
                        event.preventDefault();
                        const next: Visibility = visibility === 'private' ? 'shared' : 'private';
                        setVisibility(next);
                        queueMicrotask(() => {
                          visibilityGroupRef.current
                            ?.querySelector<HTMLButtonElement>(`[data-visibility="${next}"]`)
                            ?.focus();
                        });
                      }}
                    >
                      <button
                        type="button"
                        role="radio"
                        data-visibility="private"
                        aria-checked={visibility === 'private'}
                        tabIndex={visibility === 'private' ? 0 : -1}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-sm px-2.5 py-1 text-xs font-medium',
                          visibility === 'private' ? 'nm-pill-active' : 'text-muted-foreground hover:text-foreground',
                        )}
                        onClick={() => {
                          if (importPending) return;
                          setVisibility('private');
                        }}
                      >
                        <Check
                          size={12}
                          aria-hidden
                          className={visibility === 'private' ? undefined : 'invisible'}
                        />
                        Private
                      </button>
                      <button
                        type="button"
                        role="radio"
                        data-visibility="shared"
                        aria-checked={visibility === 'shared'}
                        tabIndex={visibility === 'shared' ? 0 : -1}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-sm px-2.5 py-1 text-xs font-medium',
                          visibility === 'shared' ? 'nm-pill-active' : 'text-muted-foreground hover:text-foreground',
                        )}
                        onClick={() => {
                          if (importPending) return;
                          setVisibility('shared');
                        }}
                      >
                        <Check
                          size={12}
                          aria-hidden
                          className={visibility === 'shared' ? undefined : 'invisible'}
                        />
                        Shared
                      </button>
                    </div>
                  </div>

                  {spaceKey ? (
                    <div>
                      <span className="mb-1.5 block text-sm font-medium">Location</span>
                      <LocationPicker
                        spaceKey={spaceKey}
                        parentId={parentId}
                        onSelect={handleLocationSelect}
                        disabled={importPending}
                        modal
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            )}

            {step === 'result' && resultItems && (
              <ul className="space-y-2 text-sm" data-testid="notion-import-result">
                {resultItems.map((item) => {
                  const pageTitle = titlesById.get(item.notionPageId) ?? item.notionPageId;
                  const href =
                    item.localPageId != null && (item.status === 'success' || item.status === 'already_imported')
                      ? `/pages/${item.localPageId}`
                      : undefined;
                  return (
                    <li key={item.notionPageId} className="flex flex-wrap items-baseline gap-x-2">
                      {href ? (
                        <a href={href} className="font-medium text-foreground underline-offset-2 hover:underline">
                          {pageTitle}
                        </a>
                      ) : (
                        <span className="font-medium text-foreground">{pageTitle}</span>
                      )}
                      <span className="text-muted-foreground">
                        {resultStatusLabel(item.status)}
                        {item.reason ? ` — ${item.reason}` : ''}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
            {step === 'pick' && (
              <NotionImportPickFooter
                importCount={summary.importCount}
                importPending={importPending}
                onCancel={requestClose}
                onContinue={() => setStep('confirm')}
              />
            )}
            {step === 'confirm' && (
              <>
                <button
                  type="button"
                  className="nm-button-ghost h-8 px-3 text-xs"
                  disabled={importPending}
                  onClick={() => setStep('pick')}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="nm-button-primary h-8 px-3 text-xs aria-disabled:opacity-70"
                  aria-disabled={importDisabled || undefined}
                  onClick={() => {
                    if (importDisabled) return;
                    void handleImport();
                  }}
                >
                  {importPending ? 'Importing…' : 'Import'}
                </button>
              </>
            )}
            {step === 'result' && (
              <button type="button" className="nm-button-primary h-8 px-3 text-xs" onClick={requestClose}>
                Done
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
