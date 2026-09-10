import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import * as Popover from '@radix-ui/react-popover';

import { useKeyboardShortcuts, type ShortcutDefinition } from './use-keyboard-shortcuts';

/**
 * `use-keyboard-shortcuts` must not fire a single-key shortcut for a keystroke
 * another handler has already claimed.
 *
 * Found in a browser on `dev`: with the article in edit mode, opening the Text
 * Color picker (`Editor.tsx` — a bare Radix Popover) and pressing Escape closed
 * the popover **and** exited edit mode, surfacing "Discard changes?" for what
 * should have been "close this popover". `StatusBadgeView.tsx` has the same
 * shape. The instrumented trace:
 *
 *     document CAPTURE:  dialogPresent=true    defaultPrevented=false
 *     body     BUBBLE:   dialogPresent=FALSE   defaultPrevented=TRUE
 *     document BUBBLE:   dialogPresent=FALSE   defaultPrevented=TRUE
 *     -> edit mode exited
 *
 * Radix's `DismissableLayer` handles Escape from a **capture** listener on
 * `document` (`@radix-ui/react-use-escape-keydown` registers with
 * `{ capture: true }`), calls `preventDefault()` and dismisses. This hook
 * listens in **bubble**. So by the time it runs, two things are true at once:
 * the layer can already be unmounted — which is why `PageViewPage`'s
 * `[role="dialog"]` probe queried an empty DOM and found nothing — and
 * `defaultPrevented` is `true`. The flag was the only surviving evidence, and
 * the dispatch loop never read it.
 *
 * These tests run the REAL hook against a REAL Radix Popover, so the claim
 * being made is about Radix's actual timing rather than a re-enactment of it.
 * Two things are modelled deliberately, because a related fix in this repo
 * (#1205) passed jsdom and failed in a browser by testing neither:
 *
 * 1. **Dispatch position.** Escape arrives from inside the layer *and* from
 *    `document.body`. The `body` case is what the browser trace shows once
 *    Radix has torn its focus scope down.
 * 2. **Synchronous fiber unmount during capture.** `flushSync(() => …)` from a
 *    capture listener registered on a LATER commit than the layer's own, so it
 *    runs after Radix's. Removing a DOM *node* mid-dispatch would model
 *    nothing: the spec computes the propagation path at dispatch time. It has
 *    to be a real unmount.
 *
 * The grid also carries the two cells a one-sided guard would fail: a claimed
 * keystroke with **no** claimant (`none` — the shortcut must still fire), and
 * the whole `MODIFIER_GRID` below (a modifier chord must fire even when
 * claimed). A guard that suppressed everything would pass half of this file.
 */

/** How — and whether — the Escape gets claimed before the hook sees it. */
type Claimant =
  /** A bare Radix Popover with no containment: the production repro. */
  | 'radix'
  /** A plain capture listener that only calls preventDefault(). */
  | 'capturePrevent'
  /** Nothing claims the key. The control: the shortcut MUST still fire. */
  | 'none';

/** Where the key comes from. `body` is the position the browser trace shows. */
type From = 'layer' | 'body';

interface HarnessProps {
  claimant: Claimant;
  onExit: () => void;
  onSave: () => void;
  /**
   * Unmount the layer synchronously from a capture listener, the way Radix
   * does in a browser. Registered on a later commit so it runs after the
   * layer's own capture listener — registering first would tear the layer down
   * before it ever saw the key, which measures nothing.
   */
  syncUnmount?: boolean;
}

