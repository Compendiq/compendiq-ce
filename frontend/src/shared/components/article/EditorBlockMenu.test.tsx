import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { Highlight } from '@tiptap/extension-highlight';
import { toast } from 'sonner';
import { ConfluenceSection, ConfluenceColumn, Panel, ConfluenceStatus, ConfluenceUserMention, ExtendedTable, Details, DetailsSummary } from './article-extensions';
import type { Editor as EditorType } from '@tiptap/react';

// Mock the SSE transport so "Improve" never hits the network. Capturing the
// abort signal is how the unmount-abort contract is asserted below.
const streamSSE = vi.fn();
vi.mock('../../lib/sse', () => ({
  streamSSE: (...args: unknown[]) => streamSSE(...args),
}));

import { EditorBlockMenu } from './EditorBlockMenu';
import { NESTED_DRAG_OPTIONS } from './block-menu-nodes';
import {
  blockMenuTargetKey,
  createBlockMenuTargetPlugin,
  setBlockMenuTarget,
} from './block-menu-decoration';

/**
 * #1179 — the block context menu body, driven by a real TipTap editor.
 *
 * The handle wrapper is deliberately not exercised here: the drag-handle plugin
 * resolves its node from `mousemove` coordinates and `getBoundingClientRect`,
 * so it never resolves a node under jsdom. `Editor.test.tsx` keeps the wiring
 * assertion shallow for the same reason.
 */

function gen(chunks: Array<Record<string, unknown>>) {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

/** A generator that yields one chunk and then never settles — an in-flight run. */
function pending(signal?: AbortSignal) {
  return (async function* () {
    yield { content: 'partial' };
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  })();
}

// Stand-in for the ~20 atomic / macro nodes in `article-extensions.ts`. Only
// the node *name* drives the hide-don't-disable decision, so a minimal node
// registered under the real name exercises the same path without dragging the
// React node views (and their contexts) into this suite.
const DrawioDiagram = Node.create({
  name: 'drawioDiagram',
  group: 'block',
  atom: true,
  parseHTML: () => [{ tag: 'div[data-drawio]' }],
  renderHTML: () => ['div', { 'data-drawio': '' }],
});

beforeAll(() => {
  // jsdom has no layout engine; ProseMirror's scroll-into-view (from `.focus()`)
  // calls `getClientRects` on a DOM range and throws without these.
  if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  }
});

interface Target { pos: number; }

/** Absolute position of the `index`-th top-level block. */
function topLevelPos(editor: EditorType, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
  return pos;
}

function Harness({
  content,
  blockIndex,
  onReady,
  onClose,
  mounted = true,
  trailingNode = true,
  customPos,
}: {
  content: string;
  blockIndex?: number;
  customPos?: (editor: EditorType) => number;
  onReady: (editor: EditorType) => void;
  onClose: () => void;
  mounted?: boolean;
  /**
   * StarterKit's TrailingNode keeps an empty paragraph at the end of any
   * document that does not already end in one — so in the app the doc can only
   * be emptied by deleting a sole *paragraph*. One test turns it off to reach
   * the same guard from a sole atomic block.
   */
  trailingNode?: boolean;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure(trailingNode ? {} : { trailingNode: false }),
      ExtendedTable,
      TableRow,
      TableCell,
      TableHeader,
      TextAlign.configure({
        types: ['heading', 'paragraph', 'blockquote'],
      }),
      Highlight.configure({ multicolor: true }),
      DrawioDiagram,
      ConfluenceStatus,
      ConfluenceUserMention,
      ConfluenceSection,
      ConfluenceColumn,
      Panel,
      Details,
      DetailsSummary,
    ],
    content,
    immediatelyRender: false,
  });
  const [target, setTarget] = useState<Target | null>(null);

  useEffect(() => {
    if (!editor) return;
    // Mirrors what `EditorBlockHandle` does on click: register the marker
    // plugin, then mark the block the pointer was over.
    editor.registerPlugin(createBlockMenuTargetPlugin());
    const pos = customPos ? customPos(editor) : topLevelPos(editor, blockIndex ?? 0);
    setBlockMenuTarget(editor, pos);
    setTarget({ pos });
    onReady(editor);
    return () => { editor.unregisterPlugin(blockMenuTargetKey); };
  }, [editor, blockIndex, customPos, onReady]);

  if (!editor || !target) return null;
  const node = editor.state.doc.nodeAt(target.pos);
  return (
    <>
      <EditorContent editor={editor} />
      {mounted && node && (
        <EditorBlockMenu editor={editor} pos={target.pos} node={node} onClose={onClose} />
      )}
    </>
  );
}

interface HarnessProps {
  content: string;
  blockIndex?: number;
  customPos?: (editor: EditorType) => number;
  onReady: (e: EditorType) => void;
  onClose: () => void;
  trailingNode?: boolean;
}

interface Mounted {
  editor: EditorType;
  onClose: ReturnType<typeof vi.fn>;
  rerender: (ui: React.ReactElement) => void;
  props: HarnessProps;
}

async function mountMenu(
  content: string,
  blockIndex = 0,
  extra: { trailingNode?: boolean; customPos?: (editor: EditorType) => number } = {},
): Promise<Mounted> {
  let editor: EditorType | null = null;
  const onReady = (e: EditorType) => { editor = e; };
  const onClose = vi.fn();
  const props: HarnessProps = { content, blockIndex, onReady, onClose, ...extra };
  const { rerender } = render(<Harness {...props} />);
  await waitFor(() => expect(editor).not.toBeNull());
  await screen.findByTestId('editor-block-menu');
  return { editor: editor!, onClose, rerender, props };
}

beforeEach(() => streamSSE.mockReset());

