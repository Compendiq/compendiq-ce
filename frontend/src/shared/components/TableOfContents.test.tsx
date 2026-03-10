import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LazyMotion, domMax } from 'framer-motion';
import { TableOfContents, parseHeadings, buildTree } from './TableOfContents';

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LazyMotion features={domMax}>{children}</LazyMotion>;
}

// ---------- parseHeadings ----------

describe('parseHeadings', () => {
  it('parses h1 headings from HTML', () => {
    const html = '<h1 id="intro">Introduction</h1><p>text</p>';
    const headings = parseHeadings(html);
    expect(headings).toHaveLength(1);
    expect(headings[0]).toEqual({ id: 'intro', text: 'Introduction', level: 1 });
  });

  it('parses h1, h2, h3 headings', () => {
    const html = `
      <h1 id="main">Main Title</h1>
      <h2 id="sub1">Subtitle 1</h2>
      <h3 id="sub1a">Sub-subtitle</h3>
      <h2 id="sub2">Subtitle 2</h2>
    `;
    const headings = parseHeadings(html);
    expect(headings).toHaveLength(4);
    expect(headings[0].level).toBe(1);
    expect(headings[1].level).toBe(2);
    expect(headings[2].level).toBe(3);
    expect(headings[3].level).toBe(2);
  });

  it('parses h4 headings', () => {
    const html = '<h4 id="deep">Deep heading</h4>';
    const headings = parseHeadings(html);
    expect(headings).toHaveLength(1);
    expect(headings[0]).toEqual({ id: 'deep', text: 'Deep heading', level: 4 });
  });

  it('ignores h5, h6 headings', () => {
    const html = '<h5 id="h5">H5</h5><h6 id="h6">H6</h6>';
    const headings = parseHeadings(html);
    expect(headings).toHaveLength(0);
  });

  it('skips empty headings', () => {
    const html = '<h1 id="real">Real Heading</h1><h2 id="empty"></h2>';
    const headings = parseHeadings(html);
    expect(headings).toHaveLength(1);
  });

  it('generates id when not present', () => {
    const html = '<h1>No ID Heading</h1>';
    const headings = parseHeadings(html);
    expect(headings).toHaveLength(1);
    expect(headings[0].id).toBe('heading-0');
  });

  it('returns empty array for content without headings', () => {
    const html = '<p>Just a paragraph</p>';
    const headings = parseHeadings(html);
    expect(headings).toHaveLength(0);
  });
});

// ---------- buildTree ----------

describe('buildTree', () => {
  it('returns empty array for empty input', () => {
    expect(buildTree([])).toEqual([]);
  });

  it('makes a flat list of h1s when no nesting', () => {
    const headings = [
      { id: 'a', text: 'A', level: 1 },
      { id: 'b', text: 'B', level: 1 },
    ];
    const tree = buildTree(headings);
    expect(tree).toHaveLength(2);
    expect(tree[0].children).toHaveLength(0);
    expect(tree[1].children).toHaveLength(0);
  });

  it('nests h2 under h1', () => {
    const headings = [
      { id: 'h1', text: 'H1', level: 1 },
      { id: 'h2', text: 'H2', level: 2 },
    ];
    const tree = buildTree(headings);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].heading.id).toBe('h2');
  });

  it('nests h3 under h2 under h1', () => {
    const headings = [
      { id: 'h1', text: 'H1', level: 1 },
      { id: 'h2', text: 'H2', level: 2 },
      { id: 'h3', text: 'H3', level: 3 },
    ];
    const tree = buildTree(headings);
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].children[0].heading.id).toBe('h3');
  });

  it('resets nesting when a higher level heading appears', () => {
    const headings = [
      { id: 'h1a', text: 'H1 A', level: 1 },
      { id: 'h2',  text: 'H2',   level: 2 },
      { id: 'h1b', text: 'H1 B', level: 1 },
    ];
    const tree = buildTree(headings);
    expect(tree).toHaveLength(2);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[1].children).toHaveLength(0);
  });

  it('multiple h2 siblings under one h1', () => {
    const headings = [
      { id: 'h1',  text: 'H1',  level: 1 },
      { id: 'h2a', text: 'H2A', level: 2 },
      { id: 'h2b', text: 'H2B', level: 2 },
    ];
    const tree = buildTree(headings);
    expect(tree[0].children).toHaveLength(2);
  });
});

// ---------- TableOfContents component ----------

const htmlWithHeadings = `
  <h1 id="intro">Introduction</h1>
  <p>Some text</p>
  <h2 id="setup">Setup</h2>
  <p>Setup instructions</p>
  <h3 id="prereqs">Prerequisites</h3>
  <p>More text</p>
  <h2 id="usage">Usage</h2>
  <p>Usage info</p>
`;

