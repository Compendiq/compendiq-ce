import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { NewPagePage } from './NewPagePage';
import { UserMenu } from '../../shared/components/layout/UserMenu';
import { useAuthStore } from '../../stores/auth-store';
import { useArticleViewStore } from '../../stores/article-view-store';
import { beginDraftEdit, persistDraft, readDraft } from '../../shared/lib/editor-drafts';

// #1747 (GHSA-r652-53hc-h6jh rules): an interrupted new page is offered back
// to the account that wrote it, and only to that account. Real NewPagePage,
// Editor (TipTap), UserMenu, logoutApi and auth store; only the network
// (fetch) is stubbed, as in PageViewPage.drafts.test.tsx. Absence checks scan
// ALL of localStorage for the unsaved text.

const AUTO_SAVE_DELAY_MS = 2000;
const ACCOUNT_A = { id: '11111111-1111-4111-8111-111111111111', username: 'author_a', role: 'user' as const };
const ACCOUNT_B = { id: '22222222-2222-4222-8222-222222222222', username: 'reader_b', role: 'user' as const };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Mirrors App's ProtectedRoute: signing out unmounts the page. */
function SignedInShell() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <h1>Sign in</h1>;
  return (
    <>
      <UserMenu />
      <Routes>
        <Route path="/pages/new" element={<NewPagePage />} />
        <Route path="/pages/:id" element={<h1>Created page</h1>} />
      </Routes>
    </>
  );
}

function renderNewPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/pages/new']}>
        <LazyMotion features={domAnimation}>
          <SignedInShell />
        </LazyMotion>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function editableBody(): Promise<HTMLElement> {
  return waitFor(() => {
    const element = document.querySelector('.ProseMirror');
    if (!(element instanceof HTMLElement)) throw new Error('Editor did not mount');
    expect(element).toHaveAttribute('contenteditable', 'true');
    return element;
  });
}

async function typeBody(text: string) {
  const editor = await editableBody();
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', {
    value: { items: [], files: [], getData: (type: string) => (type === 'text/plain' ? text : '') },
  });
  editor.focus();
  fireEvent(editor, paste);
  await waitFor(() => expect(editor).toHaveTextContent(text));
}

async function signOutFromMenu(username: string) {
  const trigger = screen.getByRole('button', { name: `${username} menu` });
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
  fireEvent.click(await screen.findByText('Sign out'));
  await screen.findByTestId('confirm-dialog');
  fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
  await waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(false));
}

function storedValuesContaining(text: string): string[] {
  const hits: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && localStorage.getItem(key)?.includes(text)) hits.push(key);
  }
  return hits;
}

async function advancePastAutosave() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS + 500);
  });
}

/** Seeds a draft the way the app writes one: through editor-drafts. */
function writeDraftAs(user: typeof ACCOUNT_A, key: string, value: string) {
  useAuthStore.getState().setAuth(`jwt-${user.id}`, user);
  const pending = beginDraftEdit(key);
  if (!pending) throw new Error('expected a signed-in draft scope');
  persistDraft(pending, () => value);
}

let createBodies: unknown[];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  Element.prototype.scrollTo = vi.fn();
  localStorage.clear();
  useAuthStore.getState().setAuth('jwt-a', ACCOUNT_A);
  createBodies = [];

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (url === '/api/spaces' && method === 'GET') return json([
      { key: 'DEV', name: 'Development', homepageId: null, lastSynced: '2026-03-01T00:00:00Z', pageCount: 10 },
    ]);
    if (url === '/api/spaces/local' && method === 'GET') return json([
      { key: 'LOCAL', name: 'Local Space', source: 'local', description: null, icon: null, pageCount: 0, createdBy: null, createdAt: '2026-01-01T00:00:00Z' },
    ]);
    if (url.startsWith('/api/pages/tree')) return json({ items: [], total: 0 });
    if (url === '/api/pages' && method === 'POST') {
      createBodies.push(JSON.parse(String(init?.body)));
      return json({ id: '77', title: 'created', version: 1 });
    }
    if (url === '/api/auth/logout' && method === 'POST') return json({ message: 'Logged out' });
    if (url === '/api/settings') return json({
      inlineCompletionEnabled: false,
      clientInferenceEnabled: false,
      clientInferenceAdminEnabled: false,
      clientSpellcheckEnabled: false,
    });
    if (url === '/api/settings/drawio-url') return json({ drawioEmbedUrl: 'https://draw.example.com' });
    if (url.startsWith('/api/llm/usecase-default')) return json({ message: 'Not configured' }, 404);
    return json({});
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAuthStore.getState().clearAuth();
  useArticleViewStore.getState().setEditing(false);
  useArticleViewStore.getState().setHeadings([]);
  localStorage.clear();
});

