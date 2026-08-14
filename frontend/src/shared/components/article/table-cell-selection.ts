import { useEffect, useState } from 'react';
import { TextSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import { CellSelection, cellAround, isInTable, selectedRect } from '@tiptap/pm/tables';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Editor as EditorType } from '@tiptap/react';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

const CELL_NODE_TYPES = new Set(['tableCell', 'tableHeader']);

/**
 * Handle clicks inside table cells:
 * 1. Shift+Click creates a rectangular CellSelection between the anchor cell and clicked cell.
 * 2. Preserves active multi-cell CellSelection when mouseup/click completes a drag gesture.
 */
export function handleTableCellClick(
  view: EditorView,
  pos: number,
  event: MouseEvent,
): boolean {
  if (event.button !== 0) return false;

  const { state } = view;
  const { doc, selection } = state;

  if (pos < 0 || pos > doc.content.size) return false;

  // 1. Shift+Click cell range selection
  if (event.shiftKey && isInTable(state)) {
    const $targetCell = cellAround(doc.resolve(pos));
    if ($targetCell) {
      const $anchorCell =
        selection instanceof CellSelection
          ? selection.$anchorCell
          : cellAround(selection.$from);

      if ($anchorCell) {
        try {
          const anchorTable = $anchorCell.node(-1);
          const targetTable = $targetCell.node(-1);
          if (anchorTable === targetTable) {
            view.dispatch(
              state.tr.setSelection(
                CellSelection.create(doc, $anchorCell.pos, $targetCell.pos),
              ),
            );
            event.preventDefault();
            return true;
          }
        } catch {
          // Fall back to default click if table resolution fails
        }
      }
    }
  }

  // 2. Prevent multi-cell drag release from collapsing to a single-caret TextSelection
  if (
    selection instanceof CellSelection &&
    selection.$anchorCell.pos !== selection.$headCell.pos
  ) {
    const $targetCell = cellAround(doc.resolve(pos));
    if ($targetCell) {
      let isInsideSelection = false;
      selection.forEachCell((_node, cellPos) => {
        if (cellPos === $targetCell.pos) {
          isInsideSelection = true;
        }
      });
      if (isInsideSelection) {
        event.preventDefault();
        return true;
      }
    }
  }

  return false;
}

/**
 * Prevent native browser text drag-and-drop inside tables from aborting ProseMirror's
 * multi-cell selection gesture.
 */
export function handleTableDragStart(view: EditorView, event: DragEvent): boolean {
  if (isInTable(view.state)) {
    event.preventDefault();
    return true;
  }
  return false;
}

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

/**
 * Synchronize full-width table attributes and colgroup styles in the DOM.
 */
export function syncTableLayoutAttributes(editor: EditorType) {
  if (editor.isDestroyed) return;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return true;

    const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
    const table = dom?.tagName === 'TABLE' ? dom : dom?.querySelector('table');
    if (!table) return true;
    const wrapper = table.closest('.tableWrapper');

    if (node.attrs['data-layout'] === 'full-width') {
      table.setAttribute('data-layout', 'full-width');
      wrapper?.setAttribute('data-layout', 'full-width');
    } else {
      table.removeAttribute('data-layout');
      wrapper?.removeAttribute('data-layout');
    }

    return true;
  });
}

/**
 * Insert a table caption directly below the table node.
 */
export function insertTableCaption(editor: EditorType, targetPos?: number) {
  if (editor.isDestroyed) return;
  const { doc, selection } = editor.state;
  let tablePos: number | null = targetPos !== undefined && targetPos >= 0 ? targetPos : null;
  let tableNodeSize = 0;

  if (tablePos !== null) {
    const node = doc.nodeAt(tablePos);
    if (node && node.type.name === 'table') {
      tableNodeSize = node.nodeSize;
    } else {
      tablePos = null;
    }
  }

  if (tablePos === null) {
    const $pos = selection.$from;
    for (let d = $pos.depth; d > 0; d--) {
      const node = $pos.node(d);
      if (node.type.name === 'table') {
        tablePos = $pos.before(d);
        tableNodeSize = node.nodeSize;
        break;
      }
    }
  }

  if (tablePos !== null && tablePos >= 0) {
    const insertPos = tablePos + tableNodeSize;
    const nextNode = doc.nodeAt(insertPos);
    if (nextNode && nextNode.type.name === 'tableCaption') {
      editor.chain().focus().setTextSelection(insertPos + 1).run();
      return;
    }

    editor
      .chain()
      .focus()
      .insertContentAt(insertPos, {
        type: 'tableCaption',
        content: [{ type: 'text', text: 'Table caption' }],
      })
      .setTextSelection({ from: insertPos + 1, to: insertPos + 14 })
      .run();
  } else {
    editor.chain().focus().insertContent({ type: 'tableCaption' }).run();
  }
}

