import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NOTION_UNSUPPORTED_LABEL } from '@compendiq/contracts';
import { useAuthStore } from '../../../stores/auth-store';
import { NotionImportDialog, NotionImportPickFooter } from './NotionImportDialog';
import { NOTION_IMPORT_MAX_PAGES, shouldCommitImportResult } from './notion-import-selection';

const TOKEN = 'ntn_dummy_secret_do_not_echo';

const { mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
    warning: vi.fn(),
  },
}));

interface StubResponse {
  status?: number;
  body?: unknown;
}

let routes: Array<{
  match: RegExp;
  method?: string;
  respond: (url: string, init?: RequestInit) => StubResponse | Promise<StubResponse>;
}>;
let calls: Array<{ url: string; method: string; body: string | null }>;

function stubFetch() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : null });
      const route = routes.find((r) => r.match.test(url) && (r.method ?? 'GET') === method);
      const resolved = route
        ? await route.respond(url, init)
        : { status: 404, body: { message: `no stub for ${method} ${url}` } };
      const { status = 200, body = {} } = resolved;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: String(status),
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => body,
      } as unknown as Response;
    }),
  );
}

function deferResponse(): {
  promise: Promise<StubResponse>;
  resolve: (value: StubResponse) => void;
} {
  let resolve!: (value: StubResponse) => void;
  const promise = new Promise<StubResponse>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const MIXED_TREE = {
  nodes: [
    {
      id: 'handbook',
      title: 'Handbook',
      type: 'page',
      selectable: true,
      children: [
        {
          id: 'onboarding',
          title: 'Onboarding',
          type: 'page',
          selectable: true,
          children: [
            { id: 'nested', title: 'Nested notes', type: 'page', selectable: true, children: [] },
          ],
        },
        {
          id: 'crm',
          title: 'CRM',
          type: 'database',
          selectable: false,
          skipReason: NOTION_UNSUPPORTED_LABEL,
          children: [],
        },
        {
          id: 'board',
          title: 'Whiteboard',
          type: 'unsupported',
          selectable: false,
          skipReason: NOTION_UNSUPPORTED_LABEL,
          children: [],
        },
      ],
    },
    {
      id: 'row-listed',
      title: 'Customer Acme',
      type: 'page',
      selectable: true,
      children: [],
    },
  ],
};

const LOCAL_SPACES = [
  {
    key: 'notes',
    name: 'My Notes',
    source: 'local',
    description: null,
    icon: null,
    pageCount: 3,
    createdBy: null,
    createdAt: '2026-01-01T00:00:00Z',
  },
];

let connected = false;

function givenHappyPath(opts: { tree?: unknown; importItems?: unknown[] } = {}) {
  connected = false;
  routes = [
    {
      match: /\/notion\/connection$/,
      method: 'GET',
      respond: () => ({ body: { hasToken: connected } }),
    },
    {
      match: /\/notion\/connection$/,
      method: 'PUT',
      respond: (_url, init) => {
        const body = JSON.parse(init?.body ?? '{}') as { token?: string };
        if (!body.token) return { status: 400, body: { message: 'token required' } };
        connected = true;
        return { body: { hasToken: true } };
      },
    },
    {
      match: /\/notion\/connection$/,
      method: 'DELETE',
      respond: () => {
        connected = false;
        return { body: { hasToken: false } };
      },
    },
    {
      match: /\/notion\/tree$/,
      method: 'GET',
      respond: () => (connected ? { body: opts.tree ?? MIXED_TREE } : { status: 400, body: { message: 'Notion is not connected' } }),
    },
    {
      match: /\/notion\/import$/,
      method: 'POST',
      respond: () => ({
        body: {
          items: opts.importItems ?? [
            { notionPageId: 'handbook', status: 'success', localPageId: 11 },
            { notionPageId: 'nested', status: 'skip', reason: NOTION_UNSUPPORTED_LABEL },
          ],
        },
      }),
    },
    { match: /\/spaces\/local/, method: 'GET', respond: () => ({ body: LOCAL_SPACES }) },
    { match: /\/spaces(?:\?|$)/, method: 'GET', respond: () => ({ body: [] }) },
    { match: /\/pages\/tree/, method: 'GET', respond: () => ({ body: { items: [], total: 0 } }) },
  ];
}

function renderDialog(opts: { open?: boolean; onClose?: () => void; queryClient?: QueryClient } = {}) {
  const queryClient =
    opts.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = opts.onClose ?? vi.fn();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <NotionImportDialog open={opts.open ?? true} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { ...view, queryClient, onClose };
}

async function connectWithDummyToken() {
  const input = await screen.findByLabelText(/internal integration token/i);
  fireEvent.change(input, { target: { value: TOKEN } });
  fireEvent.click(screen.getByRole('button', { name: /connect/i }));
  await screen.findByRole('heading', { name: 'Choose pages' });
  await waitFor(() => {
    expect(
      screen.queryByTestId('notion-import-tree')
        ?? screen.queryByTestId('notion-import-tree-empty')
        ?? screen.queryByTestId('notion-import-tree-error'),
    ).toBeTruthy();
  });
}

beforeEach(() => {
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
  useAuthStore.getState().setAuth('test-access', { id: 'u1', username: 'me', role: 'user' });
  stubFetch();
  givenHappyPath();
});

afterEach(() => {
  useAuthStore.getState().clearAuth();
  vi.unstubAllGlobals();
});

describe('NotionImportDialog picker skip rules', () => {
  it('labels databases and unsupported nodes and refuses to select them', async () => {
    renderDialog();
    await connectWithDummyToken();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Handbook' }));

    const crm = screen.getByTestId('notion-node-crm');
    expect(crm).toHaveTextContent(NOTION_UNSUPPORTED_LABEL);
    expect(within(crm).queryByRole('checkbox')).toBeNull();

    const board = screen.getByTestId('notion-node-board');
    expect(board).toHaveTextContent(NOTION_UNSUPPORTED_LABEL);
    expect(within(board).queryByRole('checkbox')).toBeNull();

    fireEvent.click(crm);
    expect(screen.queryByRole('checkbox', { name: 'CRM' })).toBeNull();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('groups descendants behind expandable parent rows', async () => {
    renderDialog();
    await connectWithDummyToken();

    expect(screen.getByRole('checkbox', { name: 'Handbook' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Onboarding' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Nested notes' })).toBeNull();
    expect(screen.getByTestId('notion-import-tree')).not.toHaveAttribute('role');
    expect(screen.getByRole('button', { name: 'Expand Handbook' })).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Expand Handbook' }));
    expect(screen.getByRole('button', { name: 'Collapse Handbook' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('checkbox', { name: 'Onboarding' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Nested notes' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Onboarding' }));
    expect(screen.getByRole('checkbox', { name: 'Nested notes' })).toBeInTheDocument();
  });

  it('selects an entire collapsed parent group and exposes partial selection', async () => {
    renderDialog();
    await connectWithDummyToken();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Handbook' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('notion-import-confirm-copy')).toHaveTextContent(/3 pages will import/i);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand Handbook' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Onboarding' }));
    expect(screen.getByRole('checkbox', { name: 'Handbook' })).toBePartiallyChecked();
  });

  it('shows group checkbox and badge on a database with child pages', async () => {
    givenHappyPath({
      tree: {
        nodes: [
          {
            id: 'wiki-db',
            title: 'Kubernetes Wiki',
            type: 'database',
            selectable: false,
            skipReason: NOTION_UNSUPPORTED_LABEL,
            reasonCode: 'database',
            children: [
              { id: 'p1', title: 'AOWD', type: 'page', selectable: true, children: [] },
              { id: 'p2', title: 'Redis Cheatsheet', type: 'page', selectable: true, children: [] },
            ],
          },
        ],
      },
    });
    renderDialog();
    await connectWithDummyToken();

    const wikiNode = screen.getByTestId('notion-node-wiki-db');
    expect(wikiNode).toHaveTextContent('Kubernetes Wiki');
    expect(wikiNode).toHaveTextContent('Database');
    expect(wikiNode).toHaveTextContent(/2 pages can be imported/i);

    const groupCheckbox = within(wikiNode).getByRole('checkbox', { name: /Select all 2 pages in Kubernetes Wiki/i });
    expect(groupCheckbox).not.toBeChecked();

    fireEvent.click(groupCheckbox);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('notion-import-confirm-copy')).toHaveTextContent(/2 pages will import/i);
  });
});

describe('NotionImportDialog large workspace rendering', () => {
  it('renders root groups in bounded batches and exposes the remainder', async () => {
    givenHappyPath({
      tree: {
        nodes: Array.from({ length: 51 }, (_, index) => ({
          id: `root-${index}`,
          title: `Root page ${index}`,
          type: 'page',
          selectable: true,
          children: [],
        })),
      },
    });
    renderDialog();
    await connectWithDummyToken();

    expect(screen.getByRole('checkbox', { name: 'Root page 49' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Root page 50' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more page' }));
    expect(screen.getByRole('checkbox', { name: 'Root page 50' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show .* more page/i })).toBeNull();
  });

  it('drops stale selections before enforcing the page cap after a tree refresh', async () => {
    givenHappyPath({
      tree: {
        nodes: [{
          id: 'old-parent',
          title: 'Old parent',
          type: 'page',
          selectable: true,
          children: Array.from({ length: NOTION_IMPORT_MAX_PAGES - 1 }, (_, index) => ({
            id: `old-child-${index}`,
            title: `Old child ${index}`,
            type: 'page',
            selectable: true,
            children: [],
          })),
        }],
      },
    });
    const { queryClient } = renderDialog();
    await connectWithDummyToken();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Old parent' }));

    queryClient.setQueryData(['notion', 'tree'], {
      nodes: [{ id: 'fresh', title: 'Fresh page', type: 'page', selectable: true, children: [] }],
    });
    const fresh = await screen.findByRole('checkbox', { name: 'Fresh page' });
    fireEvent.click(fresh);

    expect(fresh).toBeChecked();
    expect(screen.queryByText(/exceeds the 200-page import limit/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });
});

describe('NotionImportDialog confirm copy', () => {
  it('states skipped databases include their rows', async () => {
    renderDialog();
    await connectWithDummyToken();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Handbook' }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    const confirm = await screen.findByTestId('notion-import-confirm-copy');
    expect(confirm).toHaveTextContent(/3 pages will import/);
    expect(confirm).toHaveTextContent(/database skipped/i);
    expect(confirm).toHaveTextContent(/including its rows|including their rows/);
    expect(confirm).toHaveTextContent(/stay in Notion/i);
    expect(confirm.textContent).not.toContain(TOKEN);
  });

  it('sends only selected page ids to the local destination, never a token', async () => {
    renderDialog();
    await connectWithDummyToken();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Handbook' }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await screen.findByTestId('notion-import-confirm-copy');
    fireEvent.change(screen.getByLabelText(/space/i), { target: { value: 'notes' } });
    fireEvent.click(screen.getByRole('radio', { name: /shared/i }));
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && /\/notion\/import$/.test(c.url))).toBe(true);
    });
    const post = calls.find((c) => c.method === 'POST' && /\/notion\/import$/.test(c.url));
    const body = JSON.parse(post!.body ?? '{}') as Record<string, unknown>;
    expect(body.pageIds).toEqual(['handbook', 'onboarding', 'nested']);
    expect(body.spaceKey).toBe('notes');
    expect(body.visibility).toBe('shared');
    expect(body).not.toHaveProperty('token');
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });
});

describe('NotionImportDialog connect-step token guidance', () => {
  it('names the Notion token type and how to share pages', async () => {
    renderDialog();
    const input = await screen.findByLabelText(/internal integration token/i);

    expect(screen.getByText(/installation access token/i)).toBeInTheDocument();
    expect(screen.getByText(/not an oauth app/i)).toBeInTheDocument();
    expect(screen.getByText(/not a personal access token/i)).toBeInTheDocument();
    expect(screen.getByText(/share the pages you want to import/i)).toBeInTheDocument();
    expect(screen.getByText(/never shown again/i)).toBeInTheDocument();

    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    for (const id of (describedBy ?? '').split(/\s+/).filter(Boolean)) {
      const region = document.getElementById(id);
      expect(region, `missing described-by region #${id}`).not.toBeNull();
      expect(region!.querySelector('a')).toBeNull();
    }
  });

  it('links to Notion’s integrations portal outside the field description', async () => {
    renderDialog();
    await screen.findByLabelText(/internal integration token/i);

    const link = screen.getByTestId('notion-token-link');
    expect(link).toHaveAttribute('href', 'https://www.notion.so/my-integrations');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    expect(link).toHaveTextContent(/create a token in notion/i);
  });
});

describe('NotionImportDialog connection never-echo', () => {
  it('never puts the token on GET URLs, GET bodies, or toasts', async () => {
    renderDialog();
    await connectWithDummyToken();

    const gets = calls.filter((c) => c.method === 'GET');
    expect(gets.length).toBeGreaterThan(0);
    for (const get of gets) {
      expect(get.url).not.toContain(TOKEN);
      expect(get.body).toBeNull();
    }
    const put = calls.find((c) => c.method === 'PUT' && /\/notion\/connection$/.test(c.url));
    expect(JSON.parse(put!.body ?? '{}')).toEqual({ token: TOKEN });

    const toasted = [...mockToastSuccess.mock.calls, ...mockToastError.mock.calls].flat().join(' ');
    expect(toasted).not.toContain(TOKEN);
    expect(screen.getByTestId('notion-import-dialog').textContent).not.toContain(TOKEN);
  });

  it('GET connection handler source never names a token query param', () => {
    const src = readFileSync(
      path.join(process.cwd(), 'src/features/pages/notion-import/use-notion-import.ts'),
      'utf8',
    );
    expect(src).toContain("'/notion/connection'");
    expect(src).toContain("'/notion/tree'");
    expect(src).toContain("cancelQueries({ queryKey: ['notion'] })");
    expect(src).toContain("setQueryData(['notion', 'connection']");
    expect(src).toContain("removeQueries({ queryKey: ['notion', 'tree'] })");
    expect(src).not.toMatch(/notion\/(?:connection|tree)\?.*token/);
    expect(src).not.toMatch(/api\.notion\.com/);
  });
});

describe('NotionImportDialog connect then tree', () => {
  it('loads the tree after Connect even while GET connection has not refetched', async () => {
    const held = deferResponse();
    let connectionGetSettled = 0;
    givenHappyPath();
    routes = [
      {
        match: /\/notion\/connection$/,
        method: 'GET',
        respond: async () => {
          const body = await held.promise;
          connectionGetSettled += 1;
          return body;
        },
      },
      ...routes.filter((route) => !((route.method ?? 'GET') === 'GET' && route.match.test('/api/notion/connection'))),
    ];
    const { queryClient } = renderDialog();
    const input = await screen.findByLabelText(/internal integration token/i);
    fireEvent.change(input, { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));

    expect(await screen.findByRole('checkbox', { name: 'Handbook' })).toBeInTheDocument();
    expect(screen.queryByText(/loading workspace/i)).toBeNull();

    held.resolve({ body: { hasToken: false } });
    await waitFor(() => {
      expect(connectionGetSettled).toBeGreaterThanOrEqual(1);
      expect(queryClient.getQueryState(['notion', 'connection'])?.fetchStatus).toBe('idle');
    });
    expect(queryClient.getQueryData(['notion', 'connection'])).toEqual({ hasToken: true });
    expect(screen.getByRole('heading', { name: 'Choose pages' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Handbook' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/internal integration token/i)).toBeNull();
  });
});

describe('NotionImportDialog empty and error', () => {
  it('shows an empty tree that cannot continue', async () => {
    givenHappyPath({ tree: { nodes: [] } });
    renderDialog();
    await connectWithDummyToken();
    expect(screen.getByTestId('notion-import-tree-empty')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('reports a tree error instead of treating it as empty', async () => {
    connected = true;
    routes = [
      { match: /\/notion\/connection$/, method: 'GET', respond: () => ({ body: { hasToken: true } }) },
      {
        match: /\/notion\/tree$/,
        method: 'GET',
        respond: () => ({ status: 502, body: { message: 'Notion is unreachable' } }),
      },
      { match: /\/spaces\/local/, method: 'GET', respond: () => ({ body: LOCAL_SPACES }) },
    ];
    renderDialog();
    expect(await screen.findByTestId('notion-import-tree-error')).toHaveTextContent(/unreachable/i);
    expect(screen.queryByTestId('notion-import-tree-empty')).toBeNull();
  });

  it('keeps Retry mounted and focusable while a no-cache refetch is in flight', async () => {
    connected = true;
    const held = deferResponse();
    let treeGets = 0;
    routes = [
      { match: /\/notion\/connection$/, method: 'GET', respond: () => ({ body: { hasToken: true } }) },
      {
        match: /\/notion\/tree$/,
        method: 'GET',
        respond: () => {
          treeGets += 1;
          if (treeGets === 1) return { status: 502, body: { message: 'Notion is unreachable' } };
          return held.promise;
        },
      },
      { match: /\/spaces\/local/, method: 'GET', respond: () => ({ body: LOCAL_SPACES }) },
    ];
    renderDialog();
    const retry = await screen.findByRole('button', { name: /^retry$/i });
    retry.focus();
    fireEvent.click(retry);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /retrying/i })).toBeInTheDocument();
    });
    const retrying = screen.getByRole('button', { name: /retrying/i });
    expect(retrying).not.toBeDisabled();
    expect(retrying).toHaveAttribute('aria-disabled', 'true');
    expect(retrying).toHaveFocus();
    expect(screen.getByTestId('notion-import-tree-error')).toBeInTheDocument();

    held.resolve({ status: 502, body: { message: 'Notion is unreachable' } });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^retry$/i })).toBeInTheDocument();
    });
  });

  it('keeps a cached tree under a degraded strip when refetch fails', async () => {
    connected = true;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['notion', 'tree'], MIXED_TREE, { updatedAt: 0 });
    routes = [
      { match: /\/notion\/connection$/, method: 'GET', respond: () => ({ body: { hasToken: true } }) },
      {
        match: /\/notion\/tree$/,
        method: 'GET',
        respond: () => ({ status: 502, body: { message: 'Notion is unreachable' } }),
      },
      { match: /\/spaces\/local/, method: 'GET', respond: () => ({ body: LOCAL_SPACES }) },
    ];
    renderDialog({ queryClient });

    expect(await screen.findByTestId('notion-import-tree-degraded')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('notion-import-tree')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Handbook' })).toBeInTheDocument();
    expect(screen.queryByTestId('notion-import-tree-error')).toBeNull();
  });
});

