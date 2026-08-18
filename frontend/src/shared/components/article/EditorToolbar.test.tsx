import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { Editor as EditorType } from '@tiptap/react';
import { EditorToolbar } from './EditorToolbar';

/**
 * The toolbar's own contract, after the 31-icon flat row became twelve
 * controls (#353's grouping, restructured).
 *
 * The point of these tests is coverage-of-capability: the restructure moved
 * actions behind menus, and the one way that goes wrong is an action quietly
 * failing to arrive on the other side. So the Insert menu is asserted item by
 * item against the list the flat row used to carry.
 */

/**
 * Minimal TipTap stand-in. `isActive` is overridable per test so the block-type
 * trigger and the mark toggles can be driven without a real document.
 */
function createMockEditor(overrides: Partial<Record<string, unknown>> = {}): EditorType {
  const chainProxy: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      if (prop === 'run') return vi.fn();
      return () => chainProxy;
    },
  });
  return {
    chain: () => chainProxy,
    can: () => new Proxy({}, { get: () => () => true }),
    isActive: () => false,
    getAttributes: () => ({}),
    state: { selection: { from: 0 }, doc: { nodeAt: () => null } },
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  } as unknown as EditorType;
}

/** Radix menus open on pointerdown; fire click too so either primitive works. */
function open(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

const openInsertMenu = () => open(screen.getByTestId('insert-menu-trigger'));
const openBlockMenu = () => open(screen.getByTestId('block-type-trigger'));

describe('EditorToolbar', () => {
  it('exposes the toolbar landmark with an accessible name', () => {
    render(<EditorToolbar editor={createMockEditor()} />);
    expect(screen.getByRole('toolbar', { name: 'Page editor toolbar' })).toBeInTheDocument();
  });

  it('keeps page properties out of the session-actions group', () => {
    render(
      <EditorToolbar
        editor={createMockEditor()}
        pageProperty={<button type="button">Add tags</button>}
        actions={<button type="button">Save</button>}
      />,
    );
    const properties = screen.getByRole('group', { name: 'Page properties' });
    const actions = screen.getByRole('group', { name: 'Page actions' });
    expect(properties).toHaveTextContent('Add tags');
    expect(actions).toHaveTextContent('Save');
    expect(properties).not.toContainElement(screen.getByRole('button', { name: 'Save' }));
  });

  it('presents eighteen main controls plus utilities', () => {
    render(<EditorToolbar editor={createMockEditor()} onToggleHeaderNumbering={vi.fn()} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Page editor toolbar' });
    // 18 = (block type + quote + code block + divider) + 5 marks + 1 align dropdown + 3 lists + 1 colour + 1 emoji + Insert + undo + redo
    expect(toolbar.querySelectorAll('button').length).toBe(18);
  });

  it('renders the groups in the restructured order', () => {
    render(<EditorToolbar editor={createMockEditor()} />);
    const groups = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="toolbar-group-"]'),
    ).map((el) => el.dataset.testid);

    // First choose the block, then shape text. Color sits with lists so it
    // is immediately left of the bullet list; block-level actions follow.
    expect(groups).toEqual([
      'toolbar-group-history',
      'toolbar-group-block-type',
      'toolbar-group-inline',
      'toolbar-group-lists',
      'toolbar-group-block-actions',
      'toolbar-group-insert',
    ]);
  });

  it('sits the colour picker immediately left of the bullet list', () => {
    render(<EditorToolbar editor={createMockEditor()} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Page editor toolbar' });
    const buttons = Array.from(toolbar.querySelectorAll('button'));
    const colorIdx = buttons.findIndex((b) => b.getAttribute('data-testid') === 'color-picker-trigger');
    const bulletIdx = buttons.findIndex((b) => b.getAttribute('aria-label') === 'Bullet List (Ctrl+Shift+8)');
    expect(colorIdx).toBeGreaterThan(-1);
    expect(bulletIdx).toBe(colorIdx + 1);
  });

  it('gives every icon-only control a real aria-label, not just a tooltip', () => {
    // `title` is only the last fallback in the accessible-name computation and
    // is not surfaced by every screen reader or on touch at all.
    render(<EditorToolbar editor={createMockEditor()} onToggleHeaderNumbering={vi.fn()} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Page editor toolbar' });
    for (const btn of Array.from(toolbar.querySelectorAll('button'))) {
      expect(btn.getAttribute('aria-label')?.trim()).toBeTruthy();
    }
  });

  it('makes the toolbar a single tab stop', () => {
    render(<EditorToolbar editor={createMockEditor()} onToggleHeaderNumbering={vi.fn()} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Page editor toolbar' });
    const stops = Array.from(toolbar.querySelectorAll<HTMLElement>('button')).filter(
      (b) => b.tabIndex === 0,
    );
    expect(stops.length).toBe(1);
  });

  // ---------- block-type control ----------

  it('reads the caret’s block back in words', () => {
    // The flat row showed heading state only as "which of three icons is lit".
    const editor = createMockEditor({
      isActive: (name: string, attrs?: { level?: number }) =>
        name === 'heading' && attrs?.level === 2,
    });
    render(<EditorToolbar editor={editor} />);
    expect(screen.getByTestId('block-type-trigger')).toHaveTextContent('Heading 2');
  });

  it('falls back to Text rather than blanking out', () => {
    render(<EditorToolbar editor={createMockEditor()} />);
    expect(screen.getByTestId('block-type-trigger')).toHaveTextContent('Text');
  });

  it('highlights the Quote toggle when inside a blockquote', () => {
    const editor = createMockEditor({
      isActive: (name: string) => name === 'blockquote' || name === 'paragraph',
    });
    render(<EditorToolbar editor={editor} />);
    expect(screen.getByRole('button', { name: 'Quote' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('block-type-trigger')).toHaveTextContent('Text');
  });

  it('offers headings, text, quote, and code block in the dropdown, with Quote, Code block, and Divider on the toolbar', () => {
    render(<EditorToolbar editor={createMockEditor()} />);
    // Check toolbar buttons outside dropdown
    expect(screen.getByRole('button', { name: 'Quote' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Code Block' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Divider' })).toBeInTheDocument();

    openBlockMenu();
    // Check dropdown options
    for (const label of ['Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Quote', 'Code block']) {
      expect(screen.getByRole('menuitem', { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
  });

  it('runs block quote, code block, and divider commands when toolbar buttons are clicked', () => {
    const run = vi.fn();
    const chain: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
      get(_t, prop: string) {
        if (prop === 'run') return run;
        return () => chain;
      },
    });
    const editor = createMockEditor({ chain: () => chain });
    render(<EditorToolbar editor={editor} />);

    fireEvent.click(screen.getByRole('button', { name: 'Quote' }));
    expect(run).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Code Block' }));
    expect(run).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Divider' }));
    expect(run).toHaveBeenCalled();
  });

  it('runs setTextAlign when alignment buttons are clicked', () => {
    const run = vi.fn();
    const chain: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
      get(_t, prop: string) {
        if (prop === 'run') return run;
        return () => chain;
      },
    });
    const editor = createMockEditor({ chain: () => chain });
    render(<EditorToolbar editor={editor} />);

    const trigger = screen.getByTestId('align-menu-trigger');
    open(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Align Left' }));
    expect(run).toHaveBeenCalled();

    open(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Align Center' }));
    expect(run).toHaveBeenCalled();

    open(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Align Right' }));
    expect(run).toHaveBeenCalled();

    open(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Justify' }));
    expect(run).toHaveBeenCalled();
  });

  it('runs setHeading when a heading option is chosen', () => {
    const run = vi.fn();
    const setHeading = vi.fn();
    const chain: Record<string, unknown> = new Proxy({ setHeading } as Record<string, unknown>, {
      get(target, prop: string) {
        if (prop === 'setHeading') return target.setHeading;
        if (prop === 'run') return run;
        return () => chain;
      },
    });
    setHeading.mockReturnValue(chain);
    const editor = createMockEditor({ chain: () => chain });
    render(<EditorToolbar editor={editor} />);
    openBlockMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /^Heading 4/ }));
    expect(setHeading).toHaveBeenCalledWith({ level: 4 });
    expect(run).toHaveBeenCalled();
  });

  // ---------- insert menu ----------

  it('carries every insert the flat row had', () => {
    // Coverage-of-capability. Panel and Column layout are submenu triggers, so
    // they are asserted by their own role.
    render(<EditorToolbar editor={createMockEditor()} />);
    openInsertMenu();

    for (const label of [
      'Table',
      'Image…',
      'Diagram',
      'Mermaid diagram',
      'Status label…',
      'Emoji…',
      'Quote',
      'Code block',
      'Divider',
      'Expand section',
      'Attachments',
      'Child pages',
      'Caption for selected image',
      'Table caption',
      'List of figures',
      'List of tables',
    ]) {
      expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
    }

    expect(screen.getByText('Panel')).toBeInTheDocument();
    expect(screen.getByText('Column layout')).toBeInTheDocument();

    // Folded formatting stays out of Insert until the toolbar is actually narrow.
    expect(screen.queryByRole('menuitem', { name: 'Strikethrough' })).toBeNull();
  });

  it('distinguishes "List of figures" from "Child pages"', () => {
    // The flat row gave them the same ListTree glyph and no label at all.
    render(<EditorToolbar editor={createMockEditor()} />);
    openInsertMenu();

    const figures = screen.getByRole('menuitem', { name: 'List of figures' });
    const children = screen.getByRole('menuitem', { name: 'Child pages' });
    const glyph = (el: HTMLElement) => el.querySelector('svg')?.getAttribute('class');
    expect(glyph(figures)).not.toBe(glyph(children));
  });

  it('opens a popover — not an in-menu field — for the image URL', () => {
    // A Radix menu is role="menu", whose typeahead swallows printable keys.
    // Any text field has to leave the menu. Same trap as the block menu's
    // free-form Improve input.
    render(<EditorToolbar editor={createMockEditor()} />);
    openInsertMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Image…' }));

    const field = screen.getByLabelText('Image URL');
    expect(field).toBeInTheDocument();
    expect(field.closest('[role="menu"]')).toBeNull();
  });

  it('refuses to insert an image with no URL', () => {
    render(<EditorToolbar editor={createMockEditor()} />);
    openInsertMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Image…' }));
    expect(screen.getByRole('button', { name: 'Insert image' })).toBeDisabled();
  });

  it('inserts an image from the popover', () => {
    const setImage = vi.fn(() => chain);
    const chain: Record<string, unknown> = new Proxy({ setImage } as Record<string, unknown>, {
      get(target, prop: string) {
        if (prop === 'setImage') return target.setImage;
        if (prop === 'run') return vi.fn();
        return () => chain;
      },
    });
    render(<EditorToolbar editor={createMockEditor({ chain: () => chain })} />);
    openInsertMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Image…' }));

    fireEvent.change(screen.getByLabelText('Image URL'), {
      target: { value: 'https://example.com/a.png' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Insert image' }));

    expect(setImage).toHaveBeenCalledWith({ src: 'https://example.com/a.png' });
  });

  it('offers the status label its colour and its text outside the menu', () => {
    render(<EditorToolbar editor={createMockEditor()} />);
    openInsertMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Status label…' }));

    const label = screen.getByLabelText('Label');
    expect(label.closest('[role="menu"]')).toBeNull();
    for (const colour of ['Grey', 'Blue', 'Green', 'Yellow', 'Red']) {
      expect(screen.getByRole('radio', { name: colour })).toBeInTheDocument();
    }
  });

  it('inserts a status label with the chosen colour and text', () => {
    const insertContent = vi.fn(() => chain);
    const chain: Record<string, unknown> = new Proxy({ insertContent } as Record<string, unknown>, {
      get(target, prop: string) {
        if (prop === 'insertContent') return target.insertContent;
        if (prop === 'run') return vi.fn();
        return () => chain;
      },
    });
    render(<EditorToolbar editor={createMockEditor({ chain: () => chain })} />);
    openInsertMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Status label…' }));

    fireEvent.click(screen.getByRole('radio', { name: 'Green' }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'shipped' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert status label' }));

    expect(insertContent).toHaveBeenCalledWith({
      type: 'confluenceStatus',
      // Uppercased on the way in — Confluence status labels are uppercase.
      attrs: { color: 'green', label: 'SHIPPED' },
    });
  });

  it('inserts an emoji from the Insert menu popup', () => {
    const insertContent = vi.fn(() => chain);
    const chain: Record<string, unknown> = new Proxy({ insertContent } as Record<string, unknown>, {
      get(target, prop: string) {
        if (prop === 'insertContent') return target.insertContent;
        if (prop === 'run') return vi.fn();
        return () => chain;
      },
    });
    render(<EditorToolbar editor={createMockEditor({ chain: () => chain })} />);
    openInsertMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Emoji…' }));

    expect(screen.getByRole('dialog', { name: 'Emoji Picker' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('popular-emoji-✨'));
    expect(insertContent).toHaveBeenCalledWith('✨');
  });

  it('runs quote, code block, and divider from the Insert menu', () => {
    const toggleBlockquote = vi.fn(() => chain);
    const toggleCodeBlock = vi.fn(() => chain);
    const setHorizontalRule = vi.fn(() => chain);
    const run = vi.fn();
    const chain: Record<string, unknown> = new Proxy(
      { toggleBlockquote, toggleCodeBlock, setHorizontalRule } as Record<string, unknown>,
      {
        get(target, prop: string) {
          if (prop === 'toggleBlockquote') return target.toggleBlockquote;
          if (prop === 'toggleCodeBlock') return target.toggleCodeBlock;
          if (prop === 'setHorizontalRule') return target.setHorizontalRule;
          if (prop === 'run') return run;
          return () => chain;
        },
      },
    );
    render(<EditorToolbar editor={createMockEditor({ chain: () => chain })} />);

    openInsertMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Quote' }));
    expect(toggleBlockquote).toHaveBeenCalled();

    openInsertMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Code block' }));
    expect(toggleCodeBlock).toHaveBeenCalled();

    openInsertMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Divider' }));
    expect(setHorizontalRule).toHaveBeenCalled();
  });

  // ---------- pressed state ----------

  it('exposes aria-pressed on active and inactive toggles (#955)', () => {
    const editor = createMockEditor({ isActive: (name: string) => name === 'bold' });
    render(<EditorToolbar editor={editor} />);
    expect(screen.getByRole('button', { name: 'Bold (Ctrl+B)' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Italic (Ctrl+I)' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('carries heading-numbering state into the text-style menu', () => {
    render(<EditorToolbar editor={createMockEditor()} onToggleHeaderNumbering={vi.fn()} headerNumbering />);
    openBlockMenu();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Number headings' })).toHaveAttribute('aria-checked', 'true');
  });

  // ---------- colours ----------

  it('sizes the colour picker like every other control', () => {
    render(<EditorToolbar editor={createMockEditor()} />);
    const trigger = screen.getByTestId('color-picker-trigger');
    expect(trigger.className).toContain('nm-icon-button');
  });

  it('opens one Color panel with text and highlight rows, including Brown and Teal', () => {
    render(<EditorToolbar editor={createMockEditor()} />);
    const trigger = screen.getByTestId('color-picker-trigger');
    expect(trigger).toHaveAttribute('aria-label', 'Color');
    expect(trigger.querySelector('svg')).toHaveClass('lucide-baseline');

    fireEvent.click(trigger);
    expect(screen.getByRole('group', { name: 'Color' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Highlight' })).toBeInTheDocument();

    const swatches = screen.getAllByTestId('color-picker-swatch');
    // 10 hues × two roles. The original eight stay; Brown and Teal are the extras.
    expect(swatches).toHaveLength(20);
    expect(screen.getByLabelText('Brown text')).toBeInTheDocument();
    expect(screen.getByLabelText('Teal highlight')).toBeInTheDocument();
    for (const sw of swatches) expect(sw.getAttribute('aria-label')).toBeTruthy();
  });

  it('applies text colour and highlight from the same panel', () => {
    const setColor = vi.fn(() => chain);
    const toggleHighlight = vi.fn(() => chain);
    const chain: Record<string, unknown> = new Proxy(
      { setColor, toggleHighlight } as Record<string, unknown>,
      {
        get(target, prop: string) {
          if (prop === 'setColor') return target.setColor;
          if (prop === 'toggleHighlight') return target.toggleHighlight;
          if (prop === 'run') return vi.fn();
          return () => chain;
        },
      },
    );
    render(<EditorToolbar editor={createMockEditor({ chain: () => chain })} />);
    fireEvent.click(screen.getByTestId('color-picker-trigger'));
    fireEvent.click(screen.getByLabelText('Red text'));
    expect(setColor).toHaveBeenCalledWith('#ef4444');

    fireEvent.click(screen.getByTestId('color-picker-trigger'));
    fireEvent.click(screen.getByLabelText('Yellow highlight'));
    expect(toggleHighlight).toHaveBeenCalledWith({ color: '#eab308' });
  });

  // ---------- utilities ----------

  it('renders the header-numbering toggle in the text-style menu only when it is wired up', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<EditorToolbar editor={createMockEditor()} />);
    openBlockMenu();
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Number headings' })).not.toBeInTheDocument();

    rerender(
      <EditorToolbar editor={createMockEditor()} headerNumbering onToggleHeaderNumbering={onToggle} />,
    );
    const toggleItem = screen.getByRole('menuitemcheckbox', { name: 'Number headings' });
    expect(toggleItem).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggleItem);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  // ---------- emoji picker ----------

  it('renders the emoji picker trigger with accessible attributes', () => {
    render(<EditorToolbar editor={createMockEditor()} />);
    const trigger = screen.getByTestId('emoji-picker-trigger');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-label', 'Insert Emoji');
    expect(trigger).toHaveAttribute('title', 'Insert Emoji');
    expect(trigger.className).toContain('nm-icon-button');
  });

  it('opens emoji picker and inserts selected emoji into document', () => {
    const insertContent = vi.fn(() => chain);
    const chain: Record<string, unknown> = new Proxy({ insertContent } as Record<string, unknown>, {
      get(target, prop: string) {
        if (prop === 'insertContent') return target.insertContent;
        if (prop === 'run') return vi.fn();
        return () => chain;
      },
    });
    const editor = createMockEditor({ chain: () => chain });
    render(<EditorToolbar editor={editor} />);

    const trigger = screen.getByTestId('emoji-picker-trigger');
    open(trigger);

    expect(screen.getByRole('dialog', { name: 'Emoji Picker' })).toBeInTheDocument();
    const popularEmoji = screen.getByTestId('popular-emoji-🚀');
    fireEvent.click(popularEmoji);

    expect(insertContent).toHaveBeenCalledWith('🚀');
  });

  // ---------- responsive folding ----------

  it('folds secondary items when toolbar container width narrows', () => {
    let resizeCallback: ((entries: Array<{ contentRect: { width: number } }>) => void) | null = null;
    class MockResizeObserver {
      constructor(cb: (entries: Array<{ contentRect: { width: number } }>) => void) {
        resizeCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const originalRO = window.ResizeObserver;
    window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

    try {
      render(<EditorToolbar editor={createMockEditor()} />);

      // Initially at wide default (1200px), all buttons are present
      expect(screen.getByRole('button', { name: 'Underline (Ctrl+U)' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Quote' })).toBeInTheDocument();
      expect(screen.getByTestId('emoji-picker-trigger')).toBeInTheDocument();

      // Trigger resize to narrow width (500px)
      act(() => {
        resizeCallback?.([{ contentRect: { width: 500 } }]);
      });

      // Essential items remain:
      expect(screen.getByRole('button', { name: 'Bold (Ctrl+B)' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Italic (Ctrl+I)' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Bullet List (Ctrl+Shift+8)' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Insert' })).toBeInTheDocument();

      // Folded items are removed from toolbar (accessible via Insert menu):
      expect(screen.queryByRole('button', { name: 'Underline (Ctrl+U)' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Quote' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Code Block' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Divider' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('emoji-picker-trigger')).not.toBeInTheDocument();
      expect(screen.queryByTestId('more-formatting-trigger')).not.toBeInTheDocument();

      openInsertMenu();
      for (const label of ['Underline', 'Strikethrough', 'Inline Code', 'Ordered List', 'Task List', 'Alignment']) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
      expect(screen.getByTestId('color-picker-trigger')).toBeInTheDocument();
    } finally {
      window.ResizeObserver = originalRO;
    }
  });

  it('restores folded items when the toolbar widens again', () => {
    let resizeCallback: ((entries: Array<{ contentRect: { width: number } }>) => void) | null = null;
    class MockResizeObserver {
      constructor(cb: (entries: Array<{ contentRect: { width: number } }>) => void) {
        resizeCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const originalRO = window.ResizeObserver;
    window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

    try {
      render(<EditorToolbar editor={createMockEditor()} />);
      act(() => {
        resizeCallback?.([{ contentRect: { width: 500 } }]);
      });
      expect(screen.queryByRole('button', { name: 'Underline (Ctrl+U)' })).not.toBeInTheDocument();

      act(() => {
        resizeCallback?.([{ contentRect: { width: 1200 } }]);
      });
      expect(screen.getByRole('button', { name: 'Underline (Ctrl+U)' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Quote' })).toBeInTheDocument();
      expect(screen.getByTestId('emoji-picker-trigger')).toBeInTheDocument();
      expect(screen.getByTestId('color-picker-trigger')).toBeInTheDocument();
    } finally {
      window.ResizeObserver = originalRO;
    }
  });

  // ---------- narrow-viewport overlap (P0) ----------

  it('gives the formatting group its own scroll region instead of overflowing onto the actions group', () => {
    // jsdom performs no real layout, so this can't measure pixels the way a
    // headless-browser fixture would — but the specific bug (Cancel painted
    // over Bullet List, Tags over Italic at 390px) traces to one missing
    // class: `min-w-0` lets the formatting group's box shrink below its
    // content's width, and without `overflow-x-auto` that shrunk box still
    // paints its children at full size past its own right edge. Pin the
    // class so the fix can't silently regress.
    render(
      <EditorToolbar
        editor={createMockEditor()}
        actions={<button aria-label="Save">Save</button>}
      />,
    );
    const toolbar = screen.getByRole('toolbar', { name: 'Page editor toolbar' });
    expect(toolbar.className).toContain('flex-1');
    // The marks/lists cluster is the only box allowed to shrink (`min-w-0`).
    // Insert stays `shrink-0` so it cannot slide under Tags/Save — folded
    // tools live in Insert, so that trigger has to stay tappable.
    const scroller = screen.getByTestId('toolbar-scroll');
    expect(scroller.className).toContain('min-w-0');
    expect(scroller.className).toContain('flex-1');
    expect(scroller.className).toContain('overflow-x-auto');
    expect(screen.getByTestId('toolbar-group-insert').className).toContain('shrink-0');

    // The actions group must stay `shrink-0` — if it started shrinking too,
    // scrolling the formatting group would no longer be sufficient to keep
    // Save/Cancel/Tags fully visible and tappable.
    const actionsGroup = screen.getByRole('group', { name: 'Page actions' });
    expect(actionsGroup.className).toContain('shrink-0');
  });

  // ---------- Insert overflow ----------
  // A second toolbar trigger ("More formatting") used to appear just to
  // hold the folded marks. Insert already exists; folded tools go there.

  function resizeTo(width: number) {
    let resizeCallback: ((entries: Array<{ contentRect: { width: number } }>) => void) | null = null;
    class MockResizeObserver {
      constructor(cb: (entries: Array<{ contentRect: { width: number } }>) => void) {
        resizeCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const originalRO = window.ResizeObserver;
    window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    return {
      apply: () => act(() => resizeCallback?.([{ contentRect: { width } }])),
      restore: () => { window.ResizeObserver = originalRO; },
    };
  }

  it('never adds a More formatting trigger, wide or narrow', () => {
    const resize = resizeTo(650);
    try {
      render(<EditorToolbar editor={createMockEditor()} />);
      expect(screen.queryByTestId('more-formatting-trigger')).not.toBeInTheDocument();
      resize.apply();
      expect(screen.queryByTestId('more-formatting-trigger')).not.toBeInTheDocument();
    } finally {
      resize.restore();
    }
  });

  it('surfaces Task List, Inline Code, Strikethrough and Alignment in Insert once the toolbar narrows past their thresholds', () => {
    const resize = resizeTo(650); // below 760/820/980 (not 1060 — Quote/Code block/Divider already live in Insert)
    try {
      render(<EditorToolbar editor={createMockEditor()} />);
      resize.apply();

      expect(screen.queryByRole('button', { name: 'Strikethrough (Ctrl+Shift+X)' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Inline Code (Ctrl+E)' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Task List' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('align-menu-trigger')).not.toBeInTheDocument();
      // Color is a peer of the bullet list — it does not fold.
      expect(screen.getByTestId('color-picker-trigger')).toBeInTheDocument();

      openInsertMenu();
      for (const label of ['Task List', 'Inline Code', 'Strikethrough', 'Alignment']) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
      expect(screen.queryByRole('menuitem', { name: 'Color…' })).toBeNull();
    } finally {
      resize.restore();
    }
  });

  it('runs the hidden Strikethrough toggle from Insert', () => {
    const toggleStrike = vi.fn(() => chain);
    const chain: Record<string, unknown> = new Proxy({ toggleStrike } as Record<string, unknown>, {
      get(target, prop: string) {
        if (prop === 'toggleStrike') return target.toggleStrike;
        if (prop === 'run') return vi.fn();
        return () => chain;
      },
    });
    const editor = createMockEditor({ chain: () => chain });
    const resize = resizeTo(650);
    try {
      render(<EditorToolbar editor={editor} />);
      resize.apply();
      openInsertMenu();
      fireEvent.click(screen.getByText('Strikethrough'));
      expect(toggleStrike).toHaveBeenCalledTimes(1);
    } finally {
      resize.restore();
    }
  });

  it('applies alignment from Insert’s Alignment submenu', () => {
    const setTextAlign = vi.fn(() => chain);
    const chain: Record<string, unknown> = new Proxy({ setTextAlign } as Record<string, unknown>, {
      get(target, prop: string) {
        if (prop === 'setTextAlign') return target.setTextAlign;
        if (prop === 'run') return vi.fn();
        return () => chain;
      },
    });
    const editor = createMockEditor({ chain: () => chain });
    const resize = resizeTo(650);
    try {
      render(<EditorToolbar editor={editor} />);
      resize.apply();
      openInsertMenu();
      open(screen.getByText('Alignment'));
      fireEvent.click(screen.getByText('Align Center'));
      expect(setTextAlign).toHaveBeenCalledWith('center');
    } finally {
      resize.restore();
    }
  });

});
