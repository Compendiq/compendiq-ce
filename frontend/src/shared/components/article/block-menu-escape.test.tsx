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
 * unsaved changes that surfaced a "Discard changes?" prompt. The menu is
 * portalled to `<body>`, so `isEditableTarget(event)` is false, the shared
 * hook's editable gate passes, and `PageViewPage`'s `Escape` shortcut runs
 * `handleCancelEditing()`.
 *
 * ## Two fixes, at two layers — and BOTH are wanted
 *
 * This file originally recorded a third finding: `preventDefault` alone did not
 * help either, because `use-keyboard-shortcuts` consulted `defaultPrevented`
 * only in its blur-a-native-input branch and never in its dispatch loop. That
 * was a bug in the shared hook affecting every portalled layer in the app, and
 * **#1206 fixed it there** — single-key shortcuts now yield to a claimed
 * keystroke.
 *
 * So the grid below no longer reads as "only `escapeContained` works". With
 * #1206 in, Radix marks the Escape `defaultPrevented` on its own and the hook
 * honours that, which is why the `none`, `onKeyDown` and `escapePreventOnly`
 * rows now contain the key too. **That is the fix working, not this one being
 * redundant**, and the rows are kept rather than deleted precisely so a
 * regression in #1206's gate shows up here as well as in its own suite.
 *
 * `absorbBlockMenuEscape` still ships, and still does both halves:
 *
 * - `preventDefault()` — so Radix skips its own dismissal and `close` runs once
 *   rather than twice. This was never about the shortcut.
 * - `stopPropagation()` — belt and braces over #1206's gate. It is the only
 *   half that does not depend on some *other* layer having marked the event,
 *   and it keeps the menu's Escape from reaching document listeners that have
 *   nothing to do with `use-keyboard-shortcuts`.
 *
 * ## What the grid still measures
 *
 * The `wiring` axis is now about **where containment comes from**, and the
 * `syncUnmount` / `from` axes still model the two independent reasons an
 * `onKeyDown` handler is not a containment mechanism at all:
 *
 * 1. **The fiber is unmounted before React dispatches** — the production cause.
 *    Radix dismisses from a `document` capture listener; React delegates at the
 *    root and rebuilds its synthetic path from the FIBER tree when its own
 *    listener runs, so a component unmounted during capture has nothing left to
 *    dispatch to. Measured in Chrome with focus genuinely INSIDE the popover.
 * 2. **The element is not on the propagation path** — real, but a canary. It
 *    needs focus outside the layer, and in the real flow Radix has auto-focused
 *    the content, so this does not arise in the app.
 *
 * Removing a DOM *node* mid-dispatch models NEITHER: the spec computes the path
 * at dispatch, and React keeps dispatching to a live fiber. It has to be a real
 * unmount (`flushSync`) or a different target. That is why `onKeyDown` must not
 * be reinstated as the wiring even though it now looks green — its containment
 * comes entirely from #1206, and it contributes nothing of its own.
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
  fireEvent.keyDown(target, { key: 'Escape', cancelable: true });

  return { onClose, onExit };
}

afterEach(cleanup);

/**
 * The full grid: every wiring against both causes. Table-driven rather than a
 * few hand-picked cases, because the way this shipped broken was a suite that
 * happened to exercise the single cell where `onKeyDown` looks correct.
 *
 * **`exits: false` everywhere is the point, and it is #1206's doing.** Before
 * that fix landed, the first twelve rows all read `exits: true` — the shortcut
 * fired no matter what the layer did, because the hook's dispatch loop never
 * consulted `defaultPrevented`. Radix marks the Escape itself, so once the hook
 * honours the flag every wiring contains the key.
 *
 * The rows are kept at their new values rather than deleted, because they are
 * now a second witness for #1206's gate: break it and this file goes red
 * alongside `use-keyboard-shortcuts.default-prevented.test.tsx`. What they no
 * longer are is an argument for `escapeContained` over the alternatives — see
 * the `absorbBlockMenuEscape` assertions below for the two things it still does
 * that nothing else does.
 */
