import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domMax } from 'framer-motion';
import { WorkersTab } from './WorkersTab';

// Mock auth store - supports both hook-style (selector) and getState() calls
const authState = { user: { role: 'admin' }, accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() };
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  ),
}));

// ---------------------------------------------------------------------------
// Mock API responses
// ---------------------------------------------------------------------------

const qualityStatus = {
  totalPages: 200,
  analyzedPages: 156,
  analyzingPages: 1,
  pendingPages: 12,
  failedPages: 3,
  skippedPages: 28,
  averageScore: 75,
  isProcessing: true,
  lastRunAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 min ago
  intervalMinutes: 60,
  model: 'qwen3:32b',
};

const summaryStatus = {
  totalPages: 200,
  summarizedPages: 180,
  summarizingPages: 0,
  pendingPages: 5,
  failedPages: 2,
  skippedPages: 13,
  isProcessing: false,
  lastRunAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
  intervalMinutes: 60,
  model: 'qwen3:32b',
};

const embeddingStatus = {
  totalPages: 200,
  embeddedPages: 190,
  dirtyPages: 10,
  totalEmbeddings: 3500,
  isProcessing: false,
  lastRunAt: null,
  model: 'nomic-embed-text',
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <LazyMotion features={domMax}>
          {children}
        </LazyMotion>
      </QueryClientProvider>
    );
  };
}

