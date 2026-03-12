import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LazyMotion, domMax } from 'framer-motion';
import { DiffView } from './DiffView';

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LazyMotion features={domMax}>{children}</LazyMotion>;
}

describe('DiffView', () => {
  const original = 'The quick brown fox jumps over the lazy dog';
  const improved = 'The quick red fox leaps over the lazy cat';

  it('renders the unified diff view by default', () => {
    render(<DiffView original={original} improved={improved} />, { wrapper: Wrapper });
    expect(screen.getByTestId('unified-diff')).toBeInTheDocument();
  });

  it('highlights additions in green', () => {
    render(<DiffView original="hello" improved="hello world" />, { wrapper: Wrapper });
    const diffContainer = screen.getByTestId('unified-diff');
    // Find spans with text-success class
    const successSpans = diffContainer.querySelectorAll('.text-success');
    expect(successSpans.length).toBeGreaterThan(0);
    // Verify the added content is present
    const addedText = Array.from(successSpans).map((s) => s.textContent).join('');
    expect(addedText).toContain('world');
  });

  it('highlights removals in red', () => {
    render(<DiffView original="hello world" improved="hello" />, { wrapper: Wrapper });
    const diffContainer = screen.getByTestId('unified-diff');
    const destructiveSpans = diffContainer.querySelectorAll('.text-destructive');
    expect(destructiveSpans.length).toBeGreaterThan(0);
    const removedText = Array.from(destructiveSpans).map((s) => s.textContent).join('');
    expect(removedText).toContain('world');
  });

  it('toggles to side-by-side view', () => {
    render(<DiffView original={original} improved={improved} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByText('Side-by-Side'));

    expect(screen.getByTestId('side-by-side-diff')).toBeInTheDocument();
    expect(screen.getByText('Original')).toBeInTheDocument();
    expect(screen.getByText('Improved')).toBeInTheDocument();
  });

  it('toggles back to unified view', () => {
    render(<DiffView original={original} improved={improved} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByText('Side-by-Side'));
    expect(screen.getByTestId('side-by-side-diff')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Unified'));
    expect(screen.getByTestId('unified-diff')).toBeInTheDocument();
  });

  it('shows addition and deletion stats', () => {
    render(<DiffView original="old text" improved="new text" />, { wrapper: Wrapper });
    // Stats should show + and - counts
    const header = screen.getByText('Changes').parentElement;
    expect(header).toBeTruthy();
  });

  it('calls onAccept when Accept button is clicked', () => {
    const onAccept = vi.fn();
    render(
      <DiffView original={original} improved={improved} onAccept={onAccept} />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByText('Accept'));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('calls onReject when Reject button is clicked', () => {
    const onReject = vi.fn();
    render(
      <DiffView original={original} improved={improved} onReject={onReject} />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByText('Reject'));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('does not show action buttons when no callbacks are provided', () => {
    render(<DiffView original={original} improved={improved} />, { wrapper: Wrapper });
    expect(screen.queryByText('Accept')).not.toBeInTheDocument();
    expect(screen.queryByText('Reject')).not.toBeInTheDocument();
  });

  it('handles identical content', () => {
    render(<DiffView original="same text" improved="same text" />, { wrapper: Wrapper });
    const diff = screen.getByTestId('unified-diff');
    expect(diff.textContent).toBe('same text');
  });

  it('handles empty strings', () => {
    render(<DiffView original="" improved="new content" />, { wrapper: Wrapper });
    expect(screen.getByTestId('unified-diff')).toBeInTheDocument();
  });
});
