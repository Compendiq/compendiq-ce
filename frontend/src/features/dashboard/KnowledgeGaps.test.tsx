import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KnowledgeGaps } from './KnowledgeGaps';
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

describe('KnowledgeGaps', () => {
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

  it('shows the Knowledge Gaps header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ gaps: [], total: 0, periodDays: 30 }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<KnowledgeGaps />, { wrapper: createWrapper() });
    expect(screen.getByText('Knowledge Gaps')).toBeInTheDocument();
  });

  it('shows the number of unanswered queries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          gaps: [
            { query: 'kubernetes', occurrences: 5, lastSearched: '2026-03-01T00:00:00Z', avgMaxScore: null },
            { query: 'terraform', occurrences: 3, lastSearched: '2026-03-02T00:00:00Z', avgMaxScore: null },
          ],
          total: 2,
          periodDays: 30,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<KnowledgeGaps />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/2 unanswered queries/)).toBeInTheDocument();
    });
  });

  it('shows comprehensive message when no gaps', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ gaps: [], total: 0, periodDays: 30 }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<KnowledgeGaps />, { wrapper: createWrapper() });

    // Expand the card
    await waitFor(() => {
      expect(screen.getByText(/0 unanswered queries/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Knowledge Gaps'));

    await waitFor(() => {
      expect(screen.getByText(/No knowledge gaps detected/)).toBeInTheDocument();
    });
  });

  it('shows gap items when expanded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          gaps: [
            { query: 'kubernetes deployment', occurrences: 5, lastSearched: '2026-03-01T00:00:00Z', avgMaxScore: null },
          ],
          total: 1,
          periodDays: 30,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<KnowledgeGaps />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/1 unanswered query/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Knowledge Gaps'));

    await waitFor(() => {
      expect(screen.getByText('kubernetes deployment')).toBeInTheDocument();
    });
  });

  it('navigates to AI generate page when Create is clicked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          gaps: [
            { query: 'redis caching', occurrences: 3, lastSearched: '2026-03-01T00:00:00Z', avgMaxScore: null },
          ],
          total: 1,
          periodDays: 30,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<KnowledgeGaps />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/1 unanswered query/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Knowledge Gaps'));

    await waitFor(() => {
      expect(screen.getByText('redis caching')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create'));
    expect(mockNavigate).toHaveBeenCalledWith('/ai?mode=generate&prompt=redis%20caching');
  });
});
