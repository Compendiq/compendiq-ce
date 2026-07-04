import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SyncTab } from './panels/SyncTab';

// SyncTab is prop-less: it self-fetches the sync overview plus the quality /
// summary worker status, so we render it directly and mock fetch at the
// network boundary. The auth store is mocked as a module so we can flip
// admin vs. non-admin (which gates the Force Rescan / Force Re-sync buttons).
let authState = { user: { role: 'user' as string }, accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() };
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  ),
}));

// Mutation success/error handlers call toast; mock it so the queued toasts
// don't leak between tests and we don't need a mounted <Toaster>.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

const mockOverview = {
  sync: {
    userId: 'user-1',
    status: 'idle' as const,
    lastSynced: '2026-03-11T10:00:00.000Z',
  },
  totals: {
    selectedSpaces: 1,
    totalPages: 2,
    pagesWithAssets: 1,
    pagesWithIssues: 1,
    healthyPages: 1,
    images: { expected: 2, cached: 1, missing: 1 },
    drawio: { expected: 1, cached: 1, missing: 0 },
  },
  spaces: [{
    spaceKey: 'OPS',
    spaceName: 'Operations',
    status: 'degraded' as const,
    lastSynced: '2026-03-11T10:00:00.000Z',
    pageCount: 2,
    pagesWithAssets: 1,
    pagesWithIssues: 1,
    images: { expected: 2, cached: 1, missing: 1 },
    drawio: { expected: 1, cached: 1, missing: 0 },
  }],
  issues: [{
    pageId: 'page-1',
    pageTitle: 'Runbook',
    spaceKey: 'OPS',
    missingImages: 1,
    missingDrawio: 0,
    missingFiles: ['missing.png'],
  }],
};

const mockQualityStatus = {
  totalPages: 100,
  analyzedPages: 75,
  pendingPages: 15,
  failedPages: 5,
  skippedPages: 5,
  averageScore: 72,
  isProcessing: false,
};

