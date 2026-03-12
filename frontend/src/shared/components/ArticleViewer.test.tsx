import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

// Mock mermaid (must be before component import)
const mockMermaidRender = vi.fn().mockResolvedValue({ svg: '<svg data-testid="mermaid-svg">diagram</svg>' });
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

const mockFetchAuthenticatedBlob = vi.fn();
vi.mock('../hooks/use-authenticated-src', () => ({
  fetchAuthenticatedBlob: (...args: unknown[]) => mockFetchAuthenticatedBlob(...args),
}));

import { ArticleViewer } from './ArticleViewer';

describe('ArticleViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rewrites protected attachment images to authenticated blob URLs', async () => {
    mockFetchAuthenticatedBlob.mockResolvedValueOnce('blob:dashboard');

    const html = '<p><img src="/api/attachments/page-1/dashboard.png" alt="Dashboard" /></p>';
    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img).toHaveAttribute('src', 'blob:dashboard');
    });

    expect(mockFetchAuthenticatedBlob).toHaveBeenCalledWith('/api/attachments/page-1/dashboard.png');
  });

  it('adds error placeholder class when image fetch fails', async () => {
    mockFetchAuthenticatedBlob.mockResolvedValueOnce(null);

    const html = '<p><img src="/api/attachments/page-1/missing.png" alt="Missing" /></p>';
    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img?.classList.contains('image-load-error')).toBe(true);
    });

    // Should have a helpful title tooltip
    const img = container.querySelector('img')!;
    expect(img.title).toContain('could not be loaded');
  });

  it('does not rewrite external images through the authenticated attachment fetcher', async () => {
    const html = '<p><img src="https://example.com/diagram.svg" alt="External" /></p>';
    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img).toHaveAttribute('src', 'https://example.com/diagram.svg');
    });

    expect(mockFetchAuthenticatedBlob).not.toHaveBeenCalled();
  });

  it('renders HTML content with proper headings', async () => {
    const html = '<h1>Main Title</h1><p>Some content here</p><h2>Section Two</h2><p>More content</p>';

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('h1')).toBeTruthy();
    });

    expect(container.querySelector('h1')?.textContent).toBe('Main Title');
    expect(container.querySelector('h2')?.textContent).toBe('Section Two');
    expect(container.querySelectorAll('p')).toHaveLength(2);
  });

  it('renders lists with proper structure', async () => {
    const html = '<ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>';

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('ul')).toBeTruthy();
    });

    const listItems = container.querySelectorAll('li');
    expect(listItems).toHaveLength(3);
    expect(listItems[0].textContent).toBe('Item 1');
  });

  it('renders ordered lists', async () => {
    const html = '<ol><li>First</li><li>Second</li></ol>';

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('ol')).toBeTruthy();
    });

    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders code blocks with syntax highlighting wrapper', async () => {
    const html = '<pre><code class="language-javascript">const x = 1;</code></pre>';

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('pre')).toBeTruthy();
    });

    expect(container.querySelector('pre code')).toBeTruthy();
  });

  it('renders tables', async () => {
    const html = '<table><thead><tr><th>Col 1</th><th>Col 2</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr></tbody></table>';

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('table')).toBeTruthy();
    });

    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelectorAll('td')).toHaveLength(2);
  });

  it('renders multi-row tables with header and multiple data rows', async () => {
    const html = [
      '<table>',
      '<thead><tr><th>Name</th><th>Role</th><th>Status</th></tr></thead>',
      '<tbody>',
      '<tr><td>Alice</td><td>Engineer</td><td>Active</td></tr>',
      '<tr><td>Bob</td><td>Designer</td><td>Active</td></tr>',
      '<tr><td>Carol</td><td>Manager</td><td>On Leave</td></tr>',
      '<tr><td>Dave</td><td>DevOps</td><td>Active</td></tr>',
      '</tbody>',
      '</table>',
    ].join('');

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('table')).toBeTruthy();
    });

    // Header row
    const headers = container.querySelectorAll('th');
    expect(headers).toHaveLength(3);
    expect(headers[0].textContent).toBe('Name');
    expect(headers[1].textContent).toBe('Role');
    expect(headers[2].textContent).toBe('Status');

    // Data rows (4 rows x 3 cells = 12 td elements)
    const cells = container.querySelectorAll('td');
    expect(cells).toHaveLength(12);
    expect(cells[0].textContent).toBe('Alice');
    expect(cells[3].textContent).toBe('Bob');
    expect(cells[6].textContent).toBe('Carol');
    expect(cells[9].textContent).toBe('Dave');

    // Verify all rows rendered
    const rows = container.querySelectorAll('tr');
    expect(rows).toHaveLength(5); // 1 header + 4 data rows
  });

  it('renders tables with colspan and rowspan attributes', async () => {
    const html = [
      '<table>',
      '<thead><tr><th colspan="2">Full Name</th><th>Age</th></tr></thead>',
      '<tbody>',
      '<tr><td>First</td><td>Last</td><td rowspan="2">30</td></tr>',
      '<tr><td>John</td><td>Doe</td></tr>',
      '</tbody>',
      '</table>',
    ].join('');

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('table')).toBeTruthy();
    });

    // Check colspan header
    const headerWithColspan = container.querySelector('th[colspan="2"]');
    expect(headerWithColspan).toBeTruthy();
    expect(headerWithColspan?.textContent).toBe('Full Name');

    // Check rowspan cell
    const cellWithRowspan = container.querySelector('td[rowspan="2"]');
    expect(cellWithRowspan).toBeTruthy();
    expect(cellWithRowspan?.textContent).toBe('30');
  });

  it('renders blockquotes', async () => {
    const html = '<blockquote><p>A wise quote</p></blockquote>';

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('blockquote')).toBeTruthy();
    });

    expect(container.querySelector('blockquote')?.textContent).toContain('A wise quote');
  });

  it('renders links with proper attributes', async () => {
    const html = '<p>Visit <a href="https://example.com">Example</a></p>';

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('a')).toBeTruthy();
    });

    const link = container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(link.textContent).toBe('Example');
  });

  it('renders in non-editable mode', async () => {
    const html = '<p>Read only content</p>';

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('.tiptap')).toBeTruthy();
    });

    const tiptap = container.querySelector('.tiptap')!;
    expect(tiptap.getAttribute('contenteditable')).toBe('false');
  });

  it('generates heading IDs and calls onHeadingsReady', async () => {
    const html = '<h1>Title One</h1><h2>Sub Title</h2><h3>Deep Section</h3>';
    const onHeadingsReady = vi.fn();

    render(
      <ArticleViewer content={html} onHeadingsReady={onHeadingsReady} />,
    );

    await waitFor(() => {
      expect(onHeadingsReady).toHaveBeenCalled();
    });

    const headings = onHeadingsReady.mock.calls[0][0];
    expect(headings).toHaveLength(3);
    expect(headings[0]).toEqual(expect.objectContaining({ text: 'Title One', level: 1 }));
    expect(headings[1]).toEqual(expect.objectContaining({ text: 'Sub Title', level: 2 }));
    expect(headings[2]).toEqual(expect.objectContaining({ text: 'Deep Section', level: 3 }));
    // Each heading should have an id
    headings.forEach((h: { id: string }) => {
      expect(h.id).toBeTruthy();
    });
  });

  it('applies the article-viewer CSS class', async () => {
    const html = '<p>Test</p>';

    const { container } = render(<ArticleViewer content={html} className="custom-class" />);

    await waitFor(() => {
      const editorContent = container.querySelector('.article-viewer');
      expect(editorContent).toBeTruthy();
    });
  });

  it('sanitizes dangerous HTML', async () => {
    const html = '<p>Safe</p><script>alert("xss")</script>';

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('p')).toBeTruthy();
    });

    expect(container.querySelector('script')).toBeNull();
  });

  it('renders Confluence panels', async () => {
    const html = '<div class="panel-info"><p>Info panel content</p></div>';

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('.panel-info')).toBeTruthy();
    });

    expect(container.querySelector('.panel-info')?.textContent).toContain('Info panel content');
  });

  it('renders Confluence status badges', async () => {
    const html = '<p>Status: <span class="confluence-status" data-color="green">DONE</span></p>';

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('.confluence-status')).toBeTruthy();
    });

    const badge = container.querySelector('.confluence-status')!;
    expect(badge.textContent).toBe('DONE');
    expect(badge.getAttribute('data-color')).toBe('green');
  });

  it('renders Confluence children macro placeholder', async () => {
    const html = '<div class="confluence-children-macro" data-sort="title">[Children pages listed here]</div>';

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('.confluence-children-macro')).toBeTruthy();
    });

    const placeholder = container.querySelector('.confluence-children-macro')!;
    expect(placeholder.textContent).toContain('Children pages listed here');
  });

  it('renders collapsible details/summary sections', async () => {
    const html = '<details><summary>Click to expand</summary><p>Hidden content</p></details>';

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('details')).toBeTruthy();
    });

    expect(container.querySelector('summary')?.textContent).toBe('Click to expand');
  });

  it('adds copy buttons to code blocks', async () => {
    const html = '<pre><code>console.log("hello")</code></pre>';

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('.code-copy-btn')).toBeTruthy();
    });

    const btn = container.querySelector('.code-copy-btn')!;
    expect(btn.textContent).toBe('Copy');
    expect(btn.getAttribute('aria-label')).toBe('Copy code to clipboard');
  });

  it('handles image click callback', async () => {
    const onImageClick = vi.fn();
    const html = '<p><img src="https://example.com/img.png" alt="Test image" /></p>';

    const { container } = render(
      <ArticleViewer content={html} onImageClick={onImageClick} />,
    );

    // Wait for TipTap to render the image and for the rAF-based effect to run
    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img).toBeTruthy();
      expect(img?.style.cursor).toBe('zoom-in');
    });
  });

  it('renders mermaid code blocks as MermaidDiagram components', async () => {
    const html = '<pre><code class="language-mermaid">graph TD\n  A --> B</code></pre>';

    const { container } = render(<ArticleViewer content={html} />);

    // The mermaid code block should be replaced with a MermaidDiagram wrapper
    await waitFor(() => {
      const wrapper = container.querySelector('.mermaid-diagram-wrapper');
      expect(wrapper).toBeTruthy();
    });

    // The original <pre> element should no longer exist (replaced by the wrapper)
    const pre = container.querySelector('pre > code.language-mermaid');
    expect(pre).toBeNull();
  });

  it('renders regular code blocks normally alongside mermaid diagrams', async () => {
    const html = '<pre><code class="language-javascript">const x = 1;</code></pre><pre><code class="language-mermaid">graph TD\n  A --> B</code></pre>';

    const { container } = render(<ArticleViewer content={html} />);

    // Wait for rendering
    await waitFor(() => {
      // Mermaid block should be replaced
      const wrapper = container.querySelector('.mermaid-diagram-wrapper');
      expect(wrapper).toBeTruthy();
    });

    // Regular code block should still exist with copy button
    await waitFor(() => {
      const copyBtn = container.querySelector('.code-copy-btn');
      expect(copyBtn).toBeTruthy();
    });
  });

  it('renders code blocks with data-title attribute', async () => {
    const html = '<pre data-title="docker-compose.yml"><code class="language-yaml">version: "3.8"</code></pre>';

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('pre')).toBeTruthy();
    });

    const pre = container.querySelector('pre')!;
    expect(pre.getAttribute('data-title')).toBe('docker-compose.yml');
  });

  it('renders code blocks without data-title normally', async () => {
    const html = '<pre><code class="language-bash">echo "hello"</code></pre>';

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      expect(container.querySelector('pre')).toBeTruthy();
    });

    const pre = container.querySelector('pre')!;
    expect(pre.getAttribute('data-title')).toBeNull();
  });

  it('applies prose-invert class only in dark theme', async () => {
    const html = '<p>Dark theme content</p>';

    const { container } = render(<ArticleViewer content={html} />);

    await waitFor(() => {
      const editorContent = container.querySelector('.article-viewer');
      expect(editorContent).toBeTruthy();
    });

    const editorContent = container.querySelector('.article-viewer')!;
    // useIsLightTheme is mocked to return false (dark theme), so prose-invert should be present
    expect(editorContent.classList.contains('prose-invert')).toBe(true);
  });

  it('renders empty mermaid code blocks with empty state placeholder', async () => {
    const html = '<pre><code class="language-mermaid">   </code></pre>';

    const { container } = render(<ArticleViewer content={html} />);

    // The wrapper renders but shows an empty-state message instead of a diagram
    await waitFor(() => {
      expect(container.querySelector('.mermaid-diagram-wrapper')).toBeTruthy();
    });

    // MermaidDiagram should NOT be invoked for empty code (no mermaid-container)
    expect(container.querySelector('.mermaid-container')).toBeNull();
  });
});
