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

  it('renders labeled table groups when cursor is inside a table', async () => {
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
    await waitFor(() => {
      expect(editor.view.dom.querySelector('table')).toHaveAttribute('data-layout', 'full-width');
      expect(editor.view.dom.querySelector('.tableWrapper')).toHaveAttribute('data-layout', 'full-width');
    });
    expect(editor.getHTML()).toContain('data-layout="full-width"');
    expect(toggleBtn).toHaveTextContent('Page width');

    // Click again to return to default width
    fireEvent.click(toggleBtn);
    expect(editor.getAttributes('table')['data-layout']).toBe('default');
    await waitFor(() => {
      expect(editor.view.dom.querySelector('table')).not.toHaveAttribute('data-layout', 'full-width');
      expect(editor.view.dom.querySelector('.tableWrapper')).not.toHaveAttribute('data-layout', 'full-width');
    });
    expect(toggleBtn).toHaveTextContent('Expand');
  });

  it('keeps secondary table actions behind the labeled More menu', async () => {
    const editor = await renderEditorWithTable();
    focusFirstTableCell(editor);

    await waitFor(() => {
      expect(screen.getByTestId('table-more-trigger')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('table-toggle-header-row')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('table-more-trigger'));

    expect(screen.getByText('More table actions')).toBeInTheDocument();
    expect(screen.getByTestId('table-toggle-header-row')).toBeInTheDocument();
    expect(screen.getByTestId('table-toggle-header-column')).toBeInTheDocument();
    expect(screen.getByTestId('table-add-caption')).toBeInTheDocument();
    expect(screen.getByTestId('table-delete')).toBeInTheDocument();
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
});
