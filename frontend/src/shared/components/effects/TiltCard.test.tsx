import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LazyMotion, domAnimation } from 'framer-motion';
import { TiltCard } from './TiltCard';

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LazyMotion features={domAnimation}>{children}</LazyMotion>;
}

// Store originals so we can restore them
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

describe('TiltCard', () => {
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
      <TiltCard data-testid="tilt-card">
        <span>Card content</span>
      </TiltCard>,
      { wrapper: Wrapper },
    );

    expect(screen.getByText('Card content')).toBeInTheDocument();
    expect(screen.getByTestId('tilt-card')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    mockMatchMedia(true, false);
    render(
      <TiltCard className="nm-card p-4" data-testid="tilt-card">
        <span>Content</span>
      </TiltCard>,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('tilt-card');
    expect(card.className).toContain('nm-card');
  });

  it('renders as plain div on touch devices (no hover)', () => {
    mockMatchMedia(false, false);
    render(
      <TiltCard data-testid="tilt-card">
        <span>Touch content</span>
      </TiltCard>,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('tilt-card');
    expect(card.tagName).toBe('DIV');
    // Should NOT have will-change-transform class (plain div)
    expect(card.className).not.toContain('will-change-transform');
  });

  it('renders as motion div on hover-capable devices', () => {
    mockMatchMedia(true, false);
    render(
      <TiltCard data-testid="tilt-card" className="test-class">
        <span>Hover content</span>
      </TiltCard>,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('tilt-card');
    expect(card.className).toContain('will-change-transform');
  });

  it('disables on prefers-reduced-motion', () => {
    mockMatchMedia(true, true);
    render(
      <TiltCard data-testid="tilt-card">
        <span>Reduced motion content</span>
      </TiltCard>,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('tilt-card');
    // Falls back to plain div
    expect(card.className).not.toContain('will-change-transform');
  });

  it('clamps maxTilt to 0-15 range', () => {
    mockMatchMedia(true, false);
    // Should not throw for out-of-range values
    const { rerender } = render(
      <TiltCard maxTilt={20} data-testid="tilt-card">
        <span>Content</span>
      </TiltCard>,
      { wrapper: Wrapper },
    );

    expect(screen.getByTestId('tilt-card')).toBeInTheDocument();

    rerender(
      <Wrapper>
        <TiltCard maxTilt={-5} data-testid="tilt-card">
          <span>Content</span>
        </TiltCard>
      </Wrapper>,
    );

    expect(screen.getByTestId('tilt-card')).toBeInTheDocument();
  });

  it('handles mouse move and leave without errors', () => {
    mockMatchMedia(true, false);
    render(
      <TiltCard data-testid="tilt-card">
        <span>Content</span>
      </TiltCard>,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('tilt-card');

    // Simulate mouse move — should not throw
    fireEvent.mouseMove(card, { clientX: 50, clientY: 50 });
    fireEvent.mouseLeave(card);

    expect(card).toBeInTheDocument();
  });
});
