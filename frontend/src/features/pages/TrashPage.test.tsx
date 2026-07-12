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

const DAY_MS = 24 * 60 * 60 * 1000;

// Mirrors the GET /api/pages/trash response shape from
// backend/src/routes/knowledge/pages-crud.ts (id is a STRING).
const mockTrashData = {
  items: [
    {
      id: '3',
      title: 'Deleted Article',
      source: 'standalone',
      visibility: 'private',
      deletedAt: new Date(Date.now() - DAY_MS).toISOString(),
      createdAt: new Date(Date.now() - 10 * DAY_MS).toISOString(),
      deletedBy: 'simon',
      autoPurgeAt: new Date(Date.now() + 29 * DAY_MS).toISOString(),
    },
  ],
  total: 1,
};

/**
 * Mocks fetch at the network boundary, answering only the real backend
 * endpoints: GET /api/pages/trash and POST /api/pages/:id/restore.
 * Everything else (e.g. the old /api/trash path) gets a 404.
 */
function mockApi(trashData: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';

    if (url === '/api/pages/trash' && method === 'GET') {
      return new Response(JSON.stringify(trashData), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const restoreMatch = url.match(/^\/api\/pages\/([^/]+)\/restore$/);
    if (restoreMatch && method === 'POST') {
      return new Response(
        JSON.stringify({ id: restoreMatch[1], title: 'Deleted Article', restored: true }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ message: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('TrashPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the page title and description', () => {
    mockApi({ items: [], total: 0 });
    render(<TrashPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Trash')).toBeInTheDocument();
    expect(screen.getByText(/automatically purged/)).toBeInTheDocument();
  });

  it('shows empty state when no items in trash', async () => {
    mockApi({ items: [], total: 0 });
    render(<TrashPage />, { wrapper: createWrapper() });
    const empty = await screen.findByTestId('trash-empty');
    expect(empty).toBeInTheDocument();
    expect(screen.getByText('No pages in trash')).toBeInTheDocument();
  });

  it('renders trash items fetched from GET /api/pages/trash', async () => {
    mockApi(mockTrashData);
    render(<TrashPage />, { wrapper: createWrapper() });

    const list = await screen.findByTestId('trash-list');
    expect(list).toBeInTheDocument();

    expect(screen.getByText('Deleted Article')).toBeInTheDocument();
    expect(screen.getByText(/by simon/)).toBeInTheDocument();
  });

  it('shows days until auto-purge for each item', async () => {
    mockApi(mockTrashData);
    render(<TrashPage />, { wrapper: createWrapper() });
    await screen.findByTestId('trash-list');
    expect(screen.getByText(/29 days until auto-purge/)).toBeInTheDocument();
  });

  it('exposes an accessible name on the back button (#939)', () => {
    mockApi({ items: [], total: 0 });
    render(<TrashPage />, { wrapper: createWrapper() });
    expect(screen.getByRole('button', { name: /back to dashboard/i })).toBeInTheDocument();
  });

  it('shows a restore button for each trash item', async () => {
    mockApi(mockTrashData);
    render(<TrashPage />, { wrapper: createWrapper() });
    await screen.findByTestId('trash-list');
    expect(screen.getByTestId('restore-btn-3')).toBeInTheDocument();
  });

  it('issues POST /api/pages/3/restore when restore is clicked', async () => {
    const fetchSpy = mockApi(mockTrashData);
    render(<TrashPage />, { wrapper: createWrapper() });
    await screen.findByTestId('trash-list');

    fireEvent.click(screen.getByTestId('restore-btn-3'));

    await waitFor(() => {
      const restoreCall = fetchSpy.mock.calls.find(
        ([url, init]) =>
          typeof url === 'string' &&
          url === '/api/pages/3/restore' &&
          init?.method === 'POST',
      );
      expect(restoreCall).toBeTruthy();
    });
  });
});
