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

import {
  BubbleMenuContent,
  selectionShouldShow,
  editorBubbleMenuPluginKey,
} from './EditorBubbleMenu';
import { IMPROVE_DECORATION_CLASS } from './improve-decoration';

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

  it('stays shown while the AI section is open, regardless of selection', async () => {
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

describe('BubbleMenuContent — try-again replays the chosen action', () => {
  beforeEach(() => streamSSE.mockReset());

  it('replays the user-selected action, not the default "Improve writing"', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'Short.' }]));
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 12 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    // Run a NON-default action — "Make shorter" carries a distinctive instruction.
    fireEvent.click(await screen.findByText('Make shorter'));
    await waitFor(() => expect(screen.getByTestId('bubble-ai-preview')).toHaveTextContent('Short.'));

    const [, firstBody] = streamSSE.mock.calls[0]!;
    expect((firstBody as { instruction: string }).instruction).toContain('more concise');

    // Try again must replay the SAME action's instruction (not the default).
    streamSSE.mockReturnValue(gen([{ content: 'Shorter.' }]));
    fireEvent.click(screen.getByTitle('Try again'));

    await waitFor(() => expect(streamSSE).toHaveBeenCalledTimes(2));
    const [, secondBody] = streamSSE.mock.calls[1]!;
    expect((secondBody as { instruction: string }).instruction).toContain('more concise');
  });
});

describe('BubbleMenuContent — selection decoration lifecycle (#764)', () => {
  beforeEach(() => streamSSE.mockReset());

  const decorated = (editor: EditorType) =>
    editor.view.dom.querySelector(`.${IMPROVE_DECORATION_CLASS}`);

  it('decorates the captured range while the Improve section is open, without mutating the doc', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    expect(decorated(editor)).toBeNull();
    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));

    const el = decorated(editor);
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe('Hello');
    // The highlight is a view decoration, not a mark — document unchanged.
    expect(editor.getHTML()).toBe('<p>Hello world</p>');
  });

  it('clears the decoration when the AI section closes via Escape', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    expect(decorated(editor)).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(decorated(editor)).toBeNull());
    expect(editor.getHTML()).toBe('<p>Hello world</p>');
  });

  it('clears the decoration on Discard', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'Howdy' }]));
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    fireEvent.click(await screen.findByText('Improve writing'));
    await waitFor(() => expect(screen.getByTestId('bubble-ai-preview')).toHaveTextContent('Howdy'));
    expect(decorated(editor)).not.toBeNull();

    fireEvent.click(screen.getByTitle('Discard'));

    await waitFor(() => expect(decorated(editor)).toBeNull());
    expect(editor.getHTML()).toBe('<p>Hello world</p>'); // discarded, untouched
  });

  it('clears the decoration after Replace', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'Howdy' }]));
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    fireEvent.click(await screen.findByText('Improve writing'));
    await waitFor(() => expect(screen.getByTestId('bubble-ai-preview')).toHaveTextContent('Howdy'));

    fireEvent.click(screen.getByTitle('Replace selection'));

    await waitFor(() => expect(editor.getHTML()).toContain('Howdy world'));
    expect(decorated(editor)).toBeNull();
  });

  it('clears the decoration after Insert below', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'Extra detail' }]));
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 12 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    fireEvent.click(await screen.findByText('Make longer'));
    await waitFor(() => expect(screen.getByTestId('bubble-ai-preview')).toHaveTextContent('Extra detail'));

    fireEvent.click(screen.getByTitle('Insert below selection'));

    await waitFor(() => expect(editor.getHTML()).toContain('Extra detail'));
    expect(decorated(editor)).toBeNull();
  });

  it('keeps the decoration and Replace range glued to the passage after an unrelated doc change', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'Howdy' }]));
    const editor = await mountEditor('<p>Intro</p><p>Hello world</p>');
    // "Hello" in the second paragraph (p1 spans 0..7, p2 text starts at 8).
    act(() => { editor.commands.setTextSelection({ from: 8, to: 13 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    fireEvent.click(await screen.findByText('Improve writing'));
    await waitFor(() => expect(screen.getByTestId('bubble-ai-preview')).toHaveTextContent('Howdy'));

    // Unrelated edit earlier in the document while the popover is open —
    // shifts every later position by 4.
    act(() => { editor.view.dispatch(editor.state.tr.insertText('XYZ ', 1)); });

    // (a) the decoration set is remapped, so the highlight stays on "Hello".
    const el = decorated(editor);
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe('Hello');

    // (b) Replace acts on the remapped range, not the stale offsets captured
    // when the popover opened (those now point into "XYZ Intro").
    fireEvent.click(screen.getByTitle('Replace selection'));
    await waitFor(() => {
      const html = editor.getHTML();
      expect(html).toContain('<p>XYZ Intro</p>');
      expect(html).toContain('Howdy world');
      expect(html).not.toContain('Hello');
    });
  });
});

