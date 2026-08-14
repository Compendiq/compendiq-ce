import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
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
  it('renders TableContextToolbar when cursor is inside a table', async () => {
    const editor = await renderEditorWithTable();
    focusFirstTableCell(editor);

    await waitFor(() => {
      expect(screen.getByTestId('table-context-toolbar')).toBeInTheDocument();
    });

    expect(screen.getByTitle('Add row before')).toBeInTheDocument();
    expect(screen.getByTitle('Add row after')).toBeInTheDocument();
    expect(screen.getByTitle('Delete row')).toBeInTheDocument();
    expect(screen.getByTitle('Add column before')).toBeInTheDocument();
    expect(screen.getByTitle('Add column after')).toBeInTheDocument();
    expect(screen.getByTitle('Delete column')).toBeInTheDocument();
  });

  it('toggles table expansion to page size (data-layout="full-width")', async () => {
    const editor = await renderEditorWithTable();
    focusFirstTableCell(editor);

    await waitFor(() => {
      expect(screen.getByTestId('toggle-table-expand')).toBeInTheDocument();
    });

    const toggleBtn = screen.getByTestId('toggle-table-expand');
    expect(toggleBtn).toHaveTextContent('Expand');
    expect(editor.getAttributes('table')['data-layout']).toBe('default');

    // Click to expand table
    fireEvent.click(toggleBtn);

    expect(editor.getAttributes('table')['data-layout']).toBe('full-width');
    expect(toggleBtn).toHaveTextContent('Page width');

    // Click again to return to default width
    fireEvent.click(toggleBtn);
    expect(editor.getAttributes('table')['data-layout']).toBe('default');
    expect(toggleBtn).toHaveTextContent('Expand');
  });

  it('renders Notion table overlay edge buttons (+ Column and + Row)', async () => {
    const editor = await renderEditorWithTable();
    focusFirstTableCell(editor);

    await waitFor(() => {
      expect(screen.getByTestId('editor-table-overlay')).toBeInTheDocument();
    });

    expect(screen.getByTestId('add-column-right-btn')).toBeInTheDocument();
    expect(screen.getByTestId('add-row-bottom-btn')).toBeInTheDocument();
    expect(screen.getByTestId('table-corner-menu-trigger')).toBeInTheDocument();
  });

  it('adds a column when clicking the + Column edge button', async () => {
    const editor = await renderEditorWithTable();
    focusFirstTableCell(editor);

    await waitFor(() => {
      expect(screen.getByTestId('add-column-right-btn')).toBeInTheDocument();
    });

    const initialCols = editor.state.doc.firstChild?.firstChild?.childCount;
    expect(initialCols).toBe(2);

    const addColBtn = screen.getByTestId('add-column-right-btn');
    fireEvent.click(addColBtn);

    const updatedCols = editor.state.doc.firstChild?.firstChild?.childCount;
    expect(updatedCols).toBe(3);
  });

  it('adds a row when clicking the + Row edge button', async () => {
    const editor = await renderEditorWithTable();
    focusFirstTableCell(editor);

    await waitFor(() => {
      expect(screen.getByTestId('add-row-bottom-btn')).toBeInTheDocument();
    });

    const initialRows = editor.state.doc.firstChild?.childCount;
    expect(initialRows).toBe(2);

    const addRowBtn = screen.getByTestId('add-row-bottom-btn');
    fireEvent.click(addRowBtn);

    const updatedRows = editor.state.doc.firstChild?.childCount;
    expect(updatedRows).toBe(3);
  });
});
