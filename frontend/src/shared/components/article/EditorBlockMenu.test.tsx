import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Highlight } from '@tiptap/extension-highlight';
import type { Editor as EditorType } from '@tiptap/react';

// Mock the SSE transport so "Improve" never hits the network. Capturing the
// abort signal is how the unmount-abort contract is asserted below.
const streamSSE = vi.fn();
vi.mock('../../lib/sse', () => ({
  streamSSE: (...args: unknown[]) => streamSSE(...args),
}));

import { EditorBlockMenu } from './EditorBlockMenu';
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
}: {
  content: string;
  blockIndex: number;
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
      Highlight.configure({ multicolor: true }),
      DrawioDiagram,
    ],
    content,
    immediatelyRender: false,
  });
  const [target, setTarget] = useState<Target | null>(null);

  useEffect(() => {
    if (!editor) return;
    // Mirrors what `EditorBlockHandle` does on right-click: register the marker
    // plugin, then mark the block the pointer was over.
    editor.registerPlugin(createBlockMenuTargetPlugin());
    const pos = topLevelPos(editor, blockIndex);
    setBlockMenuTarget(editor, pos);
    setTarget({ pos });
    onReady(editor);
    return () => { editor.unregisterPlugin(blockMenuTargetKey); };
  }, [editor, blockIndex, onReady]);

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
  blockIndex: number;
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
  extra: { trailingNode?: boolean } = {},
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

  it('offers formatting, Improve and Delete', async () => {
    await mountMenu('<p>Hello world</p>');
    expect(screen.getByRole('toolbar', { name: 'Block formatting' })).toBeTruthy();
    expect(screen.getByTitle('Bold (Ctrl+B)')).toBeTruthy();
    expect(screen.getByTestId('block-ai-trigger')).toBeTruthy();
    expect(screen.getByTestId('block-menu-delete')).toBeTruthy();
  });

  it('formats the WHOLE block, not wherever the caret happens to be', async () => {
    const { editor } = await mountMenu('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection(2); }); // a collapsed caret

    fireEvent.click(screen.getByTitle('Bold (Ctrl+B)'));

    expect(editor.getHTML()).toBe('<p><strong>Hello world</strong></p>');
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

  it('leaves an empty paragraph when the last remaining block is deleted', async () => {
    // `doc` is `block+`: emptying it outright is an invalid document.
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

  it('deletes the right block after the document shifted above it', async () => {
    // The snapshotted `pos` is stale the moment anything above the block
    // changes; the marker decoration is what keeps the target correct.
    const { editor } = await mountMenu('<p>First</p><p>Remove</p>', 1);

    act(() => { editor.commands.insertContentAt(1, 'PREFIX '); });
    fireEvent.click(screen.getByTestId('block-menu-delete'));

    expect(editor.getHTML()).toBe('<p>PREFIX First</p>');
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