/** Observe whether the active table is using the full-width layout. */
export function useActiveTableLayout(editor: EditorType | null, targetPos?: number) {
  const [isFullWidth, setIsFullWidth] = useState(false);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;

    const update = () => {
      if (targetPos !== undefined && targetPos >= 0) {
        const node = editor.state.doc.nodeAt(targetPos);
        if (node && node.type.name === 'table') {
          setIsFullWidth(node.attrs['data-layout'] === 'full-width');
          return;
        }
      }
      if (!editor.isActive('table')) {
        setIsFullWidth(false);
        return;
      }
      const activeIsFull = editor.isActive('table', { 'data-layout': 'full-width' });
      setIsFullWidth(activeIsFull);
    };

    update();
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
    };
  }, [editor, targetPos]);

  return isFullWidth;
}

export function setTableLayout(editor: EditorType, nextLayout: 'default' | 'full-width', targetPos?: number) {
  let tablePos: number | null = targetPos !== undefined && targetPos >= 0 ? targetPos : null;
  if (tablePos === null) {
    const { selection } = editor.state;
    const $pos = selection.$from;
    for (let d = $pos.depth; d > 0; d--) {
      if ($pos.node(d).type.name === 'table') {
        tablePos = $pos.before(d);
        break;
      }
    }
  }

  if (tablePos !== null && tablePos >= 0) {
    editor.view.dispatch(editor.state.tr.setNodeAttribute(tablePos, 'data-layout', nextLayout));
  } else {
    editor.chain().focus().updateAttributes('table', { 'data-layout': nextLayout }).run();
  }
  syncTableLayoutAttributes(editor);
}

export function getTableNode(editor: EditorType, targetPos?: number): ProseMirrorNode | null {
  if (editor.isDestroyed) return null;
  if (targetPos !== undefined && targetPos >= 0 && targetPos < editor.state.doc.content.size) {
    const node = editor.state.doc.nodeAt(targetPos);
    if (node && node.type.name === 'table') return node;
  }
  const { selection } = editor.state;
  const $pos = selection.$from;
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === 'table') return node;
  }
  return null;
}

export function checkHasHeaderRow(tableNode: ProseMirrorNode | null | undefined): boolean {
  if (!tableNode || tableNode.childCount === 0) return false;
  const firstRow = tableNode.child(0);
  if (firstRow.type.name !== 'tableRow' || firstRow.childCount === 0) return false;

  // If there are multiple columns, determine header row by the non-corner cells (col 1..n)
  // so that toggling header column on/off does not unintentionally flip header row.
  if (firstRow.childCount > 1) {
    for (let c = 1; c < firstRow.childCount; c++) {
      if (firstRow.child(c).type.name !== 'tableHeader') {
        return false;
      }
    }
    return true;
  }
  return firstRow.child(0).type.name === 'tableHeader';
}

export function checkHasHeaderColumn(tableNode: ProseMirrorNode | null | undefined): boolean {
  if (!tableNode || tableNode.childCount === 0) return false;

  // If there are multiple rows, determine header column by rows 1..m at col 0
  // so that toggling header row on/off does not unintentionally flip header column.
  if (tableNode.childCount > 1) {
    for (let r = 1; r < tableNode.childCount; r++) {
      const row = tableNode.child(r);
      if (row.type.name === 'tableRow') {
        if (row.childCount === 0 || row.child(0).type.name !== 'tableHeader') {
          return false;
        }
      }
    }
    return true;
  }

  const firstRow = tableNode.child(0);
  return firstRow.type.name === 'tableRow' && firstRow.childCount > 0 && firstRow.child(0).type.name === 'tableHeader';
}

/**
 * Directly toggles the header row between tableHeader and tableCell.
 * Correctly preserves the corner cell (0, 0) if header column is active.
 */
export function toggleTableHeaderRowDirect(editor: EditorType, targetPos?: number) {
  if (editor.isDestroyed) return;
  const { state, view } = editor;
  const { schema } = state;
  const cellType = schema.nodes.tableCell;
  const headerType = schema.nodes.tableHeader;
  if (!cellType || !headerType) return;

  const tableNode = getTableNode(editor, targetPos);
  let tablePos: number | null = targetPos !== undefined && targetPos >= 0 ? targetPos : null;
  if (tablePos === null) {
    const { selection } = state;
    const $pos = selection.$from;
    for (let d = $pos.depth; d > 0; d--) {
      if ($pos.node(d).type.name === 'table') {
        tablePos = $pos.before(d);
        break;
      }
    }
  }

  if (tablePos === null || !tableNode || tableNode.childCount === 0) {
    editor.chain().focus().toggleHeaderRow().run();
    return;
  }

  const firstRow = tableNode.child(0);
  if (firstRow.type.name !== 'tableRow' || firstRow.childCount === 0) return;

  const isCurrentlyHeaderRow = checkHasHeaderRow(tableNode);
  const isHeaderCol = checkHasHeaderColumn(tableNode);
  const nextIsHeaderRow = !isCurrentlyHeaderRow;

  const newCells: ProseMirrorNode[] = [];
  for (let c = 0; c < firstRow.childCount; c++) {
    const cell = firstRow.child(c);
    if (c === 0) {
      const cornerType = (nextIsHeaderRow || isHeaderCol) ? headerType : cellType;
      newCells.push(cornerType.create(cell.attrs, cell.content, cell.marks));
    } else {
      const targetType = nextIsHeaderRow ? headerType : cellType;
      newCells.push(targetType.create(cell.attrs, cell.content, cell.marks));
    }
  }
  const newFirstRow = firstRow.type.create(firstRow.attrs, newCells);

  const rowPos = tablePos + 1;
  const tr = state.tr.replaceWith(rowPos, rowPos + firstRow.nodeSize, newFirstRow);
  view.dispatch(tr);
  syncTableLayoutAttributes(editor);
}

