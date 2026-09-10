import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import {
  SlashCommandExtension,
  slashCommandPluginKey,
  getSlashMatch,
  registerSlashKeyHandler,
} from './slash-command-extension';
import {
  SLASH_COMMAND_ITEMS,
  filterSlashCommands,
} from './slash-command-types';
import { MermaidBlock } from './MermaidBlockExtension';
import { Panel, Details, DetailsSummary } from './article-extensions';

function createSlashEditor(content = '<p></p>') {
  return new Editor({
    extensions: [
      StarterKit,
      Table,
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem,
      Panel,
      Details,
      DetailsSummary,
      MermaidBlock,
      SlashCommandExtension,
    ],
    content,
  });
}

describe('SlashCommandExtension', () => {
  it('detects slash trigger at the start of a paragraph', () => {
    const editor = createSlashEditor('<p>/</p>');
    editor.commands.setTextSelection(2); // After '/'

    const match = getSlashMatch(editor.state);
    expect(match).not.toBeNull();
    expect(match?.query).toBe('');
    expect(match?.range).toEqual({ from: 1, to: 2 });

    const pluginState = slashCommandPluginKey.getState(editor.state);
    expect(pluginState?.isOpen).toBe(true);
    expect(pluginState?.query).toBe('');
    expect(pluginState?.range).toEqual({ from: 1, to: 2 });

    editor.destroy();
  });

  it('detects slash with query filter (e.g. /h1)', () => {
    const editor = createSlashEditor('<p>/h1</p>');
    editor.commands.setTextSelection(4); // After '/h1'

    const match = getSlashMatch(editor.state);
    expect(match).not.toBeNull();
    expect(match?.query).toBe('h1');
    expect(match?.range).toEqual({ from: 1, to: 4 });

    const pluginState = slashCommandPluginKey.getState(editor.state);
    expect(pluginState?.isOpen).toBe(true);
    expect(pluginState?.query).toBe('h1');

    editor.destroy();
  });

  it('detects slash preceded by whitespace', () => {
    const editor = createSlashEditor('<p>Hello /table</p>');
    editor.commands.setTextSelection(13); // After '/table'

    const match = getSlashMatch(editor.state);
    expect(match).not.toBeNull();
    expect(match?.query).toBe('table');
    expect(match?.range.from).toBe(7); // Position of '/'
    expect(match?.range.to).toBe(13);

    editor.destroy();
  });

  it('does NOT trigger for URLs or slashes in middle of words (e.g. http://example.com/test)', () => {
    const editor = createSlashEditor('<p>http://example.com/test</p>');
    editor.commands.setTextSelection(26);

    const match = getSlashMatch(editor.state);
    expect(match).toBeNull();

    const pluginState = slashCommandPluginKey.getState(editor.state);
    expect(pluginState?.isOpen).toBe(false);

    editor.destroy();
  });

  it('does NOT trigger inside a code block', () => {
    const editor = createSlashEditor('<pre><code>/table</code></pre>');
    editor.commands.setTextSelection(8);

    const match = getSlashMatch(editor.state);
    expect(match).toBeNull();

    const pluginState = slashCommandPluginKey.getState(editor.state);
    expect(pluginState?.isOpen).toBe(false);

    editor.destroy();
  });

  it('closes slash menu via closeSlashCommand command', () => {
    const editor = createSlashEditor('<p>/head</p>');
    editor.commands.setTextSelection(6);

    expect(slashCommandPluginKey.getState(editor.state)?.isOpen).toBe(true);

    editor.commands.closeSlashCommand();
    expect(slashCommandPluginKey.getState(editor.state)?.isOpen).toBe(false);

    editor.destroy();
  });

  it('forwards keyboard events to registered slash key handler when menu is open', () => {
    const editor = createSlashEditor('<p>/</p>');
    editor.commands.setTextSelection(2);

    let keyReceived = '';
    const unregister = registerSlashKeyHandler((e) => {
      keyReceived = e.key;
      return true;
    });

    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    editor.view.someProp('handleKeyDown', (f) => f(editor.view, event));

    expect(keyReceived).toBe('ArrowDown');

    unregister();
    editor.destroy();
  });
});

describe('filterSlashCommands', () => {
  it('returns all items when query is empty', () => {
    const items = filterSlashCommands(SLASH_COMMAND_ITEMS, '');
    expect(items.length).toBe(SLASH_COMMAND_ITEMS.length);
  });

  it('filters by heading keywords and shortcuts', () => {
    const h1Items = filterSlashCommands(SLASH_COMMAND_ITEMS, 'h1');
    expect(h1Items.some((i) => i.id === 'h1')).toBe(true);

    const headingItems = filterSlashCommands(SLASH_COMMAND_ITEMS, 'heading');
    expect(headingItems.length).toBeGreaterThanOrEqual(4);
  });

  it('filters by table keyword and typo tolerance (tabels)', () => {
    const tableItems = filterSlashCommands(SLASH_COMMAND_ITEMS, 'table');
    expect(tableItems.some((i) => i.id === 'table')).toBe(true);

    const typoItems = filterSlashCommands(SLASH_COMMAND_ITEMS, 'tabels');
    expect(typoItems.some((i) => i.id === 'table')).toBe(true);
  });

  it('filters by panel keywords (info, warn, note, tip, callout)', () => {
    const infoItems = filterSlashCommands(SLASH_COMMAND_ITEMS, 'info');
    expect(infoItems.some((i) => i.id === 'panel-info')).toBe(true);

    const calloutItems = filterSlashCommands(SLASH_COMMAND_ITEMS, 'callout');
    expect(calloutItems.length).toBe(4);
  });

  it('filters by list keywords (bullet, ordered, todo, task)', () => {
    const taskItems = filterSlashCommands(SLASH_COMMAND_ITEMS, 'todo');
    expect(taskItems.some((i) => i.id === 'taskList')).toBe(true);

    const bulletItems = filterSlashCommands(SLASH_COMMAND_ITEMS, 'bullet');
    expect(bulletItems.some((i) => i.id === 'bulletList')).toBe(true);
  });

  it('filters by diagram and macro keywords (drawio, mermaid, toc, status)', () => {
    const mermaidItems = filterSlashCommands(SLASH_COMMAND_ITEMS, 'mermaid');
    expect(mermaidItems.some((i) => i.id === 'mermaid')).toBe(true);

    const tocItems = filterSlashCommands(SLASH_COMMAND_ITEMS, 'toc');
    expect(tocItems.some((i) => i.id === 'toc')).toBe(true);

    const statusItems = filterSlashCommands(SLASH_COMMAND_ITEMS, 'status');
    expect(statusItems.some((i) => i.id === 'status')).toBe(true);
  });

  it('returns empty array when query does not match anything', () => {
    const items = filterSlashCommands(SLASH_COMMAND_ITEMS, 'xyznonexistent123');
    expect(items).toEqual([]);
  });
});
