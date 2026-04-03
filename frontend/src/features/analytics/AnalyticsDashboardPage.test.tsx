import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnalyticsDashboardPage } from './AnalyticsDashboardPage';
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

const mockDashboardData = {
  trending: [
    { id: 'p1', title: 'Kubernetes Guide', spaceKey: 'DEV', viewCount: 42 },
    { id: 'p2', title: 'Docker Setup', spaceKey: 'OPS', viewCount: 35 },
  ],
  quality: {
    averageScore: 78,
    articlesNeedingAttention: 5,
    totalScored: 42,
  },
  contentGaps: [
    { query: 'terraform modules', occurrences: 8 },
    { query: 'helm charts', occurrences: 3 },
  ],
  mostHelpful: [
    { id: 'p3', title: 'API Guide', spaceKey: 'DEV', helpfulCount: 15, unhelpfulCount: 1 },
  ],
  leastHelpful: [
    { id: 'p4', title: 'Old Setup Doc', spaceKey: 'OPS', helpfulCount: 1, unhelpfulCount: 8 },
  ],
};

const mockVerificationHealth = {
  stats: { fresh: 20, aging: 10, overdue: 5, unverified: 3, total: 38 },
  overdueArticles: [],
};

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/analytics/dashboard')) {
      return new Response(JSON.stringify(mockDashboardData), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/analytics/verification-health')) {
      return new Response(JSON.stringify(mockVerificationHealth), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('AnalyticsDashboardPage', () => {
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
    render(<AnalyticsDashboardPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Content Analytics')).toBeInTheDocument();
  });

  it('shows trending articles section', async () => {
    mockFetch();
    render(<AnalyticsDashboardPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('trending-articles')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Kubernetes Guide')).toBeInTheDocument();
    });
    expect(screen.getByText('42 views')).toBeInTheDocument();
  });

  it('shows content quality overview', async () => {
    mockFetch();
    render(<AnalyticsDashboardPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('quality-overview')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('78')).toBeInTheDocument();
    });
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Articles Scored')).toBeInTheDocument();
  });

  it('shows content gaps summary', async () => {
    mockFetch();
    render(<AnalyticsDashboardPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('content-gaps-summary')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('terraform modules')).toBeInTheDocument();
    });
    expect(screen.getByText('8x')).toBeInTheDocument();
  });

  it('shows verification health section', () => {
    mockFetch();
    render(<AnalyticsDashboardPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Verification Health')).toBeInTheDocument();
  });

  it('shows reader feedback summary', async () => {
    mockFetch();
    render(<AnalyticsDashboardPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('feedback-summary')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('API Guide')).toBeInTheDocument();
    });
  });
});