const GRID: ReadonlyArray<{
  wiring: Wiring;
  from: From;
  syncUnmount: boolean;
  exits: boolean;
}> = [
  // No containment at the layer at all. Contained anyway, entirely by #1206:
  // Radix's DismissableLayer marks the event and the hook now yields to it.
  // These four are the ones that regress loudest if that gate is removed.
  { wiring: 'none', from: 'menu', syncUnmount: false, exits: false },
  { wiring: 'none', from: 'menu', syncUnmount: true, exits: false },
  { wiring: 'none', from: 'body', syncUnmount: false, exits: false },
  { wiring: 'none', from: 'body', syncUnmount: true, exits: false },

  // `onKeyDown` + stopPropagation. Green now, but it contributes NOTHING of its
  // own: React cannot dispatch to an unmounted fiber (cause 1, the production
  // case) or to an element off the propagation path (cause 2), so in three of
  // these four cells the handler never runs and #1206 is doing all the work.
  // Do not read these as a licence to reinstate it as the wiring.
  { wiring: 'onKeyDown', from: 'menu', syncUnmount: false, exits: false },
  { wiring: 'onKeyDown', from: 'menu', syncUnmount: true, exits: false },
  { wiring: 'onKeyDown', from: 'body', syncUnmount: false, exits: false },
  { wiring: 'onKeyDown', from: 'body', syncUnmount: true, exits: false },

  // `onEscapeKeyDown` with preventDefault only. This is the row set that #1206
  // changed outright: `preventDefault` is now exactly the signal the hook reads,
  // so the half-fix is no longer a half-fix as far as the shortcut goes. It
  // still leaves the key propagating to every other document listener, which is
  // why `stopPropagation` stays in what ships.
  { wiring: 'escapePreventOnly', from: 'menu', syncUnmount: false, exits: false },
  { wiring: 'escapePreventOnly', from: 'menu', syncUnmount: true, exits: false },
  { wiring: 'escapePreventOnly', from: 'body', syncUnmount: false, exits: false },
  { wiring: 'escapePreventOnly', from: 'body', syncUnmount: true, exits: false },

  // What ships: robust in all four, and the only wiring that does not depend on
  // some other layer having marked the event first.
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
  //
  // This is also the grid's negative control. Every row above now expects
  // `exits: false`, so on its own the grid would pass for a hook that
  // suppressed Escape unconditionally. This is the cell that fails if it does.
  it('leaves Escape alone when the menu is closed', () => {
    const { onClose, onExit } = press(false, 'escapeContained', 'body');

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  // What `escapeContained` still buys over `escapePreventOnly` now that #1206
  // reads `defaultPrevented`: the key never reaches document listeners at all.
  //
  // `use-keyboard-shortcuts` is not the only thing listening on `document`, and
  // the rest have no reason to consult a flag Radix set. `preventDefault` alone
  // leaves the keystroke propagating to every one of them; this is the half that
  // does not depend on the listener being well behaved.
  it.each([
    { wiring: 'escapePreventOnly' as const, reaches: true },
    { wiring: 'escapeContained' as const, reaches: false },
  ])('$wiring -> Escape reaches other document listeners: $reaches', ({ wiring, reaches }) => {
    const bystander = vi.fn();
    document.addEventListener('keydown', bystander);
    try {
      press(true, wiring, 'body');
      expect(bystander).toHaveBeenCalledTimes(reaches ? 1 : 0);
    } finally {
      document.removeEventListener('keydown', bystander);
    }
  });
});

describe('absorbBlockMenuEscape', () => {
  it('stops the key both ways and closes', () => {
    const close = vi.fn();
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };

    absorbBlockMenuEscape(event, close);

    // preventDefault: Radix must skip its own dismissal, since we close here.
    // Since #1206 it is also the signal `use-keyboard-shortcuts` reads.
    expect(event.preventDefault).toHaveBeenCalled();
    // stopPropagation: keeps the key off every OTHER document listener, none of
    // which has any reason to consult a flag Radix set. Measured by the
    // bystander test above rather than only asserted here.
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});
