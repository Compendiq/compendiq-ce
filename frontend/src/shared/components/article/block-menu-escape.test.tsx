import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import * as Popover from '@radix-ui/react-popover';

import { useKeyboardShortcuts } from '../../hooks/use-keyboard-shortcuts';
import { absorbBlockMenuEscape } from './use-block-menu-target';

/**
 * #1179 — Escape must close the block menu and stop there.
 *
 * Found in a browser: Escape with the menu open ALSO exited edit mode, and with
 * unsaved changes that surfaced a "Discard changes?" prompt. The cause is in the
 * shared hook: `use-keyboard-shortcuts` suppresses single-key shortcuts only
 * when `isEditableTarget(event)` is true — focus inside `.tiptap`, an input, or
 * a contentEditable. This menu is portalled to `<body>`, so the target is none
 * of those, the gate passes, and `PageViewPage`'s `Escape` shortcut runs
 * `handleCancelEditing()`. `preventDefault` does not help: the hook consults
 * `defaultPrevented` only in its blur-a-native-input branch, never in the
 * dispatch loop.
 *
 * These run the REAL hook. An earlier version modelled it as "bails when it
 * sees a `[role="dialog"]`" and proved nothing — the hook has no such check.
 *
 * **Two independent sufficient causes, and these tests MODEL them.**
 *
 * 1. **The fiber is unmounted before React dispatches** — the production cause.
 *    Radix dismisses from a `document` capture listener; React delegates at the
 *    root and rebuilds its synthetic path from the FIBER tree when its own
 *    listener runs, so a component unmounted during capture has nothing left to
 *    dispatch to. Measured in Chrome with focus genuinely INSIDE the popover,
 *    which rules out cause 2 there.
 * 2. **The element is not on the propagation path** — real, but a canary. It
 *    needs focus outside the layer, and in the real flow Radix has auto-focused
 *    the content, so this does not arise in the app. Cheap to test and it does
 *    catch the broken wiring, so it stays — second, and labelled.
 *
 * Note that removing a DOM *node* mid-dispatch models NEITHER: the spec computes
 * the path at dispatch, and React keeps dispatching to a live fiber. It has to
 * be a real unmount (`flushSync`) or a different target.
 *
 *     wiring                 target  fiber unmount in capture   exits edit mode?
 *     onKeyDown              menu    deferred (RTL default)     no   <- misleading
 *     onKeyDown              menu    synchronous                YES  <- cause 1
 *     onKeyDown              body    either                     YES  <- cause 2
 *     onEscapeKeyDown+stop   either  either                     no   <- robust
 *
 * The misleading cell — menu dispatch with a deferred unmount — is RTL's default
 * and what an earlier version of this file used exclusively; it passed for a
 * wiring that did nothing in a browser.
 *
 * **Because these are models of Radix + React timing rather than the behaviour
 * itself, they can drift green if either library changes.** That is why
 * `EditorBlockMenu.test.tsx` also carries a one-line source guard on the wiring:
 * it costs nothing and does not depend on any of this being right.
 */

/**
 * Every wiring that has been proposed for this, so the grid can rule each out.
 * `escapeContained` is what ships.
 */
type Wiring = 'none' | 'onKeyDown' | 'escapePreventOnly' | 'escapeContained';

interface HarnessProps {
  open: boolean;
  onClose: () => void;
  onExit: () => void;
  wiring?: Wiring;
  /**
   * Unmount the content synchronously from a capture listener, the way Radix
   * does in a browser. Registered from the parent, so it runs after Content's
   * own effect — React runs child effects first.
   */
  syncUnmount?: boolean;
}

function Harness({ open, onClose, onExit, wiring = 'escapeContained', syncUnmount = false }: HarnessProps) {
  const [mounted, setMounted] = useState(true);
  // Register on a LATER commit than Radix's own capture listener. Same node and
  // phase means listeners fire in registration order, and a parent effect is
  // not late enough — React runs child effects first, but Radix's Content sits
  // behind a portal and presence layer. Registering first would tear Radix's
  // listener down before it ever handled the key, which measures nothing.
  const [afterRadix, setAfterRadix] = useState(false);
  useEffect(() => { setAfterRadix(true); }, []);
  useEffect(() => {
    if (!syncUnmount || !afterRadix) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      flushSync(() => setMounted(false));
    };
    document.addEventListener('keydown', handler, { capture: true });
    return () => document.removeEventListener('keydown', handler, { capture: true });
  }, [syncUnmount, afterRadix]);
  const showContent = open && (!syncUnmount || mounted);
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
      {showContent && (
        <Popover.Portal>
          <Popover.Content
            aria-label="Paragraph block actions"
            onKeyDown={wiring === 'onKeyDown'
              ? (event) => absorbBlockMenuEscape(event, onClose)
              : undefined}
            onEscapeKeyDown={
              wiring === 'escapeContained'
                ? (event) => absorbBlockMenuEscape(event, onClose)
                : wiring === 'escapePreventOnly'
                  // The half-fix: Radix stops dismissing, but the key still
                  // reaches the shortcut, which ignores `defaultPrevented`.
                  ? (event) => { event.preventDefault(); onClose(); }
                  : undefined
            }
          >
            <button type="button" data-testid="menu-item">Delete block</button>
          </Popover.Content>
        </Popover.Portal>
      )}
    </Popover.Root>
  );
}

