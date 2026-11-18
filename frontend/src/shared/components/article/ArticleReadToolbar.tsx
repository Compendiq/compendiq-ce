import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ArrowRightLeft,
  ExternalLink,
  FileDown,
  GitGraph,
  History,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  RefreshCw,
  Tag,
  Trash2,
} from 'lucide-react';
import type { AiPolicy } from '@compendiq/contracts';
import type { PageDetail } from '../../hooks/use-pages';
import { useArticleActions } from '../../hooks/use-article-actions';
import { cn } from '../../lib/cn';
import { isMac as detectMac } from '../../lib/platform';
import { formatKeysForPlatform, getShortcutHint } from '../../lib/shortcut-registry';
import { Button } from '../Button';
import { AiPolicyChip } from '../badges/AiPolicyChips';
import { FrozenBadge } from '../badges/FrozenBadge';
import { ConfirmDialog } from '../ConfirmDialog';
import { ShortcutHint } from '../ShortcutHint';
import { PresenceAvatarStack } from '../../../features/pages/PresenceAvatarStack';
import type { PresenceViewer } from '../../../features/pages/use-presence';
import { VersionHistory } from '../../../features/pages/VersionHistory';
import { AutoTagger } from '../../../features/pages/AutoTagger';
import { RelocateDialog } from '../../../features/pages/RelocateDialog';

interface ArticleReadToolbarProps {
  page: PageDetail;
  confluenceUrl?: string | null;
  mergedViewers: PresenceViewer[];
  saveInFlight: boolean;
  onStartEditing: () => void;
  isPinned: boolean;
  onPinToggle: () => void;
  onDelete: () => void;
}

const toolbarIconBtn =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

const menuItemClass =
  'flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none transition-colors data-[highlighted]:bg-foreground/5 data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

const destructiveMenuItemClass =
  'nm-action-destructive flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-xs outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

