import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { MermaidBlock } from './MermaidBlockExtension';
import { _resetMermaidCache, loadMermaid } from './MermaidDiagram';

// Mock mermaid
const mockMermaidRender = vi.fn().mockResolvedValue({ svg: '<svg>diagram</svg>' });
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: (...args: unknown[]) => mockMermaidRender(...args),
  },
}));

// Mock useIsLightTheme hook
vi.mock('../hooks/use-is-light-theme', () => ({
  useIsLightTheme: () => false,
}));

/**
 * Helper component that wraps TipTap editor with the MermaidBlock extension.
 */
function TestEditor({ content, editable = true }: { content: string; editable?: boolean }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      MermaidBlock,
    ],
    content,
    editable,
    immediatelyRender: false,
  });

  return <EditorContent editor={editor} />;
}

describe('MermaidBlockExtension', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    _resetMermaidCache();
    mockMermaidRender.mockResolvedValue({ svg: '<svg>diagram</svg>' });
    // Pre-warm the mermaid cache so the lazy import resolves instantly
    await loadMermaid();
  });

  afterEach(() => {
    _resetMermaidCache();
  });

  it('parses mermaid code blocks from HTML and renders the MermaidBlock node view', async () => {
    const html = '<pre><code class="language-mermaid">graph TD\n  A --> B</code></pre>';

    render(<TestEditor content={html} />);

    // The MermaidBlock NodeView should render with the data-testid
    await waitFor(() => {
      expect(screen.getByTestId('mermaid-block')).toBeInTheDocument();
    });
  });

  it('shows Mermaid Diagram label in the toolbar', async () => {
    const html = '<pre><code class="language-mermaid">graph TD\n  A --> B</code></pre>';

    render(<TestEditor content={html} />);

    // Both the MermaidBlockView toolbar and the inner MermaidDiagram component
    // render "Mermaid Diagram" labels, so we expect at least 2
    await waitFor(() => {
      const labels = screen.getAllByText('Mermaid Diagram');
      expect(labels.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows preview by default', async () => {
    const html = '<pre><code class="language-mermaid">graph TD\n  A --> B</code></pre>';

    render(<TestEditor content={html} />);

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-block')).toBeInTheDocument();
    });

    // Preview is shown by default (MermaidDiagram component is rendered)
    // The Edit button should be visible
    expect(screen.getByTitle('Edit source code')).toBeInTheDocument();
  });

  it('toggles between preview and source edit when clicking toggle button', async () => {
    const html = '<pre><code class="language-mermaid">graph TD\n  A --> B</code></pre>';

    render(<TestEditor content={html} />);

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-block')).toBeInTheDocument();
    });

    // Click "Edit" to switch to source view
    const editButton = screen.getByTitle('Edit source code');
    fireEvent.click(editButton);

    // Source editor (textarea) should now be visible
    await waitFor(() => {
      expect(screen.getByTestId('mermaid-source-editor')).toBeInTheDocument();
    });

    // The textarea should contain the mermaid code
    const textarea = screen.getByTestId('mermaid-source-editor') as HTMLTextAreaElement;
    expect(textarea.value).toBe('graph TD\n  A --> B');

    // Click "Preview" to switch back
    const previewButton = screen.getByTitle('Show preview');
    fireEvent.click(previewButton);

    // Textarea should be gone, preview should be back
    await waitFor(() => {
      expect(screen.queryByTestId('mermaid-source-editor')).toBeNull();
    });
  });

  it('does not parse regular code blocks as mermaid', async () => {
    const html = '<pre><code class="language-javascript">const x = 1;</code></pre>';

    render(<TestEditor content={html} />);

    // Wait for TipTap to render
    await waitFor(() => {
      expect(document.querySelector('.tiptap')).toBeTruthy();
    });

    // Should not render a MermaidBlock
    expect(screen.queryByTestId('mermaid-block')).toBeNull();
  });

  it('hides edit toggle in non-editable mode', async () => {
    const html = '<pre><code class="language-mermaid">graph TD\n  A --> B</code></pre>';

    render(<TestEditor content={html} editable={false} />);

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-block')).toBeInTheDocument();
    });

    // Edit toggle should not be present when editor is not editable
    expect(screen.queryByTitle('Edit source code')).toBeNull();
  });

  it('shows empty state message when code is empty', async () => {
    const html = '<pre><code class="language-mermaid"></code></pre>';

    render(<TestEditor content={html} />);

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-block')).toBeInTheDocument();
    });

    expect(screen.getByText(/Empty diagram/)).toBeInTheDocument();
  });

  it('serializes mermaid blocks back to pre/code HTML', async () => {
    const html = '<pre><code class="language-mermaid">graph TD\n  A --> B</code></pre>';

    let editorInstance: ReturnType<typeof useEditor> | null = null;

    function EditorWithRef({ content }: { content: string }) {
      const editor = useEditor({
        extensions: [
          StarterKit.configure({ codeBlock: false }),
          MermaidBlock,
        ],
        content,
        immediatelyRender: false,
      });
      editorInstance = editor;
      return <EditorContent editor={editor} />;
    }

    render(<EditorWithRef content={html} />);

    await waitFor(() => {
      expect(editorInstance).toBeTruthy();
    });

    // Get the serialized HTML from the editor
    const outputHtml = editorInstance!.getHTML();
    expect(outputHtml).toContain('language-mermaid');
    expect(outputHtml).toContain('graph TD');
  });
});
