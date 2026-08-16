import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { SlashCommandExtension } from './slash-command-extension';
import { EditorSlashMenu } from './EditorSlashMenu';
import {
  ConfluenceLayout,
  ConfluenceLayoutSection,
  ConfluenceLayoutCell,
  ConfluenceSection,
  ConfluenceColumn,
  ConfluenceStatus,
  ConfluenceToc,
  ConfluenceAttachments,
  ConfluenceChildren,
  Panel,
  Details,
  DetailsSummary,
  DrawioDiagram,
  FigureIndex,
  TableIndex,
  ExtendedTable,
} from './article-extensions';
import { MermaidBlock } from './MermaidBlockExtension';

function createFullEditor(content = '<p></p>') {
  return new Editor({
    extensions: [
      StarterKit,
      ExtendedTable,
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem,
      Panel,
      Details,
      DetailsSummary,
      DrawioDiagram,
      MermaidBlock,
      ConfluenceLayout,
      ConfluenceLayoutSection,
      ConfluenceLayoutCell,
      ConfluenceSection,
      ConfluenceColumn,
      ConfluenceStatus,
      ConfluenceToc,
      ConfluenceAttachments,
      ConfluenceChildren,
      FigureIndex,
      TableIndex,
      SlashCommandExtension,
    ],
    content,
  });
}