export function ArticleReadToolbar({
  page,
  confluenceUrl,
  mergedViewers,
  saveInFlight,
  onStartEditing,
  isPinned,
  onPinToggle,
  onDelete,
}: ArticleReadToolbarProps) {
  const navigate = useNavigate();
  const autoTagTriggerRef = useRef<(() => void) | null>(null);
  const {
    exportPdf,
    handleExportPdf,
    resyncMutation,
    confirmResyncOpen,
    setConfirmResyncOpen,
    openResyncConfirm,
    handleConfirmResync,
    aiAutoTagAvailable,
    canRelocate,
    relocateOpen,
    setRelocateOpen,
  } = useArticleActions(page.id, page.title);

  const frozen = page.isFrozen === true;
  const isStandalone = page.source === 'standalone' || !page.confluenceId;
  const pinShortcut = formatKeysForPlatform(getShortcutHint('pin-page') ?? '', detectMac());
  const pinTitle = `${isPinned ? 'Unpin' : 'Pin'}${pinShortcut ? ` (${pinShortcut})` : ''}`;
  const aiPolicy = (page as PageDetail & { aiPolicy?: AiPolicy }).aiPolicy;

  return (
    <>
      {aiPolicy && (
        <div className="shrink-0">
          <AiPolicyChip policy={aiPolicy} />
        </div>
      )}

      {(page.labels ?? []).length > 0 && (
        <div
          className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden"
          data-testid="article-tags-readonly"
        >
          {(page.labels ?? []).map((label) => (
            <span
              key={label}
              className="inline-flex h-8 shrink-0 items-center rounded-full border border-border bg-background/45 px-2.5 text-xs font-medium text-muted-foreground"
            >
              {label}
            </span>
          ))}
        </div>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <PresenceAvatarStack viewers={mergedViewers} />

        <button
          type="button"
          onClick={onPinToggle}
          aria-pressed={isPinned}
          aria-label={isPinned ? 'Unpin page' : 'Pin page'}
          title={pinTitle}
          data-testid="read-toolbar-pin-btn"
          className={cn(
            toolbarIconBtn,
            isPinned && 'bg-primary/10 text-primary-ink hover:bg-primary/15',
          )}
        >
          <Pin size={15} className={cn(isPinned && 'fill-current')} aria-hidden="true" />
        </button>

        <VersionHistory
          pageId={page.id}
          restoreAllowed={!frozen}
          renderTrigger={(historyOpen) => (
            <button
              type="button"
              aria-label="Version history"
              title="Version history"
              data-testid="read-toolbar-history-btn"
              className={cn(
                toolbarIconBtn,
                historyOpen && 'bg-foreground/10 text-foreground',
              )}
            >
              <History size={15} aria-hidden="true" />
            </button>
          )}
        />

        {confluenceUrl && page.confluenceId && (
          <a
            href={`${confluenceUrl.replace(/\/+$/, '')}/pages/viewpage.action?pageId=${encodeURIComponent(page.confluenceId)}`}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in Confluence"
            title="Open in Confluence"
            data-testid="read-toolbar-confluence-link"
            className={toolbarIconBtn}
          >
            <ExternalLink size={15} aria-hidden="true" />
          </a>
        )}

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label="More page actions"
              title="More page actions"
              data-testid="article-read-more-btn"
              className={toolbarIconBtn}
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="z-50 min-w-52 p-1.5 nm-popover-glass"
            >
              <DropdownMenu.Item
                className={menuItemClass}
                onSelect={() => navigate(`/graph?focus=${encodeURIComponent(page.id)}`)}
                data-testid="show-in-graph-btn"
              >
                <GitGraph size={14} className="shrink-0 opacity-70" aria-hidden="true" />
                <span>Show in graph</span>
              </DropdownMenu.Item>

              <DropdownMenu.Item
                className={menuItemClass}
                disabled={exportPdf.isPending}
                onSelect={() => void handleExportPdf()}
              >
                {exportPdf.isPending ? (
                  <Loader2 size={14} className="shrink-0 animate-spin opacity-70" aria-hidden="true" />
                ) : (
                  <FileDown size={14} className="shrink-0 opacity-70" aria-hidden="true" />
                )}
                <span>Export PDF</span>
              </DropdownMenu.Item>

              {aiAutoTagAvailable && !frozen && (
                <DropdownMenu.Item
                  className={menuItemClass}
                  onSelect={() => autoTagTriggerRef.current?.()}
                >
                  <Tag size={14} className="shrink-0 opacity-70" aria-hidden="true" />
                  <span>Auto-tag</span>
                </DropdownMenu.Item>
              )}

              {!isStandalone && page.confluenceId && !frozen && (
                <DropdownMenu.Item
                  className={menuItemClass}
                  disabled={resyncMutation.isPending}
                  onSelect={openResyncConfirm}
                  data-testid="article-resync-btn"
                >
                  <RefreshCw
                    size={14}
                    className={cn('shrink-0 opacity-70', resyncMutation.isPending && 'animate-spin')}
                    aria-hidden="true"
                  />
                  <span>
                    {resyncMutation.isPending ? 'Pulling from Confluence…' : 'Pull latest from Confluence…'}
                  </span>
                </DropdownMenu.Item>
              )}

              {isStandalone && canRelocate && !frozen && (
                <DropdownMenu.Item
                  className={menuItemClass}
                  onSelect={() => setRelocateOpen(true)}
                  data-testid="relocate-btn"
                >
                  <ArrowRightLeft size={14} className="shrink-0 opacity-70" aria-hidden="true" />
                  <span>Move to Confluence…</span>
                </DropdownMenu.Item>
              )}

              {!frozen && (
                <>
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  {isStandalone ? (
                    <DropdownMenu.Item
                      className={destructiveMenuItemClass}
                      onSelect={onDelete}
                    >
                      <Trash2 size={14} className="shrink-0 opacity-70" aria-hidden="true" />
                      <span>Move to trash</span>
                    </DropdownMenu.Item>
                  ) : (
                    <>
                      <DropdownMenu.Item
                        className={destructiveMenuItemClass}
                        onSelect={onDelete}
                      >
                        <Trash2 size={14} className="shrink-0 opacity-70" aria-hidden="true" />
                        <span>Delete in Confluence…</span>
                      </DropdownMenu.Item>
                      {canRelocate && (
                        <DropdownMenu.Item
                          className={destructiveMenuItemClass}
                          onSelect={() => setRelocateOpen(true)}
                          data-testid="relocate-local-btn"
                        >
                          <ArrowRightLeft size={14} className="shrink-0 opacity-70" aria-hidden="true" />
                          <span>Move to a local space…</span>
                        </DropdownMenu.Item>
                      )}
                    </>
                  )}
                </>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        {frozen ? (
          <span
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-md)]
              border border-border px-2.5 text-xs font-medium text-muted-foreground"
            data-testid="article-frozen-status"
          >
            <FrozenBadge frozenVersion={page.frozenVersion} compact />
            <span>Frozen — open Details for the baseline</span>
          </span>
        ) : (
          <Button
            type="button"
            onClick={onStartEditing}
            disabled={saveInFlight}
            isLoading={saveInFlight}
            title={saveInFlight ? 'Wait for the current save to finish' : 'Edit page'}
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 gap-1.5 px-2.5 text-xs text-foreground"
            data-testid="edit-page-btn"
            leftIcon={!saveInFlight ? <Pencil size={13} aria-hidden /> : undefined}
            rightIcon={!saveInFlight ? <ShortcutHint shortcutId="toggle-edit" /> : undefined}
          >
            <span>{saveInFlight ? 'Finishing save…' : 'Edit'}</span>
          </Button>
        )}
      </div>

      {aiAutoTagAvailable && !frozen && (
        <AutoTagger
          pageId={page.id}
          currentLabels={page.labels ?? []}
          triggerRef={autoTagTriggerRef}
          renderTrigger={() => null}
        />
      )}

      {relocateOpen && (
        <RelocateDialog
          open
          pageId={page.id}
          pageTitle={page.title}
          source={page.source}
          onClose={() => setRelocateOpen(false)}
        />
      )}

      <ConfirmDialog
        open={confirmResyncOpen}
        title="Pull the latest version from Confluence?"
        description="This overwrites any local changes made here with the latest version in Confluence. A copy of your current content is saved in version history first."
        confirmLabel="Pull latest"
        onConfirm={handleConfirmResync}
        onCancel={() => setConfirmResyncOpen(false)}
      />
    </>
  );
}
