import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Highlight } from '@tiptap/extension-highlight';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import type { Editor as EditorType } from '@tiptap/react';
import { useEffect } from 'react';

// Mock the SSE transport so "Improve" actions don't hit the network.
const streamSSE = vi.fn();
vi.mock('../../lib/sse', () => ({
  streamSSE: (...args: unknown[]) => streamSSE(...args),
}));

import {
  BubbleMenuContent,
  EditorBubbleMenu,
  improvePanelPlacement,
  selectionShouldShow,
  editorBubbleMenuPluginKey,
} from './EditorBubbleMenu';
import {
  ConfluenceJiraIssue,
  ConfluenceStatus,
  ConfluenceUserMention,
} from './article-extensions';
import { IMPROVE_DECORATION_CLASS } from './improve-decoration';
import {
  clearBlockMenuTarget,
  createBlockMenuTargetPlugin,
  setBlockMenuTarget,
} from './block-menu-decoration';

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
    extensions: [
      StarterKit,
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      // The REAL inline Confluence atoms. The macro guard below is about these
      // exact node types — a hand-rolled stand-in would prove nothing about the
      // schema the editor actually runs. They are inert for every other test in
      // this file, which never puts one in the document.
      ConfluenceStatus,
      ConfluenceUserMention,
      ConfluenceJiraIssue,
    ],
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

  // #1179 — the block context menu selects the whole block's content to run
  // the same actions. That selection is non-empty, so without this the bubble
  // menu would render a second panel on top of the block menu.
  describe('while the block context menu owns the interaction', () => {
    it('hides even though the selection is non-empty', async () => {
      const editor = await mountEditor('<p>Hello world</p>');
      act(() => {
        editor.registerPlugin(createBlockMenuTargetPlugin());
        editor.commands.setTextSelection({ from: 1, to: 6 });
      });
      expect(selectionShouldShow(editor, false)).toBe(true);

      act(() => { setBlockMenuTarget(editor, 0); });
      expect(selectionShouldShow(editor, false)).toBe(false);
    });

    it('hides even with its own AI section open', async () => {
      const editor = await mountEditor('<p>Hello world</p>');
      act(() => {
        editor.registerPlugin(createBlockMenuTargetPlugin());
        setBlockMenuTarget(editor, 0);
      });
      expect(selectionShouldShow(editor, true)).toBe(false);
    });

    it('comes back once the block menu closes', async () => {
      const editor = await mountEditor('<p>Hello world</p>');
      act(() => {
        editor.registerPlugin(createBlockMenuTargetPlugin());
        editor.commands.setTextSelection({ from: 1, to: 6 });
        setBlockMenuTarget(editor, 0);
      });
      expect(selectionShouldShow(editor, false)).toBe(false);

      act(() => { clearBlockMenuTarget(editor); });
      expect(selectionShouldShow(editor, false)).toBe(true);
    });

    it('is unaffected on an editor that never registered the marker plugin', async () => {
      const editor = await mountEditor('<p>Hello world</p>');
      act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });
      expect(selectionShouldShow(editor, false)).toBe(true);
    });
  });
});

