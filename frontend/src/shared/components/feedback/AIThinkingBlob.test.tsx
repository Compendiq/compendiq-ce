import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AIThinkingBlob } from './AIThinkingBlob';

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LazyMotion features={domAnimation}>{children}</LazyMotion>;
}

describe('AIThinkingBlob', () => {
  it('renders when active', () => {
    render(<AIThinkingBlob active />, { wrapper: Wrapper });
    expect(screen.getByTestId('ai-thinking-blob')).toBeInTheDocument();
  });

  it('does not render when not active', () => {
    render(<AIThinkingBlob active={false} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('ai-thinking-blob')).not.toBeInTheDocument();
  });

  it('shows default label text', () => {
    render(<AIThinkingBlob />, { wrapper: Wrapper });
    expect(screen.getByText('Thinking...')).toBeInTheDocument();
  });

  it('shows custom label text', () => {
    render(<AIThinkingBlob label="Processing..." />, { wrapper: Wrapper });
    expect(screen.getByText('Processing...')).toBeInTheDocument();
  });

  it('has role status for accessibility', () => {
    render(<AIThinkingBlob />, { wrapper: Wrapper });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('has aria-label matching the label text', () => {
    render(<AIThinkingBlob label="Thinking..." />, { wrapper: Wrapper });
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Thinking...');
  });

  it('applies custom className', () => {
    render(<AIThinkingBlob className="my-class" />, { wrapper: Wrapper });
    expect(screen.getByTestId('ai-thinking-blob').className).toContain('my-class');
  });

  it('defaults to active when no active prop provided', () => {
    render(<AIThinkingBlob />, { wrapper: Wrapper });
    expect(screen.getByTestId('ai-thinking-blob')).toBeInTheDocument();
  });
});
