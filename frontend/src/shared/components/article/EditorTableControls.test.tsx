import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CellSelection } from '@tiptap/pm/tables';
import { Editor } from './Editor';
import type { Editor as EditorType } from '@tiptap/react';

const SAMPLE_TABLE_HTML = [
  '<table>',
  '<tbody>',
  '<tr><th>Header 1</th><th>Header 2</th></tr>',
  '<tr><td>Cell 1</td><td>Cell 2</td></tr>',
  '</tbody>',
  '</table>',
].join('');

async function renderEditorWithTable() {
  let editor: EditorType | null = null;
  render(
    <Editor
      content={SAMPLE_TABLE_HTML}
      editable={true}
      onEditorReady={(e) => {
        editor = e;
      }}
    />
  );
  await waitFor(() => {
    expect(editor).not.toBeNull();
  });
  return editor!;
}

async function renderEditorWithContent(content: string) {
  let editor: EditorType | null = null;
  render(
    <Editor
      content={content}
      editable={true}
      onEditorReady={(e) => {
        editor = e;
      }}
    />,
  );
  await waitFor(() => {
    expect(editor).not.toBeNull();
  });
  return editor!;
}

/** Position cursor inside the first table cell */
function focusFirstTableCell(editor: EditorType) {
  let cellPos = -1;
  editor.state.doc.descendants((node, pos) => {
    if (cellPos !== -1) return false;
    if (node.type.name === 'tableHeader' || node.type.name === 'tableCell') {
      cellPos = pos + 1;
      return false;
    }
    return true;
  });
  if (cellPos !== -1) {
    editor.chain().focus().setTextSelection(cellPos).run();
  }
}

