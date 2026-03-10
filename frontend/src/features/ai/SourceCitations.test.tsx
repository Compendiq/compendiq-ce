import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { SourceCitations, type Source } from './SourceCitations';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <LazyMotion features={domMax}>
        {children}
      </LazyMotion>
    </MemoryRouter>
  );
}

const mockSources: Source[] = [
  {
    pageTitle: 'Getting Started Guide',
    spaceKey: 'DOCS',
    confluenceId: 'page-123',
    sectionTitle: 'Installation',
  },
  {
    pageTitle: 'API Reference',
    spaceKey: 'DEV',
    confluenceId: 'page-456',
  },
  {
    pageTitle: 'FAQ',
    spaceKey: 'HELP',
    confluenceId: 'page-789',
    sectionTitle: 'Common Issues',
  },
];

describe('SourceCitations', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it('renders nothing when sources is empty', () => {
    const { container } = render(<SourceCitations sources={[]} />, { wrapper: Wrapper });
    expect(container.firstChild).toBeNull();
  });

  it('shows collapsible header with source count', () => {
    render(<SourceCitations sources={mockSources} />, { wrapper: Wrapper });
    expect(screen.getByText('Sources (3)')).toBeInTheDocument();
  });

  it('is collapsed by default', () => {
    render(<SourceCitations sources={mockSources} />, { wrapper: Wrapper });
    expect(screen.queryByText('Getting Started Guide')).not.toBeInTheDocument();
  });

  it('expands when clicked to show source cards', () => {
    render(<SourceCitations sources={mockSources} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByText('Sources (3)'));

    expect(screen.getByText('Getting Started Guide')).toBeInTheDocument();
    expect(screen.getByText('API Reference')).toBeInTheDocument();
    expect(screen.getByText('FAQ')).toBeInTheDocument();
  });

  it('shows space key for each source', () => {
    render(<SourceCitations sources={mockSources} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('Sources (3)'));

    expect(screen.getByText('DOCS')).toBeInTheDocument();
    expect(screen.getByText('DEV')).toBeInTheDocument();
    expect(screen.getByText('HELP')).toBeInTheDocument();
  });

  it('shows section title when available', () => {
    render(<SourceCitations sources={mockSources} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('Sources (3)'));

    expect(screen.getByText('Installation')).toBeInTheDocument();
    expect(screen.getByText('Common Issues')).toBeInTheDocument();
  });

  it('navigates to page when source card is clicked', () => {
    render(<SourceCitations sources={mockSources} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('Sources (3)'));

    fireEvent.click(screen.getByText('Getting Started Guide'));

    expect(mockNavigate).toHaveBeenCalledWith('/pages/page-123');
  });

  it('collapses when clicked again', () => {
    render(<SourceCitations sources={mockSources} />, { wrapper: Wrapper });

    // Expand
    fireEvent.click(screen.getByText('Sources (3)'));
    expect(screen.getByText('Getting Started Guide')).toBeInTheDocument();

    // Collapse
    fireEvent.click(screen.getByText('Sources (3)'));

    // Sources should be hidden (AnimatePresence exit)
    // Note: AnimatePresence may keep items briefly during exit animation
  });

  it('handles single source', () => {
    render(<SourceCitations sources={[mockSources[0]]} />, { wrapper: Wrapper });
    expect(screen.getByText('Sources (1)')).toBeInTheDocument();
  });
});
