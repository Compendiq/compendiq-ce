import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DashboardPage } from './DashboardPage';
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

describe('DashboardPage', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    // Set auth state
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'testuser',
      role: 'user',
    });

    // Mock fetch for all API calls
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;

      if (url.includes('/api/spaces')) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { key: 'DEV', name: 'Development', lastSynced: '2026-03-01', pageCount: 10 },
            ]),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }

      if (url.includes('/api/pages') && url.includes('limit=5')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  id: 'page-1',
                  title: 'Recent Article',
                  spaceKey: 'DEV',
                  lastModifiedAt: '2026-03-04T12:00:00Z',
                  version: 1,
                  parentId: null,
                  labels: [],
                  author: 'user',
                  lastSynced: '2026-03-04',
                  embeddingDirty: false,
                },
              ],
              total: 1,
              page: 1,
              limit: 5,
              totalPages: 1,
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }

      if (url.includes('/api/pages')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ items: [], total: 42, page: 1, limit: 1, totalPages: 42 }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }

      if (url.includes('/api/embeddings/status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ totalPages: 42, embeddedPages: 37, dirtyPages: 5, totalEmbeddings: 100, isProcessing: false }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }

      if (url.includes('/api/embeddings/process')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ message: 'Embedding processing started' }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } }),
      );
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('shows welcome message with username', async () => {
    const { unmount } = render(<DashboardPage />, { wrapper: createWrapper() });
    expect(screen.getByText(/Welcome back, testuser/)).toBeInTheDocument();
    unmount();
  });

  it('displays stat cards', async () => {
    const { unmount } = render(<DashboardPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Spaces')).toBeInTheDocument();
    expect(screen.getByText('Pages')).toBeInTheDocument();
    expect(screen.getByText('Embedded Pages')).toBeInTheDocument();
    expect(screen.getByText('Chunks')).toBeInTheDocument();
    unmount();
  });

  it('shows Quick Actions section', async () => {
    const { unmount } = render(<DashboardPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Quick Actions')).toBeInTheDocument();
    expect(screen.getByText('Sync Now')).toBeInTheDocument();
    expect(screen.getByText('New Page')).toBeInTheDocument();
    expect(screen.getByText('AI Assistant')).toBeInTheDocument();
    expect(screen.getByText('Manage Spaces')).toBeInTheDocument();
    unmount();
  });

  it('navigates to correct path on quick action click', async () => {
    const { unmount } = render(<DashboardPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByText('New Page'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/new');
    unmount();
  });

  it('shows Recent Articles section', async () => {
    const { unmount } = render(<DashboardPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Recent Articles')).toBeInTheDocument();
    unmount();
  });

  it('shows Getting Started section', async () => {
    const { unmount } = render(<DashboardPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    unmount();
  });

  it('navigates to page view when article is clicked', async () => {
    const { unmount } = render(<DashboardPage />, { wrapper: createWrapper() });

    // Wait for recent articles to load
    const article = await screen.findByText('Recent Article');
    fireEvent.click(article);
    expect(mockNavigate).toHaveBeenCalledWith('/pages/page-1');
    unmount();
  });

  it('shows embedded pages ratio in stats', async () => {
    const { unmount } = render(<DashboardPage />, { wrapper: createWrapper() });
    // Wait for embedding status data to load - "37 / 42" from embeddedPages/totalPages
    const ratio = await screen.findByText('37 / 42');
    expect(ratio).toBeInTheDocument();
    unmount();
  });

  it('shows Embed Now button when dirty pages exist', async () => {
    const { unmount } = render(<DashboardPage />, { wrapper: createWrapper() });
    const embedButton = await screen.findByText('Embed Now');
    expect(embedButton).toBeInTheDocument();
    unmount();
  });

  it('shows dirty pages count in embedding trigger section', async () => {
    const { unmount } = render(<DashboardPage />, { wrapper: createWrapper() });
    const dirtyText = await screen.findByText(/5 pages need embedding/);
    expect(dirtyText).toBeInTheDocument();
    unmount();
  });

  it('calls embedding process endpoint when Embed Now is clicked', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { unmount } = render(<DashboardPage />, { wrapper: createWrapper() });

    const embedButton = await screen.findByText('Embed Now');
    fireEvent.click(embedButton);

    // Check that POST /api/embeddings/process was called
    await vi.waitFor(() => {
      const calls = fetchSpy.mock.calls;
      const processCall = calls.find((call) => {
        const url = typeof call[0] === 'string' ? call[0] : '';
        return url.includes('/api/embeddings/process');
      });
      expect(processCall).toBeDefined();
    });
    unmount();
  });

  it('does not show embedding trigger when no dirty pages', async () => {
    // Override fetch to return 0 dirty pages
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;

      if (url.includes('/api/embeddings/status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ totalPages: 42, embeddedPages: 42, dirtyPages: 0, totalEmbeddings: 200, isProcessing: false }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }

      // Return default responses for other endpoints
      if (url.includes('/api/spaces')) {
        return Promise.resolve(
          new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } }),
        );
      }
      if (url.includes('/api/pages')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ items: [], total: 0, page: 1, limit: 1, totalPages: 0 }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } }),
      );
    });

    const { unmount } = render(<DashboardPage />, { wrapper: createWrapper() });

    // Wait for data to load
    await screen.findByText('42 / 42');

    // The "Embed Now" button should not be present
    expect(screen.queryByText('Embed Now')).not.toBeInTheDocument();
    unmount();
  });
});