describe('EditorTableControls & Table Expansion', () => {
  it('reads a persisted full-width attribute when loading table HTML', async () => {
    const editor = await renderEditorWithContent(
      '<table data-layout="full-width"><tbody><tr><td>Wide</td></tr></tbody></table>',
    );

    expect(editor.getAttributes('table')['data-layout']).toBe('full-width');
  });

  it('shows a saved full-width table at page width in the editor DOM', async () => {
    // TipTap's TableView builds its own wrapper and does not copy node
    // attributes onto the <table>. View mode re-stamps them; edit mode
    // used to skip that, so a full-width table shrank to its colgroup
    // pixel width the moment you entered Edit.
    const editor = await renderEditorWithContent(
      '<table data-layout="full-width"><tbody><tr>' +
        '<th colwidth="120"><p>ID</p></th><th colwidth="300"><p>Title</p></th>' +
        '</tr></tbody></table>',
    );

    await waitFor(() => {
      const table = editor.view.dom.querySelector('table');
      const wrapper = editor.view.dom.querySelector('.tableWrapper');
      expect(table).toHaveAttribute('data-layout', 'full-width');
      expect(wrapper).toHaveAttribute('data-layout', 'full-width');
      expect(table).toHaveStyle({ width: '100%' });
    });
  });

  it('renders labeled table groups and icon-only buttons when cursor is inside a table', async () => {
    const editor = await renderEditorWithTable();
    focusFirstTableCell(editor);

    await waitFor(() => {
      expect(screen.getByTestId('table-context-toolbar')).toBeInTheDocument();
    });

    expect(screen.getByRole('toolbar', { name: 'Table editing controls' })).toBeInTheDocument();
    expect(screen.getByTestId('table-toolbar-heading')).toHaveTextContent('Table');
    expect(screen.getByTestId('table-group-rows')).toHaveAccessibleName('Rows');
    expect(screen.getByTestId('table-group-columns')).toHaveAccessibleName('Columns');
    expect(screen.getByTestId('table-group-cells')).toHaveAccessibleName('Cells');

    expect(screen.getByTitle('Add row above')).toBeInTheDocument();
    expect(screen.getByTitle('Add row below')).toBeInTheDocument();
    expect(screen.getByTitle('Delete row')).toBeInTheDocument();
    expect(screen.getByTitle('Add column before')).toBeInTheDocument();
    expect(screen.getByTitle('Add column after')).toBeInTheDocument();
    expect(screen.getByTitle('Delete column')).toBeInTheDocument();

    expect(screen.getByTestId('table-toggle-header-row')).toBeInTheDocument();
    expect(screen.getByTestId('table-toggle-header-column')).toBeInTheDocument();
    expect(screen.getByTestId('table-add-caption')).toBeInTheDocument();
    expect(screen.getByTestId('table-delete')).toBeInTheDocument();
  });

  it('toggles table expansion to page size (data-layout="full-width")', async () => {
    const editor = await renderEditorWithTable();
    focusFirstTableCell(editor);

    await waitFor(() => {
      expect(screen.getByTestId('toggle-table-expand')).toBeInTheDocument();
    });

    const toggleBtn = screen.getByTestId('toggle-table-expand');
    expect(toggleBtn).toHaveAttribute('title', 'Expand table to page width');
    expect(editor.getAttributes('table')['data-layout']).toBe('default');

    // Click to expand table
    fireEvent.click(toggleBtn);

    expect(editor.getAttributes('table')['data-layout']).toBe('full-width');
    await waitFor(() => {
      expect(editor.view.dom.querySelector('table')).toHaveAttribute('data-layout', 'full-width');
      expect(editor.view.dom.querySelector('.tableWrapper')).toHaveAttribute('data-layout', 'full-width');
    });
    expect(editor.getHTML()).toContain('data-layout="full-width"');
    expect(toggleBtn).toHaveAttribute('title', 'Return table to standard width');

    // Click again to return to default width
    fireEvent.click(toggleBtn);
    expect(editor.getAttributes('table')['data-layout']).toBe('default');
    await waitFor(() => {
      expect(editor.view.dom.querySelector('table')).not.toHaveAttribute('data-layout', 'full-width');
      expect(editor.view.dom.querySelector('.tableWrapper')).not.toHaveAttribute('data-layout', 'full-width');
    });
    expect(toggleBtn).toHaveAttribute('title', 'Expand table to page width');
  });

  it('preserves user-adjusted column widths (colwidth) in full-width tables', async () => {
    const editor = await renderEditorWithContent(
      '<table data-layout="full-width"><tbody><tr><th colwidth="120"><p>ID</p></th><th colwidth="300"><p>Title</p></th><th colwidth="150"><p>Status</p></th></tr><tr><td colwidth="120"><p>1</p></td><td colwidth="300"><p>Item</p></td><td colwidth="150"><p>Open</p></td></tr></tbody></table>',
    );
    focusFirstTableCell(editor);

    expect(editor.getAttributes('table')['data-layout']).toBe('full-width');
    expect(editor.getHTML()).toContain('colwidth="120"');
    expect(editor.getHTML()).toContain('colwidth="300"');
    expect(editor.getHTML()).toContain('colwidth="150"');
  });

  it('inserts table caption directly below the table node', async () => {
    const editor = await renderEditorWithTable();
    focusFirstTableCell(editor);

    await waitFor(() => {
      expect(screen.getByTestId('table-add-caption')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('table-add-caption'));

    // Verify doc structure: table directly followed by tableCaption
    expect(editor.state.doc.child(0).type.name).toBe('table');
    expect(editor.state.doc.child(1).type.name).toBe('tableCaption');
  });

  it('adds a column when clicking the labeled column action', async () => {
    const editor = await renderEditorWithTable();
    focusFirstTableCell(editor);

    await waitFor(() => {
      expect(screen.getByTitle('Add column after')).toBeInTheDocument();
    });

    const initialCols = editor.state.doc.firstChild?.firstChild?.childCount;
    expect(initialCols).toBe(2);

    const addColBtn = screen.getByTitle('Add column after');
    fireEvent.click(addColBtn);

    const updatedCols = editor.state.doc.firstChild?.firstChild?.childCount;
    expect(updatedCols).toBe(3);
  });

  it('adds a row when clicking the labeled row action', async () => {
    const editor = await renderEditorWithTable();
    focusFirstTableCell(editor);

    await waitFor(() => {
      expect(screen.getByTitle('Add row below')).toBeInTheDocument();
    });

    const initialRows = editor.state.doc.firstChild?.childCount;
    expect(initialRows).toBe(2);

    const addRowBtn = screen.getByTitle('Add row below');
    fireEvent.click(addRowBtn);

    const updatedRows = editor.state.doc.firstChild?.childCount;
    expect(updatedRows).toBe(3);
  });

  it('deletes multiple selected rows in a single batch action', async () => {
    const THREE_BY_THREE_HTML = [
      '<table><tbody>',
      '<tr><th>H1</th><th>H2</th><th>H3</th></tr>',
      '<tr><td>R2C1</td><td>R2C2</td><td>R2C3</td></tr>',
      '<tr><td>R3C1</td><td>R3C2</td><td>R3C3</td></tr>',
      '</tbody></table>',
    ].join('');
    const editor = await renderEditorWithContent(THREE_BY_THREE_HTML);
    expect(editor.state.doc.firstChild?.childCount).toBe(3);

    // Select row 2 and row 3 cells
    const doc = editor.state.doc;
    const tableNode = doc.firstChild!;
    const r2c1Pos = 1 + tableNode.child(0).nodeSize + 1; // start of row 2 cell 1
    const r3c3Pos = 1 + tableNode.child(0).nodeSize + tableNode.child(1).nodeSize + tableNode.child(2).child(0).nodeSize + tableNode.child(2).child(1).nodeSize + 1;

    const $anchor = doc.resolve(r2c1Pos);
    const $head = doc.resolve(r3c3Pos);
    editor.view.dispatch(editor.state.tr.setSelection(new CellSelection($anchor, $head)));

    await waitFor(() => {
      expect(screen.getByTitle('Delete row')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Delete row'));

    // Verify 2 rows were deleted, leaving 1 row
    await waitFor(() => {
      expect(editor.state.doc.firstChild?.childCount).toBe(1);
    });
  });

  it('deletes multiple selected columns in a single batch action', async () => {
    const THREE_BY_THREE_HTML = [
      '<table><tbody>',
      '<tr><th>H1</th><th>H2</th><th>H3</th></tr>',
      '<tr><td>R2C1</td><td>R2C2</td><td>R2C3</td></tr>',
      '<tr><td>R3C1</td><td>R3C2</td><td>R3C3</td></tr>',
      '</tbody></table>',
    ].join('');
    const editor = await renderEditorWithContent(THREE_BY_THREE_HTML);
    expect(editor.state.doc.firstChild?.firstChild?.childCount).toBe(3);

    // Select column 2 and column 3
    const doc = editor.state.doc;
    const tableNode = doc.firstChild!;
    const c2Pos = 1 + tableNode.child(0).child(0).nodeSize + 1;
    const c3Pos = 1 + tableNode.child(0).child(0).nodeSize + tableNode.child(0).child(1).nodeSize + 1;

    const $anchor = doc.resolve(c2Pos);
    const $head = doc.resolve(c3Pos);
    editor.view.dispatch(editor.state.tr.setSelection(new CellSelection($anchor, $head)));

    await waitFor(() => {
      expect(screen.getByTitle('Delete column')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Delete column'));

    // Verify 2 columns were deleted, leaving 1 column
    await waitFor(() => {
      expect(editor.state.doc.firstChild?.firstChild?.childCount).toBe(1);
    });
  });

  it('renders context toolbars as an overlay without pushing article content when table is in column layout', async () => {
    const TABLE_IN_COLUMN_HTML = [
      '<div class="confluence-section">',
      '  <div class="confluence-column">',
      '    <table><tbody>',
      '      <tr><th>Header</th></tr>',
      '      <tr><td>Data</td></tr>',
      '    </tbody></table>',
      '  </div>',
      '</div>',
    ].join('');

    const editor = await renderEditorWithContent(TABLE_IN_COLUMN_HTML);

    // Find table cell pos
    let cellPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (cellPos !== -1) return false;
      if (node.type.name === 'tableHeader' || node.type.name === 'tableCell') {
        cellPos = pos + 1;
        return false;
      }
      return true;
    });
    expect(cellPos).toBeGreaterThan(0);
    editor.chain().focus().setTextSelection(cellPos).run();

    // Verify context toolbars container appears
    await waitFor(() => {
      expect(screen.getByTestId('editor-context-toolbars')).toBeInTheDocument();
    });

    const overlay = screen.getByTestId('editor-context-toolbars');
    // Ensure it uses absolute positioning so it does not shift in-flow article content
    expect(overlay.className).toContain('absolute');
    expect(overlay.className).toContain('top-full');
    expect(overlay.className).toContain('inset-x-0');

    // Both table and column editing controls must be present
    expect(screen.getByTestId('table-context-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('column-context-toolbar')).toBeInTheDocument();
  });

  it('does not render context toolbars when cursor is in plain text', async () => {
    const editor = await renderEditorWithContent('<p>Plain paragraph text</p>');
    editor.chain().focus().setTextSelection(1).run();

    expect(screen.queryByTestId('editor-context-toolbars')).not.toBeInTheDocument();
    expect(screen.queryByTestId('table-context-toolbar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('column-context-toolbar')).not.toBeInTheDocument();
  });
});