function Harness({ claimant, onExit, onSave, syncUnmount = false }: HarnessProps) {
  const [mounted, setMounted] = useState(true);
  const [afterLayer, setAfterLayer] = useState(false);
  useEffect(() => { setAfterLayer(true); }, []);

  // The non-Radix claimant: preventDefault only, nothing else. Proves the hook
  // gates on the flag itself and not on anything Radix-shaped. It claims
  // *every* key, not just Escape, so the modifier grid below exercises a
  // genuinely claimed chord rather than an unclaimed one.
  useEffect(() => {
    if (claimant !== 'capturePrevent') return;
    const handler = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener('keydown', handler, { capture: true });
    return () => document.removeEventListener('keydown', handler, { capture: true });
  }, [claimant]);

  useEffect(() => {
    if (!syncUnmount || !afterLayer) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      flushSync(() => setMounted(false));
    };
    document.addEventListener('keydown', handler, { capture: true });
    return () => document.removeEventListener('keydown', handler, { capture: true });
  }, [syncUnmount, afterLayer]);

  const shortcuts: ShortcutDefinition[] = [
    {
      key: 'Escape',
      keys: ['Escape'],
      description: 'Exit edit mode',
      category: 'editor',
      action: onExit,
    },
    {
      key: 'Ctrl+S',
      keys: ['s'],
      mod: true,
      description: 'Save current page',
      category: 'editor',
      action: onSave,
    },
  ];
  useKeyboardShortcuts(shortcuts);

  if (claimant === 'radix') {
    return (
      <Popover.Root open>
        <Popover.Anchor asChild>
          <span data-testid="anchor" tabIndex={-1}>swatch</span>
        </Popover.Anchor>
        {mounted && (
          <Popover.Portal>
            <Popover.Content aria-label="Text colour swatches">
              <button type="button" data-testid="layer-item">Red</button>
            </Popover.Content>
          </Popover.Portal>
        )}
      </Popover.Root>
    );
  }

  // A hand-rolled portalled overlay, so `from: 'layer'` and `syncUnmount` mean
  // the same thing in every row of the grid. This shape is real in the app —
  // `AiDockSheet`, `ProviderEditModal` and the mobile sidebar are all
  // hand-rolled `role="dialog"` overlays that never call preventDefault.
  return (
    <>
      <span data-testid="anchor" tabIndex={-1}>swatch</span>
      {mounted
        && createPortal(
          <div role="dialog" aria-label="Hand-rolled layer">
            <button type="button" data-testid="layer-item">Red</button>
          </div>,
          document.body,
        )}
    </>
  );
}

function press(
  claimant: Claimant,
  from: From,
  syncUnmount: boolean,
  key: { key: string; ctrlKey?: boolean },
) {
  const onExit = vi.fn();
  const onSave = vi.fn();
  const { getByTestId } = render(
    <Harness claimant={claimant} onExit={onExit} onSave={onSave} syncUnmount={syncUnmount} />,
  );

  let target: HTMLElement;
  if (from === 'layer') {
    target = getByTestId('layer-item');
    target.focus();
  } else {
    target = document.body;
  }
  fireEvent.keyDown(target, { ...key, bubbles: true, cancelable: true });

  return { onExit, onSave };
}

afterEach(cleanup);

interface Cell {
  claimant: Claimant;
  from: From;
  syncUnmount: boolean;
  fires: boolean;
}

/**
 * Escape — a single-key shortcut. Fires iff nothing claimed the keystroke.
 * Table-driven rather than hand-picked, because the way this shipped broken was
 * a suite that only ever exercised the unclaimed case.
 */
const SINGLE_KEY_GRID: readonly Cell[] = [
  // Real Radix Popover, no containment: the shipped defect, in all four cells.
  { claimant: 'radix', from: 'layer', syncUnmount: false, fires: false },
  { claimant: 'radix', from: 'layer', syncUnmount: true, fires: false },
  { claimant: 'radix', from: 'body', syncUnmount: false, fires: false },
  { claimant: 'radix', from: 'body', syncUnmount: true, fires: false },

  // preventDefault() and nothing else — no unmount, no Radix, layer still in
  // the DOM. Isolates the flag as the thing being read.
  { claimant: 'capturePrevent', from: 'layer', syncUnmount: false, fires: false },
  { claimant: 'capturePrevent', from: 'layer', syncUnmount: true, fires: false },
  { claimant: 'capturePrevent', from: 'body', syncUnmount: false, fires: false },
  { claimant: 'capturePrevent', from: 'body', syncUnmount: true, fires: false },

  // Unclaimed. A guard that suppressed everything would pass the rows above
  // and fail these — including with an open `role="dialog"` on screen, which
  // is why `PageViewPage` keeps its own `[role="dialog"]` probe on top.
  { claimant: 'none', from: 'layer', syncUnmount: false, fires: true },
  { claimant: 'none', from: 'layer', syncUnmount: true, fires: true },
  { claimant: 'none', from: 'body', syncUnmount: false, fires: true },
  { claimant: 'none', from: 'body', syncUnmount: true, fires: true },
];

