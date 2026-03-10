import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  dirtyPages: 25,
  totalEmbeddings: 300,
  isProcessing: false,
};

describe('KPICards', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all five KPI cards', () => {
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
    expect(screen.getByTestId('kpi-spaces-synced')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-embedding-coverage')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-last-sync')).toBeInTheDocument();
  });

  it('displays correct total articles count', () => {
    render(
      <KPICards
        embeddingStatus={mockEmbeddingStatus}
        spacesCount={3}
      />,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('kpi-total-articles');
    expect(card).toHaveTextContent('Total Articles');
    expect(card).toHaveTextContent('100');
  });

  it('displays correct embedded pages count (totalPages - dirtyPages)', () => {
    render(
      <KPICards
        embeddingStatus={mockEmbeddingStatus}
        spacesCount={3}
      />,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('kpi-embedded-pages');
    expect(card).toHaveTextContent('Embedded Pages');
    expect(card).toHaveTextContent('75');
  });

  it('displays correct spaces count', () => {
    render(
      <KPICards
        embeddingStatus={mockEmbeddingStatus}
        spacesCount={7}
      />,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('kpi-spaces-synced');
    expect(card).toHaveTextContent('Spaces Synced');
    expect(card).toHaveTextContent('7');
  });

  it('displays correct embedding coverage percentage', () => {
    render(
      <KPICards
        embeddingStatus={mockEmbeddingStatus}
        spacesCount={3}
      />,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('kpi-embedding-coverage');
    expect(card).toHaveTextContent('Embedding Coverage');
    expect(card).toHaveTextContent('75%');
  });

  it('displays 100% coverage when no dirty pages', () => {
    render(
      <KPICards
        embeddingStatus={{ ...mockEmbeddingStatus, dirtyPages: 0 }}
        spacesCount={3}
      />,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('kpi-embedding-coverage');
    expect(card).toHaveTextContent('100%');
  });

  it('displays 0% coverage when all pages are dirty', () => {
    render(
      <KPICards
        embeddingStatus={{ ...mockEmbeddingStatus, dirtyPages: 100 }}
        spacesCount={3}
      />,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('kpi-embedding-coverage');
    expect(card).toHaveTextContent('0%');
  });

  it('handles 0 total pages without division by zero', () => {
    render(
      <KPICards
        embeddingStatus={{ totalPages: 0, dirtyPages: 0, totalEmbeddings: 0, isProcessing: false }}
        spacesCount={0}
      />,
      { wrapper: Wrapper },
    );

    const coverage = screen.getByTestId('kpi-embedding-coverage');
    expect(coverage).toHaveTextContent('0%');

    const total = screen.getByTestId('kpi-total-articles');
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

  it('shows "Never" when lastSynced is not provided', () => {
    render(
      <KPICards
        embeddingStatus={mockEmbeddingStatus}
        spacesCount={3}
      />,
      { wrapper: Wrapper },
    );

    const card = screen.getByTestId('kpi-last-sync');
    expect(card).toHaveTextContent('Last Sync');
    expect(card).toHaveTextContent('Never');
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
