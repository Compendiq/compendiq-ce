import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DirectionAwareHover } from './DirectionAwareHover';

let originalMatchMedia: typeof window.matchMedia;

function mockMatchMedia(hover: boolean, reducedMotion: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    let matches = false;
    if (query === '(hover: hover)') matches = hover;
    if (query === '(prefers-reduced-motion: reduce)') matches = reducedMotion;
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  });
}

describe('DirectionAwareHover', () => {
  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
  });

  it('renders children', () => {
    mockMatchMedia(true, false);
    render(
      <DirectionAwareHover data-testid="dir-hover">
        <span>Article item</span>
      </DirectionAwareHover>,
    );

    expect(screen.getByText('Article item')).toBeInTheDocument();
    expect(screen.getByTestId('dir-hover')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    mockMatchMedia(true, false);
    render(
      <DirectionAwareHover className="glass-card-hover p-4" data-testid="dir-hover">
        <span>Content</span>
      </DirectionAwareHover>,
    );

    const el = screen.getByTestId('dir-hover');
    expect(el.className).toContain('glass-card-hover');
    expect(el.className).toContain('direction-aware-hover');
  });

  it('has bloom element hidden by default', () => {
    mockMatchMedia(true, false);
    render(
      <DirectionAwareHover data-testid="dir-hover">
        <span>Content</span>
      </DirectionAwareHover>,
    );

    const bloom = screen.getByTestId('dir-hover-bloom');
    expect(bloom).toBeInTheDocument();
    expect(bloom.style.opacity).toBe('0');
  });

  it('shows bloom on mouse enter on hover-capable device', () => {
    mockMatchMedia(true, false);
    render(
      <DirectionAwareHover data-testid="dir-hover">
        <span>Content</span>
      </DirectionAwareHover>,
    );

    const el = screen.getByTestId('dir-hover');
    // Mock getBoundingClientRect for direction calculation
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 60,
      width: 200,
      height: 60,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.mouseEnter(el, { clientX: 1, clientY: 30 }); // Enter from left

    const bloom = screen.getByTestId('dir-hover-bloom');
    expect(bloom.style.opacity).toBe('1');
    // Should have a gradient going to the right (entered from left)
    expect(bloom.style.background).toContain('to right');
  });

  it('hides bloom on mouse leave', () => {
    mockMatchMedia(true, false);
    render(
      <DirectionAwareHover data-testid="dir-hover">
        <span>Content</span>
      </DirectionAwareHover>,
    );

    const el = screen.getByTestId('dir-hover');
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 200, bottom: 60,
      width: 200, height: 60, x: 0, y: 0,
      toJSON: () => ({}),
    });

    fireEvent.mouseEnter(el, { clientX: 1, clientY: 30 });
    fireEvent.mouseLeave(el);

    const bloom = screen.getByTestId('dir-hover-bloom');
    expect(bloom.style.opacity).toBe('0');
  });

  it('detects entry from the right edge', () => {
    mockMatchMedia(true, false);
    render(
      <DirectionAwareHover data-testid="dir-hover">
        <span>Content</span>
      </DirectionAwareHover>,
    );

    const el = screen.getByTestId('dir-hover');
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 200, bottom: 60,
      width: 200, height: 60, x: 0, y: 0,
      toJSON: () => ({}),
    });

    fireEvent.mouseEnter(el, { clientX: 199, clientY: 30 }); // Enter from right

    const bloom = screen.getByTestId('dir-hover-bloom');
    expect(bloom.style.background).toContain('to left');
  });

  it('detects entry from the top edge', () => {
    mockMatchMedia(true, false);
    render(
      <DirectionAwareHover data-testid="dir-hover">
        <span>Content</span>
      </DirectionAwareHover>,
    );

    const el = screen.getByTestId('dir-hover');
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 200, bottom: 200,
      width: 200, height: 200, x: 0, y: 0,
      toJSON: () => ({}),
    });

    fireEvent.mouseEnter(el, { clientX: 100, clientY: 1 }); // Enter from top

    const bloom = screen.getByTestId('dir-hover-bloom');
    expect(bloom.style.background).toContain('to bottom');
  });

  it('does not show bloom on touch devices', () => {
    mockMatchMedia(false, false);
    render(
      <DirectionAwareHover data-testid="dir-hover">
        <span>Content</span>
      </DirectionAwareHover>,
    );

    const el = screen.getByTestId('dir-hover');
    fireEvent.mouseEnter(el, { clientX: 1, clientY: 30 });

    const bloom = screen.getByTestId('dir-hover-bloom');
    expect(bloom.style.opacity).toBe('0');
  });

  it('does not show bloom when prefers-reduced-motion', () => {
    mockMatchMedia(true, true);
    render(
      <DirectionAwareHover data-testid="dir-hover">
        <span>Content</span>
      </DirectionAwareHover>,
    );

    const el = screen.getByTestId('dir-hover');
    fireEvent.mouseEnter(el, { clientX: 1, clientY: 30 });

    const bloom = screen.getByTestId('dir-hover-bloom');
    expect(bloom.style.opacity).toBe('0');
  });
});
