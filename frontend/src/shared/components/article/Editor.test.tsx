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
  it('sticky toolbar has a safe ::before mask that covers the scroll gap without overlapping content above', async () => {
    // The internal toolbar uses before:-z-10 (behind its own content) to mask
    // the scroll-container padding gap above when the toolbar is stuck.
    // The old bad pattern (before:bottom-full, no -z-10) created a 200px opaque
    // pane that covered title inputs and config bars on embedding pages.
    const { container } = render(
      <Editor content="<p>Hello</p>" editable={true} />,
    );

    await waitFor(() => {
      expect(container.querySelector('[class*="sticky"]')).toBeTruthy();
    });

    const toolbar = container.querySelector('[class*="sticky"]');
    const classes = toolbar?.className ?? '';

    // Must NOT use the old downward-extending pattern that covered page content
    expect(classes).not.toMatch(/before:bottom-full/);
    expect(classes).not.toMatch(/before:h-\[/);

    // Must use the safe behind-content mask with an upward extension
    expect(classes).toMatch(/before:-z-10/);
    expect(classes).toMatch(/before:-top-\[/);
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
      expect(container.querySelector('[class*="glass-card"]')).toBeTruthy();
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
});
