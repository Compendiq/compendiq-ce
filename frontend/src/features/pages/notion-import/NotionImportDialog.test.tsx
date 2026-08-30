import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  NOTION_UNSUPPORTED_LABEL,
  type NotionImportItem,
  type NotionTreeDatabaseNode,
  type NotionTreeNode,
  type NotionTreePageNode,
  type NotionTreeSkippedNode,
} from '@compendiq/contracts';
import { useAuthStore } from '../../../stores/auth-store';
import { NotionImportDialog, NotionImportPickFooter } from './NotionImportDialog';
import { NOTION_IMPORT_MAX_PAGES, shouldCommitImportResult } from './notion-import-selection';

const TOKEN = 'ntn_dummy_secret_do_not_echo';

/** Deliberately not `NOTION_UNSUPPORTED_LABEL`: the row must read the node. */
const BOARD_SKIP = 'Whiteboards have no local shape yet';

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

function pageNode(id: string, title: string, children: NotionTreeNode[] = []): NotionTreePageNode {
  return { id, title, type: 'page', selectable: true, children };
}

function rowNode(id: string, title: string): NotionTreePageNode {
  return { id, title, type: 'page', selectable: true, isDatabaseRow: true, children: [] };
}

type DatabaseOverrides = Partial<
  Pick<
    NotionTreeDatabaseNode,
    'recommendedMode' | 'rowContent' | 'isWiki' | 'rowCount' | 'columns' | 'children'
  >
>;

function dbNode(id: string, title: string, overrides: DatabaseOverrides = {}): NotionTreeDatabaseNode {
  const children = overrides.children ?? [];
  return {
    id,
    title,
    type: 'database',
    selectable: true,
    recommendedMode: 'table',
    rowContent: 'none',
    isWiki: false,
    rowCount: children.length,
    columns: ['Name', 'Stage'],
    ...overrides,
    children,
  };
}

function wikiNode(id: string, title: string, overrides: DatabaseOverrides = {}): NotionTreeDatabaseNode {
  return dbNode(id, title, {
    isWiki: true,
    recommendedMode: 'pages',
    rowContent: 'some',
    ...overrides,
  });
}

function unsupportedNode(
  id: string,
  title: string,
  overrides: Partial<Pick<NotionTreeSkippedNode, 'skipReason' | 'reasonCode' | 'children'>> = {},
): NotionTreeSkippedNode {
  return {
    id,
    title,
    type: 'unsupported',
    selectable: false,
    skipReason: BOARD_SKIP,
    children: [],
    ...overrides,
  };
}

const MIXED_TREE = {
  nodes: [
    pageNode('handbook', 'Handbook', [
      pageNode('onboarding', 'Onboarding', [pageNode('nested', 'Nested notes')]),
      dbNode('crm', 'CRM', { rowCount: 0 }),
      unsupportedNode('board', 'Whiteboard', { reasonCode: 'canvas' }),
    ]),
    pageNode('row-listed', 'Customer Acme'),
  ],
};