describe('BubbleMenuContent — single merged surface (#782)', () => {
  beforeEach(() => streamSSE.mockReset());

  it('expands the AI section INSIDE the bubble-menu container — no detached popover', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));

    const panel = await screen.findByTestId('bubble-ai-panel');
    // One container: the AI section is a child of the bubble menu, sharing its
    // single Floating UI anchor on the selection.
    expect(screen.getByTestId('editor-bubble-menu')).toContainElement(panel);
    // The old #764 layout portalled a Radix popover to <body> on the opposite
    // side of the selection — it must be gone.
    expect(screen.queryByTestId('bubble-ai-popover')).not.toBeInTheDocument();
    expect(document.querySelector('[data-radix-popper-content-wrapper]')).toBeNull();
  });

  it('marks the trigger expanded while open and collapses (clearing the decoration) on second click', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    const trigger = screen.getByTestId('bubble-ai-trigger');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(editor.view.dom.querySelector(`.${IMPROVE_DECORATION_CLASS}`)).not.toBeNull();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('bubble-ai-panel')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(editor.view.dom.querySelector(`.${IMPROVE_DECORATION_CLASS}`)).toBeNull();
    });
  });

  it('expands in place on Cmd/Ctrl+J', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.keyDown(document, { key: 'j', ctrlKey: true });

    const panel = await screen.findByTestId('bubble-ai-panel');
    expect(screen.getByTestId('editor-bubble-menu')).toContainElement(panel);
    expect(editor.view.dom.querySelector(`.${IMPROVE_DECORATION_CLASS}`)).not.toBeNull();
  });

  it('focuses the prompt input on open while the menu stays mounted (focus-retention, #764)', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));

    const input = await screen.findByLabelText('Ask AI to edit the selection');
    expect(input).toHaveFocus();
    // The editor lost focus to the input, but the shouldShow contract keeps
    // the (single) panel mounted while the AI section is open.
    expect(selectionShouldShow(editor, true)).toBe(true);
    expect(screen.getByTestId('editor-bubble-menu')).toBeInTheDocument();
  });

  it('collapses and clears the decoration on outside pointerdown', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    await screen.findByTestId('bubble-ai-panel');

    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(screen.queryByTestId('bubble-ai-panel')).not.toBeInTheDocument();
    });
    expect(editor.view.dom.querySelector(`.${IMPROVE_DECORATION_CLASS}`)).toBeNull();
    expect(editor.getHTML()).toBe('<p>Hello world</p>'); // never mutated
  });

  it('does NOT collapse on pointerdown inside the panel (e.g. quick actions, toolbar row)', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    const panel = await screen.findByTestId('bubble-ai-panel');

    fireEvent.pointerDown(panel);
    fireEvent.pointerDown(screen.getByTitle('Bold (Ctrl+B)'));

    expect(screen.getByTestId('bubble-ai-panel')).toBeInTheDocument();
  });
});

describe('BubbleMenuContent — Floating UI repositioning on panel growth (#782)', () => {
  beforeEach(() => streamSSE.mockReset());

  /** Collect `updatePosition` requests dispatched to the BubbleMenu plugin. */
  function trackPositionUpdates(editor: EditorType): { count: () => number } {
    let n = 0;
    editor.on('transaction', ({ transaction }) => {
      if (transaction.getMeta(editorBubbleMenuPluginKey) === 'updatePosition') n += 1;
    });
    return { count: () => n };
  }

  it('requests a position update when the AI section expands', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    const updates = trackPositionUpdates(editor);
    const before = updates.count();
    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));

    // The plugin only repositions on selection/doc/scroll/resize by itself —
    // expanding the panel must explicitly ask Floating UI to recompute so the
    // grown container is re-anchored (flip/shift re-evaluate) instead of
    // growing over the decorated selection.
    await waitFor(() => expect(updates.count()).toBeGreaterThan(before));
  });

  it('requests position updates as streamed content grows the preview', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'How' }, { content: 'dy' }]));
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    const updates = trackPositionUpdates(editor);
    const before = updates.count();

    fireEvent.click(await screen.findByText('Improve writing'));
    await waitFor(() => expect(screen.getByTestId('bubble-ai-preview')).toHaveTextContent('Howdy'));

    await waitFor(() => expect(updates.count()).toBeGreaterThan(before));
  });
});

describe('BubbleMenuContent — error state', () => {
  beforeEach(() => streamSSE.mockReset());

  it('surfaces the stream error with retry, inside the merged panel', async () => {
    streamSSE.mockReturnValue(gen([{ error: 'LLM unavailable' }]));
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    fireEvent.click(await screen.findByText('Improve writing'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('LLM unavailable');
    expect(screen.getByTestId('editor-bubble-menu')).toContainElement(alert);

    // Retry from the error state streams again into the same panel.
    streamSSE.mockReturnValue(gen([{ content: 'Recovered' }]));
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(screen.getByTestId('bubble-ai-preview')).toHaveTextContent('Recovered'));
  });
});

describe('BubbleMenuContent — empty result feedback', () => {
  beforeEach(() => streamSSE.mockReset());

  it('shows a "No changes returned" state instead of silently reverting', async () => {
    // Stream completes but yields nothing.
    streamSSE.mockReturnValue(gen([]));
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    fireEvent.click(await screen.findByText('Improve writing'));

    const empty = await screen.findByTestId('bubble-ai-empty');
    expect(empty).toHaveTextContent(/No changes returned/i);
    // The quick-action menu must NOT be shown in the empty state.
    expect(screen.queryByText('Fix spelling & grammar')).not.toBeInTheDocument();
  });
});
