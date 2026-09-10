import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import type { ConversationSummary } from '@compendiq/contracts';
import { ApiError } from '../../../shared/lib/api';
import { cn } from '../../../shared/lib/cn';
import { neutralChipClass } from '../../../shared/components/badges/neutral-chip';
import { conversationIdFromPath, conversationPath } from '../../../shared/lib/ai-routes';
import { useRenameConversation } from './use-conversation-mutations';
import { ConversationRowMenu } from './ConversationRowMenu';

export interface ConversationRowProps {
  conversation: ConversationSummary;
  /** Roving tabindex: exactly one row in the list is a tab stop. */
  tabIndex: 0 | -1;
  onRowFocus: (id: string) => void;
  onRowKeyDown: (event: React.KeyboardEvent, id: string) => void;
  /** Mobile drawer: close on the tap, not only on the pathname effect. */
  onNavigate?: () => void;
}

export function ConversationRow({
  conversation,
  tabIndex,
  onRowFocus,
  onRowKeyDown,
  onNavigate,
}: ConversationRowProps) {
  const location = useLocation();
  // The kebab is a SIBLING of the NavLink, so NavLink's own isActive cannot
  // reach it. These rows are not memoized, and the list already re-renders on
  // navigation, so this subscription is not the #960 tree regression.
  const isActive = conversationIdFromPath(location.pathname) === conversation.id;

  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const rename = useRenameConversation();

  const rowRef = useRef<HTMLLIElement>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const kebabRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Escape cancels; the blur that follows must not commit what Escape discarded.
  const cancelledRef = useRef(false);
  const returnFocusRef = useRef(false);

  // After commit or cancel, focus returns to the row link.
  useEffect(() => {
    if (editing || !returnFocusRef.current) return;
    returnFocusRef.current = false;
    linkRef.current?.focus();
  }, [editing]);

  const startRename = useCallback(() => {
    cancelledRef.current = false;
    setDraft(conversation.title);
    setEditing(true);
  }, [conversation.title]);

  const exitEditing = useCallback(() => {
    returnFocusRef.current = true;
    setEditing(false);
  }, []);

  const commit = useCallback(async () => {
    if (cancelledRef.current) return;
    // Enter awaits mutateAsync with the input still mounted; if focus moves
    // during the request, the resulting blur would otherwise fire a second,
    // unguarded commit() and double-PATCH.
    if (rename.isPending) return;
    const next = draft.trim();
    // Empty or unchanged is a silent cancel — never a PATCH.
    if (!next || next === conversation.title) {
      exitEditing();
      return;
    }
    try {
      await rename.mutateAsync({ id: conversation.id, title: next });
      exitEditing();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'The conversation could not be renamed.',
      );
      inputRef.current?.focus();
    }
  }, [draft, conversation.id, conversation.title, rename, exitEditing]);

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void commit();
        return;
      }
      if (event.key === 'Escape') {
        // Both halves, for different reasons: preventDefault is the flag
        // `use-keyboard-shortcuts` reads (#1206); stopPropagation is what keeps
        // the key off every other document listener. There is no portal here,
        // so absorbPortalEscape does not apply — the calls are made by hand.
        event.preventDefault();
        event.stopPropagation();
        cancelledRef.current = true;
        exitEditing();
      }
    },
    [commit, exitEditing],
  );

  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Radix portals its menu content out of the DOM but not out of the React
      // tree and replays events up it (the reason useToolbarRovingFocus guards
      // with root.contains), so an open menu's arrows would otherwise move the
      // list underneath it.
      const row = rowRef.current;
      if (row && event.target instanceof Node && !row.contains(event.target)) return;
      if (editing) return;

      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
        event.preventDefault();
        setMenuOpen(true);
        return;
      }

      if (event.target === kebabRef.current) {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          linkRef.current?.focus();
        }
        // Everything else on the kebab is Radix's Trigger contract (ArrowDown,
        // Enter, Space open the menu). The list must not also travel.
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        kebabRef.current?.focus();
        return;
      }

      onRowKeyDown(event, conversation.id);
    },
    [editing, onRowKeyDown, conversation.id],
  );

  return (
    <li
      ref={rowRef}
      // `group/row` is what the kebab's hover/focus-within visibility keys on;
      // `relative` is what its `right-1` resolves against.
      className="group/row relative flex h-7 items-center"
      onKeyDown={handleRowKeyDown}
      onFocus={() => onRowFocus(conversation.id)}
    >
      {editing ? (
        <input
          ref={inputRef}
          autoFocus
          className="nm-input h-6 w-full text-[13px]"
          aria-label={`Rename ${conversation.title}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={handleInputKeyDown}
          onBlur={() => void commit()}
        />
      ) : (
        <NavLink
          ref={linkRef}
          to={conversationPath(conversation.id)}
          title={conversation.title}
          data-row-id={conversation.id}
          tabIndex={tabIndex}
          onClick={onNavigate}
          className={({ isActive: active }) =>
            cn(
              // The focus ring is the tree row's: this link is the list's single
              // tab stop, so it must show focus.
              'flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 pr-7 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              active
                ? 'nav-selection font-medium'
                : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
            )
          }
        >
          <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
          {conversation.pageTitle && (
            // A label, never a hue (a category, ADR-010). The sr-only prefix is
            // real text: an aria-label on a plain span is prohibited naming.
            <span
              className={cn(neutralChipClass, 'max-w-[45%] truncate')}
              title={conversation.pageTitle}
            >
              <span className="sr-only">Page: </span>
              {conversation.pageTitle}
            </span>
          )}
        </NavLink>
      )}

      {/* Not rendered while renaming: the input is w-full and the kebab is
          absolutely positioned over it. Radix's FocusScope still dispatches its
          unmount-auto-focus, which the menu's onCloseAutoFocus guard swallows,
          so focus stays in the field. */}
      {!editing && (
        <ConversationRowMenu
          conversation={conversation}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onRename={startRename}
          triggerRef={kebabRef}
          visible={isActive}
        />
      )}
    </li>
  );
}
