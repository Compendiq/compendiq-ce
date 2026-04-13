import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LazyMotion, domAnimation } from 'framer-motion';
import { StreamingCursor } from './StreamingCursor';

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LazyMotion features={domAnimation}>{children}</LazyMotion>;
}

describe('StreamingCursor', () => {
  it('renders when active', () => {
    render(<StreamingCursor active />, { wrapper: Wrapper });
    expect(screen.getByTestId('streaming-cursor')).toBeInTheDocument();
  });

  it('does not render when not active', () => {
    render(<StreamingCursor active={false} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('streaming-cursor')).not.toBeInTheDocument();
  });

  it('is hidden from assistive technology', () => {
    render(<StreamingCursor />, { wrapper: Wrapper });
    expect(screen.getByTestId('streaming-cursor')).toHaveAttribute('aria-hidden', 'true');
  });

  it('applies cyan glow styling', () => {
    render(<StreamingCursor />, { wrapper: Wrapper });
    const cursor = screen.getByTestId('streaming-cursor');
    expect(cursor.className).toContain('bg-cyan-400');
  });

  it('applies custom className', () => {
    render(<StreamingCursor className="my-custom" />, { wrapper: Wrapper });
    const cursor = screen.getByTestId('streaming-cursor');
    expect(cursor.className).toContain('my-custom');
  });

  it('has blink animation class', () => {
    render(<StreamingCursor />, { wrapper: Wrapper });
    const cursor = screen.getByTestId('streaming-cursor');
    expect(cursor.className).toContain('animate-[cursor-blink');
  });

  it('defaults to active when no prop provided', () => {
    render(<StreamingCursor />, { wrapper: Wrapper });
    expect(screen.getByTestId('streaming-cursor')).toBeInTheDocument();
  });
});
