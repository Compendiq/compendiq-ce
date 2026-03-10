import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CitationChips } from './CitationChips';
import type { Source } from './SourceCitations';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

const mockSources: Source[] = [
  {
    pageTitle: 'Getting Started Guide',
    spaceKey: 'DOCS',
    confluenceId: 'page-123',
    sectionTitle: 'Installation',
    score: 0.85,
  },
  {
    pageTitle: 'API Reference',
    spaceKey: 'DEV',
    confluenceId: 'page-456',
    score: 0.6,
  },
  {
    pageTitle: 'FAQ',
    spaceKey: 'HELP',
    confluenceId: 'page-789',
    sectionTitle: 'Common Issues',
    score: 0.3,
  },
];

describe('CitationChips', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it('renders nothing when sources is empty', () => {
    const { container } = render(<CitationChips sources={[]} />, { wrapper: Wrapper });
    expect(container.firstChild).toBeNull();
  });

  it('renders numbered chips for each source', () => {
    render(<CitationChips sources={mockSources} />, { wrapper: Wrapper });
    expect(screen.getByTestId('citation-chip-1')).toBeInTheDocument();
    expect(screen.getByTestId('citation-chip-2')).toBeInTheDocument();
    expect(screen.getByTestId('citation-chip-3')).toBeInTheDocument();
  });

  it('displays correct numbers in chips', () => {
    render(<CitationChips sources={mockSources} />, { wrapper: Wrapper });
    expect(screen.getByTestId('citation-chip-1')).toHaveTextContent('1');
    expect(screen.getByTestId('citation-chip-2')).toHaveTextContent('2');
    expect(screen.getByTestId('citation-chip-3')).toHaveTextContent('3');
  });

  it('shows page title in tooltip', () => {
    render(<CitationChips sources={mockSources} />, { wrapper: Wrapper });
    expect(screen.getByTestId('citation-chip-1').getAttribute('title')).toBe('Getting Started Guide');
    expect(screen.getByTestId('citation-chip-2').getAttribute('title')).toBe('API Reference');
  });

  it('navigates to page when chip is clicked', () => {
    render(<CitationChips sources={mockSources} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('citation-chip-1'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/page-123');
  });

  it('navigates to correct page for each chip', () => {
    render(<CitationChips sources={mockSources} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('citation-chip-3'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/page-789');
  });

  it('has data-testid on the wrapper', () => {
    render(<CitationChips sources={mockSources} />, { wrapper: Wrapper });
    expect(screen.getByTestId('citation-chips')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    render(<CitationChips sources={mockSources} className="my-class" />, { wrapper: Wrapper });
    expect(screen.getByTestId('citation-chips').className).toContain('my-class');
  });

  it('handles single source', () => {
    render(<CitationChips sources={[mockSources[0]]} />, { wrapper: Wrapper });
    expect(screen.getByTestId('citation-chip-1')).toBeInTheDocument();
    expect(screen.queryByTestId('citation-chip-2')).not.toBeInTheDocument();
  });

  it('stops event propagation on click', () => {
    const outerClick = vi.fn();
    render(
      <div onClick={outerClick}>
        <CitationChips sources={mockSources} />
      </div>,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByTestId('citation-chip-1'));
    expect(outerClick).not.toHaveBeenCalled();
  });
});