describe('EditorSlashMenu', () => {
  it('does not render when slash command is not active', () => {
    const editor = createFullEditor('<p>Hello world</p>');
    editor.commands.setTextSelection(3);

    render(<EditorSlashMenu editor={editor} />);
    expect(screen.queryByTestId('slash-command-menu')).not.toBeInTheDocument();

    editor.destroy();
  });

  it('renders floating menu when slash is typed at start of paragraph', () => {
    const editor = createFullEditor('<p>/</p>');
    editor.commands.setTextSelection(2);

    render(<EditorSlashMenu editor={editor} />);
    expect(screen.getByTestId('slash-command-menu')).toBeInTheDocument();
    expect(screen.getByText('Insert block')).toBeInTheDocument();
    expect(screen.getByText('Basic blocks')).toBeInTheDocument();
    expect(screen.getByText('Heading 1')).toBeInTheDocument();
    expect(screen.getByText('Table')).toBeInTheDocument();
    // Descriptions are removed from the popup menu for compact Notion-style scanning
    expect(screen.queryByText('Plain body text paragraph')).not.toBeInTheDocument();
    expect(screen.queryByText('Large section heading')).not.toBeInTheDocument();

    editor.destroy();
  });

  it('filters items when query is typed (e.g. /h1)', () => {
    const editor = createFullEditor('<p>/h1</p>');
    editor.commands.setTextSelection(4);

    render(<EditorSlashMenu editor={editor} />);
    expect(screen.getByTestId('slash-command-menu')).toBeInTheDocument();
    expect(screen.getByText('Heading 1')).toBeInTheDocument();
    expect(screen.queryByText('Table')).not.toBeInTheDocument();

    editor.destroy();
  });

  it('shows empty state when no command matches query', () => {
    const editor = createFullEditor('<p>/xyznotfound</p>');
    editor.commands.setTextSelection(14);

    render(<EditorSlashMenu editor={editor} />);
    expect(screen.getByText(/No matching blocks for/i)).toBeInTheDocument();

    editor.destroy();
  });

  it('converts paragraph to Heading 1 when Heading 1 is selected', () => {
    const editor = createFullEditor('<p>/h1</p>');
    editor.commands.setTextSelection(4);

    render(<EditorSlashMenu editor={editor} />);
    const h1Option = screen.getByTestId('slash-cmd-item-h1');
    act(() => {
      fireEvent.click(h1Option);
    });

    expect(editor.getHTML()).toContain('<h1></h1>');
    expect(editor.getText()).not.toContain('/h1');

    editor.destroy();
  });

  it('converts paragraph to Heading 2 when Heading 2 is selected', () => {
    const editor = createFullEditor('<p>/h2</p>');
    editor.commands.setTextSelection(4);

    render(<EditorSlashMenu editor={editor} />);
    const h2Option = screen.getByTestId('slash-cmd-item-h2');
    act(() => {
      fireEvent.click(h2Option);
    });

    expect(editor.getHTML()).toContain('<h2></h2>');
    expect(editor.getText()).not.toContain('/h2');

    editor.destroy();
  });

  it('inserts table when Table command is clicked', () => {
    const editor = createFullEditor('<p>/table</p>');
    editor.commands.setTextSelection(7);

    render(<EditorSlashMenu editor={editor} />);
    const tableOption = screen.getByTestId('slash-cmd-item-table');
    act(() => {
      fireEvent.click(tableOption);
    });

    expect(editor.getHTML()).toContain('<table');
    expect(editor.getHTML()).toContain('<th');
    expect(editor.getText()).not.toContain('/table');

    editor.destroy();
  });

  it('inserts bullet list when Bullet list command is clicked', () => {
    const editor = createFullEditor('<p>/bullet</p>');
    editor.commands.setTextSelection(8);

    render(<EditorSlashMenu editor={editor} />);
    const bulletOption = screen.getByTestId('slash-cmd-item-bulletList');
    act(() => {
      fireEvent.click(bulletOption);
    });

    expect(editor.getHTML()).toContain('<ul><li><p></p></li></ul>');
    expect(editor.getText()).not.toContain('/bullet');

    editor.destroy();
  });

  it('inserts task list when Task list command is clicked', () => {
    const editor = createFullEditor('<p>/task</p>');
    editor.commands.setTextSelection(6);

    render(<EditorSlashMenu editor={editor} />);
    const taskOption = screen.getByTestId('slash-cmd-item-taskList');
    act(() => {
      fireEvent.click(taskOption);
    });

    expect(editor.getHTML()).toContain('data-type="taskList"');
    expect(editor.getText()).not.toContain('/task');

    editor.destroy();
  });

  it('inserts info panel when Info panel command is clicked', () => {
    const editor = createFullEditor('<p>/info</p>');
    editor.commands.setTextSelection(6);

    render(<EditorSlashMenu editor={editor} />);
    const infoOption = screen.getByTestId('slash-cmd-item-panel-info');
    act(() => {
      fireEvent.click(infoOption);
    });

    expect(editor.getHTML()).toContain('class="panel-info"');
    expect(editor.getText()).not.toContain('/info');

    editor.destroy();
  });

  it('inserts expand section when Expand section command is clicked', () => {
    const editor = createFullEditor('<p>/expand</p>');
    editor.commands.setTextSelection(8);

    render(<EditorSlashMenu editor={editor} />);
    const expandOption = screen.getByTestId('slash-cmd-item-expand');
    act(() => {
      fireEvent.click(expandOption);
    });

    expect(editor.getHTML()).toContain('<details');
    expect(editor.getText()).not.toContain('/expand');

    editor.destroy();
  });

  it('inserts mermaid diagram when Mermaid command is clicked', () => {
    const editor = createFullEditor('<p>/mermaid</p>');
    editor.commands.setTextSelection(9);

    render(<EditorSlashMenu editor={editor} />);
    const mermaidOption = screen.getByTestId('slash-cmd-item-mermaid');
    act(() => {
      fireEvent.click(mermaidOption);
    });

    expect(editor.getHTML()).toContain('class="language-mermaid"');
    expect(editor.getText()).not.toContain('/mermaid');

    editor.destroy();
  });

  it('navigates with ArrowDown and selects via Enter key', () => {
    const editor = createFullEditor('<p>/</p>');
    editor.commands.setTextSelection(2);

    render(<EditorSlashMenu editor={editor} />);
    expect(screen.getByTestId('slash-command-menu')).toBeInTheDocument();

    // Default selected is index 0 (Text)
    const textOption = screen.getByTestId('slash-cmd-item-paragraph');
    expect(textOption).toHaveAttribute('aria-selected', 'true');

    // Press ArrowDown to move to Heading 1
    act(() => {
      const downEvent = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      editor.view.someProp('handleKeyDown', (f) => f(editor.view, downEvent));
    });

    const h1Option = screen.getByTestId('slash-cmd-item-h1');
    expect(h1Option).toHaveAttribute('aria-selected', 'true');

    // Press Enter to execute Heading 1
    act(() => {
      const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      editor.view.someProp('handleKeyDown', (f) => f(editor.view, enterEvent));
    });

    expect(editor.getHTML()).toContain('<h1></h1>');

    editor.destroy();
  });

  it('closes menu on Escape key press', () => {
    const editor = createFullEditor('<p>/</p>');
    editor.commands.setTextSelection(2);

    const { rerender } = render(<EditorSlashMenu editor={editor} />);
    expect(screen.getByTestId('slash-command-menu')).toBeInTheDocument();

    act(() => {
      const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      editor.view.someProp('handleKeyDown', (f) => f(editor.view, escEvent));
    });

    rerender(<EditorSlashMenu editor={editor} />);
    expect(screen.queryByTestId('slash-command-menu')).not.toBeInTheDocument();

    editor.destroy();
  });
});
