import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('presents eighteen main controls plus utilities', () => {
    render(<EditorToolbar editor={createMockEditor()} onToggleHeaderNumbering={vi.fn()} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Page editor toolbar' });
    // 18 = (block type + quote + code block + divider) + 5 marks + 1 align dropdown + 3 lists + 2 colours + Insert + undo + redo
    expect(toolbar.querySelectorAll('button').length).toBe(18);
  });

  it('renders the groups in the restructured order', () => {
    render(<EditorToolbar editor={createMockEditor()} />);
    const groups = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="toolbar-group-"]'),
    ).map((el) => el.dataset.testid);

    // First choose the block, then shape text and lists. Alignment belongs with
    // lists; block-level actions follow it as their own compact section.
    expect(groups).toEqual([
      'toolbar-group-history',
      'toolbar-group-block-type',
      'toolbar-group-inline',
      'toolbar-group-lists',
      'toolbar-group-block-actions',
      'toolbar-group-colors',
      'toolbar-group-insert',
    ]);
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

  it('sizes both colour pickers like every other control', () => {
    // They used to be the two 36px boxes in a row of 28px ones. `nm-icon-button`
    // is the workspace's 32px control, so the row now has ONE height.
    render(<EditorToolbar editor={createMockEditor()} />);
    const triggers = screen.getAllByTestId('color-picker-trigger');
    expect(triggers.length).toBe(2);
    for (const t of triggers) expect(t.className).toContain('nm-icon-button');
  });

  it('names both colour triggers and every swatch', () => {
    render(<EditorToolbar editor={createMockEditor()} />);
    const triggers = screen.getAllByTestId('color-picker-trigger');
    expect(triggers[0]).toHaveAttribute('aria-label', 'Text Color');
    expect(triggers[1]).toHaveAttribute('aria-label', 'Highlight (Ctrl+Shift+H)');
    expect(triggers[0]?.querySelector('svg')).toHaveClass('lucide-baseline');

    fireEvent.click(triggers[0]!);
    const swatches = screen.getAllByTestId('color-picker-swatch');
    expect(swatches.length).toBeGreaterThanOrEqual(8);
    for (const sw of swatches) expect(sw.getAttribute('aria-label')).toBeTruthy();
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

  it('disables undo and redo when the history is empty', () => {
    const editor = createMockEditor({
      can: () => new Proxy({}, { get: () => () => false }),
    });
    render(<EditorToolbar editor={editor} />);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
  });
});
