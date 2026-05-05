/**
 * Tests for ReviewerQueuePage (Compendiq/compendiq-ee#120).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReviewerQueuePage } from './ReviewerQueuePage';
import { useAuthStore } from '../../stores/auth-store';
import type { AiReviewListItem } from '@compendiq/contracts';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const mockUseEnterprise = vi.fn();
vi.mock('../../shared/enterprise/use-enterprise', () => ({
  useEnterprise: () => mockUseEnterprise(),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/settings/ai/ai-reviews']}>
          <LazyMotion features={domMax}>
            <Routes>
              <Route
                path="/settings/ai/ai-reviews"
                element={<>{children}</>}
              />
              <Route
                path="/settings/ai-reviews/:id"
                element={<div data-testid="navigated-to-detail" />}
              />
            </Routes>
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const sampleReview: AiReviewListItem = {
  id: '11111111-1111-4111-8111-111111111111',
  page_id: 42,
  action_type: 'improve',
  authored_by: '22222222-2222-4222-8222-222222222222',
  authored_at: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
  status: 'pending',
};

interface MockOptions {
  reviews?: AiReviewListItem[];
  getStatus?: 404 | 500;
}

function mockFetch(opts: MockOptions = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = (
        init?.method ??
        (input as Request)?.method ??
        'GET'
      ).toUpperCase();

      if (url.includes('/ai-reviews') && method === 'GET') {
        if (opts.getStatus === 404) {
          return new Response(JSON.stringify({ error: 'not_found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (opts.getStatus === 500) {
          return new Response(JSON.stringify({ message: 'boom' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({ reviews: opts.reviews ?? [] }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      return new Response('Not found', { status: 404 });
    });
}

describe('ReviewerQueuePage', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'admin',
      email: 'admin@test',
      role: 'admin',
      displayName: null,
      isActive: true,
    });
    mockUseEnterprise.mockReturnValue({
      isEnterprise: true,
      hasFeature: (f: string) => f === 'ai_output_review',
      license: null,
      refresh: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an upgrade prompt when the licence does not grant the feature', () => {
    mockUseEnterprise.mockReturnValue({
      isEnterprise: false,
      hasFeature: () => false,
      license: null,
      refresh: vi.fn(),
    });
    const Wrapper = createWrapper();
    render(<ReviewerQueuePage />, { wrapper: Wrapper });
    expect(
      screen.getByTestId('ai-review-queue-not-licensed'),
    ).toBeInTheDocument();
  });

  it('renders the empty state when no reviews are pending', async () => {
    mockFetch({ reviews: [] });
    const Wrapper = createWrapper();
    render(<ReviewerQueuePage />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-queue-empty'),
      ).toBeInTheDocument();
    });
  });

  it('renders one row per review with action label + relative time', async () => {
    mockFetch({
      reviews: [
        sampleReview,
        {
          ...sampleReview,
          id: '33333333-3333-4333-8333-333333333333',
          page_id: 43,
          action_type: 'auto_tag',
        },
      ],
    });
    const Wrapper = createWrapper();
    render(<ReviewerQueuePage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId(`ai-review-row-${sampleReview.id}`),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('ai-review-row-33333333-3333-4333-8333-333333333333'),
    ).toBeInTheDocument();
    // Action label rendered.
    expect(
      screen.getByTestId(`ai-review-action-${sampleReview.id}`),
    ).toHaveTextContent('Improve');
    // Relative time rendered (5h ago, give or take a second).
    expect(
      screen.getByTestId(`ai-review-row-${sampleReview.id}`).textContent,
    ).toMatch(/[0-9]+h ago/);
  });

  it('navigates to the detail page when Review is clicked', async () => {
    mockFetch({ reviews: [sampleReview] });
    const Wrapper = createWrapper();
    render(<ReviewerQueuePage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId(`ai-review-row-review-btn-${sampleReview.id}`),
      ).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByTestId(`ai-review-row-review-btn-${sampleReview.id}`),
    );

    await waitFor(() => {
      expect(screen.getByTestId('navigated-to-detail')).toBeInTheDocument();
    });
  });

  it('shows an EE-overlay-missing notice on 404', async () => {
    mockFetch({ getStatus: 404 });
    const Wrapper = createWrapper();
    render(<ReviewerQueuePage />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-queue-overlay-missing'),
      ).toBeInTheDocument();
    });
  });

  it('shows a generic error banner on 500', async () => {
    mockFetch({ getStatus: 500 });
    const Wrapper = createWrapper();
    render(<ReviewerQueuePage />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(
        screen.getByTestId('ai-review-queue-error'),
      ).toBeInTheDocument();
    });
  });

  it('refetches with the chosen status when the filter changes', async () => {
    const fetchSpy = mockFetch({ reviews: [sampleReview] });
    const Wrapper = createWrapper();
    render(<ReviewerQueuePage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId(`ai-review-row-${sampleReview.id}`),
      ).toBeInTheDocument();
    });

    const statusFilter = screen.getByTestId(
      'ai-review-queue-status-filter',
    ) as HTMLSelectElement;
    fireEvent.change(statusFilter, { target: { value: 'rejected' } });

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.filter((c) => {
        const url = typeof c[0] === 'string' ? c[0] : (c[0] as Request).url;
        return url.includes('status=rejected');
      });
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it('filters in-memory by action type', async () => {
    mockFetch({
      reviews: [
        sampleReview,
        {
          ...sampleReview,
          id: '44444444-4444-4444-8444-444444444444',
          action_type: 'auto_tag',
        },
      ],
    });
    const Wrapper = createWrapper();
    render(<ReviewerQueuePage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByTestId(`ai-review-row-${sampleReview.id}`),
      ).toBeInTheDocument();
    });

    const actionFilter = screen.getByTestId(
      'ai-review-queue-action-filter',
    ) as HTMLSelectElement;
    fireEvent.change(actionFilter, { target: { value: 'auto_tag' } });

    await waitFor(() => {
      expect(
        screen.queryByTestId(`ai-review-row-${sampleReview.id}`),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId('ai-review-row-44444444-4444-4444-8444-444444444444'),
      ).toBeInTheDocument();
    });
  });
});
