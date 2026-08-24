/**
 * One-shot Notion import wizard (#1466 / #1459).
 *
 * Connects with an internal integration token (never echoed), picks pages
 * from B’s tree (databases stay labelled and unselectable), confirms skip
 * of databases including their rows, and creates standalone pages via D.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { NotionImportItem, NotionTreeNode } from '@compendiq/contracts';
import { NOTION_UNSUPPORTED_LABEL } from '@compendiq/contracts';
import { ApiError } from '../../../shared/lib/api';
import { cn } from '../../../shared/lib/cn';
import { LocationPicker, type LocationSelection } from '../../../shared/components/LocationPicker';
import { useLocalSpaces } from '../../../shared/hooks/use-standalone';
import {
  formatConfirmCopy,
  isSelectablePage,
  summarizeImport,
  toggleSelectedPage,
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

type Step = 'connect' | 'pick' | 'confirm' | 'result';
type Visibility = 'private' | 'shared';

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

function TreeNodeRow({
  node,
  selected,
  onToggle,
  depth,
}: {
  node: NotionTreeNode;
  selected: ReadonlySet<string>;
  onToggle: (node: NotionTreeNode) => void;
  depth: number;
}) {
  const selectable = isSelectablePage(node);
  return (
    <div>
      <div
        data-testid={`notion-node-${node.id}`}
        className="flex min-h-7 items-start gap-2 py-1 text-[13px]"
        style={{ paddingLeft: depth * 12 }}
      >
        {selectable ? (
          <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-border-interactive accent-primary"
              checked={selected.has(node.id)}
              onChange={() => onToggle(node)}
              aria-label={node.title}
            />
            <span className="min-w-0 break-words text-foreground">{node.title}</span>
          </label>
        ) : (
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-muted-foreground">{node.title}</span>
            <span className="text-xs text-muted-foreground">{NOTION_UNSUPPORTED_LABEL}</span>
          </div>
        )}
      </div>
      {node.children.map((child) => (
        <TreeNodeRow
          key={child.id}
          node={child}
          selected={selected}
          onToggle={onToggle}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

export function NotionImportDialog({ open, onClose }: NotionImportDialogProps) {
  const connection = useNotionConnection(open);
  const connect = useConnectNotion();
  const disconnect = useDisconnectNotion();
  const hasToken = connection.data?.hasToken === true;
  const tree = useNotionTree(open && hasToken);
  const runImport = useRunNotionImport();
  const { data: localSpaces } = useLocalSpaces();

  const [step, setStep] = useState<Step>('connect');
  const [token, setToken] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [spaceKey, setSpaceKey] = useState('');
  const [parentId, setParentId] = useState<string | undefined>();
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [resultItems, setResultItems] = useState<NotionImportItem[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(hasToken ? 'pick' : 'connect');
  }, [open, hasToken]);

  useEffect(() => {
    if (open) return;
    setToken('');
    setSelected(new Set());
    setSpaceKey('');
    setParentId(undefined);
    setVisibility('private');
    setResultItems(null);
    setStep('connect');
  }, [open]);

  const nodes = useMemo(() => tree.data?.nodes ?? [], [tree.data?.nodes]);
  const summary = useMemo(() => summarizeImport(nodes, selected), [nodes, selected]);
  const confirmCopy = formatConfirmCopy(summary);

  const handleToggle = useCallback((node: NotionTreeNode) => {
    setSelected((prev) => toggleSelectedPage(prev, node));
  }, []);

  const handleConnect = async () => {
    const pasted = token.trim();
    if (!pasted) return;
    try {
      await connect.mutateAsync(pasted);
      setToken('');
      setStep('pick');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect.mutateAsync();
      setSelected(new Set());
      setStep('connect');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleImport = async () => {
    if (!spaceKey || summary.importIds.length === 0) return;
    try {
      const response = await runImport.mutateAsync({
        pageIds: summary.importIds,
        spaceKey,
        parentId,
        visibility,
      });
      setResultItems(response.items);
      setStep('result');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleLocationSelect = useCallback((selection: LocationSelection) => {
    setParentId(selection.parentId);
  }, []);

  const canContinuePick = summary.importCount > 0;
  const canImport = Boolean(spaceKey) && summary.importCount > 0 && !runImport.isPending;

  const title =
    step === 'connect'
      ? 'Connect Notion'
      : step === 'pick'
        ? 'Choose pages'
        : step === 'confirm'
          ? 'Confirm import'
          : 'Import finished';

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content
          className="nm-card-elevated fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden outline-none"
          data-testid="notion-import-dialog"
        >
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold text-foreground">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                One-shot migrate into a local space. Databases stay in Notion.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="nm-icon-button shrink-0" aria-label="Close" onClick={onClose}>
                <X size={15} aria-hidden />
              </button>
            </Dialog.Close>
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
                />
                <p className="text-xs text-muted-foreground">
                  Stored encrypted. It is never shown again and is not a live sync.
                </p>
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
                      disabled={disconnect.isPending}
                    >
                      Disconnect
                    </button>
                  </div>
                )}

                {tree.isError && !tree.data ? (
                  <div
                    role="alert"
                    data-testid="notion-import-tree-error"
                    className="flex items-start gap-2 text-sm text-destructive"
                  >
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
                    <div>
                      <p>{errorMessage(tree.error)}</p>
                      <button
                        type="button"
                        className="nm-button-ghost mt-2 h-8 px-2 text-xs"
                        onClick={() => void tree.refetch()}
                      >
                        Retry
                      </button>
                    </div>
                  </div>
                ) : tree.isPending ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 size={14} className="animate-spin" aria-hidden />
                    Loading workspace…
                  </p>
                ) : nodes.length === 0 ? (
                  <p data-testid="notion-import-tree-empty" className="text-sm text-muted-foreground">
                    No pages are visible to this integration. Share pages with it in Notion, then retry.
                  </p>
                ) : (
                  <div data-testid="notion-import-tree" className="rounded-md border border-border bg-card px-2 py-1">
                    {nodes.map((node) => (
                      <TreeNodeRow
                        key={node.id}
                        node={node}
                        selected={selected}
                        onToggle={handleToggle}
                        depth={0}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {step === 'confirm' && (
              <div className="space-y-4">
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
                      onChange={(e) => {
                        setSpaceKey(e.target.value);
                        setParentId(undefined);
                      }}
                      aria-label="Space"
                    >
                      <option value="">Select a local space…</option>
                      {(localSpaces ?? []).map((space) => (
                        <option key={space.key} value={space.key}>
                          {space.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <span className="mb-1.5 block text-sm font-medium">Visibility</span>
                    <div
                      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted p-0.5"
                      role="group"
                      aria-label="Visibility"
                    >
                      <button
                        type="button"
                        aria-pressed={visibility === 'private'}
                        className={cn(
                          'rounded-sm px-2.5 py-1 text-xs font-medium',
                          visibility === 'private' ? 'nm-pill-active' : 'text-muted-foreground hover:text-foreground',
                        )}
                        onClick={() => setVisibility('private')}
                      >
                        Private
                      </button>
                      <button
                        type="button"
                        aria-pressed={visibility === 'shared'}
                        className={cn(
                          'rounded-sm px-2.5 py-1 text-xs font-medium',
                          visibility === 'shared' ? 'nm-pill-active' : 'text-muted-foreground hover:text-foreground',
                        )}
                        onClick={() => setVisibility('shared')}
                      >
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
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            )}

            {step === 'result' && resultItems && (
              <ul className="space-y-2 text-sm" data-testid="notion-import-result">
                {resultItems.map((item) => (
                  <li key={item.notionPageId} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-foreground">{item.notionPageId}</span>
                    <span className="text-muted-foreground">
                      {item.status === 'already_imported'
                        ? 'already imported'
                        : item.status}
                      {item.reason ? ` — ${item.reason}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
            {step === 'pick' && (
              <>
                <button type="button" className="nm-button-ghost h-8 px-3 text-xs" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="nm-button-primary h-8 px-3 text-xs"
                  disabled={!canContinuePick}
                  onClick={() => setStep('confirm')}
                >
                  Continue
                </button>
              </>
            )}
            {step === 'confirm' && (
              <>
                <button
                  type="button"
                  className="nm-button-ghost h-8 px-3 text-xs"
                  onClick={() => setStep('pick')}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="nm-button-primary h-8 px-3 text-xs"
                  disabled={!canImport}
                  onClick={() => void handleImport()}
                >
                  {runImport.isPending ? 'Importing…' : 'Import'}
                </button>
              </>
            )}
            {step === 'result' && (
              <button type="button" className="nm-button-primary h-8 px-3 text-xs" onClick={onClose}>
                Done
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