describe('NotionImportDialog destination and lock', () => {
  async function reachConfirm() {
    renderDialog();
    await connectWithDummyToken();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Handbook' }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByTestId('notion-import-confirm-copy');
  }

  it('says a local space is required when the list is empty', async () => {
    routes = routes.map((route) =>
      route.match.test('/spaces/local') ? { ...route, respond: () => ({ body: [] }) } : route,
    );
    await reachConfirm();
    expect(screen.getByTestId('notion-import-spaces-empty')).toHaveTextContent(/local space/i);
    expect(screen.getByRole('button', { name: /^import$/i })).toHaveAttribute('aria-disabled', 'true');
  });

  it('says local spaces could not be read when the list request fails', async () => {
    connected = true;
    routes = [
      { match: /\/notion\/connection$/, method: 'GET', respond: () => ({ body: { hasToken: true } }) },
      { match: /\/notion\/tree$/, method: 'GET', respond: () => ({ body: MIXED_TREE }) },
      {
        match: /\/spaces\/local/,
        method: 'GET',
        respond: () => ({ status: 502, body: { message: 'spaces failed' } }),
      },
      { match: /\/spaces(?:\?|$)/, method: 'GET', respond: () => ({ body: [] }) },
      { match: /\/pages\/tree/, method: 'GET', respond: () => ({ body: { items: [], total: 0 } }) },
    ];
    renderDialog();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Handbook' }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByTestId('notion-import-spaces-error')).toHaveTextContent(/could not/i);
    expect(screen.getByRole('button', { name: /^import$/i })).toHaveAttribute('aria-disabled', 'true');
  });

  it('does not fetch local spaces while the wizard is closed', () => {
    renderDialog({ open: false });
    expect(calls.some((c) => /\/spaces\/local/.test(c.url))).toBe(false);
  });

  it('locks Back and selection while import is in flight, then shows titles', async () => {
    const held = deferResponse();
    givenHappyPath();
    routes = routes.map((route) =>
      (route.method ?? 'GET') === 'POST' && route.match.test('/notion/import')
        ? { ...route, respond: () => held.promise }
        : route,
    );
    const { onClose } = renderDialog();
    await connectWithDummyToken();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Handbook' }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByTestId('notion-import-confirm-copy');
    fireEvent.change(screen.getByLabelText(/space/i), { target: { value: 'notes' } });
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /importing/i })).toBeInTheDocument();
    });
    const back = screen.getByRole('button', { name: /^back$/i });
    expect(back).toBeDisabled();
    expect(screen.queryByRole('checkbox', { name: 'Nested notes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).not.toHaveBeenCalled();

    held.resolve({
      body: {
        items: [
          { notionPageId: 'handbook', status: 'success', localPageId: 11 },
          { notionPageId: 'nested', status: 'skip', reason: NOTION_UNSUPPORTED_LABEL },
        ],
      },
    });

    const result = await screen.findByTestId('notion-import-result');
    expect(result).toHaveTextContent('Handbook');
    expect(result).not.toHaveTextContent('handbook');
    expect(within(result).getByRole('link', { name: 'Handbook' })).toHaveAttribute('href', '/pages/11');
  });

  it('does not commit an in-flight POST after the wizard leaves confirm', () => {
    expect(shouldCommitImportResult('confirm', true)).toBe(true);
    expect(shouldCommitImportResult('pick', true)).toBe(false);
    expect(shouldCommitImportResult('result', true)).toBe(false);
    expect(shouldCommitImportResult('confirm', false)).toBe(false);
  });

  it('keeps parent-page search focused inside the location picker', async () => {
    await reachConfirm();
    fireEvent.change(screen.getByLabelText(/space/i), { target: { value: 'notes' } });
    fireEvent.click(screen.getByRole('button', { name: /select page location/i }));
    const search = await screen.findByPlaceholderText(/search pages/i);
    search.focus();
    fireEvent.change(search, { target: { value: 'Root' } });
    expect(search).toHaveValue('Root');
    expect(search).toHaveFocus();
    expect(screen.getByTestId('notion-import-dialog')).toBeInTheDocument();
  });

  it('strips a leaked token key from GET connection/tree before caching', async () => {
    connected = true;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    routes = [
      {
        match: /\/notion\/connection$/,
        method: 'GET',
        respond: () => ({ body: { hasToken: true, token: TOKEN } }),
      },
      {
        match: /\/notion\/tree$/,
        method: 'GET',
        respond: () => ({ body: { ...MIXED_TREE, token: TOKEN } }),
      },
      { match: /\/spaces\/local/, method: 'GET', respond: () => ({ body: LOCAL_SPACES }) },
    ];
    renderDialog({ queryClient });

    await waitFor(() => {
      expect(screen.getByTestId('notion-import-dialog').textContent).not.toContain(TOKEN);
    });
    expect(JSON.stringify(queryClient.getQueryData(['notion', 'connection']) ?? {})).not.toContain(TOKEN);
    expect(JSON.stringify(queryClient.getQueryData(['notion', 'tree']) ?? {})).not.toContain(TOKEN);
  });

  it('renders the unsupported label from node.skipReason', () => {
    const src = readFileSync(
      path.join(process.cwd(), 'src/features/pages/notion-import/NotionImportDialog.tsx'),
      'utf8',
    );
    expect(src).toMatch(/node\.skipReason/);
    expect(src).toMatch(/<NotionImportPickFooter/);
    expect(src).toMatch(/importCount=\{summary\.importCount\}/);
  });
});

