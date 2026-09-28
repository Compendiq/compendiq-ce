import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmbeddingStatusBadge } from './EmbeddingStatusBadge';

describe('EmbeddingStatusBadge', () => {
  // ---- Legacy boolean prop backward compatibility ----

  it('renders "Not indexed" when embeddingDirty is true (legacy)', () => {
    render(<EmbeddingStatusBadge embeddingDirty={true} />);
    expect(screen.getByText('Not indexed')).toBeInTheDocument();
  });

  it('renders "Embedded" when embeddingDirty is false (legacy)', () => {
    render(<EmbeddingStatusBadge embeddingDirty={false} />);
    expect(screen.getByText('Embedded')).toBeInTheDocument();
  });

  // ---- New 4-state embeddingStatus prop ----

  it('renders not_embedded state token-neutral — no hex literals, no dark: variant', () => {
    render(<EmbeddingStatusBadge embeddingStatus="not_embedded" />);
    const badge = screen.getByTestId('badge-not-embedded');
    expect(badge).toHaveTextContent('Not indexed');
    // The old warm-gray hexes hid behind a `dark:` variant, which — with no
    // `@custom-variant dark` in this app — compiles to the OS media query, so
    // OS-dark + user-picked Paper rendered a dark pill on the white page.
    // Resting states wear the neutral chip recipe: `bg-muted` with no border
    // measured 1.04:1 against the inspector pane — an invisible pill.
    expect(badge.className).toContain('border-border');
    expect(badge.className).toContain('bg-foreground/10');
    expect(badge.className).toContain('text-secondary-foreground');
    expect(badge.className).not.toContain('bg-muted');
    expect(badge.className).not.toMatch(/#[0-9a-fA-F]{3,8}|dark:/);
    expect(badge.className).not.toMatch(/amber|warning|yellow|primary/);
    expect(badge).toHaveAttribute('data-status', 'not_embedded');
  });

  // Was: "renders embedding state with blue styling and pulse animation",
  // asserting the fill at 20% and the ink class. Both assertions died with the
  // hue: `--color-status-embedding` resolves to body ink now (it had been
  // byte-identical to `--color-primary`), so there is no blue to assert and
  // re-stating the ink class would only mirror the stylesheet. What has to
  // hold instead is the two non-colour channels plus the measured weight
  // ceiling.
  it('renders embedding state hueless — label and glyph carry the state', () => {
    render(<EmbeddingStatusBadge embeddingStatus="embedding" />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge).toHaveTextContent('Embedding…');
    expect(badge).toHaveAttribute('data-status', 'embedding');

    // Channel 1 — a glyph no sibling state renders. This is the one that has
    // to survive `prefers-reduced-motion: reduce`, under which index.css
    // clamps every animation to 0.01ms and a single iteration.
    expect(badge.querySelector('[data-testid="embedding-status-glyph"]')).toBeTruthy();
    // Channel 2 — motion, a redundant enhancement on top, never the only one.
    expect(badge.className).toContain('animate-pulse');

    // The measured ceiling, pinned by enumeration so no literal dead utility
    // has to be written here. An embedding surface may not out-weigh the
    // `--color-border` hairline (1.414:1 Paper / 1.264:1 Graphite on Pane):
    // the fill at 20% measured 1.527 / 1.746:1, and any `border-` utility
    // bound to this token composites over the fill and reaches 1.439 / 1.592:1
    // at the pill's outer edge. The 10% fill (1.225 / 1.278:1) and the quiet
    // hairline token are the pair that fits.
    const utilities = badge.className.split(/\s+/);
    expect(utilities.filter((c) => c.startsWith('bg-'))).toEqual(['bg-status-embedding/10']);
    expect(utilities.filter((c) => c.startsWith('border-'))).toEqual(['border-border']);
  });

  // With `embedding` hueless too, three of the four states are neutral. What
  // keeps them apart is enumerated here so a future relabel cannot quietly
  // collapse two of them into the same rendering.
  it('keeps all four states distinguishable without colour', () => {
    const signatures = (['not_embedded', 'embedding', 'embedded', 'failed'] as const).map(
      (status) => {
        const { container, unmount } = render(
          <EmbeddingStatusBadge embeddingStatus={status} onRetry={() => {}} />,
        );
        const badge = screen.getByTestId(
          status === 'not_embedded' ? 'badge-not-embedded' : 'embedding-status-badge',
        );
        const signature = [
          badge.textContent,
          badge.querySelector('[data-testid="embedding-status-glyph"]') ? 'glyph' : '-',
          container.querySelector('[data-testid="embedding-retry-button"]') ? 'retry' : '-',
        ].join('|');
        unmount();
        return signature;
      },
    );
    expect(new Set(signatures).size).toBe(4);
  });

  // "Embedded <date>" is the resting state of every healthy page — a
  // freshness readout, not an event — so it may not wear the connected green:
  // a permanent green pill on every Details tab dilutes the one hue that
  // means "a connection is up". `failed` keeps its reserved red; `embedding`
  // gave its hue up entirely and reads from label, glyph and ink weight.
  it('renders embedded state neutral, not in the connected green', () => {
    render(<EmbeddingStatusBadge embeddingStatus="embedded" />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge).toHaveTextContent('Embedded');
    expect(badge.className).toContain('border-border');
    expect(badge.className).not.toContain('bg-muted');
    expect(badge.className).not.toMatch(/status-connected|success|green/);
    expect(badge).toHaveAttribute('data-status', 'embedded');
  });

  it('renders embedded state with relative timestamp when embeddedAt is provided', () => {
    const recentDate = new Date(Date.now() - 3600_000).toISOString(); // 1 hour ago
    render(<EmbeddingStatusBadge embeddingStatus="embedded" embeddedAt={recentDate} />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge).toHaveTextContent(/Embedded 1h ago/);
  });

  // Red is never the only channel: the failed chip carries a glyph too.
  it('renders failed state with red styling and an alert glyph', () => {
    render(<EmbeddingStatusBadge embeddingStatus="failed" />);
    const badge = screen.getByTestId('embedding-status-badge');
    expect(badge).toHaveTextContent('Indexing failed');
    expect(badge.className).toContain('text-status-disconnected');
    expect(badge.className).toContain('bg-status-disconnected/20');
    expect(badge.querySelector('[data-testid="embedding-status-glyph"]')).toBeTruthy();
    expect(badge).toHaveAttribute('data-status', 'failed');
  });

  // Retry is a real 32px control beside the chip — nesting it inside a passive
  // readout put an 11px button in a pill a screen reader announced as a note.
  it('renders Retry as a sibling button outside the chip', () => {
    const onRetry = vi.fn();
    render(<EmbeddingStatusBadge embeddingStatus="failed" onRetry={onRetry} />);
    const badge = screen.getByTestId('embedding-status-badge');
    const retryBtn = screen.getByRole('button', { name: /retry/i });
    expect(retryBtn).toHaveAttribute('type', 'button');
    expect(retryBtn).toHaveTextContent('Retry');
    expect(badge.contains(retryBtn)).toBe(false);
    expect(retryBtn.parentElement).toBe(badge.parentElement);
    expect(retryBtn.className).toContain('h-8');
    expect(retryBtn.className).not.toContain('text-[11px]');
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not show retry button for failed state when onRetry is not provided', () => {
    render(<EmbeddingStatusBadge embeddingStatus="failed" />);
    expect(screen.queryByTestId('embedding-retry-button')).not.toBeInTheDocument();
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

  // ---- Passive readout ----

  // Passive means passive: a chip that takes focus is a Tab stop with nothing
  // to do, and an aria-label replaced the visible label with the tooltip copy.
  it.each(['not_embedded', 'embedding', 'embedded', 'failed'] as const)(
    '%s chip is not focusable and is named by its visible text',
    (status) => {
      const { container } = render(<EmbeddingStatusBadge embeddingStatus={status} />);
      const badge = screen.getByTestId(
        status === 'not_embedded' ? 'badge-not-embedded' : 'embedding-status-badge',
      );
      expect(badge).not.toHaveAttribute('role');
      expect(badge).not.toHaveAttribute('tabindex');
      expect(badge).not.toHaveAttribute('aria-label');
      expect(container.querySelectorAll('[tabindex], button, a[href], input')).toHaveLength(0);
    },
  );

  it('offers exactly one Tab stop in the failed state — the Retry button', () => {
    const { container } = render(
      <EmbeddingStatusBadge embeddingStatus="failed" onRetry={() => {}} />,
    );
    const stops = container.querySelectorAll('[tabindex], button, a[href], input');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(screen.getByTestId('embedding-retry-button'));
  });

  it('keeps the exact embedded timestamp in title as a pointer supplement', () => {
    const date = '2026-01-15T12:00:00Z';
    render(<EmbeddingStatusBadge embeddingStatus="embedded" embeddedAt={date} />);
    expect(screen.getByTestId('embedding-status-badge')).toHaveAttribute(
      'title',
      `Indexed for AI search on ${new Date(date).toLocaleString()}`,
    );
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
