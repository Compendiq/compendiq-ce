import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    pageId: 123,
    confluenceId: 'page-123',
    sectionTitle: 'Installation',
    score: 0.85,
  },
  {
    pageTitle: 'API Reference',
    spaceKey: 'DEV',
    pageId: 456,
    confluenceId: 'page-456',
    score: 0.6,
  },
  {
    pageTitle: 'FAQ',
    spaceKey: 'HELP',
    pageId: 789,
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

  it('navigates by internal page id when chip is clicked', () => {
    render(<CitationChips sources={mockSources} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('citation-chip-1'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/123');
  });

  it('navigates to correct page for each chip', () => {
    render(<CitationChips sources={mockSources} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('citation-chip-3'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/789');
  });

  // ── #1125 ────────────────────────────────────────────────────────────────

  it('navigates a locally-created page (null confluenceId) by page id', () => {
    render(
      <CitationChips sources={[{ pageTitle: 'My Article', spaceKey: 'Local', pageId: 55, confluenceId: null }]} />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByTestId('citation-chip-1'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/55');
  });

  it('opens a web source in a new tab instead of routing into /pages/', () => {
    render(
      <CitationChips
        sources={[{
          pageTitle: 'Linux',
          spaceKey: 'Web',
          pageId: 0,
          confluenceId: 'https://en.wikipedia.org/wiki/Linux',
          url: 'https://en.wikipedia.org/wiki/Linux',
        }]}
      />,
      { wrapper: Wrapper },
    );

    const chip = screen.getByTestId('citation-chip-1');
    expect(chip.tagName).toBe('A');
    expect(chip).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Linux');
    expect(chip).toHaveAttribute('target', '_blank');
    expect(chip).toHaveAttribute('rel', 'noopener noreferrer');

    fireEvent.click(chip);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('renders a source with no usable target as a non-link', () => {
    render(
      <CitationChips sources={[{ pageTitle: 'Orphan', spaceKey: 'Web', confluenceId: null }]} />,
      { wrapper: Wrapper },
    );

    const chip = screen.getByTestId('citation-chip-1');
    expect(chip.tagName).toBe('SPAN');
    fireEvent.click(chip);
    expect(mockNavigate).not.toHaveBeenCalled();
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

  // ── Image sources (#1115 P3) ─────────────────────────────────────────────
  //
  // This component is what the DOCK renders for a message's sources
  // (`DockPanel` → `CitationChips`), so these cover the article-side assistant
  // as well as `/ai`'s inline chips.

  describe('image sources', () => {
    const imageSource: Source = {
      kind: 'image',
      pageTitle: 'Turbine assembly',
      pageId: 77,
      attachmentUrl: '/api/attachments/77/turbine.png',
      similarity: null,
      score: 0.0328,
    };

    beforeEach(() => {
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumb');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    });

    function mockAttachmentFetch(ok = true) {
      const fetchMock = vi.fn(async () =>
        ok
          ? ({ ok: true, status: 200, blob: async () => new Blob(['x']) } as unknown as Response)
          : ({ ok: false, status: 404, blob: async () => new Blob() } as unknown as Response),
      );
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('renders a thumbnail inside the numbered chip and names the control', async () => {
      const fetchMock = mockAttachmentFetch();
      render(<CitationChips sources={[imageSource]} />, { wrapper: Wrapper });

      const chip = screen.getByTestId('citation-chip-1');
      // The number stays — the answer text refers to it by position.
      expect(chip).toHaveTextContent('1');
      // The picture is decorative, so the CONTROL carries the name.
      expect(chip).toHaveAttribute('aria-label', 'Turbine assembly — image');

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(fetchMock.mock.calls[0]![0]).toBe('/api/attachments/77/turbine.png');
      const thumb = await screen.findByTestId('source-thumbnail');
      expect(thumb).toHaveAttribute('alt', '');
      expect(thumb).toHaveAttribute('aria-hidden', 'true');
    });

    it('navigates to the PAGE, never to the attachment', async () => {
      mockAttachmentFetch();
      render(<CitationChips sources={[imageSource]} />, { wrapper: Wrapper });
      fireEvent.click(screen.getByTestId('citation-chip-1'));
      expect(mockNavigate).toHaveBeenCalledWith('/pages/77');
    });

    it('degrades to the plain numbered chip when the thumbnail cannot be loaded', async () => {
      mockAttachmentFetch(false);
      render(<CitationChips sources={[imageSource]} />, { wrapper: Wrapper });

      await waitFor(() =>
        expect(screen.queryByTestId('source-thumbnail')).not.toBeInTheDocument(),
      );
      const chip = screen.getByTestId('citation-chip-1');
      expect(chip).toHaveTextContent('1');
      expect(chip).toHaveAttribute('aria-label', 'Turbine assembly — image');
      fireEvent.click(chip);
      expect(mockNavigate).toHaveBeenCalledWith('/pages/77');
    });

    it('leaves an ordinary page chip untouched', () => {
      render(<CitationChips sources={[mockSources[0]]} />, { wrapper: Wrapper });
      expect(screen.queryByTestId('source-thumbnail')).not.toBeInTheDocument();
      expect(screen.getByTestId('citation-chip-1')).not.toHaveAttribute('aria-label');
    });
  });
});