describe('EditorBlockMenu — text blocks', () => {
  it('names the block it targets', async () => {
    await mountMenu('<h2>Release notes</h2>');
    expect(screen.getByTestId('block-menu-label')).toHaveTextContent('Heading 2');
  });

  it('offers block type dropdown, formatting, Improve and Delete', async () => {
    await mountMenu('<p>Hello world</p>');
    expect(screen.getByTestId('block-type-trigger')).toHaveTextContent('Text');
    expect(screen.getByRole('toolbar', { name: 'Block formatting' })).toBeTruthy();
    expect(screen.getByTitle('Bold (Ctrl+B)')).toBeTruthy();
    expect(screen.getByTestId('block-ai-trigger')).toBeTruthy();
    expect(screen.getByTestId('block-menu-delete')).toBeTruthy();
  });

  it('changes block type (e.g. paragraph to Heading 1) via the block type dropdown', async () => {
    const { editor } = await mountMenu('<p>Hello world</p>');
    expect(screen.getByTestId('block-type-trigger')).toHaveTextContent('Text');

    fireEvent.pointerDown(screen.getByTestId('block-type-trigger'), { button: 0, pointerType: 'mouse' });
    fireEvent.click(screen.getByTestId('block-type-trigger'));

    const h1Option = await screen.findByRole('menuitem', { name: /^Heading 1/ });
    fireEvent.click(h1Option);

    expect(editor.getHTML()).toContain('<h1>Hello world</h1>');
    expect(screen.getByTestId('block-type-trigger')).toHaveTextContent('Heading 1');
  });

  it('converts paragraph to Quote via the block type dropdown', async () => {
    const { editor } = await mountMenu('<p>Quote me</p>');
    expect(screen.getByTestId('block-type-trigger')).toHaveTextContent('Text');

    fireEvent.pointerDown(screen.getByTestId('block-type-trigger'), { button: 0, pointerType: 'mouse' });
    fireEvent.click(screen.getByTestId('block-type-trigger'));

    const quoteOption = await screen.findByRole('menuitem', { name: /^Quote/ });
    fireEvent.click(quoteOption);

    expect(editor.getHTML()).toContain('<blockquote><p>Quote me</p></blockquote>');
  });

  it('converts paragraph to Code block via the block type dropdown', async () => {
    const { editor } = await mountMenu('<p>const a = 10;</p>');
    expect(screen.getByTestId('block-type-trigger')).toHaveTextContent('Text');

    fireEvent.pointerDown(screen.getByTestId('block-type-trigger'), { button: 0, pointerType: 'mouse' });
    fireEvent.click(screen.getByTestId('block-type-trigger'));

    const codeOption = await screen.findByRole('menuitem', { name: /^Code block/ });
    fireEvent.click(codeOption);

    expect(editor.getHTML()).toContain('<pre><code');
    expect(editor.getHTML()).toContain('const a = 10;');
  });

  it('aligns the block (e.g. Center, Right, Justify) from the block menu', async () => {
    const { editor } = await mountMenu('<p>Hello world</p>');

    fireEvent.click(screen.getByTitle('Align center'));
    expect(editor.getHTML()).toContain('style="text-align: center;"');

    fireEvent.click(screen.getByTitle('Align right'));
    expect(editor.getHTML()).toContain('style="text-align: right;"');
  });

  it('formats the WHOLE block, not wherever the caret happens to be', async () => {
    const { editor } = await mountMenu('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection(2); }); // a collapsed caret

    fireEvent.click(screen.getByTitle('Bold (Ctrl+B)'));

    expect(editor.getHTML()).toBe('<p><strong>Hello world</strong></p>');
  });

  // A block-wide selection left behind outlives the menu: once the marker
  // clears, `selectionShouldShow` sees it and pops the bubble menu over the
  // block the user just finished with.
  it('leaves no selection behind for the bubble menu to latch onto', async () => {
    const { editor } = await mountMenu('<p>Hello world</p>');

    fireEvent.click(screen.getByTitle('Bold (Ctrl+B)'));

    expect(editor.getHTML()).toBe('<p><strong>Hello world</strong></p>');
    expect(editor.state.selection.empty).toBe(true);
  });

  it('formats the second block when that is the target', async () => {
    const { editor } = await mountMenu('<p>First</p><p>Second</p>', 1);

    fireEvent.click(screen.getByTitle('Italic (Ctrl+I)'));

    expect(editor.getHTML()).toBe('<p>First</p><p><em>Second</em></p>');
  });

  it('reflects the block\'s own marks in the pressed state, not the caret\'s', async () => {
    const { editor } = await mountMenu('<p><strong>Bold block</strong></p>');
    act(() => { editor.commands.setTextSelection(0); });

    await waitFor(() => {
      expect(screen.getByTitle('Bold (Ctrl+B)')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTitle('Italic (Ctrl+I)')).toHaveAttribute('aria-pressed', 'false');
    });
  });

  it('sends only the block\'s text, scoped by the block instruction', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'Improved.' }, { done: true }]));
    await mountMenu('<p>First</p><h2>Target heading</h2>', 1);

    fireEvent.click(screen.getByTestId('block-ai-trigger'));
    fireEvent.click(screen.getByText('Improve writing'));

    await waitFor(() => expect(streamSSE).toHaveBeenCalled());
    const [url, body] = streamSSE.mock.calls[0]!;
    expect(url).toBe('/llm/improve');
    expect(body.content).toBe('Target heading');
    expect(body.instruction).toContain('ONE COMPLETE BLOCK');
  });

  it('replaces the block CONTENT, so an improved heading is still a heading', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'Sharper heading' }, { done: true }]));
    const { editor, onClose } = await mountMenu('<h2>Vague heading</h2>');

    fireEvent.click(screen.getByTestId('block-ai-trigger'));
    fireEvent.click(screen.getByText('Improve writing'));
    await screen.findByTestId('block-ai-preview');
    await waitFor(() => expect(screen.getByTitle('Replace block content')).not.toBeDisabled());

    fireEvent.click(screen.getByTitle('Replace block content'));

    // Still an h2, with new content — not flattened to a paragraph.
    expect(editor.state.doc.child(0).type.name).toBe('heading');
    expect(editor.state.doc.child(0).attrs.level).toBe(2);
    expect(editor.state.doc.child(0).textContent).toBe('Sharper heading');
    expect(onClose).toHaveBeenCalled();
  });

  it('inserts below the whole block rather than splitting it', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'Extra thought' }, { done: true }]));
    const { editor } = await mountMenu('<p>Original</p><p>Next</p>');

    fireEvent.click(screen.getByTestId('block-ai-trigger'));
    fireEvent.click(screen.getByText('Improve writing'));
    await waitFor(() => expect(screen.getByTitle('Insert below block')).not.toBeDisabled());

    fireEvent.click(screen.getByTitle('Insert below block'));

    expect(editor.getHTML()).toBe('<p>Original</p><p>Extra thought</p><p>Next</p>');
  });

  it('hides Improve on a block with no text — an empty run would do nothing', async () => {
    await mountMenu('<p></p>');
    expect(screen.queryByTestId('block-ai-trigger')).toBeNull();
    // Formatting and Delete are still there.
    expect(screen.getByTitle('Bold (Ctrl+B)')).toBeTruthy();
    expect(screen.getByTestId('block-menu-delete')).toBeTruthy();
  });

  // A blockquote's content range starts at a block-level position rather than
  // inside a textblock — the one case where "pos + 1 … pos + size - 1" is not
  // simply a run of text.
  it('improves a quote through its nested paragraph', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'Better quote' }, { done: true }]));
    await mountMenu('<blockquote><p>Quoted text</p></blockquote>');

    fireEvent.click(screen.getByTestId('block-ai-trigger'));
    fireEvent.click(screen.getByText('Improve writing'));

    await waitFor(() => expect(streamSSE).toHaveBeenCalled());
    expect(streamSSE.mock.calls[0]![1].content).toBe('Quoted text');
  });

  it('formats a quote through its nested paragraph', async () => {
    const { editor } = await mountMenu('<blockquote><p>Quoted text</p></blockquote>');

    fireEvent.click(screen.getByTitle('Bold (Ctrl+B)'));

    expect(editor.getHTML()).toContain('<blockquote><p><strong>Quoted text</strong></p></blockquote>');
  });

  it('replaces a quote\'s content without unwrapping the quote', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'Better quote' }, { done: true }]));
    const { editor } = await mountMenu('<blockquote><p>Quoted text</p></blockquote>');

    fireEvent.click(screen.getByTestId('block-ai-trigger'));
    fireEvent.click(screen.getByText('Improve writing'));
    await waitFor(() => expect(screen.getByTitle('Replace block content')).not.toBeDisabled());

    fireEvent.click(screen.getByTitle('Replace block content'));

    expect(editor.state.doc.child(0).type.name).toBe('blockquote');
    expect(editor.state.doc.child(0).textContent).toBe('Better quote');
  });
});

