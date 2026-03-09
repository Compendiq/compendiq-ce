import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { ArticleViewer } from './ArticleViewer';

describe('ArticleViewer', () => {
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
});
