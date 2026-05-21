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

    // CSS guards. The original bug was a dead selector — `[style*="display:
    // block"]` — that never matched because the upstream TipTap extension
    // toggles `visibility`, not `display`. We want to catch any future
    // change that silently re-introduces the same class of mistake.
    describe('visibility-toggle CSS rule', () => {
      it('targets the visibility-hidden inline style (file-content guard)', async () => {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        // Cheap, deterministic guard: read the rule out of index.css and
        // assert the selector covers what the extension actually toggles.
        // The old broken selector matched `display: block` (which the
        // extension never sets); this guard ensures the rule still keys off
        // `visibility: hidden` instead.
        const cssPath = resolve(__dirname, '../../../index.css');
        const css = readFileSync(cssPath, 'utf8');

        // Must NOT have reverted to the previous dead-selector form.
        expect(css).not.toMatch(/\.drag-handle\[style\*="display:\s*block"]/);

        // Must invert the visibility-hidden state — both whitespace variants
        // (browsers serialize as either `visibility: hidden` or, rarely,
        // `visibility:hidden`).
        expect(css).toMatch(/\.drag-handle:not\(\[style\*="visibility:\s*hidden"\]\):not\(\[style\*="visibility:hidden"\]\)/);
      });

      it('shows the handle when no visibility is set and hides it when visibility: hidden is set (behavioural)', () => {
        // jsdom does not load `index.css`, so inject the rule we depend on.
        // The selector copied here is what the file-content guard above
        // pins down — keep these in sync if the selector changes.
        const style = document.createElement('style');
        style.textContent = `
          .drag-handle { opacity: 0; }
          .drag-handle:not([style*="visibility: hidden"]):not([style*="visibility:hidden"]) { opacity: 0.7; }
        `;
        document.head.appendChild(style);

        const el = document.createElement('div');
        el.className = 'drag-handle';
        document.body.appendChild(el);

        try {
          // Extension's "shown" state — no inline visibility.
          expect(getComputedStyle(el).opacity).toBe('0.7');

          // Extension's "hidden" state — visibility cleared by setting it
          // to hidden in the inline style.
          el.style.visibility = 'hidden';
          expect(getComputedStyle(el).opacity).toBe('0');

          // Re-shown by clearing the visibility property — must reach 0.7
          // again (this is the round-trip the user complaint produced when
          // the cursor left and re-entered the block).
          el.style.visibility = '';
          expect(getComputedStyle(el).opacity).toBe('0.7');
        } finally {
          el.remove();
          style.remove();
        }
      });
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
    // Editor-toolbar active-state uses ink-action (Task 5 — amber reserved for AI affordances).
    expect(btn.className).toContain('bg-action');
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

  it('renders the toolbar groups in the conventional order (#353)', () => {
    const editor = createMockEditor();
    render(<EditorToolbar editor={editor} />);

    // Inline → block → lists → insert → captions → colors → utilities.
    const groups = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="toolbar-group-"]'),
    ).map((el) => el.dataset.testid);

    expect(groups).toEqual([
      'toolbar-group-inline',
      'toolbar-group-block',
      'toolbar-group-lists',
      'toolbar-group-insert',
      'toolbar-group-captions',
      'toolbar-group-colors',
      'toolbar-group-utilities',
    ]);
  });

  it('places both color pickers inside the colors group (#353)', () => {
    const editor = createMockEditor();
    render(<EditorToolbar editor={editor} />);

    const group = screen.getByTestId('toolbar-group-colors');
    expect(group).toHaveAttribute('role', 'group');
    expect(group).toHaveAttribute('aria-label', 'colors');
    expect(group.querySelectorAll('[data-testid="color-picker-trigger"]').length).toBe(2);
  });

  it('separates groups with role=separator dividers (#353)', () => {
    const editor = createMockEditor();
    const { container } = render(<EditorToolbar editor={editor} />);

    // Six segments → at least five separators between them.
    const separators = container.querySelectorAll('[role="separator"]');
    expect(separators.length).toBeGreaterThanOrEqual(5);
  });

  it('color-picker triggers meet the 32x32 minimum target size (#353)', () => {
    const editor = createMockEditor();
    render(<EditorToolbar editor={editor} />);

    const triggers = screen.getAllByTestId('color-picker-trigger');
    expect(triggers.length).toBe(2);
    for (const trigger of triggers) {
      // Tailwind h-9 w-9 maps to 36×36 (1rem = 16px) — comfortably above
      // the issue's 32×32 minimum.
      expect(trigger.className).toMatch(/(?:^|\s)h-9(?:\s|$)/);
      expect(trigger.className).toMatch(/(?:^|\s)w-9(?:\s|$)/);
    }
  });

  it('color-picker triggers expose a tooltip and aria-label (#353)', () => {
    const editor = createMockEditor();
    render(<EditorToolbar editor={editor} />);

    const triggers = screen.getAllByTestId('color-picker-trigger');
    expect(triggers[0]).toHaveAttribute('title', 'Text Color');
    expect(triggers[0]).toHaveAttribute('aria-label', 'Text Color');
    expect(triggers[1]).toHaveAttribute('title', 'Highlight (Ctrl+Shift+H)');
    expect(triggers[1]).toHaveAttribute('aria-label', 'Highlight (Ctrl+Shift+H)');
  });

  it('color-picker swatches meet the 24x24 minimum after opening the picker (#353)', () => {
    const editor = createMockEditor();
    render(<EditorToolbar editor={editor} />);

    const triggers = screen.getAllByTestId('color-picker-trigger');
    fireEvent.click(triggers[0]!);

    const swatches = screen.getAllByTestId('color-picker-swatch');
    expect(swatches.length).toBeGreaterThanOrEqual(8);
    for (const sw of swatches) {
      // h-7 w-7 → 28×28 (above the issue's 24×24 minimum).
      expect(sw.className).toMatch(/(?:^|\s)h-7(?:\s|$)/);
      expect(sw.className).toMatch(/(?:^|\s)w-7(?:\s|$)/);
      // Each swatch must carry an accessible name (its colour label).
      expect(sw.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('exposes the toolbar landmark with an accessible name (#353)', () => {
    const editor = createMockEditor();
    render(<EditorToolbar editor={editor} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Article editor toolbar' });
    expect(toolbar).toBeInTheDocument();
  });
});
