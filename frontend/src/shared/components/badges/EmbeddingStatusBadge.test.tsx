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

  it('renders not_embedded state token-neutral — no hex literals, no dark: variant', () => {
    render(<EmbeddingStatusBadge embeddingStatus="not_embedded" />);
    const badge = screen.getByTestId('badge-not-embedded');
    expect(badge).toHaveTextContent('Not Embedded');
    // The old warm-gray hexes hid behind a `dark:` variant, which — with no
    // `@custom-variant dark` in this app — compiles to the OS media query, so
    // OS-dark + user-picked Paper rendered a dark pill on the white page.
    expect(badge.className).toContain('bg-muted');
    expect(badge.className).toContain('text-muted-foreground');
    expect(badge.className).not.toMatch(/#[0-9a-fA-F]{3,8}|dark:/);
    expect(badge.className).not.toMatch(/amber|warning|yellow|primary/);
    expect(badge).toHaveAttribute('data-status', 'not_embedded');
  });

  it('renders embedding state with blue styling and pulse animation', () => {
    render(<EmbeddingStatusBadge embeddingStatus="embedding" />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge).toHaveTextContent('Embedding...');
    expect(badge.className).toContain('text-status-embedding');
    expect(badge.className).toContain('bg-status-embedding/20');
    expect(badge.className).toContain('animate-pulse');
    expect(badge).toHaveAttribute('data-status', 'embedding');
  });

  // "Embedded <date>" is the resting state of every healthy page — a
  // freshness readout, not an event — so it may not wear the connected green:
  // a permanent green pill on every Details tab dilutes the one hue that
  // means "a connection is up". The live states (embedding/failed) keep
  // their reserved hues.
  it('renders embedded state neutral, not in the connected green', () => {
    render(<EmbeddingStatusBadge embeddingStatus="embedded" />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge).toHaveTextContent('Embedded');
    expect(badge.className).toContain('bg-muted');
    expect(badge.className).toContain('text-muted-foreground');
    expect(badge.className).not.toMatch(/status-connected|success|green/);
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
    expect(badge.className).toContain('text-status-disconnected');
    expect(badge.className).toContain('bg-status-disconnected/20');
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
    const badge = screen.getByTestId('badge-not-embedded');
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

  it('shows error message in tooltip when embeddingError is provided', () => {
    render(
      <EmbeddingStatusBadge
        embeddingStatus="failed"
        embeddingError="Connection refused: Ollama server not reachable"
      />,
    );
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge.getAttribute('title')).toContain('Connection refused: Ollama server not reachable');
    expect(badge.getAttribute('title')).toContain('Embedding failed:');
  });

  it('shows generic tooltip when failed with no embeddingError', () => {
    render(<EmbeddingStatusBadge embeddingStatus="failed" embeddingError={null} />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge.getAttribute('title')).toContain('click retry to try again');
  });

  it('does not show error in tooltip for non-failed states', () => {
    render(
      <EmbeddingStatusBadge
        embeddingStatus="embedded"
        embeddingError="some stale error"
      />,
    );
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge.getAttribute('title')).not.toContain('some stale error');
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
    expect(screen.getByTestId('badge-not-embedded').className).not.toContain('animate-pulse');

    rerender(<EmbeddingStatusBadge embeddingStatus="embedded" />);
    expect(screen.getByTestId('embedding-status-badge').className).not.toContain('animate-pulse');

    rerender(<EmbeddingStatusBadge embeddingStatus="failed" />);
    expect(screen.getByTestId('embedding-status-badge').className).not.toContain('animate-pulse');
  });
});
