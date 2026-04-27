import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LlmAuditPage } from './LlmAuditPage';
import { useAuthStore } from '../../stores/auth-store';

// ── Mock useEnterprise ─────────────────────────────────────────────────────────

let mockHasFeature = (_f: string) => true;

vi.mock('../../shared/enterprise/use-enterprise', () => ({
  useEnterprise: () => ({
    isEnterprise: true,
    hasFeature: (f: string) => mockHasFeature(f),
    ui: null,
    license: null,
    isLoading: false,
  }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LazyMotion features={domMax}>
            {children}
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

// Matches the backend `llm_audit_log` row shape — see
// `overlay/backend/src/routes/foundation/llm-audit.ts`.
const mockAuditItems = [
  {
    id: 1,
    user_id: '11111111-1111-1111-1111-111111111111',
    action: 'chat',
    model: 'gpt-4o',
    provider: 'openai',
    input_tokens: 500,
    output_tokens: 1000,
    duration_ms: 1200,
    status: 'success' as const,
    error_message: null,
    created_at: '2026-04-10T10:00:00Z',
  },
  {
    id: 2,
    user_id: '22222222-2222-2222-2222-222222222222',
    action: 'embed',
    model: 'bge-m3',
    provider: 'ollama',
    input_tokens: 256,
    output_tokens: 0,
    duration_ms: 80,
    status: 'error' as const,
    error_message: 'timeout',
    created_at: '2026-04-10T11:00:00Z',
  },
];

const mockStats = {
  totalRequests: 5000,
  totalInputTokens: 250_000,
  totalOutputTokens: 1_000_000,
  byAction: { chat: 4000, embed: 1000 },
  byModel: { 'gpt-4o': 4000, 'bge-m3': 1000 },
  byStatus: { success: 4850, error: 150 },
};

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;

    if (url.includes('/admin/llm-audit/stats')) {
      return new Response(JSON.stringify(mockStats), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/admin/llm-audit/export')) {
      return new Response('id,user,action\n1,alice,chat', {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="llm-audit.csv"',
        },
      });
    }
    if (url.includes('/admin/llm-audit')) {
      return new Response(JSON.stringify({
        items: mockAuditItems,
        total: 2,
        page: 1,
        limit: 25,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function mockFetchEmpty() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;

    if (url.includes('/admin/llm-audit/stats')) {
      return new Response(
        JSON.stringify({
          totalRequests: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          byAction: {},
          byModel: {},
          byStatus: {},
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/admin/llm-audit')) {
      return new Response(JSON.stringify({
        items: [],
        total: 0,
        page: 1,
        limit: 25,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('LlmAuditPage', () => {
  beforeEach(() => {
    mockHasFeature = () => true;
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'admin',
      role: 'admin',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('shows feature-gated banner when feature is not enabled', () => {
    mockHasFeature = () => false;
    mockFetch();
    render(<LlmAuditPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('llm-audit-gated')).toBeInTheDocument();
    // #347: clarified copy — explicit about CE-vs-EE ownership and points
    // CE users at the regular Audit Log for ops events.
    expect(screen.getByText(/Enterprise feature/i)).toBeInTheDocument();
    expect(screen.getByText(/Community Edition does not persist/i)).toBeInTheDocument();
    expect(screen.getByText(/regular/i)).toBeInTheDocument();
  });

  it('renders the audit page when feature is enabled', async () => {
    mockFetch();
    render(<LlmAuditPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('llm-audit-page')).toBeInTheDocument();
    });
  });

  it('shows the audit table with items and sums tokens per row', async () => {
    mockFetch();
    render(<LlmAuditPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('audit-table')).toBeInTheDocument();
    });
    // Tokens = input + output = 1500 & 256 respectively
    expect(screen.getByText('1,500')).toBeInTheDocument();
    expect(screen.getByText('256')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
    expect(screen.getByText('bge-m3')).toBeInTheDocument();
  });

  it('derives total tokens + error rate from stats', async () => {
    mockFetch();
    render(<LlmAuditPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('audit-stats')).toBeInTheDocument();
    });
    // totalRequests
    expect(screen.getByText('5,000')).toBeInTheDocument();
    // totalTokens = 250_000 + 1_000_000 = 1_250_000
    expect(screen.getByText('1,250,000')).toBeInTheDocument();
    // errorRate = 150 / 5000 = 3.0%
    expect(screen.getByText('3.0%')).toBeInTheDocument();
  });

  it('shows empty state when no entries', async () => {
    mockFetchEmpty();
    render(<LlmAuditPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('audit-empty')).toBeInTheDocument();
    });
    expect(screen.getByText('No audit entries found')).toBeInTheDocument();
  });

  it('shows filter panel when toggle is clicked', async () => {
    mockFetch();
    render(<LlmAuditPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('toggle-filters-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('toggle-filters-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('audit-filters')).toBeInTheDocument();
    });
    expect(screen.getByTestId('filter-user')).toBeInTheDocument();
    expect(screen.getByTestId('filter-action')).toBeInTheDocument();
    expect(screen.getByTestId('filter-status')).toBeInTheDocument();
  });

  it('requests the page with page+limit query params that the backend accepts', async () => {
    const fetchSpy = mockFetch();
    render(<LlmAuditPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('audit-table')).toBeInTheDocument();
    });

    const listCall = fetchSpy.mock.calls.find(([url]) =>
      typeof url === 'string' && url.includes('/admin/llm-audit?') && !url.includes('/stats') && !url.includes('/export'),
    );
    expect(listCall).toBeTruthy();
    const url = listCall![0] as string;
    expect(url).toContain('page=1');
    expect(url).toContain('limit=25');
    expect(url).not.toContain('pageSize=');
  });

  it('has an export CSV button', async () => {
    mockFetch();
    render(<LlmAuditPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('export-csv-btn')).toBeInTheDocument();
    });
  });

  it('triggers CSV export on button click', async () => {
    const fetchSpy = mockFetch();

    // Mock URL.createObjectURL and URL.revokeObjectURL for jsdom
    const createObjectURL = vi.fn(() => 'blob:test');
    const revokeObjectURL = vi.fn();
    globalThis.URL.createObjectURL = createObjectURL;
    globalThis.URL.revokeObjectURL = revokeObjectURL;

    render(<LlmAuditPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('export-csv-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('export-csv-btn'));

    await waitFor(() => {
      const exportCalls = fetchSpy.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/admin/llm-audit/export'),
      );
      expect(exportCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
