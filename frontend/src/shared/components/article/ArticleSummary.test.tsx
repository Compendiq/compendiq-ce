import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArticleSummary } from './ArticleSummary';
import { useAuthStore } from '../../../stores/auth-store';

// Mock use-pages hooks. The mutate fn is overridden per-test where needed
// to exercise success / error branches.
const mockMutate = vi.fn();
vi.mock('../../hooks/use-pages', () => ({
  useSummaryRegenerate: () => ({
    mutate: (pageId: string, opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) =>
      mockMutate(pageId, opts),
    isPending: false,
  }),
}));

// Mock sonner toast
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

// Helper to set the auth store to a specific role for the duration of a test.
function setUser(role: 'admin' | 'user' | null) {
  if (role === null) {
    useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false });
  } else {
    useAuthStore.setState({
      user: { id: 'u1', username: 'tester', role },
      accessToken: 'tok',
      isAuthenticated: true,
    });
  }
}

describe('ArticleSummary', () => {
  beforeEach(() => {
    localStorage.clear();
    mockMutate.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    // Default: admin (preserves existing tests that asserted button visibility).
    setUser('admin');
  });

  it('renders nothing for skipped status', () => {
    const { container } = render(
      <ArticleSummary
        pageId="p1"
        summaryHtml={null}
        summaryStatus="skipped"
        summaryGeneratedAt={null}
        summaryModel={null}
        summaryError={null}
      />,
      { wrapper: createWrapper() },
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders pending indicator for pending status', () => {
    render(
      <ArticleSummary
        pageId="p1"
        summaryHtml={null}
        summaryStatus="pending"
        summaryGeneratedAt={null}
        summaryModel={null}
        summaryError={null}
      />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByTestId('article-summary-pending')).toBeInTheDocument();
    expect(screen.getByText('AI summary will be generated shortly')).toBeInTheDocument();
  });

  it('renders summarizing indicator with pulse', () => {
    render(
      <ArticleSummary
        pageId="p1"
        summaryHtml={null}
        summaryStatus="summarizing"
        summaryGeneratedAt={null}
        summaryModel={null}
        summaryError={null}
      />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByTestId('article-summary-pending')).toBeInTheDocument();
    expect(screen.getByText('Generating AI summary...')).toBeInTheDocument();
  });

  // The pending banner promises "AI summary will be generated shortly" — a
  // promise that can't be kept while the LLM provider is down. When /api/health
  // reports services.llm === false, show a muted offline note instead.
  describe('LLM offline while summary pending', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function renderWithStatus(summaryStatus: 'pending' | 'summarizing') {
      return render(
        <ArticleSummary
          pageId="p1"
          summaryHtml={null}
          summaryStatus={summaryStatus}
          summaryGeneratedAt={null}
          summaryModel={null}
          summaryError={null}
        />,
        { wrapper: createWrapper() },
      );
    }

    it('shows the offline note instead of the pending promise when health reports llm: false', async () => {
      fetchMock.mockResolvedValue({
        json: () => Promise.resolve({ status: 'degraded', services: { llm: false } }),
      });

      renderWithStatus('pending');

      expect(await screen.findByTestId('article-summary-offline')).toBeInTheDocument();
      expect(screen.getByText('AI summary unavailable — LLM provider offline')).toBeInTheDocument();
      expect(screen.queryByText('AI summary will be generated shortly')).not.toBeInTheDocument();
      // #1052: the request carries the admin token so the backend returns the
      // per-service `services` payload.
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/health',
        expect.objectContaining({ headers: expect.anything() }),
      );
    });

    it('keeps the pending text when health reports llm: true', async () => {
      fetchMock.mockResolvedValue({
        json: () => Promise.resolve({ status: 'ok', services: { llm: true } }),
      });

      renderWithStatus('pending');

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/health',
          expect.objectContaining({ headers: expect.anything() }),
        );
      });
      expect(screen.getByText('AI summary will be generated shortly')).toBeInTheDocument();
      expect(screen.queryByTestId('article-summary-offline')).not.toBeInTheDocument();
    });

    it('keeps the pending text when the health endpoint is unavailable', async () => {
      fetchMock.mockRejectedValue(new Error('network down'));

      renderWithStatus('pending');

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/health',
          expect.objectContaining({ headers: expect.anything() }),
        );
      });
      expect(screen.getByText('AI summary will be generated shortly')).toBeInTheDocument();
      expect(screen.queryByTestId('article-summary-offline')).not.toBeInTheDocument();
    });

    it('keeps "Generating AI summary..." while actively summarizing even if llm is reported down', () => {
      fetchMock.mockResolvedValue({
        json: () => Promise.resolve({ services: { llm: false } }),
      });

      renderWithStatus('summarizing');

      // An in-flight generation already left the queue — don't contradict it.
      expect(screen.getByText('Generating AI summary...')).toBeInTheDocument();
      expect(screen.queryByTestId('article-summary-offline')).not.toBeInTheDocument();
    });
  });

  it('renders failed state with error message and retry button (admin)', () => {
    render(
      <ArticleSummary
        pageId="p1"
        summaryHtml={null}
        summaryStatus="failed"
        summaryGeneratedAt={null}
        summaryModel={null}
        summaryError="Connection refused"
      />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByTestId('article-summary-failed')).toBeInTheDocument();
    expect(screen.getByText(/Connection refused/)).toBeInTheDocument();
    expect(screen.getByTestId('summary-retry-button')).toBeInTheDocument();
  });

  it('renders summarized state with collapsible content', () => {
    render(
      <ArticleSummary
        pageId="p1"
        summaryHtml="<p>This is a summary</p>"
        summaryStatus="summarized"
        summaryGeneratedAt={new Date().toISOString()}
        summaryModel="qwen3:32b"
        summaryError={null}
      />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByTestId('article-summary')).toBeInTheDocument();
    expect(screen.getByText('AI Summary')).toBeInTheDocument();
    expect(screen.getByText('(qwen3:32b)')).toBeInTheDocument();
    expect(screen.getByTestId('article-summary-content')).toBeInTheDocument();
  });

  it('collapses and expands on toggle click', () => {
    render(
      <ArticleSummary
        pageId="p1"
        summaryHtml="<p>This is a summary</p>"
        summaryStatus="summarized"
        summaryGeneratedAt={new Date().toISOString()}
        summaryModel="qwen3:32b"
        summaryError={null}
      />,
      { wrapper: createWrapper() },
    );

    // Initially expanded
    expect(screen.getByTestId('article-summary-content')).toBeInTheDocument();

    // Click to collapse
    fireEvent.click(screen.getByText('AI Summary'));
    expect(screen.queryByTestId('article-summary-content')).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByText('AI Summary'));
    expect(screen.getByTestId('article-summary-content')).toBeInTheDocument();
  });

  it('persists the collapse choice per page, not globally', () => {
    const { unmount } = render(
      <ArticleSummary
        pageId="p1"
        summaryHtml="<p>Summary</p>"
        summaryStatus="summarized"
        summaryGeneratedAt={null}
        summaryModel={null}
        summaryError={null}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('AI Summary'));
    expect(localStorage.getItem('article-summary-collapsed:p1')).toBe('true');
    // The old global key must not be written, or one page's chevron silently
    // sets an app-wide preference.
    expect(localStorage.getItem('article-summary-collapsed')).toBeNull();

    unmount();

    // A DIFFERENT page is unaffected by p1's choice.
    render(
      <ArticleSummary
        pageId="p2"
        summaryHtml="<p>Summary 2</p>"
        summaryStatus="summarized"
        summaryGeneratedAt={null}
        summaryModel={null}
        summaryError={null}
      />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByTestId('article-summary-content')).toBeInTheDocument();
  });

  it('restores the same page\'s collapse choice on return', () => {
    localStorage.setItem('article-summary-collapsed:p1', 'true');
    render(
      <ArticleSummary
        pageId="p1"
        summaryHtml="<p>Summary</p>"
        summaryStatus="summarized"
        summaryGeneratedAt={null}
        summaryModel={null}
        summaryError={null}
      />,
      { wrapper: createWrapper() },
    );
    expect(screen.queryByTestId('article-summary-content')).not.toBeInTheDocument();
  });

  it('clears the legacy global collapse key so no stale true survives', () => {
    localStorage.setItem('article-summary-collapsed', 'true');
    render(
      <ArticleSummary
        pageId="p1"
        summaryHtml="<p>Summary</p>"
        summaryStatus="summarized"
        summaryGeneratedAt={null}
        summaryModel={null}
        summaryError={null}
      />,
      { wrapper: createWrapper() },
    );
    expect(localStorage.getItem('article-summary-collapsed')).toBeNull();
    // ...and it does not govern this page: with no per-page choice the default
    // applies, which here (no lede declared) is expanded.
    expect(screen.getByTestId('article-summary-content')).toBeInTheDocument();
  });

  // ---- Deferring to the article's own lede ----

  describe('deferToLede', () => {
    const summarized = {
      summaryHtml: '<p>Summary</p>',
      summaryStatus: 'summarized' as const,
      summaryGeneratedAt: null,
      summaryModel: null,
      summaryError: null,
    };

    it('starts collapsed when the article opens with its own lede', () => {
      render(<ArticleSummary pageId="p1" {...summarized} deferToLede />, {
        wrapper: createWrapper(),
      });
      expect(screen.queryByTestId('article-summary-content')).not.toBeInTheDocument();
      // The header still renders — deferring hides the paraphrase, not the block.
      expect(screen.getByText('AI Summary')).toBeInTheDocument();
    });

    it('starts expanded when the article has no lede to defer to', () => {
      render(<ArticleSummary pageId="p1" {...summarized} deferToLede={false} />, {
        wrapper: createWrapper(),
      });
      expect(screen.getByTestId('article-summary-content')).toBeInTheDocument();
    });

    it('is only a default — an explicit choice for this page wins', () => {
      localStorage.setItem('article-summary-collapsed:p1', 'false');
      render(<ArticleSummary pageId="p1" {...summarized} deferToLede />, {
        wrapper: createWrapper(),
      });
      expect(screen.getByTestId('article-summary-content')).toBeInTheDocument();
    });

    it('can still be expanded by the reader when it deferred', () => {
      render(<ArticleSummary pageId="p1" {...summarized} deferToLede />, {
        wrapper: createWrapper(),
      });
      fireEvent.click(screen.getByText('AI Summary'));
      expect(screen.getByTestId('article-summary-content')).toBeInTheDocument();
      expect(localStorage.getItem('article-summary-collapsed:p1')).toBe('false');
    });
  });

  // ---- Staleness ----

  describe('stale summary', () => {
    const base = {
      pageId: 'p1',
      summaryHtml: '<p>Summary</p>',
      summaryStatus: 'summarized' as const,
      summaryModel: null,
      summaryError: null,
    };

    it('flags a summary generated before the last edit', () => {
      render(
        <ArticleSummary
          {...base}
          summaryGeneratedAt="2026-08-01T12:00:00Z"
          lastModifiedAt="2026-08-09T12:00:00Z"
        />,
        { wrapper: createWrapper() },
      );
      expect(screen.getByTestId('article-summary-stale')).toBeInTheDocument();
    });

    it('says nothing when the summary is current', () => {
      render(
        <ArticleSummary
          {...base}
          summaryGeneratedAt="2026-08-09T12:00:00Z"
          lastModifiedAt="2026-08-01T12:00:00Z"
        />,
        { wrapper: createWrapper() },
      );
      expect(screen.queryByTestId('article-summary-stale')).not.toBeInTheDocument();
    });

    // The whole point of putting it in the header: deferring to the lede must
    // never hide the fact that the summary describes content that changed.
    it('stays visible while the block is collapsed', () => {
      render(
        <ArticleSummary
          {...base}
          summaryGeneratedAt="2026-08-01T12:00:00Z"
          lastModifiedAt="2026-08-09T12:00:00Z"
          deferToLede
        />,
        { wrapper: createWrapper() },
      );
      expect(screen.queryByTestId('article-summary-content')).not.toBeInTheDocument();
      expect(screen.getByTestId('article-summary-stale')).toBeInTheDocument();
    });

    // Regenerate is admin-only (#356). Staleness is the signal a viewer gets,
    // so it must not be gated the same way.
    it('shows to non-admin viewers, who have no Regenerate control', () => {
      useAuthStore.setState({ user: { id: '2', username: 'viewer', role: 'user' } });
      render(
        <ArticleSummary
          {...base}
          summaryGeneratedAt="2026-08-01T12:00:00Z"
          lastModifiedAt="2026-08-09T12:00:00Z"
        />,
        { wrapper: createWrapper() },
      );
      expect(screen.getByTestId('article-summary-stale')).toBeInTheDocument();
      expect(screen.queryByTestId('summary-regenerate-button')).not.toBeInTheDocument();
    });
  });

  it('renders nothing when summarized but no summaryHtml', () => {
    const { container } = render(
      <ArticleSummary
        pageId="p1"
        summaryHtml={null}
        summaryStatus="summarized"
        summaryGeneratedAt={null}
        summaryModel={null}
        summaryError={null}
      />,
      { wrapper: createWrapper() },
    );
    expect(container.querySelector('[data-testid="article-summary"]')).not.toBeInTheDocument();
  });

  it('shows regenerate button in summarized state for admins', () => {
    render(
      <ArticleSummary
        pageId="p1"
        summaryHtml="<p>Summary</p>"
        summaryStatus="summarized"
        summaryGeneratedAt={null}
        summaryModel={null}
        summaryError={null}
      />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByTestId('summary-regenerate-button')).toBeInTheDocument();
  });

  // ---- #356: role-gating ----------------------------------------------------

  it('hides the regenerate button for non-admin viewers (#356)', () => {
    setUser('user');
    render(
      <ArticleSummary
        pageId="p1"
        summaryHtml="<p>Summary</p>"
        summaryStatus="summarized"
        summaryGeneratedAt={null}
        summaryModel={null}
        summaryError={null}
      />,
      { wrapper: createWrapper() },
    );
    // The summary banner itself is still visible to all users.
    expect(screen.getByTestId('article-summary')).toBeInTheDocument();
    // But the admin-only regenerate control is not.
    expect(screen.queryByTestId('summary-regenerate-button')).not.toBeInTheDocument();
  });

  it('hides the retry button on the failed banner for non-admin viewers (#356)', () => {
    setUser('user');
    render(
      <ArticleSummary
        pageId="p1"
        summaryHtml={null}
        summaryStatus="failed"
        summaryGeneratedAt={null}
        summaryModel={null}
        summaryError="boom"
      />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByTestId('article-summary-failed')).toBeInTheDocument();
    // The error text is still shown, but the retry button is gone.
    expect(screen.queryByTestId('summary-retry-button')).not.toBeInTheDocument();
  });

  it('hides the regenerate button when no user is logged in', () => {
    setUser(null);
    render(
      <ArticleSummary
        pageId="p1"
        summaryHtml="<p>Summary</p>"
        summaryStatus="summarized"
        summaryGeneratedAt={null}
        summaryModel={null}
        summaryError={null}
      />,
      { wrapper: createWrapper() },
    );
    expect(screen.queryByTestId('summary-regenerate-button')).not.toBeInTheDocument();
  });

  // ---- #356: error-toast surfaces server message ----------------------------

  it('shows the success toast when admin regenerate succeeds', async () => {
    mockMutate.mockImplementation((_pageId, opts) => {
      opts?.onSuccess?.();
    });
    render(
      <ArticleSummary
        pageId="p1"
        summaryHtml="<p>Summary</p>"
        summaryStatus="summarized"
        summaryGeneratedAt={null}
        summaryModel={null}
        summaryError={null}
      />,
      { wrapper: createWrapper() },
    );
    fireEvent.click(screen.getByTestId('summary-regenerate-button'));
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith('Summary regeneration queued');
    });
  });

  it('surfaces the server error message in the toast on failure (#356)', async () => {
    mockMutate.mockImplementation((_pageId, opts) => {
      opts?.onError?.(new Error('Page not found'));
    });
    render(
      <ArticleSummary
        pageId="p1"
        summaryHtml="<p>Summary</p>"
        summaryStatus="summarized"
        summaryGeneratedAt={null}
        summaryModel={null}
        summaryError={null}
      />,
      { wrapper: createWrapper() },
    );
    fireEvent.click(screen.getByTestId('summary-regenerate-button'));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Page not found');
    });
  });

  it('falls back to the generic toast when the error has no message', async () => {
    mockMutate.mockImplementation((_pageId, opts) => {
      opts?.onError?.(new Error(''));
    });
    render(
      <ArticleSummary
        pageId="p1"
        summaryHtml="<p>Summary</p>"
        summaryStatus="summarized"
        summaryGeneratedAt={null}
        summaryModel={null}
        summaryError={null}
      />,
      { wrapper: createWrapper() },
    );
    fireEvent.click(screen.getByTestId('summary-regenerate-button'));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Failed to queue summary regeneration');
    });
  });
});
