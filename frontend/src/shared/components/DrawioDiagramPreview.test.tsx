import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DrawioDiagramPreview } from './DrawioDiagramPreview';

describe('DrawioDiagramPreview', () => {
  const defaultProps = {
    src: '/api/attachments/page-1/topology.png',
    diagramName: 'system-topology',
    alt: 'Draw.io diagram: system-topology',
    editHref: 'https://confluence.example.com/pages/viewpage.action?pageId=12345',
  };

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

  it('renders the diagram image with lazy loading', () => {
    render(<DrawioDiagramPreview {...defaultProps} />);

    const img = screen.getByAltText('Draw.io diagram: system-topology');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', '/api/attachments/page-1/topology.png');
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('shows loading skeleton initially', () => {
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

  it('shows error state when image fails to load', async () => {
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
    render(<DrawioDiagramPreview {...defaultProps} />);

    const img = screen.getByAltText('Draw.io diagram: system-topology');
    // Don't fire load event, so it stays in loading state
    fireEvent.click(img);

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
});
