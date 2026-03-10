import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DrawioDiagramPreview } from './DrawioDiagramPreview';

// Mock the authenticated src hook — by default, return the src as a blob URL
// immediately (simulating a successful authenticated fetch).
const mockUseAuthenticatedSrc = vi.fn();
vi.mock('../hooks/use-authenticated-src', () => ({
  useAuthenticatedSrc: (...args: unknown[]) => mockUseAuthenticatedSrc(...args),
}));

describe('DrawioDiagramPreview', () => {
  const defaultProps = {
    src: '/api/attachments/page-1/topology.png',
    diagramName: 'system-topology',
    alt: 'Draw.io diagram: system-topology',
    editHref: 'https://confluence.example.com/pages/viewpage.action?pageId=12345',
  };

  // Default mock: authenticated fetch succeeds, returns a blob URL
  beforeEach(() => {
    mockUseAuthenticatedSrc.mockImplementation((src: string | null) => ({
      blobSrc: src ? `blob:${src}` : null,
      loading: false,
      error: !src,
    }));
  });

  it('renders the diagram container', () => {
    render(<DrawioDiagramPreview {...defaultProps} />);

    expect(screen.getByTestId('drawio-preview')).toBeInTheDocument();
  });

  it('renders the caption with diagram name', () => {
    render(<DrawioDiagramPreview {...defaultProps} />);

    expect(screen.getByTestId('drawio-caption')).toBeInTheDocument();
    expect(screen.getByText('system-topology')).toBeInTheDocument();
  });

  it('does not render caption when diagramName is null', () => {
    render(<DrawioDiagramPreview {...defaultProps} diagramName={null} />);

    expect(screen.queryByTestId('drawio-caption')).not.toBeInTheDocument();
  });

  it('renders the diagram image with blob URL from authenticated fetch', () => {
    render(<DrawioDiagramPreview {...defaultProps} />);

    const img = screen.getByAltText('Draw.io diagram: system-topology');
    expect(img).toBeInTheDocument();
    // The img src should be the blob URL, not the raw API URL
    expect(img).toHaveAttribute('src', 'blob:/api/attachments/page-1/topology.png');
  });

  it('passes the raw src to useAuthenticatedSrc', () => {
    render(<DrawioDiagramPreview {...defaultProps} />);

    expect(mockUseAuthenticatedSrc).toHaveBeenCalledWith('/api/attachments/page-1/topology.png');
  });

  it('shows loading skeleton while auth fetch is in progress', () => {
    mockUseAuthenticatedSrc.mockReturnValue({
      blobSrc: null,
      loading: true,
      error: false,
    });

    render(<DrawioDiagramPreview {...defaultProps} />);

    expect(screen.getByTestId('drawio-skeleton')).toBeInTheDocument();
  });

  it('hides loading skeleton after image loads', async () => {
    render(<DrawioDiagramPreview {...defaultProps} />);

    const img = screen.getByAltText('Draw.io diagram: system-topology');
    fireEvent.load(img);

    await waitFor(() => {
      expect(screen.queryByTestId('drawio-skeleton')).not.toBeInTheDocument();
    });
  });

  it('shows error state when authenticated fetch fails', async () => {
    mockUseAuthenticatedSrc.mockReturnValue({
      blobSrc: null,
      loading: false,
      error: true,
    });

    render(<DrawioDiagramPreview {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('drawio-error')).toBeInTheDocument();
      expect(screen.getByText(/could not be loaded/)).toBeInTheDocument();
    });
  });

  it('shows error state when image element fails to load', async () => {
    render(<DrawioDiagramPreview {...defaultProps} />);

    const img = screen.getByAltText('Draw.io diagram: system-topology');
    fireEvent.error(img);

    await waitFor(() => {
      expect(screen.getByTestId('drawio-error')).toBeInTheDocument();
      expect(screen.getByText(/could not be loaded/)).toBeInTheDocument();
    });
  });

  it('shows error state with diagram name in message', async () => {
    render(<DrawioDiagramPreview {...defaultProps} />);

    const img = screen.getByAltText('Draw.io diagram: system-topology');
    fireEvent.error(img);

    await waitFor(() => {
      expect(screen.getByText('Diagram "system-topology" could not be loaded')).toBeInTheDocument();
    });
  });

  it('shows generic error message when no diagram name', async () => {
    render(<DrawioDiagramPreview {...defaultProps} diagramName={null} />);

    const img = screen.getByAltText('Draw.io diagram: system-topology');
    fireEvent.error(img);

    await waitFor(() => {
      expect(screen.getByText('Diagram could not be loaded')).toBeInTheDocument();
    });
  });

  it('shows error state when src is null', () => {
    render(<DrawioDiagramPreview {...defaultProps} src={null} />);

    expect(screen.getByTestId('drawio-error')).toBeInTheDocument();
  });

  it('shows sync button when onRequestSync is provided and in error state', () => {
    const onRequestSync = vi.fn();
    render(<DrawioDiagramPreview {...defaultProps} src={null} onRequestSync={onRequestSync} />);

    const syncButton = screen.getByTestId('drawio-sync-button');
    expect(syncButton).toBeInTheDocument();
    expect(syncButton).toHaveTextContent('Sync to load diagram');
  });

  it('calls onRequestSync when sync button is clicked', () => {
    const onRequestSync = vi.fn();
    render(<DrawioDiagramPreview {...defaultProps} src={null} onRequestSync={onRequestSync} />);

    fireEvent.click(screen.getByTestId('drawio-sync-button'));

    expect(onRequestSync).toHaveBeenCalledTimes(1);
  });

  it('does not show sync button when onRequestSync is not provided', () => {
    render(<DrawioDiagramPreview {...defaultProps} src={null} />);

    expect(screen.queryByTestId('drawio-sync-button')).not.toBeInTheDocument();
  });

  it('renders the edit link as a styled button', () => {
    render(<DrawioDiagramPreview {...defaultProps} />);

    const editLink = screen.getByTestId('drawio-edit-link');
    expect(editLink).toBeInTheDocument();
    expect(editLink).toHaveTextContent('Edit in Confluence');
    expect(editLink).toHaveAttribute('href', 'https://confluence.example.com/pages/viewpage.action?pageId=12345');
    expect(editLink).toHaveAttribute('target', '_blank');
    expect(editLink).toHaveAttribute('rel', 'noreferrer');
    expect(editLink).toHaveAttribute('title', 'Open this diagram in Confluence to edit it');
  });

  it('shows zoom-in cursor on loaded image', async () => {
    render(<DrawioDiagramPreview {...defaultProps} />);

    const img = screen.getByAltText('Draw.io diagram: system-topology');
    fireEvent.load(img);

    await waitFor(() => {
      expect(img.className).toContain('cursor-zoom-in');
    });
  });

  it('opens lightbox when clicking loaded image', async () => {
    render(<DrawioDiagramPreview {...defaultProps} />);

    const img = screen.getByAltText('Draw.io diagram: system-topology');
    fireEvent.load(img);

    await waitFor(() => {
      expect(img.className).toContain('cursor-zoom-in');
    });

    fireEvent.click(img);

    // Lightbox dialog should appear
    await waitFor(() => {
      // Radix Dialog sets role="dialog"
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  it('does not open lightbox when clicking image in loading state', () => {
    mockUseAuthenticatedSrc.mockReturnValue({
      blobSrc: null,
      loading: true,
      error: false,
    });

    render(<DrawioDiagramPreview {...defaultProps} />);

    // In loading state, no image is rendered so nothing to click
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('wraps image in a light background panel for dark mode', () => {
    render(<DrawioDiagramPreview {...defaultProps} />);

    const panel = screen.getByTestId('drawio-image-panel');
    expect(panel).toBeInTheDocument();
    expect(panel.className).toContain('bg-white');
  });

  it('applies custom className', () => {
    render(<DrawioDiagramPreview {...defaultProps} className="mt-8" />);

    expect(screen.getByTestId('drawio-preview')).toHaveClass('mt-8');
  });

  describe('srcXmlFallback', () => {
    it('uses XML fallback blob URL when primary PNG auth fails', async () => {
      // Primary PNG fails; XML fallback succeeds
      mockUseAuthenticatedSrc
        .mockImplementationOnce(() => ({ blobSrc: null, loading: false, error: true }))
        .mockImplementationOnce((src: string | null) => ({
          blobSrc: src ? `blob:${src}` : null,
          loading: false,
          error: false,
        }));

      render(
        <DrawioDiagramPreview
          {...defaultProps}
          srcXmlFallback="/api/attachments/page-1/topology.xml"
        />,
      );

      const img = await screen.findByRole('img');
      expect(img).toHaveAttribute('src', 'blob:/api/attachments/page-1/topology.xml');
    });

    it('passes XML fallback URL to useAuthenticatedSrc when primary fails', () => {
      mockUseAuthenticatedSrc
        .mockImplementationOnce(() => ({ blobSrc: null, loading: false, error: true }))
        .mockImplementationOnce(() => ({ blobSrc: 'blob:xml', loading: false, error: false }));

      render(
        <DrawioDiagramPreview
          {...defaultProps}
          srcXmlFallback="/api/attachments/page-1/topology.xml"
        />,
      );

      // Second call to useAuthenticatedSrc should receive the XML fallback URL
      expect(mockUseAuthenticatedSrc).toHaveBeenCalledWith('/api/attachments/page-1/topology.xml');
    });

    it('does not attempt XML fallback when primary PNG succeeds (passes null)', () => {
      // Primary succeeds — default mock returns blob URL
      mockUseAuthenticatedSrc.mockImplementation((src: string | null) => ({
        blobSrc: src ? `blob:${src}` : null,
        loading: false,
        error: false,
      }));

      render(
        <DrawioDiagramPreview
          {...defaultProps}
          srcXmlFallback="/api/attachments/page-1/topology.xml"
        />,
      );

      // Second call to useAuthenticatedSrc should receive null (no fallback needed)
      expect(mockUseAuthenticatedSrc).toHaveBeenCalledWith(null);
    });

    it('shows error state when both primary and XML fallback fail', () => {
      mockUseAuthenticatedSrc
        .mockImplementationOnce(() => ({ blobSrc: null, loading: false, error: true }))
        .mockImplementationOnce(() => ({ blobSrc: null, loading: false, error: true }));

      render(
        <DrawioDiagramPreview
          {...defaultProps}
          srcXmlFallback="/api/attachments/page-1/topology.xml"
        />,
      );

      expect(screen.getByTestId('drawio-error')).toBeInTheDocument();
    });

    it('shows loading state while XML fallback is being fetched', () => {
      mockUseAuthenticatedSrc
        .mockImplementationOnce(() => ({ blobSrc: null, loading: false, error: true }))
        .mockImplementationOnce(() => ({ blobSrc: null, loading: true, error: false }));

      render(
        <DrawioDiagramPreview
          {...defaultProps}
          srcXmlFallback="/api/attachments/page-1/topology.xml"
        />,
      );

      expect(screen.getByTestId('drawio-skeleton')).toBeInTheDocument();
    });
  });
});