/** One database, two rows: the three-way mode switch under test. */
const DB_TREE = {
  nodes: [
    pageNode('handbook', 'Handbook'),
    dbNode('crm', 'CRM', { children: [rowNode('row-1', 'Acme'), rowNode('row-2', 'Globex')] }),
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

function givenHappyPath(opts: { tree?: unknown; importItems?: NotionImportItem[] } = {}) {
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

/** The mode switch of one database. */
function modeControl(databaseId: string): HTMLElement {
  return screen.getByTestId(`notion-db-mode-${databaseId}`);
}

function modeButton(databaseId: string, label: string): HTMLElement {
  return within(modeControl(databaseId)).getByRole('button', { name: label });
}

function actionOf(nodeId: string): HTMLElement {
  return screen.getByTestId(`notion-node-action-${nodeId}`);
}

function kindOf(nodeId: string): HTMLElement {
  return screen.getByTestId(`notion-node-kind-${nodeId}`);
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

describe('NotionImportDialog row outcomes', () => {
  it('states the Notion kind and the local outcome of every row', async () => {
    renderDialog();
    await connectWithDummyToken();

    expect(
      screen.getByText('One-shot migrate into a local space. Every row says what it becomes.'),
    ).toBeInTheDocument();

    expect(kindOf('handbook')).toHaveTextContent('Page');
    expect(actionOf('handbook')).toHaveTextContent('Imports as a page');
    expect(kindOf('row-listed')).toHaveTextContent('Page');
    expect(actionOf('row-listed')).toHaveTextContent('Imports as a page');

    fireEvent.click(screen.getByRole('button', { name: 'Expand Handbook' }));

    expect(kindOf('onboarding')).toHaveTextContent('Page');
    expect(actionOf('onboarding')).toHaveTextContent('Imports as a page');
    expect(kindOf('crm')).toHaveTextContent('Database');
    expect(actionOf('crm')).toHaveTextContent('Imports as one table · 0 rows');
    expect(kindOf('board')).toHaveTextContent('Canvas');

    expect(screen.getByTestId('notion-node-handbook')).toHaveAttribute('data-supported', 'true');
    expect(screen.getByTestId('notion-node-crm')).toHaveAttribute('data-supported', 'true');
  });

  it('refuses to pick an unsupported row and prints the scan’s own reason', async () => {
    renderDialog();
    await connectWithDummyToken();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Handbook' }));

    const board = screen.getByTestId('notion-node-board');
    expect(board).toHaveAttribute('data-supported', 'false');
    expect(within(board).queryByRole('checkbox')).toBeNull();
    expect(actionOf('board')).toHaveTextContent(BOARD_SKIP);
    expect(board.textContent).not.toContain(NOTION_UNSUPPORTED_LABEL);
    expect(screen.queryByRole('checkbox', { name: 'Whiteboard' })).toBeNull();
  });

  it('lets an unsupported parent select the importable rows beneath it', async () => {
    givenHappyPath({
      tree: {
        nodes: [
          unsupportedNode('linked:crm', 'CRM (linked view)', {
            reasonCode: 'linked_database',
            skipReason: 'Linked views point at a database elsewhere',
            children: [pageNode('p1', 'Architecture'), pageNode('p2', 'Runbook')],
          }),
        ],
      },
    });
    renderDialog();
    await connectWithDummyToken();

    expect(kindOf('linked:crm')).toHaveTextContent('Linked view');
    expect(actionOf('linked:crm')).toHaveTextContent('Linked views point at a database elsewhere');

    const group = screen.getByRole('checkbox', { name: 'Select all 2 items in CRM (linked view)' });
    fireEvent.click(group);
    expect(group).toBeChecked();
    expect(screen.getByText(/2 pages selected/)).toBeInTheDocument();
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
    expect(await screen.findByTestId('notion-import-confirm-copy')).toHaveTextContent(
      '3 pages and 1 table will import.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand Handbook' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Onboarding' }));
    expect(screen.getByRole('checkbox', { name: 'Handbook' })).toBePartiallyChecked();
  });

  it('picks a wiki database and its rows with one checkbox', async () => {
    givenHappyPath({
      tree: {
        nodes: [
          wikiNode('wiki-db', 'Kubernetes Wiki', {
            children: [rowNode('p1', 'AOWD'), rowNode('p2', 'Redis Cheatsheet')],
          }),
        ],
      },
    });
    renderDialog();
    await connectWithDummyToken();

    expect(kindOf('wiki-db')).toHaveTextContent('Wiki');
    expect(actionOf('wiki-db')).toHaveTextContent('Imports as one page with 2 articles');

    const groupCheckbox = screen.getByRole('checkbox', { name: 'Kubernetes Wiki' });
    expect(groupCheckbox).not.toBeChecked();

    fireEvent.click(groupCheckbox);
    expect(groupCheckbox).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('notion-import-confirm-copy')).toHaveTextContent(
      '2 articles and 1 database page will import.',
    );
  });
});

describe('NotionImportDialog database mode switch', () => {
  it('offers one pressable button per available mode, with the recommendation pressed', async () => {
    givenHappyPath({ tree: DB_TREE });
    renderDialog();
    await connectWithDummyToken();

    const control = modeControl('crm');
    expect(control).toHaveAttribute('role', 'group');
    expect(control).toHaveAttribute('aria-label', 'Import CRM as');
    expect(screen.getByRole('group', { name: 'Import CRM as' })).toBe(control);

    const buttons = within(control).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Table', 'Pages', 'Skip']);
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
    ]);
  });

  it('never offers Table for a wiki, whose rows carry bodies', async () => {
    givenHappyPath({
      tree: { nodes: [wikiNode('wiki-db', 'Engineering Wiki', { children: [rowNode('w1', 'Runbook')] })] },
    });
    renderDialog();
    await connectWithDummyToken();

    const control = modeControl('wiki-db');
    expect(within(control).queryByRole('button', { name: 'Table' })).toBeNull();
    expect(within(control).getAllByRole('button').map((b) => b.textContent)).toEqual(['Pages', 'Skip']);
    expect(modeButton('wiki-db', 'Pages')).toHaveAttribute('aria-pressed', 'true');
  });

  it('rewrites the database and every row it governs when the mode changes', async () => {
    givenHappyPath({ tree: DB_TREE });
    renderDialog();
    await connectWithDummyToken();
    fireEvent.click(screen.getByRole('button', { name: 'Expand CRM' }));

    expect(actionOf('crm')).toHaveTextContent('Imports as one table · 2 rows');
    expect(kindOf('row-1')).toHaveTextContent('Database row');
    expect(actionOf('row-1')).toHaveTextContent('Included in the table above');
    expect(actionOf('row-2')).toHaveTextContent('Included in the table above');
    expect(screen.queryByRole('checkbox', { name: 'Acme' })).toBeNull();

    fireEvent.click(modeButton('crm', 'Pages'));
    expect(modeButton('crm', 'Pages')).toHaveAttribute('aria-pressed', 'true');
    expect(modeButton('crm', 'Table')).toHaveAttribute('aria-pressed', 'false');
    expect(actionOf('crm')).toHaveTextContent('Imports as one page with 2 articles');
    expect(actionOf('row-1')).toHaveTextContent('Imports as an article');
    expect(actionOf('row-2')).toHaveTextContent('Imports as an article');
    expect(screen.getByRole('checkbox', { name: 'Acme' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Globex' })).toBeInTheDocument();

    fireEvent.click(modeButton('crm', 'Skip'));
    expect(modeButton('crm', 'Skip')).toHaveAttribute('aria-pressed', 'true');
    expect(actionOf('crm')).toHaveTextContent('Excluded — stays in Notion');
    expect(actionOf('row-1')).toHaveTextContent('Excluded — stays in Notion');
    expect(actionOf('row-2')).toHaveTextContent('Excluded — stays in Notion');
    expect(within(screen.getByTestId('notion-node-crm')).queryByRole('checkbox')).toBeNull();

    fireEvent.click(modeButton('crm', 'Table'));
    expect(actionOf('crm')).toHaveTextContent('Imports as one table · 2 rows');
    expect(actionOf('row-1')).toHaveTextContent('Included in the table above');
    expect(screen.getByRole('checkbox', { name: 'CRM' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Acme' })).toBeNull();
  });

  it('cautions when a table override would flatten rows that have content', async () => {
    givenHappyPath({
      tree: {
        nodes: [
          dbNode('crm', 'CRM', {
            recommendedMode: 'pages',
            rowContent: 'some',
            children: [rowNode('row-1', 'Acme'), rowNode('row-2', 'Globex')],
          }),
        ],
      },
    });
    renderDialog();
    await connectWithDummyToken();

    expect(screen.queryByTestId('notion-node-caution-crm')).toBeNull();

    fireEvent.click(modeButton('crm', 'Table'));
    expect(screen.getByTestId('notion-node-caution-crm')).toHaveTextContent(/page content/i);
  });

  it('drops a skipped database and its rows from the selection count', async () => {
    givenHappyPath({ tree: DB_TREE });
    renderDialog();
    await connectWithDummyToken();

    fireEvent.click(modeButton('crm', 'Pages'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Handbook' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'CRM' }));
    expect(screen.getByText(/4 pages selected/)).toBeInTheDocument();

    fireEvent.click(modeButton('crm', 'Skip'));
    expect(screen.getByText(/1 page selected/)).toBeInTheDocument();
    expect(screen.queryByText(/4 pages selected/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('ticks a pages-mode database and all its rows in one click', async () => {
    // Regression: the checkbox must toggle the group the CURRENT mode governs,
    // not the recommended one, or a pages override lands half-selected.
    givenHappyPath({ tree: DB_TREE });
    renderDialog();
    await connectWithDummyToken();
    fireEvent.click(screen.getByRole('button', { name: 'Expand CRM' }));
    fireEvent.click(modeButton('crm', 'Pages'));

    const dbCheckbox = screen.getByRole('checkbox', { name: 'CRM' });
    fireEvent.click(dbCheckbox);

    expect(dbCheckbox).toBeChecked();
    expect(dbCheckbox).not.toBePartiallyChecked();
    expect(screen.getByRole('checkbox', { name: 'Acme' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Globex' })).toBeChecked();
    expect(screen.getByText(/3 pages selected/)).toBeInTheDocument();

    fireEvent.click(dbCheckbox);
    expect(dbCheckbox).not.toBeChecked();
    expect(dbCheckbox).not.toBePartiallyChecked();
    expect(screen.getByRole('checkbox', { name: 'Acme' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('sends the effective mode of every selected database, and omits skipped ones', async () => {
    givenHappyPath({
      tree: {
        nodes: [
          pageNode('handbook', 'Handbook'),
          dbNode('crm', 'CRM', { children: [rowNode('row-1', 'Acme'), rowNode('row-2', 'Globex')] }),
          wikiNode('playbooks', 'Playbooks', { children: [rowNode('play-1', 'Runbook')] }),
          dbNode('archive', 'Archive', { rowCount: 9 }),
        ],
      },
      importItems: [{ notionPageId: 'handbook', status: 'success', localPageId: 11, importedAs: 'page' }],
    });
    renderDialog();
    await connectWithDummyToken();

    fireEvent.click(modeButton('archive', 'Skip'));
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    const confirm = await screen.findByTestId('notion-import-confirm-copy');
    expect(confirm).toHaveTextContent(
      '1 page, 1 article, 1 table and 1 database page will import. 1 database is excluded.',
    );

    const reSyncCheckbox = screen.getByLabelText(/update existing pages/i);
    expect(reSyncCheckbox).not.toBeChecked();
    fireEvent.click(reSyncCheckbox);

    fireEvent.change(screen.getByLabelText(/space/i), { target: { value: 'notes' } });
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }));
    await screen.findByTestId('notion-import-result');

    const post = calls.find((c) => c.method === 'POST' && /\/notion\/import$/.test(c.url));
    const body = JSON.parse(post!.body ?? '{}') as Record<string, unknown>;
    expect(body.pageIds).toEqual(['handbook', 'crm', 'playbooks', 'play-1']);
    expect(body.databaseModes).toEqual({ crm: 'table', playbooks: 'pages' });
    expect(body.databaseModes).not.toHaveProperty('archive');
    expect(body.overwriteExisting).toBe(true);
  });
});

describe('NotionImportDialog large workspace rendering', () => {
  it('renders root groups in bounded batches and exposes the remainder', async () => {
    givenHappyPath({
      tree: {
        nodes: Array.from({ length: 51 }, (_, index) => pageNode(`root-${index}`, `Root page ${index}`)),
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
        nodes: [
          pageNode(
            'old-parent',
            'Old parent',
            Array.from({ length: NOTION_IMPORT_MAX_PAGES - 1 }, (_, index) =>
              pageNode(`old-child-${index}`, `Old child ${index}`),
            ),
          ),
        ],
      },
    });
    const { queryClient } = renderDialog();
    await connectWithDummyToken();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Old parent' }));

    queryClient.setQueryData(['notion', 'tree'], { nodes: [pageNode('fresh', 'Fresh page')] });
    const fresh = await screen.findByRole('checkbox', { name: 'Fresh page' });
    fireEvent.click(fresh);

    expect(fresh).toBeChecked();
    expect(screen.queryByText(/exceeds the 200-page import limit/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });
});

describe('NotionImportDialog confirm copy', () => {
  it('names every shape that imports and what stays in Notion', async () => {
    renderDialog();
    await connectWithDummyToken();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Handbook' }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    const confirm = await screen.findByTestId('notion-import-confirm-copy');
    expect(confirm).toHaveTextContent('3 pages and 1 table will import.');
    expect(confirm).toHaveTextContent('1 item cannot be imported and stay in Notion.');
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
    expect(body.pageIds).toEqual(['handbook', 'onboarding', 'nested', 'crm']);
    expect(body.databaseModes).toEqual({ crm: 'table' });
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

  it('reads each result row as the shape it actually landed in', async () => {
    givenHappyPath({
      importItems: [
        { notionPageId: 'handbook', status: 'success', localPageId: 11, importedAs: 'page' },
        { notionPageId: 'crm', status: 'success', localPageId: 12, importedAs: 'table' },
        { notionPageId: 'nested', status: 'success', localPageId: 13, importedAs: 'article' },
      ],
    });
    renderDialog();
    await connectWithDummyToken();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Handbook' }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByTestId('notion-import-confirm-copy');
    fireEvent.change(screen.getByLabelText(/space/i), { target: { value: 'notes' } });
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }));

    const result = await screen.findByTestId('notion-import-result');
    const rows = within(result)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    expect(rows[0]).toMatch(/^Handbook\s*imported$/);
    expect(rows[1]).toMatch(/^CRM\s*imported as a table$/);
    expect(rows[2]).toMatch(/^Nested notes\s*imported as an article$/);
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

  it('derives every row label from the node, never from a hard-coded constant', () => {
    const selection = readFileSync(
      path.join(process.cwd(), 'src/features/pages/notion-import/notion-import-selection.ts'),
      'utf8',
    );
    expect(selection).toMatch(/action: node\.skipReason/);

    const dialog = readFileSync(
      path.join(process.cwd(), 'src/features/pages/notion-import/NotionImportDialog.tsx'),
      'utf8',
    );
    expect(dialog).not.toContain('NOTION_UNSUPPORTED_LABEL');
    expect(dialog).toMatch(/<NotionImportPickFooter/);
    expect(dialog).toMatch(/importCount=\{summary\.importCount\}/);
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
    givenHappyPath({ tree: { nodes: [pageNode('other', 'Other space')] } });
    routes = routes.map((route) =>
      route.match.test('/notion/tree') ? { ...route, respond: () => held.promise } : route,
    );

    fireEvent.change(screen.getByLabelText(/internal integration token/i), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    await screen.findByRole('heading', { name: 'Choose pages' });

    expect(screen.queryByRole('checkbox', { name: 'Handbook' })).toBeNull();
    expect(screen.getByText(/loading workspace/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();

    held.resolve({ body: { nodes: [pageNode('other', 'Other space')] } });
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
          { ...pageNode('p-imported', 'Imported Guide'), alreadyImported: true, localPageId: 42 },
          { ...pageNode('p-new', 'New Article'), alreadyImported: false },
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

  it('supports Pages only selection and keeps the database when its rows are excluded', async () => {
    givenHappyPath({
      tree: {
        nodes: [
          { ...pageNode('p-doc', 'Architecture Doc'), isDatabaseRow: false },
          dbNode('db-1', 'Commands DB', { children: [rowNode('p-row', 'nslookup')] }),
        ],
      },
    });
    renderDialog();
    await connectWithDummyToken();

    fireEvent.click(screen.getByRole('button', { name: /pages only/i }));
    expect(screen.getByRole('checkbox', { name: 'Architecture Doc' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Commands DB' })).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Commands DB' }));
    expect(screen.getByText('nslookup')).toBeInTheDocument();

    // A database imports in its own right, so hiding rows hides the rows only.
    fireEvent.click(screen.getByLabelText(/exclude database rows/i));
    expect(screen.queryByText('nslookup')).not.toBeInTheDocument();
    expect(screen.getByTestId('notion-node-db-1')).toBeInTheDocument();
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

  it('forgets database mode overrides when the dialog closes', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onClose = vi.fn();
    givenHappyPath({ tree: DB_TREE });
    const ui = (open: boolean) => (
      <QueryClientProvider client={queryClient}>
        <NotionImportDialog open={open} onClose={onClose} />
      </QueryClientProvider>
    );
    const view = render(ui(true));
    await connectWithDummyToken();

    fireEvent.click(modeButton('crm', 'Skip'));
    expect(actionOf('crm')).toHaveTextContent('Excluded — stays in Notion');

    view.rerender(ui(false));
    view.rerender(ui(true));
    await screen.findByRole('heading', { name: 'Choose pages' });
    expect(actionOf('crm')).toHaveTextContent('Imports as one table · 2 rows');
    expect(modeButton('crm', 'Table')).toHaveAttribute('aria-pressed', 'true');
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
