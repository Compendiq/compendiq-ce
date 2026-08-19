import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LazyMotion, domAnimation } from 'framer-motion';
import { KPICards } from './KPICards';
import { formatRelativeTime } from '../../shared/lib/format-relative-time';

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={domAnimation}>
      {children}
    </LazyMotion>
  );
}

const mockEmbeddingStatus = {
  totalPages: 100,
  embeddedPages: 75,
  dirtyPages: 25,
  totalEmbeddings: 300,
  isProcessing: false,
};

describe('KPICards', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders three tiles, not five', () => {
    // The July-2026 critique found five equal-weight tiles where two were
    // derived from the others: "Embedding Coverage" was embedded/total, and
    // both operands sat immediately to its left. Coverage and the space count
    // are now qualifiers inside the tiles they describe.
    render(
      <KPICards
        embeddingStatus={mockEmbeddingStatus}
        spacesCount={5}
        lastSynced="2026-03-10T10:00:00Z"
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByTestId('kpi-cards')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-total-articles')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-embedded-pages')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-last-sync')).toBeInTheDocument();

    // Coverage and spaces still render — inside their parent tiles.
    expect(screen.getByTestId('kpi-total-articles')).toContainElement(
      screen.getByTestId('kpi-spaces-synced'),
    );
    expect(screen.getByTestId('kpi-embedded-pages')).toContainElement(
      screen.getByTestId('kpi-embedding-coverage'),
    );
  });

  it('renders Last Sync as the final segment of the KPI strip', () => {
    render(
      <KPICards embeddingStatus={mockEmbeddingStatus} spacesCount={5} />,
      { wrapper: Wrapper },
    );

    const lastSync = screen.getByTestId('kpi-last-sync');
    const segments = Array.from(screen.getByTestId('kpi-cards').children);
    expect(segments.indexOf(lastSync)).toBe(segments.length - 1);
  });

  it('offers the sync action inside the Last Sync tile', () => {
    const onSync = vi.fn();
    render(
      <KPICards embeddingStatus={mockEmbeddingStatus} spacesCount={5} onSync={onSync} />,
      { wrapper: Wrapper },
    );

    const btn = screen.getByTestId('kpi-sync-btn');
    expect(screen.getByTestId('kpi-last-sync')).toContainElement(btn);
    fireEvent.click(btn);
    expect(onSync).toHaveBeenCalledOnce();
  });

  it('disables the sync action while a sync is running', () => {
    render(
      <KPICards embeddingStatus={mockEmbeddingStatus} spacesCount={5} onSync={vi.fn()} isSyncing />,
      { wrapper: Wrapper },
    );

    expect(screen.getByTestId('kpi-sync-btn')).toBeDisabled();
    expect(screen.getByTestId('kpi-sync-btn')).toHaveTextContent('Syncing...');
  });

  it('omits the sync action when no handler is supplied', () => {
    render(
      <KPICards embeddingStatus={mockEmbeddingStatus} spacesCount={5} />,
      { wrapper: Wrapper },
    );

    expect(screen.queryByTestId('kpi-sync-btn')).not.toBeInTheDocument();
  });

  it('displays correct total articles count', async () => {
    render(
      <KPICards
        embeddingStatus={mockEmbeddingStatus}
        spacesCount={3}
      />,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('kpi-total-articles');
    expect(card).toHaveTextContent('Total Pages');
    // AnimatedCounter animates from 0 to target via spring physics
    await waitFor(() => {
      expect(card).toHaveTextContent('100');
    }, { timeout: 3000 });
  });

  it('displays correct embedded pages count from API embeddedPages field', async () => {
    render(
      <KPICards
        embeddingStatus={mockEmbeddingStatus}
        spacesCount={3}
      />,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('kpi-embedded-pages');
    expect(card).toHaveTextContent('Embedded');
    await waitFor(() => {
      expect(card).toHaveTextContent('75');
    }, { timeout: 3000 });
  });

  it('displays the spaces count as a qualifier on the total-pages tile', () => {
    render(
      <KPICards
        embeddingStatus={mockEmbeddingStatus}
        spacesCount={7}
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByTestId('kpi-spaces-synced')).toHaveTextContent('across 7 spaces');
  });

  it('pluralises a single space correctly', () => {
    render(
      <KPICards embeddingStatus={mockEmbeddingStatus} spacesCount={1} />,
      { wrapper: Wrapper },
    );

    // "1 pages" appeared elsewhere in the app; don't repeat it here.
    expect(screen.getByTestId('kpi-spaces-synced')).toHaveTextContent('across 1 space');
    expect(screen.getByTestId('kpi-spaces-synced')).not.toHaveTextContent('1 spaces');
  });

  it('folds coverage into the embedded tile as "of N (P%)"', async () => {
    render(
      <KPICards
        embeddingStatus={mockEmbeddingStatus}
        spacesCount={3}
      />,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('kpi-embedding-coverage');
    await waitFor(() => {
      expect(card).toHaveTextContent('of 100 (75%)');
    }, { timeout: 3000 });
  });

  it('displays 100% coverage when all pages are embedded', async () => {
    render(
      <KPICards
        embeddingStatus={{ ...mockEmbeddingStatus, embeddedPages: 100, dirtyPages: 0 }}
        spacesCount={3}
      />,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('kpi-embedding-coverage');
    await waitFor(() => {
      expect(card).toHaveTextContent('100%');
    }, { timeout: 3000 });
  });

  it('displays 0% coverage when no pages are embedded', () => {
    render(
      <KPICards
        embeddingStatus={{ ...mockEmbeddingStatus, embeddedPages: 0, dirtyPages: 100 }}
        spacesCount={3}
      />,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('kpi-embedding-coverage');
    // 0% is the initial value too, so no animation needed
    expect(card).toHaveTextContent('0%');
  });

  it('uses embeddedPages from API instead of deriving from totalPages - dirtyPages', async () => {
    // Scenario: 100 total pages, 10 dirty, but only 60 actually have embeddings
    // (30 pages had short/empty content and were skipped by embedPage)
    // Old buggy code would show 90 embedded (100 - 10), new code shows 60.
    render(
      <KPICards
        embeddingStatus={{
          totalPages: 100,
          embeddedPages: 60,
          dirtyPages: 10,
          totalEmbeddings: 200,
          isProcessing: false,
        }}
        spacesCount={3}
      />,
      { wrapper: Wrapper },
    );

    const embeddedCard = screen.getByTestId('kpi-embedded-pages');
    await waitFor(() => {
      expect(embeddedCard).toHaveTextContent('60');
    }, { timeout: 3000 });

    const coverageCard = screen.getByTestId('kpi-embedding-coverage');
    expect(coverageCard).toHaveTextContent('60%');
  });

  it('handles 0 total pages without division by zero', () => {
    render(
      <KPICards
        embeddingStatus={{ totalPages: 0, embeddedPages: 0, dirtyPages: 0, totalEmbeddings: 0, isProcessing: false }}
        spacesCount={0}
      />,
      { wrapper: Wrapper },
    );

    const coverage = screen.getByTestId('kpi-embedding-coverage');
    expect(coverage).toHaveTextContent('0%');

    const total = screen.getByTestId('kpi-total-articles');
    // 0 is also the starting value, so it should be there immediately
    expect(total).toHaveTextContent('0');
  });

  it('shows placeholder dashes when embeddingStatus is undefined', () => {
    render(
      <KPICards
        embeddingStatus={undefined}
        spacesCount={3}
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByTestId('kpi-total-articles')).toHaveTextContent('--');
    expect(screen.getByTestId('kpi-embedded-pages')).toHaveTextContent('--');
    expect(screen.getByTestId('kpi-embedding-coverage')).toHaveTextContent('--');
  });

  it('says Not recorded when lastSynced is missing but pages exist', () => {
    render(
      <KPICards
        embeddingStatus={mockEmbeddingStatus}
        spacesCount={3}
      />,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('kpi-last-sync');
    expect(card).toHaveTextContent('Last Sync');
    expect(card).toHaveTextContent('Not recorded');
    expect(card).not.toHaveTextContent('Never');
  });

  it('does not claim zero spaces when the library already has pages', () => {
    render(
      <KPICards
        embeddingStatus={mockEmbeddingStatus}
        spacesCount={0}
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByTestId('kpi-spaces-synced')).toHaveTextContent('in the library');
    expect(screen.getByTestId('kpi-spaces-synced')).not.toHaveTextContent('0 spaces');
  });

  it('shows relative time for lastSynced', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();

    render(
      <KPICards
        embeddingStatus={mockEmbeddingStatus}
        spacesCount={3}
        lastSynced={fiveMinutesAgo}
      />,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('kpi-last-sync');
    expect(card).toHaveTextContent('5m ago');
  });

  it('renders the embedding coverage ring SVG', () => {
    render(
      <KPICards
        embeddingStatus={mockEmbeddingStatus}
        spacesCount={3}
      />,
      { wrapper: Wrapper },
    );

    const ring = screen.getByTestId('embedding-coverage-ring');
    expect(ring).toBeInTheDocument();
    // Should contain an SVG with aria label
    const svg = ring.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('aria-label', 'Embedding coverage: 75%');
  });

  it('renders the coverage ring with correct aria-label at 100%', () => {
    render(
      <KPICards
        embeddingStatus={{ ...mockEmbeddingStatus, embeddedPages: 100, dirtyPages: 0 }}
        spacesCount={3}
      />,
      { wrapper: Wrapper },
    );

    const ring = screen.getByTestId('embedding-coverage-ring');
    const svg = ring.querySelector('svg');
    expect(svg).toHaveAttribute('aria-label', 'Embedding coverage: 100%');
  });

  // These are three segments of ONE strip, not three cards. The old version of
  // this test asserted each carried `rounded-xl bg-card h-full` — the tile
  // styling — which is exactly what a strip must not have: three bordered
  // panes inside a bordered pane is the nested-card shape.
  it('renders one separated strip with all three segments inside it', () => {
    render(
      <KPICards
        embeddingStatus={mockEmbeddingStatus}
        spacesCount={5}
        lastSynced="2026-03-10T10:00:00Z"
      />,
      { wrapper: Wrapper },
    );

    // Separated by a rule, not boxed. The strip is ambient status — a caption
    // on the page rather than an object on it — so it carries a bottom hairline
    // and no fill. It used to assert `bg-card`, which pinned the container the
    // destacking pass removed; the intent was always "one strip, and the
    // segments own no pane styling", which the loop below is what actually
    // tests.
    const strip = screen.getByTestId('kpi-cards');
    expect(strip.className).not.toContain('bg-card');

    for (const testId of ['kpi-total-articles', 'kpi-embedded-pages', 'kpi-last-sync']) {
      const segment = screen.getByTestId(testId);
      expect(strip).toContainElement(segment);
      // No pane styling of its own — the strip is the only surface.
      expect(segment.className).not.toContain('bg-card');
      expect(segment.className).not.toContain('rounded-xl');
    }
  });
});

describe('formatRelativeTime', () => {
  it('returns "just now" for times less than 1 minute ago', () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe('just now');
  });

  it('returns minutes for times less than 1 hour ago', () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(formatRelativeTime(tenMinAgo)).toBe('10m ago');
  });

  it('returns hours for times less than 1 day ago', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(formatRelativeTime(threeHoursAgo)).toBe('3h ago');
  });

  it('returns days for times less than 1 week ago', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect(formatRelativeTime(twoDaysAgo)).toBe('2d ago');
  });

  it('returns locale date string for times more than 1 week ago', () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const result = formatRelativeTime(twoWeeksAgo);
    // Should be a formatted date string, not relative
    expect(result).not.toContain('ago');
    expect(result).not.toBe('just now');
  });
});
