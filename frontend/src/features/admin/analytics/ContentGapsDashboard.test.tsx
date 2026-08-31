import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContentGapsDashboard } from './ContentGapsDashboard';
import type { DashboardProps } from './AnalyticsPage';

// ── Mock ChartsBundle ──────────────────────────────────────────────────────────

vi.mock('../../../shared/components/charts/ChartsBundle', () => {
  // Recharts only needs to render its children here — the dashboard's charts
  // are not what these tests measure, and jsdom gives them no layout anyway.
  const P = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    PieChart: P, Pie: P, Cell: P,
    Tooltip: P, ResponsiveContainer: P, Legend: P,
  };
});

// ── Mock apiFetch ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.mock('../../../shared/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockFetch(...args),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

const defaultDateRange: DashboardProps['dateRange'] = {
  startDate: '2025-01-01',
  endDate: '2025-01-31',
};

/** One gap per severity band, plus the never-scored case. */
const mockData = {
  gaps: [
    { query: 'severe query', occurrences: 12, lastSearched: '2025-01-20T10:00:00Z', avgMaxScore: 0.05, avgResultCount: 0 },
    { query: 'moderate query', occurrences: 8, lastSearched: '2025-01-19T10:00:00Z', avgMaxScore: 0.35, avgResultCount: 2 },
    { query: 'minor query', occurrences: 4, lastSearched: '2025-01-18T10:00:00Z', avgMaxScore: 0.8, avgResultCount: 6 },
    { query: 'unscored query', occurrences: 2, lastSearched: '2025-01-17T10:00:00Z', avgMaxScore: null, avgResultCount: 0 },
  ],
  duplicateCoverage: [],
  requestBacklog: [{ status: 'open', count: 3 }],
};

function renderDashboard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props: DashboardProps = { dateRange: defaultDateRange, onExportPdf: vi.fn() };
  return render(
    <QueryClientProvider client={queryClient}>
      <ContentGapsDashboard {...props} />
    </QueryClientProvider>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ContentGapsDashboard severity column', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The column used to be a single hue-coded dot in an unlabelled column: the
   * only carrier of severity, and `success`/`status-inactive` (and
   * `warning`/`destructive`) collapse under deuteranopia. Both replacement
   * channels are asserted — filled-bar COUNT and a readable state word.
   */
  it('names every severity in text, not only in colour', async () => {
    mockFetch.mockResolvedValue(mockData);
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByTestId('gaps-table')).toBeInTheDocument();
    });

    expect(screen.getByText('Severe gap')).toBeInTheDocument();
    expect(screen.getByText('Moderate gap')).toBeInTheDocument();
    expect(screen.getByText('Minor gap')).toBeInTheDocument();
    expect(screen.getByText('Never scored')).toBeInTheDocument();

    // The column itself is named, so the words above have a header to be read
    // against in a screen reader's table navigation.
    expect(screen.getByText('Severity')).toBeInTheDocument();
  });

  it('encodes severity as bar count, so it survives a greyscale render', async () => {
    mockFetch.mockResolvedValue(mockData);
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByTestId('gaps-table')).toBeInTheDocument();
    });

    // Row order matches mockData.gaps: severe, moderate, minor, unscored.
    const filled = screen
      .getAllByTestId('gap-severity')
      .map((el) => el.getAttribute('data-filled'));
    expect(filled).toEqual(['3', '2', '1', '0']);

    // Distinct counts must also be distinct in the DOM, not just in the
    // attribute: count the bars that carry a hue class rather than the track.
    const bars = screen
      .getAllByTestId('gap-severity')
      .map((el) => el.querySelectorAll('span[class*="bg-"]:not([class*="bg-border"])').length);
    expect(bars).toEqual([3, 2, 1, 0]);
  });

  it('keeps the meter out of the accessibility tree so the word is the name', async () => {
    mockFetch.mockResolvedValue(mockData);
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByTestId('gaps-table')).toBeInTheDocument();
    });

    for (const marker of screen.getAllByTestId('gap-severity')) {
      expect(marker.querySelector('[aria-hidden="true"]')).not.toBeNull();
      expect(marker.querySelector('.sr-only')?.textContent).toBeTruthy();
    }
  });
});
