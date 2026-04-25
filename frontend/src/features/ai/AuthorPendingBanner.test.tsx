/**
 * Tests for AuthorPendingBanner (Compendiq/compendiq-ee#120).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthorPendingBanner } from './AuthorPendingBanner';
import { useAuthStore } from '../../stores/auth-store';

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
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

interface MockOptions {
  count?: number;
  status?: 200 | 404 | 500;
}

function mockFetch(opts: MockOptions = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/me/ai-review-pending-count')) {
        if (opts.status === 404) {
          return new Response(JSON.stringify({ error: 'not_found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (opts.status === 500) {
          return new Response(JSON.stringify({ message: 'boom' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ count: opts.count ?? 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });
}

describe('AuthorPendingBanner', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'tester',
      email: 'tester@test',
      role: 'editor',
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

  it('renders nothing in CE-only deployments (feature gated)', async () => {
    mockUseEnterprise.mockReturnValue({
      isEnterprise: false,
      hasFeature: () => false,
      license: null,
      refresh: vi.fn(),
    });
    const fetchSpy = mockFetch({ count: 5 });
    const Wrapper = createWrapper();
    const { container } = render(<AuthorPendingBanner />, {
      wrapper: Wrapper,
    });
    expect(container.firstChild).toBeNull();
    // Crucially, no probe is sent — saves bandwidth on CE deployments.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders nothing while count is 0', async () => {
    mockFetch({ count: 0 });
    const Wrapper = createWrapper();
    const { container } = render(<AuthorPendingBanner />, {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId('author-pending-banner'),
      ).not.toBeInTheDocument();
    });
    expect(container.querySelector('[data-testid="author-pending-banner"]')).toBeNull();
  });

  it('renders the banner with the count when count > 0', async () => {
    mockFetch({ count: 3 });
    const Wrapper = createWrapper();
    render(<AuthorPendingBanner />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByTestId('author-pending-banner')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('author-pending-banner-count'),
    ).toHaveTextContent('3 AI outputs awaiting review');
    const link = screen.getByTestId('author-pending-banner-link');
    expect(link).toHaveAttribute('href', '/settings/ai/ai-reviews');
  });

  it('uses singular text when count === 1', async () => {
    mockFetch({ count: 1 });
    const Wrapper = createWrapper();
    render(<AuthorPendingBanner />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(
        screen.getByTestId('author-pending-banner-count'),
      ).toHaveTextContent('1 AI output awaiting review');
    });
  });

  it('hides silently on 404 (overlay route not deployed)', async () => {
    mockFetch({ status: 404 });
    const Wrapper = createWrapper();
    render(<AuthorPendingBanner />, { wrapper: Wrapper });
    // Wait long enough for the 404 to settle, then verify nothing.
    await new Promise((r) => setTimeout(r, 50));
    expect(
      screen.queryByTestId('author-pending-banner'),
    ).not.toBeInTheDocument();
  });

  it('hides silently on 500 (transient error must not block page edit)', async () => {
    mockFetch({ status: 500 });
    const Wrapper = createWrapper();
    render(<AuthorPendingBanner />, { wrapper: Wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(
      screen.queryByTestId('author-pending-banner'),
    ).not.toBeInTheDocument();
  });
});
