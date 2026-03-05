import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DuplicateDetector } from './DuplicateDetector';
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

describe('DuplicateDetector', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'testuser',
      role: 'user',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders the Find Duplicates button', () => {
    render(
      <DuplicateDetector pageId="page-1" pageTitle="Test Page" />,
      { wrapper: createWrapper() },
    );

    expect(screen.getByText('Find Duplicates')).toBeInTheDocument();
    expect(screen.getByText('Duplicate Detection')).toBeInTheDocument();
  });

  it('shows loading state when scanning', async () => {
    // Mock fetch to hang (never resolve) to test loading state
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise(() => {}), // Never resolves
    );

    render(
      <DuplicateDetector pageId="page-1" pageTitle="Test Page" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Find Duplicates'));

    await waitFor(() => {
      expect(screen.getByText('Scanning for similar pages...')).toBeInTheDocument();
    });
  });

  it('shows no duplicates message when none found', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ duplicates: [], pageId: 'page-1' }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <DuplicateDetector pageId="page-1" pageTitle="Test Page" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Find Duplicates'));

    await waitFor(() => {
      expect(screen.getByText(/No duplicates found/)).toBeInTheDocument();
    });
  });

  it('shows duplicate results with similarity scores', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          duplicates: [
            {
              confluenceId: 'page-2',
              title: 'Similar Page',
              spaceKey: 'DEV',
              embeddingDistance: 0.1,
              titleSimilarity: 0.5,
              combinedScore: 0.78,
            },
          ],
          pageId: 'page-1',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <DuplicateDetector pageId="page-1" pageTitle="Test Page" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Find Duplicates'));

    await waitFor(() => {
      expect(screen.getByText('Similar Page')).toBeInTheDocument();
      expect(screen.getByText('DEV')).toBeInTheDocument();
      expect(screen.getByText('Compare')).toBeInTheDocument();
      expect(screen.getByText('View')).toBeInTheDocument();
    });
  });

  it('navigates to view page when View is clicked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          duplicates: [
            {
              confluenceId: 'page-2',
              title: 'Similar Page',
              spaceKey: 'DEV',
              embeddingDistance: 0.1,
              titleSimilarity: 0.5,
              combinedScore: 0.78,
            },
          ],
          pageId: 'page-1',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <DuplicateDetector pageId="page-1" pageTitle="Test Page" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Find Duplicates'));

    await waitFor(() => {
      expect(screen.getByText('View')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('View'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/page-2');
  });
});
