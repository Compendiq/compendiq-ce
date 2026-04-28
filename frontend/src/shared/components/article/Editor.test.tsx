import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, screen, fireEvent } from '@testing-library/react';

vi.mock('../hooks/use-is-light-theme', () => ({
  useIsLightTheme: () => false,
}));

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { Editor, EditorToolbar } from './Editor';
import type { Editor as EditorType } from '@tiptap/react';

// Minimal mock of a TipTap Editor instance for toolbar-level tests
function createMockEditor(): EditorType {
  const chainProxy: Record<string, unknown> = new Proxy(
    { run: vi.fn() } as Record<string, unknown>,
    {
      get(_target, prop: string) {
        if (prop === 'run') return vi.fn();
        return () => chainProxy;
      },
    },
  );

  return {
    chain: () => chainProxy,
    can: () =>
      new Proxy(
        {},
        { get() { return () => true; } },
      ),
    isActive: () => false,
    getAttributes: () => ({}),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as EditorType;
}

describe('Editor', () => {
  it('sticky toolbar reads as the top of the article card (#30 overhaul)', async () => {
    // The internal toolbar must look like the visual top of the article card
    // below — same bg, rounded only on top, sticks at top:0 when scrolling.
    // The old bad patterns (before:bottom-full overlapping content above, or
    // before:bg-background showing the page color through the toolbar) are
    // structurally impossible now because the ::before strip is gone.
    const { container } = render(
      <Editor content="<p>Hello</p>" editable={true} />,
    );

    await waitFor(() => {
      expect(container.querySelector('[class*="sticky"]')).toBeTruthy();
    });

    const toolbar = container.querySelector('[class*="sticky"]');
    const classes = toolbar?.className ?? '';

    // Sticky at top:0
    expect(classes).toMatch(/sticky/);
    expect(classes).toMatch(/top-0/);

    // Square top corners — definitive fix for the scroll-peek-through bug.
    // Rounded top corners create transparent cutout areas that reveal
    // whatever is behind the toolbar (article card edges, page bg, etc.)
    // when scrolling. Square corners eliminate the cutouts entirely.
    expect(classes).not.toMatch(/rounded-t-/);
    expect(classes).toMatch(/bg-card\b/);
    expect(classes).toMatch(/border-b/);
    // No ::before pseudo-strip — the old shield/extension patterns are gone.
    expect(classes).not.toMatch(/before:absolute/);
    expect(classes).not.toMatch(/before:bottom-full/);
    expect(classes).not.toMatch(/before:bg-background/);
  });

  it('renders Insert Layout toolbar button', async () => {
    const { container } = render(
      <Editor content="<p>Test</p>" editable={true} />,
    );

    await waitFor(() => {
      expect(container.querySelector('[class*="tiptap"]')).toBeTruthy();
    });

    // Find the toolbar region: look for a group of buttons inside the editor wrapper
    const buttons = container.querySelectorAll('button');
    const layoutButton = Array.from(buttons).find(
      (btn) =>
        btn.title?.toLowerCase().includes('layout') ||
        btn.textContent?.toLowerCase().includes('layout'),
    );

    // The Insert Layout button must exist in the toolbar
    expect(layoutButton).toBeTruthy();
  });

  it('loads the MermaidBlock extension', async () => {
    const { container } = render(
      <Editor content="<p>Test</p>" editable={true} />,
    );

    await waitFor(() => {
      expect(container.querySelector('[class*="tiptap"]')).toBeTruthy();
    });

    // The MermaidBlock extension is registered (no toolbar button exists for it;
    // mermaid blocks are inserted via slash commands or pasted content).
    // Verify the editor loaded successfully with the extension by checking
    // that the ProseMirror editor is mounted and interactive.
    const prosemirror = container.querySelector('.ProseMirror');
    expect(prosemirror).toBeTruthy();
    expect(prosemirror?.getAttribute('contenteditable')).toBe('true');
  });

  it('preserves Confluence image metadata attributes in the editor', async () => {
    const htmlWithMetadata = `
      <p><img src="/api/attachments/page-1/test.png"
        data-confluence-image-source="external-url"
        data-confluence-url="https://example.com/a.png"
        data-confluence-filename="original.png"
        data-confluence-owner-page-title="Shared Assets"
        data-confluence-owner-space-key="OPS"
      /></p>
    `;

    const { container } = render(
      <Editor content={htmlWithMetadata} editable={true} />,
    );

    await waitFor(() => {
      expect(container.querySelector('img')).toBeTruthy();
    });

    const img = container.querySelector('img');
    expect(img).toHaveAttribute('data-confluence-image-source', 'external-url');
    expect(img).toHaveAttribute('data-confluence-url', 'https://example.com/a.png');
    expect(img).toHaveAttribute('data-confluence-filename', 'original.png');
    expect(img).toHaveAttribute('data-confluence-owner-page-title', 'Shared Assets');
    expect(img).toHaveAttribute('data-confluence-owner-space-key', 'OPS');
  });

  describe('clipboard image paste (#17)', () => {
    it('renders and accepts the pageId prop', async () => {
      const { container } = render(
        <Editor content="" editable={true} pageId="42" />,
      );

      await waitFor(() => {
        expect(container.querySelector('[class*="tiptap"]')).toBeTruthy();
      });

      // Verify the editor renders successfully with pageId
      expect(container.querySelector('[class*="tiptap"]')).toBeTruthy();
    });

    it('renders without pageId (backward compatible)', async () => {
      const { container } = render(
        <Editor content="" editable={true} />,
      );

      await waitFor(() => {
        expect(container.querySelector('[class*="tiptap"]')).toBeTruthy();
      });

      expect(container.querySelector('[class*="tiptap"]')).toBeTruthy();
    });
  });

  it('applies header-numbering class to container when localStorage flag is true', async () => {
    localStorage.setItem('editor-header-numbering', 'true');
    const { container } = render(
      <Editor content="<p>Hello</p>" editable={true} />,
    );

    await waitFor(() => {
      expect(container.querySelector('.header-numbering')).toBeTruthy();
    });
  });

  it('does not apply header-numbering class when localStorage flag is false', async () => {
    localStorage.setItem('editor-header-numbering', 'false');
    const { container } = render(
      <Editor content="<p>Hello</p>" editable={true} />,
    );

    await waitFor(() => {
      // Wait for editor to render
      expect(container.querySelector('[class*="nm-card"]')).toBeTruthy();
    });
    expect(container.querySelector('.header-numbering')).toBeFalsy();
  });

  describe('drag handle (#49)', () => {
    it('renders drag handle in edit mode', async () => {
      const { container } = render(
        <Editor content="<p>Hello</p>" editable={true} />,
      );

      await waitFor(() => {
        expect(container.querySelector('[class*="tiptap"]')).toBeTruthy();
      });

      const dragHandle = container.querySelector('.drag-handle');
      expect(dragHandle).toBeTruthy();
    });

    it('does not render drag handle in read-only mode', async () => {
      const { container } = render(
        <Editor content="<p>Hello</p>" editable={false} />,
      );

      await waitFor(() => {
        expect(container.querySelector('[class*="tiptap"]')).toBeTruthy();
      });

      const dragHandle = container.querySelector('.drag-handle');
      expect(dragHandle).toBeFalsy();
    });
  });
});

describe('EditorToolbar — header numbering toggle', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders a header numbering toggle button when props are provided', () => {
    const editor = createMockEditor();
    const toggle = vi.fn();
    render(<EditorToolbar editor={editor} headerNumbering={false} onToggleHeaderNumbering={toggle} />);

    expect(screen.getByTitle('Toggle Header Numbering')).toBeInTheDocument();
  });

  it('shows active styling when headerNumbering is true', () => {
    const editor = createMockEditor();
    const toggle = vi.fn();
    render(<EditorToolbar editor={editor} headerNumbering={true} onToggleHeaderNumbering={toggle} />);

    const btn = screen.getByTitle('Toggle Header Numbering');
    expect(btn.className).toContain('bg-primary');
  });

  it('shows inactive styling when headerNumbering is false', () => {
    const editor = createMockEditor();
    const toggle = vi.fn();
    render(<EditorToolbar editor={editor} headerNumbering={false} onToggleHeaderNumbering={toggle} />);

    const btn = screen.getByTitle('Toggle Header Numbering');
    expect(btn.className).not.toContain('bg-primary');
  });

  it('calls onToggleHeaderNumbering when the button is clicked', () => {
    const editor = createMockEditor();
    const toggle = vi.fn();
    render(<EditorToolbar editor={editor} headerNumbering={false} onToggleHeaderNumbering={toggle} />);

    fireEvent.click(screen.getByTitle('Toggle Header Numbering'));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('does not render the toggle button when onToggleHeaderNumbering is absent', () => {
    const editor = createMockEditor();
    render(<EditorToolbar editor={editor} />);

    expect(screen.queryByTitle('Toggle Header Numbering')).not.toBeInTheDocument();
  });

  // ---------- #353 toolbar grouping + bigger color pickers ----------

  it('renders a labeled Colors group containing both color pickers (#353)', () => {
    const editor = createMockEditor();
    render(<EditorToolbar editor={editor} />);

    const group = screen.getByRole('group', { name: 'Colors' });
    expect(group).toBeInTheDocument();
    expect(group).toHaveAttribute('data-toolbar-group', 'colors');
    // Both triggers live inside the group.
    expect(group.querySelectorAll('[data-testid="color-picker-trigger"]').length).toBe(2);
  });

  it('color-picker triggers meet the 32x32 minimum target size (#353)', () => {
    const editor = createMockEditor();
    render(<EditorToolbar editor={editor} />);

    const triggers = screen.getAllByTestId('color-picker-trigger');
    expect(triggers.length).toBe(2);
    for (const trigger of triggers) {
      // Tailwind h-8 w-8 maps to 32×32 (1rem = 16px).
      expect(trigger.className).toMatch(/(?:^|\s)h-8(?:\s|$)/);
      expect(trigger.className).toMatch(/(?:^|\s)w-8(?:\s|$)/);
    }
  });

  it('color-picker swatches meet the 24x24 minimum after opening the picker (#353)', () => {
    const editor = createMockEditor();
    render(<EditorToolbar editor={editor} />);

    const triggers = screen.getAllByTestId('color-picker-trigger');
    fireEvent.click(triggers[0]!);

    const swatches = screen.getAllByTestId('color-picker-swatch');
    expect(swatches.length).toBeGreaterThanOrEqual(8);
    for (const sw of swatches) {
      // h-7 w-7 → 28×28 (above the 24 minimum).
      expect(sw.className).toMatch(/(?:^|\s)h-7(?:\s|$)/);
      expect(sw.className).toMatch(/(?:^|\s)w-7(?:\s|$)/);
    }
  });
});
