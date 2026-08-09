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

  // Was `bg-cyan-400` with a `shadow-[0_0_8px_#22d3ee]` glow. Both were raw
  // literals that never tracked the theme; the glow went with the flat system
  // and the fill is the accent token now. Solid, not a tint — this is a 2px
  // cursor, and a 15% fill makes it a smudge.
  it('paints the cursor in the accent, at full strength', () => {
    render(<StreamingCursor />, { wrapper: Wrapper });
    const cursor = screen.getByTestId('streaming-cursor');
    expect(cursor.className).toContain('bg-primary');
    expect(cursor.className).not.toMatch(/bg-primary\//);
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
