import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Highlight } from '@tiptap/extension-highlight';
import type { Editor as EditorType } from '@tiptap/react';
import { useEffect } from 'react';

// Mock the SSE transport so "Improve" actions don't hit the network.
const streamSSE = vi.fn();
vi.mock('../../lib/sse', () => ({
  streamSSE: (...args: unknown[]) => streamSSE(...args),
}));

import { BubbleMenuContent, selectionShouldShow } from './EditorBubbleMenu';

function gen(chunks: Array<Record<string, unknown>>) {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

// jsdom has no layout engine, so ProseMirror's scroll-into-view (triggered by
// `.focus()` after insertContentAt) calls `getClientRects` on a DOM range and
// throws. Stub it to a no-op so the editor commands run cleanly under jsdom.
beforeAll(() => {
  if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  }
});

/**
 * Test harness: mounts a real TipTap editor, exposes it via a ref callback, and
 * renders the bubble-menu body directly (bypassing the Floating UI wrapper,
 * which does not render in jsdom). Using a real editor means formatting commands
 * and `insertContentAt` ranges are exercised against genuine ProseMirror state.
 */
function Harness({
  content,
  onReady,
}: {
  content: string;
  onReady: (editor: EditorType) => void;
}) {
  const editor = useEditor({
    extensions: [StarterKit, Highlight.configure({ multicolor: true })],
    content,
    immediatelyRender: false,
  });

  useEffect(() => {
    if (editor) onReady(editor);
  }, [editor, onReady]);

  if (!editor) return null;
  return (
    <>
      <EditorContent editor={editor} />
      <BubbleMenuContent editor={editor} />
    </>
  );
}

async function mountEditor(content: string): Promise<EditorType> {
  let editor: EditorType | null = null;
  render(<Harness content={content} onReady={(e) => { editor = e; }} />);
  await waitFor(() => expect(editor).not.toBeNull());
  return editor!;
}

describe('selectionShouldShow', () => {
  it('hides on an empty selection', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection(2); }); // collapsed
    expect(selectionShouldShow(editor, false)).toBe(false);
  });

  it('shows on a non-empty text selection', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });
    expect(selectionShouldShow(editor, false)).toBe(true);
  });

  it('hides inside a code block even with a selection', async () => {
    const editor = await mountEditor('<pre><code>const x = 1;</code></pre>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });
    expect(selectionShouldShow(editor, false)).toBe(false);
  });

  it('hides when the editor is not editable', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => {
      editor.setEditable(false);
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });
    expect(selectionShouldShow(editor, false)).toBe(false);
  });

  it('stays shown while the AI popover is open, regardless of selection', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection(2); }); // collapsed
    expect(selectionShouldShow(editor, true)).toBe(true);
  });
});

describe('BubbleMenuContent — formatting commands', () => {
  beforeEach(() => streamSSE.mockReset());

  it('toggles bold on the current selection', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.click(screen.getByTitle('Bold (Ctrl+B)'));
    expect(editor.getHTML()).toContain('<strong>Hello</strong>');
  });

  it('toggles italic on the current selection', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.click(screen.getByTitle('Italic (Ctrl+I)'));
    expect(editor.getHTML()).toContain('<em>Hello</em>');
  });

  it('toggles inline code on the current selection', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.click(screen.getByTitle('Inline code (Ctrl+E)'));
    expect(editor.getHTML()).toContain('<code>Hello</code>');
  });

  it('renders the AI Improve trigger', async () => {
    await mountEditor('<p>Hello world</p>');
    expect(screen.getByTestId('bubble-ai-trigger')).toBeInTheDocument();
  });
});

describe('BubbleMenuContent — inline AI improve replace-range', () => {
  beforeEach(() => streamSSE.mockReset());

  it('replaces ONLY the captured selection range with the improved fragment', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'Howdy' }]));
    const editor = await mountEditor('<p>Hello world</p>');
    // Select "Hello" (positions 1..6 in a single paragraph).
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    // Open the AI popover (captures the range), run an action, accept Replace.
    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    fireEvent.click(await screen.findByText('Improve writing'));

    await waitFor(() => expect(screen.getByTestId('bubble-ai-preview')).toHaveTextContent('Howdy'));

    fireEvent.click(screen.getByTitle('Replace selection'));

    await waitFor(() => {
      // Only "Hello" was replaced; " world" is preserved.
      expect(editor.getHTML()).toContain('Howdy world');
      expect(editor.getHTML()).not.toContain('Hello');
    });
  });

  it('inserts the improved fragment below without removing the original', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'Extra detail' }]));
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 12 }); }); // whole text

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    fireEvent.click(await screen.findByText('Make longer'));
    await waitFor(() => expect(screen.getByTestId('bubble-ai-preview')).toHaveTextContent('Extra detail'));

    fireEvent.click(screen.getByTitle('Insert below selection'));

    await waitFor(() => {
      const html = editor.getHTML();
      expect(html).toContain('Hello world'); // original kept
      expect(html).toContain('Extra detail'); // inserted
    });
  });

  it('sends only the selected text as content (no whole-page context)', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'x' }]));
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    fireEvent.click(await screen.findByText('Fix spelling & grammar'));

    await waitFor(() => expect(streamSSE).toHaveBeenCalled());
    const [, body] = streamSSE.mock.calls[0]!;
    expect((body as { content: string }).content).toBe('Hello');
    expect(body).not.toHaveProperty('pageId');
  });
});
