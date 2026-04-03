import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContentGapsPage } from './ContentGapsPage';
import { useAuthStore } from '../../stores/auth-store';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LazyMotion features={domAnimation}>
            {children}
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const mockGapsData = {
  gaps: [
    {
      query: 'kubernetes deployment',
      occurrences: 12,
      lastSearched: '2026-03-10T00:00:00Z',
      avgMaxScore: null,
    },
    {
      query: 'terraform modules',
      occurrences: 5,
      lastSearched: '2026-03-09T00:00:00Z',
      avgMaxScore: null,
    },
  ],
  total: 2,
  periodDays: 30,
};

function mockFetch(data = mockGapsData) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('ContentGapsPage', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
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

  it('renders the page heading', () => {
    mockFetch();
    render(<ContentGapsPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Content Gaps')).toBeInTheDocument();
  });

  it('shows gap list with content', async () => {
    mockFetch();
    render(<ContentGapsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('content-gaps-list')).toBeInTheDocument();
    });
    expect(screen.getByText('kubernetes deployment')).toBeInTheDocument();
    expect(screen.getByText('terraform modules')).toBeInTheDocument();
  });

  it('shows summary text with count', async () => {
    mockFetch();
    render(<ContentGapsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('gaps-summary')).toHaveTextContent('2 failed queries');
    });
  });

  it('navigates to new page when Create Article is clicked', async () => {
    mockFetch();
    render(<ContentGapsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('create-article-0')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('create-article-0'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/new?title=kubernetes%20deployment');
  });

  it('navigates to knowledge requests when Request is clicked', async () => {
    mockFetch();
    render(<ContentGapsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('create-request-0')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('create-request-0'));
    expect(mockNavigate).toHaveBeenCalledWith('/knowledge-requests?title=kubernetes%20deployment');
  });

  it('shows empty state when no gaps', async () => {
    mockFetch({ gaps: [], total: 0, periodDays: 30 });
    render(<ContentGapsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('no-gaps-title')).toHaveTextContent('No content gaps');
    });
  });
});