describe('TableOfContents', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders table of contents with headings', () => {
    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText('Table of Contents')).toBeInTheDocument();
    expect(screen.getByText('Introduction')).toBeInTheDocument();
    expect(screen.getByText('Setup')).toBeInTheDocument();
    expect(screen.getByText('Prerequisites')).toBeInTheDocument();
    expect(screen.getByText('Usage')).toBeInTheDocument();
  });

  it('renders nothing when no headings in content', () => {
    const { container } = render(
      <TableOfContents htmlContent="<p>No headings here</p>" />,
      { wrapper: Wrapper },
    );
    expect(screen.queryByText('Table of Contents')).not.toBeInTheDocument();
    expect(container.querySelector('[role="navigation"]')).not.toBeInTheDocument();
  });

  it('applies indent classes for h2 and h3', () => {
    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );

    const introBtn = screen.getByText('Introduction');
    expect(introBtn.className).toContain('font-medium');

    const setupBtn = screen.getByText('Setup');
    expect(setupBtn.className).toContain('pl-4');

    const prereqsBtn = screen.getByText('Prerequisites');
    expect(prereqsBtn.className).toContain('pl-6');
  });

  it('has a mobile toggle button', () => {
    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );
    expect(screen.getByLabelText('Toggle table of contents')).toBeInTheDocument();
  });

  it('toggles mobile menu on button click', () => {
    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );
    const toggleBtn = screen.getByLabelText('Toggle table of contents');
    fireEvent.click(toggleBtn);
    expect(toggleBtn).toBeInTheDocument();
  });

  it('has navigation role for accessibility', () => {
    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );
    expect(screen.getByRole('navigation', { name: 'Table of contents' })).toBeInTheDocument();
  });

  it('calls scrollIntoView when heading is clicked', () => {
    const mockScrollIntoView = vi.fn();
    const el = document.createElement('div');
    el.id = 'intro';
    el.scrollIntoView = mockScrollIntoView;
    document.body.appendChild(el);

    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByText('Introduction'));
    expect(mockScrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });

    document.body.removeChild(el);
  });

  // ---------- Panel fold toggle ----------

  it('renders the panel fold toggle button', () => {
    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );
    expect(screen.getByTestId('toc-panel-toggle')).toBeInTheDocument();
  });

  it('panel fold toggle hides nav content when clicked', () => {
    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );
    // Nav content is visible by default
    expect(screen.getByTestId('toc-nav-content')).toBeInTheDocument();
    // Click to collapse
    fireEvent.click(screen.getByTestId('toc-panel-toggle'));
    expect(screen.queryByTestId('toc-nav-content')).not.toBeInTheDocument();
  });

  it('panel fold toggle re-shows nav content when clicked again', () => {
    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByTestId('toc-panel-toggle'));
    expect(screen.queryByTestId('toc-nav-content')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('toc-panel-toggle'));
    expect(screen.getByTestId('toc-nav-content')).toBeInTheDocument();
  });

  it('panel fold toggle aria-label changes based on state', () => {
    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );
    const btn = screen.getByTestId('toc-panel-toggle');
    expect(btn).toHaveAttribute('aria-label', 'Collapse outline');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-label', 'Expand outline');
  });

  // ---------- Section collapse ----------

  it('renders chevron toggle for headings that have children', () => {
    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );
    // "intro" (h1) has children (Setup, Usage as h2s), so it has a toggle
    expect(screen.getByTestId('toc-toggle-intro')).toBeInTheDocument();
  });

  it('does not render a chevron for leaf headings', () => {
    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );
    // "usage" is a leaf h2 (no h3 under it), so no toggle
    expect(screen.queryByTestId('toc-toggle-usage')).not.toBeInTheDocument();
  });

  it('section collapse toggle hides children when clicked', () => {
    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );
    // Setup and Usage are children of Introduction (h1)
    expect(screen.getByText('Setup')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('toc-toggle-intro'));
    expect(screen.queryByText('Setup')).not.toBeInTheDocument();
    expect(screen.queryByText('Usage')).not.toBeInTheDocument();
    // Introduction itself remains visible
    expect(screen.getByText('Introduction')).toBeInTheDocument();
  });

  it('section collapse toggle re-expands when clicked again', () => {
    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByTestId('toc-toggle-intro'));
    expect(screen.queryByText('Setup')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('toc-toggle-intro'));
    expect(screen.getByText('Setup')).toBeInTheDocument();
  });

  // ---------- localStorage persistence ----------

  it('persists panel closed state to localStorage', () => {
    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByTestId('toc-panel-toggle'));
    expect(localStorage.getItem('toc-panel-open')).toBe('false');
  });

  it('persists panel open state to localStorage', () => {
    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );
    // Default is open
    expect(localStorage.getItem('toc-panel-open')).toBe('true');
  });

  it('restores panel closed state from localStorage', () => {
    localStorage.setItem('toc-panel-open', 'false');
    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );
    expect(screen.queryByTestId('toc-nav-content')).not.toBeInTheDocument();
  });

  it('persists collapsed section IDs to localStorage', () => {
    render(
      <TableOfContents htmlContent={htmlWithHeadings} pageId="page-1" />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByTestId('toc-toggle-intro'));
    const stored = JSON.parse(localStorage.getItem('toc-collapsed-page-1') ?? '[]') as string[];
    expect(stored).toContain('intro');
  });

  it('restores collapsed sections from localStorage', () => {
    localStorage.setItem('toc-collapsed-page-1', JSON.stringify(['intro']));
    render(
      <TableOfContents htmlContent={htmlWithHeadings} pageId="page-1" />,
      { wrapper: Wrapper },
    );
    // Children of "intro" should not be visible
    expect(screen.queryByText('Setup')).not.toBeInTheDocument();
  });
});