// The block-type allow-list keeps Improve away from block-level macros, but a
// plain paragraph can still carry Confluence's INLINE atoms. `textBetween` skips
// them (the model never sees them) and Replace overwrites the whole content
// range, deleting the nodes — silent Confluence loss on the next Save.
describe('EditorBlockMenu — inline macros inside an allowed text block', () => {
  const WITH_MENTION =
    '<p>Ask <span class="confluence-user-mention" data-username="jdoe">@jdoe</span> about it</p>';
  const WITH_STATUS =
    '<p>Release <span class="confluence-status" data-color="green">DONE</span> now</p>';

  function countType(editor: EditorType, name: string): number {
    let n = 0;
    editor.state.doc.descendants((node) => { if (node.type.name === name) n += 1; });
    return n;
  }

  it('hides Improve on a paragraph carrying a user mention', async () => {
    const { editor } = await mountMenu(WITH_MENTION);
    expect(countType(editor, 'confluenceUserMention')).toBe(1);

    expect(screen.queryByTestId('block-ai-trigger')).toBeNull();
    expect(
      screen.getByText(/a rewrite would drop this block.s inline macros/i),
    ).toBeTruthy();
  });

  it('hides Improve on a paragraph carrying a status macro', async () => {
    const { editor } = await mountMenu(WITH_STATUS);
    expect(countType(editor, 'confluenceStatus')).toBe(1);
    expect(screen.queryByTestId('block-ai-trigger')).toBeNull();
  });

  it('still offers formatting and Delete, which do not touch the atoms', async () => {
    const { editor } = await mountMenu(WITH_MENTION);

    fireEvent.click(screen.getByTitle('Bold (Ctrl+B)'));

    expect(editor.getHTML()).toContain('<strong>');
    expect(countType(editor, 'confluenceUserMention')).toBe(1);
    expect(screen.getByTestId('block-menu-delete')).toBeTruthy();
  });

  it('leaves Improve alone on a paragraph with no inline macro', async () => {
    await mountMenu('<p>Just ordinary prose</p>');
    expect(screen.getByTestId('block-ai-trigger')).toBeTruthy();
    expect(screen.queryByText(/inline macros/i)).toBeNull();
  });

  it('does not block Improve for a line break, which is only cosmetic', async () => {
    await mountMenu('<p>First line<br>second line</p>');
    expect(screen.getByTestId('block-ai-trigger')).toBeTruthy();
  });
});

