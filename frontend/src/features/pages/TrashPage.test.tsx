import { describe, it, expect, vi, afterEach } from 'vitest';
import { toast } from 'sonner';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TrashPage } from './TrashPage';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

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
 * A parent and the sub-article one cascade put in the same batch — the two rows
 * `mockTrashData`'s single item cannot model (#1636).
 */
const twoItemTrash = {
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
    {
      id: '4',
      title: 'Sub-article',
      source: 'standalone',
      visibility: 'private',
      deletedAt: new Date(Date.now() - DAY_MS).toISOString(),
      createdAt: new Date(Date.now() - 9 * DAY_MS).toISOString(),
      deletedBy: 'simon',
      autoPurgeAt: new Date(Date.now() + 29 * DAY_MS).toISOString(),
    },
  ],
  total: 2,
};

/**
 * Mocks fetch at the network boundary, answering only the real backend
 * endpoints: GET /api/pages/trash and POST /api/pages/:id/restore.
 * Everything else (e.g. the old /api/trash path) gets a 404.
 *
 * `restore` overrides the POST answer per page id, so a test can exercise a
 * server refusal (the #1636 409) without inventing a second HTTP layer.
 */
function mockApi(trashData: unknown, options: { restore?: (pageId: string) => Response } = {}) {
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
      if (options.restore) return options.restore(restoreMatch[1]!);
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
    expect(screen.getByRole('button', { name: /back to pages/i })).toBeInTheDocument();
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

  it('filters trash items by search query', async () => {
    mockApi({
      items: [
        { id: '1', title: 'Architecture Document', deletedAt: new Date().toISOString(), autoPurgeAt: new Date(Date.now() + DAY_MS).toISOString(), deletedBy: 'alice' },
        { id: '2', title: 'Marketing Plan', deletedAt: new Date().toISOString(), autoPurgeAt: new Date(Date.now() + DAY_MS).toISOString(), deletedBy: 'bob' },
      ],
      total: 2,
    });
    render(<TrashPage />, { wrapper: createWrapper() });
    await screen.findByTestId('trash-list');

    const searchInput = screen.getByTestId('trash-search-input');
    fireEvent.change(searchInput, { target: { value: 'marketing' } });

    expect(screen.queryByTestId('trash-item-1')).toBeNull();
    expect(screen.getByTestId('trash-item-2')).toBeInTheDocument();
  });

  it('supports selecting all items and bulk restoring them', async () => {
    const fetchSpy = mockApi({
      items: [
        { id: '1', title: 'Doc A', deletedAt: new Date().toISOString(), autoPurgeAt: new Date(Date.now() + DAY_MS).toISOString(), deletedBy: 'alice' },
        { id: '2', title: 'Doc B', deletedAt: new Date().toISOString(), autoPurgeAt: new Date(Date.now() + DAY_MS).toISOString(), deletedBy: 'bob' },
      ],
      total: 2,
    });
    render(<TrashPage />, { wrapper: createWrapper() });
    await screen.findByTestId('trash-list');

    fireEvent.click(screen.getByTestId('trash-select-all'));
    expect(await screen.findByTestId('trash-bulk-bar')).toBeInTheDocument();
    expect(screen.getByTestId('trash-bulk-count')).toHaveTextContent('2 pages selected');

    fireEvent.click(screen.getByTestId('trash-bulk-restore-btn'));

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.filter(
        ([url, init]) =>
          typeof url === 'string' &&
          url.includes('/restore') &&
          init?.method === 'POST',
      );
      expect(calls.length).toBe(2);
    });
  });

  /**
   * #1636 — restore can now be REFUSED by the server (409: the page's ancestor
   * is still in the trash, so restoring it alone would put it back at the root).
   * The dialog's job is to say why, not to invent a message of its own.
   */
  it('surfaces the server\u2019s reason when a restore is refused', async () => {
    mockApi(mockTrashData, {
      restore: () =>
        new Response(
          JSON.stringify({
            error: 'Conflict',
            message: 'Restore "Parent article" first',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    render(<TrashPage />, { wrapper: createWrapper() });
    await screen.findByTestId('trash-list');

    fireEvent.click(screen.getByTestId('restore-btn-3'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Restore "Parent article" first');
    });
  });

  /**
   * A cascade puts several rows in ONE batch, and one request per selected row
   * means whichever lands first restores the whole batch: its sibling is then
   * refused (409) for an ancestor that IS in this selection. Retrying after the
   * others settle is what keeps the toast from reporting a failure for work
   * that is already done.
   */
  it('retries a refused bulk restore once the rest of the selection has settled', async () => {
    let restoreCalls = 0;
    const fetchSpy = mockApi(twoItemTrash, {
      restore: (pageId) => {
        restoreCalls += 1;
        // The parent is restored first and takes its sub-article with it, so
        // the sub-article's own (concurrent) request is refused once.
        const refused = pageId === '3' && restoreCalls === 1;
        if (refused) {
          return new Response(
            JSON.stringify({ error: 'Conflict', message: 'Restore "Deleted Article" first' }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ id: pageId, title: 'x', restored: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    render(<TrashPage />, { wrapper: createWrapper() });
    await screen.findByTestId('trash-list');

    fireEvent.click(screen.getByTestId('trash-select-all'));
    fireEvent.click(await screen.findByTestId('trash-bulk-restore-btn'));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Restored 2 pages');
    });
    expect(toast.error).not.toHaveBeenCalled();
    // One request per row plus the single retry.
    const restoreRequests = fetchSpy.mock.calls.filter(
      ([url, init]) => typeof url === 'string' && url.includes('/restore') && init?.method === 'POST',
    );
    expect(restoreRequests.length).toBe(3);
  });
});