/**
 * Ctrl+S — a modifier chord. Fires in every cell, claimed or not. Modifier
 * shortcuts are app-level: they already punch through editable elements and
 * through the WCAG single-key toggle, and `defaultPrevented` does not change
 * that. The editor is the most preventDefault-heavy surface in the app
 * (ProseMirror's keymap prevents every binding it handles) and Ctrl+S has to
 * keep saving from inside it.
 *
 * `capturePrevent` claims every key, so these four rows are the load-bearing
 * ones: the chord itself is `defaultPrevented` when the hook sees it. A blanket
 * guard fails exactly here. The `radix` rows claim only Escape (that is all
 * `DismissableLayer` ever marks) and assert the weaker, still-useful thing —
 * an open popover does not disturb the chord.
 */
const MODIFIER_GRID: readonly Cell[] = [
  { claimant: 'capturePrevent', from: 'layer', syncUnmount: false, fires: true },
  { claimant: 'capturePrevent', from: 'layer', syncUnmount: true, fires: true },
  { claimant: 'capturePrevent', from: 'body', syncUnmount: false, fires: true },
  { claimant: 'capturePrevent', from: 'body', syncUnmount: true, fires: true },
  { claimant: 'radix', from: 'layer', syncUnmount: false, fires: true },
  { claimant: 'radix', from: 'body', syncUnmount: true, fires: true },
  { claimant: 'none', from: 'layer', syncUnmount: false, fires: true },
  { claimant: 'none', from: 'body', syncUnmount: true, fires: true },
];

describe('single-key shortcuts yield to a claimed keystroke', () => {
  it.each(SINGLE_KEY_GRID)(
    'claimant=$claimant, from $from, syncUnmount=$syncUnmount -> Escape shortcut fires: $fires',
    ({ claimant, from, syncUnmount, fires }) => {
      const { onExit } = press(claimant, from, syncUnmount, { key: 'Escape' });
      expect(onExit).toHaveBeenCalledTimes(fires ? 1 : 0);
    },
  );

  it('is not special-cased to Escape', () => {
    const action = vi.fn();
    function CommaHarness() {
      useEffect(() => {
        const handler = (event: KeyboardEvent) => event.preventDefault();
        document.addEventListener('keydown', handler, { capture: true });
        return () => document.removeEventListener('keydown', handler, { capture: true });
      }, []);
      useKeyboardShortcuts([
        { key: ',', keys: [','], description: 'Toggle left sidebar', category: 'panels', action },
      ]);
      return null;
    }

    render(<CommaHarness />);
    fireEvent.keyDown(document.body, { key: ',' });

    expect(action).not.toHaveBeenCalled();
  });
});

describe('modifier shortcuts still fire for a claimed keystroke', () => {
  it.each(MODIFIER_GRID)(
    'claimant=$claimant, from $from, syncUnmount=$syncUnmount -> Ctrl+S fires: $fires',
    ({ claimant, from, syncUnmount, fires }) => {
      const { onSave } = press(claimant, from, syncUnmount, { key: 's', ctrlKey: true });
      expect(onSave).toHaveBeenCalledTimes(fires ? 1 : 0);
    },
  );
});

/**
 * Pins the mechanism itself, so the grid above cannot drift green for the wrong
 * reason. This is the browser trace, reproduced: at bubble time the flag is set
 * and the DOM probe is already useless.
 */
describe('the mechanism the fix relies on', () => {
  it('sees defaultPrevented=true and an empty [role="dialog"] probe at bubble time', () => {
    const seen: Array<{ defaultPrevented: boolean; dialogInDom: boolean }> = [];
    const probe = (event: KeyboardEvent) => {
      seen.push({
        defaultPrevented: event.defaultPrevented,
        dialogInDom: !!document.querySelector('[role="dialog"]'),
      });
    };
    // Registered BEFORE the hook's own listener so it observes, in bubble
    // phase, exactly the event state the hook is about to be handed.
    document.addEventListener('keydown', probe);

    try {
      const { getByTestId } = render(
        <Harness claimant="radix" onExit={vi.fn()} onSave={vi.fn()} syncUnmount />,
      );
      // Radix Popover.Content carries role="dialog" — present before the key.
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();

      fireEvent.keyDown(getByTestId('layer-item'), { key: 'Escape', cancelable: true });

      expect(seen).toEqual([{ defaultPrevented: true, dialogInDom: false }]);
    } finally {
      document.removeEventListener('keydown', probe);
    }
  });
});
