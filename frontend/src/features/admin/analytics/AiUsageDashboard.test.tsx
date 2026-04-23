import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EnterpriseContext } from '../../../shared/enterprise/enterprise-context';
import type { EnterpriseContextValue } from '../../../shared/enterprise/types';
import { AiUsageDashboard } from './AiUsageDashboard';
import type { DashboardProps } from './AnalyticsPage';

// ── Mock ChartsBundle ──────────────────────────────────────────────────────────

vi.mock('../../../shared/components/charts/ChartsBundle', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chart mocks only need to render containers
  const P = (_: any) => _.children ?? null;
  return {
    LineChart: P, Line: P, BarChart: P, Bar: P,
    XAxis: P, YAxis: P, Tooltip: P, ResponsiveContainer: P,
    CartesianGrid: P, Legend: P,
  };
});

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

function makeEnterpriseValue(features: string[]): EnterpriseContextValue {
  return {
    ui: null,
    license: {
      edition: 'enterprise' as const,
      tier: 'enterprise' as const,
      valid: true,
      features,
    },
    isEnterprise: true,
    hasFeature: (f: string) => features.includes(f),
    isLoading: false,
  };
}

const defaultDateRange: DashboardProps['dateRange'] = {
  startDate: '2025-01-01',
  endDate: '2025-01-31',
};

const mockData = {
  available: true,
  requestsOverTime: [
    { date: '2025-01-01', requests: 100, errors: 2 },
    { date: '2025-01-02', requests: 150, errors: 5 },
  ],
  tokenConsumption: [
    { model: 'qwen3:4b', inputTokens: 5000, outputTokens: 3000, totalRequests: 80 },
    { model: 'llama3.1', inputTokens: 2000, outputTokens: 1500, totalRequests: 40 },
  ],
  modelBreakdown: [
    { model: 'qwen3:4b', action: 'chat', count: 60, avgDurationMs: 1200 },
    { model: 'llama3.1', action: 'summarize', count: 30, avgDurationMs: 800 },
  ],
  errorRate: { total: 250, errors: 7, rate: 2.8 },
};

function renderDashboard(
  features: string[] = ['advanced_analytics', 'ai_usage_analytics'],
  props?: Partial<DashboardProps>,
) {
  const queryClient = createQueryClient();
  const defaultProps: DashboardProps = {
    dateRange: defaultDateRange,
    onExportPdf: vi.fn(),
    ...props,
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <EnterpriseContext.Provider value={makeEnterpriseValue(features)}>
        <AiUsageDashboard {...defaultProps} />
      </EnterpriseContext.Provider>
    </QueryClientProvider>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('AiUsageDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows feature gate banner when ai_usage_analytics is not enabled', () => {
    renderDashboard(['advanced_analytics']); // missing ai_usage_analytics
    expect(screen.getByTestId('ai-usage-gate')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /AI Usage Analytics/ })).toBeInTheDocument();
  });

  it('renders stat cards when data is available', async () => {
    mockFetch.mockResolvedValue(mockData);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByTestId('stat-total-requests')).toBeInTheDocument();
    });
    expect(screen.getByTestId('stat-total-tokens')).toBeInTheDocument();
    expect(screen.getByTestId('stat-models-used')).toBeInTheDocument();
    expect(screen.getByTestId('stat-error-rate')).toBeInTheDocument();
  });

  it('shows "not available" message when available is false', async () => {
    mockFetch.mockResolvedValue({ available: false, message: 'LLM audit table not found' });
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByTestId('ai-usage-unavailable')).toBeInTheDocument();
    });
    expect(screen.getByText('LLM audit table not found')).toBeInTheDocument();
  });

  it('shows error rate warning when rate > 10%', async () => {
    mockFetch.mockResolvedValue({
      ...mockData,
      errorRate: { total: 100, errors: 15, rate: 15.0 },
    });
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByTestId('error-rate-warning')).toBeInTheDocument();
    });
  });

  it('renders requests-over-time chart container', async () => {
    mockFetch.mockResolvedValue(mockData);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByTestId('requests-chart')).toBeInTheDocument();
    });
  });

  it('renders model breakdown table when data has entries', async () => {
    mockFetch.mockResolvedValue(mockData);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByTestId('model-breakdown-table')).toBeInTheDocument();
    });
    expect(screen.getByText('qwen3:4b')).toBeInTheDocument();
    expect(screen.getByText('chat')).toBeInTheDocument();
  });
});