/**
 * Directly toggles the header column between tableHeader and tableCell.
 * Correctly preserves the corner cell (0, 0) if header row is active.
 */
export function toggleTableHeaderColumnDirect(editor: EditorType, targetPos?: number) {
  if (editor.isDestroyed) return;
  const { state, view } = editor;
  const { schema } = state;
  const cellType = schema.nodes.tableCell;
  const headerType = schema.nodes.tableHeader;
  if (!cellType || !headerType) return;

  const tableNode = getTableNode(editor, targetPos);
  let tablePos: number | null = targetPos !== undefined && targetPos >= 0 ? targetPos : null;
  if (tablePos === null) {
    const { selection } = state;
    const $pos = selection.$from;
    for (let d = $pos.depth; d > 0; d--) {
      if ($pos.node(d).type.name === 'table') {
        tablePos = $pos.before(d);
        break;
      }
    }
  }

  if (tablePos === null || !tableNode || tableNode.childCount === 0) {
    editor.chain().focus().toggleHeaderColumn().run();
    return;
  }

  const isHeaderRow = checkHasHeaderRow(tableNode);
  const isCurrentlyHeaderCol = checkHasHeaderColumn(tableNode);
  const nextIsHeaderCol = !isCurrentlyHeaderCol;

  const newRows: ProseMirrorNode[] = [];
  for (let r = 0; r < tableNode.childCount; r++) {
    const row = tableNode.child(r);
    if (row.type.name === 'tableRow' && row.childCount > 0) {
      const firstCell = row.child(0);
      let targetFirstCellType: typeof cellType;
      if (r === 0) {
        targetFirstCellType = (isHeaderRow || nextIsHeaderCol) ? headerType : cellType;
      } else {
        targetFirstCellType = nextIsHeaderCol ? headerType : cellType;
      }
      const newFirstCell = targetFirstCellType.create(firstCell.attrs, firstCell.content, firstCell.marks);
      const newCells = [newFirstCell];
      for (let c = 1; c < row.childCount; c++) {
        newCells.push(row.child(c));
      }
      newRows.push(row.type.create(row.attrs, newCells));
    } else {
      newRows.push(row);
    }
  }

  const newTable = tableNode.type.create(tableNode.attrs, newRows);
  const tr = state.tr.replaceWith(tablePos, tablePos + tableNode.nodeSize, newTable);
  view.dispatch(tr);
  syncTableLayoutAttributes(editor);
}

export const tableSelectionPerimeterPluginKey = new PluginKey('tableSelectionPerimeter');

/**
 * ProseMirror plugin to compute perimeter classes (top, bottom, left, right)
 * for multi-cell table selections so that a continuous border is drawn around
 * the entire bounding box of selected cells, rather than around each individual cell (Notion-style).
 */
export function createTableSelectionPerimeterPlugin() {
  return new Plugin({
    key: tableSelectionPerimeterPluginKey,
    props: {
      decorations(state) {
        const { selection } = state;
        if (!(selection instanceof CellSelection)) return null;

        try {
          const rect = selectedRect(state);
          const { map, tableStart, top, bottom, left, right } = rect;
          const decorations: Decoration[] = [];
          const seenCells = new Set<number>();

          for (let row = top; row < bottom; row++) {
            for (let col = left; col < right; col++) {
              const cellOffset = map.map[row * map.width + col];
              if (cellOffset === undefined || seenCells.has(cellOffset)) continue;
              seenCells.add(cellOffset);

              const cellPos = tableStart + cellOffset;
              const cellNode = state.doc.nodeAt(cellPos);
              if (!cellNode) continue;

              const isTop = row === top;
              const isBottom = row + (cellNode.attrs.rowspan || 1) >= bottom;
              const isLeft = col === left;
              const isRight = col + (cellNode.attrs.colspan || 1) >= right;

              const classes: string[] = ['selectedCell'];
              if (isTop) classes.push('selectedCell-top');
              if (isBottom) classes.push('selectedCell-bottom');
              if (isLeft) classes.push('selectedCell-left');
              if (isRight) classes.push('selectedCell-right');

              decorations.push(
                Decoration.node(cellPos, cellPos + cellNode.nodeSize, {
                  class: classes.join(' '),
                }),
              );
            }
          }
          return DecorationSet.create(state.doc, decorations);
        } catch {
          return null;
        }
      },
    },
  });
}