// Each case mounts the real TipTap editor up to twice; allow for a busy runner.
describe('New page drafts are recoverable and private to their account (#1747)', { timeout: 15_000 }, () => {
  it('restores the stored draft into the real editor and creates the page with it, clearing both keys', async () => {
    writeDraftAs(ACCOUNT_A, 'new-page', '<p>NEW DRAFT BODY</p>');
    writeDraftAs(ACCOUNT_A, 'new-page:meta', JSON.stringify({ title: 'NEW DRAFT TITLE', spaceKey: 'LOCAL', parentId: null }));
    renderNewPage();

    expect(await screen.findByText('Restore draft?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(await editableBody()).toHaveTextContent('NEW DRAFT BODY');
    expect(screen.getByTestId('title-input')).toHaveValue('NEW DRAFT TITLE');
    await waitFor(() => expect(screen.getByTestId('space-selector')).toHaveValue('LOCAL'));
    expect(screen.getByTestId('article-type-local')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('create-page-button'));
    await screen.findByRole('heading', { name: 'Created page' });
    expect(createBodies).toEqual([
      expect.objectContaining({ spaceKey: 'LOCAL', title: 'NEW DRAFT TITLE', bodyHtml: '<p>NEW DRAFT BODY</p>' }),
    ]);
    expect(readDraft('new-page')).toBeNull();
    expect(readDraft('new-page:meta')).toBeNull();
    await advancePastAutosave();
    expect(readDraft('new-page')).toBeNull();
    expect(readDraft('new-page:meta')).toBeNull();
  });

  it("autosaves both keys, leaves none of A's new page after A signs out, and offers B nothing", async () => {
    renderNewPage();
    fireEvent.change(await screen.findByTestId('title-input'), { target: { value: 'Title secret TT61' } });
    await typeBody('Body secret BB62');
    await advancePastAutosave();
    expect(readDraft('new-page') ?? '').toContain('BB62');
    expect(readDraft('new-page:meta') ?? '').toContain('TT61');

    await signOutFromMenu(ACCOUNT_A.username);
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(storedValuesContaining('TT61')).toEqual([]);
    expect(storedValuesContaining('BB62')).toEqual([]);

    act(() => useAuthStore.getState().setAuth('jwt-b', ACCOUNT_B));
    expect(await screen.findByTestId('title-input')).toHaveValue('');
    await editableBody();
    expect(screen.queryByText('Restore draft?')).not.toBeInTheDocument();
  });

  it('leaves nothing behind when A signs out inside the debounce window', async () => {
    renderNewPage();
    fireEvent.change(await screen.findByTestId('title-input'), { target: { value: 'Pending title PT73' } });
    await typeBody('Pending body PB74');
    await signOutFromMenu(ACCOUNT_A.username);
    await screen.findByRole('heading', { name: 'Sign in' });
    await advancePastAutosave();
    expect(storedValuesContaining('PT73')).toEqual([]);
    expect(storedValuesContaining('PB74')).toEqual([]);
  });

  it('keeps the new page for the same account when the session ends without a sign-out', async () => {
    renderNewPage();
    fireEvent.change(await screen.findByTestId('title-input'), { target: { value: 'Expiry title EX81' } });
    await typeBody('Expiry body EX82');
    // Refresh failure / expiry inside the debounce window: the unmount
    // flushes write both keys into A's own scope.
    act(() => useAuthStore.getState().clearAuth());
    await screen.findByRole('heading', { name: 'Sign in' });
    await advancePastAutosave();

    act(() => useAuthStore.getState().setAuth('jwt-a2', ACCOUNT_A));
    expect(await screen.findByText('Restore draft?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(await editableBody()).toHaveTextContent('Expiry body EX82');
    expect(screen.getByTestId('title-input')).toHaveValue('Expiry title EX81');
  });

  it('after Start blank, typing in the real editor rewrites both keys and a later restore offers only the new draft', async () => {
    writeDraftAs(ACCOUNT_A, 'new-page', '<p>OLD BODY OB55</p>');
    writeDraftAs(ACCOUNT_A, 'new-page:meta', JSON.stringify({ title: 'OLD TITLE OT55', spaceKey: 'LOCAL', parentId: null }));
    const first = renderNewPage();
    expect(await screen.findByText('Restore draft?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    await waitFor(() => expect(screen.queryByText('Restore draft?')).not.toBeInTheDocument());

    await typeBody('New body NB55');
    await advancePastAutosave();
    expect(storedValuesContaining('OT55')).toEqual([]);
    expect(storedValuesContaining('OB55')).toEqual([]);
    expect(readDraft('new-page') ?? '').toContain('NB55');

    first.unmount();
    renderNewPage();
    expect(await screen.findByText('Restore draft?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(await editableBody()).toHaveTextContent('New body NB55');
    expect(screen.getByTestId('title-input')).toHaveValue('');
  });

  it('leaving inside the debounce window after Start blank rewrites both keys with the real editor', async () => {
    writeDraftAs(ACCOUNT_A, 'new-page', '<p>OLD BODY OB66</p>');
    writeDraftAs(ACCOUNT_A, 'new-page:meta', JSON.stringify({ title: 'OLD TITLE OT66', spaceKey: 'LOCAL', parentId: null }));
    const first = renderNewPage();
    expect(await screen.findByText('Restore draft?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    await waitFor(() => expect(screen.queryByText('Restore draft?')).not.toBeInTheDocument());

    await typeBody('New body NB66');
    first.unmount();
    expect(storedValuesContaining('OT66')).toEqual([]);
    expect(storedValuesContaining('OB66')).toEqual([]);
    expect(readDraft('new-page') ?? '').toContain('NB66');
    expect(readDraft('new-page:meta')).not.toBeNull();
  });
});