// `unwrapSingleParagraph` only strips a wrapper when the answer is exactly one
// paragraph. Anything else stays block-level HTML, and inserting THAT over a
// heading's inline content range does not fill the heading — ProseMirror lifts
// the blocks out and the heading is gone. "Make longer" produces this every
// time, and a heading demoted to body text breaks the page's TOC on Save.
describe('EditorBlockMenu — multi-block answers over a heading', () => {
  async function improve(content: string, chunks: string, blockIndex = 0) {
    streamSSE.mockReturnValue(gen([{ content: chunks }, { done: true }]));
    const mounted = await mountMenu(content, blockIndex);
    fireEvent.click(screen.getByTestId('block-ai-trigger'));
    fireEvent.click(screen.getByText('Improve writing'));
    await screen.findByTestId('block-ai-preview');
    return mounted;
  }

  it('refuses Replace and says why when the answer is more than one block', async () => {
    const { editor } = await improve('<h2>Release notes</h2><p>after</p>', 'Release notes v2\n\nEvery change is listed.');

    await waitFor(() => expect(screen.getByTestId('block-ai-replace-blocked')).toBeTruthy());
    expect(screen.getByTitle(/more than one block/i)).toBeDisabled();

    fireEvent.click(screen.getByTitle(/more than one block/i));
    expect(editor.state.doc.child(0).type.name).toBe('heading');
    expect(editor.state.doc.child(0).textContent).toBe('Release notes');
  });

  it('refuses when the answer is a markdown heading, which would re-level it', async () => {
    await improve('<h2>Release notes</h2>', '# Big title');
    await waitFor(() => expect(screen.getByTestId('block-ai-replace-blocked')).toBeTruthy());
  });

  it('leaves Insert below available, so the answer is never lost', async () => {
    const { editor } = await improve('<h2>Release notes</h2><p>after</p>', 'Release notes v2\n\nEvery change is listed.');

    await waitFor(() => expect(screen.getByTitle('Insert below block')).not.toBeDisabled());
    fireEvent.click(screen.getByTitle('Insert below block'));

    expect(editor.state.doc.child(0).type.name).toBe('heading');
    expect(editor.getHTML()).toContain('Every change is listed.');
  });

  it('still allows Replace on a heading when the answer is a single paragraph', async () => {
    const { editor } = await improve('<h2>Vague heading</h2>', 'Sharper heading');

    await waitFor(() => expect(screen.getByTitle('Replace block content')).not.toBeDisabled());
    expect(screen.queryByTestId('block-ai-replace-blocked')).toBeNull();
    fireEvent.click(screen.getByTitle('Replace block content'));

    expect(editor.state.doc.child(0).type.name).toBe('heading');
    expect(editor.state.doc.child(0).textContent).toBe('Sharper heading');
  });

  // A paragraph becoming two paragraphs is the point of "Make longer", and a
  // blockquote takes block content by schema — neither loses a node.
  it('allows a multi-block Replace on a paragraph', async () => {
    const { editor } = await improve('<p>Short</p>', 'First part.\n\nSecond part.');

    await waitFor(() => expect(screen.getByTitle('Replace block content')).not.toBeDisabled());
    fireEvent.click(screen.getByTitle('Replace block content'));

    expect(editor.getHTML()).toContain('First part.');
    expect(editor.getHTML()).toContain('Second part.');
  });

  it('allows a multi-block Replace on a quote, which survives it', async () => {
    const { editor } = await improve('<blockquote><p>Short</p></blockquote>', 'First part.\n\nSecond part.');

    await waitFor(() => expect(screen.getByTitle('Replace block content')).not.toBeDisabled());
    fireEvent.click(screen.getByTitle('Replace block content'));

    expect(editor.state.doc.child(0).type.name).toBe('blockquote');
  });
});

// A link is a MARK, not a node, so the inline-macro guard never sees it.
// `textBetween` strips it, the model cannot return what it never saw, and the
// href is data rather than formatting. Warned, not hidden: the text survives,
// and hiding Improve for every paragraph with a link would gut the feature.
describe('EditorBlockMenu — link marks', () => {
  const WITH_LINK = '<p>See the <a href="https://conf/x/RUNBOOK">runbook</a> first</p>';

  it('warns that a rewrite drops the href, but still offers Improve', async () => {
    await mountMenu(WITH_LINK);

    expect(screen.getByTestId('block-ai-trigger')).toBeTruthy();
    expect(screen.getByTestId('block-menu-link-warning')).toBeTruthy();
  });

  it('shows no warning on a block with no link', async () => {
    await mountMenu('<p>Just ordinary prose</p>');
    expect(screen.queryByTestId('block-menu-link-warning')).toBeNull();
  });
});

describe('EditorBlockMenu — atomic and macro blocks', () => {
  it('offers Delete ONLY on a draw.io diagram', async () => {
    await mountMenu('<p>Text</p><div data-drawio></div>', 1);

    expect(screen.getByTestId('block-menu-label')).toHaveTextContent('Draw.io diagram');
    expect(screen.queryByRole('toolbar', { name: 'Block formatting' })).toBeNull();
    expect(screen.queryByTitle('Bold (Ctrl+B)')).toBeNull();
    expect(screen.queryByTestId('block-ai-trigger')).toBeNull();
    expect(screen.getByTestId('block-menu-delete')).toBeTruthy();
  });

  it('says why the text actions are missing rather than showing a bare menu', async () => {
    await mountMenu('<p>Text</p><div data-drawio></div>', 1);
    expect(
      screen.getByText('Formatting and AI editing apply to text blocks only.'),
    ).toBeTruthy();
  });

  it('offers Delete only inside a code block, matching selectionShouldShow', async () => {
    await mountMenu('<pre><code>const x = 1;</code></pre>');

    expect(screen.getByTestId('block-menu-label')).toHaveTextContent('Code block');
    expect(screen.queryByTitle('Bold (Ctrl+B)')).toBeNull();
    expect(screen.queryByTestId('block-ai-trigger')).toBeNull();
    expect(screen.getByTestId('block-menu-delete')).toBeTruthy();
  });

  it('offers Delete only on a list, which is not one of the four text types', async () => {
    await mountMenu('<ul><li><p>One</p></li></ul>');
    expect(screen.queryByTitle('Bold (Ctrl+B)')).toBeNull();
    expect(screen.getByTestId('block-menu-delete')).toBeTruthy();
  });

  it('toggles UI Expand default-open from the handle menu', async () => {
    const { editor } = await mountMenu(
      '<details data-macro-name="ui-expand"><summary>T</summary><p>B</p></details>',
    );
    const toggle = screen.getByTestId('block-menu-default-open');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(editor.getHTML()).not.toMatch(/<details[^>]*\sopen\b/);
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(editor.getHTML()).toMatch(/<details[^>]*\sopen\b/);
    expect(screen.getByTestId('block-menu-default-open')).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not offer default-open on a native expand', async () => {
    await mountMenu(
      '<details data-macro-name="expand"><summary>T</summary><p>B</p></details>',
    );
    expect(screen.queryByTestId('block-menu-default-open')).toBeNull();
  });
});

