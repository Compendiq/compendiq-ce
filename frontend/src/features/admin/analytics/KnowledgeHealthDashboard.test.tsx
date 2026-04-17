import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KnowledgeHealthDashboard } from './KnowledgeHealthDashboard';
import type { DashboardProps } from './AnalyticsPage';

// ── Mock ChartsBundle ──────────────────────────────────────────────────────────

vi.mock('../../../shared/components/charts/ChartsBundle', () => ({
  BarChart: ({ children, ...props }: any) => <div data-testid="bar-chart" {...props}>{children}</div>,
  Bar: (props: any) => <div data-testid="bar" {...props} />,
  PieChart: ({ children, ...props }: any) => <div data-testid="pie-chart" {...props}>{children}</div>,
  Pie: ({ children, ...props }: any) => <div data-testid="pie" {...props}>{children}</div>,
  Cell: (props: any) => <div data-testid="cell" {...props} />,
  Treemap: (props: any) => <div data-testid="treemap" {...props} />,
  XAxis: (props: any) => <div {...props} />,
  YAxis: (props: any) => <div {...props} />,
  Tooltip: () => <div />,
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  CartesianGrid: () => <div />,
  Legend: () => <div />,
}));

// ── Mock apiFetch ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.mock('../../../shared/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockFetch(...args),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

const defaultDateRange: DashboardProps['dateRange'] = {
  startDate: '2025-01-01',
  endDate: '2025-01-31',
};

const mockData = {
  qualityDistribution: [
    { bucket: 'excellent', count: 10 },
    { bucket: 'good', count: 20 },
    { bucket: 'fair', count: 15 },
    { bucket: 'poor', count: 5 },
  ],
  staleContent: [
    { bucket: '< 30 days', count: 50 },
    { bucket: '30-90 days', count: 30 },
    { bucket: '> 90 days', count: 20 },
  ],
  coverageBySpace: [
    { spaceKey: 'ENG', pageCount: 100, avgQuality: 0.8 },
    { spaceKey: 'OPS', pageCount: 50, avgQuality: 0.6 },
  ],
  verificationStatus: [
    { status: 'verified_current', count: 40 },
    { status: 'verified_stale', count: 15 },
    { status: 'unverified', count: 45 },
  ],
};

function renderDashboard(props?: Partial<DashboardProps>) {
  const queryClient = createQueryClient();
  const defaultProps: DashboardProps = {
    dateRange: defaultDateRange,
    onExportPdf: vi.fn(),
    onExportExcel: vi.fn(),
    ...props,
  };
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <KnowledgeHealthDashboard {...defaultProps} />
      </QueryClientProvider>,
    ),
    props: defaultProps,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('KnowledgeHealthDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading skeleton during fetch', () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // never resolves
    renderDashboard();
    expect(screen.getByTestId('knowledge-loading')).toBeInTheDocument();
  });

  it('renders chart containers when data is loaded', async () => {
    mockFetch.mockResolvedValue(mockData);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByTestId('quality-chart')).toBeInTheDocument();
    });
    expect(screen.getByTestId('stale-chart')).toBeInTheDocument();
    expect(screen.getByTestId('coverage-chart')).toBeInTheDocument();
    expect(screen.getByTestId('verification-chart')).toBeInTheDocument();
  });

  it('renders empty state when no data is returned', async () => {
    mockFetch.mockResolvedValue(null);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-empty')).toBeInTheDocument();
    });
  });

  it('calls export handlers when export buttons are clicked', async () => {
    mockFetch.mockResolvedValue(mockData);
    const onExportPdf = vi.fn();
    const onExportExcel = vi.fn();
    renderDashboard({ onExportPdf, onExportExcel });

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-export-pdf')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('knowledge-export-pdf'));
    expect(onExportPdf).toHaveBeenCalledTimes(1);
    expect(onExportPdf).toHaveBeenCalledWith(expect.any(Array), 'Knowledge Health');

    fireEvent.click(screen.getByTestId('knowledge-export-excel'));
    expect(onExportExcel).toHaveBeenCalledTimes(1);
    expect(onExportExcel).toHaveBeenCalledWith(expect.any(Array), 'Knowledge Health');
  });

  it('renders quality distribution chart heading', async () => {
    mockFetch.mockResolvedValue(mockData);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Quality Score Distribution')).toBeInTheDocument();
    });
  });
});
