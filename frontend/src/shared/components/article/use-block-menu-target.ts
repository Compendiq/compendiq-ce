import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor as EditorType } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import {
  blockMenuTargetKey,
  clearBlockMenuTarget,
  createBlockMenuTargetPlugin,
  setBlockMenuTarget,
  setDragHandleLocked,
} from './block-menu-decoration';

/**
 * #1179 — the block context menu's open/close state and the editor-level side
 * effects that have to move with it.
 *
 * Split out of `EditorBlockHandle` so it can be tested. The component around it
 * cannot: the drag-handle plugin resolves its node from `mousemove` coordinates
 * and `getBoundingClientRect`, so under jsdom it never reports a node and the
 * menu can never be opened through the UI. That left the two side effects here
 * — marking the target and freezing the handle — with no coverage at all, and
 * an unreleased lock is invisible in tests but permanent for the user: the
 * handle stops tracking the pointer for the rest of the editor's life.
 *
 * Both effects are paired, and `close` must undo everything `open` did.
 */
export interface BlockMenuTarget {
  node: PMNode;
  pos: number;
}

export interface UseBlockMenuTargetResult {
  /** The block the menu is open on, or `null` when it is closed. */
  target: BlockMenuTarget | null;
  /** Note the block under the pointer. Cheap — a ref write, never a render. */
  setHovered: (hovered: BlockMenuTarget | null) => void;
  /** Open the menu on whatever `setHovered` last reported. */
  open: () => void;
  close: () => void;
}

export function useBlockMenuTarget(editor: EditorType): UseBlockMenuTargetResult {
  // The hovered block lives in a ref, not state: the drag-handle plugin fires
  // on every `mousemove` across the document, and re-rendering the editor tree
  // that often would be ruinous.
  const hoveredRef = useRef<BlockMenuTarget | null>(null);
  const [target, setTarget] = useState<BlockMenuTarget | null>(null);
  /** Mirrors `target` for the idempotence check in `close`, which must not
   *  wait for a re-render to know the menu is already shut. */
  const openRef = useRef(false);

  useEffect(() => {
    if (editor.isDestroyed) return;
    editor.registerPlugin(createBlockMenuTargetPlugin());
    return () => { editor.unregisterPlugin(blockMenuTargetKey); };
  }, [editor]);

  const setHovered = useCallback((hovered: BlockMenuTarget | null) => {
    hoveredRef.current = hovered;
  }, []);

  const open = useCallback(() => {
    const hovered = hoveredRef.current;
    if (!hovered || editor.isDestroyed) return;
    setDragHandleLocked(editor, true);
    setBlockMenuTarget(editor, hovered.pos);
    openRef.current = true;
    setTarget(hovered);
  }, [editor]);

  // Closing is idempotent: the Escape handler closes explicitly and Radix may
  // still run its own dismissal for the same key, so `close` is called twice in
  // the same tick. Re-dispatching the unlock and the marker clear on an already
  // closed menu is harmless but noisy, and hides double-close bugs.
  const close = useCallback(() => {
    if (!openRef.current) return;
    openRef.current = false;
    setTarget(null);
    if (editor.isDestroyed) return;
    clearBlockMenuTarget(editor);
    setDragHandleLocked(editor, false);
  }, [editor]);

  // A menu open when the editor goes away would leave the handle locked and the
  // marker set on an editor nobody can see.
  useEffect(() => () => {
    if (!editor.isDestroyed) setDragHandleLocked(editor, false);
  }, [editor]);

  return { target, setHovered, open, close };
}

/**
 * Absorb an Escape that the block menu is handling.
 *
 * **`onEscapeKeyDown` + `preventDefault()` + `stopPropagation()`. Not
 * `onKeyDown`: it is bypassed when the layer unmounts in Radix's capture pass,
 * and again when the key is dispatched from outside the layer. Not
 * `preventDefault` alone: the shortcut dispatch ignores `defaultPrevented`.**
 *
 * Those are two independent sufficient causes plus a half-fix, and all three are
 * measured — `block-menu-escape.test.tsx` runs the full grid of every wiring
 * against both causes. `onKeyDown` contains the key in exactly one of four
 * cells (focus inside the menu, unmount deferred), which is RTL's default and
 * the reason a broken fix once passed a green suite.
 *
 * Both halves are needed:
 * - `preventDefault()` so Radix skips its own dismissal — we close here instead,
 *   so `close` runs once rather than twice.
 * - `stopPropagation()` on the NATIVE event so it never reaches the
 *   document-bubble listener in `use-keyboard-shortcuts`. That hook suppresses
 *   single-key shortcuts only when `isEditableTarget(event)` is true, and a
 *   portalled Radix layer is not editable — so `PageViewPage`'s `Escape` would
 *   run `handleCancelEditing()` and throw the user out of the editor, into a
 *   "Discard changes?" prompt if they had unsaved work. `preventDefault` alone
 *   does NOT stop it: the hook consults `defaultPrevented` only in its
 *   blur-a-native-input branch, never in the dispatch loop — a browser trace
 *   measured `defaultPrevented=true` at both bubble points with the shortcut
 *   firing regardless.
 *
 * The selection bubble menu avoids all of this only because its buttons
 * `preventDefault` on mousedown, so focus never leaves `.tiptap`.
 */
export function absorbBlockMenuEscape(
  event: { preventDefault: () => void; stopPropagation: () => void },
  close: () => void,
): void {
  event.preventDefault();
  event.stopPropagation();
  close();
}
