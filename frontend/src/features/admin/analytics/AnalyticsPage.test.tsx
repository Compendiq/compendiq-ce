import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PDFDocument } from 'pdf-lib';
import { toast } from 'sonner';
import { EnterpriseContext } from '../../../shared/enterprise/enterprise-context';
import type { EnterpriseContextValue } from '../../../shared/enterprise/types';
import { setPdfRendererOverlay } from '../../../shared/lib/export-helpers';
import { AnalyticsPage, type DashboardProps } from './AnalyticsPage';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// ── Mock lazy-loaded dashboards ────────────────────────────────────────────────
// Each mock's PDF button calls `onExportPdf` the way its real dashboard does,
// so the page's export handler runs against the real export-helpers.

vi.mock('./KnowledgeHealthDashboard', () => ({
  KnowledgeHealthDashboard: ({ onExportPdf }: DashboardProps) => (
    <div data-testid="knowledge-dashboard-mock">
      Knowledge Health
      <button
        type="button"
        data-testid="mock-export-pdf"
        onClick={() => onExportPdf(
          [{ type: 'quality', bucket: '80-100', count: 4 }],
          'Knowledge Health',
          [{ label: 'Total pages', value: 4 }],
        )}
      >
        PDF
      </button>
    </div>
  ),
}));
vi.mock('./AiUsageDashboard', () => ({
  AiUsageDashboard: ({ onExportPdf }: DashboardProps) => (
    <div data-testid="ai-usage-dashboard-mock">
      AI Usage
      <button
        type="button"
        data-testid="mock-export-pdf"
        onClick={() => onExportPdf(
          [{ type: 'requests', date: '2026-10-01', requests: 3, errors: 0 }],
          'AI Usage',
          [{ label: 'Error rate', value: '0.0', unit: '%' }],
        )}
      >
        PDF
      </button>
    </div>
  ),
}));
vi.mock('./SearchEffectivenessDashboard', () => ({
  SearchEffectivenessDashboard: ({ onExportPdf }: DashboardProps) => (
    <div data-testid="search-dashboard-mock">
      Search
      <button
        type="button"
        data-testid="mock-export-pdf"
        onClick={() => onExportPdf(
          [{ type: 'topQuery', query: 'vpn setup', count: 9 }],
          'Search Effectiveness',
          [{ label: 'Top query', value: 'vpn setup' }],
        )}
      >
        PDF
      </button>
    </div>
  ),
}));
vi.mock('./ContentGapsDashboard', () => ({
  ContentGapsDashboard: ({ onExportPdf }: DashboardProps) => (
    <div data-testid="content-gaps-dashboard-mock">
      Content Gaps
      <button
        type="button"
        data-testid="mock-export-pdf"
        onClick={() => onExportPdf(
          [{ type: 'gap', query: 'sso login', occurrences: 2, avgMaxScore: 'N/A' }],
          'Content Gaps',
          [{ label: 'Content gaps', value: 1 }],
        )}
      >
        PDF
      </button>
    </div>
  ),
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
  initialEntries: string[] = ['/admin/analytics'],
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
        <MemoryRouter initialEntries={initialEntries}>
          <AnalyticsPage />
        </MemoryRouter>
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

  it('initializes active tab and date range from URL query parameters', async () => {
    renderWithProviders(['advanced_analytics', 'ai_usage_analytics'], [
      '/admin/analytics?tab=ai-usage&from=2026-01-01&to=2026-01-15',
    ]);
    expect(await screen.findByTestId('ai-usage-dashboard-mock')).toBeInTheDocument();
    expect((screen.getByTestId('date-start') as HTMLInputElement).value).toBe('2026-01-01');
    expect((screen.getByTestId('date-end') as HTMLInputElement).value).toBe('2026-01-15');
  });

  describe('PDF export (#1732)', () => {
    // [tab, title the dashboard passes, filename slug AnalyticsPage derives]
    const DASHBOARDS = [
      ['knowledge', 'Knowledge Health', 'knowledge-health'],
      ['ai-usage', 'AI Usage', 'ai-usage'],
      ['search', 'Search Effectiveness', 'search-effectiveness'],
      ['content-gaps', 'Content Gaps', 'content-gaps'],
    ] as const;

    let blobs: Blob[];
    let downloads: string[];

    beforeEach(() => {
      blobs = [];
      downloads = [];
      URL.createObjectURL = vi.fn((blob: Blob) => {
        blobs.push(blob);
        return 'blob:analytics-export';
      }) as typeof URL.createObjectURL;
      URL.revokeObjectURL = vi.fn();
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push(this.download);
      });
    });

    afterEach(() => {
      setPdfRendererOverlay(null);
    });

    it.each(DASHBOARDS)('exports the %s date-range report through the CE renderer', async (tab, _title, slug) => {
      renderWithProviders(undefined, [`/admin/analytics?tab=${tab}&from=2026-10-01&to=2026-10-27`]);

      fireEvent.click(await screen.findByTestId('mock-export-pdf'));

      await waitFor(() => expect(downloads).toEqual([`${slug}-2026-10-01-to-2026-10-27.pdf`]));
      const doc = await PDFDocument.load(new Uint8Array(await blobs[0]!.arrayBuffer()));
      expect(doc.getPageCount()).toBe(2);
      expect(toast.error).not.toHaveBeenCalled();
    });

    it.each(DASHBOARDS)('reports a failed %s export with an error toast and downloads nothing', async (tab, title) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failure = new Error('Renderer unavailable');
      setPdfRendererOverlay(async () => {
        throw failure;
      });
      renderWithProviders(undefined, [`/admin/analytics?tab=${tab}&from=2026-10-01&to=2026-10-27`]);

      fireEvent.click(await screen.findByTestId('mock-export-pdf'));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
        `Could not export the ${title} PDF`,
        { description: 'Renderer unavailable' },
      ));
      expect(consoleError).toHaveBeenCalledWith('[AnalyticsPage] PDF export failed:', failure);
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(downloads).toEqual([]);
    });
  });
});
