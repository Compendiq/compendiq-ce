import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

/**
 * Holds `POST /api/pages/bulk/sync` open, so the force re-sync stays PENDING
 * for the length of an assertion — the multi-minute run #1532 is about,
 * expressed in a test. `null` (the default, reset in `beforeEach`) resolves
 * immediately, exactly as the mock behaved before.
 */
let bulkSyncGate: Promise<void> | null = null;

/**
 * Radix's FocusScope dispatches close-auto-focus from a `setTimeout(…, 0)` in
 * its effect cleanup, so `ConfirmDialog`'s restore (#1531) lands one macrotask
 * after the closing commit. Asserting focus without this flush reads the
 * window in which `<body>` legitimately still holds the keyboard — a cell that
 * would pass fixed and broken alike.
 */
async function flushCloseAutoFocus() {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  });
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('Settings SyncTab', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    bulkSyncGate = null;
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
        if (bulkSyncGate) await bulkSyncGate;
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

  // `embedding` is the only hueless pill in the sync status map:
  // `--color-status-embedding` resolves to body ink now (it had been
  // byte-identical to `--color-primary`, so pipeline telemetry wore the colour
  // that means "you can act on this"). Hue therefore cannot say "indexing" any
  // more — `syncLabel` does — and the pill's weight is capped, which is the
  // part a stylesheet edit could silently undo. At the siblings' 20% the ink
  // fill measures 1.746:1 in Graphite, past the 1.264:1 `--color-border`
  // hairline; any `border-` utility on the token composites over that fill and
  // reaches 1.592:1 at the pill's outer edge. 10% plus the hairline token fits.
  it('names the embedding sync state in text, with a capped hueless pill', async () => {
    mockFetchResponses({
      overview: {
        ...mockOverview,
        sync: { ...mockOverview.sync, status: 'embedding' },
      } as typeof mockOverview,
    });
    render(<SyncTab />, { wrapper: createWrapper() });

    const pill = await waitFor(() => screen.getByTestId('sync-overview-status'));
    await waitFor(() => expect(pill).toHaveTextContent('Embedding'));

    const utilities = pill.className.split(/\s+/);
    expect(utilities.filter((c) => c.startsWith('bg-'))).toEqual(['bg-status-embedding/10']);
    expect(utilities.filter((c) => c.startsWith('border-'))).toEqual(['border-border']);
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

    /**
     * #1532 on the panel's THIRD action control, added after the serial
     * browser pass on `a820e9b7` returned checklist items 3 and 11 FAIL.
     * `onConfirm` runs `runForceResyncAll()` synchronously, so
     * `forceResyncMutation.isPending` lands in the very commit that closes the
     * `ConfirmDialog`; as a native `disabled` that commit removes the trigger
     * from the focusable set BEFORE Radix dispatches close-auto-focus, and
     * #1531's restore then aims `focus()` at a control that cannot take it.
     *
     * The load-bearing red at the unfixed head is the pair below:
     * `not.toHaveAttribute('disabled')`, and the end-to-end focus cell — jsdom
     * has no focus fixup, but it DOES refuse `focus()` on a natively-disabled
     * control, which is the exact mechanism the browser proved.
     */
    it('holds the trigger with aria-disabled, never native disabled, while the re-sync runs', async () => {
      authState = { user: { role: 'admin' }, accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() };
      const gate = Promise.withResolvers<void>();
      bulkSyncGate = gate.promise;
      mockFetchResponses();
      render(<SyncTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByTestId('sync-overview-force-resync-all')).toBeInTheDocument();
      });
      const trigger = screen.getByTestId('sync-overview-force-resync-all');

      fireEvent.click(trigger);
      await screen.findByTestId('confirm-dialog');
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

      await waitFor(() => {
        expect(trigger).toHaveAttribute('aria-disabled', 'true');
      });
      expect(trigger).not.toHaveAttribute('disabled');
      expect(trigger).toHaveTextContent('Re-syncing...');

      gate.resolve();
      await waitFor(() => {
        expect(trigger).not.toHaveAttribute('aria-disabled');
      });
    });

    it('refuses a second Force Re-sync All while one is already running', async () => {
      authState = { user: { role: 'admin' }, accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() };
      const gate = Promise.withResolvers<void>();
      bulkSyncGate = gate.promise;
      mockFetchResponses();
      render(<SyncTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByTestId('sync-overview-force-resync-all')).toBeInTheDocument();
      });
      const trigger = screen.getByTestId('sync-overview-force-resync-all');

      fireEvent.click(trigger);
      await screen.findByTestId('confirm-dialog');
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

      await waitFor(() => {
        expect(trigger).toHaveAttribute('aria-disabled', 'true');
      });
      // The refusal `aria-disabled` cannot perform: it blocks no events, so
      // without the handler's early return this press re-opens the dialog and
      // a confirm fires a second KB-wide re-fetch against a running one.
      fireEvent.click(trigger);
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
      expect(bulkSyncCalls()).toHaveLength(1);

      gate.resolve();
      await waitFor(() => {
        expect(trigger).not.toHaveAttribute('aria-disabled');
      });
    });

    it('returns focus to the trigger after confirming, not to <body>', async () => {
      authState = { user: { role: 'admin' }, accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() };
      const gate = Promise.withResolvers<void>();
      bulkSyncGate = gate.promise;
      mockFetchResponses();
      render(<SyncTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByTestId('sync-overview-force-resync-all')).toBeInTheDocument();
      });
      const trigger = screen.getByTestId('sync-overview-force-resync-all');

      // Keyboard shape: the trigger holds focus when the dialog opens, which is
      // what `ConfirmDialog` captures in `onOpenAutoFocus`.
      trigger.focus();
      fireEvent.click(trigger);
      await screen.findByTestId('confirm-dialog');
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
      await waitFor(() => {
        expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
      });
      await flushCloseAutoFocus();

      expect(document.activeElement).toBe(trigger);

      gate.resolve();
      await waitFor(() => {
        expect(trigger).not.toHaveAttribute('aria-disabled');
      });
    });
  });
});
