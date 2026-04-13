import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DiagramLightbox } from './DiagramLightbox';

describe('DiagramLightbox', () => {
  const defaultProps = {
    src: '/api/attachments/page-1/topology.png',
    alt: 'System Topology',
    diagramName: 'system-topology',
    open: true,
    onOpenChange: vi.fn(),
  };

  it('renders the diagram image when open', () => {
    render(<DiagramLightbox {...defaultProps} />);

    const img = screen.getByAltText('System Topology');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', '/api/attachments/page-1/topology.png');
  });

  it('displays the diagram name as title', () => {
    render(<DiagramLightbox {...defaultProps} />);

    expect(screen.getByText('system-topology')).toBeInTheDocument();
  });

  it('shows "Diagram Preview" when no diagram name provided', () => {
    render(<DiagramLightbox {...defaultProps} diagramName={undefined} />);

    expect(screen.getByText('Diagram Preview')).toBeInTheDocument();
  });

  it('renders zoom controls', () => {
    render(<DiagramLightbox {...defaultProps} />);

    expect(screen.getByLabelText('Zoom in')).toBeInTheDocument();
    expect(screen.getByLabelText('Zoom out')).toBeInTheDocument();
    expect(screen.getByLabelText('Fit to screen')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('increments zoom on zoom in click', () => {
    render(<DiagramLightbox {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Zoom in'));

    expect(screen.getByText('125%')).toBeInTheDocument();
  });

  it('decrements zoom on zoom out click', () => {
    render(<DiagramLightbox {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Zoom out'));

    expect(screen.getByText('75%')).toBeInTheDocument();
  });

  it('resets zoom on fit to screen click', () => {
    render(<DiagramLightbox {...defaultProps} />);

    // Zoom in twice
    fireEvent.click(screen.getByLabelText('Zoom in'));
    fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(screen.getByText('150%')).toBeInTheDocument();

    // Fit to screen
    fireEvent.click(screen.getByLabelText('Fit to screen'));
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('renders close button', () => {
    render(<DiagramLightbox {...defaultProps} />);

    expect(screen.getByLabelText('Close preview')).toBeInTheDocument();
  });

  it('renders download button', () => {
    render(<DiagramLightbox {...defaultProps} />);

    expect(screen.getByLabelText('Download diagram')).toBeInTheDocument();
  });

  it('calls onOpenChange when clicking the backdrop', () => {
    const onOpenChange = vi.fn();
    render(<DiagramLightbox {...defaultProps} onOpenChange={onOpenChange} />);

    // Click the viewport/backdrop area
    const viewport = screen.getByAltText('System Topology').parentElement!;
    fireEvent.click(viewport);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not render when closed', () => {
    render(<DiagramLightbox {...defaultProps} open={false} />);

    expect(screen.queryByAltText('System Topology')).not.toBeInTheDocument();
  });

  it('handles keyboard zoom shortcuts', () => {
    render(<DiagramLightbox {...defaultProps} />);

    // The content receives keyboard events
    const content = screen.getByAltText('System Topology').closest('[role="dialog"]')!;

    fireEvent.keyDown(content, { key: '+' });
    expect(screen.getByText('125%')).toBeInTheDocument();

    fireEvent.keyDown(content, { key: '-' });
    expect(screen.getByText('100%')).toBeInTheDocument();

    fireEvent.keyDown(content, { key: '+' });
    fireEvent.keyDown(content, { key: '+' });
    expect(screen.getByText('150%')).toBeInTheDocument();

    fireEvent.keyDown(content, { key: '0' });
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('applies white background to image for dark mode readability', () => {
    render(<DiagramLightbox {...defaultProps} />);

    const img = screen.getByAltText('System Topology');
    expect(img.className).toContain('bg-white');
  });

  it('prevents zoom below minimum', () => {
    render(<DiagramLightbox {...defaultProps} />);

    // Click zoom out many times
    for (let i = 0; i < 10; i++) {
      fireEvent.click(screen.getByLabelText('Zoom out'));
    }

    // Should not go below 25%
    expect(screen.getByText('25%')).toBeInTheDocument();
  });

  it('prevents zoom above maximum', () => {
    render(<DiagramLightbox {...defaultProps} />);

    // Click zoom in many times
    for (let i = 0; i < 20; i++) {
      fireEvent.click(screen.getByLabelText('Zoom in'));
    }

    // Should not go above 400%
    expect(screen.getByText('400%')).toBeInTheDocument();
  });
});
