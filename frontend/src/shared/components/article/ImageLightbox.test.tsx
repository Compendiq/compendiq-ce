import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LazyMotion, domAnimation } from 'framer-motion';
import { ImageLightbox } from './ImageLightbox';

let mockUseAuthenticatedSrc = vi.fn((src: string) => ({
  blobSrc: src,
  loading: false,
  error: false,
}));

vi.mock('../../hooks/use-authenticated-src', () => ({
  useAuthenticatedSrc: (src: string) => mockUseAuthenticatedSrc(src),
}));

function renderLightbox(props: Partial<React.ComponentProps<typeof ImageLightbox>> = {}) {
  const defaultProps = {
    alt: 'Architecture Diagram',
    onClose: vi.fn(),
    src: '/api/attachments/page-1/diagram.png',
    ...props,
  };

  const result = render(
    <LazyMotion features={domAnimation}>
      <ImageLightbox {...defaultProps} />
    </LazyMotion>
  );

  return { ...result, props: defaultProps };
}

describe('ImageLightbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuthenticatedSrc = vi.fn((src: string) => ({
      blobSrc: src,
      loading: false,
      error: false,
    }));
  });

  it('renders image preview dialog with image, close button, and zoom HUD', () => {
    renderLightbox();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-label', 'Image preview: Architecture Diagram');

    const img = screen.getByAltText('Architecture Diagram');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', '/api/attachments/page-1/diagram.png');

    const toolbar = screen.getByRole('toolbar', { name: 'Image zoom controls' });
    expect(toolbar).toBeInTheDocument();

    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByLabelText('Zoom in')).toBeInTheDocument();
    expect(screen.getByLabelText('Zoom out')).toBeInTheDocument();
    expect(screen.getByLabelText('Reset zoom and pan')).toBeInTheDocument();
    expect(screen.getByLabelText('Toggle actual size')).toBeInTheDocument();
    expect(screen.getByLabelText('Close preview')).toBeInTheDocument();
  });

  it('zooms in and out with toolbar buttons', () => {
    renderLightbox();

    const zoomInBtn = screen.getByLabelText('Zoom in');
    const zoomOutBtn = screen.getByLabelText('Zoom out');
    const img = screen.getByAltText('Architecture Diagram');

    expect(screen.getByText('100%')).toBeInTheDocument();

    fireEvent.click(zoomInBtn);
    expect(screen.getByText('125%')).toBeInTheDocument();
    expect(img.style.transform).toContain('scale(1.25)');

    fireEvent.click(zoomInBtn);
    expect(screen.getByText('150%')).toBeInTheDocument();
    expect(img.style.transform).toContain('scale(1.5)');

    fireEvent.click(zoomOutBtn);
    expect(screen.getByText('125%')).toBeInTheDocument();
    expect(img.style.transform).toContain('scale(1.25)');
  });

  it('clamps zoom within MIN_SCALE (50%) and MAX_SCALE (500%)', () => {
    renderLightbox();

    const zoomInBtn = screen.getByLabelText('Zoom in');
    const zoomOutBtn = screen.getByLabelText('Zoom out');

    // Zoom out to minimum
    for (let i = 0; i < 5; i++) {
      fireEvent.click(zoomOutBtn);
    }
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(zoomOutBtn).toBeDisabled();

    // Zoom in up to maximum
    for (let i = 0; i < 20; i++) {
      fireEvent.click(zoomInBtn);
    }
    expect(screen.getByText('500%')).toBeInTheDocument();
    expect(zoomInBtn).toBeDisabled();
  });

  it('resets zoom and pan when reset button is clicked', () => {
    renderLightbox();

    const zoomInBtn = screen.getByLabelText('Zoom in');
    const resetBtn = screen.getByLabelText('Reset zoom and pan');
    const img = screen.getByAltText('Architecture Diagram');

    expect(resetBtn).toBeDisabled();

    fireEvent.click(zoomInBtn);
    fireEvent.click(zoomInBtn);
    expect(screen.getByText('150%')).toBeInTheDocument();
    expect(resetBtn).not.toBeDisabled();

    fireEvent.click(resetBtn);
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(img.style.transform).toBe('translate3d(0px, 0px, 0px) scale(1)');
    expect(resetBtn).toBeDisabled();
  });

  it('toggles actual size (1:1 / 2x) with toggle button', () => {
    renderLightbox();

    const actualSizeBtn = screen.getByLabelText('Toggle actual size');
    const img = screen.getByAltText('Architecture Diagram');

    expect(screen.getByText('100%')).toBeInTheDocument();

    fireEvent.click(actualSizeBtn);
    expect(screen.getByText('200%')).toBeInTheDocument();
    expect(img.style.transform).toContain('scale(2)');

    fireEvent.click(actualSizeBtn);
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(img.style.transform).toContain('scale(1)');
  });

  it('toggles zoom between 1x and 2x on double-click', () => {
    renderLightbox();

    const img = screen.getByAltText('Architecture Diagram');
    expect(screen.getByText('100%')).toBeInTheDocument();

    fireEvent.doubleClick(img);
    expect(screen.getByText('200%')).toBeInTheDocument();
    expect(img.style.transform).toContain('scale(2)');

    fireEvent.doubleClick(img);
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(img.style.transform).toContain('scale(1)');
  });

  it('supports wheel zooming', () => {
    renderLightbox();

    const img = screen.getByAltText('Architecture Diagram');
    const container = img.parentElement!;

    // Wheel up / zoom in
    fireEvent.wheel(container, { deltaY: -100 });
    expect(screen.getByText('115%')).toBeInTheDocument();

    // Wheel down / zoom out
    fireEvent.wheel(container, { deltaY: 100 });
    expect(screen.getByText('98%')).toBeInTheDocument();
  });

  it('handles keyboard shortcuts (+, -, 0, Escape, arrows)', () => {
    const { props } = renderLightbox();

    // Zoom in with '+'
    fireEvent.keyDown(document, { key: '+' });
    expect(screen.getByText('125%')).toBeInTheDocument();

    // Zoom in with '='
    fireEvent.keyDown(document, { key: '=' });
    expect(screen.getByText('150%')).toBeInTheDocument();

    // Zoom out with '-'
    fireEvent.keyDown(document, { key: '-' });
    expect(screen.getByText('125%')).toBeInTheDocument();

    // Pan with arrow keys when zoomed
    const img = screen.getByAltText('Architecture Diagram');
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(img.style.transform).toContain('translate3d(-50px, 0px, 0px)');

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(img.style.transform).toContain('translate3d(-50px, -50px, 0px)');

    // Reset with '0'
    fireEvent.keyDown(document, { key: '0' });
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(img.style.transform).toBe('translate3d(0px, 0px, 0px) scale(1)');

    // Close with Escape
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('supports drag to pan when scale > 1', () => {
    renderLightbox();

    const zoomInBtn = screen.getByLabelText('Zoom in');
    fireEvent.click(zoomInBtn);
    fireEvent.click(zoomInBtn);

    const img = screen.getByAltText('Architecture Diagram');
    expect(img).toHaveClass('cursor-grab');

    // Pointer down
    fireEvent.pointerDown(img, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    expect(img).toHaveClass('cursor-grabbing');

    // Pointer move
    fireEvent.pointerMove(img, { clientX: 250, clientY: 230, pointerId: 1 });
    expect(img.style.transform).toContain('translate3d(50px, 30px, 0px)');

    // Pointer up ends dragging
    fireEvent.pointerUp(img, { pointerId: 1 });
    expect(img).toHaveClass('cursor-grab');
  });

  it('does not drag when scale <= 1', () => {
    renderLightbox();

    const img = screen.getByAltText('Architecture Diagram');
    expect(img).toHaveClass('cursor-zoom-in');

    fireEvent.pointerDown(img, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(img, { clientX: 150, clientY: 150, pointerId: 1 });
    fireEvent.pointerUp(img, { pointerId: 1 });

    expect(img.style.transform).toBe('translate3d(0px, 0px, 0px) scale(1)');
  });

  it('closes when clicking backdrop or close button, but not when clicking image or toolbar', () => {
    const { props } = renderLightbox();

    const closeBtn = screen.getByLabelText('Close preview');
    fireEvent.click(closeBtn);
    expect(props.onClose).toHaveBeenCalledTimes(1);

    const toolbar = screen.getByRole('toolbar');
    fireEvent.click(toolbar);
    expect(props.onClose).toHaveBeenCalledTimes(1);

    const img = screen.getByAltText('Architecture Diagram');
    fireEvent.click(img);
    expect(props.onClose).toHaveBeenCalledTimes(1);

    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('manages focus and focus trap (#942)', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = renderLightbox();

    const closeBtn = screen.getByLabelText('Close preview');
    expect(document.activeElement).toBe(closeBtn);

    // Focus trap Tab wrap
    const dialog = screen.getByRole('dialog');
    const actualSizeBtn = screen.getByLabelText('Toggle actual size');
    actualSizeBtn.focus();
    expect(document.activeElement).toBe(actualSizeBtn);

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: false });
    expect(document.activeElement).toBe(closeBtn);

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(actualSizeBtn);

    unmount();
    expect(document.activeElement).toBe(trigger);
    document.body.removeChild(trigger);
  });

  it('shows loading and error states', () => {
    mockUseAuthenticatedSrc = vi.fn(() => ({
      blobSrc: null,
      loading: true,
      error: false,
    }));

    const { rerender } = renderLightbox();
    expect(screen.getByText('Loading image…')).toBeInTheDocument();

    mockUseAuthenticatedSrc = vi.fn(() => ({
      blobSrc: null,
      loading: false,
      error: true,
    }));

    rerender(
      <LazyMotion features={domAnimation}>
        <ImageLightbox alt="Error Diagram" onClose={vi.fn()} src="/api/bad.png" />
      </LazyMotion>
    );

    expect(screen.getByText('Failed to load image.')).toBeInTheDocument();
  });

  it('resets scale and position when src prop changes', () => {
    const { rerender } = renderLightbox({ src: '/img1.png' });

    const zoomInBtn = screen.getByLabelText('Zoom in');
    fireEvent.click(zoomInBtn);
    expect(screen.getByText('125%')).toBeInTheDocument();

    rerender(
      <LazyMotion features={domAnimation}>
        <ImageLightbox alt="Diagram 2" onClose={vi.fn()} src="/img2.png" />
      </LazyMotion>
    );

    expect(screen.getByText('100%')).toBeInTheDocument();
  });
});
