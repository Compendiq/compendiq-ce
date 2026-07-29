import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

const CELL_NODE_TYPES = new Set(['tableCell', 'tableHeader']);

/**
 * Triple-click inside a table cell selects the cell's entire text (#1135).
 *
 * Two defaults are being overridden here, and both are wrong for this gesture:
 *
 * - ProseMirror's own `defaultTripleClick` selects the enclosing *textblock*,
 *   so a `<td>` holding two paragraphs only ever yields one of them.
 * - prosemirror-tables' `tableEditing` plugin gets there first and answers
 *   with a `CellSelection`, which spans the right range but carries
 *   `visible === false`: ProseMirror hides the browser selection for it and
 *   expects the app to paint the `.selectedCell` decoration class instead.
 *   We have never styled that class, so the gesture currently highlights
 *   nothing at all.
 *
 * Installing this in `editorProps` wins over both — `view.someProp` reads the
 * view's direct props before any plugin's — and produces an ordinary,
 * visible `TextSelection` over the whole cell.
 *
 * Returns `false` for a non-left button, for a click outside any cell, and for
 * a cell this cannot safely handle — so ProseMirror's default runs unchanged.
 */
export function handleTableCellTripleClick(
  view: EditorView,
  pos: number,
  event: MouseEvent,
): boolean {
  // Left button only, matching ProseMirror's own `defaultTripleClick`
  // (`if (event.button != 0) return false`). This handler runs *before* that
  // one, so without the same guard a triple right-click — the gesture that
  // opens a context menu — would hijack the selection on its way past.
  if (event.button !== 0) return false;

  const { doc } = view.state;
  if (pos < 0 || pos > doc.content.size) return false;

  // Walk up from the clicked position rather than reading `editor.isActive`:
  // `isActive` reports on the *current* selection, which need not be anywhere
  // near where the user just clicked.
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    if (!CELL_NODE_TYPES.has($pos.node(depth).type.name)) continue;

    // `start`/`end` land on the cell's content boundary, which is not itself a
    // valid text position — `TextSelection.between` snaps each endpoint to the
    // nearest one, so a cell holding an empty paragraph collapses to a caret
    // rather than throwing.
    const $start = doc.resolve($pos.start(depth));
    const $end = doc.resolve($pos.end(depth));
    const selection = TextSelection.between($start, $end);

    // A cell with no textblock *at all* has no valid text position inside it,
    // and then `between` searches OUTWARD: `Selection.findFrom` walks up the
    // depth chain and `findSelectionIn` skips atoms, so it escapes into a
    // sibling. `tableCell` content is `block+` and image / drawioDiagram /
    // mermaidBlock and the macro nodes are block atoms, so `<td><img></td>` is
    // both legal and routine — content-converter's `image.replaceWith(img)`
    // emits exactly that for a Confluence screenshot in a cell.
    //
    // Declining hands the gesture back to prosemirror-tables, whose
    // CellSelection is invisible (the bug this file exists to fix) but at
    // least spans the cell and copies its content. Returning `true` would
    // instead put the caret outside the table with no fallback, because
    // prosemirror-view calls `preventDefault()` for any truthy handler.
    if (selection.from < $start.pos || selection.to > $end.pos) return false;

    view.dispatch(view.state.tr.setSelection(selection).setMeta('pointer', true));
    return true;
  }

  return false;
}
