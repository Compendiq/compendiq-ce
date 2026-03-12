import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AnimatedCounter } from './AnimatedCounter';

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LazyMotion features={domAnimation}>{children}</LazyMotion>;
}

describe('AnimatedCounter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders with data-testid', () => {
    render(<AnimatedCounter value={42} />, { wrapper: Wrapper });
    expect(screen.getByTestId('animated-counter')).toBeInTheDocument();
  });

  it('renders the initial value of 0 before animation', () => {
    render(<AnimatedCounter value={100} />, { wrapper: Wrapper });
    const el = screen.getByTestId('animated-counter');
    // Initial text content should start at 0 (before spring catches up)
    expect(el.textContent).toMatch(/^0/);
  });

  it('applies suffix to the displayed value', () => {
    render(<AnimatedCounter value={75} suffix="%" />, { wrapper: Wrapper });
    const el = screen.getByTestId('animated-counter');
    // The initial text includes the suffix
    expect(el.textContent).toContain('%');
  });

  it('applies custom className', () => {
    render(<AnimatedCounter value={10} className="text-lg font-bold" />, { wrapper: Wrapper });
    const el = screen.getByTestId('animated-counter');
    expect(el.className).toContain('text-lg');
    expect(el.className).toContain('font-bold');
  });

  it('eventually reaches the target value', async () => {
    render(<AnimatedCounter value={50} />, { wrapper: Wrapper });
    const el = screen.getByTestId('animated-counter');
    // The spring animation should eventually settle near the target
    await waitFor(
      () => {
        expect(el.textContent).toBe('50');
      },
      { timeout: 3000 },
    );
  });

  it('eventually reaches target value with suffix', async () => {
    render(<AnimatedCounter value={85} suffix="%" />, { wrapper: Wrapper });
    const el = screen.getByTestId('animated-counter');
    await waitFor(
      () => {
        expect(el.textContent).toBe('85%');
      },
      { timeout: 3000 },
    );
  });

  it('handles value of 0', () => {
    render(<AnimatedCounter value={0} />, { wrapper: Wrapper });
    const el = screen.getByTestId('animated-counter');
    expect(el.textContent).toBe('0');
  });
});
