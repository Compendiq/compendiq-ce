import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Editor as EditorType } from '@tiptap/react';

/**
 * #764 — Non-destructive selection highlight for the bubble menu's AI Improve
 * flow. When the Improve popover opens, its input steals focus and the blurred
 * editor stops painting the native selection, so the user loses sight of the
 * passage being improved (the logical range survives in the menu's `rangeRef`).
 * This plugin re-marks that captured range with a ProseMirror inline
 * decoration — a pure view overlay that never touches the document, preserving
 * #716's "document is never mutated until accept" guarantee. Styled by
 * `.ai-improve-selection` in `frontend/src/index.css` (theme tokens, works in
 * both Graphite Honey and Honey Linen).
 */

/** Class applied to the decorated range; styled in `frontend/src/index.css`. */
export const IMPROVE_DECORATION_CLASS = 'ai-improve-selection';

export const improveDecorationKey = new PluginKey<DecorationSet>('aiImproveSelection');

interface ImproveDecorationMeta {
  /** Decorate this range (replaces any existing decoration). */
  range?: { from: number; to: number };
  /** Remove the decoration. */
  clear?: true;
}

export function createImproveDecorationPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: improveDecorationKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const meta = tr.getMeta(improveDecorationKey) as ImproveDecorationMeta | undefined;
        if (meta?.clear) return DecorationSet.empty;
        if (meta?.range) {
          return DecorationSet.create(tr.doc, [
            Decoration.inline(meta.range.from, meta.range.to, { class: IMPROVE_DECORATION_CLASS }),
          ]);
        }
        // Map through unrelated document changes so the highlight stays glued
        // to the original passage.
        return set.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return improveDecorationKey.getState(state);
      },
    },
  });
}

/** Highlight `range` while the Improve popover is open. */
export function setImproveDecoration(
  editor: EditorType,
  range: { from: number; to: number },
): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(
    editor.state.tr.setMeta(improveDecorationKey, { range } satisfies ImproveDecorationMeta),
  );
}

/** Remove the highlight (Replace / Insert below / Discard / Escape / close). */
export function clearImproveDecoration(editor: EditorType): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(
    editor.state.tr.setMeta(improveDecorationKey, { clear: true } satisfies ImproveDecorationMeta),
  );
}
