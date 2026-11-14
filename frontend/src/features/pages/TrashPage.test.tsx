import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { toast } from 'sonner';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TrashPage } from './TrashPage';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

function createWrapper(queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})) {
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
      spaceKey: 'NOTES',
      spaceMissing: false,
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
      spaceKey: 'NOTES',
      spaceMissing: false,
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
      spaceKey: 'NOTES',
      spaceMissing: false,
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
    spaceKey: 'NOTES',
    spaceMissing: false,
    deletedAt: new Date(Date.now() - (depth + 1) * DAY_MS).toISOString(),
    createdAt: new Date(Date.now() - 10 * DAY_MS).toISOString(),
    deletedBy: 'simon',
    autoPurgeAt: new Date(Date.now() + 29 * DAY_MS).toISOString(),
  })),
  total: 3,
};

/**
 * Mocks fetch at the network boundary, answering only the real backend
 * endpoints: GET /api/pages/trash, GET /api/spaces/local, and restore POSTs.
 * Everything else (e.g. the old /api/trash path) gets a 404.
 *
 * `restore` overrides the POST answer per page id, so a test can exercise a
 * server refusal (the #1636 409) without inventing a second HTTP layer.
 */
function mockApi(
  trashData: unknown,
  options: {
    restore?: (pageId: string, init?: RequestInit) => Response | Promise<Response>;
    localSpaces?: () => Response | Promise<Response>;
  } = {},
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';

    if (url === '/api/pages/trash' && method === 'GET') {
      const data = typeof trashData === 'function' ? await trashData() : trashData;
      return data instanceof Response ? data : jsonResponse(data);
    }
    if (url === '/api/spaces/local' && method === 'GET') {
      return options.localSpaces ? options.localSpaces() : jsonResponse(localSpaceChoices);
    }
    const restoreMatch = url.match(/^\/api\/pages\/([^/]+)\/restore$/);
    if (restoreMatch && method === 'POST') {
      if (options.restore) return options.restore(restoreMatch[1]!, init);
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

const missingSpaceMessage = 'The space "GONE" no longer exists. Choose a space to restore into.';
const invalidTargetMessage = 'The selected restore space is unavailable. Choose an existing local space.';

const localSpaceChoices = [
  {
    key: 'TARGET',
    name: 'Team Notes',
    description: null,
    icon: null,
    pageCount: 0,
    createdBy: 'owner',
    createdAt: '2026-01-01T00:00:00Z',
    source: 'local',
  },
  {
    key: 'OTHER',
    name: 'Other Notes',
    description: null,
    icon: null,
    pageCount: 0,
    createdBy: 'owner',
    createdAt: '2026-01-01T00:00:00Z',
    source: 'local',
  },
];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function missingSpaceResponse(key = 'GONE'): Response {
  return jsonResponse({
    statusCode: 409,
    error: 'Conflict',
    reason: 'restore_space_missing',
    message: `The space "${key}" no longer exists. Choose a space to restore into.`,
    missingSpaceKey: key,
    canChooseTarget: true,
  }, 409);
}

function invalidTargetResponse(): Response {
  return jsonResponse({
    statusCode: 409,
    error: 'Conflict',
    reason: 'restore_target_space_invalid',
    message: invalidTargetMessage,
  }, 409);
}

function missingTrash(spaceMissing = true) {
  return {
    items: mockTrashData.items.map((item) => ({
      ...item,
      spaceKey: 'GONE',
      spaceMissing,
    })),
    total: mockTrashData.total,
  };
}

function selectedTargetKey(init?: RequestInit): string | undefined {
  if (typeof init?.body !== 'string') return undefined;
  try {
    const body: unknown = JSON.parse(init.body);
    if (body && typeof body === 'object' && !Array.isArray(body)
      && 'targetSpaceKey' in body && typeof body.targetSpaceKey === 'string') {
      return body.targetSpaceKey;
    }
  } catch {
    // An invalid request must stay refused, not turn into a fixture exception.
  }
  return undefined;
}

function restoreRequests(calls: readonly FetchCall[]): FetchCall[] {
  return calls.filter(([url, init]) =>
    init?.method === 'POST' && typeof url === 'string'
    && /^\/api\/pages\/[^/]+\/restore$/.test(url));
}

async function openRestoreDialog(pageId = '3') {
  const restore = await screen.findByTestId(`restore-btn-${pageId}`);
  restore.focus();
  await act(async () => {
    fireEvent.click(restore);
  });
  // The original component settles the real refusal but has no remedy dialog.
  return screen.getByRole('dialog');
}

describe('TrashPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows pending without claiming the trash is empty', () => {
    const { promise } = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, 'fetch').mockReturnValue(promise);
    render(<TrashPage />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('trash-empty')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('keeps the initial error and keyboard focus during retry, then shows the successful empty state', async () => {
    const { promise, resolve: resolveRetry } = Promise.withResolvers<Response>();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockReturnValueOnce(promise);
    render(<TrashPage />, { wrapper: createWrapper() });
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByTestId('trash-empty')).not.toBeInTheDocument();
    retry.focus();
    fireEvent.click(retry);
    expect(screen.getByRole('button', { name: 'Retrying…' })).toHaveFocus();
    expect(screen.queryByTestId('trash-empty')).not.toBeInTheDocument();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    resolveRetry(new Response(JSON.stringify({ items: [], total: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(await screen.findByTestId('trash-empty')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/automatically purged/)).toHaveFocus());
  });

  it('retains cached rows and labels them stale after a failed refresh', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(mockTrashData), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValue(new Response('{}', { status: 500 }));
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter><TrashPage /></MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText('Deleted Article');
    await client.invalidateQueries();
    expect(await screen.findByText(/Showing the last loaded results/)).toBeInTheDocument();
    expect(screen.getByText('Deleted Article')).toBeInTheDocument();
    expect(screen.queryByTestId('trash-empty')).not.toBeInTheDocument();
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

  describe('#1742 rehome regressions', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('[R01] offers the current server-authorized remedy despite a stale nonmissing hint', async () => {
      const fetchSpy = mockApi(missingTrash(false), { restore: () => missingSpaceResponse() });
      render(<TrashPage />, { wrapper: createWrapper() });

      const dialog = await openRestoreDialog();
      expect(dialog).toHaveAccessibleName(/restore/i);
      expect(within(dialog).getByText(missingSpaceMessage, { exact: true })).toBeVisible();
      expect(dialog).toHaveAccessibleDescription(/The space "GONE" no longer exists/);
      const select = within(dialog).getByRole('combobox', { name: /local space/i });
      await waitFor(() => expect(select).toHaveFocus());
      expect(select).toHaveValue('');
      expect(within(select).getByRole('option', { name: /no space/i })).toHaveValue('__local__');
      expect(screen.getByTestId('trash-item-3')).toBeInTheDocument();
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(1);
      expect(restoreRequests(fetchSpy.mock.calls)[0]![1]?.body).toBeUndefined();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('[R02] restores only after an explicit local choice and deliberate retry', async () => {
      let remaining = missingTrash();
      const fetchSpy = mockApi(() => remaining, {
        localSpaces: () => jsonResponse([
          ...localSpaceChoices,
          { ...localSpaceChoices[0]!, key: 'CONF', name: 'Confluence', source: 'confluence' },
        ]),
        restore: (pageId, init) => {
          if (pageId === '3' && selectedTargetKey(init) === 'TARGET') {
            remaining = { items: [], total: 0 };
            return restored(pageId);
          }
          return missingSpaceResponse();
        },
      });
      render(<TrashPage />, { wrapper: createWrapper() });

      const dialog = await openRestoreDialog();
      const select = within(dialog).getByRole('combobox', { name: /local space/i });
      expect(await within(select).findByRole('option', { name: /Team Notes.*TARGET/ })).toBeVisible();
      expect(within(select).queryByRole('option', { name: /Confluence/ })).not.toBeInTheDocument();
      expect(select).toHaveValue('');
      expect(restoreRequests(fetchSpy.mock.calls)[0]![1]?.body).toBeUndefined();
      fireEvent.change(select, { target: { value: 'TARGET' } });
      expect(screen.getByTestId('trash-item-3')).toBeInTheDocument();
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(1);
      expect(toast.success).not.toHaveBeenCalled();

      const retry = within(dialog).getByRole('button', { name: /retry restore/i });
      retry.focus();
      await act(async () => {
        fireEvent.click(retry);
      });
      expect(await screen.findByTestId('trash-empty')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByTestId('trash-item-3')).not.toBeInTheDocument();
      expect(toast.success).toHaveBeenCalledWith('Page restored');
      const requests = restoreRequests(fetchSpy.mock.calls);
      expect(requests).toHaveLength(2);
      expect(requests[1]![0]).toBe('/api/pages/3/restore');
      expect(selectedTargetKey(requests[1]![1])).toBe('TARGET');
    });

    it('[R03] restores into explicitly chosen no-space when the local list is empty', async () => {
      let remaining = missingTrash();
      const fetchSpy = mockApi(() => remaining, {
        localSpaces: () => jsonResponse([]),
        restore: (pageId, init) => {
          if (pageId === '3' && selectedTargetKey(init) === '__local__') {
            remaining = { items: [], total: 0 };
            return restored(pageId);
          }
          return missingSpaceResponse();
        },
      });
      render(<TrashPage />, { wrapper: createWrapper() });

      const dialog = await openRestoreDialog();
      const select = within(dialog).getByRole('combobox', { name: /local space/i });
      const noSpace = within(select).getByRole('option', { name: /no space/i });
      expect(noSpace).toHaveValue('__local__');
      expect(select).toHaveValue('');
      fireEvent.change(select, { target: { value: '__local__' } });
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(1);
      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: /retry restore/i }));
      });

      expect(await screen.findByTestId('trash-empty')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(toast.success).toHaveBeenCalledWith('Page restored');
      expect(selectedTargetKey(restoreRequests(fetchSpy.mock.calls)[1]![1])).toBe('__local__');
    });

    it('[R04] keeps an invalid target refusal actionable without replaying the rejected choice', async () => {
      let remaining = missingTrash();
      let targetDeleted = false;
      const fetchSpy = mockApi(() => remaining, {
        localSpaces: () => jsonResponse(
          targetDeleted ? [localSpaceChoices[1]!] : localSpaceChoices,
        ),
        restore: (pageId, init) => {
          if (pageId !== '3') return jsonResponse({ message: 'Not found' }, 404);
          const target = selectedTargetKey(init);
          if (target === 'TARGET') return invalidTargetResponse();
          if (target === 'OTHER') {
            remaining = { items: [], total: 0 };
            return restored(pageId);
          }
          return missingSpaceResponse();
        },
      });
      render(<TrashPage />, { wrapper: createWrapper() });

      const dialog = await openRestoreDialog();
      const select = within(dialog).getByRole('combobox', { name: /local space/i });
      await within(select).findByRole('option', { name: /Team Notes.*TARGET/ });
      fireEvent.change(select, { target: { value: 'TARGET' } });
      targetDeleted = true;
      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: /retry restore/i }));
      });

      expect(within(dialog).getByText(invalidTargetMessage, { exact: true })).toBeVisible();
      expect(screen.getByRole('dialog')).toBe(dialog);
      expect(screen.getByTestId('trash-item-3')).toBeInTheDocument();
      expect(select).toHaveValue('');
      await waitFor(() => {
        expect(within(select).queryByRole('option', { name: /Team Notes.*TARGET/ }))
          .not.toBeInTheDocument();
      });
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(2);
      fireEvent.change(select, { target: { value: 'OTHER' } });
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(2);
      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: /retry restore/i }));
      });
      expect(await screen.findByTestId('trash-empty')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(toast.success).toHaveBeenCalledWith('Page restored');
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(3);
    });

    it('[R05] exposes unresolved local choices without claiming an empty list or submitting', async () => {
      const localRead = Promise.withResolvers<Response>();
      const fetchSpy = mockApi(missingTrash(), {
        restore: () => missingSpaceResponse(),
        localSpaces: () => localRead.promise,
      });
      render(<TrashPage />, { wrapper: createWrapper() });

      const dialog = await openRestoreDialog();
      expect(within(dialog).getByRole('status')).toHaveTextContent(/load.*space/i);
      expect(within(dialog).queryByText(/no local spaces/i)).not.toBeInTheDocument();
      const select = within(dialog).getByRole('combobox', { name: /local space/i });
      expect(within(select).getByRole('option', { name: /no space/i })).toHaveValue('__local__');
      fireEvent.change(select, { target: { value: '__local__' } });
      await act(async () => {
        localRead.resolve(jsonResponse(localSpaceChoices));
      });
      await within(select).findByRole('option', { name: /Team Notes.*TARGET/ });
      expect(select).toHaveValue('__local__');
      expect(screen.getByTestId('trash-item-3')).toBeInTheDocument();
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(1);
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('[R06] retains the failed local-list Retry and focus until its read recovers', async () => {
      const localRetry = Promise.withResolvers<Response>();
      let localReads = 0;
      const fetchSpy = mockApi(missingTrash(), {
        restore: () => missingSpaceResponse(),
        localSpaces: () => {
          localReads += 1;
          return localReads === 1
            ? jsonResponse({ message: 'Local space list unavailable' }, 500)
            : localRetry.promise;
        },
      });
      render(<TrashPage />, { wrapper: createWrapper() });

      const dialog = await openRestoreDialog();
      const retry = await within(dialog).findByRole('button', { name: /^retry$/i });
      expect(retry.closest('[role="status"], [role="alert"]')).not.toBeNull();
      expect(within(dialog).queryByText(/no local spaces/i)).not.toBeInTheDocument();
      retry.focus();
      await act(async () => {
        fireEvent.click(retry);
        fireEvent.click(retry);
      });
      expect(within(dialog).getByRole('button', { name: /retrying/i })).toBe(retry);
      expect(retry).toHaveFocus();
      expect(retry).toHaveAttribute('aria-disabled', 'true');
      expect(retry).not.toHaveAttribute('disabled');
      expect(retry.tabIndex).toBeGreaterThanOrEqual(0);
      expect(localReads).toBe(2);
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(1);
      await act(async () => {
        localRetry.resolve(jsonResponse(localSpaceChoices));
      });
      await within(dialog).findByRole('option', { name: /Team Notes.*TARGET/ });
      await waitFor(() => expect(retry).not.toBeInTheDocument());
      await waitFor(() => {
        expect(dialog).toContainElement(document.activeElement as HTMLElement);
        expect(document.activeElement).toHaveAttribute('tabindex', '-1');
        expect(document.activeElement).toHaveTextContent(/\S/);
      });
      expect(screen.getByTestId('trash-item-3')).toBeInTheDocument();
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(1);
    });

    it('[R07] preserves cached local choices and an unsent selection during failed refetch', async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const localRetry = Promise.withResolvers<Response>();
      let localReads = 0;
      const fetchSpy = mockApi(missingTrash(), {
        restore: () => missingSpaceResponse(),
        localSpaces: () => {
          localReads += 1;
          if (localReads === 1) return jsonResponse(localSpaceChoices);
          if (localReads === 2) return jsonResponse({ message: 'Local spaces unavailable' }, 500);
          return localRetry.promise;
        },
      });
      render(<TrashPage />, { wrapper: createWrapper(client) });

      const dialog = await openRestoreDialog();
      const select = within(dialog).getByRole('combobox', { name: /local space/i });
      await within(select).findByRole('option', { name: /Team Notes.*TARGET/ });
      fireEvent.change(select, { target: { value: 'TARGET' } });
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['local-spaces'] });
      });
      const retry = await within(dialog).findByRole('button', { name: /^retry$/i });
      expect(retry.closest('[role="status"], [role="alert"]'))
        .toHaveTextContent(/refresh|stale|last loaded|out of date/i);
      expect(within(select).getByRole('option', { name: /Team Notes.*TARGET/ })).toBeVisible();
      expect(select).toHaveValue('TARGET');
      retry.focus();
      await act(async () => {
        fireEvent.click(retry);
      });
      expect(within(dialog).getByRole('button', { name: /retrying/i })).toBe(retry);
      expect(retry).toHaveFocus();
      expect(retry).not.toHaveAttribute('disabled');
      expect(retry).toHaveAttribute('aria-disabled', 'true');
      await act(async () => {
        localRetry.resolve(jsonResponse(localSpaceChoices));
      });
      await waitFor(() => expect(retry).not.toBeInTheDocument());
      expect(select).toHaveValue('TARGET');
      await waitFor(() => {
        expect(dialog).toContainElement(document.activeElement as HTMLElement);
        expect(document.activeElement).toHaveAttribute('tabindex', '-1');
      });
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(1);
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('[R08] dismisses the remedy with Escape and restores its invoking row focus', async () => {
      const fetchSpy = mockApi(missingTrash(), { restore: () => missingSpaceResponse() });
      render(<TrashPage />, { wrapper: createWrapper() });

      const dialog = await openRestoreDialog();
      const origin = screen.getByTestId('restore-btn-3');
      const select = within(dialog).getByRole('combobox', { name: /local space/i });
      await within(select).findByRole('option', { name: /Team Notes.*TARGET/ });
      fireEvent.change(select, { target: { value: 'TARGET' } });
      await act(async () => {
        fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
      });
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      await waitFor(() => expect(origin).toHaveFocus());
      expect(screen.getByTestId('trash-item-3')).toBeInTheDocument();
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(1);

      const reopened = await openRestoreDialog();
      expect(within(reopened).getByRole('combobox', { name: /local space/i })).toHaveValue('');
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(2);
    });

    it('[R09] cancels without submitting and does not leak a target into another page remedy', async () => {
      const data = {
        items: twoItemTrash.items.map((item) => ({
          ...item,
          spaceKey: item.id === '3' ? 'GONE' : 'SECOND_GONE',
          spaceMissing: true,
        })),
        total: 2,
      };
      const fetchSpy = mockApi(data, {
        restore: (pageId) => missingSpaceResponse(pageId === '3' ? 'GONE' : 'SECOND_GONE'),
      });
      render(<TrashPage />, { wrapper: createWrapper() });

      const first = await openRestoreDialog();
      const select = within(first).getByRole('combobox', { name: /local space/i });
      await within(select).findByRole('option', { name: /Team Notes.*TARGET/ });
      fireEvent.change(select, { target: { value: 'TARGET' } });
      await act(async () => {
        fireEvent.click(within(first).getByRole('button', { name: /^cancel$/i }));
      });
      await waitFor(() => expect(first).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByTestId('restore-btn-3')).toHaveFocus());
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(1);

      const second = await openRestoreDialog('4');
      expect(second).toHaveTextContent('Sub-article');
      expect(within(second).getByText(
        'The space "SECOND_GONE" no longer exists. Choose a space to restore into.',
        { exact: true },
      )).toBeVisible();
      expect(within(second).getByRole('combobox', { name: /local space/i })).toHaveValue('');
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(2);
      expect(restoreRequests(fetchSpy.mock.calls).every(([, init]) => init?.body === undefined))
        .toBe(true);
    });

    it('[R10] recovers focus when the dialog closes before the refreshed batch rows disappear', async () => {
      const batch = {
        items: twoItemTrash.items.map((item) => ({ ...item, spaceKey: 'GONE', spaceMissing: true })),
        total: 2,
      };
      const refresh = Promise.withResolvers<Response>();
      let targetRestored = false;
      mockApi(() => targetRestored ? refresh.promise : batch, {
        restore: (pageId, init) => {
          if (pageId === '3' && selectedTargetKey(init) === 'TARGET') {
            targetRestored = true;
            return restored(pageId);
          }
          return missingSpaceResponse();
        },
      });
      render(<TrashPage />, { wrapper: createWrapper() });

      const dialog = await openRestoreDialog();
      const select = within(dialog).getByRole('combobox', { name: /local space/i });
      await within(select).findByRole('option', { name: /Team Notes.*TARGET/ });
      fireEvent.change(select, { target: { value: 'TARGET' } });
      const retry = within(dialog).getByRole('button', { name: /retry restore/i });
      retry.focus();
      await act(async () => {
        fireEvent.click(retry);
      });
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      expect(screen.getByTestId('trash-item-3')).toBeInTheDocument();
      expect(screen.getByTestId('trash-item-4')).toBeInTheDocument();
      await act(async () => {
        refresh.resolve(jsonResponse({ items: [], total: 0 }));
      });
      expect(await screen.findByTestId('trash-empty')).toBeInTheDocument();
      expect(screen.queryByTestId('trash-item-3')).not.toBeInTheDocument();
      expect(screen.queryByTestId('trash-item-4')).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByText(/automatically purged/)).toHaveFocus());
    });

    it('[R11] rehomes orphaned focus after an ordinary restored last row disappears', async () => {
      const restoreReply = Promise.withResolvers<Response>();
      const refresh = Promise.withResolvers<Response>();
      let restoreLanded = false;
      const fetchSpy = mockApi(() => restoreLanded ? refresh.promise : mockTrashData, {
        restore: async () => {
          const response = await restoreReply.promise;
          restoreLanded = true;
          return response;
        },
      });
      render(<TrashPage />, { wrapper: createWrapper() });
      const origin = await screen.findByTestId('restore-btn-3');
      origin.focus();
      await act(async () => {
        fireEvent.click(origin);
      });
      await act(async () => {
        restoreReply.resolve(restored('3'));
      });
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Page restored'));
      expect(screen.getByTestId('trash-item-3')).toBeInTheDocument();
      await act(async () => {
        refresh.resolve(jsonResponse({ items: [], total: 0 }));
      });
      await screen.findByTestId('trash-empty');
      expect(screen.queryByTestId('trash-item-3')).not.toBeInTheDocument();
      expect(screen.getByText(/automatically purged/)).toHaveFocus();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(restoreRequests(fetchSpy.mock.calls)[0]![1]?.body).toBeUndefined();
    });

    it('[R12] keeps the explicit retry mounted and focusable while refusing duplicate activation', async () => {
      const targetReply = Promise.withResolvers<Response>();
      const fetchSpy = mockApi(missingTrash(), {
        restore: (pageId, init) =>
          pageId === '3' && selectedTargetKey(init) === 'TARGET'
            ? targetReply.promise
            : missingSpaceResponse(),
      });
      render(<TrashPage />, { wrapper: createWrapper() });

      const dialog = await openRestoreDialog();
      const select = within(dialog).getByRole('combobox', { name: /local space/i });
      await within(select).findByRole('option', { name: /Team Notes.*TARGET/ });
      fireEvent.change(select, { target: { value: 'TARGET' } });
      const submit = within(dialog).getByRole('button', { name: /retry restore/i });
      submit.focus();
      await act(async () => {
        fireEvent.click(submit);
      });
      expect(submit).toBeInTheDocument();
      expect(submit).toHaveFocus();
      expect(submit).toHaveAttribute('aria-busy', 'true');
      expect(submit).toHaveAttribute('aria-disabled', 'true');
      expect(submit).not.toHaveAttribute('disabled');
      expect(submit.tabIndex).toBeGreaterThanOrEqual(0);
      expect(within(dialog).getByRole('status')).toHaveTextContent(/restor/i);
      await act(async () => {
        fireEvent.keyDown(submit, { key: 'Enter', code: 'Enter' });
        fireEvent.click(submit);
        fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
        fireEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
      });
      expect(screen.getByRole('dialog')).toBe(dialog);
      expect(submit).toBeInTheDocument();
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(2);
      await act(async () => {
        targetReply.resolve(invalidTargetResponse());
      });
      expect(await within(dialog).findByText(invalidTargetMessage, { exact: true })).toBeVisible();
      expect(select).toHaveValue('');
      const idleRetry = within(dialog).getByRole('button', { name: /retry restore/i });
      idleRetry.focus();
      expect(idleRetry).toHaveFocus();
      expect(idleRetry).not.toHaveAttribute('disabled');
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(2);
      expect(screen.getByTestId('trash-item-3')).toBeInTheDocument();
    });
  });

  describe('#1742 preservation controls', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('[C19] reports bulk missing-space as permanent without opening a picker or replaying', async () => {
      const fetchSpy = mockApi(missingTrash(), { restore: () => missingSpaceResponse() });
      render(<TrashPage />, { wrapper: createWrapper() });
      await screen.findByTestId('trash-list');
      fireEvent.click(screen.getByTestId('trash-select-all'));
      fireEvent.click(screen.getByTestId('trash-bulk-restore-btn'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(`Failed to restore the page. ${missingSpaceMessage}`);
      });
      expect(screen.getByTestId('trash-item-3')).toBeInTheDocument();
      expect(screen.getByTestId('trash-bulk-count')).toHaveTextContent('1 page selected');
      await waitFor(() => expect(screen.getByTestId('trash-bulk-restore-btn')).not.toBeDisabled());
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(restoreUrls(fetchSpy.mock.calls)).toEqual(['/api/pages/3/restore']);
    });

    it('[C20] replays only ancestors in a mixed partial bulk restore and prunes successes', async () => {
      const data = {
        items: threeLevelTrash.items.map((item) => ({
          ...item,
          spaceKey: item.id === '5' ? 'GONE' : 'NOTES',
          spaceMissing: item.id === '5',
        })),
        total: 3,
      };
      const remaining = new Set(['3', '4', '5']);
      const attempts = new Map<string, number>();
      const fetchSpy = mockApi(() => ({
        items: data.items.filter((item) => remaining.has(item.id)),
        total: remaining.size,
      }), {
        restore: (pageId) => {
          const attempt = (attempts.get(pageId) ?? 0) + 1;
          attempts.set(pageId, attempt);
          if (pageId === '5') return missingSpaceResponse();
          if (pageId === '4' && attempt === 1) return ancestorConflict('Level 0');
          remaining.delete(pageId);
          return restored(pageId);
        },
      });
      render(<TrashPage />, { wrapper: createWrapper() });
      await screen.findByTestId('trash-list');
      fireEvent.click(screen.getByTestId('trash-select-all'));
      fireEvent.click(screen.getByTestId('trash-bulk-restore-btn'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(`Restored 2 of 3 pages. ${missingSpaceMessage}`);
      });
      await waitFor(() => {
        expect(screen.queryByTestId('trash-item-3')).not.toBeInTheDocument();
        expect(screen.queryByTestId('trash-item-4')).not.toBeInTheDocument();
      });
      expect(screen.getByTestId('trash-item-5')).toBeInTheDocument();
      expect(screen.getByTestId('trash-bulk-count')).toHaveTextContent('1 page selected');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(restoreUrls(fetchSpy.mock.calls).filter((url) => url === '/api/pages/5/restore'))
        .toHaveLength(1);
      expect(attempts.get('3')).toBe(1);
      expect(attempts.get('4')).toBe(2);
      expect(toast.success).not.toHaveBeenCalled();
    });

    it.each([
      { id: 'C21', label: 'an existing local space', spaceKey: 'NOTES' },
      { id: 'C22', label: 'null no-space', spaceKey: null },
      { id: 'C23', label: 'the virtual local sentinel', spaceKey: '__local__' },
    ])('[$id] preserves bodyless ordinary restore for $label', async ({ spaceKey }) => {
      let remaining = {
        items: mockTrashData.items.map((item) => ({ ...item, spaceKey, spaceMissing: false })),
        total: 1,
      };
      const fetchSpy = mockApi(() => remaining, {
        restore: (pageId) => {
          remaining = { items: [], total: 0 };
          return restored(pageId);
        },
      });
      render(<TrashPage />, { wrapper: createWrapper() });
      const restore = await screen.findByTestId('restore-btn-3');
      await act(async () => {
        fireEvent.click(restore);
      });

      expect(await screen.findByTestId('trash-empty')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(toast.success).toHaveBeenCalledWith('Page restored');
      const requests = restoreRequests(fetchSpy.mock.calls);
      expect(requests).toHaveLength(1);
      expect(requests[0]![0]).toBe('/api/pages/3/restore');
      expect(requests[0]![1]?.body).toBeUndefined();
    });

    it.each([
      {
        id: 'C24',
        reason: 'restore_target_not_applicable',
        status: 400,
        message: 'A restore target can only be chosen when the stored space no longer exists.',
      },
      {
        id: 'C25',
        reason: 'restore_import_conflict',
        status: 409,
        message: 'A live import of this page already exists',
      },
      {
        id: 'C26',
        reason: 'restore_parent_ambiguous',
        status: 409,
        message: 'The parent identifier is ambiguous',
      },
      {
        id: 'C27',
        reason: 'subtree_identifier_ambiguous',
        status: 409,
        message: 'A subtree identifier is ambiguous',
      },
    ])('[$id] preserves ordinary message handling for $reason', async ({ reason, status, message }) => {
      const fetchSpy = mockApi(mockTrashData, {
        restore: () => jsonResponse({
          statusCode: status,
          error: status === 400 ? 'ValidationError' : 'Conflict',
          reason,
          message,
        }, status),
      });
      render(<TrashPage />, { wrapper: createWrapper() });
      await screen.findByTestId('trash-list');
      fireEvent.click(screen.getByRole('button', { name: 'Select Deleted Article' }));
      await act(async () => {
        fireEvent.click(screen.getByTestId('restore-btn-3'));
      });

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
      expect(screen.getByTestId('trash-item-3')).toBeInTheDocument();
      expect(screen.getByTestId('trash-bulk-count')).toHaveTextContent('1 page selected');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(restoreUrls(fetchSpy.mock.calls)).toEqual(['/api/pages/3/restore']);
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('[C28] never steals search focus when another restored row disappears', async () => {
      const restoreReply = Promise.withResolvers<Response>();
      let remaining = twoItemTrash;
      const fetchSpy = mockApi(() => remaining, {
        restore: async (pageId) => {
          const response = await restoreReply.promise;
          remaining = {
            items: remaining.items.filter((item) => item.id !== pageId),
            total: 1,
          };
          return response;
        },
      });
      render(<TrashPage />, { wrapper: createWrapper() });
      const origin = await screen.findByTestId('restore-btn-3');
      origin.focus();
      await act(async () => {
        fireEvent.click(origin);
      });
      const search = screen.getByTestId('trash-search-input');
      search.focus();
      await act(async () => {
        restoreReply.resolve(restored('3'));
      });

      await waitFor(() => expect(screen.queryByTestId('trash-item-3')).not.toBeInTheDocument());
      expect(screen.getByTestId('trash-item-4')).toBeInTheDocument();
      expect(search).toHaveFocus();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(restoreRequests(fetchSpy.mock.calls)[0]![1]?.body).toBeUndefined();
    });

    it('[C29] retains authoritative cached empty state and mounted Retry during refetch failure', async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const retryReply = Promise.withResolvers<Response>();
      let reads = 0;
      mockApi(() => {
        reads += 1;
        if (reads === 1) return { items: [], total: 0 };
        if (reads === 2) return jsonResponse({ message: 'Trash unavailable' }, 500);
        return retryReply.promise;
      });
      render(<TrashPage />, { wrapper: createWrapper(client) });
      await screen.findByTestId('trash-empty');
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['trash'] });
      });
      const retry = await screen.findByRole('button', { name: 'Retry' });
      expect(screen.getByTestId('trash-empty')).toBeInTheDocument();
      expect(screen.getByText(/Showing the last loaded results/)).toBeVisible();
      expect(screen.queryByText('Could not load trash. Please try again.')).not.toBeInTheDocument();
      retry.focus();
      await act(async () => {
        fireEvent.click(retry);
      });
      expect(screen.getByRole('button', { name: 'Retrying…' })).toBe(retry);
      expect(retry).toHaveFocus();
      expect(retry).toHaveAttribute('aria-disabled', 'true');
      expect(retry).not.toHaveAttribute('disabled');
      expect(screen.getByTestId('trash-empty')).toBeInTheDocument();
      await act(async () => {
        retryReply.resolve(jsonResponse({ items: [], total: 0 }));
      });
      await waitFor(() => expect(retry).not.toBeInTheDocument());
      expect(screen.getByTestId('trash-empty')).toBeInTheDocument();
      await waitFor(() => expect(screen.getByText(/automatically purged/)).toHaveFocus());
      expect(reads).toBe(3);
    });
  });

  // Post-delta controls: these were held out of the accepted original-code baseline.
  describe('#1742 post-delta feature controls', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    function secondaryMissingSpaceResponse(missingSpaceKey: string, canChooseTarget: unknown) {
      return jsonResponse({
        statusCode: 409,
        error: 'Conflict',
        reason: 'restore_space_missing',
        message: canChooseTarget === false
          ? `The space "${missingSpaceKey}" for another page in this trash batch no longer exists. This batch cannot be restored by choosing a target for this page.`
          : `The space "${missingSpaceKey}" no longer exists. Choose a space to restore into.`,
        missingSpaceKey,
        canChooseTarget,
      }, 409);
    }

    async function expectInitialSecondaryRefusal(canChooseTarget: unknown) {
      const message = canChooseTarget === false
        ? 'The space "RETAINED" for another page in this trash batch no longer exists. This batch cannot be restored by choosing a target for this page.'
        : 'The space "RETAINED" no longer exists. Choose a space to restore into.';
      const fetchSpy = mockApi(missingTrash(), {
        restore: () => secondaryMissingSpaceResponse('RETAINED', canChooseTarget),
      });
      render(<TrashPage />, { wrapper: createWrapper() });
      fireEvent.click(await screen.findByTestId('trash-checkbox-3'));
      const origin = screen.getByTestId('restore-btn-3');
      origin.focus();
      await act(async () => { fireEvent.click(origin); });

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByTestId('trash-item-3')).toBeInTheDocument();
      expect(screen.getByTestId('trash-bulk-count')).toHaveTextContent('1 page selected');
      expect(origin).toHaveFocus();
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(1);
      expect(restoreRequests(fetchSpy.mock.calls)[0]![1]?.body).toBeUndefined();
      expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/spaces/local'))).toBe(false);
      expect(toast.success).not.toHaveBeenCalled();
    }

    async function expectSelectedSecondaryCloses(missingSpaceKey: string, canChooseTarget: unknown) {
      const message = canChooseTarget === false
        ? `The space "${missingSpaceKey}" for another page in this trash batch no longer exists. This batch cannot be restored by choosing a target for this page.`
        : `The space "${missingSpaceKey}" no longer exists. Choose a space to restore into.`;
      const fetchSpy = mockApi(missingTrash(), {
        restore: (_pageId, init) => selectedTargetKey(init) === 'TARGET'
          ? secondaryMissingSpaceResponse(missingSpaceKey, canChooseTarget)
          : missingSpaceResponse(),
      });
      render(<TrashPage />, { wrapper: createWrapper() });
      fireEvent.click(await screen.findByTestId('trash-checkbox-3'));
      const dialog = await openRestoreDialog();
      const select = within(dialog).getByRole('combobox', { name: /local space/i });
      await within(select).findByRole('option', { name: /Team Notes.*TARGET/ });
      fireEvent.change(select, { target: { value: 'TARGET' } });
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(1);
      const retry = within(dialog).getByRole('button', { name: /retry restore/i });
      retry.focus();
      await act(async () => { fireEvent.click(retry); });

      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(toast.error).toHaveBeenCalledWith(message);
      expect(screen.queryByText(missingSpaceMessage, { exact: true })).not.toBeInTheDocument();
      expect(screen.getByTestId('trash-item-3')).toBeInTheDocument();
      expect(screen.getByTestId('trash-bulk-count')).toHaveTextContent('1 page selected');
      await waitFor(() => expect(screen.getByTestId('restore-btn-3')).toHaveFocus());
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(2);
      expect(selectedTargetKey(restoreRequests(fetchSpy.mock.calls)[1]![1])).toBe('TARGET');
      expect(toast.success).not.toHaveBeenCalled();
    }

    it('[F01a] refuses an initial secondary missing space despite a misleading cached root hint', async () => {
      await expectInitialSecondaryRefusal(false);
    });

    it('[F01b] closes an open remedy on a current false discriminator for a different retained key', async () => {
      await expectSelectedSecondaryCloses('RETAINED', false);
    });

    it('[F01c] closes an open remedy even when the false response names its former root key', async () => {
      await expectSelectedSecondaryCloses('GONE', false);
    });

    it('[F01d] accepts a fresh explicit true refusal without trusting the cached key or missing hint', async () => {
      const message = 'The space "CURRENT_MISSING" no longer exists. Choose a space to restore into.';
      const fetchSpy = mockApi(missingTrash(false), {
        restore: () => missingSpaceResponse('CURRENT_MISSING'),
      });
      render(<TrashPage />, { wrapper: createWrapper() });

      const dialog = await openRestoreDialog();
      expect(within(dialog).getByText(message, { exact: true })).toBeVisible();
      const select = within(dialog).getByRole('combobox', { name: /local space/i });
      expect(select).toHaveValue('');
      await waitFor(() => expect(select).toHaveFocus());
      expect(screen.getByTestId('trash-item-3')).toBeInTheDocument();
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(1);
      expect(restoreRequests(fetchSpy.mock.calls)[0]![1]?.body).toBeUndefined();
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('[F01e] opens a fresh unchosen remedy only on a new bodyless action after a later true response', async () => {
      let currentMissingKey = 'GONE';
      const secondaryMessage = 'The space "RETAINED" for another page in this trash batch no longer exists. This batch cannot be restored by choosing a target for this page.';
      const fetchSpy = mockApi(missingTrash(), {
        restore: (_pageId, init) => selectedTargetKey(init) === 'TARGET'
          ? secondaryMissingSpaceResponse('RETAINED', false)
          : missingSpaceResponse(currentMissingKey),
      });
      render(<TrashPage />, { wrapper: createWrapper() });
      fireEvent.click(await screen.findByTestId('trash-checkbox-3'));
      const first = await openRestoreDialog();
      const select = within(first).getByRole('combobox', { name: /local space/i });
      await within(select).findByRole('option', { name: /Team Notes.*TARGET/ });
      fireEvent.change(select, { target: { value: 'TARGET' } });
      const retry = within(first).getByRole('button', { name: /retry restore/i });
      retry.focus();
      await act(async () => { fireEvent.click(retry); });
      await waitFor(() => expect(first).not.toBeInTheDocument());
      expect(toast.error).toHaveBeenCalledWith(secondaryMessage);
      await waitFor(() => expect(screen.getByTestId('restore-btn-3')).toHaveFocus());
      expect(restoreRequests(fetchSpy.mock.calls)).toHaveLength(2);

      // Transport fixture for a later other-client lifecycle change, not real DB proof.
      currentMissingKey = 'LATER_MISSING';
      const fresh = await openRestoreDialog();
      expect(within(fresh).getByText(
        'The space "LATER_MISSING" no longer exists. Choose a space to restore into.',
        { exact: true },
      )).toBeVisible();
      expect(within(fresh).queryByText(secondaryMessage, { exact: true })).not.toBeInTheDocument();
      await waitFor(() => expect(
        within(fresh).getByRole('combobox', { name: /local space/i }),
      ).toHaveFocus());
      expect(within(fresh).getByRole('combobox', { name: /local space/i })).toHaveValue('');
      expect(screen.getByTestId('trash-bulk-count')).toHaveTextContent('1 page selected');
      const requests = restoreRequests(fetchSpy.mock.calls);
      expect(requests).toHaveLength(3);
      expect(requests[0]![1]?.body).toBeUndefined();
      expect(selectedTargetKey(requests[1]![1])).toBe('TARGET');
      expect(requests[2]![1]?.body).toBeUndefined();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('[F01f] fails closed when an initial refusal omits the capability discriminator', async () => {
      await expectInitialSecondaryRefusal(undefined);
    });

    it('[F01g] fails closed when an initial refusal supplies a nonboolean capability discriminator', async () => {
      await expectInitialSecondaryRefusal('true');
    });

    it('[F01h] closes an open remedy when the current refusal omits the capability discriminator', async () => {
      await expectSelectedSecondaryCloses('RETAINED', undefined);
    });

    it('[F01i] closes an open remedy when the current capability discriminator is not boolean true', async () => {
      await expectSelectedSecondaryCloses('RETAINED', 'true');
    });
  });
});