describe('EditorBlockMenu — table blocks', () => {
  it('offers table configuration from the grab-handle context menu', async () => {
    await mountMenu(
      '<table><tbody><tr><th>Header</th><th>Value</th></tr><tr><td>A</td><td>B</td></tr></tbody></table>',
    );

    await waitFor(() => {
      expect(screen.getByTestId('block-table-toolbar')).toBeInTheDocument();
      expect(screen.getByRole('toolbar', { name: 'Table editing controls' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('toolbar', { name: 'Block formatting' })).toBeNull();
    expect(screen.getByTestId('toggle-table-expand')).toHaveAttribute('title', 'Expand table to page width');
    expect(screen.getByTestId('table-toggle-header-row')).toBeInTheDocument();
    expect(screen.getByTestId('table-toggle-header-column')).toBeInTheDocument();
  });

  it('toggles header row switch state in the context menu when clicked', async () => {
    await mountMenu(
      '<table><tbody><tr><th>Header</th><th>Value</th></tr><tr><td>A</td><td>B</td></tr></tbody></table>',
    );

    const rowSwitch = screen.getByTestId('table-toggle-header-row');
    expect(rowSwitch).toHaveAttribute('data-state', 'checked');

    fireEvent.click(rowSwitch);

    await waitFor(() => {
      expect(screen.getByTestId('table-toggle-header-row')).toHaveAttribute('data-state', 'unchecked');
    });

    fireEvent.click(screen.getByTestId('table-toggle-header-row'));

    await waitFor(() => {
      expect(screen.getByTestId('table-toggle-header-row')).toHaveAttribute('data-state', 'checked');
    });
  });

  it('toggles header column switch state in the context menu when clicked', async () => {
    await mountMenu(
      '<table><tbody><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></tbody></table>',
    );

    const colSwitch = screen.getByTestId('table-toggle-header-column');
    expect(colSwitch).toHaveAttribute('data-state', 'unchecked');

    fireEvent.click(colSwitch);

    await waitFor(() => {
      expect(screen.getByTestId('table-toggle-header-column')).toHaveAttribute('data-state', 'checked');
    });
  });

  it('keeps header row active when toggling header column off from a state where both are active', async () => {
    await mountMenu(
      '<table><tbody><tr><th>Header</th><th>Value</th></tr><tr><th>Row 1</th><td>Data</td></tr></tbody></table>',
    );

    const rowSwitch = screen.getByTestId('table-toggle-header-row');
    const colSwitch = screen.getByTestId('table-toggle-header-column');

    expect(rowSwitch).toHaveAttribute('data-state', 'checked');
    expect(colSwitch).toHaveAttribute('data-state', 'checked');

    // Toggle column OFF
    fireEvent.click(colSwitch);

    await waitFor(() => {
      expect(screen.getByTestId('table-toggle-header-row')).toHaveAttribute('data-state', 'checked');
      expect(screen.getByTestId('table-toggle-header-column')).toHaveAttribute('data-state', 'unchecked');
    });

    // Toggle column back ON
    fireEvent.click(colSwitch);

    await waitFor(() => {
      expect(screen.getByTestId('table-toggle-header-row')).toHaveAttribute('data-state', 'checked');
      expect(screen.getByTestId('table-toggle-header-column')).toHaveAttribute('data-state', 'checked');
    });
  });
});

describe('EditorBlockMenu — Duplicate', () => {
  it('duplicates the target block directly below it', async () => {
    const { editor, onClose } = await mountMenu('<p>First</p><p>Target</p><p>Last</p>', 1);

    fireEvent.click(screen.getByTestId('block-menu-duplicate'));

    expect(editor.getHTML()).toBe('<p>First</p><p>Target</p><p>Target</p><p>Last</p>');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('EditorBlockMenu — Delete', () => {
  it('removes just the target block', async () => {
    const { editor, onClose } = await mountMenu('<p>Keep</p><p>Remove</p><p>Keep too</p>', 1);

    fireEvent.click(screen.getByTestId('block-menu-delete'));

    expect(editor.getHTML()).toBe('<p>Keep</p><p>Keep too</p>');
    expect(onClose).toHaveBeenCalled();
  });

  it('removes an atomic block — the only way to delete one from the editor', async () => {
    const { editor } = await mountMenu('<p>Text</p><div data-drawio></div><p>After</p>', 1);
    expect(editor.getHTML()).toContain('data-drawio');

    fireEvent.click(screen.getByTestId('block-menu-delete'));

    expect(editor.getHTML()).not.toContain('data-drawio');
    expect(editor.state.doc.textContent).toBe('TextAfter');
  });

  // The invariant, not the mechanism: `doc` is `block+`, so emptying it outright
  // is an invalid document. ProseMirror's `deleteRange` is what delivers the
  // bare paragraph (measured identical to hand-rolling one across every
  // container shape in the schema), so these pin the outcome that must hold if
  // its fitting ever changes.
  it('leaves an empty paragraph when the last remaining block is deleted', async () => {
    const { editor } = await mountMenu('<p>The only block</p>');

    fireEvent.click(screen.getByTestId('block-menu-delete'));

    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.child(0).type.name).toBe('paragraph');
    expect(editor.state.doc.textContent).toBe('');
  });

  it('leaves an empty paragraph when the sole block is atomic', async () => {
    const { editor } = await mountMenu('<div data-drawio></div>', 0, { trailingNode: false });
    expect(editor.state.doc.childCount).toBe(1);

    fireEvent.click(screen.getByTestId('block-menu-delete'));

    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.child(0).type.name).toBe('paragraph');
  });

  // `deleteRange` widens to a range the schema can lose. Removing a container's
  // only child has to take the container too rather than leave it empty and
  // invalid — the case the old hand-rolled "is this the only block" branch never
  // covered, since it only fired for a whole-document range.
  it('takes the container with it when the block was its only child', async () => {
    const { editor } = await mountMenu('<p>Before</p><blockquote><p>Quoted</p></blockquote>', 1);

    fireEvent.click(screen.getByTestId('block-menu-delete'));

    expect(editor.getHTML()).not.toContain('<blockquote>');
    expect(editor.state.doc.type.validContent(editor.state.doc.content)).toBe(true);
    let invalid: string | null = null;
    editor.state.doc.descendants((n) => {
      if (!n.type.validContent(n.content)) invalid = n.type.name;
    });
    expect(invalid).toBeNull();
  });

  // The toast outlives the menu and can outlive the editor — leaving edit mode
  // or navigating away destroys it while the toast is still on screen.
  it('does not throw when Undo is clicked after the editor is destroyed', async () => {
    const { editor } = await mountMenu('<p>Keep</p><p>Remove</p>', 1);
    const toasts: Array<{ action?: { onClick: () => void } }> = [];
    const spy = vi.spyOn(toast, 'success').mockImplementation(((_m: unknown, opts: unknown) => {
      toasts.push(opts as { action?: { onClick: () => void } });
      return 1;
    }) as typeof toast.success);

    fireEvent.click(screen.getByTestId('block-menu-delete'));
    spy.mockRestore();

    const undo = toasts[0]?.action?.onClick;
    expect(undo).toBeTypeOf('function');
    editor.destroy();
    expect(() => undo!()).not.toThrow();
  });

  it('deletes the right block after the document shifted above it', async () => {
    // The snapshotted `pos` is stale the moment anything above the block
    // changes; the marker decoration is what keeps the target correct.
    const { editor } = await mountMenu('<p>First</p><p>Remove</p>', 1);

    act(() => { editor.commands.insertContentAt(1, 'PREFIX '); });
    fireEvent.click(screen.getByTestId('block-menu-delete'));

    expect(editor.getHTML()).toBe('<p>PREFIX First</p>');
  });
});

/**
 * Source-level guards, in the style this repo already uses for the CSS
 * contracts (`index-css-a11y.test.ts`, the neumorphic source walk).
 *
 * `EditorBlockHandle` mounts the Radix layer, and it cannot be driven under
 * jsdom: the drag-handle plugin resolves its node from `mousemove` coordinates
 * and `getBoundingClientRect`, so the menu never opens and none of the popover's
 * props are ever exercised. These pin the two that are load-bearing and would
 * otherwise fail silently — verified by adversarial mutation to survive the
 * whole behavioural suite.
 */
describe('EditorBlockMenu — popover wiring (source guards)', () => {
  const source = readFileSync(resolve(__dirname, 'EditorBlockMenu.tsx'), 'utf-8');

  // Every action chain ends in `editor.chain().focus()`, which moves focus out
  // of the popover. Radix reads that as an interaction outside the layer and
  // dismisses — so without this the menu closes after a single Bold.
  it('does not treat focus leaving for the editor as a dismissal', () => {
    expect(source).toMatch(/onFocusOutside=\{\(event\) => event\.preventDefault\(\)\}/);
  });

  // Theory-independent tripwire. `block-menu-escape.test.tsx` covers the
  // behaviour, but it does so by MODELLING Radix + React timing — if either
  // library changes when it unmounts, those models can drift green while the
  // real bug returns. This assertion costs one line and survives that.
  it('contains Escape via onEscapeKeyDown', () => {
    expect(source).toMatch(/onEscapeKeyDown=\{\(event\) => absorbBlockMenuEscape\(event, closeMenu\)\}/);
  });

  // Radix's `Popover.Anchor` is what the menu is positioned against, and the
  // `data-block-menu-open` attribute is what `index.css` keys the handle's
  // open-state reveal off (`.drag-handle:has([data-block-menu-open="true"])`).
  it('declares the open state the handle CSS reveal keys off', () => {
    expect(source).toMatch(/data-block-menu-open=\{open \? 'true' : undefined\}/);
  });
});

describe('EditorBlockMenu — lifecycle', () => {
  it('aborts an in-flight Improve when the menu unmounts', async () => {
    let signal: AbortSignal | undefined;
    streamSSE.mockImplementation((_url: string, _body: unknown, s: AbortSignal) => {
      signal = s;
      return pending(s);
    });

    const { rerender, props } = await mountMenu('<p>Improve me</p>');
    fireEvent.click(screen.getByTestId('block-ai-trigger'));
    fireEvent.click(screen.getByText('Improve writing'));
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal!.aborted).toBe(false);

    // Radix unmounts the popover content on Escape / outside click / Delete.
    rerender(<Harness {...props} mounted={false} />);

    await waitFor(() => expect(signal!.aborted).toBe(true));
  });

  it('aborts the stream when the AI section is discarded', async () => {
    let signal: AbortSignal | undefined;
    streamSSE.mockImplementation((_url: string, _body: unknown, s: AbortSignal) => {
      signal = s;
      return pending(s);
    });

    await mountMenu('<p>Improve me</p>');
    fireEvent.click(screen.getByTestId('block-ai-trigger'));
    fireEvent.click(screen.getByText('Improve writing'));
    await waitFor(() => expect(signal).toBeDefined());

    fireEvent.click(screen.getByTitle('Discard'));

    await waitFor(() => expect(signal!.aborted).toBe(true));
    // Collapsed back to the command list, menu still open.
    expect(screen.queryByTestId('block-ai-panel')).toBeNull();
    expect(screen.getByTestId('block-menu-delete')).toBeTruthy();
  });

  it('goes inert rather than formatting a different block once the target is gone', async () => {
    const { editor } = await mountMenu('<p>First</p><p>Target</p>', 1);
    act(() => {
      editor.commands.deleteRange({
        from: topLevelPos(editor, 1),
        to: editor.state.doc.content.size,
      });
      // Put a live selection somewhere else, which a fall-through would format.
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });

    const bold = screen.queryByTitle('Bold (Ctrl+B)');
    if (bold) fireEvent.click(bold);

    expect(editor.getHTML()).not.toContain('<strong>');
  });

  // The menu must not survive its target being swapped out from under it, even
  // when the replacement occupies exactly the same span and the range therefore
  // still "fits" — `blockquote(paragraph())` and `paragraph('xy')` are both
  // nodeSize 4. ProseMirror drops the node decoration on any replacement, which
  // is what delivers this; the test pins the outcome rather than the mechanism.
  it('closes itself when the target is swapped for a different node of the same size', async () => {
    const { editor, onClose } = await mountMenu('<p>First</p><p>xy</p>', 1);
    const pos = topLevelPos(editor, 1);
    expect(editor.state.doc.child(1).nodeSize).toBe(4);
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      editor.commands.command(({ tr, dispatch }) => {
        if (!dispatch) return true;
        const swapped = editor.schema.nodes.blockquote!.create(
          null,
          editor.schema.nodes.paragraph!.create(null),
        );
        expect(swapped.nodeSize).toBe(4);
        tr.replaceWith(pos, pos + 4, swapped);
        return true;
      });
    });

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  // The close-on-missing-target check keys off the NODE range. Keying it off the
  // content range instead would close every atomic block's menu the instant it
  // opened, since an atom has no content range at all.
  it('stays open on an atomic block, whose content range is empty by nature', async () => {
    const { onClose } = await mountMenu('<p>Text</p><div data-drawio></div>', 1);

    expect(screen.getByTestId('block-menu-delete')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes itself when the target block disappears underneath it', async () => {
    const { editor, onClose } = await mountMenu('<p>First</p><p>Target</p>', 1);
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      editor.commands.deleteRange({
        from: topLevelPos(editor, 1),
        to: editor.state.doc.content.size,
      });
    });

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('hides Delete while the AI section is open, so the menu has one focus', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'x' }, { done: true }]));
    await mountMenu('<p>Improve me</p>');

    fireEvent.click(screen.getByTestId('block-ai-trigger'));

    expect(screen.getByTestId('block-ai-panel')).toBeTruthy();
    expect(screen.queryByTestId('block-menu-delete')).toBeNull();
  });
});

describe('EditorBlockMenu — nested blocks in column containers', () => {
  it('configures NESTED_DRAG_OPTIONS with sensible defaults and excludes column containers', () => {
    expect(NESTED_DRAG_OPTIONS.defaultRules).toBe(true);
    expect(NESTED_DRAG_OPTIONS.edgeDetection).toBe('none');
    const containerRule = NESTED_DRAG_OPTIONS.rules?.find((r) => r.id === 'excludeLayoutContainers');
    expect(containerRule).toBeDefined();

    const evalRule = (nodeName: string, parentName?: string) =>
      containerRule?.evaluate({
        node: { type: { name: nodeName } },
        parent: parentName ? { type: { name: parentName } } : null,
      });

    // Structural containers should be excluded from drag targeting
    expect(evalRule('confluenceColumn')).toBe(1000);
    expect(evalRule('confluenceLayoutCell')).toBe(1000);
    expect(evalRule('confluenceLayoutSection')).toBe(1000);
    expect(evalRule('detailsSummary')).toBe(1000);
    expect(evalRule('tableRow')).toBe(1000);
    expect(evalRule('tableCell')).toBe(1000);
    expect(evalRule('tableHeader')).toBe(1000);
    expect(evalRule('paragraph', 'tableCell')).toBe(1000);

    // Regular content blocks outside tables should not be deducted
    expect(evalRule('paragraph', 'confluenceColumn')).toBe(0);
    expect(evalRule('heading')).toBe(0);
    expect(evalRule('table')).toBe(0);

    // Notion-style title/header anchor rule for outer containers
    const anchorRule = NESTED_DRAG_OPTIONS.rules?.find((r) => r.id === 'notionContainerTitleAnchor');
    expect(anchorRule).toBeDefined();

    const evalAnchor = (nodeName: string, depth = 1, cursorDepth = 2, childIndex = 0, childCount = 2) =>
      anchorRule?.evaluate({
        node: { type: { name: nodeName }, childCount },
        depth,
        $pos: { depth: cursorDepth, index: () => childIndex },
      });

    // Expand sections (details): only anchor handle when hovering title (index 0); body (index > 0) never jumps to outer container
    expect(evalAnchor('details', 1, 2, 0, 2)).toBe(0);
    expect(evalAnchor('details', 1, 2, 1, 2)).toBe(1000);
    expect(evalAnchor('details', 1, 2, 2, 2)).toBe(1000);
    // Gap between text blocks inside details (cursorDepth === depth)
    expect(evalAnchor('details', 1, 1, 0, 2)).toBe(1000);

    // Multi-column layouts: sections always yield to inner column blocks and gaps between blocks
    expect(evalAnchor('confluenceSection', 1, 3, 0, 2)).toBe(1000);
    expect(evalAnchor('confluenceSection', 1, 1, 0, 2)).toBe(1000);
    expect(evalAnchor('confluenceLayout', 1, 3, 0, 2)).toBe(1000);

    // Callouts & Panels: yield to inner blocks in body (index > 0), prefer inner block in first row
    expect(evalAnchor('panel', 1, 2, 0, 2)).toBe(200);
    expect(evalAnchor('panel', 1, 2, 1, 2)).toBe(1000);
    expect(evalAnchor('blockquote', 1, 2, 1, 2)).toBe(1000);
    // Gap between text blocks inside panel/blockquote (cursorDepth === depth)
    expect(evalAnchor('panel', 1, 1, 0, 2)).toBe(1000);
    expect(evalAnchor('blockquote', 1, 1, 0, 2)).toBe(1000);
    expect(evalAnchor('paragraph', 2, 2, 0, 1)).toBe(0);

    // When mouse is in the outer left gutter (outside container bounding rect)
    const mockElement = {
      getBoundingClientRect: () => ({ left: 200, right: 800, top: 100, bottom: 300, width: 600, height: 200 }),
    };
    const mockView = {
      nodeDOM: () => mockElement,
    };

    // Dispatch mouse event to left of container (x: 180 < 200 + 16)
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 180, clientY: 150 }));

    const evalOuterGutter = (nodeName: string, depth = 1, pos = 0) =>
      anchorRule?.evaluate({
        node: { type: { name: nodeName } },
        pos,
        depth,
        $pos: { depth: 2, before: () => 0, node: () => ({ type: { name: 'confluenceSection' } }) },
        view: mockView,
      });

    // Outer container receives 0 deduction (Score 1000) when hovering in outer left gutter
    expect(evalOuterGutter('confluenceSection', 1, 0)).toBe(0);
    expect(evalOuterGutter('panel', 1, 0)).toBe(0);
    expect(evalOuterGutter('details', 1, 0)).toBe(0);
    // Inner child block yields (deduction 1000) when pointer is in outer gutter
    expect(evalOuterGutter('paragraph', 2, 10)).toBe(1000);
  });

  it('targets a paragraph inside a confluenceColumn and offers block actions', async () => {
    const content = `
      <div class="confluence-section">
        <div class="confluence-column">
          <p>Column 1 Paragraph</p>
        </div>
      </div>
    `;

    // Find pos of the inner paragraph
    const findInnerPos = (editor: EditorType) => {
      let foundPos = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'paragraph' && node.textContent.includes('Column 1 Paragraph')) {
          foundPos = pos;
          return false;
        }
        return true;
      });
      return foundPos;
    };

    await mountMenu(content, 0, { customPos: findInnerPos });

    expect(screen.getByTestId('block-menu-label')).toHaveTextContent('Paragraph');
    expect(screen.getByTestId('block-type-trigger')).toHaveTextContent('Text');
    expect(screen.getByTestId('block-menu-duplicate')).toBeTruthy();
    expect(screen.getByTestId('block-menu-delete')).toBeTruthy();
    expect(screen.getByTestId('block-ai-trigger')).toBeTruthy();
  });

  it('allows converting block type of a paragraph inside a column to a heading', async () => {
    const content = `
      <div class="confluence-section">
        <div class="confluence-column">
          <p>Convert this</p>
        </div>
      </div>
    `;

    const findInnerPos = (editor: EditorType) => {
      let foundPos = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'paragraph' && node.textContent.includes('Convert this')) {
          foundPos = pos;
          return false;
        }
        return true;
      });
      return foundPos;
    };

    const { editor } = await mountMenu(content, 0, { customPos: findInnerPos });

    fireEvent.pointerDown(screen.getByTestId('block-type-trigger'), { button: 0, pointerType: 'mouse' });
    fireEvent.click(screen.getByTestId('block-type-trigger'));
    const h2Option = await screen.findByRole('menuitem', { name: /Heading 2/ });
    fireEvent.click(h2Option);

    const html = editor.getHTML();
    expect(html).toContain('<h2>Convert this</h2>');
    expect(html).toContain('class="confluence-section"');
    expect(html).toContain('class="confluence-column"');
  });

  it('duplicates a block inside a column from the block menu', async () => {
    const content = `
      <div class="confluence-section">
        <div class="confluence-column">
          <p>Inner content to duplicate</p>
        </div>
      </div>
    `;

    const findInnerPos = (editor: EditorType) => {
      let foundPos = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'paragraph' && node.textContent.includes('Inner content to duplicate')) {
          foundPos = pos;
          return false;
        }
        return true;
      });
      return foundPos;
    };

    const { editor, onClose } = await mountMenu(content, 0, { customPos: findInnerPos });

    fireEvent.click(screen.getByTestId('block-menu-duplicate'));

    expect(onClose).toHaveBeenCalled();
    const html = editor.getHTML();
    expect(html).toContain('<p>Inner content to duplicate</p><p>Inner content to duplicate</p>');
    const sectionCount = (html.match(/class="confluence-section"/g) || []).length;
    expect(sectionCount).toBe(1);
  });

  it('deletes one block inside a column when multiple blocks exist', async () => {
    const content = `
      <div class="confluence-section">
        <div class="confluence-column">
          <p>Block A</p>
          <p>Block B</p>
        </div>
      </div>
    `;

    const findBlockAPos = (editor: EditorType) => {
      let foundPos = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'paragraph' && node.textContent.includes('Block A')) {
          foundPos = pos;
          return false;
        }
        return true;
      });
      return foundPos;
    };

    const { editor, onClose } = await mountMenu(content, 0, { customPos: findBlockAPos });

    fireEvent.click(screen.getByTestId('block-menu-delete'));

    expect(onClose).toHaveBeenCalled();
    const html = editor.getHTML();
    expect(html).not.toContain('Block A');
    expect(html).toContain('Block B');
  });

  it('replaces with an empty paragraph when deleting the sole block in a column', async () => {
    const content = `
      <div class="confluence-section">
        <div class="confluence-column">
          <p>Only block</p>
        </div>
      </div>
    `;

    const findInnerPos = (editor: EditorType) => {
      let foundPos = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'paragraph' && node.textContent.includes('Only block')) {
          foundPos = pos;
          return false;
        }
        return true;
      });
      return foundPos;
    };

    const { editor, onClose } = await mountMenu(content, 0, { customPos: findInnerPos });

    fireEvent.click(screen.getByTestId('block-menu-delete'));

    expect(onClose).toHaveBeenCalled();
    const doc = editor.getJSON();
    const section = doc.content?.find((n) => n.type === 'confluenceSection');
    const col = section?.content?.[0];
    expect(col?.type).toBe('confluenceColumn');
    expect(col?.content?.length).toBe(1);
    expect(col?.content?.[0].type).toBe('paragraph');
  });

  it('renders table controls when targeting a table inside a column', async () => {
    const content = `
      <div class="confluence-section">
        <div class="confluence-column">
          <table data-layout="default">
            <tbody>
              <tr><th>Col 1</th></tr>
              <tr><td>Val 1</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    const findTablePos = (editor: EditorType) => {
      let foundPos = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'table') {
          foundPos = pos;
          return false;
        }
        return true;
      });
      return foundPos;
    };

    await mountMenu(content, 0, { customPos: findTablePos });

    expect(screen.getByTestId('block-table-toolbar')).toBeTruthy();
    expect(screen.getByTestId('table-toggle-header-row')).toBeTruthy();
    expect(screen.getByTestId('table-delete')).toBeTruthy();
  });
});

