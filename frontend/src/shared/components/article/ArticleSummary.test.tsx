import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArticleSummary } from './ArticleSummary';

// Mock use-pages hooks
vi.mock('../hooks/use-pages', () => ({
  useSummaryRegenerate: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
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

describe('ArticleSummary', () => {
  beforeEach(() => {
    localStorage.clear();
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

  it('renders failed state with error message and retry button', () => {
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

  it('shows regenerate button in summarized state', () => {
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
});
