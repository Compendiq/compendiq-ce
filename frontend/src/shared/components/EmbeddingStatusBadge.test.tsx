import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmbeddingStatusBadge } from './EmbeddingStatusBadge';

describe('EmbeddingStatusBadge', () => {
  // ---- Legacy boolean prop backward compatibility ----

  it('renders "Not Embedded" when embeddingDirty is true (legacy)', () => {
    render(<EmbeddingStatusBadge embeddingDirty={true} />);
    expect(screen.getByText('Not Embedded')).toBeInTheDocument();
  });

  it('renders "Embedded" when embeddingDirty is false (legacy)', () => {
    render(<EmbeddingStatusBadge embeddingDirty={false} />);
    expect(screen.getByText('Embedded')).toBeInTheDocument();
  });

  // ---- New 4-state embeddingStatus prop ----

  it('renders not_embedded state with gray styling', () => {
    render(<EmbeddingStatusBadge embeddingStatus="not_embedded" />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge).toHaveTextContent('Not Embedded');
    expect(badge.className).toContain('text-gray-400');
    expect(badge.className).toContain('bg-gray-500/20');
    expect(badge).toHaveAttribute('data-status', 'not_embedded');
  });

  it('renders embedding state with blue styling and pulse animation', () => {
    render(<EmbeddingStatusBadge embeddingStatus="embedding" />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge).toHaveTextContent('Embedding...');
    expect(badge.className).toContain('text-blue-400');
    expect(badge.className).toContain('bg-blue-500/20');
    expect(badge.className).toContain('animate-pulse');
    expect(badge).toHaveAttribute('data-status', 'embedding');
  });

  it('renders embedded state with green styling', () => {
    render(<EmbeddingStatusBadge embeddingStatus="embedded" />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge).toHaveTextContent('Embedded');
    expect(badge.className).toContain('text-green-400');
    expect(badge.className).toContain('bg-green-500/20');
    expect(badge).toHaveAttribute('data-status', 'embedded');
  });

  it('renders embedded state with relative timestamp when embeddedAt is provided', () => {
    const recentDate = new Date(Date.now() - 3600_000).toISOString(); // 1 hour ago
    render(<EmbeddingStatusBadge embeddingStatus="embedded" embeddedAt={recentDate} />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge).toHaveTextContent(/Embedded 1h ago/);
  });

  it('renders failed state with red styling', () => {
    render(<EmbeddingStatusBadge embeddingStatus="failed" />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge).toHaveTextContent('Embedding Failed');
    expect(badge.className).toContain('text-red-400');
    expect(badge.className).toContain('bg-red-500/20');
    expect(badge).toHaveAttribute('data-status', 'failed');
  });

  it('shows retry button for failed state when onRetry is provided', () => {
    const onRetry = vi.fn();
    render(<EmbeddingStatusBadge embeddingStatus="failed" onRetry={onRetry} />);
    const retryBtn = screen.getByTestId('embedding-retry-button');
    expect(retryBtn).toBeInTheDocument();
    expect(retryBtn).toHaveTextContent('Retry');
  });

  it('does not show retry button for failed state when onRetry is not provided', () => {
    render(<EmbeddingStatusBadge embeddingStatus="failed" />);
    expect(screen.queryByTestId('embedding-retry-button')).not.toBeInTheDocument();
  });

  it('calls onRetry when retry button is clicked', () => {
    const onRetry = vi.fn();
    render(<EmbeddingStatusBadge embeddingStatus="failed" onRetry={onRetry} />);
    const retryBtn = screen.getByTestId('embedding-retry-button');
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('stops event propagation when retry button is clicked', () => {
    const onRetry = vi.fn();
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <EmbeddingStatusBadge embeddingStatus="failed" onRetry={onRetry} />
      </div>,
    );
    fireEvent.click(screen.getByTestId('embedding-retry-button'));
    expect(onRetry).toHaveBeenCalled();
    expect(onParentClick).not.toHaveBeenCalled();
  });

  // ---- Tooltip ----

  it('shows tooltip for not_embedded state', () => {
    render(<EmbeddingStatusBadge embeddingStatus="not_embedded" />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge.getAttribute('title')).toContain('not been indexed');
  });

  it('shows tooltip for embedding state', () => {
    render(<EmbeddingStatusBadge embeddingStatus="embedding" />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge.getAttribute('title')).toContain('being indexed');
  });

  it('shows tooltip with date for embedded state', () => {
    const date = '2026-01-15T12:00:00Z';
    render(<EmbeddingStatusBadge embeddingStatus="embedded" embeddedAt={date} />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge.getAttribute('title')).toContain('Indexed for AI search on');
  });

  it('shows tooltip for failed state', () => {
    render(<EmbeddingStatusBadge embeddingStatus="failed" />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge.getAttribute('title')).toContain('failed');
  });

  // ---- Priority: embeddingStatus takes precedence over embeddingDirty ----

  it('prefers embeddingStatus over embeddingDirty when both are provided', () => {
    render(<EmbeddingStatusBadge embeddingDirty={true} embeddingStatus="embedded" />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge).toHaveAttribute('data-status', 'embedded');
  });

  // ---- Custom className ----

  it('applies custom className', () => {
    render(<EmbeddingStatusBadge embeddingStatus="embedded" className="custom-class" />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge.className).toContain('custom-class');
  });

  // ---- No animation for non-embedding states ----

  it('does not apply animate-pulse for non-embedding states', () => {
    const { rerender } = render(<EmbeddingStatusBadge embeddingStatus="not_embedded" />);
    expect(screen.getByTestId('embedding-status-badge').className).not.toContain('animate-pulse');

    rerender(<EmbeddingStatusBadge embeddingStatus="embedded" />);
    expect(screen.getByTestId('embedding-status-badge').className).not.toContain('animate-pulse');

    rerender(<EmbeddingStatusBadge embeddingStatus="failed" />);
    expect(screen.getByTestId('embedding-status-badge').className).not.toContain('animate-pulse');
  });
});
