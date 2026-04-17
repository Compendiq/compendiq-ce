import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DataRetentionTab } from './DataRetentionTab';
import { useAuthStore } from '../../stores/auth-store';

// ── Mock useEnterprise ────────────────────────────────────���────────────────────

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

const mockRetentionPolicy = {
  rules: [
    { table: 'llm_audit_log', retentionDays: 90, enabled: true },
    { table: 'sync_history', retentionDays: 30, enabled: true },
    { table: 'error_log', retentionDays: null, enabled: false },
  ],
  extendedRetention: false,
};

const mockPreview = [
  { table: 'llm_audit_log', rowCount: 1250, oldestRecord: '2025-01-15T00:00:00Z' },
  { table: 'sync_history', rowCount: 340, oldestRecord: '2025-03-01T00:00:00Z' },
  { table: 'error_log', rowCount: 0, oldestRecord: null },
];

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init && typeof init === 'object' && 'method' in init ? (init as RequestInit).method : 'GET';

    if (url.includes('/admin/data-retention/preview')) {
      return new Response(JSON.stringify(mockPreview), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/admin/data-retention/purge') && method === 'POST') {
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/admin/data-retention')) {
      return new Response(JSON.stringify(mockRetentionPolicy), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

// ── Tests ────────────���─────────────────────��───────────────────────────────��───

describe('DataRetentionTab', () => {
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
    render(<DataRetentionTab />, { wrapper: createWrapper() });
    expect(screen.getByTestId('data-retention-gated')).toBeInTheDocument();
    expect(screen.getByText('Enterprise Feature')).toBeInTheDocument();
  });

  it('renders the retention form when feature is enabled', async () => {
    mockFetch();
    render(<DataRetentionTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('data-retention-form')).toBeInTheDocument();
    });
  });

  it('displays retention rules table with data from API', async () => {
    mockFetch();
    render(<DataRetentionTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('retention-rules-table')).toBeInTheDocument();
    });
    expect(screen.getByText('llm_audit_log')).toBeInTheDocument();
    expect(screen.getByText('sync_history')).toBeInTheDocument();
    expect(screen.getByText('error_log')).toBeInTheDocument();
  });

  it('has extended retention toggle', async () => {
    mockFetch();
    render(<DataRetentionTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('extended-retention-toggle')).toBeInTheDocument();
    });
  });

  it('shows preview results when preview button is clicked', async () => {
    mockFetch();
    render(<DataRetentionTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('preview-purge-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('preview-purge-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('preview-results')).toBeInTheDocument();
    });
  });

  it('shows purge confirmation dialog requiring type-to-confirm', async () => {
    mockFetch();
    render(<DataRetentionTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('purge-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('purge-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('purge-confirm-dialog')).toBeInTheDocument();
    });

    // Confirm button should be disabled until user types PURGE
    expect(screen.getByTestId('purge-confirm-btn')).toBeDisabled();

    fireEvent.change(screen.getByTestId('purge-confirm-input'), { target: { value: 'PURGE' } });
    expect(screen.getByTestId('purge-confirm-btn')).not.toBeDisabled();
  });

  it('has a save button', async () => {
    mockFetch();
    render(<DataRetentionTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('data-retention-save-btn')).toBeInTheDocument();
    });
  });

  it('submits PUT when save is clicked', async () => {
    const fetchSpy = mockFetch();
    render(<DataRetentionTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('data-retention-save-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('data-retention-save-btn'));

    await waitFor(() => {
      const putCalls = fetchSpy.mock.calls.filter(
        ([, opts]) => opts && typeof opts === 'object' && 'method' in opts && (opts as RequestInit).method === 'PUT',
      );
      expect(putCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