describe('improvePanelPlacement', () => {
  it('keeps the Improve controls below the toolbar by default when the menu is below the selection', () => {
    expect(improvePanelPlacement(
      { top: 220, bottom: 320 },
      { top: 160, bottom: 200 },
    )).toBe('below');
  });

  it('moves the Improve controls above the toolbar after the menu flips above the selection', () => {
    expect(improvePanelPlacement(
      { top: 40, bottom: 140 },
      { top: 160, bottom: 200 },
    )).toBe('above');
  });

  it('keeps the default downward disclosure for an ambiguous shifted overlap', () => {
    expect(improvePanelPlacement(
      { top: 80, bottom: 180 },
      { top: 160, bottom: 200 },
    )).toBe('below');
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

  it('exposes the same color picker as the toolbar', async () => {
    await mountEditor('<p>Hello world</p>');
    expect(screen.getByTestId('color-picker-trigger')).toBeInTheDocument();
  });

  it('keeps color when the selection is also bold', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });
    fireEvent.click(screen.getByTitle('Bold (Ctrl+B)'));
    fireEvent.click(screen.getByTestId('color-picker-trigger'));
    fireEvent.click(screen.getByLabelText('Red text'));
    expect(editor.getHTML()).toContain('rgb(239, 68, 68)');
    expect(editor.getHTML()).toContain('<strong>');
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

  // #1179 made this a single click: the block menu can delete the very block
  // an open AI section is improving. The decoration goes with it and the
  // captured offsets then point past the end of a shorter document, which
  // `insertContentAt` would throw on.
  it('refuses to replace when the passage was deleted while the section was open', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'Improved' }]));
    const editor = await mountEditor('<p>Hello world</p><p>Second paragraph here</p>');
    const secondStart = editor.state.doc.child(0).nodeSize + 1;
    act(() => {
      editor.commands.setTextSelection({ from: secondStart, to: secondStart + 20 });
    });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    fireEvent.click(await screen.findByText('Improve writing'));
    await waitFor(() => expect(screen.getByTitle('Replace selection')).not.toBeDisabled());

    // The passage disappears out from under the open section.
    act(() => { editor.commands.setContent('<p>Hi</p>'); });

    // The captured offsets now point past the end of the document. Without the
    // clamp `insertContentAt` throws a RangeError out of the click handler —
    // which React reports asynchronously, so assert on the error rather than
    // relying on it surfacing as a test failure.
    const errors: string[] = [];
    const onError = (e: ErrorEvent) => { errors.push(e.message); e.preventDefault(); };
    window.addEventListener('error', onError);
    try {
      fireEvent.click(screen.getByTitle('Replace selection'));
    } finally {
      window.removeEventListener('error', onError);
    }

    expect(errors).toEqual([]);
    expect(editor.getHTML()).toBe('<p>Hi</p>');
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

  it('does NOT collapse on Escape targeted at a foreign overlay (e.g. a dialog stacked above)', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    await screen.findByTestId('bubble-ai-panel');

    // A modal portalled to <body> above the editor — its Escape must close the
    // modal, not also collapse the AI section underneath.
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const dialogInput = document.createElement('input');
    dialog.appendChild(dialogInput);
    document.body.appendChild(dialog);
    try {
      fireEvent.keyDown(dialogInput, { key: 'Escape' });

      expect(screen.getByTestId('bubble-ai-panel')).toBeInTheDocument();
      expect(editor.view.dom.querySelector(`.${IMPROVE_DECORATION_CLASS}`)).not.toBeNull();
    } finally {
      dialog.remove();
    }
  });

  it('does NOT collapse on an Escape a higher-priority handler already consumed (defaultPrevented)', async () => {
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    await screen.findByTestId('bubble-ai-panel');

    // Simulate an overlay's capture-phase handler claiming the Escape before
    // our document-level listener sees it.
    const consume = (e: KeyboardEvent) => { if (e.key === 'Escape') e.preventDefault(); };
    document.addEventListener('keydown', consume, { capture: true });
    try {
      fireEvent.keyDown(document.body, { key: 'Escape' });

      expect(screen.getByTestId('bubble-ai-panel')).toBeInTheDocument();
      expect(editor.view.dom.querySelector(`.${IMPROVE_DECORATION_CLASS}`)).not.toBeNull();
    } finally {
      document.removeEventListener('keydown', consume, { capture: true });
    }
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

  it('coalesces per-chunk reposition requests into one animation frame (no dispatch per SSE chunk)', async () => {
    streamSSE.mockReturnValue(gen([
      { content: 'How' }, { content: 'dy ' }, { content: 'part' }, { content: 'ner' },
    ]));
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    await screen.findByTestId('bubble-ai-panel');
    // Let any reposition frame scheduled by opening the panel fire before
    // stubbing rAF (frame callbacks run in registration order, so awaiting a
    // fresh frame guarantees earlier ones have run).
    await act(async () => {
      await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    });

    // Deterministic rAF: frames only run when flushed manually.
    const pendingFrames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextFrameId++;
      pendingFrames.set(id, cb);
      return id;
    });
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      pendingFrames.delete(id);
    });

    try {
      const updates = trackPositionUpdates(editor);
      fireEvent.click(screen.getByText('Improve writing'));
      await waitFor(() => expect(screen.getByTestId('bubble-ai-preview')).toHaveTextContent('Howdy partner'));

      // Only the immediate (layout-effect) path dispatched so far: one for
      // idle→streaming and one for streaming→done. The four chunks did NOT
      // dispatch per-chunk transactions.
      await waitFor(() => expect(updates.count()).toBe(2));

      // The four output changes coalesced into a single pending frame
      // (earlier frames were cancelled on re-schedule).
      expect(pendingFrames.size).toBe(1);

      act(() => {
        const frames = [...pendingFrames.values()];
        pendingFrames.clear();
        for (const cb of frames) cb(performance.now());
      });
      // The coalesced frame dispatched exactly one position update.
      expect(updates.count()).toBe(3);
    } finally {
      raf.mockRestore();
      caf.mockRestore();
    }
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

