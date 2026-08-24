import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NOTION_UNSUPPORTED_LABEL } from '@compendiq/contracts';
import { useAuthStore } from '../../../stores/auth-store';
import { NotionImportDialog } from './NotionImportDialog';

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
  respond: (url: string, init?: RequestInit) => StubResponse;
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
      const { status = 200, body = {} } = route
        ? route.respond(url, init)
        : { status: 404, body: { message: `no stub for ${method} ${url}` } };
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

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NotionImportDialog open onClose={vi.fn()} />
    </QueryClientProvider>,
  );
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

  it('lets a parent be selected without children, and nested pages independently', async () => {
    renderDialog();
    await connectWithDummyToken();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Handbook' }));
    expect(screen.getByRole('checkbox', { name: 'Handbook' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Onboarding' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Nested notes' })).not.toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Nested notes' }));
    expect(screen.getByRole('checkbox', { name: 'Nested notes' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Onboarding' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled();
  });
});

describe('NotionImportDialog confirm copy', () => {
  it('states skipped databases include their rows', async () => {
    renderDialog();
    await connectWithDummyToken();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Handbook' }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    const confirm = await screen.findByTestId('notion-import-confirm-copy');
    expect(confirm).toHaveTextContent(/1 page will import/);
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
    fireEvent.click(screen.getByRole('button', { name: /shared/i }));
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && /\/notion\/import$/.test(c.url))).toBe(true);
    });
    const post = calls.find((c) => c.method === 'POST' && /\/notion\/import$/.test(c.url));
    const body = JSON.parse(post!.body ?? '{}') as Record<string, unknown>;
    expect(body.pageIds).toEqual(['handbook']);
    expect(body.spaceKey).toBe('notes');
    expect(body.visibility).toBe('shared');
    expect(body).not.toHaveProperty('token');
    expect(JSON.stringify(body)).not.toContain(TOKEN);
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
    expect(src).not.toMatch(/notion\/(?:connection|tree)\?.*token/);
    expect(src).not.toMatch(/api\.notion\.com/);
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
});
