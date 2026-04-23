import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EnterpriseContext } from '../../../shared/enterprise/enterprise-context';
import type { EnterpriseContextValue } from '../../../shared/enterprise/types';
import { AnalyticsPage } from './AnalyticsPage';

// ── Mock lazy-loaded dashboards ────────────────────────────────────────────────

vi.mock('./KnowledgeHealthDashboard', () => ({
  KnowledgeHealthDashboard: () => <div data-testid="knowledge-dashboard-mock">Knowledge Health</div>,
}));
vi.mock('./AiUsageDashboard', () => ({
  AiUsageDashboard: () => <div data-testid="ai-usage-dashboard-mock">AI Usage</div>,
}));
vi.mock('./SearchEffectivenessDashboard', () => ({
  SearchEffectivenessDashboard: () => <div data-testid="search-dashboard-mock">Search</div>,
}));
vi.mock('./ContentGapsDashboard', () => ({
  ContentGapsDashboard: () => <div data-testid="content-gaps-dashboard-mock">Content Gaps</div>,
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

function renderWithProviders(
  features: string[] = ['advanced_analytics', 'ai_usage_analytics'],
) {
  const queryClient = createQueryClient();
  const enterpriseValue = features.length > 0
    ? makeEnterpriseValue(features)
    : {
        ui: null,
        license: null,
        isEnterprise: false,
        hasFeature: () => false,
        isLoading: false,
      };

  return render(
    <QueryClientProvider client={queryClient}>
      <EnterpriseContext.Provider value={enterpriseValue}>
        <AnalyticsPage />
      </EnterpriseContext.Provider>
    </QueryClientProvider>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('AnalyticsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows gate banner when advanced_analytics feature is not enabled', () => {
    renderWithProviders([]);
    expect(screen.getByTestId('analytics-gate')).toBeInTheDocument();
    expect(screen.getByText(/require an Enterprise license/)).toBeInTheDocument();
  });

  it('renders 4 tab buttons when feature is enabled', () => {
    renderWithProviders();
    expect(screen.getByTestId('analytics-tabs')).toBeInTheDocument();
    expect(screen.getByTestId('tab-knowledge')).toBeInTheDocument();
    expect(screen.getByTestId('tab-ai-usage')).toBeInTheDocument();
    expect(screen.getByTestId('tab-search')).toBeInTheDocument();
    expect(screen.getByTestId('tab-content-gaps')).toBeInTheDocument();
  });

  it('defaults to Knowledge Health tab', async () => {
    renderWithProviders();
    // The knowledge dashboard should be rendered by default
    expect(await screen.findByTestId('knowledge-dashboard-mock')).toBeInTheDocument();
  });

  it('switches tabs when clicked', async () => {
    renderWithProviders();
    fireEvent.click(screen.getByTestId('tab-search'));
    expect(await screen.findByTestId('search-dashboard-mock')).toBeInTheDocument();
  });

  it('renders date range inputs', () => {
    renderWithProviders();
    expect(screen.getByTestId('date-start')).toBeInTheDocument();
    expect(screen.getByTestId('date-end')).toBeInTheDocument();
  });

  it('updates date range state when inputs change', () => {
    renderWithProviders();
    const startInput = screen.getByTestId('date-start') as HTMLInputElement;
    fireEvent.change(startInput, { target: { value: '2025-01-01' } });
    expect(startInput.value).toBe('2025-01-01');
  });

  it('shows AI Usage tab with reduced opacity when ai_usage_analytics is not enabled', () => {
    renderWithProviders(['advanced_analytics']);
    const aiTab = screen.getByTestId('tab-ai-usage');
    // Tab should be rendered but with opacity class
    expect(aiTab).toBeInTheDocument();
    expect(aiTab.className).toContain('opacity-50');
  });

  it('does not render a header-level export dropdown (removed in #303)', () => {
    // The header-level "Export" dropdown was removed because its click
    // handlers were dead. Per-dashboard PDF buttons are the real surface.
    renderWithProviders();
    expect(screen.queryByTestId('export-btn')).toBeNull();
    expect(screen.queryByTestId('export-pdf')).toBeNull();
  });
});
