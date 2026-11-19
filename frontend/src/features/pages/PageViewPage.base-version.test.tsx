import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { toast } from 'sonner';
import { PageViewPage } from './PageViewPage';
import { useAuthStore } from '../../stores/auth-store';
import { useArticleViewStore } from '../../stores/article-view-store';
import { beginDraftEdit, pageDraftKey, persistDraft } from '../../shared/lib/editor-drafts';

// #1746: the ordinary (non-collaborative) Save must send the version the
// editing session's content is based on, never whatever the page query last
// refetched. Real PageViewPage, TipTap editor and use-pages hooks; only the
// network (fetch) is stubbed, by a small server that applies the unchanged
// `PUT /pages/:id` rule. No <Toaster/> is mounted here (it lives at the app
// root), so sonner is a spy and a toast action is invoked exactly as a real
// Toaster would when the user activates it.
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

const AUTO_SAVE_DELAY_MS = 2000;
const ACCOUNT = { id: '11111111-1111-4111-8111-111111111111', username: 'author_a', role: 'user' as const };
const CONFLICT_MESSAGE = 'Page has been modified since you loaded it. Please refresh and try again.';
const CONFLICT_TOAST = 'Version conflict detected.';

const v1Page = {
  id: '42',
  confluenceId: null,
  title: 'Shared article',
  spaceKey: null,
  pageType: 'page',
  bodyHtml: '<p>ORIGINAL v1</p>',
  bodyText: 'ORIGINAL v1',
  version: 1,
  parentId: null,
  labels: [] as string[],
  author: 'author_a',
  lastModifiedAt: '2026-09-20T12:00:00.000Z',
  lastSynced: '2026-09-20T12:00:00.000Z',
  hasChildren: false,
  descendantCount: 0,
  embeddingDirty: false,
  embeddingStatus: 'embedded',
  embeddedAt: '2026-09-20T12:00:00.000Z',
  embeddingError: null,
  qualityScore: null,
  qualityStatus: null,
  qualityCompleteness: null,
  qualityClarity: null,
  qualityStructure: null,
  qualityAccuracy: null,
  qualityReadability: null,
  qualitySummary: null,
  qualityAnalyzedAt: null,
  qualityError: null,
  summaryHtml: null,
  summaryStatus: undefined,
  summaryGeneratedAt: null,
  summaryModel: null,
  summaryError: null,
  source: 'standalone',
  visibility: 'shared',
  createdByUserId: ACCOUNT.id,
  lifecycleRevision: '1',
  isFrozen: false,
  canMutateContent: true,
};

type ServerPage = typeof v1Page;
type PutBody = { title: string; bodyHtml: string; version?: number };

let serverPage: ServerPage;
let puts: PutBody[];
let nextPutOverride: (() => Response) | null;
let fetchMock: Mock;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

/** A second HTTP client saves: the server row moves on, this tab does not know yet. */
function remoteSave(bodyHtml: string, extra: Partial<ServerPage> = {}) {
  serverPage = { ...serverPage, bodyHtml, bodyText: bodyHtml, version: serverPage.version + 1, ...extra };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/pages/42']}>
        <LazyMotion features={domAnimation}>
          <Routes>
            <Route path="/pages/:id" element={<PageViewPage />} />
          </Routes>
        </LazyMotion>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, ...view };
}

/** What the Details panel shows: ArticleRightPane renders the same ['pages', id] query. */
function cachedVersion(client: QueryClient) {
  return client.getQueryData<{ version: number }>(['pages', '42'])?.version;
}

/** The tab becomes visible again: TanStack refetches the stale page query. */
async function backgroundRefresh(client: QueryClient, expected: number) {
  await act(async () => { window.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => expect(cachedVersion(client)).toBe(expected));
}

async function startEditing() {
  fireEvent.click(await screen.findByRole('button', { name: /^Edit/ }));
}

async function editableBody(): Promise<HTMLElement> {
  return waitFor(() => {
    const element = document.querySelector('.ProseMirror');
    if (!(element instanceof HTMLElement)) throw new Error('Editor did not mount');
    expect(element).toHaveAttribute('contenteditable', 'true');
    return element;
  });
}

/** Pastes at the caret (the start of the document), like PageViewPage.drafts.test.tsx. */
async function typeText(text: string) {
  const editor = await editableBody();
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', {
    value: { items: [], files: [], getData: (type: string) => (type === 'text/plain' ? text : '') },
  });
  editor.focus();
  fireEvent(editor, paste);
  await waitFor(() => expect(editor).toHaveTextContent(text));
}

async function clickSave() {
  const save = await screen.findByRole('button', { name: 'Save' });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
}

async function waitForPuts(count: number) {
  await waitFor(() => expect(puts).toHaveLength(count));
}

