import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import * as Popover from '@radix-ui/react-popover';

import { useKeyboardShortcuts } from '../../hooks/use-keyboard-shortcuts';
import { absorbBlockMenuEscape } from './use-block-menu-target';

/**
 * #1179 — Escape must close the block menu and stop there.
 *
 * Found in a browser: Escape with the menu open ALSO exited edit mode, and with
 * unsaved changes that surfaced a "Discard changes?" prompt. Root cause is in
 * `use-keyboard-shortcuts`: it suppresses single-key shortcuts only when
 * `isEditableTarget(event)` is true — focus inside `.tiptap`, an input, or a
 * contentEditable. This menu is portalled to `<body>` and Radix moves focus
 * into it, so the target is none of those, the gate passes, and
 * `PageViewPage`'s `Escape` shortcut runs `handleCancelEditing()`.
 *
 * `preventDefault` does not help: the hook consults `defaultPrevented` only in
 * its blur-a-native-input branch, never in the dispatch loop. The key has to be
 * stopped before it reaches `document`.
 *
 * These run the REAL hook rather than a stand-in. An earlier version of this
 * file modelled it as "bails when it sees a `[role="dialog"]`" and proved
 * nothing — the hook has no such check, so the imitation passed with the fix
 * removed. Anything portalled hits this, so the test is written against the
 * hook itself and needs no drag handle.
 */

interface HarnessProps {
  open: boolean;
  onClose: () => void;
  onExit: () => void;
  /** Off = the pre-fix behaviour, for the mutation check. */
  contain?: boolean;
}

function Harness({ open, onClose, onExit, contain = true }: HarnessProps) {
  useKeyboardShortcuts([
    {
      key: 'Escape',
      keys: ['Escape'],
      description: 'Exit edit mode',
      category: 'editor',
      action: onExit,
    },
  ]);

  return (
    <Popover.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Popover.Anchor asChild><span data-testid="anchor" tabIndex={-1}>handle</span></Popover.Anchor>
      {open && (
        <Popover.Portal>
          <Popover.Content
            aria-label="Paragraph block actions"
            onKeyDown={contain ? (event) => absorbBlockMenuEscape(event, onClose) : undefined}
          >
            <button type="button" data-testid="menu-item">Delete block</button>
          </Popover.Content>
        </Popover.Portal>
      )}
    </Popover.Root>
  );
}

function press(open: boolean, contain: boolean) {
  const onClose = vi.fn();
  const onExit = vi.fn();
  const { getByTestId } = render(
    <Harness open={open} onClose={onClose} onExit={onExit} contain={contain} />,
  );

  // Focus where it actually sits: Radix moves it into the content on open. The
  // bug is entirely about `event.target` being outside `.tiptap`.
  const target = open ? getByTestId('menu-item') : getByTestId('anchor');
  target.focus();
  fireEvent.keyDown(target, { key: 'Escape' });

  return { onClose, onExit };
}

afterEach(cleanup);

describe('block menu Escape containment', () => {
  it('closes the menu and leaves edit mode alone', () => {
    const { onClose, onExit } = press(true, true);

    expect(onClose).toHaveBeenCalled();
    // The whole point. Without the containment this is 1 and the user is out of
    // the editor, staring at a discard prompt.
    expect(onExit).not.toHaveBeenCalled();
  });

  // Radix handles Escape in the CAPTURE phase and dismisses before this
  // bubble-phase handler runs, so the close callback genuinely fires twice for
  // one key press. The containment cannot prevent that — it stops the key from
  // reaching `document`, which happens after Radix has already acted. Closing
  // is therefore made idempotent at the source; see the
  // "closing twice does nothing the second time" test in
  // `use-block-menu-target.test.ts`.
  it('fires close for the key, alongside Radix\'s own dismissal', () => {
    const { onClose } = press(true, true);
    expect(onClose).toHaveBeenCalled();
  });

  // Scoped to "while the menu is open": with it closed, Escape has to behave
  // exactly as it did before this feature existed.
  it('leaves Escape alone when the menu is closed', () => {
    const { onClose, onExit } = press(false, true);

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  // Pins that the test can actually see the defect — an imitation of the hook
  // could not, and passed either way.
  it('reproduces the defect when the containment is removed', () => {
    const { onExit } = press(true, false);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

describe('absorbBlockMenuEscape', () => {
  it('stops the key and closes, for Escape', () => {
    const close = vi.fn();
    const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };

    expect(absorbBlockMenuEscape(event, close)).toBe(true);
    // stopPropagation is the load-bearing one: the shortcut ignores
    // defaultPrevented in its dispatch loop.
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('ignores every other key, so typing in the menu still works', () => {
    const close = vi.fn();
    const event = { key: 'a', preventDefault: vi.fn(), stopPropagation: vi.fn() };

    expect(absorbBlockMenuEscape(event, close)).toBe(false);
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
