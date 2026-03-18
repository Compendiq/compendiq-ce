import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FeedbackWidget } from './FeedbackWidget';
import { useAuthStore } from '../../../stores/auth-store';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          {children}
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

/** Matches GET /api/pages/:id/feedback backend response */
const mockFeedbackData = {
  helpful: 5,
  notHelpful: 1,
  total: 6,
  userVote: null as { isHelpful: boolean; comment: string | null } | null,
};

function mockFetch(data = mockFeedbackData) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/feedback') && (!init || init.method !== 'POST')) {
      return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // POST feedback
    return new Response(JSON.stringify({ id: 1 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('FeedbackWidget', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'user',
      role: 'user',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders the feedback question', () => {
    mockFetch();
    render(<FeedbackWidget pageId="page-1" />, { wrapper: createWrapper() });
    expect(screen.getByText('Was this article helpful?')).toBeInTheDocument();
  });

  it('renders helpful and unhelpful buttons', () => {
    mockFetch();
    render(<FeedbackWidget pageId="page-1" />, { wrapper: createWrapper() });
    expect(screen.getByTestId('feedback-helpful')).toBeInTheDocument();
    expect(screen.getByTestId('feedback-unhelpful')).toBeInTheDocument();
  });

  it('shows vote count when available', async () => {
    mockFetch();
    render(<FeedbackWidget pageId="page-1" />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('feedback-count')).toHaveTextContent('5 people found this helpful');
    });
  });

  it('shows thanks message after helpful vote', async () => {
    mockFetch();
    render(<FeedbackWidget pageId="page-1" />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('feedback-helpful')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('feedback-helpful'));

    expect(screen.getByTestId('feedback-thanks')).toHaveTextContent('Thanks for your feedback!');
  });

  it('shows comment field after unhelpful vote', async () => {
    mockFetch();
    render(<FeedbackWidget pageId="page-1" />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('feedback-unhelpful')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('feedback-unhelpful'));

    expect(screen.getByTestId('feedback-comment-section')).toBeInTheDocument();
    expect(screen.getByTestId('feedback-comment-input')).toBeInTheDocument();
  });

  it('shows singular text for 1 helpful vote', async () => {
    mockFetch({ helpful: 1, notHelpful: 0, total: 1, userVote: null });
    render(<FeedbackWidget pageId="page-1" />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('feedback-count')).toHaveTextContent('1 person found this helpful');
    });
  });

  it('sends isHelpful field in POST request', async () => {
    const fetchSpy = mockFetch();
    render(<FeedbackWidget pageId="42" />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('feedback-helpful')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('feedback-helpful'));

    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(([, opts]) =>
        opts && (opts as RequestInit).method === 'POST',
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body).toEqual({ isHelpful: true });
    });
  });

  it('sends isHelpful: false for unhelpful vote', async () => {
    const fetchSpy = mockFetch();
    render(<FeedbackWidget pageId="42" />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('feedback-unhelpful')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('feedback-unhelpful'));

    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(([, opts]) =>
        opts && (opts as RequestInit).method === 'POST',
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body).toEqual({ isHelpful: false });
    });
  });

  it('highlights helpful button when user previously voted helpful', async () => {
    mockFetch({
      helpful: 3,
      notHelpful: 0,
      total: 3,
      userVote: { isHelpful: true, comment: null },
    });
    render(<FeedbackWidget pageId="page-1" />, { wrapper: createWrapper() });

    await waitFor(() => {
      const btn = screen.getByTestId('feedback-helpful');
      expect(btn.className).toContain('bg-success');
    });
  });
});
