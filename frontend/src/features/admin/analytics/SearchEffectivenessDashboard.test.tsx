import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SearchEffectivenessDashboard } from './SearchEffectivenessDashboard';
import type { DashboardProps } from './AnalyticsPage';

// ── Mock ChartsBundle ──────────────────────────────────────────────────────────

vi.mock('../../../shared/components/charts/ChartsBundle', () => {
  // Recharts only needs to render its children here; jsdom gives charts no layout.
  const P = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    AreaChart: P, Area: P, BarChart: P, Bar: P, PieChart: P, Pie: P, Cell: P,
    XAxis: P, YAxis: P, Tooltip: P, ResponsiveContainer: P, CartesianGrid: P, Legend: P,
  };
});

// ── Mock apiFetch ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.mock('../../../shared/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockFetch(...args),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

const mockData = {
  zeroResultRate: { total: 40, zeroResults: 6, rate: 0.15 },
  topQueries: [{ query: 'vpn setup', searchCount: 12, avgResults: 4, avgScore: 0.62 }],
  clickThroughRate: [{ searchType: 'hybrid', withResults: 30, total: 40, rate: 75 }],
  dailyVolume: [{ date: '2025-01-01', totalSearches: 40, zeroResultSearches: 6 }],
};

function renderDashboard(onExportPdf: DashboardProps['onExportPdf']) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SearchEffectivenessDashboard
        dateRange={{ startDate: '2025-01-01', endDate: '2025-01-31' }}
        onExportPdf={onExportPdf}
      />
    </QueryClientProvider>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('SearchEffectivenessDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes its rows, title and KPIs to the PDF export handler (#1732)', async () => {
    mockFetch.mockResolvedValue(mockData);
    const onExportPdf = vi.fn();
    renderDashboard(onExportPdf);

    fireEvent.click(await screen.findByTestId('search-export-pdf'));

    expect(onExportPdf).toHaveBeenCalledTimes(1);
    expect(onExportPdf).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ type: 'zeroResultRate', total: 40, zeroResults: 6 }),
        expect.objectContaining({ type: 'topQuery', query: 'vpn setup' }),
      ]),
      'Search Effectiveness',
      expect.arrayContaining([
        expect.objectContaining({ label: 'Zero-result rate', value: '15.0', unit: '%' }),
        expect.objectContaining({ label: 'Top query', value: 'vpn setup' }),
      ]),
    );
  });
});
