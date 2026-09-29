import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { PageViewPage } from './PageViewPage';
import { UserMenu } from '../../shared/components/layout/UserMenu';
import { useAuthStore } from '../../stores/auth-store';
import { useArticleViewStore } from '../../stores/article-view-store';

// GHSA-r652-53hc-h6jh: a non-collaborative editor draft of a shared page must
// never be offered to a different account signing in to the same browser.
// Real PageViewPage, Editor, UserMenu, logoutApi and auth store; only the
// network (fetch) is stubbed. Nothing here knows how drafts are stored: every
// storage assertion scans ALL of localStorage for the unpublished text.

const AUTO_SAVE_DELAY_MS = 2000;
const ACCOUNT_A = { id: '11111111-1111-4111-8111-111111111111', username: 'author_a', role: 'user' as const };
const ACCOUNT_B = { id: '22222222-2222-4222-8222-222222222222', username: 'reader_b', role: 'user' as const };

const sharedPage = {
  id: '42',
  confluenceId: null,
  title: 'Shared article',
  spaceKey: null,
  pageType: 'page',
  bodyHtml: '<p>Published baseline</p>',
  bodyText: 'Published baseline',
  version: 1,
  parentId: null,
  labels: [],
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
  createdByUserId: ACCOUNT_A.id,
  lifecycleRevision: '1',
  isFrozen: false,
  canMutateContent: true,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Mirrors App's ProtectedRoute: signing out unmounts the page. */
function SignedInShell({ gate }: { gate: boolean }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (gate && !isAuthenticated) return <h1>Sign in</h1>;
  return (
    <>
      <UserMenu />
      <Routes>
        <Route path="/pages/:id" element={<PageViewPage />} />
      </Routes>
    </>
  );
}

function renderPage({ gate = true }: { gate?: boolean } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/pages/42']}>
        <LazyMotion features={domAnimation}>
          <SignedInShell gate={gate} />
        </LazyMotion>
      </MemoryRouter>
    </QueryClientProvider>,
  );
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

async function typeUnpublished(text: string) {
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

/** B opens the page and presses Edit: the published body, and no restore offer. */
async function expectNoRestoreOffer() {
  await startEditing();
  const editor = await editableBody();
  expect(editor).toHaveTextContent('Published baseline');
  expect(screen.queryByText('Restore draft?')).not.toBeInTheDocument();
}

let fetchMock: Mock;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  Element.prototype.scrollTo = vi.fn();
  localStorage.clear();
  useAuthStore.getState().setAuth('jwt-a', ACCOUNT_A);

  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (url === '/api/pages/42' && method === 'GET') return json(sharedPage);
    if (url === '/api/auth/logout' && method === 'POST') return json({ message: 'Logged out' });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAuthStore.getState().clearAuth();
  useArticleViewStore.getState().setEditing(false);
  useArticleViewStore.getState().setHeadings([]);
  localStorage.clear();
});

// Each case mounts the real TipTap editor up to twice; allow for a busy runner.
describe('PageViewPage local drafts are private to the account that wrote them', { timeout: 15_000 }, () => {
  it("does not offer account A's autosaved draft to account B after A signs out", async () => {
    renderPage();
    await startEditing();
    await typeUnpublished('Unpublished author secret DRAFT7B91');
    await advancePastAutosave();
    // A's own autosave happened: this is what sign-out has to get rid of.
    expect(storedValuesContaining('DRAFT7B91')).not.toHaveLength(0);

    await signOutFromMenu(ACCOUNT_A.username);
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(storedValuesContaining('DRAFT7B91')).toEqual([]);

    act(() => useAuthStore.getState().setAuth('jwt-b', ACCOUNT_B));
    await expectNoRestoreOffer();
    expect(screen.queryByText(/DRAFT7B91/)).not.toBeInTheDocument();
  });

  it('leaves nothing behind when A signs out before the autosave debounce fires', async () => {
    renderPage();
    await startEditing();
    await typeUnpublished('Unsaved second before signing out QX42');
    // No timer advance: sign-out lands inside the debounce window, so the
    // editor's unmount flush is the write that must not happen.
    await signOutFromMenu(ACCOUNT_A.username);
    await screen.findByRole('heading', { name: 'Sign in' });
    await advancePastAutosave();
    expect(storedValuesContaining('QX42')).toEqual([]);

    act(() => useAuthStore.getState().setAuth('jwt-b', ACCOUNT_B));
    await expectNoRestoreOffer();
  });

  it('drops a debounced autosave that fires after sign-out while the editor is still mounted', async () => {
    // Another tab's editor, for example, stays mounted until its logout
    // message arrives; its pending timer must not recreate the draft.
    const { unmount } = renderPage({ gate: false });
    await startEditing();
    await typeUnpublished('Still pending when sign-out completed ZK07');
    await signOutFromMenu(ACCOUNT_A.username);

    await advancePastAutosave();
    expect(storedValuesContaining('ZK07')).toEqual([]);
    unmount();
    expect(storedValuesContaining('ZK07')).toEqual([]);
  });

  it('keeps the draft for the same account when the session ends without a sign-out', async () => {
    renderPage();
    await startEditing();
    await typeUnpublished('Recover me after expiry RC55');
    // Refresh failure / expiry: clearAuth() without an explicit sign-out,
    // inside the debounce window, so the unmount flush writes the draft.
    act(() => useAuthStore.getState().clearAuth());
    await screen.findByRole('heading', { name: 'Sign in' });
    await advancePastAutosave();

    act(() => useAuthStore.getState().setAuth('jwt-a2', ACCOUNT_A));
    await startEditing();
    expect(await screen.findByText('Restore draft?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(await editableBody()).toHaveTextContent('Recover me after expiry RC55');
  });

  it('does not offer a session-expired draft of account A to account B', async () => {
    renderPage();
    await startEditing();
    await typeUnpublished('Expired session content EX19');
    act(() => useAuthStore.getState().clearAuth());
    await screen.findByRole('heading', { name: 'Sign in' });
    await advancePastAutosave();

    act(() => useAuthStore.getState().setAuth('jwt-b', ACCOUNT_B));
    await expectNoRestoreOffer();
  });

  it('never offers a legacy unscoped draft and removes it on sign-out', async () => {
    // Written by a build that stored drafts without an owner.
    localStorage.setItem('draft:page-42', '<p>Legacy ownerless draft LG33</p>');
    renderPage();
    await expectNoRestoreOffer();

    await signOutFromMenu(ACCOUNT_A.username);
    expect(localStorage.getItem('draft:page-42')).toBeNull();
  });
});
