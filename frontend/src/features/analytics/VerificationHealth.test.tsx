import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VerificationHealth } from './VerificationHealth';
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
          <LazyMotion features={domMax}>
            {children}
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const mockData = {
  stats: { fresh: 20, aging: 10, overdue: 5, unverified: 3, total: 38 },
  overdueArticles: [
    {
      id: 'p1',
      title: 'Outdated API Docs',
      spaceKey: 'DEV',
      lastVerifiedAt: '2025-01-01T00:00:00Z',
      lastModifiedAt: '2025-06-01T00:00:00Z',
    },
  ],
};

function mockFetch(data = mockData) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('VerificationHealth', () => {
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

  it('renders four status cards', async () => {
    mockFetch();
    render(<VerificationHealth />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('verification-fresh')).toBeInTheDocument();
    });
    expect(screen.getByTestId('verification-aging')).toBeInTheDocument();
    expect(screen.getByTestId('verification-overdue')).toBeInTheDocument();
    expect(screen.getByTestId('verification-unverified')).toBeInTheDocument();
  });

  it('displays counts and percentages', async () => {
    mockFetch();
    render(<VerificationHealth />, { wrapper: createWrapper() });

    await waitFor(() => {
      const freshCard = screen.getByTestId('verification-fresh');
      expect(freshCard).toHaveTextContent('20');
      expect(freshCard).toHaveTextContent('53%');
    });
  });

  it('shows overdue articles list', async () => {
    mockFetch();
    render(<VerificationHealth />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('overdue-articles-list')).toBeInTheDocument();
    });
    expect(screen.getByText('Outdated API Docs')).toBeInTheDocument();
  });

  it('shows verify button for overdue articles', async () => {
    mockFetch();
    render(<VerificationHealth />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('verify-p1')).toBeInTheDocument();
    });
  });

  it('does not show overdue list when empty', async () => {
    mockFetch({
      stats: { fresh: 10, aging: 5, overdue: 0, unverified: 0, total: 15 },
      overdueArticles: [],
    });
    render(<VerificationHealth />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('verification-fresh')).toHaveTextContent('10');
    });
    expect(screen.queryByTestId('overdue-articles-list')).not.toBeInTheDocument();
  });
});