describe('NotionImportDialog tree cache and empty retry', () => {
  it('drops the cached tree on disconnect so a new Connect cannot POST old ids', async () => {
    const { queryClient } = renderDialog();
    await connectWithDummyToken();
    expect(screen.getByRole('checkbox', { name: 'Handbook' })).toBeInTheDocument();
    expect(queryClient.getQueryData(['notion', 'tree'])).toEqual(MIXED_TREE);

    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    await screen.findByRole('heading', { name: 'Connect Notion' });
    expect(queryClient.getQueryData(['notion', 'tree'])).toBeUndefined();

    const held = deferResponse();
    givenHappyPath({
      tree: {
        nodes: [{ id: 'other', title: 'Other space', type: 'page', selectable: true, children: [] }],
      },
    });
    routes = routes.map((route) =>
      route.match.test('/notion/tree') ? { ...route, respond: () => held.promise } : route,
    );

    fireEvent.change(screen.getByLabelText(/internal integration token/i), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    await screen.findByRole('heading', { name: 'Choose pages' });

    expect(screen.queryByRole('checkbox', { name: 'Handbook' })).toBeNull();
    expect(screen.getByText(/loading workspace/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();

    held.resolve({
      body: {
        nodes: [{ id: 'other', title: 'Other space', type: 'page', selectable: true, children: [] }],
      },
    });
    expect(await screen.findByRole('checkbox', { name: 'Other space' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Handbook' })).toBeNull();
  });

  it('invalidates the cached tree after import so alreadyImported can refresh', async () => {
    const { queryClient } = renderDialog();
    await connectWithDummyToken();
    expect(queryClient.getQueryData(['notion', 'tree'])).toEqual(MIXED_TREE);
    const treeGetsBefore = calls.filter((c) => c.method === 'GET' && /\/notion\/tree$/.test(c.url)).length;
    expect(treeGetsBefore).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Handbook' }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByTestId('notion-import-confirm-copy');
    fireEvent.change(screen.getByLabelText(/space/i), { target: { value: 'notes' } });
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }));
    await screen.findByTestId('notion-import-result');

    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'GET' && /\/notion\/tree$/.test(c.url)).length).toBeGreaterThan(
        treeGetsBefore,
      );
    });
  });

  it('lets an empty tree retry instead of keeping a successful [] cache', async () => {
    givenHappyPath({ tree: { nodes: [] } });
    renderDialog();
    await connectWithDummyToken();
    expect(screen.getByTestId('notion-import-tree-empty')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /^retry$/i });
    expect(screen.getByTestId('notion-import-tree-empty').textContent).toMatch(/retry/i);

    givenHappyPath({ tree: MIXED_TREE });
    connected = true;
    fireEvent.click(retry);
    expect(await screen.findByRole('checkbox', { name: 'Handbook' })).toBeInTheDocument();
  });

  it('rehomes focus to the tree after a successful no-cache Retry', async () => {
    connected = true;
    const held = deferResponse();
    let treeGets = 0;
    routes = [
      { match: /\/notion\/connection$/, method: 'GET', respond: () => ({ body: { hasToken: true } }) },
      {
        match: /\/notion\/tree$/,
        method: 'GET',
        respond: () => {
          treeGets += 1;
          if (treeGets === 1) return { status: 502, body: { message: 'Notion is unreachable' } };
          return held.promise;
        },
      },
      { match: /\/spaces\/local/, method: 'GET', respond: () => ({ body: LOCAL_SPACES }) },
    ];
    renderDialog();
    const retry = await screen.findByRole('button', { name: /^retry$/i });
    retry.focus();
    fireEvent.click(retry);
    await screen.findByRole('button', { name: /retrying/i });
    held.resolve({ body: MIXED_TREE });
    await screen.findByTestId('notion-import-tree');
    await waitFor(() => {
      expect(screen.getByTestId('notion-import-tree')).toHaveFocus();
    });
  });
});

