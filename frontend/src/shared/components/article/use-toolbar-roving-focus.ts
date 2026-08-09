import { useCallback, useEffect, type KeyboardEvent, type FocusEvent, type RefObject } from 'react';

/**
 * Roving tabindex for `role="toolbar"`, per the WAI-ARIA toolbar pattern.
 *
 * A toolbar is ONE tab stop. Arrow keys move between its controls; Tab leaves
 * it entirely. Without this the editor toolbar was 27 sequential tab stops
 * sitting between the prose and the Save button, which a keyboard user had to
 * traverse on every trip out of the document — in a product whose fifth
 * principle is that the keyboard is the primary input.
 *
 * Two details are load-bearing:
 *
 * 1. **The `contains` guard.** The toolbar hosts Radix menus and popovers, and
 *    portalled Radix content is a React child of this toolbar even though it is
 *    not a DOM descendant. React replays events up the *React* tree, so an
 *    ArrowRight pressed inside an open Insert menu arrives at this handler.
 *    Without the guard it would yank focus out of the menu mid-navigation.
 *    `root.contains(event.target)` is false for portalled content, which is
 *    exactly the discrimination needed.
 *
 * 2. **Vertical arrows are not intercepted.** ArrowDown on a menu trigger is
 *    Radix's own "open and focus the first item"; claiming it here would make
 *    every menu in the row unopenable from the keyboard.
 *
 * Items opt in with `data-toolbar-item`. Disabled ones are skipped rather than
 * focused-and-ignored, so Undo greying out does not strand the caret on it.
 */

export const TOOLBAR_ITEM_ATTR = 'data-toolbar-item';

const ALL = `[${TOOLBAR_ITEM_ATTR}]`;
const ENABLED = `${ALL}:not([disabled]):not([aria-disabled='true'])`;

/** Every opted-in control, including the disabled ones. */
function allItemsOf(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ALL));
}

/** The ones arrow keys may land on. */
function itemsOf(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ENABLED));
}

/**
 * Give exactly one item `tabIndex=0` and the rest `-1`. Preference order:
 * whatever currently holds focus, else whatever already held the tab stop, else
 * the first item.
 *
 * `el.tabIndex` reads the IDL property, which is 0 for a `<button>` that has
 * never been assigned one — so on the very first pass every item looks like the
 * tab stop and the `findIndex` lands on the first, which is the wanted answer.
 */
function syncTabStop(root: HTMLElement): void {
  const items = itemsOf(root);
  if (items.length === 0) return;

  const focused = items.indexOf(document.activeElement as HTMLElement);
  const held = items.findIndex((el) => el.tabIndex === 0);
  const stop = focused >= 0 ? focused : held >= 0 ? held : 0;

  // Clear every opted-in control first, disabled ones included. A disabled
  // button is already skipped by the browser whatever its tabIndex, so leaving
  // it at the native 0 changes no behaviour — but it makes the DOM report three
  // tab stops where there is one, which is what any audit of this will read.
  allItemsOf(root).forEach((el) => {
    el.tabIndex = -1;
  });
  items[stop]!.tabIndex = 0;
}

export function useToolbarRovingFocus(rootRef: RefObject<HTMLElement | null>): {
  onKeyDown: (event: KeyboardEvent) => void;
  onFocus: (event: FocusEvent) => void;
} {
  // Deliberately no dependency array. The tab stop has to survive items
  // mounting and unmounting — the Vim toggle is conditional, Undo/Redo flip
  // between enabled and disabled as the history fills, and the toolbar
  // re-renders on every editor transaction anyway. Re-running a
  // querySelectorAll over ~15 nodes is cheaper than the bookkeeping needed to
  // know when the set changed, and it cannot go stale.
  useEffect(() => {
    const root = rootRef.current;
    if (root) syncTabStop(root);
  });

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root) return;

      const { key } = event;
      if (key !== 'ArrowRight' && key !== 'ArrowLeft' && key !== 'Home' && key !== 'End') return;
      // A modified arrow is a text-navigation or OS gesture, not toolbar travel.
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      // Portalled menu content bubbles here through the React tree; ignore it.
      if (!root.contains(event.target as Node)) return;

      const items = itemsOf(root);
      const current = items.indexOf(document.activeElement as HTMLElement);
      if (current < 0) return;

      const next =
        key === 'Home'
          ? 0
          : key === 'End'
            ? items.length - 1
            : key === 'ArrowRight'
              ? (current + 1) % items.length
              : (current - 1 + items.length) % items.length;

      event.preventDefault();
      items[next]?.focus();
      syncTabStop(root);
    },
    [rootRef],
  );

  const onFocus = useCallback(
    (event: FocusEvent) => {
      const root = rootRef.current;
      // Focus moving INTO portalled menu content must not move the tab stop —
      // the trigger keeps it, so Shift+Tab out of a closed menu lands where the
      // user left off.
      if (!root || !root.contains(event.target as Node)) return;
      syncTabStop(root);
    },
    [rootRef],
  );

  return { onKeyDown, onFocus };
}
