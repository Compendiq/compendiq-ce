import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TrashPage } from './TrashPage';

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

const mockTrashItems = {
  items: [
    {
      id: 1,
      title: 'Deleted Article',
      deletedAt: '2026-03-10T00:00:00Z',
      deletedBy: 'alice',
      autoPurgeAt: '2026-04-09T00:00:00Z',
    },
    {
      id: 2,
      title: 'Another Deleted',
      deletedAt: '2026-03-12T00:00:00Z',
      deletedBy: 'bob',
      autoPurgeAt: '2026-04-11T00:00:00Z',
    },
  ],
  total: 2,
};

function mockFetch(data: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('TrashPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the page title and description', () => {
    mockFetch({ items: [], total: 0 });
    render(<TrashPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Trash')).toBeInTheDocument();
    expect(screen.getByText(/automatically purged/)).toBeInTheDocument();
  });

  it('shows empty state when no items in trash', async () => {
    mockFetch({ items: [], total: 0 });
    render(<TrashPage />, { wrapper: createWrapper() });
    const empty = await screen.findByTestId('trash-empty');
    expect(empty).toBeInTheDocument();
    expect(screen.getByText('No articles in trash')).toBeInTheDocument();
  });

  it('renders trash items with title and metadata', async () => {
    mockFetch(mockTrashItems);
    render(<TrashPage />, { wrapper: createWrapper() });

    const list = await screen.findByTestId('trash-list');
    expect(list).toBeInTheDocument();

    expect(screen.getByText('Deleted Article')).toBeInTheDocument();
    expect(screen.getByText('Another Deleted')).toBeInTheDocument();
    expect(screen.getByText(/by alice/)).toBeInTheDocument();
    expect(screen.getByText(/by bob/)).toBeInTheDocument();
  });

  it('shows restore button for each trash item', async () => {
    mockFetch(mockTrashItems);
    render(<TrashPage />, { wrapper: createWrapper() });
    await screen.findByTestId('trash-list');
    expect(screen.getByTestId('restore-btn-1')).toBeInTheDocument();
    expect(screen.getByTestId('restore-btn-2')).toBeInTheDocument();
  });

  it('calls restore API when restore button is clicked', async () => {
    const fetchSpy = mockFetch(mockTrashItems);
    render(<TrashPage />, { wrapper: createWrapper() });
    await screen.findByTestId('trash-list');

    // Reset the mock to track the restore call
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ message: 'restored' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    fireEvent.click(screen.getByTestId('restore-btn-1'));

    await waitFor(() => {
      const calls = fetchSpy.mock.calls;
      const restoreCall = calls.find(([url]) =>
        typeof url === 'string' && url.includes('/trash/1/restore'),
      );
      expect(restoreCall).toBeTruthy();
    });
  });

  it('shows days until auto-purge for each item', async () => {
    mockFetch(mockTrashItems);
    render(<TrashPage />, { wrapper: createWrapper() });
    await screen.findByTestId('trash-list');
    // Should show auto-purge information
    const purgeTexts = screen.getAllByText(/days until auto-purge/);
    expect(purgeTexts).toHaveLength(2);
  });
});
