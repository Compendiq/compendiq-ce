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
 * Returns `false` for a click outside any cell so ProseMirror's default runs
 * unchanged.
 */
export function handleTableCellTripleClick(view: EditorView, pos: number): boolean {
  const { doc } = view.state;
  if (pos < 0 || pos > doc.content.size) return false;

  // Walk up from the clicked position rather than reading `editor.isActive`:
  // `isActive` reports on the *current* selection, which need not be anywhere
  // near where the user just clicked.
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    if (!CELL_NODE_TYPES.has($pos.node(depth).type.name)) continue;

    // `start`/`end` land on the cell's content boundary, which is not itself a
    // valid text position — `TextSelection.between` snaps each endpoint inward
    // to the nearest one. An empty cell collapses to a caret instead of
    // throwing.
    const selection = TextSelection.between(doc.resolve($pos.start(depth)), doc.resolve($pos.end(depth)));
    view.dispatch(view.state.tr.setSelection(selection).setMeta('pointer', true));
    return true;
  }

  return false;
}