describe('NotionImportDialog picker cap and a11y', () => {
  it('enables Continue with batch count when more than 200 pages are selected for multi-batch import', () => {
    render(
      <NotionImportPickFooter
        importCount={201}
        importPending={false}
        onCancel={() => {}}
        onContinue={() => {}}
      />,
    );
    expect(screen.getByText(/201 pages selected · 2 batches/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue \(2 batches\)/i })).toBeEnabled();
  });

  it('renders imported badge and supports selecting unimported pages and hiding imported pages', async () => {
    givenHappyPath({
      tree: {
        nodes: [
          {
            id: 'p-imported',
            title: 'Imported Guide',
            type: 'page',
            selectable: true,
            alreadyImported: true,
            localPageId: 42,
            children: [],
          },
          {
            id: 'p-new',
            title: 'New Article',
            type: 'page',
            selectable: true,
            alreadyImported: false,
            children: [],
          },
        ],
      },
    });
    renderDialog();
    await connectWithDummyToken();

    expect(screen.getByTestId('notion-imported-badge-p-imported')).toHaveTextContent('Imported');

    fireEvent.click(screen.getByRole('button', { name: /select unimported/i }));
    expect(screen.getByRole('checkbox', { name: 'New Article' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Imported Guide' })).not.toBeChecked();
    fireEvent.click(screen.getByLabelText(/hide imported/i));
    expect(screen.queryByText('Imported Guide')).not.toBeInTheDocument();
    expect(screen.getByText('New Article')).toBeInTheDocument();
  });

  it('supports Pages only selection and excluding database rows', async () => {
    givenHappyPath({
      tree: {
        nodes: [
          {
            id: 'p-doc',
            title: 'Architecture Doc',
            type: 'page',
            selectable: true,
            isDatabaseRow: false,
            children: [],
          },
          {
            id: 'db-1',
            title: 'Commands DB',
            type: 'database',
            selectable: false,
            skipReason: NOTION_UNSUPPORTED_LABEL,
            children: [
              {
                id: 'p-row',
                title: 'nslookup',
                type: 'page',
                selectable: true,
                isDatabaseRow: true,
                children: [],
              },
            ],
          },
        ],
      },
    });
    renderDialog();
    await connectWithDummyToken();

    fireEvent.click(screen.getByRole('button', { name: /pages only/i }));
    expect(screen.getByRole('checkbox', { name: 'Architecture Doc' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /select all 1 pages in commands db/i })).not.toBeChecked();

    fireEvent.click(screen.getByLabelText(/exclude database rows/i));
    expect(screen.queryByText('Commands DB')).not.toBeInTheDocument();
    expect(screen.getByText('Architecture Doc')).toBeInTheDocument();
  });

  it('filters and auto-expands tree branches using search input', async () => {
    renderDialog();
    await connectWithDummyToken();

    const searchInput = screen.getByRole('searchbox', { name: /search pages and databases/i });
    fireEvent.change(searchInput, { target: { value: 'nested' } });

    expect(screen.getByRole('checkbox', { name: 'Nested notes' })).toBeInTheDocument();
    expect(screen.queryByText('CRM')).not.toBeInTheDocument();
  });

  it('renders a skip control per database and sends overwriteExisting and skip modes on import', async () => {
    givenHappyPath({
      tree: {
        nodes: [
          {
            id: 'handbook',
            title: 'Handbook',
            type: 'page',
            selectable: true,
            children: [
              {
                id: 'crm',
                title: 'CRM',
                type: 'database',
                selectable: false,
                skipReason: NOTION_UNSUPPORTED_LABEL,
                children: [{ id: 'row-1', title: 'Row 1', type: 'page', selectable: true, children: [] }],
              },
            ],
          },
        ],
      },
    });
    renderDialog();
    await connectWithDummyToken();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Handbook' }));
    const crmNode = screen.getByTestId('notion-node-crm');
    expect(within(crmNode).queryByRole('button', { name: 'Table' })).not.toBeInTheDocument();
    expect(within(crmNode).queryByRole('button', { name: 'Articles' })).not.toBeInTheDocument();
    const skipBtn = within(crmNode).getByRole('button', { name: 'Skip' });

    fireEvent.click(skipBtn);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Handbook' }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await screen.findByTestId('notion-import-confirm-copy');
    expect(screen.getByTestId('notion-import-confirm-copy')).toHaveTextContent('1 page will import');
    const reSyncCheckbox = screen.getByLabelText(/update existing pages/i);
    expect(reSyncCheckbox).not.toBeChecked();
    fireEvent.click(reSyncCheckbox);
    expect(reSyncCheckbox).toBeChecked();

    fireEvent.change(screen.getByLabelText(/space/i), { target: { value: 'notes' } });
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }));

    await screen.findByTestId('notion-import-result');
    const importCall = calls.find((c) => c.url.includes('/notion/import'));
    expect(importCall).toBeDefined();
    const body = JSON.parse(importCall!.body!);
    expect(body.overwriteExisting).toBe(true);
    expect(body.databaseModes).toEqual({ crm: 'skip' });
    expect(body.pageIds).toEqual(['handbook']);
  });

  it('clears search when the dialog closes', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onClose = vi.fn();
    const ui = (open: boolean) => (
      <QueryClientProvider client={queryClient}>
        <NotionImportDialog open={open} onClose={onClose} />
      </QueryClientProvider>
    );
    const view = render(ui(true));
    await connectWithDummyToken();
    fireEvent.change(screen.getByRole('searchbox', { name: /search pages and databases/i }), {
      target: { value: 'nested' },
    });
    expect(screen.getByRole('checkbox', { name: 'Nested notes' })).toBeInTheDocument();
    view.rerender(ui(false));
    view.rerender(ui(true));
    await screen.findByRole('heading', { name: 'Choose pages' });
    expect(screen.getByRole('searchbox', { name: /search pages and databases/i })).toHaveValue('');
  });
  it('rehomes focus to the result heading after a successful Import', async () => {
    renderDialog();
    await connectWithDummyToken();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Handbook' }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByTestId('notion-import-confirm-copy');
    fireEvent.change(screen.getByLabelText(/space/i), { target: { value: 'notes' } });
    const importBtn = screen.getByRole('button', { name: /^import$/i });
    importBtn.focus();
    fireEvent.click(importBtn);
    await screen.findByTestId('notion-import-result');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Import finished' })).toHaveFocus();
    });
  });

  it('moves visibility with arrow keys on one tab stop', async () => {
    renderDialog();
    await connectWithDummyToken();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Handbook' }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByTestId('notion-import-confirm-copy');

    const privateRadio = screen.getByRole('radio', { name: /private/i });
    const sharedRadio = screen.getByRole('radio', { name: /shared/i });
    expect(privateRadio).toHaveAttribute('tabindex', '0');
    expect(sharedRadio).toHaveAttribute('tabindex', '-1');
    privateRadio.focus();
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: /visibility/i }), { key: 'ArrowRight' });
    expect(sharedRadio).toHaveAttribute('aria-checked', 'true');
    expect(sharedRadio).toHaveAttribute('tabindex', '0');
  });
});
