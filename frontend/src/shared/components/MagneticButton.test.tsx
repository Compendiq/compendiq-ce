import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LazyMotion, domAnimation } from 'framer-motion';
import { MagneticButton } from './MagneticButton';

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LazyMotion features={domAnimation}>{children}</LazyMotion>;
}

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

describe('MagneticButton', () => {
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
      <MagneticButton data-testid="mag-btn">Click me</MagneticButton>,
      { wrapper: Wrapper },
    );

    expect(screen.getByText('Click me')).toBeInTheDocument();
    expect(screen.getByTestId('mag-btn')).toBeInTheDocument();
  });

  it('renders as a button element', () => {
    mockMatchMedia(true, false);
    render(
      <MagneticButton data-testid="mag-btn">Button</MagneticButton>,
      { wrapper: Wrapper },
    );

    const btn = screen.getByTestId('mag-btn');
    expect(btn.tagName).toBe('BUTTON');
  });

  it('handles click events', () => {
    mockMatchMedia(true, false);
    const handleClick = vi.fn();
    render(
      <MagneticButton onClick={handleClick} data-testid="mag-btn">
        Click
      </MagneticButton>,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByTestId('mag-btn'));
    expect(handleClick).toHaveBeenCalledOnce();
  });

  it('renders as plain button on touch devices', () => {
    mockMatchMedia(false, false);
    render(
      <MagneticButton className="test-class" data-testid="mag-btn">
        Touch
      </MagneticButton>,
      { wrapper: Wrapper },
    );

    const btn = screen.getByTestId('mag-btn');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.className).toBe('test-class');
  });

  it('renders as plain button when prefers-reduced-motion', () => {
    mockMatchMedia(true, true);
    render(
      <MagneticButton data-testid="mag-btn">Reduced</MagneticButton>,
      { wrapper: Wrapper },
    );

    const btn = screen.getByTestId('mag-btn');
    expect(btn.tagName).toBe('BUTTON');
  });

  it('supports disabled state', () => {
    mockMatchMedia(true, false);
    const handleClick = vi.fn();
    render(
      <MagneticButton disabled onClick={handleClick} data-testid="mag-btn">
        Disabled
      </MagneticButton>,
      { wrapper: Wrapper },
    );

    const btn = screen.getByTestId('mag-btn');
    expect(btn).toBeDisabled();
  });

  it('supports aria-label', () => {
    mockMatchMedia(true, false);
    render(
      <MagneticButton aria-label="Sync pages" data-testid="mag-btn">
        Sync
      </MagneticButton>,
      { wrapper: Wrapper },
    );

    expect(screen.getByLabelText('Sync pages')).toBeInTheDocument();
  });

  it('supports type prop', () => {
    mockMatchMedia(true, false);
    render(
      <MagneticButton type="submit" data-testid="mag-btn">
        Submit
      </MagneticButton>,
      { wrapper: Wrapper },
    );

    const btn = screen.getByTestId('mag-btn');
    expect(btn).toHaveAttribute('type', 'submit');
  });

  it('handles mouse move and leave without errors', () => {
    mockMatchMedia(true, false);
    render(
      <MagneticButton data-testid="mag-btn">Hover me</MagneticButton>,
      { wrapper: Wrapper },
    );

    const btn = screen.getByTestId('mag-btn');
    fireEvent.mouseMove(btn, { clientX: 50, clientY: 50 });
    fireEvent.mouseLeave(btn);

    expect(btn).toBeInTheDocument();
  });
});
