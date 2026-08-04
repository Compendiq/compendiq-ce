import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Editor as EditorType } from '@tiptap/react';

/**
 * #1179 — target marker for the editor's block context menu.
 *
 * Two jobs, both of which the block menu cannot do with a plain `pos` snapshot:
 *
 * 1. **The position must survive edits.** The drag-handle plugin hands us
 *    `{ node, pos }` for the block under the pointer, but that `pos` is a plain
 *    number: any transaction (the user's own Improve replacement included)
 *    invalidates it. A ProseMirror decoration is remapped through every
 *    transaction, exactly as `improve-decoration.ts` does for the bubble menu's
 *    captured range, so reading the live range back gives a position that is
 *    always correct — or gone, if the block itself was removed.
 *
 * 2. **The user must see which block the menu acts on.** The menu is portalled
 *    to `<body>` and the editor is blurred while it is open, so nothing else
 *    marks the target. A *node* decoration (not the inline one the bubble menu
 *    uses) outlines the whole block, which is the only shape that works for
 *    atomic nodes like a draw.io diagram.
 *
 * The presence of a decoration is also how `selectionShouldShow` knows the block
 * menu owns the interaction and the selection bubble menu must stand down —
 * without it, the text selection the menu sets would pop a second panel on top.
 * The document is never mutated: decorations are a pure view overlay.
 *
 * Styled by `.block-menu-target` in `frontend/src/index.css`.
 */

/** Class applied to the targeted block; styled in `frontend/src/index.css`. */
export const BLOCK_MENU_TARGET_CLASS = 'block-menu-target';

export const blockMenuTargetKey = new PluginKey<DecorationSet>('editorBlockMenuTarget');

interface BlockMenuTargetMeta {
  /** Mark the block starting at this position (replaces any existing marker). */
  pos?: number;
  /** Remove the marker. */
  clear?: true;
}

export function createBlockMenuTargetPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: blockMenuTargetKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const meta = tr.getMeta(blockMenuTargetKey) as BlockMenuTargetMeta | undefined;
        if (meta?.clear) return DecorationSet.empty;
        if (meta?.pos !== undefined) {
          // `nodeAt` throws rather than returning null for an out-of-range
          // position, and the drag-handle plugin's `pos` can lag a fast edit.
          if (meta.pos < 0 || meta.pos >= tr.doc.content.size) return DecorationSet.empty;
          const node = tr.doc.nodeAt(meta.pos);
          if (!node) return DecorationSet.empty;
          return DecorationSet.create(tr.doc, [
            Decoration.node(meta.pos, meta.pos + node.nodeSize, {
              class: BLOCK_MENU_TARGET_CLASS,
            }),
          ]);
        }
        // Remap through document changes so the marker stays glued to the block
        // — and drops out entirely if the block was removed.
        return set.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return blockMenuTargetKey.getState(state);
      },
    },
  });
}

/** Mark the block at `pos` as the block menu's target. */
export function setBlockMenuTarget(editor: EditorType, pos: number): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(
    editor.state.tr.setMeta(blockMenuTargetKey, { pos } satisfies BlockMenuTargetMeta),
  );
}

/** Remove the marker (menu closed, block deleted, editor torn down). */
export function clearBlockMenuTarget(editor: EditorType): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(
    editor.state.tr.setMeta(blockMenuTargetKey, { clear: true } satisfies BlockMenuTargetMeta),
  );
}

/**
 * Transaction meta the drag-handle plugin reads to freeze itself. Named here
 * rather than written inline at the call site because a typo would be silent:
 * the plugin ignores metas it does not recognise, so the handle would keep
 * tracking the pointer and would null its node out the moment the pointer left
 * for the portalled menu.
 */
export const DRAG_HANDLE_LOCK_META = 'lockDragHandle';

/**
 * Freeze (`true`) or release (`false`) the drag handle. While locked the
 * plugin's `mousemove`, `mouseleave` and `keydown` handlers all early-return,
 * so the handle stays put and keeps pointing at the block the menu was opened
 * on. Releasing on close is not optional — a handle left locked never tracks
 * the pointer again for the life of the editor.
 *
 * It has to be the meta: the `lockDragHandle` / `unlockDragHandle` *commands*
 * live on the `DragHandle` Extension, which this editor never registers — only
 * the React component's plugin.
 */
export function setDragHandleLocked(editor: EditorType, locked: boolean): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(DRAG_HANDLE_LOCK_META, locked));
}

/**
 * The target block's live range, remapped through every transaction since the
 * menu opened. `null` when no menu is open, when the plugin is not registered
 * (read-only editors never mount the handle), or when the block is gone.
 */
export function blockMenuTargetRange(
  editor: EditorType,
): { from: number; to: number } | null {
  if (editor.isDestroyed) return null;
  const deco = blockMenuTargetKey.getState(editor.state)?.find()[0];
  return deco ? { from: deco.from, to: deco.to } : null;
}

/**
 * Whether a block menu currently owns the interaction. Read by
 * `selectionShouldShow` so the selection bubble menu does not render on top of
 * the block menu's own text selection.
 */
export function hasBlockMenuTarget(editor: EditorType): boolean {
  return blockMenuTargetRange(editor) !== null;
}