// The same defect #1179 fixed on the block menu, reached through the more-used
// surface. `doc.textBetween` skips inline atoms, so the model is sent
// "Ask  about it" for a paragraph reading "Ask @jdoe about it", and Replace
// overwrites the range those atoms live in — the mention is gone and the next
// Save pushes the loss to Confluence.
describe('BubbleMenuContent — inline macros in the selection', () => {
  beforeEach(() => streamSSE.mockReset());

  const WITH_MENTION =
    '<p>Ask <span class="confluence-user-mention" data-username="jdoe">@jdoe</span> about it</p>';
  const WITH_STATUS =
    '<p>Release <span class="confluence-status" data-color="green">DONE</span> now</p>';
  const WITH_JIRA =
    '<p>See <span class="confluence-jira-issue" data-key="KB-42">KB-42</span> for details</p>';

  function countType(editor: EditorType, name: string): number {
    let n = 0;
    editor.state.doc.descendants((node) => { if (node.type.name === name) n += 1; });
    return n;
  }

  /** The whole of the first paragraph's inline content. */
  const wholeParagraph = (editor: EditorType) => ({
    from: 1,
    to: editor.state.doc.child(0).nodeSize - 1,
  });

  const selectAll = (editor: EditorType) => {
    act(() => { editor.commands.setTextSelection(wholeParagraph(editor)); });
  };

  it.each([
    ['a user mention', WITH_MENTION, 'confluenceUserMention'],
    ['a status macro', WITH_STATUS, 'confluenceStatus'],
    ['a Jira issue macro', WITH_JIRA, 'confluenceJiraIssue'],
  ])('hides Improve when the selection contains %s', async (_name, content, type) => {
    const editor = await mountEditor(content);
    expect(countType(editor, type)).toBe(1);

    selectAll(editor);

    expect(screen.queryByTestId('bubble-ai-trigger')).toBeNull();
    expect(screen.getByTestId('bubble-menu-macro-notice')).toHaveTextContent(
      /a rewrite would drop the inline macros in this selection/i,
    );
  });

  // The negative control. A selection with nothing structured in it must reach
  // the model and write back exactly as it did before this guard existed.
  it('leaves an ordinary selection untouched — trigger, run and Replace all unchanged', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'Howdy' }]));
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });

    expect(screen.getByTestId('bubble-ai-trigger')).toBeInTheDocument();
    expect(screen.queryByTestId('bubble-menu-macro-notice')).toBeNull();

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    fireEvent.click(await screen.findByText('Improve writing'));
    await waitFor(() => expect(screen.getByTestId('bubble-ai-preview')).toHaveTextContent('Howdy'));
    expect(screen.queryByTestId('bubble-ai-replace-blocked')).toBeNull();

    fireEvent.click(screen.getByTitle('Replace selection'));
    await waitFor(() => expect(editor.getHTML()).toContain('Howdy world'));
  });

  // The remedy the copy promises, proved end to end. `nodesBetween` does not
  // visit a node whose start equals `to`, so a range that stops at the atom is
  // genuinely clean — Improve comes back, the model gets the prose, and the
  // mention survives the write-back.
  it('offers Improve again for a selection that stops short of the macro', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'Please ask' }]));
    const editor = await mountEditor(WITH_MENTION);
    // "Ask " — positions 1..5; the mention atom begins at 5.
    act(() => { editor.commands.setTextSelection({ from: 1, to: 5 }); });

    expect(screen.queryByTestId('bubble-menu-macro-notice')).toBeNull();
    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    fireEvent.click(await screen.findByText('Improve writing'));

    await waitFor(() => expect(streamSSE).toHaveBeenCalled());
    expect((streamSSE.mock.calls[0]![1] as { content: string }).content).toBe('Ask ');
    await waitFor(() => expect(screen.getByTestId('bubble-ai-preview')).toHaveTextContent('Please ask'));

    fireEvent.click(screen.getByTitle('Replace selection'));

    await waitFor(() => expect(editor.getHTML()).toContain('Please ask'));
    expect(countType(editor, 'confluenceUserMention')).toBe(1);
    expect(editor.getHTML()).toContain('data-username="jdoe"');
  });

  // Cmd/Ctrl+J never touches the trigger, so hiding the button alone would
  // leave the keyboard route opening a section that can only lose the macro.
  it('refuses Cmd/Ctrl+J on a selection that carries a macro', async () => {
    const editor = await mountEditor(WITH_MENTION);
    selectAll(editor);

    fireEvent.keyDown(document, { key: 'j', ctrlKey: true });

    expect(screen.queryByTestId('bubble-ai-panel')).not.toBeInTheDocument();
    expect(editor.view.dom.querySelector(`.${IMPROVE_DECORATION_CLASS}`)).toBeNull();
    expect(streamSSE).not.toHaveBeenCalled();
  });

  it('still offers formatting, which rewrites marks and leaves the atoms alone', async () => {
    const editor = await mountEditor(WITH_MENTION);
    selectAll(editor);

    fireEvent.click(screen.getByTitle('Bold (Ctrl+B)'));

    expect(editor.getHTML()).toContain('<strong>');
    expect(countType(editor, 'confluenceUserMention')).toBe(1);
  });

  // A `<br>` is an inline atom by ProseMirror's reckoning but not Confluence
  // content — withholding Improve from every paragraph carrying one would gut
  // the feature, which is why the predicate excludes it.
  it('does not withhold Improve for a hard break', async () => {
    const editor = await mountEditor('<p>First line<br>second line</p>');
    selectAll(editor);

    expect(screen.getByTestId('bubble-ai-trigger')).toBeInTheDocument();
    expect(screen.queryByTestId('bubble-menu-macro-notice')).toBeNull();
  });
});