/** Where the key comes from. `body` is the case a browser actually hit. */
type From = 'menu' | 'body';

function press(open: boolean, wiring: Wiring, from: From, syncUnmount = false) {
  const onClose = vi.fn();
  const onExit = vi.fn();
  const { getByTestId } = render(
    <Harness
      open={open}
      onClose={onClose}
      onExit={onExit}
      wiring={wiring}
      syncUnmount={syncUnmount}
    />,
  );

  let target: HTMLElement;
  if (!open) {
    target = getByTestId('anchor');
  } else if (from === 'menu') {
    target = getByTestId('menu-item');
    target.focus();
  } else {
    target = document.body;
  }
  fireEvent.keyDown(target, { key: 'Escape' });

  return { onClose, onExit };
}

afterEach(cleanup);

/**
 * The full grid: every wiring against both causes. Table-driven rather than a
 * few hand-picked cases, because the way this shipped broken was a suite that
 * happened to exercise the single cell where `onKeyDown` looks correct.
 */
const GRID: ReadonlyArray<{
  wiring: Wiring;
  from: From;
  syncUnmount: boolean;
  exits: boolean;
}> = [
  // No containment: the original defect, in all four cells.
  { wiring: 'none', from: 'menu', syncUnmount: false, exits: true },
  { wiring: 'none', from: 'menu', syncUnmount: true, exits: true },
  { wiring: 'none', from: 'body', syncUnmount: false, exits: true },
  { wiring: 'none', from: 'body', syncUnmount: true, exits: true },

  // `onKeyDown` + stopPropagation: contains in exactly ONE cell — focus inside
  // the menu with the unmount deferred, which is RTL's default and precisely
  // what an earlier version of this file tested. Bypassed by the fiber unmount
  // (cause 1, the production case) and by dispatch from outside (cause 2).
  { wiring: 'onKeyDown', from: 'menu', syncUnmount: false, exits: false },
  { wiring: 'onKeyDown', from: 'menu', syncUnmount: true, exits: true },
  { wiring: 'onKeyDown', from: 'body', syncUnmount: false, exits: true },
  { wiring: 'onKeyDown', from: 'body', syncUnmount: true, exits: true },

  // `onEscapeKeyDown` with preventDefault only: fails everywhere. The shortcut
  // dispatch gates solely on `isEditableTarget` and never consults
  // `defaultPrevented` — the shared-hook bug, measured rather than inferred.
  { wiring: 'escapePreventOnly', from: 'menu', syncUnmount: false, exits: true },
  { wiring: 'escapePreventOnly', from: 'menu', syncUnmount: true, exits: true },
  { wiring: 'escapePreventOnly', from: 'body', syncUnmount: false, exits: true },
  { wiring: 'escapePreventOnly', from: 'body', syncUnmount: true, exits: true },

  // What ships: robust in all four.
  { wiring: 'escapeContained', from: 'menu', syncUnmount: false, exits: false },
  { wiring: 'escapeContained', from: 'menu', syncUnmount: true, exits: false },
  { wiring: 'escapeContained', from: 'body', syncUnmount: false, exits: false },
  { wiring: 'escapeContained', from: 'body', syncUnmount: true, exits: false },
];

describe('block menu Escape containment', () => {
  it.each(GRID)(
    '$wiring, from $from, syncUnmount=$syncUnmount -> exits edit mode: $exits',
    ({ wiring, from, syncUnmount, exits }) => {
      const { onExit } = press(true, wiring, from, syncUnmount);
      expect(onExit).toHaveBeenCalledTimes(exits ? 1 : 0);
    },
  );

  // `preventDefault` makes Radix skip its own dismissal, so we close once.
  it('closes exactly once, because Radix skips its own dismissal', () => {
    const { onClose } = press(true, 'escapeContained', 'body');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Scoped to "while the menu is open": with it closed, Escape has to behave
  // exactly as it did before this feature existed.
  it('leaves Escape alone when the menu is closed', () => {
    const { onClose, onExit } = press(false, 'escapeContained', 'body');

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('absorbBlockMenuEscape', () => {
  it('stops the key both ways and closes', () => {
    const close = vi.fn();
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };

    absorbBlockMenuEscape(event, close);

    // preventDefault: Radix must skip its own dismissal, since we close here.
    expect(event.preventDefault).toHaveBeenCalled();
    // stopPropagation is the load-bearing half — the page shortcut ignores
    // defaultPrevented in its dispatch loop, as the browser trace confirmed.
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});
