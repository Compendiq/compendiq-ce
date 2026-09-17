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
 * A -> B -> C, each trashed by a SEPARATE action: three distinct `deleted_at`
 * batches, so restoring the chain takes three separate restores and one
 * concurrent retry pass cannot clear it (#1636).
 */
const threeLevelTrash = {
  items: ['3', '4', '5'].map((id, depth) => ({
    id,
    title: `Level ${depth}`,
    source: 'standalone',
    visibility: 'private',
    deletedAt: new Date(Date.now() - (depth + 1) * DAY_MS).toISOString(),
    createdAt: new Date(Date.now() - 10 * DAY_MS).toISOString(),
    deletedBy: 'simon',
    autoPurgeAt: new Date(Date.now() + 29 * DAY_MS).toISOString(),
  })),
  total: 3,
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

/** The route's transient 409: the target's ancestor is still in the trash. */
function ancestorConflict(parentTitle: string): Response {
  return new Response(
    JSON.stringify({
      error: 'Conflict',
      message: `Restore "${parentTitle}" first`,
      reason: 'restore_ancestor_trashed',
    }),
    { status: 409, headers: { 'Content-Type': 'application/json' } },
  );
}

function restored(pageId: string): Response {
  return new Response(JSON.stringify({ id: pageId, title: 'x', restored: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/** One entry of a `fetch` spy's recorded calls. */
type FetchCall = [input: RequestInfo | URL, init?: RequestInit];

/** Every restore POST the component actually sent, in order. */
function restoreUrls(calls: readonly FetchCall[]): string[] {
  return calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([url]) => (typeof url === 'string' ? url : String(url)))
    .filter((url) => url.endsWith('/restore'));
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
            reason: 'restore_ancestor_trashed',
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
   * means whichever lands first restores the whole batch: the SUB-ARTICLE's own
   * request is then refused (409) for an ancestor that IS in this selection.
   * Retrying after the others settle is what keeps the toast from reporting a
   * failure for work that is already done.
   *
   * The refusal is keyed on the page id and that id's own attempt count, never
   * on a global call counter: `Array.from(selectedIds)` order is an internal
   * detail of the Set, and a counter-keyed fixture reds the build when that
   * order changes with no behaviour change at all. Refusing the PARENT — as
   * this fixture used to — also modelled the parent as its own blocked
   * descendant, which is not a state the route can produce.
   */
  it('retries the sub-article refused for an ancestor inside the same selection', async () => {
    const attempts = new Map<string, number>();
    const fetchSpy = mockApi(twoItemTrash, {
      restore: (pageId) => {
        const attempt = (attempts.get(pageId) ?? 0) + 1;
        attempts.set(pageId, attempt);
        // '4' is the sub-article; '3' is the parent whose restore takes the
        // whole batch — and therefore the sub-article — back with it.
        if (pageId === '4' && attempt === 1) return ancestorConflict('Deleted Article');
        return restored(pageId);
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
    // One request per row plus the sub-article's single retry — and the parent
    // is never re-asked, because it was never refused.
    expect(restoreUrls(fetchSpy.mock.calls)).toEqual([
      '/api/pages/3/restore',
      '/api/pages/4/restore',
      '/api/pages/4/restore',
    ]);
  });

  /**
   * #1636 — A -> B -> C, each trashed by a separate action, is three distinct
   * `deleted_at` batches and therefore three separate restores. ONE extra
   * concurrent pass cannot resolve that chain: pass 1 restores A while B and C
   * are both refused, and firing B and C together again lets C observe B still
   * trashed. The refused set is therefore re-asked in serialised passes for as
   * long as it keeps shrinking.
   */
  it('retries in passes, so a chain deeper than one level still resolves', async () => {
    const attempts = new Map<string, number>();
    const fetchSpy = mockApi(threeLevelTrash, {
      restore: (pageId) => {
        const attempt = (attempts.get(pageId) ?? 0) + 1;
        attempts.set(pageId, attempt);
        // '4' is live once its parent '3' is back: refused for one pass. '5' is
        // one level deeper and stays refused until '4' is back: two passes.
        if (pageId === '4' && attempt === 1) return ancestorConflict('Level 0');
        if (pageId === '5' && attempt <= 2) return ancestorConflict('Level 1');
        return restored(pageId);
      },
    });
    render(<TrashPage />, { wrapper: createWrapper() });
    await screen.findByTestId('trash-list');

    fireEvent.click(screen.getByTestId('trash-select-all'));
    fireEvent.click(await screen.findByTestId('trash-bulk-restore-btn'));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Restored 3 pages');
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(attempts.get('5')).toBe(3);
    // 3 + 2 + 1: every pass carries only the ids still refused.
    expect(restoreUrls(fetchSpy.mock.calls)).toHaveLength(6);
  });

  /**
   * An ancestor that is NOT in this selection is a genuine block, not a race —
   * no later pass can change it. So the loop stops the first time a pass fails
   * to shrink the refused set; without that, "retry while refused" is a retry
   * without end, and the user is told about a refusal the server has already
   * made final.
   */
  it('stops re-asking once a pass makes no progress', async () => {
    const attempts = new Map<string, number>();
    const fetchSpy = mockApi(mockTrashData, {
      restore: (pageId) => {
        attempts.set(pageId, (attempts.get(pageId) ?? 0) + 1);
        return ancestorConflict('Parent article');
      },
    });
    render(<TrashPage />, { wrapper: createWrapper() });
    await screen.findByTestId('trash-list');

    fireEvent.click(screen.getByTestId('trash-select-all'));
    fireEvent.click(await screen.findByTestId('trash-bulk-restore-btn'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to restore the page. Restore "Parent article" first',
      );
    });
    expect(restoreUrls(fetchSpy.mock.calls)).toEqual(['/api/pages/3/restore']);
  });

  /**
   * #1636 — a partial restore used to clear NOTHING from the selection: the
   * `setSelectedIds(new Set())` sat in the all-succeeded branch only. The rows
   * that did restore left the list (the mutation invalidates `['trash']`) but
   * stayed selected, so the bar kept a stale count, select-all's size
   * comparison went wrong, and pressing Restore Selected again re-POSTed
   * already-live ids — answered 200 `restored: false` — under a toast claiming
   * a fresh restore. The failed id stays selected on purpose: it is exactly
   * what a retry is for.
   */
  it('deselects the ids that restored and keeps the failure selected', async () => {
    const fetchSpy = mockApi(twoItemTrash, {
      restore: (pageId) =>
        pageId === '4'
          ? new Response(
              JSON.stringify({ error: 'Internal Server Error', message: 'Database unavailable' }),
              { status: 500, headers: { 'Content-Type': 'application/json' } },
            )
          : restored(pageId),
    });
    render(<TrashPage />, { wrapper: createWrapper() });
    await screen.findByTestId('trash-list');

    fireEvent.click(screen.getByTestId('trash-select-all'));
    fireEvent.click(await screen.findByTestId('trash-bulk-restore-btn'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Restored 1 of 2 pages. Database unavailable');
    });
    expect(screen.getByTestId('trash-bulk-count')).toHaveTextContent('1 page selected');

    // The second press can only address the failure: the restored id is out of
    // the selection, so it is never asked again.
    fireEvent.click(screen.getByTestId('trash-bulk-restore-btn'));

    await waitFor(() => {
      expect(restoreUrls(fetchSpy.mock.calls).filter((url) => url === '/api/pages/4/restore'))
        .toHaveLength(2);
    });
    expect(restoreUrls(fetchSpy.mock.calls).filter((url) => url === '/api/pages/3/restore'))
      .toHaveLength(1);
  });

  /**
   * The restore route answers 409 for two different reasons, and only ONE is
   * transient: the ancestor guard clears itself once the rest of the selection
   * has landed, while a live import of the same page is a permanent refusal.
   * Retrying on the status alone re-fires a request the server has already
   * decided — and reports the same refusal twice.
   */
  it('does not retry the route\u2019s other 409 — a permanent refusal', async () => {
    let restoreCalls = 0;
    mockApi(mockTrashData, {
      restore: () => {
        restoreCalls += 1;
        return new Response(
          JSON.stringify({ error: 'Conflict', message: 'A live import of this page already exists' }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    render(<TrashPage />, { wrapper: createWrapper() });
    await screen.findByTestId('trash-list');

    fireEvent.click(screen.getByTestId('trash-select-all'));
    fireEvent.click(await screen.findByTestId('trash-bulk-restore-btn'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to restore the page. A live import of this page already exists',
      );
    });
    expect(restoreCalls).toBe(1);
  });
});