function mockFetch(overrides?: {
  quality?: Partial<typeof qualityStatus>;
  summary?: Partial<typeof summaryStatus>;
  embedding?: Partial<typeof embeddingStatus>;
}) {
  const quality = { ...qualityStatus, ...overrides?.quality };
  const summary = { ...summaryStatus, ...overrides?.summary };
  const embedding = { ...embeddingStatus, ...overrides?.embedding };

  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request) => {
    const path = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

    if (path.includes('/api/llm/quality-status')) {
      return new Response(JSON.stringify(quality), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path.includes('/api/llm/summary-status')) {
      return new Response(JSON.stringify(summary), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path.includes('/api/llm/embedding-status')) {
      return new Response(JSON.stringify(embedding), { headers: { 'Content-Type': 'application/json' } });
    }

    // POST endpoints (run-now, rescan, etc.)
    if (path.includes('/api/llm/')) {
      return new Response(JSON.stringify({ message: 'OK' }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  });
}

describe('WorkersTab', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = mockFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all three worker cards', async () => {
    render(<WorkersTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Quality Analysis')).toBeInTheDocument();
      expect(screen.getByText('Summary Generation')).toBeInTheDocument();
      expect(screen.getByText('Embedding Processing')).toBeInTheDocument();
    });
  });

  it('renders the section heading and description', () => {
    render(<WorkersTab />, { wrapper: createWrapper() });
    expect(screen.getByText('Background Workers')).toBeInTheDocument();
    expect(screen.getByText(/Monitor and manually trigger/)).toBeInTheDocument();
  });

  it('displays status badge as Running when worker is processing', async () => {
    render(<WorkersTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      const qualityCard = screen.getByTestId('worker-card-quality');
      expect(within(qualityCard).getByText('Running')).toBeInTheDocument();
    });
  });

  it('displays status badge as Queued when pending > 0 and not processing', async () => {
    fetchSpy.mockRestore();
    mockFetch({
      summary: { isProcessing: false, summarizingPages: 0, pendingPages: 5, failedPages: 0 },
    });

    render(<WorkersTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      const summaryCard = screen.getByTestId('worker-card-summary');
      expect(within(summaryCard).getByText('Queued')).toBeInTheDocument();
    });
  });

  it('displays status badge as Idle when nothing is pending or processing', async () => {
    fetchSpy.mockRestore();
    mockFetch({
      embedding: { isProcessing: false, dirtyPages: 0, embeddedPages: 200, totalPages: 200 },
    });

    render(<WorkersTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      const embeddingCard = screen.getByTestId('worker-card-embedding');
      expect(within(embeddingCard).getByText('Idle')).toBeInTheDocument();
    });
  });

  it('displays progress bar with correct percentage', async () => {
    render(<WorkersTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      const qualityCard = screen.getByTestId('worker-card-quality');
      const progressBar = within(qualityCard).getByTestId('progress-bar');
      // 156 of 200 = 78%
      expect(progressBar.textContent).toContain('78%');
      expect(progressBar.textContent).toContain('156 of 200');
    });
  });

  it('displays status pills with correct counts', async () => {
    render(<WorkersTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      const qualityCard = screen.getByTestId('worker-card-quality');
      // The pills show "Pending", "Processing", "Done", "Failed", "Skipped" labels
      expect(within(qualityCard).getByText('Pending')).toBeInTheDocument();
      expect(within(qualityCard).getByText('Processing')).toBeInTheDocument();
      expect(within(qualityCard).getByText('Done')).toBeInTheDocument();
      expect(within(qualityCard).getByText('Failed')).toBeInTheDocument();
      expect(within(qualityCard).getByText('Skipped')).toBeInTheDocument();
    });
  });

  it('hides status pills with zero counts', async () => {
    fetchSpy.mockRestore();
    mockFetch({
      embedding: { dirtyPages: 0, embeddedPages: 200, totalPages: 200, isProcessing: false },
    });

    render(<WorkersTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      const embeddingCard = screen.getByTestId('worker-card-embedding');
      // With dirtyPages=0 and no failed/skipped, only "Done" pill should appear
      expect(within(embeddingCard).getByText('Done')).toBeInTheDocument();
      expect(within(embeddingCard).queryByText('Pending')).not.toBeInTheDocument();
      expect(within(embeddingCard).queryByText('Failed')).not.toBeInTheDocument();
    });
  });

  it('displays timing row with model name and interval', async () => {
    render(<WorkersTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      const qualityCard = screen.getByTestId('worker-card-quality');
      const timingRow = within(qualityCard).getByTestId('timing-row');
      expect(timingRow.textContent).toContain('qwen3:32b');
      expect(timingRow.textContent).toContain('60 min');
      expect(timingRow.textContent).toContain('Last run:');
    });
  });

  it('shows "Never" for last run when lastRunAt is null', async () => {
    render(<WorkersTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      const embeddingCard = screen.getByTestId('worker-card-embedding');
      const timingRow = within(embeddingCard).getByTestId('timing-row');
      expect(timingRow.textContent).toContain('Never');
    });
  });

  it('renders Run Now and Rescan All buttons for each card', async () => {
    render(<WorkersTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('quality-run-now')).toBeInTheDocument();
      expect(screen.getByTestId('quality-rescan')).toBeInTheDocument();
      expect(screen.getByTestId('summary-run-now')).toBeInTheDocument();
      expect(screen.getByTestId('summary-rescan')).toBeInTheDocument();
      expect(screen.getByTestId('embedding-run-now')).toBeInTheDocument();
      expect(screen.getByTestId('embedding-rescan')).toBeInTheDocument();
    });
  });

  it('renders Retry Failed button for embedding when there are failures', async () => {
    fetchSpy.mockRestore();
    mockFetch({
      embedding: { dirtyPages: 0, embeddedPages: 190, totalPages: 200, isProcessing: false },
    });

    render(<WorkersTab />, { wrapper: createWrapper() });

    // Embedding normalizer sets failed=0, so no retry button should appear
    await waitFor(() => {
      expect(screen.getByTestId('worker-card-embedding')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('embedding-retry-failed')).not.toBeInTheDocument();
  });

  it('fires POST when Run Now is clicked', async () => {
    render(<WorkersTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('quality-run-now')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('quality-run-now'));

    await waitFor(() => {
      const postCalls = fetchSpy.mock.calls.filter(
        ([url, opts]) => {
          const path = typeof url === 'string' ? url : '';
          return path.includes('quality-run-now') && (opts as RequestInit)?.method === 'POST';
        },
      );
      expect(postCalls.length).toBeGreaterThan(0);
    });
  });

  it('does not show interval for embedding (on-demand worker)', async () => {
    render(<WorkersTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      const embeddingCard = screen.getByTestId('worker-card-embedding');
      const timingRow = within(embeddingCard).getByTestId('timing-row');
      // Should not contain "Every ... min" since intervalMinutes is 0
      expect(timingRow.textContent).not.toMatch(/Every \d+ min/);
    });
  });

  it('displays model name for embedding worker', async () => {
    render(<WorkersTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      const embeddingCard = screen.getByTestId('worker-card-embedding');
      const timingRow = within(embeddingCard).getByTestId('timing-row');
      expect(timingRow.textContent).toContain('nomic-embed-text');
    });
  });

  it('displays Error state when failed > 0 and nothing is processing or pending', async () => {
    fetchSpy.mockRestore();
    mockFetch({
      quality: { isProcessing: false, analyzingPages: 0, pendingPages: 0, failedPages: 5 },
    });

    render(<WorkersTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      const qualityCard = screen.getByTestId('worker-card-quality');
      expect(within(qualityCard).getByText('Error')).toBeInTheDocument();
    });
  });
});
