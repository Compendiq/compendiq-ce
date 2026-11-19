import { useCallback, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Tag } from 'lucide-react';
import { AI_POLICY_CANONICAL_LABELS, isReservedAiPolicyLabel } from '@compendiq/contracts';
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
  /**
   * Icon-only 32px trigger — the article write toolbar's compact form.
   * The accessible name stays the count label; only the visible text is dropped.
   */
  iconOnly?: boolean;
  /**
   * #283 — the server's verdict on the last label write, when it was refused
   * for article-AI-policy reasons (a contradictory reserved-label set, a
   * relaxation without policy authority, enforcement not activated). Shown as
   * visible prose inside the popover; the ordinary tag edits the user made
   * stay on screen. `null` when the last write was committed.
   */
  policyNotice?: string | null;
}

/**
 * The canonical reserved policy labels the editor may suggest (#283). They
 * are suggestions only: the SERVER normalizes synonyms, decides the resulting
 * policy under its authority rules, and restores the canonical label when a
 * reserved one is removed on its own — this control never infers a policy.
 */
export const RESERVED_POLICY_LABEL_SUGGESTIONS = Object.values(AI_POLICY_CANONICAL_LABELS);

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
 * parent and version — and below `md` that tab now lives in the page-inspector
 * sheet. This chip stays anyway: it is the in-flow control while writing, and a
 * sheet you have to open is the wrong place to reach for a label.
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
  iconOnly = false,
  policyNotice = null,
}: TagPopoverProps) {
  const [open, setOpen] = useState(false);
  const editorRef = useRef<TagEditorHandle>(null);
  const label = tagChipLabel(tags.length);
  // Offer the canonical reserved labels alongside the corpus labels, de-duplicated.
  const allSuggestions = useMemo(() => {
    const seen = new Set(suggestions ?? []);
    return [...(suggestions ?? []), ...RESERVED_POLICY_LABEL_SUGGESTIONS.filter((l) => !seen.has(l))];
  }, [suggestions]);
  const hasReservedLabel = tags.some((t) => isReservedAiPolicyLabel(t));

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
        aria-label={label}
        title={label}
        className={cn(
          iconOnly
            ? 'nm-icon-button shrink-0'
            : 'nm-button-ghost h-8 shrink-0 px-2.5 text-xs',
          className,
        )}
      >
        <Tag size={15} className="shrink-0" aria-hidden="true" />
        {!iconOnly && label}
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
            'nm-popover-glass z-50 w-[min(20rem,calc(100vw-2rem))] p-3',
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
            suggestions={allSuggestions}
            isLoading={isLoading}
            autoFocus
          />
          {/* #283 — reserved policy labels are a server contract, said here
              as prose so the editor does not look like a second policy
              control. Removing one alone does NOT relax the policy; the
              server restores its canonical label. A refused write is named
              with the server's reason; ordinary tag edits stay. */}
          {(hasReservedLabel || policyNotice) && (
            <div className="mt-2 space-y-1 text-xs text-muted-foreground" data-testid="tag-popover-policy-note">
              {hasReservedLabel && (
                <p>
                  Removing a reserved AI-policy label (all-ai, local-ai-only, no-ai) alone does not change the
                  article&apos;s policy; the canonical label is restored. Change the policy explicitly in
                  Details → AI policy.
                </p>
              )}
              {policyNotice && <p role="alert" data-testid="tag-popover-policy-notice">{policyNotice}</p>}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
