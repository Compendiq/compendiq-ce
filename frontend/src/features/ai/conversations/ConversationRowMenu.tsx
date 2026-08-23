import { useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import type { ConversationSummary } from '@compendiq/contracts';
import { cn } from '../../../shared/lib/cn';
import { absorbPortalEscape } from '../../../shared/lib/absorb-portal-escape';
import { ConfirmDialog } from '../../../shared/components/ConfirmDialog';
import { useDeleteConversation } from './use-conversation-mutations';

/**
 * The app's dropdown item recipe, stated once for the two items below
 * (`UserMenu.tsx:50` is the reference callsite). Delete adds
 * `nm-action-destructive` on top — the one inline destructive treatment.
 */
const MENU_ITEM =
  'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground data-[highlighted]:bg-foreground/10 data-[highlighted]:text-foreground transition-colors';

export interface ConversationRowMenuProps {
  conversation: ConversationSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Puts the row into inline rename mode; the row owns that state. */
  onRename: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** Force the kebab visible — the row is the open conversation. */
  visible: boolean;
}

export function ConversationRowMenu({
  conversation,
  open,
  onOpenChange,
  onRename,
  triggerRef,
  visible,
}: ConversationRowMenuProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const deleteConversation = useDeleteConversation();
  // Set by Rename's AND Delete's onSelect, read one tick later by
  // onCloseAutoFocus: Radix returns focus to the trigger as the layer
  // unmounts, in the same tick the next layer (the rename input, or
  // ConfirmDialog's own focus trap) would claim it, and without this the
  // trigger wins the race (the EditorToolbar trap). Delete needs the same
  // guard as Rename for a second reason: a completed delete unmounts the
  // whole row, kebab included, so a trigger that regained focus here would
  // leave the confirm dialog restoring focus to a node that no longer
  // exists once the mutation succeeds.
  const handoffPendingRef = useRef(false);

  return (
    <>
      <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
        <DropdownMenu.Trigger asChild>
          <button
            ref={triggerRef}
            type="button"
            // Reached with ArrowRight from the row, never with Tab: the list is
            // one tab stop and the row link is it.
            tabIndex={-1}
            aria-label={`Actions for ${conversation.title}`}
            className={cn(
              // 24x24 (WCAG 2.5.8). `nm-icon-button` is not usable here — it
              // hard-codes 2rem.
              'absolute right-1 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              // opacity-0 keeps it focusable; focus-within reveals it the
              // moment it is (WCAG 1.4.13 / 2.1.1). data-[state=open] is what
              // keeps it visible while the portalled menu holds focus.
              'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100',
              visible && 'opacity-100',
            )}
          >
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>

        {/* Portalled, as all six existing callsites are: un-portalled it renders
            inside the pane's overflow-y-auto nav inside the chassis's
            overflow-hidden aside and is clipped for rows near the bottom. */}
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-50 min-w-[160px] nm-card-elevated p-1"
            onEscapeKeyDown={(event) => absorbPortalEscape(event, () => onOpenChange(false))}
            onCloseAutoFocus={(event) => {
              if (handoffPendingRef.current) {
                handoffPendingRef.current = false;
                event.preventDefault();
              }
            }}
          >
            <DropdownMenu.Item
              className={MENU_ITEM}
              onSelect={() => {
                handoffPendingRef.current = true;
                onRename();
              }}
            >
              <Pencil size={14} aria-hidden="true" />
              Rename
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={cn(MENU_ITEM, 'nm-action-destructive')}
              onSelect={() => {
                handoffPendingRef.current = true;
                setConfirmOpen(true);
              }}
            >
              <Trash2 size={14} aria-hidden="true" />
              Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <ConfirmDialog
        open={confirmOpen}
        destructive
        title="Delete conversation?"
        description={`"${conversation.title}" will be permanently deleted. This can't be undone.`}
        confirmLabel="Delete"
        onConfirm={() => {
          setConfirmOpen(false);
          deleteConversation.mutate({ id: conversation.id, title: conversation.title });
        }}
        // Cancel and Escape do nothing but close (spec §Delete).
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
