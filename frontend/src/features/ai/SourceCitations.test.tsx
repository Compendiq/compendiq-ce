import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
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
      <LazyMotion features={domAnimation}>
        {children}
      </LazyMotion>
    </MemoryRouter>
  );
}

const mockSources: Source[] = [
  {
    pageTitle: 'Getting Started Guide',
    spaceKey: 'DOCS',
    pageId: 123,
    confluenceId: 'page-123',
    sectionTitle: 'Installation',
  },
  {
    pageTitle: 'API Reference',
    spaceKey: 'DEV',
    pageId: 456,
    confluenceId: 'page-456',
  },
  {
    pageTitle: 'FAQ',
    spaceKey: 'HELP',
    pageId: 789,
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

  it('navigates by internal page id when source card is clicked', () => {
    render(<SourceCitations sources={mockSources} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('Sources (3)'));

    fireEvent.click(screen.getByText('Getting Started Guide'));

    expect(mockNavigate).toHaveBeenCalledWith('/pages/123');
  });

  // ── #1125 ────────────────────────────────────────────────────────────────

  it('navigates a locally-created page (null confluenceId) by page id', () => {
    render(
      <SourceCitations sources={[{ pageTitle: 'My Article', spaceKey: 'Local', pageId: 55, confluenceId: null }]} />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByText('Sources (1)'));
    fireEvent.click(screen.getByText('My Article'));

    expect(mockNavigate).toHaveBeenCalledWith('/pages/55');
  });

  it('omits the space chip for a standalone page (space_key is NULL)', () => {
    // A page with a space is the control: exactly one of the two cards may
    // carry the Layers chip, so the assertion can't pass vacuously.
    const { container } = render(
      <SourceCitations
        sources={[
          { pageTitle: 'My Article', spaceKey: null, pageId: 55, confluenceId: null },
          { pageTitle: 'Synced Page', spaceKey: 'DOCS', pageId: 56, confluenceId: 'page-56' },
        ]}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByText('Sources (2)'));

    // The standalone card must not render a lone Layers icon with a blank label.
    expect(screen.getByTestId('source-card-1')).toHaveTextContent('My Article');
    expect(screen.getByTestId('source-card-1').querySelectorAll('.lucide-layers')).toHaveLength(0);
    expect(container.querySelectorAll('.lucide-layers')).toHaveLength(1);
  });

  it('renders a web source as an external link instead of routing into /pages/', () => {
    render(
      <SourceCitations
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
    fireEvent.click(screen.getByText('Sources (1)'));

    const card = screen.getByTestId('source-card-1');
    expect(card.tagName).toBe('A');
    expect(card).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Linux');
    expect(card).toHaveAttribute('target', '_blank');
    expect(card).toHaveAttribute('rel', 'noopener noreferrer');

    fireEvent.click(card);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('renders a source with no usable target as a non-link', () => {
    render(
      <SourceCitations sources={[{ pageTitle: 'Orphan', spaceKey: 'Web', confluenceId: null }]} />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByText('Sources (1)'));

    const card = screen.getByTestId('source-card-1');
    expect(card.tagName).toBe('DIV');
    fireEvent.click(card);
    expect(mockNavigate).not.toHaveBeenCalled();
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

  // ── Image sources (#1115 P3) ─────────────────────────────────────────────

  describe('image sources', () => {
    const imageSource: Source = {
      kind: 'image',
      pageTitle: 'Turbine assembly',
      spaceKey: 'ENG',
      pageId: 77,
      attachmentUrl: '/api/attachments/77/turbine.png',
      similarity: null,
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

    it('renders the thumbnail, the category label and a link to the PAGE', async () => {
      const fetchMock = mockAttachmentFetch();
      render(<SourceCitations sources={[imageSource]} />, { wrapper: Wrapper });
      fireEvent.click(screen.getByText('Sources (1)'));

      // The picture is fetched through the authenticated route, not set as a
      // bare `src` (which would 401).
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(fetchMock.mock.calls[0]![0]).toBe('/api/attachments/77/turbine.png');
      const thumb = await screen.findByTestId('source-thumbnail');
      // Decorative: the title beside it is the accessible name.
      expect(thumb).toHaveAttribute('alt', '');
      expect(thumb).toHaveAttribute('aria-hidden', 'true');

      expect(screen.getByTestId('source-image-label')).toHaveTextContent('Image');
      expect(screen.getByText('Turbine assembly')).toBeInTheDocument();

      // The control navigates to the page, never to the attachment.
      fireEvent.click(screen.getByTestId('source-card-1'));
      expect(mockNavigate).toHaveBeenCalledWith('/pages/77');
    });

    it('degrades to the title-only card when the thumbnail cannot be loaded', async () => {
      mockAttachmentFetch(false);
      render(<SourceCitations sources={[imageSource]} />, { wrapper: Wrapper });
      fireEvent.click(screen.getByText('Sources (1)'));

      await waitFor(() =>
        expect(screen.queryByTestId('source-thumbnail')).not.toBeInTheDocument(),
      );
      // Still a complete, operable citation — the label and the link survive.
      expect(screen.getByTestId('source-image-label')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('source-card-1'));
      expect(mockNavigate).toHaveBeenCalledWith('/pages/77');
    });

    it('leaves an ordinary page source alone — no thumbnail, no label', () => {
      render(<SourceCitations sources={[mockSources[0]]} />, { wrapper: Wrapper });
      fireEvent.click(screen.getByText('Sources (1)'));
      expect(screen.queryByTestId('source-thumbnail')).not.toBeInTheDocument();
      expect(screen.queryByTestId('source-image-label')).not.toBeInTheDocument();
      expect(screen.queryByTestId('source-image-file')).not.toBeInTheDocument();
    });

    it('names the picture, so two hits on one page are distinguishable (review r1)', () => {
      // One page contributes up to `MAX_IMAGE_HITS_PER_PAGE` (3) entries, and
      // the title, the space and the destination are identical on all of them
      // — with the thumbnail decorative by design, these cards were three
      // visually and programmatically identical citations.
      mockAttachmentFetch();
      render(
        <SourceCitations
          sources={[
            imageSource,
            { ...imageSource, attachmentUrl: '/api/attachments/77/rotor%20detail.png' },
          ]}
        />,
        { wrapper: Wrapper },
      );
      fireEvent.click(screen.getByText('Sources (2)'));

      expect(screen.getAllByTestId('source-image-file').map((n) => n.textContent))
        .toEqual(['turbine.png', 'rotor detail.png']);
      // …and the cards' own accessible names differ, since the name comes
      // from their content.
      const names = [1, 2].map((n) => screen.getByTestId(`source-card-${n}`).textContent);
      expect(new Set(names).size).toBe(2);
    });

    it('keeps the category label alone when the URL carries no filename', () => {
      mockAttachmentFetch();
      render(
        <SourceCitations sources={[{ ...imageSource, attachmentUrl: '/api/attachments/77/' }]} />,
        { wrapper: Wrapper },
      );
      fireEvent.click(screen.getByText('Sources (1)'));
      expect(screen.getByTestId('source-image-label')).toHaveTextContent('Image');
      expect(screen.queryByTestId('source-image-file')).not.toBeInTheDocument();
    });

    it('degrades to the ordinary page card when kind says image but no URL arrived', () => {
      // Review r3. `isImageSource` requires the URL as well as the
      // discriminator, and the guard was untested: with it removed the card
      // takes the image branch with nothing to render, and
      // `imageSourceFileName` reaches `.split` on `undefined` and THROWS
      // during render, taking the whole message list with it. The check and
      // the thing it unlocks have to be the same fact.
      const { kind, pageTitle, pageId } = imageSource;
      render(
        <SourceCitations sources={[{ kind, pageTitle, pageId } as Source]} />,
        { wrapper: Wrapper },
      );
      fireEvent.click(screen.getByText('Sources (1)'));

      expect(screen.queryByTestId('source-thumbnail')).not.toBeInTheDocument();
      expect(screen.queryByTestId('source-image-label')).not.toBeInTheDocument();
      expect(screen.queryByTestId('source-image-file')).not.toBeInTheDocument();
      // …and it is still a working citation, not a hole.
      expect(screen.getByText('Turbine assembly')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('source-card-1'));
      expect(mockNavigate).toHaveBeenCalledWith('/pages/77');
    });
  });
});
