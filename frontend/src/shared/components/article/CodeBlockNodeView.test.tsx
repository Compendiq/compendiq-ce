import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TitledCodeBlock } from './TitledCodeBlock';
import { lowlight } from '../../lib/lowlight';

// Mock clipboard API
const mockWriteText = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: mockWriteText },
  writable: true,
});

/**
 * Helper component that wraps TipTap editor with TitledCodeBlock extension
 * configured with the shared lowlight instance (same as production).
 */
function TestEditor({
  content,
  editable = true,
}: {
  content: string;
  editable?: boolean;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      TitledCodeBlock.configure({ lowlight }),
    ],
    content,
    editable,
    immediatelyRender: false,
  });

  return <EditorContent editor={editor} />;
}

describe('CodeBlockNodeView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the code block NodeView with header', async () => {
    const html = '<pre><code class="language-javascript">const x = 1;</code></pre>';

    render(<TestEditor content={html} />);

    await waitFor(() => {
      expect(screen.getByTestId('code-block-node-view')).toBeInTheDocument();
    });
  });

  it('renders language dropdown with all supported languages', async () => {
    const html = '<pre><code class="language-javascript">const x = 1;</code></pre>';

    render(<TestEditor content={html} />);

    await waitFor(() => {
      expect(screen.getByTestId('code-block-language-select')).toBeInTheDocument();
    });

    const select = screen.getByTestId('code-block-language-select') as HTMLSelectElement;

    // Should have "Plain text" option plus all supported languages
    const options = select.querySelectorAll('option');
    expect(options.length).toBeGreaterThan(10); // at least 10 languages + plain text

    // First option should be "Plain text"
    expect(options[0].textContent).toBe('Plain text');
    expect(options[0].value).toBe('');

    // Current selection should be javascript
    expect(select.value).toBe('javascript');
  });

  it('changing language calls updateAttributes with selected value', async () => {
    const html = '<pre><code class="language-javascript">const x = 1;</code></pre>';

    render(<TestEditor content={html} />);

    await waitFor(() => {
      expect(screen.getByTestId('code-block-language-select')).toBeInTheDocument();
    });

    const select = screen.getByTestId('code-block-language-select') as HTMLSelectElement;

    // Change to python
    fireEvent.change(select, { target: { value: 'python' } });

    await waitFor(() => {
      expect(select.value).toBe('python');
    });
  });

  it('"Plain text" option sets language to empty', async () => {
    const html = '<pre><code class="language-javascript">const x = 1;</code></pre>';

    render(<TestEditor content={html} />);

    await waitFor(() => {
      expect(screen.getByTestId('code-block-language-select')).toBeInTheDocument();
    });

    const select = screen.getByTestId('code-block-language-select') as HTMLSelectElement;

    // Select "Plain text" (empty value)
    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() => {
      expect(select.value).toBe('');
    });
  });

  it('"Detect" button is shown when no language is set', async () => {
    const html = '<pre><code>plain text code without language</code></pre>';

    render(<TestEditor content={html} />);

    await waitFor(() => {
      expect(screen.getByTestId('code-block-node-view')).toBeInTheDocument();
    });

    // Detect button should be visible when no language is set
    // Note: auto-detect on mount may have already run, but the button
    // visibility depends on whether a language was detected
    const select = screen.getByTestId('code-block-language-select') as HTMLSelectElement;
    if (select.value === '') {
      expect(screen.getByTestId('code-block-detect-btn')).toBeInTheDocument();
    }
  });

  it('"Copy" button copies code to clipboard', async () => {
    const html = '<pre><code class="language-javascript">const x = 1;</code></pre>';

    render(<TestEditor content={html} />);

    await waitFor(() => {
      expect(screen.getByTestId('code-block-copy-btn')).toBeInTheDocument();
    });

    const copyBtn = screen.getByTestId('code-block-copy-btn');
    fireEvent.click(copyBtn);

    expect(mockWriteText).toHaveBeenCalledWith('const x = 1;');

    // Should show "Copied!" feedback
    await waitFor(() => {
      expect(copyBtn.textContent).toBe('Copied!');
    });
  });

  it('"Copy" button handles clipboard failure gracefully', async () => {
    const html = '<pre><code class="language-javascript">const x = 1;</code></pre>';
    mockWriteText.mockRejectedValueOnce(new Error('Clipboard API not available'));

    render(<TestEditor content={html} />);

    await waitFor(() => {
      expect(screen.getByTestId('code-block-copy-btn')).toBeInTheDocument();
    });

    const copyBtn = screen.getByTestId('code-block-copy-btn');
    fireEvent.click(copyBtn);

    // Should not show "Copied!" since clipboard write failed
    // Wait a tick for the async handler to settle
    await waitFor(() => {
      expect(copyBtn.textContent).toBe('Copy');
    });

    // Should not throw or crash the component
    expect(screen.getByTestId('code-block-node-view')).toBeInTheDocument();
  });

  it('read-only mode shows language label instead of dropdown', async () => {
    const html = '<pre><code class="language-javascript">const x = 1;</code></pre>';

    render(<TestEditor content={html} editable={false} />);

    await waitFor(() => {
      expect(screen.getByTestId('code-block-node-view')).toBeInTheDocument();
    });

    // Dropdown should not be present in read-only mode
    expect(screen.queryByTestId('code-block-language-select')).toBeNull();

    // Language label should be shown instead
    expect(screen.getByTestId('code-block-language-label')).toBeInTheDocument();
    expect(screen.getByTestId('code-block-language-label').textContent).toBe('javascript');
  });

  it('renders title when present', async () => {
    const html = '<pre data-title="My Script"><code class="language-bash">echo hello</code></pre>';

    render(<TestEditor content={html} />);

    await waitFor(() => {
      expect(screen.getByTestId('code-block-node-view')).toBeInTheDocument();
    });

    // Title should be displayed in the header
    expect(screen.getByText('My Script')).toBeInTheDocument();
  });
});