// `containsStructuredInline` matches ANY inline node that is not text and not a
// hardBreak — it does not name the three Confluence atoms. That is deliberate
// (an unknown inline atom is exactly as lossy), but it couples the copy to the
// schema: MACRO_NOTICE says "inline macros", so a fourth inline node added
// later would silently start withholding Improve under a message that no longer
// describes why. Today the coupling holds, and this is what says so.
describe('the predicate matches exactly what the copy claims', () => {
  it('has no inline node in the article schema beyond the three named macros', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    const source = readFileSync(resolve(__dirname, 'article-extensions.ts'), 'utf-8');
    // Split on the definition boundary first. A single regex spanning from a
    // `name:` to an `inline: true` runs straight past the end of its own node
    // and pairs a name with a LATER node's flag.
    const inlineNodes = source
      .split(/\bNode\.create\(/)
      .slice(1)
      .map((definition) => ({
        name: definition.match(/name:\s*'([^']+)'/)?.[1],
        inline: /^\s*inline:\s*true/m.test(definition),
      }))
      .filter((d) => d.inline && d.name)
      .map((d) => d.name);

    expect(new Set(inlineNodes)).toEqual(
      new Set(['confluenceStatus', 'confluenceJiraIssue', 'confluenceUserMention']),
    );
    // The one inline node that would NOT be a macro is configured out of the
    // group on purpose; `Editor.tsx` passes `inline: false`.
    const editor = readFileSync(resolve(__dirname, 'Editor.tsx'), 'utf-8');
    expect(editor).toMatch(/ConfluenceImage\.configure\(\{\s*inline:\s*false\s*\}\)/);
  });
});

