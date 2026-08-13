import { useCallback, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Tag } from 'lucide-react';
import { cn } from '../lib/cn';
import { absorbPortalEscape } from '../lib/absorb-portal-escape';
import { tagChipLabel } from '../lib/tag-utils';
import { TagEditor, type TagEditorHandle } from './TagEditor';

interface TagPopoverProps {
  /** Current tags on the page */
  tags: string[];
  /** Called when a tag is added */
  onAddTag: (tag: string) => void;
  /** Called when a tag is removed */
  onRemoveTag: (tag: string) => void;
  /** All known tags for autocomplete suggestions */
  suggestions?: string[];
  /** Whether mutation is in-flight */
  isLoading?: boolean;
  /** Additional CSS classes for the trigger */
  className?: string;
}

/**
 * The edit bar's tag control: a property chip that opens `TagEditor`.
 *
 * `TagEditor` used to sit open in the sticky action row, where it stacked a pill
 * row, a 12px gap and an input row into ~92px of permanently pinned chrome —
 * the only bar in the app that was not 48px, on the one route where vertical
 * space matters most. Collapsed to a chip the row lands on 48px and the
 * document gets 44px back at every width.
 *
 * The inspector's Details tab is the better *grouping* — tags belong with space,
 * parent and version — but `ArticleRightPane` is `hidden md:flex`, so that would
 * make tagging impossible while editing on a phone, and ADR-010 pins
 * `useIsDockWideLayout()` as the only JS width query in the app, so a second
 * mobile control is not available either. One control that works everywhere beat
 * a better grouping that needs two.
 *
 * The editor itself is untouched inside — same pills, same autocomplete, same
 * immediate `useUpdatePageLabels` write.
 */
export function TagPopover({
  tags,
  onAddTag,
  onRemoveTag,
  suggestions,
  isLoading = false,
  className,
}: TagPopoverProps) {
  const [open, setOpen] = useState(false);
  const editorRef = useRef<TagEditorHandle>(null);

  // Escape peels one layer at a time: an open autocomplete claims the key, and
  // only a second Escape closes the popover. The peel has to be decided here
  // rather than in `TagEditor`'s own keydown, because Radix takes Escape at
  // `document` with `capture: true` — it sees the key before React dispatches
  // from its root container, so the editor's handler never runs at all.
  const closeOrPeel = useCallback(() => {
    if (editorRef.current?.dismissSuggestions()) return;
    setOpen(false);
  }, []);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        type="button"
        data-testid="tag-popover-trigger"
        title="Tags"
        aria-label="Tags"
        className={cn(
          'flex h-7 min-w-[1.75rem] shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground data-[state=open]:bg-foreground/10 data-[state=open]:text-foreground',
          className,
        )}
      >
        <Tag size={15} className="shrink-0" aria-hidden />
        <span className="tabular-nums text-[11px] font-medium">{tagChipLabel(tags.length)}</span>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          side="bottom"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Page tags"
          data-testid="tag-popover-content"
          className={cn(
            'nm-card-elevated z-50 w-[min(20rem,calc(100vw-2rem))] p-3',
            'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95',
          )}
          // Half of the autofocus mechanism. Child effects run before parent
          // effects, so `TagEditor`'s focus() already fired by the time Radix's
          // FocusScope mounts — letting it run would pull the caret back out of
          // the input and onto this wrapper.
          onOpenAutoFocus={(event) => event.preventDefault()}
          // Escape must not reach `document` in EITHER branch. Bare Escape is
          // bound to `handleCancelEditing()`, so an unmarked key dismisses this
          // popover AND throws the user out of edit mode into "Discard
          // changes?" — peeling a suggestion list is no reason to let it
          // through. `onEscapeKeyDown`, never `onKeyDown` — see
          // absorb-portal-escape.
          onEscapeKeyDown={(event) => absorbPortalEscape(event, closeOrPeel)}
        >
          <TagEditor
            ref={editorRef}
            tags={tags}
            onAddTag={onAddTag}
            onRemoveTag={onRemoveTag}
            suggestions={suggestions}
            isLoading={isLoading}
            autoFocus
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
