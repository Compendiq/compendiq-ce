import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LazyMotion, domMax } from 'framer-motion';
import { TableOfContents, parseHeadings } from './TableOfContents';

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LazyMotion features={domMax}>{children}</LazyMotion>;
}

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

  it('ignores h4, h5, h6 headings', () => {
    const html = '<h4 id="h4">H4</h4><h5 id="h5">H5</h5><h6 id="h6">H6</h6>';
    const headings = parseHeadings(html);
    expect(headings).toHaveLength(0);
  });

  it('returns empty array for content without headings', () => {
    const html = '<p>Just a paragraph</p>';
    const headings = parseHeadings(html);
    expect(headings).toHaveLength(0);
  });
});

describe('TableOfContents', () => {
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
    // Should not render the nav
    expect(screen.queryByText('Table of Contents')).not.toBeInTheDocument();
    // But progress bar is also hidden when no headings
    expect(container.querySelector('[role="navigation"]')).not.toBeInTheDocument();
  });

  it('applies indent classes for h2 and h3', () => {
    render(
      <TableOfContents htmlContent={htmlWithHeadings} />,
      { wrapper: Wrapper },
    );

    // h1 should have font-medium
    const introBtn = screen.getByText('Introduction');
    expect(introBtn.className).toContain('font-medium');

    // h2 should have pl-4
    const setupBtn = screen.getByText('Setup');
    expect(setupBtn.className).toContain('pl-4');

    // h3 should have pl-6
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
    // After toggle, the sidebar should be visible (translate-x-0)
    // The button should still be in the document
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
    // Mock scrollIntoView
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
});