const mockSummaryStatus = {
  totalPages: 100,
  summarizedPages: 80,
  pendingPages: 10,
  failedPages: 3,
  skippedPages: 7,
  isProcessing: false,
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('Settings SyncTab', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    authState = { user: { role: 'user' }, accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetchResponses(overrides?: {
    overview?: typeof mockOverview;
    quality?: typeof mockQualityStatus;
    summary?: typeof mockSummaryStatus;
  }) {
    const overview = overrides?.overview ?? mockOverview;
    const quality = overrides?.quality ?? mockQualityStatus;
    const summary = overrides?.summary ?? mockSummaryStatus;

    fetchSpy.mockImplementation(async (url: string | URL | Request, options?: RequestInit) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (path.includes('/api/settings/sync-overview')) {
        return new Response(JSON.stringify(overview), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.includes('/api/sync') && options?.method === 'POST') {
        return new Response(JSON.stringify({ message: 'Sync started', status: { userId: 'user-1', status: 'syncing' } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.includes('/api/llm/quality-status')) {
        return new Response(JSON.stringify(quality), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.includes('/api/llm/quality-rescan') && options?.method === 'POST') {
        return new Response(JSON.stringify({ message: 'Quality rescan started — 100 pages reset to pending', pagesReset: 100 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.includes('/api/llm/summary-status')) {
        return new Response(JSON.stringify(summary), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.includes('/api/llm/summary-rescan') && options?.method === 'POST') {
        return new Response(JSON.stringify({ message: 'Reset 100 pages for re-summarization', resetCount: 100 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.includes('/api/pages/bulk/sync') && options?.method === 'POST') {
        return new Response(JSON.stringify({ succeeded: 2, failed: 0, errors: [] }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('{}', {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  it('shows sync metrics, per-space health, and missing files', async () => {
    mockFetchResponses();
    render(<SyncTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('sync-overview-status')).toHaveTextContent('Idle');
    });

    expect(screen.getByTestId('sync-metric-images')).toHaveTextContent('1/2');
    expect(screen.getByTestId('sync-metric-drawio')).toHaveTextContent('1/1');
    expect(screen.getByTestId('sync-overview-space-OPS')).toHaveTextContent('Operations');
    expect(screen.getByTestId('sync-overview-issue-page-1')).toHaveTextContent('missing.png');
  });

  it('shows a clean empty state when no missing assets are present', async () => {
    mockFetchResponses({
      overview: {
        ...mockOverview,
        totals: {
          ...mockOverview.totals,
          pagesWithIssues: 0,
          healthyPages: 2,
          images: { expected: 2, cached: 2, missing: 0 },
        },
        spaces: [{
          ...mockOverview.spaces[0],
          status: 'healthy',
          pagesWithIssues: 0,
          images: { expected: 2, cached: 2, missing: 0 },
        }],
        issues: [],
      },
    });
    render(<SyncTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('sync-overview-empty')).toBeInTheDocument();
    });
  });

  it('starts a manual sync when Sync Now is clicked', async () => {
    mockFetchResponses();
    render(<SyncTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('sync-overview-sync-now')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('sync-overview-sync-now'));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/sync',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('renders quality analysis section with metric cards', async () => {
    mockFetchResponses();
    render(<SyncTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('quality-worker-section')).toBeInTheDocument();
    });

    expect(screen.getByTestId('quality-worker-status')).toHaveTextContent('Idle');
    expect(screen.getByTestId('quality-metric-analyzed')).toHaveTextContent('75');
    expect(screen.getByTestId('quality-metric-pending')).toHaveTextContent('15');
    expect(screen.getByTestId('quality-metric-failed')).toHaveTextContent('5');
    expect(screen.getByTestId('quality-metric-skipped')).toHaveTextContent('5');
    expect(screen.getByTestId('quality-metric-avg-score')).toHaveTextContent('72');
  });

  it('renders summary worker section with metric cards', async () => {
    mockFetchResponses();
    render(<SyncTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('summary-worker-section')).toBeInTheDocument();
    });

    expect(screen.getByTestId('summary-worker-status')).toHaveTextContent('Idle');
    expect(screen.getByTestId('summary-metric-summarized')).toHaveTextContent('80');
    expect(screen.getByTestId('summary-metric-pending')).toHaveTextContent('10');
    expect(screen.getByTestId('summary-metric-failed')).toHaveTextContent('3');
    expect(screen.getByTestId('summary-metric-skipped')).toHaveTextContent('7');
  });

  it('shows processing status badge when workers are active', async () => {
    mockFetchResponses({
      quality: { ...mockQualityStatus, isProcessing: true },
      summary: { ...mockSummaryStatus, isProcessing: true },
    });
    render(<SyncTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('quality-worker-status')).toHaveTextContent('Analyzing');
    });

    expect(screen.getByTestId('summary-worker-status')).toHaveTextContent('Summarizing');
  });

  it('hides Force Rescan buttons for non-admin users', async () => {
    mockFetchResponses();
    render(<SyncTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('quality-worker-section')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('quality-force-rescan')).not.toBeInTheDocument();
    expect(screen.queryByTestId('summary-force-rescan')).not.toBeInTheDocument();
  });

  it('shows Force Rescan buttons for admin users', async () => {
    authState = { user: { role: 'admin' }, accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() };
    mockFetchResponses();
    render(<SyncTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('quality-force-rescan')).toBeInTheDocument();
    });

    expect(screen.getByTestId('summary-force-rescan')).toBeInTheDocument();
  });

  // ConfirmDialog replaces the native confirm() guard on Force Re-sync All.
  describe('Force Re-sync All confirmation dialog', () => {
    function bulkSyncCalls() {
      return fetchSpy.mock.calls.filter(([url, opts]) => {
        const path = typeof url === 'string' ? url : '';
        return path.includes('/api/pages/bulk/sync') && (opts as RequestInit | undefined)?.method === 'POST';
      });
    }

    it('opens a dialog and only POSTs /pages/bulk/sync after confirming', async () => {
      authState = { user: { role: 'admin' }, accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() };
      mockFetchResponses();
      render(<SyncTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByTestId('sync-overview-force-resync-all')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('sync-overview-force-resync-all'));

      // Honest copy: heavy re-fetch + embeddings marked dirty; nothing deleted.
      expect(await screen.findByText('Force re-sync every Confluence page?')).toBeInTheDocument();
      expect(screen.getByText(/even if its Confluence version is unchanged/i)).toBeInTheDocument();
      expect(bulkSyncCalls()).toHaveLength(0);

      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

      await waitFor(() => {
        expect(bulkSyncCalls().length).toBeGreaterThan(0);
      });
    });

    it('cancelling does not start the re-sync', async () => {
      authState = { user: { role: 'admin' }, accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() };
      mockFetchResponses();
      render(<SyncTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByTestId('sync-overview-force-resync-all')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('sync-overview-force-resync-all'));
      await screen.findByTestId('confirm-dialog');
      fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));

      await waitFor(() => {
        expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
      });
      expect(bulkSyncCalls()).toHaveLength(0);
    });
  });
});
