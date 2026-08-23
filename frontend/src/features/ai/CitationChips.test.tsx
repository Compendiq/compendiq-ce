import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CitationChips } from './CitationChips';
import type { Source } from './SourceCitations';
import { installIntersectionObserverStub } from '../../test-utils';

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

    // #1361: the thumbnail waits for its sentinel to intersect. jsdom never
    // lays anything out, so the test drives the observer itself.
    let observer: ReturnType<typeof installIntersectionObserverStub>;
    beforeEach(() => {
      observer = installIntersectionObserverStub();
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumb');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    });

    /** Bring every mounted thumbnail into view. */
    async function scrollIntoView() {
      await act(async () => {
        observer.intersectAll();
      });
    }

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
      await scrollIntoView();

      const chip = screen.getByTestId('citation-chip-1');
      // The number stays — the answer text refers to it by position.
      expect(chip).toHaveTextContent('1');
      // The picture is decorative, so the CONTROL carries the name — page
      // first, then the picture, because one page can contribute three.
      expect(chip).toHaveAttribute('aria-label', 'Turbine assembly — image: turbine.png');

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(fetchMock.mock.calls[0]![0]).toBe('/api/attachments/77/turbine.png');
      const thumb = await screen.findByTestId('source-thumbnail');
      expect(thumb).toHaveAttribute('alt', '');
      expect(thumb).toHaveAttribute('aria-hidden', 'true');
    });

    it('navigates to the PAGE, never to the attachment', async () => {
      mockAttachmentFetch();
      render(<CitationChips sources={[imageSource]} />, { wrapper: Wrapper });
      await scrollIntoView();
      fireEvent.click(screen.getByTestId('citation-chip-1'));
      expect(mockNavigate).toHaveBeenCalledWith('/pages/77');
    });

    it('degrades to the plain numbered chip when the thumbnail cannot be loaded', async () => {
      mockAttachmentFetch(false);
      render(<CitationChips sources={[imageSource]} />, { wrapper: Wrapper });
      await scrollIntoView();

      await waitFor(() =>
        expect(screen.queryByTestId('source-thumbnail')).not.toBeInTheDocument(),
      );
      const chip = screen.getByTestId('citation-chip-1');
      expect(chip).toHaveTextContent('1');
      expect(chip).toHaveAttribute('aria-label', 'Turbine assembly — image: turbine.png');
      fireEvent.click(chip);
      expect(mockNavigate).toHaveBeenCalledWith('/pages/77');
    });

    it('leaves an ordinary page chip untouched', () => {
      render(<CitationChips sources={[mockSources[0]]} />, { wrapper: Wrapper });
      expect(screen.queryByTestId('source-thumbnail')).not.toBeInTheDocument();
      expect(screen.getByTestId('citation-chip-1')).not.toHaveAttribute('aria-label');
    });

    it('tells two pictures from the SAME page apart (review r1)', async () => {
      // `MAX_IMAGE_HITS_PER_PAGE` is 3, so one page really does contribute
      // several entries, and every other field on them is identical — same
      // title, same space, same destination — while the thumbnails are
      // deliberately decorative. Without the filename these announce as three
      // copies of one name over the surface whose subject IS the pictures.
      mockAttachmentFetch();
      render(
        <CitationChips
          sources={[
            imageSource,
            { ...imageSource, attachmentUrl: '/api/attachments/77/rotor%20detail.png' },
          ]}
        />,
        { wrapper: Wrapper },
      );
      await scrollIntoView();

      const labels = [1, 2].map((n) =>
        screen.getByTestId(`citation-chip-${n}`).getAttribute('aria-label'),
      );
      expect(labels).toEqual([
        'Turbine assembly — image: turbine.png',
        // Percent-encoded on the wire, readable in the name.
        'Turbine assembly — image: rotor detail.png',
      ]);
      expect(new Set(labels).size).toBe(2);
    });

    it('degrades to the ordinary numbered chip when kind says image but no URL arrived', () => {
      // Review r3. `isImageSource` requires the URL as well as the
      // discriminator. Untested, the guard could be reduced to `kind ===
      // 'image'` with the whole frontend suite green — after which a
      // malformed frame renders an empty `<img>`, takes an `aria-label`
      // promising a picture on a chip that has none, and
      // `imageSourceFileName` THROWS on `undefined.split` mid-render.
      const { kind, pageTitle, pageId } = imageSource;
      render(<CitationChips sources={[{ kind, pageTitle, pageId } as Source]} />, { wrapper: Wrapper });

      const chip = screen.getByTestId('citation-chip-1');
      expect(screen.queryByTestId('source-thumbnail')).not.toBeInTheDocument();
      expect(chip).not.toHaveAttribute('aria-label');
      expect(chip).toHaveTextContent('1');
      fireEvent.click(chip);
      expect(mockNavigate).toHaveBeenCalledWith('/pages/77');
    });

    it('keeps the unqualified name when the URL carries no filename', async () => {
      // A placeholder would be worse than nothing: the plain label is already
      // the correct name for a page contributing one picture.
      mockAttachmentFetch();
      render(
        <CitationChips sources={[{ ...imageSource, attachmentUrl: '/api/attachments/77/' }]} />,
        { wrapper: Wrapper },
      );
      await scrollIntoView();
      expect(screen.getByTestId('citation-chip-1'))
        .toHaveAttribute('aria-label', 'Turbine assembly — image');
    });
  });

  // Amendment item 4 (#1361): `CitationChips` renders on EVERY answer, and each
  // image source pulls the FULL attachment (no server-side resize, ADR-025) to
  // paint a 14px square. A reopened N-turn thread would issue N × 4 of them in
  // one gesture. The bound lives inside SourceThumbnail so both surfaces get it.
  describe('thumbnails are viewport-gated', () => {
    const imageSource: Source = {
      kind: 'image',
      pageTitle: 'Turbine assembly',
      pageId: 77,
      attachmentUrl: '/api/attachments/77/turbine.png',
      similarity: null,
    };

    function mockAttachmentFetch() {
      const fetchMock = vi.fn(async () =>
        ({ ok: true, status: 200, blob: async () => new Blob(['x']) } as unknown as Response));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('fetches nothing for eight thumbnails that never come into view', async () => {
      // The assertion that would have failed on the pre-gate component: eight
      // fetches at mount.
      installIntersectionObserverStub();
      const fetchMock = mockAttachmentFetch();

      const sources = Array.from({ length: 8 }, (_, i) => ({
        ...imageSource,
        attachmentUrl: `/api/attachments/77/frame-${i}.png`,
      }));
      render(<CitationChips sources={sources} />, { wrapper: Wrapper });

      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId('source-thumbnail')).not.toBeInTheDocument();
      // Nothing with layout stands in for them, so no placeholder boxes and no
      // layout shift when they do arrive.
      expect(screen.getAllByTestId('source-thumbnail-sentinel')).toHaveLength(8);
    });

    it('fetches exactly the thumbnails that intersect', async () => {
      const observer = installIntersectionObserverStub();
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumb');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      const fetchMock = mockAttachmentFetch();

      render(<CitationChips sources={[imageSource]} />, { wrapper: Wrapper });
      expect(fetchMock).not.toHaveBeenCalled();

      await act(async () => {
        observer.intersectAll();
      });

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls[0]![0]).toBe('/api/attachments/77/turbine.png');
      expect(await screen.findByTestId('source-thumbnail')).toBeInTheDocument();
    });
  });

  // #1361: a reopened answer can cite a page the reader has since lost. The
  // number stays — the answer text refers to it — but nothing about it is
  // operable, and the title says why.
  describe('unavailable sources', () => {
    it('renders an inert chip naming the reader’s access, not the page', () => {
      render(
        <CitationChips sources={[{ pageTitle: 'Secret Runbook', pageId: 42, unavailable: true }]} />,
        { wrapper: Wrapper },
      );
      const chip = screen.getByTestId('citation-chip-1');
      expect(chip.tagName).toBe('SPAN');
      expect(chip).toHaveTextContent('1');
      expect(chip).toHaveAttribute('title', 'This page is no longer available to you');
      fireEvent.click(chip);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('issues no attachment fetch for an unavailable image source', async () => {
      // Bring any mounted thumbnail into view: without this, the viewport gate
      // (not the `target.kind` check this test is pinning) would be why
      // nothing fetched, and this would stay green with Task 16's guard
      // reverted.
      const observer = installIntersectionObserverStub();
      const fetchMock = vi.fn(async () =>
        ({ ok: true, status: 200, blob: async () => new Blob(['x']) } as unknown as Response));
      vi.stubGlobal('fetch', fetchMock);

      render(
        <CitationChips
          sources={[{
            kind: 'image',
            pageTitle: 'Secret Runbook',
            pageId: 42,
            attachmentUrl: '/api/attachments/42/diagram.png',
            similarity: null,
            unavailable: true,
          }]}
        />,
        { wrapper: Wrapper },
      );
      await act(async () => {
        observer.intersectAll();
      });

      expect(screen.queryByTestId('source-thumbnail')).not.toBeInTheDocument();
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
