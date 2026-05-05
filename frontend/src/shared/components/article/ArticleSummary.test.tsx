import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  it('persists collapse state in localStorage', () => {
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

    // Collapse
    fireEvent.click(screen.getByText('AI Summary'));
    expect(localStorage.getItem('article-summary-collapsed')).toBe('true');

    unmount();

    // Re-render should start collapsed
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
    expect(screen.queryByTestId('article-summary-content')).not.toBeInTheDocument();
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