// The gate above runs when Improve opens. A macro can still arrive inside the
// captured passage afterwards — an undo, a collaborator, the AI dock — and the
// decoration widens to include it, so Replace would delete it.
describe('BubbleMenuContent — a macro arriving in an already-open section', () => {
  beforeEach(() => streamSSE.mockReset());

  function countMentions(editor: EditorType): number {
    let n = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'confluenceUserMention') n += 1;
    });
    return n;
  }

  /** Drop a mention into the middle of "Hello world" (inside the captured range). */
  function insertMention(editor: EditorType): void {
    const mention = editor.schema.nodes.confluenceUserMention!.create({
      username: 'jdoe',
      label: '@jdoe',
    });
    editor.view.dispatch(editor.state.tr.insert(6, mention));
  }

  /** Open the section over the whole paragraph and stream an answer into it. */
  async function openWithAnswer(): Promise<EditorType> {
    streamSSE.mockReturnValue(gen([{ content: 'Howdy everyone' }]));
    const editor = await mountEditor('<p>Hello world</p>');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 12 }); });

    fireEvent.click(screen.getByTestId('bubble-ai-trigger'));
    fireEvent.click(await screen.findByText('Improve writing'));
    await waitFor(() => expect(screen.getByTitle('Replace selection')).not.toBeDisabled());
    return editor;
  }

  it('refuses Replace and says why, keeping the trigger as the collapse control', async () => {
    const editor = await openWithAnswer();

    act(() => { insertMention(editor); });

    expect(screen.getByTestId('bubble-ai-replace-blocked')).toHaveTextContent(
      /replacing would delete it/i,
    );
    expect(screen.getByTitle(/replacing would delete it/i)).toBeDisabled();
    // The panel is open, so the trigger stays: it is the only way to collapse
    // the section, and `aria-controls` must keep pointing at a live panel.
    expect(screen.getByTestId('bubble-ai-trigger')).toHaveAttribute('aria-expanded', 'true');
  });

  it('leaves Insert below available, which preserves the macro', async () => {
    const editor = await openWithAnswer();

    act(() => { insertMention(editor); });
    fireEvent.click(screen.getByTitle('Insert below selection'));

    await waitFor(() => expect(editor.getHTML()).toContain('Howdy everyone'));
    expect(countMentions(editor)).toBe(1);
  });

  // The render gate is a React value, so a transaction landing between the last
  // paint and the click leaves it a frame stale — and one frame is all it takes
  // to delete a mention. Nesting both inside a single `act` reproduces exactly
  // that interleaving: the update is queued, the still-enabled button fires,
  // and only the document-derived check in `replaceSelection` can refuse.
  it('refuses Replace when the macro lands between the last render and the click', async () => {
    const editor = await openWithAnswer();
    const replace = screen.getByTitle('Replace selection');

    act(() => {
      insertMention(editor);
      fireEvent.click(replace);
    });

    expect(countMentions(editor)).toBe(1);
    expect(editor.getHTML()).toContain('Hello');
    expect(editor.getHTML()).not.toContain('Howdy everyone');
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

describe('EditorBubbleMenu — update loop prevention (#cpu)', () => {
  function BubbleHarness({ onReady }: { onReady: (e: EditorType) => void }) {
    const editor = useEditor({
      extensions: [StarterKit],
      content: '<p>Sample document</p>',
      immediatelyRender: false,
    });

    useEffect(() => {
      if (editor) onReady(editor);
    }, [editor, onReady]);

    if (!editor) return null;
    return (
      <>
        <EditorContent editor={editor} />
        <EditorBubbleMenu editor={editor} />
      </>
    );
  }

  it('does not continuously dispatch updateOptions transactions when idle', async () => {
    let editor: EditorType | null = null;
    let updateCount = 0;

    render(<BubbleHarness onReady={(e) => {
      editor = e;
      e.on('transaction', ({ transaction }) => {
        const meta = transaction.getMeta(editorBubbleMenuPluginKey);
        if (meta && typeof meta === 'object' && (meta as { type?: string }).type === 'updateOptions') {
          updateCount += 1;
        }
      });
    }} />);

    await waitFor(() => expect(editor).not.toBeNull());

    // Give React and ProseMirror a window to settle.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Must be 0 (no extra transactions triggered by unmemoized options prop changes).
    expect(updateCount).toBe(0);
  });
});

