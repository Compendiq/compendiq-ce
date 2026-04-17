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

const mockAuditEntries = [
  {
    id: 1,
    userId: 'u1',
    username: 'alice',
    action: 'chat',
    model: 'gpt-4o',
    provider: 'openai',
    tokensUsed: 1500,
    status: 'success' as const,
    createdAt: '2026-04-10T10:00:00Z',
  },
  {
    id: 2,
    userId: 'u2',
    username: 'bob',
    action: 'embed',
    model: 'bge-m3',
    provider: 'ollama',
    tokensUsed: 256,
    status: 'error' as const,
    createdAt: '2026-04-10T11:00:00Z',
  },
];

const mockStats = {
  totalRequests: 5000,
  totalTokens: 1250000,
  uniqueUsers: 42,
  errorRate: 0.03,
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
        entries: mockAuditEntries,
        total: 2,
        page: 1,
        pageSize: 25,
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
      return new Response(JSON.stringify({ totalRequests: 0, totalTokens: 0, uniqueUsers: 0, errorRate: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/admin/llm-audit')) {
      return new Response(JSON.stringify({
        entries: [],
        total: 0,
        page: 1,
        pageSize: 25,
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
    expect(screen.getByText('Enterprise Feature')).toBeInTheDocument();
  });

  it('renders the audit page when feature is enabled', async () => {
    mockFetch();
    render(<LlmAuditPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('llm-audit-page')).toBeInTheDocument();
    });
  });

  it('shows the audit table with entries', async () => {
    mockFetch();
    render(<LlmAuditPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('audit-table')).toBeInTheDocument();
    });
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
  });

  it('shows stats cards', async () => {
    mockFetch();
    render(<LlmAuditPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('audit-stats')).toBeInTheDocument();
    });
    expect(screen.getByText('5,000')).toBeInTheDocument();
    expect(screen.getByText('1,250,000')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
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