/** A draft an earlier tab left behind, written through editor-drafts.ts (never a hand-built key). */
function seedDraft(html: string) {
  const pending = beginDraftEdit(pageDraftKey('42'));
  if (!pending) throw new Error('no signed-in user');
  persistDraft(pending, () => html);
}

async function addTag(tag: string) {
  fireEvent.click(screen.getByTestId('tag-popover-trigger'));
  const input = await screen.findByLabelText('New tag name');
  fireEvent.change(input, { target: { value: tag } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

function conflictToasts() {
  return vi.mocked(toast.error).mock.calls.filter(([message]) => message === CONFLICT_TOAST);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  Element.prototype.scrollTo = vi.fn();
  localStorage.clear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.info).mockClear();
  useAuthStore.getState().setAuth('jwt-a', ACCOUNT);
  serverPage = v1Page;
  puts = [];
  nextPutOverride = null;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (url === '/api/pages/42' && method === 'GET') return json(serverPage);
    if (url === '/api/pages/42' && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as PutBody;
      puts.push(body);
      if (nextPutOverride) {
        const respond = nextPutOverride;
        nextPutOverride = null;
        return respond();
      }
      // pages-crud.ts local branch, unchanged: an unchanged payload is not
      // version-checked; otherwise only a strictly older version is refused.
      if (body.title === serverPage.title && body.bodyHtml === serverPage.bodyHtml) {
        return json({ id: 42, title: serverPage.title, version: serverPage.version, source: 'standalone' });
      }
      if (body.version !== undefined && body.version < serverPage.version) {
        return json({ error: 'Conflict', message: CONFLICT_MESSAGE, statusCode: 409 }, 409);
      }
      serverPage = {
        ...serverPage,
        title: body.title,
        bodyHtml: body.bodyHtml,
        bodyText: body.bodyHtml,
        version: serverPage.version + 1,
      };
      return json({ id: 42, title: serverPage.title, version: serverPage.version, source: 'standalone' });
    }
    if (url === '/api/pages/42/labels' && method === 'PUT') {
      return json({
        error: 'ai_policy_enforcement_unavailable',
        pageIds: [42],
        message: 'AI-policy enforcement is not active on this deployment',
      }, 409);
    }
    if (url === '/api/collab/config') return json({ enabled: false });
    if (url === '/api/settings') return json({
      inlineCompletionEnabled: false,
      clientInferenceEnabled: false,
      clientInferenceAdminEnabled: false,
      clientSpellcheckEnabled: false,
    });
    if (url === '/api/settings/drawio-url') return json({ drawioEmbedUrl: 'https://draw.example.com' });
    if (url === '/api/pages/filters') return json({ authors: [], labels: [] });
    if (url === '/api/pages/pinned') return json({ items: [], total: 0 });
    if (url === '/api/pages/42/connections') return json({ linked: [], section: [], related: [] });
    if (url.startsWith('/api/llm/usecase-default')) return json({ message: 'Not configured' }, 404);
    if (url === '/api/pages/42/presence' && method === 'GET') return new Response(null, { status: 403 });
    if (url.startsWith('/api/pages/42/presence')) return new Response(null, { status: 204 });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useAuthStore.getState().clearAuth();
  useArticleViewStore.getState().setEditing(false);
  useArticleViewStore.getState().setHeadings([]);
  localStorage.clear();
});

// Each case mounts the real TipTap editor, some twice; allow for a busy runner.
describe("PageViewPage ordinary Save keeps the editing session's base version (#1746)", { timeout: 20_000 }, () => {
  it('sends the version the session started from after a background refetch shows v2, and answers 409 with a Reload action', async () => {
    const { client } = renderPage();
    await startEditing();
    await typeText('LOCAL OLD EDIT');
    remoteSave('<p>REMOTE NEW CONTENT</p>');
    await backgroundRefresh(client, 2);
    // The refetch reached the page query the Details panel reads, and did not
    // replace the open draft.
    expect(await editableBody()).toHaveTextContent('LOCAL OLD EDIT');

    await clickSave();
    await waitForPuts(1);
    expect(puts[0]).toMatchObject({ version: 1 });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(CONFLICT_TOAST, expect.objectContaining({
      action: expect.objectContaining({ label: 'Reload' }),
    })));
    expect(toast.success).not.toHaveBeenCalled();
    expect(serverPage).toMatchObject({ version: 2, bodyHtml: '<p>REMOTE NEW CONTENT</p>' });
    expect(await editableBody()).toHaveTextContent('LOCAL OLD EDIT');
  });

  it('keeps the base after a 409, so a repeated Save is refused again once the page has refetched', async () => {
    const { client } = renderPage();
    await startEditing();
    await typeText('LOCAL OLD EDIT');
    remoteSave('<p>REMOTE NEW CONTENT</p>'); // this tab has not seen it yet
    await clickSave();
    await waitForPuts(1);
    expect(puts[0]).toMatchObject({ version: 1 });
    await waitFor(() => expect(conflictToasts()).toHaveLength(1));
    // The update mutation refetches the page after the refused save as well.
    await waitFor(() => expect(cachedVersion(client)).toBe(2));

    await clickSave();
    await waitForPuts(2);
    expect(puts[1]).toMatchObject({ version: 1 });
    await waitFor(() => expect(conflictToasts()).toHaveLength(2));
    expect(serverPage).toMatchObject({ version: 2, bodyHtml: '<p>REMOTE NEW CONTENT</p>' });
  });

  it('keeps the base after confluence_modified', async () => {
    // Only the collaborative commit emits confluence_modified today, and that
    // branch never reads the base. This guards the catch block both branches
    // share, so a confluence_modified reply can never move the ordinary base.
    const { client } = renderPage();
    await startEditing();
    await typeText('LOCAL OLD EDIT');
    remoteSave('<p>REMOTE NEW CONTENT</p>');
    nextPutOverride = () => json({
      error: 'Conflict',
      message: 'This page was modified in Confluence.',
      statusCode: 409,
      code: 'confluence_modified',
      remoteVersion: 9,
      localVersion: 1,
    }, 409);
    await clickSave();
    await waitForPuts(1);
    expect(await screen.findByTestId('confluence-modified-alert')).toBeInTheDocument();
    await waitFor(() => expect(cachedVersion(client)).toBe(2));

    await clickSave();
    await waitForPuts(2);
    expect(puts[1]).toMatchObject({ version: 1 });
    await waitFor(() => expect(conflictToasts()).toHaveLength(1));
    expect(serverPage).toMatchObject({ version: 2, bodyHtml: '<p>REMOTE NEW CONTENT</p>' });
  });

  it('starts a new session at the current version after Open current version', async () => {
    // Passes before #1746 too (the live version equals a new session's base).
    // It fails if the base is captured once per mount and never refreshed.
    const { client } = renderPage();
    await startEditing();
    await typeText('BLOCKED EDIT');
    remoteSave('<p>REMOTE AFTER LIFECYCLE</p>', { lifecycleRevision: '2' });
    await backgroundRefresh(client, 2);
    fireEvent.click(await screen.findByRole('button', { name: 'Open current version' }));
    expect(await screen.findByTestId('confirm-dialog-confirm')).toHaveTextContent('Open current version');
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await startEditing();
    expect(await editableBody()).toHaveTextContent('REMOTE AFTER LIFECYCLE');
    await typeText('SECOND SESSION');
    await clickSave();
    await waitForPuts(1);
    expect(puts[0]).toMatchObject({ version: 2 });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Page saved.'));
    expect(serverPage.version).toBe(3);
  });

  it('bases a restored draft on the version shown when Restore draft is chosen', async () => {
    seedDraft('<p>STORED DRAFT</p>');
    const { client } = renderPage();
    await startEditing();
    expect(await screen.findByText('Restore draft?')).toBeInTheDocument();
    remoteSave('<p>REMOTE v2</p>');
    await backgroundRefresh(client, 2);
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(await editableBody()).toHaveTextContent('STORED DRAFT');
    remoteSave('<p>REMOTE v3</p>');
    await backgroundRefresh(client, 3);

    await clickSave();
    await waitForPuts(1);
    // Not 1 (the Edit click) and not 3 (the live query): the restore moment.
    expect(puts[0]).toMatchObject({ version: 2 });
    await waitFor(() => expect(conflictToasts()).toHaveLength(1));
    expect(serverPage).toMatchObject({ version: 3, bodyHtml: '<p>REMOTE v3</p>' });
  });

  it('bases Edit published version on the version of the body it seeds', async () => {
    seedDraft('<p>STORED DRAFT</p>');
    const { client } = renderPage();
    await startEditing();
    expect(await screen.findByText('Restore draft?')).toBeInTheDocument();
    remoteSave('<p>REMOTE v2</p>');
    await backgroundRefresh(client, 2);
    fireEvent.click(screen.getByRole('button', { name: 'Edit published version' }));
    expect(await editableBody()).toHaveTextContent('REMOTE v2');
    await typeText('PLUS MINE');
    remoteSave('<p>REMOTE v3</p>');
    await backgroundRefresh(client, 3);

    await clickSave();
    await waitForPuts(1);
    expect(puts[0]).toMatchObject({ version: 2 });
    await waitFor(() => expect(conflictToasts()).toHaveLength(1));
    expect(serverPage).toMatchObject({ version: 3, bodyHtml: '<p>REMOTE v3</p>' });
  });

  it.each(['Restore draft', 'Edit published version'])(
    'keeps a remote rename made while the draft dialog is open when %s is chosen',
    async (choice) => {
      seedDraft('<p>STORED DRAFT</p>');
      const { client } = renderPage();
      await startEditing();
      expect(await screen.findByText('Restore draft?')).toBeInTheDocument();
      remoteSave('<p>REMOTE v2</p>', { title: 'Renamed remotely' });
      await backgroundRefresh(client, 2);
      fireEvent.click(screen.getByRole('button', { name: choice }));
      await typeText('PLUS MINE');

      await clickSave();
      await waitForPuts(1);
      // The title must describe the same page as the base version: the title
      // read at the Edit click would revert the rename without a conflict.
      expect(puts[0]).toMatchObject({ title: 'Renamed remotely', version: 2 });
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Page saved.'));
      expect(serverPage).toMatchObject({ version: 3, title: 'Renamed remotely' });
    },
  );

  it('adopts its own successful Save as the base when a refused label write keeps the session open', async () => {
    const { client } = renderPage();
    await startEditing();
    await typeText('LOCAL EDIT');
    await addTag('ops');
    await clickSave();
    await waitForPuts(1);
    expect(puts[0]).toMatchObject({ version: 1 });
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      'Content saved; the label change was not applied. See the tag control for the reason.',
    ));
    expect(serverPage.version).toBe(2);
    expect(await editableBody()).toHaveTextContent('LOCAL EDIT');

    remoteSave('<p>REMOTE v3</p>');
    await backgroundRefresh(client, 3);
    await clickSave();
    await waitForPuts(2);
    // Its own write (2): not the pre-save base (1), not the live query (3).
    expect(puts[1]).toMatchObject({ version: 2 });
    await waitFor(() => expect(conflictToasts()).toHaveLength(1));
    expect(serverPage).toMatchObject({ version: 3, bodyHtml: '<p>REMOTE v3</p>' });
  });

  it('adopts the version the reply names, not base + 1, when an unchanged Save does not bump the page', async () => {
    const { client } = renderPage();
    await startEditing();
    await editableBody();
    await addTag('ops');
    // Title and body untouched: the server writes nothing and answers the
    // current version (1); the refused label write keeps the session open.
    await clickSave();
    await waitForPuts(1);
    expect(puts[0]).toMatchObject({ bodyHtml: '<p>ORIGINAL v1</p>', version: 1 });
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      'Content saved; the label change was not applied. See the tag control for the reason.',
    ));
    expect(serverPage.version).toBe(1);

    remoteSave('<p>REMOTE v2</p>');
    await backgroundRefresh(client, 2);
    await typeText('LATER EDIT');
    await clickSave();
    await waitForPuts(2);
    // base + 1 would send 2 and overwrite the remote v2 without a conflict.
    expect(puts[1]).toMatchObject({ version: 1 });
    await waitFor(() => expect(conflictToasts()).toHaveLength(1));
    expect(serverPage).toMatchObject({ version: 2, bodyHtml: '<p>REMOTE v2</p>' });
  });

  it('reconciles explicitly: Reload leaves edit mode with the draft, and Restore draft then saves against the current version', async () => {
    // Passes before #1746 too: it pins the explicit reconciliation the fix
    // relies on (Reload keeps the draft; the next session saves on top).
    const { client } = renderPage();
    await startEditing();
    await typeText('LOCAL OLD EDIT');
    // Let the editor's debounced autosave write the draft that Reload must keep.
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS + 500); });
    remoteSave('<p>REMOTE NEW CONTENT</p>');
    await clickSave();
    await waitForPuts(1);
    expect(puts[0]).toMatchObject({ version: 1 });
    const [, options] = await waitFor(() => {
      const [call] = conflictToasts();
      if (!call) throw new Error('no version-conflict toast');
      return call;
    });
    const { action } = options as { action: { label: string; onClick: (event: unknown) => void } };
    expect(action.label).toBe('Reload');
    act(() => { action.onClick(new MouseEvent('click')); });

    await waitFor(() => expect(document.querySelector('.ProseMirror[contenteditable="true"]')).toBeNull());
    await waitFor(() => expect(cachedVersion(client)).toBe(2));
    await startEditing();
    expect(await screen.findByText('Restore draft?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(await editableBody()).toHaveTextContent('LOCAL OLD EDIT');

    await clickSave();
    await waitForPuts(2);
    expect(puts[1]).toMatchObject({ version: 2 });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Page saved.'));
    expect(serverPage.version).toBe(3);
    expect(serverPage.bodyHtml).toContain('LOCAL OLD EDIT');
  });
});
