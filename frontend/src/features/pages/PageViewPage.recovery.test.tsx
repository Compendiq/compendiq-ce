import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { COLLAB_UPGRADE_WINDOW_SEC, CollabCommitSchema } from '@compendiq/contracts';
import { REJOIN_COVERAGE_TIMEOUT_MS } from './collab-rejoin-attempt';
import { toast } from 'sonner';
import { PageViewPage } from './PageViewPage';
import { useAuthStore } from '../../stores/auth-store';
import { useArticleViewStore } from '../../stores/article-view-store';

class Socket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: Socket[] = [];

  readyState = Socket.CONNECTING;
  binaryType = 'arraybuffer';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: Uint8Array[] = [];

  constructor(readonly url: string, readonly protocols: string[]) {
    Socket.instances.push(this);
  }

  open() {
    this.readyState = Socket.OPEN;
    this.onopen?.(new Event('open'));
  }

  send(data: Uint8Array) {
    if (this.readyState !== Socket.OPEN) throw new Error('Socket is not open');
    this.sent.push(data.slice());
  }

  receive(data: Uint8Array) {
    if (this.readyState === Socket.OPEN) {
      this.onmessage?.(new MessageEvent('message', { data: data.slice().buffer }));
    }
  }

  close(code = 1000, reason = '') {
    if (this.readyState === Socket.CLOSED) return;
    this.readyState = Socket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }
}

function sendControl(socket: Socket, value: unknown) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 4);
  encoding.writeVarString(encoder, JSON.stringify(value));
  socket.receive(encoding.toUint8Array(encoder));
}

function synchronize(socket: Socket) {
  const server = new Y.Doc();
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeSyncStep2(encoder, server);
  socket.receive(encoding.toUint8Array(encoder));
  server.destroy();
}

function lifecycle(revision: string, frozen = false) {
  return {
    type: 'page_lifecycle',
    pageId: 42,
    lifecycleRevision: revision,
    isFrozen: frozen,
    baselineId: frozen ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null,
  };
}

const initialPage = {
  id: '42',
  confluenceId: null,
  title: 'Recovery article',
  spaceKey: null,
  pageType: 'page',
  bodyHtml: '<p>Published body</p>',
  bodyText: 'Published body',
  version: 1,
  parentId: null,
  labels: [],
  author: 'me',
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
  visibility: 'private',
  createdByUserId: 'self',
  lifecycleRevision: '1',
  isFrozen: false,
  canMutateContent: true,
};

const secondPage = {
  ...initialPage,
  id: '43',
  title: 'Second recovery article',
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function TestShell() {
  return (
    <>
      <Link to="/elsewhere">Leave article</Link>
      <Link to="/pages/43">Next article</Link>
      <Routes>
        <Route path="/pages/:id" element={<PageViewPage />} />
        <Route path="/elsewhere" element={<h1>Elsewhere</h1>} />
      </Routes>
    </>
  );
}

function renderPage(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/pages/42']}>
        <LazyMotion features={domAnimation}>
          <TestShell />
        </LazyMotion>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

/** Clicks Edit with collaboration on and returns the first, not yet open, socket. */
async function startCollabEdit(): Promise<Socket> {
  expect(Socket.instances).toHaveLength(0);
  await waitFor(() => {
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/collab/config')).toBe(true);
  });
  fireEvent.click(await screen.findByRole('button', { name: /^Edit/ }));
  await waitFor(() => expect(Socket.instances).toHaveLength(1));
  return Socket.instances[0]!;
}

async function joinWritableSession() {
  const socket = await startCollabEdit();
  act(() => {
    socket.open();
    synchronize(socket);
    sendControl(socket, { type: 'writable_admission', lifecycleRevision: '1' });
  });
  await waitFor(() => {
    expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
  });
  return socket;
}

async function pasteBodyText(text: string) {
  const editor = document.querySelector('.ProseMirror');
  if (!(editor instanceof HTMLElement)) throw new Error('ProseMirror editor did not mount');
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', {
    value: {
      items: [],
      files: [],
      getData: (type: string) => type === 'text/plain' ? text : '',
    },
  });
  editor.focus();
  fireEvent(editor, paste);
  await waitFor(() => expect(editor).toHaveTextContent(text));
}

let currentPage = initialPage;
let rejectNextPageRead = false;
let deferredPageRead: Promise<typeof initialPage> | null = null;
let fetchMock: Mock;
let collabEnabled = true;
let deferredCollabConfig: Promise<{ enabled: boolean }> | null = null;
let commitMode: 'success' | 'confluence_modified' = 'success';
let deferredCommit: Promise<void> | null = null;
let pageUpdateMode: 'success' | 'failure' = 'success';
let deferredPageUpdate: Promise<void> | null = null;

beforeEach(() => {
  Socket.instances = [];
  currentPage = initialPage;
  rejectNextPageRead = false;
  deferredPageRead = null;
  collabEnabled = true;
  deferredCollabConfig = null;
  commitMode = 'success';
  deferredCommit = null;
  pageUpdateMode = 'success';
  deferredPageUpdate = null;
  vi.stubGlobal('WebSocket', Socket);
  Element.prototype.scrollTo = vi.fn();
  localStorage.clear();
  useAuthStore.getState().setAuth('jwt-test', {
    id: 'self',
    username: 'me',
    role: 'user',
  });

  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (url === '/api/pages/42' && method === 'GET') {
      if (rejectNextPageRead) {
        rejectNextPageRead = false;
        throw new TypeError('Failed to fetch');
      }
      if (deferredPageRead) {
        const page = await deferredPageRead;
        deferredPageRead = null;
        return json(page);
      }
      return json(currentPage);
    }
    if (url === '/api/pages/43' && method === 'GET') return json(secondPage);
    if (url === '/api/pages/42' && method === 'PUT') {
      if (deferredPageUpdate) await deferredPageUpdate;
      if (pageUpdateMode === 'failure') {
        return json({ message: 'Temporary save failure. Please try again.' }, 500);
      }
      const body = JSON.parse(String(init?.body)) as { title: string; bodyHtml: string };
      currentPage = {
        ...currentPage,
        title: body.title,
        bodyHtml: body.bodyHtml,
        bodyText: body.bodyHtml,
        version: currentPage.version + 1,
      };
      return json({
        id: Number(currentPage.id),
        title: currentPage.title,
        version: currentPage.version,
      });
    }
    if (url === '/api/collab/config') {
      if (deferredCollabConfig) return json(await deferredCollabConfig);
      return json({ enabled: collabEnabled });
    }
    if (url === '/api/pages/42/collab/commit' && method === 'POST') {
      if (deferredCommit) await deferredCommit;
      if (commitMode === 'confluence_modified') {
        return json({
          message: 'This page was modified in Confluence.',
          code: 'confluence_modified',
          remoteVersion: 9,
          localVersion: 1,
        }, 409);
      }
      const body = CollabCommitSchema.parse(JSON.parse(String(init?.body)));
      currentPage = {
        ...currentPage,
        title: body.title,
        version: currentPage.version + 1,
      };
      return json({
        id: Number(currentPage.id),
        title: currentPage.title,
        version: currentPage.version,
        source: currentPage.source,
      });
    }
    if (url === '/api/settings') return json({
      inlineCompletionEnabled: false,
      clientInferenceEnabled: false,
      clientInferenceAdminEnabled: false,
      clientSpellcheckEnabled: false,
    });
    if (url === '/api/settings/drawio-url') return json({ drawioEmbedUrl: 'https://draw.example.com' });
    if (url === '/api/pages/filters') return json({ authors: [], labels: [] });
    if (url === '/api/pages/pinned') return json({ items: [], total: 0 });
    if (url === '/api/pages/42/connections' || url === '/api/pages/43/connections') {
      return json({ linked: [], section: [], related: [] });
    }
    if (url.startsWith('/api/llm/usecase-default')) return json({ message: 'Not configured' }, 404);
    if ((url === '/api/pages/42/presence' || url === '/api/pages/43/presence') && method === 'GET') {
      return new Response(null, { status: 403 });
    }
    if (url.startsWith('/api/pages/42/presence') || url.startsWith('/api/pages/43/presence')) {
      return new Response(null, { status: 204 });
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAuthStore.getState().clearAuth();
  useArticleViewStore.getState().setEditing(false);
  useArticleViewStore.getState().setHeadings([]);
});

describe('PageViewPage save and collaboration recovery', () => {
  it('keeps a dirty offline draft when navigation is cancelled and warns before unload', async () => {
    renderPage();
    const socket = await joinWritableSession();
    await pasteBodyText('Offline recovery draft');
    act(() => socket.close(1006, 'offline'));
    expect(await screen.findByText('Working offline')).toBeInTheDocument();

    const unload = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    expect(window.dispatchEvent(unload)).toBe(false);
    expect(unload.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole('link', { name: 'Leave article' }));
    expect(await screen.findByRole('heading', { name: 'Discard draft and leave?' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep draft' }));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Discard draft and leave?' })).not.toBeInTheDocument();
    });
    expect(document.querySelector('.ProseMirror')).toHaveTextContent('Offline recovery draft');

    fireEvent.click(screen.getByRole('link', { name: 'Leave article' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard draft and leave' }));
    expect(await screen.findByRole('heading', { name: 'Elsewhere' })).toBeInTheDocument();
  });

  it('guards a connected dirty body because write admission is not a durable acknowledgment', async () => {
    renderPage();
    await joinWritableSession();
    await pasteBodyText('Connected shared body');

    const unload = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    expect(window.dispatchEvent(unload)).toBe(false);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('heading', { name: 'Discard changes?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(document.querySelector('.ProseMirror')).toHaveTextContent('Connected shared body');
  });

  it('closes an untouched collaborative document without a dirty prompt and restores focus', async () => {
    renderPage();
    await joinWritableSession();
    const unload = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    expect(window.dispatchEvent(unload)).toBe(true);
    const done = screen.getByRole('button', { name: 'Done' });
    done.focus();
    fireEvent.click(done);
    const heading = await screen.findByRole('heading', { level: 1, name: initialPage.title });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.queryByRole('heading', { name: 'Discard changes?' })).not.toBeInTheDocument();
  });

  it('keeps focus on a surviving control when a clean editor closes', async () => {
    renderPage();
    await joinWritableSession();
    const outside = screen.getByRole('link', { name: 'Leave article' });
    outside.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await screen.findByRole('heading', { level: 1, name: initialPage.title });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(outside).toHaveFocus();
  });


  it('keeps editing local when collaboration is disabled by the server', async () => {
    collabEnabled = false;
    renderPage();

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/collab/config')).toBe(true);
    });
    fireEvent.click(await screen.findByRole('button', { name: /^Edit/ }));
    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
    });
    expect(Socket.instances).toHaveLength(0);
  });

  it('keeps a locally started editor local when collaboration config arrives late', async () => {
    const config = Promise.withResolvers<{ enabled: boolean }>();
    deferredCollabConfig = config.promise;
    renderPage();

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/collab/config')).toBe(true);
    });
    fireEvent.click(await screen.findByRole('button', { name: /^Edit/ }));
    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
    });
    expect(Socket.instances).toHaveLength(0);

    await act(async () => {
      config.resolve({ enabled: true });
    });
    expect(Socket.instances).toHaveLength(0);
    expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
  });

  it('confirms before leaving a connected session with a local title change', async () => {
    renderPage();
    await joinWritableSession();
    fireEvent.change(screen.getByLabelText('Page title'), {
      target: { value: 'Unsaved collaborative title' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('heading', { name: 'Discard changes?' })).toBeInTheDocument();
    const unload = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    expect(window.dispatchEvent(unload)).toBe(false);

    expect(screen.getByLabelText('Page title')).toHaveValue('Unsaved collaborative title');
  });

  it('single-flights repeated keyboard saves through the collaborative commit', async () => {
    const commit = Promise.withResolvers<void>();
    deferredCommit = commit.promise;
    renderPage();
    await joinWritableSession();
    fireEvent.change(screen.getByLabelText('Page title'), {
      target: { value: 'Committed collaborative title' },
    });
    const editor = document.querySelector('.ProseMirror');
    if (!(editor instanceof HTMLElement)) throw new Error('Editor did not mount');

    fireEvent.keyDown(editor, { key: 's', code: 'KeyS', ctrlKey: true });
    fireEvent.keyDown(editor, { key: 's', code: 'KeyS', ctrlKey: true });

    await waitFor(() => expect(
      fetchMock.mock.calls.filter(([url]) => url === '/api/pages/42/collab/commit'),
    ).toHaveLength(1));
    await act(async () => commit.resolve());
    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'Committed collaborative title',
    })).toBeInTheDocument();
  });

  it('keeps an accepted save visibly pending across discard and a retained page transition', async () => {
    const commit = Promise.withResolvers<void>();
    deferredCommit = commit.promise;
    renderPage();
    await joinWritableSession();
    fireEvent.change(screen.getByLabelText('Page title'), {
      target: { value: 'First session save' },
    });
    const firstEditor = document.querySelector('.ProseMirror');
    if (!(firstEditor instanceof HTMLElement)) throw new Error('Editor did not mount');

    fireEvent.keyDown(firstEditor, { key: 's', code: 'KeyS', ctrlKey: true });
    await waitFor(() => expect(
      fetchMock.mock.calls.filter(([url]) => url === '/api/pages/42/collab/commit'),
    ).toHaveLength(1));

    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeEnabled();
    fireEvent.click(done);
    expect(await screen.findByRole('heading', { name: 'Discard changes?' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    const pendingEdit = await screen.findByTestId('edit-page-btn');
    expect(pendingEdit).toBeDisabled();
    expect(pendingEdit).toHaveTextContent('Finishing save…');
    expect(screen.queryByLabelText('Page title')).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'e', code: 'KeyE', ctrlKey: true });
    expect(screen.queryByLabelText('Page title')).not.toBeInTheDocument();
    expect(screen.getByTestId('edit-page-btn')).toBeDisabled();

    fireEvent.click(screen.getByRole('link', { name: 'Next article' }));
    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'Second recovery article',
    })).toBeInTheDocument();
    expect(screen.getByTestId('edit-page-btn')).toBeDisabled();
    expect(screen.getByTestId('edit-page-btn')).toHaveTextContent('Finishing save…');

    await act(async () => commit.resolve());
    await waitFor(() => expect(screen.getByTestId('edit-page-btn')).toBeEnabled());
    expect(screen.getByTestId('edit-page-btn')).toHaveTextContent('Edit');
    expect(fetchMock.mock.calls.filter(
      ([url]) => url === '/api/pages/42/collab/commit',
    )).toHaveLength(1);
  });

  it('single-flights rapid keyboard saves before the standalone PUT starts', async () => {
    collabEnabled = false;
    const update = Promise.withResolvers<void>();
    deferredPageUpdate = update.promise;
    renderPage();
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/collab/config')).toBe(true);
    });
    fireEvent.click(await screen.findByRole('button', { name: /^Edit/ }));
    const editor = await waitFor(() => {
      const element = document.querySelector('.ProseMirror');
      if (!(element instanceof HTMLElement)) throw new Error('Editor did not mount');
      return element;
    });
    fireEvent.change(screen.getByLabelText('Page title'), {
      target: { value: 'Single-flight standalone title' },
    });

    fireEvent.keyDown(editor, { key: 's', code: 'KeyS', ctrlKey: true });
    fireEvent.keyDown(editor, { key: 's', code: 'KeyS', ctrlKey: true });

    await waitFor(() => expect(
      fetchMock.mock.calls.filter(([url, init]) =>
        url === '/api/pages/42' && (init?.method ?? 'GET') === 'PUT'),
    ).toHaveLength(1));
    await act(async () => update.resolve());
    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'Single-flight standalone title',
    })).toBeInTheDocument();
  });

  it('releases the keyboard save flight after failure so a genuine retry succeeds', async () => {
    collabEnabled = false;
    pageUpdateMode = 'failure';
    const failedUpdate = Promise.withResolvers<void>();
    deferredPageUpdate = failedUpdate.promise;
    renderPage();
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/collab/config')).toBe(true);
    });
    fireEvent.click(await screen.findByRole('button', { name: /^Edit/ }));
    const editor = await waitFor(() => {
      const element = document.querySelector('.ProseMirror');
      if (!(element instanceof HTMLElement)) throw new Error('Editor did not mount');
      return element;
    });
    fireEvent.change(screen.getByLabelText('Page title'), {
      target: { value: 'Retry succeeds' },
    });

    fireEvent.keyDown(editor, { key: 's', code: 'KeyS', ctrlKey: true });
    await waitFor(() => expect(
      fetchMock.mock.calls.filter(([url, init]) =>
        url === '/api/pages/42' && (init?.method ?? 'GET') === 'PUT'),
    ).toHaveLength(1));
    await act(async () => failedUpdate.resolve());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());

    deferredPageUpdate = null;
    pageUpdateMode = 'success';
    fireEvent.keyDown(editor, { key: 's', code: 'KeyS', ctrlKey: true });

    await waitFor(() => expect(
      fetchMock.mock.calls.filter(([url, init]) =>
        url === '/api/pages/42' && (init?.method ?? 'GET') === 'PUT'),
    ).toHaveLength(2));
    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'Retry succeeds',
    })).toBeInTheDocument();
  });

  it('keeps a newer local deletion open after the captured version saves', async () => {
    let finishCommit!: () => void;
    deferredCommit = new Promise<void>((resolve) => { finishCommit = resolve; });
    renderPage();
    await joinWritableSession();
    await pasteBodyText('Delete me after Save starts');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(
      fetchMock.mock.calls.some(([url]) => url === '/api/pages/42/collab/commit'),
    ).toBe(true));

    const editor = document.querySelector('.ProseMirror');
    if (!(editor instanceof HTMLElement)) throw new Error('Editor did not mount');
    editor.focus();
    fireEvent.keyDown(editor, { key: 'a', code: 'KeyA', ctrlKey: true });
    fireEvent.keyDown(editor, { key: 'Backspace', code: 'Backspace', keyCode: 8 });
    await waitFor(() => expect(editor).not.toHaveTextContent('Delete me after Save starts'));
    await act(async () => { finishCommit(); });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(editor).toHaveAttribute('contenteditable', 'true');
    expect(editor).not.toHaveTextContent('Delete me after Save starts');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });

  it('keeps a title edited while Save is pending instead of closing over it', async () => {
    let finishCommit!: () => void;
    deferredCommit = new Promise<void>((resolve) => { finishCommit = resolve; });
    renderPage();
    await joinWritableSession();
    fireEvent.change(screen.getByLabelText('Page title'), { target: { value: 'Captured title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(
      fetchMock.mock.calls.some(([url]) => url === '/api/pages/42/collab/commit'),
    ).toBe(true));
    fireEvent.change(screen.getByLabelText('Page title'), { target: { value: 'Newer local title' } });
    await act(async () => { finishCommit(); });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(screen.getByLabelText('Page title')).toHaveValue('Newer local title');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });

  it('keeps the collaboration editor open when the commit reports a Confluence conflict', async () => {
    commitMode = 'confluence_modified';
    renderPage();
    await joinWritableSession();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByTestId('confluence-modified-alert')).toBeInTheDocument();
    expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('opens the fresh current version after a lifecycle block and focuses its heading', async () => {
    renderPage();
    const socket = await joinWritableSession();
    fireEvent.change(screen.getByLabelText('Page title'), {
      target: { value: 'Retired local draft' },
    });
    act(() => sendControl(socket, lifecycle('2', true)));
    expect(await screen.findByText('This editing session is now read-only')).toBeInTheDocument();

    currentPage = {
      ...initialPage,
      title: 'Current server article',
      version: 2,
      lifecycleRevision: '2',
    };
    fireEvent.click(screen.getByRole('button', { name: 'Open current version' }));
    const confirm = await screen.findByTestId('confirm-dialog-confirm');
    confirm.focus();
    fireEvent.click(confirm);

    const heading = await screen.findByRole('heading', { level: 1, name: 'Current server article' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.queryByLabelText('Page title')).not.toBeInTheDocument();
  });


  it('does not take focus when the user moves within the dialog while recovery is pending', async () => {
    renderPage();
    const socket = await joinWritableSession();
    fireEvent.change(screen.getByLabelText('Page title'), {
      target: { value: 'Retired local draft' },
    });
    act(() => sendControl(socket, lifecycle('2', true)));
    expect(await screen.findByText('This editing session is now read-only')).toBeInTheDocument();

    const pageRead = Promise.withResolvers<typeof initialPage>();
    deferredPageRead = pageRead.promise;
    fireEvent.click(screen.getByRole('button', { name: 'Open current version' }));
    const confirm = await screen.findByTestId('confirm-dialog-confirm');
    confirm.focus();
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toHaveTextContent('Opening…'));

    const keepDraft = screen.getByRole('button', { name: 'Keep draft' });
    keepDraft.focus();
    await act(async () => {
      pageRead.resolve({
        ...initialPage,
        title: 'Current server article',
        version: 2,
        lifecycleRevision: '2',
      });
    });

    const heading = await screen.findByRole('heading', { level: 1, name: 'Current server article' });
    expect(heading).not.toHaveFocus();
  });

  it('retains the blocked draft and releases pending recovery UI when refetch rejects', async () => {
    renderPage();
    const socket = await joinWritableSession();
    fireEvent.change(screen.getByLabelText('Page title'), {
      target: { value: 'Draft that must survive' },
    });
    act(() => sendControl(socket, lifecycle('2', true)));
    expect(await screen.findByText('This editing session is now read-only')).toBeInTheDocument();

    rejectNextPageRead = true;
    fireEvent.click(screen.getByRole('button', { name: 'Open current version' }));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog-confirm')).toHaveTextContent('Open current version');
    });
    expect(screen.getByLabelText('Page title')).toHaveValue('Draft that must survive');
    expect(screen.getByText('This editing session is now read-only')).toBeInTheDocument();
  });
});

describe('collaborative join before the first sync (#1895)', () => {
  const pageReads = () => fetchMock.mock.calls.filter(
    ([url, init]) => url === '/api/pages/42' && (init?.method ?? 'GET') === 'GET',
  ).length;

  it('shows one join message, no read-only banner and no Download draft when the first join is refused', async () => {
    renderPage();
    const socket = await startCollabEdit();
    act(() => { socket.open(); socket.close(4403, 'forbidden'); });

    expect(await screen.findByTestId('collab-join-error')).toHaveTextContent('You cannot join this collaborative session.');
    expect(screen.queryByText('This editing session is now read-only')).not.toBeInTheDocument();
    expect(screen.queryByText(/Your open draft remains below/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download draft' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('collab-join-retry')).not.toBeInTheDocument();
    expect(screen.getByTestId('save-page-btn')).toBeDisabled();
    expect(screen.getByText('Tags are read-only')).toBeInTheDocument();
  });

  it('keeps Retry inert for a rate-limited join until the server window has passed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPage();
      const socket = await startCollabEdit();
      act(() => { socket.open(); socket.close(4403, 'rate_limited'); });

      expect(await screen.findByTestId('collab-join-error'))
        .toHaveTextContent('Too many connection attempts. Retry becomes available after a minute.');
      expect(screen.queryByText('This editing session is now read-only')).not.toBeInTheDocument();
      const retry = screen.getByRole('button', { name: 'Retry' });
      // Unavailable, never native `disabled`: a disabled control drops focus.
      expect(retry).toHaveAttribute('aria-disabled', 'true');
      expect(retry).toBeEnabled();
      retry.focus();
      fireEvent.click(retry);
      expect(Socket.instances).toHaveLength(1);
      expect(retry).toHaveFocus();

      await act(async () => { await vi.advanceTimersByTimeAsync(COLLAB_UPGRADE_WINDOW_SEC * 1000); });
      expect(screen.getByTestId('collab-join-error')).toHaveTextContent('Too many connection attempts. You can retry now.');
      expect(retry).not.toHaveAttribute('aria-disabled');
      fireEvent.click(retry);
      await waitFor(() => expect(Socket.instances).toHaveLength(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries an interrupted join from the editor slot and rehomes focus to the editor column', async () => {
    renderPage();
    const socket = await startCollabEdit();
    act(() => { socket.open(); socket.close(4403, 'readonly'); });

    expect(await screen.findByTestId('collab-join-error'))
      .toHaveTextContent('The collaborative session closed before it finished loading.');
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).not.toHaveAttribute('aria-disabled');
    retry.focus();
    fireEvent.click(retry);

    await waitFor(() => expect(Socket.instances).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Retrying…' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('collab-connecting')).toHaveTextContent('Connecting to the collaborative session…');

    const rejoin = Socket.instances[1]!;
    act(() => {
      rejoin.open();
      synchronize(rejoin);
      sendControl(rejoin, { type: 'writable_admission', lifecycleRevision: '1' });
    });
    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
    });
    // The focus target is a named region, so a screen reader announces where focus went.
    await waitFor(() => expect(screen.getByRole('region', { name: 'Page body' })).toHaveFocus());
  });

  it.each([
    {
      refusal: 'permission_loss',
      refuse: (socket: Socket) => sendControl(socket, { type: 'permission_loss', reason: 'edit_permission_revoked' }),
      message: 'You can view this page but cannot edit it.',
    },
    {
      refusal: 'a newer lifecycle',
      refuse: (socket: Socket) => sendControl(socket, lifecycle('2')),
      message: 'This page changed while the editor was opening. Close the editor and open it again to edit the current version.',
    },
    {
      refusal: 'a frozen lifecycle',
      refuse: (socket: Socket) => sendControl(socket, lifecycle('2', true)),
      message: 'This page is frozen, so it cannot be edited.',
    },
    {
      refusal: 'tombstone',
      refuse: (socket: Socket) => sendControl(socket, { type: 'tombstone' }),
      message: 'This page is no longer available for collaborative editing.',
    },
    {
      refusal: 'a doc_reset close',
      refuse: (socket: Socket) => socket.close(1001, 'doc_reset'),
      message: 'This page was replaced while the editor was opening. Close the editor and open it again to edit the current version.',
    },
  ])('settles a join Retry that the server refuses with $refusal before the first sync', async ({ refuse, message }) => {
    renderPage();
    const socket = await startCollabEdit();
    act(() => { socket.open(); socket.close(4403, 'readonly'); });
    const retry = await screen.findByRole('button', { name: 'Retry' });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(Socket.instances).toHaveLength(2));

    const rejoin = Socket.instances[1]!;
    act(() => {
      rejoin.open();
      refuse(rejoin);
    });

    expect(await screen.findByTestId('collab-join-error')).toHaveTextContent(message);
    // The attempt has settled: no inert "Retrying…" left beside the refusal.
    expect(screen.queryByTestId('collab-join-retry')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('region', { name: 'Page body' })).toHaveFocus());
  });

  it('keeps title, tags and Save locked until the first sync even after writable admission', async () => {
    renderPage();
    const socket = await startCollabEdit();
    act(() => {
      socket.open();
      sendControl(socket, lifecycle('1'));
      sendControl(socket, { type: 'writable_admission', lifecycleRevision: '1' });
    });

    expect(await screen.findByTestId('collab-connecting')).toHaveTextContent('Connecting to the collaborative session…');
    expect(screen.getByLabelText('Page title')).toHaveAttribute('readonly');
    expect(screen.getByTestId('save-page-btn')).toBeDisabled();
    expect(screen.getByText('Tags are read-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add tags' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('page-title-add-icon')).not.toBeInTheDocument();

    const info = vi.spyOn(toast, 'info');
    fireEvent.keyDown(document, { key: 's', code: 'KeyS', ctrlKey: true });
    expect(info).toHaveBeenCalledWith('There is nothing to save yet: the collaborative session has not loaded.');
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/pages/42/collab/commit')).toBe(false);

    act(() => synchronize(socket));
    await waitFor(() => expect(screen.getByLabelText('Page title')).not.toHaveAttribute('readonly'));
    expect(screen.getByTestId('save-page-btn')).toBeEnabled();
    expect(screen.getByTestId('page-title-add-icon')).toBeInTheDocument();
  });

  it.each([
    [1006, 'offline'],
    [1013, 'join_backlog'],
  ])('names a transient close %i before the first sync as a connection problem', async (code, reason) => {
    renderPage();
    const socket = await startCollabEdit();
    act(() => { socket.open(); socket.close(code, reason); });

    expect(await screen.findByTestId('collab-connecting'))
      .toHaveTextContent('Could not connect to the collaborative session. Retrying…');
    expect(screen.queryByTestId('collab-join-error')).not.toBeInTheDocument();
    expect(screen.queryByText('This editing session is now read-only')).not.toBeInTheDocument();
  });

  it.each([
    {
      refusal: 'writable_refused',
      refuse: (socket: Socket) => sendControl(socket, {
        type: 'writable_refused',
        reason: 'lifecycle_revision_stale',
        expectedLifecycleRevision: '1',
        currentLifecycleRevision: '2',
      }),
      message: 'This page changed while the editor was opening. Close the editor and open it again to edit the current version.',
      refetchesPage: true,
    },
    {
      refusal: 'permission_loss',
      refuse: (socket: Socket) => sendControl(socket, { type: 'permission_loss', reason: 'edit_permission_revoked' }),
      message: 'You can view this page but cannot edit it.',
      refetchesPage: false,
    },
    {
      refusal: 'frozen lifecycle',
      refuse: (socket: Socket) => sendControl(socket, lifecycle('2', true)),
      message: 'This page is frozen, so it cannot be edited.',
      refetchesPage: true,
    },
    {
      refusal: 'doc_reset close',
      refuse: (socket: Socket) => socket.close(1001, 'doc_reset'),
      message: 'This page was replaced while the editor was opening. Close the editor and open it again to edit the current version.',
      refetchesPage: true,
    },
  ])('names a pre-sync $refusal refusal without a draft', async ({ refuse, message, refetchesPage }) => {
    renderPage();
    const socket = await startCollabEdit();
    act(() => socket.open());
    const readsBefore = pageReads();
    act(() => refuse(socket));

    expect(await screen.findByTestId('collab-join-error')).toHaveTextContent(message);
    expect(screen.queryByText('This editing session is now read-only')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download draft' })).not.toBeInTheDocument();
    expect(screen.getByTestId('save-page-btn')).toBeDisabled();
    await waitFor(() => expect(pageReads() > readsBefore).toBe(refetchesPage));
  });

  it.each([
    ['flag_off', 'Collaborative editing was turned off. Your open draft remains below and is not reapplied automatically.'],
    ['rate_limited', 'Too many connection attempts from your account. Your open draft remains below and is not reapplied automatically.'],
    ['readonly', 'The server stopped accepting changes from this tab. Your open draft remains below and is not reapplied automatically.'],
    ['forbidden', 'The page or your access changed. Your open draft remains below and is not reapplied automatically.'],
  ])('keeps the read-only draft treatment for a 4403 %s after the first sync (#1927)', async (reason, sentence) => {
    renderPage();
    const socket = await joinWritableSession();
    await pasteBodyText('Synced draft body');
    act(() => socket.close(4403, reason));

    expect(await screen.findByText('This editing session is now read-only')).toBeInTheDocument();
    expect(screen.getByText(sentence)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download draft' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open current version' })).toBeInTheDocument();
    expect(screen.getByTestId('save-page-btn')).toBeDisabled();
    expect(document.querySelector('.ProseMirror')).toHaveTextContent('Synced draft body');
    expect(screen.queryByTestId('collab-join-error')).not.toBeInTheDocument();
  });

  it.each([
    ['is still pending', (gate: PromiseWithResolvers<{ enabled: boolean }>) => gate.resolve({ enabled: false })],
    ['fails', (gate: PromiseWithResolvers<{ enabled: boolean }>) => gate.reject(new TypeError('Failed to fetch'))],
  ])('opens no new collaborative join after a post-sync 4403 flag_off while the config refresh %s (#1927)', async (_name, settle) => {
    const client = renderPage();
    const socket = await joinWritableSession();
    const configReads = () => fetchMock.mock.calls.filter(([url]) => url === '/api/collab/config').length;
    const readsBefore = configReads();
    const gate = Promise.withResolvers<{ enabled: boolean }>();
    gate.promise.catch(() => undefined);
    deferredCollabConfig = gate.promise;
    act(() => socket.close(4403, 'flag_off'));

    expect(await screen.findByText(
      'Collaborative editing was turned off. Your open draft remains below and is not reapplied automatically.',
    )).toBeInTheDocument();
    await waitFor(() => expect(configReads()).toBe(readsBefore + 1));
    expect(client.getQueryData(['collab-config'])).toEqual({ enabled: false });

    fireEvent.click(screen.getByRole('button', { name: 'Open current version' }));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
    fireEvent.click(await screen.findByRole('button', { name: /^Edit/ }));
    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
    });
    expect(Socket.instances).toHaveLength(1);

    await act(async () => { settle(gate); await gate.promise.catch(() => undefined); });
    expect(Socket.instances).toHaveLength(1);
    expect(client.getQueryData(['collab-config'])).toEqual({ enabled: false });
  });

  it('refetches the collaboration config after flag_off so reopening the editor edits locally', async () => {
    const client = renderPage();
    const socket = await startCollabEdit();
    collabEnabled = false;
    act(() => { socket.open(); socket.close(4403, 'flag_off'); });

    expect(await screen.findByTestId('collab-join-error')).toHaveTextContent(
      'Collaborative editing has been turned off. Close the editor and open it again to edit this page.',
    );
    expect(screen.queryByTestId('collab-join-retry')).not.toBeInTheDocument();
    expect(screen.queryByText('This editing session is now read-only')).not.toBeInTheDocument();
    await waitFor(() => expect(client.getQueryData(['collab-config'])).toEqual({ enabled: false }));

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Edit/ }));
    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
    });
    expect(Socket.instances).toHaveLength(1);
  });
});

describe('unknown collaborative save (#2035)', () => {
  const BANNER = 'A collaborative save of this page did not finish, and its result is unknown. Editing is paused until that save is resolved. Your open draft remains below and is not reapplied automatically.';
  const PRE_SYNC = 'A collaborative save of this page did not finish, and its result is unknown. Editing is paused until that save is resolved.';

  it.each([
    ['the commit_unknown control', (socket: Socket) => {
      sendControl(socket, { type: 'commit_unknown' });
      sendControl(socket, { type: 'permission_loss', reason: 'edit_permission_revoked' });
    }],
    ['the 1001 commit_unknown close', (socket: Socket) => socket.close(1001, 'commit_unknown')],
  ])('keeps the draft read-only with Download draft and Open current version after %s', async (_name, arrive) => {
    renderPage();
    const socket = await joinWritableSession();
    await pasteBodyText('Draft typed before the save failed');

    act(() => arrive(socket));

    expect(await screen.findByText('This editing session is now read-only')).toBeInTheDocument();
    expect(screen.getByText(BANNER)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download draft' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open current version' })).toBeInTheDocument();
    expect(screen.getByTestId('save-page-btn')).toBeDisabled();
    expect(document.querySelector('.ProseMirror')).toHaveTextContent('Draft typed before the save failed');
    expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
    expect(screen.queryByTestId('collab-join-error')).not.toBeInTheDocument();
    expect(Socket.instances).toHaveLength(1);
  });

  it('names the unknown save without draft controls when the join is gated before the first sync', async () => {
    renderPage();
    const socket = await startCollabEdit();
    act(() => {
      socket.open();
      sendControl(socket, { type: 'commit_unknown' });
      sendControl(socket, { type: 'permission_loss', reason: 'edit_permission_revoked' });
    });

    expect(await screen.findByTestId('collab-join-error')).toHaveTextContent(PRE_SYNC);
    expect(screen.queryByText('This editing session is now read-only')).not.toBeInTheDocument();
    expect(screen.queryByText(/Your open draft remains below/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download draft' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('collab-join-retry')).not.toBeInTheDocument();
    expect(screen.getByTestId('save-page-btn')).toBeDisabled();
  });

  it('replaces the Confluence-modified notice when the control arrives after the HTTP error', async () => {
    commitMode = 'confluence_modified';
    renderPage();
    const socket = await joinWritableSession();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('confluence-modified-alert')).toBeInTheDocument();

    act(() => sendControl(socket, { type: 'commit_unknown' }));

    expect(await screen.findByText(BANNER)).toBeInTheDocument();
    expect(screen.queryByTestId('confluence-modified-alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/session is still open/)).not.toBeInTheDocument();
  });

  it('never shows the Confluence-modified notice when the control arrives before the HTTP error', async () => {
    commitMode = 'confluence_modified';
    const commit = Promise.withResolvers<void>();
    deferredCommit = commit.promise;
    renderPage();
    const socket = await joinWritableSession();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(
      fetchMock.mock.calls.filter(([url]) => url === '/api/pages/42/collab/commit'),
    ).toHaveLength(1));

    act(() => sendControl(socket, { type: 'commit_unknown' }));
    expect(await screen.findByText(BANNER)).toBeInTheDocument();
    expect(screen.getByTestId('save-page-btn')).toHaveTextContent('Saving…');
    await act(async () => commit.resolve());
    // The Save flight ends only after the 409 was handled.
    await waitFor(() => expect(screen.getByTestId('save-page-btn')).not.toHaveTextContent('Saving…'));

    expect(screen.getByText(BANNER)).toBeInTheDocument();
    expect(screen.queryByTestId('confluence-modified-alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/session is still open/)).not.toBeInTheDocument();
  });
});

describe('Rejoin of the read-only draft after a post-sync rate_limited (#2036)', () => {
  const EPOCH = '7b0f4c1e-52a8-4d3f-9c6b-1a2b3c4d5e6f';
  const WINDOW_MS = COLLAB_UPGRADE_WINDOW_SEC * 1000;
  const BANNER = 'Too many connection attempts from your account. Your open draft remains below and is not reapplied automatically.';
  const UNCONFIRMED = 'We could not confirm that the server has your draft, so editing stays paused. Download draft saves it as it was before you first pressed Rejoin. You can press Rejoin again.';
  let room: Y.Doc;
  let roomDropsUpdates: boolean;
  let handled: WeakMap<Socket, number>;
  let downloads: Blob[];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    room = new Y.Doc();
    roomDropsUpdates = false;
    handled = new WeakMap();
    downloads = [];
    URL.createObjectURL = vi.fn((blob: Blob) => { downloads.push(blob); return 'blob:draft'; });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    room.destroy();
  });

  /** Answers each sync frame the client sent since the last call, as the room does. */
  function serve(socket: Socket) {
    let index = handled.get(socket) ?? 0;
    for (; index < socket.sent.length; index++) {
      const decoder = decoding.createDecoder(socket.sent[index]!);
      if (decoding.readVarUint(decoder) !== 0) continue;
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, 0);
      // A room that lost the replay still answers every SyncStep1.
      if (roomDropsUpdates && decoding.peekVarUint(decoder) !== syncProtocol.messageYjsSyncStep1) continue;
      syncProtocol.readSyncMessage(decoder, reply, room, 'client');
      if (encoding.length(reply) > 1) socket.receive(encoding.toUint8Array(reply));
    }
    handled.set(socket, index);
  }

  function requestReplay(socket: Socket) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeSyncStep1(encoder, room);
    socket.receive(encoding.toUint8Array(encoder));
  }

  async function joinPinnedSession() {
    const socket = await startCollabEdit();
    act(() => {
      socket.open();
      sendControl(socket, { type: 'doc_epoch', epoch: EPOCH });
      synchronize(socket);
      sendControl(socket, { type: 'writable_admission', lifecycleRevision: '1' });
    });
    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
    });
    return socket;
  }

  /** A pinned session with a typed draft, closed by a post-sync 4403. */
  async function limitedSession(reason = 'rate_limited') {
    renderPage();
    const socket = await joinPinnedSession();
    await pasteBodyText('Typed before the limit');
    act(() => socket.close(4403, reason));
    await screen.findByText('This editing session is now read-only');
  }

  const pressRejoin = async () => {
    await act(async () => { await vi.advanceTimersByTimeAsync(WINDOW_MS); });
    const rejoin = screen.getByRole('button', { name: 'Rejoin' });
    rejoin.focus();
    fireEvent.click(rejoin);
    await waitFor(() => expect(Socket.instances.length).toBeGreaterThan(1));
    return { rejoin, attempt: Socket.instances[Socket.instances.length - 1]! };
  };

  const expectDraftControls = async () => {
    expect(screen.getByText('This editing session is now read-only')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open current version' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download draft' }));
    const saved = JSON.parse(await downloads[downloads.length - 1]!.text()) as { bodyHtml: string };
    expect(saved.bodyHtml).toContain('Typed before the limit');
    expect(screen.getByTestId('save-page-btn')).toBeDisabled();
    expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
    expect(document.querySelector('.ProseMirror')).toHaveTextContent('Typed before the limit');
  };

  it('shows an inert Rejoin beside the draft controls until one full upgrade window has passed', async () => {
    await limitedSession();

    expect(screen.getByText(BANNER)).toBeInTheDocument();
    const rejoin = screen.getByRole('button', { name: 'Rejoin' });
    // Unavailable, never native `disabled`: a disabled control drops focus.
    expect(rejoin).toHaveAttribute('aria-disabled', 'true');
    expect(rejoin).toBeEnabled();
    expect(screen.getByTestId('collab-rejoin-status')).toHaveTextContent('Rejoin becomes available after a minute.');
    rejoin.focus();
    fireEvent.click(rejoin);
    expect(Socket.instances).toHaveLength(1);
    expect(rejoin).toHaveFocus();
    await expectDraftControls();

    // The exact boundary is pinned in use-collab-provider.test.ts; the page's clock also runs in real time.
    await act(async () => { await vi.advanceTimersByTimeAsync(WINDOW_MS - 10_000); });
    expect(rejoin).toHaveAttribute('aria-disabled', 'true');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(rejoin).not.toHaveAttribute('aria-disabled');
    expect(screen.getByTestId('collab-rejoin-status')).toHaveTextContent('You can rejoin now.');
    // The control never retries by itself.
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * WINDOW_MS); });
    expect(Socket.instances).toHaveLength(1);
    await expectDraftControls();
  });

  it('keeps the banner, Download draft and Open current version through the attempt, then edits again once the server holds the draft', async () => {
    await limitedSession();
    const { rejoin, attempt } = await pressRejoin();

    // The control stays mounted and focusable while the attempt runs.
    expect(screen.getByRole('button', { name: 'Rejoining…' })).toBe(rejoin);
    expect(rejoin).toHaveAttribute('aria-disabled', 'true');
    expect(rejoin).toHaveFocus();
    expect(screen.getByTestId('collab-rejoin-status')).toHaveTextContent(
      'Rejoining. Editing resumes once the server is confirmed to hold your draft.',
    );
    fireEvent.click(rejoin);
    expect(Socket.instances).toHaveLength(2);
    await expectDraftControls();

    act(() => {
      attempt.open();
      serve(attempt);
      sendControl(attempt, { type: 'writable_admission', lifecycleRevision: '1' });
    });
    // Admitted, synced and still unproven: nothing is editable yet.
    await expectDraftControls();
    act(() => requestReplay(attempt));
    await act(async () => { await Promise.resolve(); });
    await expectDraftControls();
    act(() => serve(attempt));

    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
    });
    expect(screen.queryByText('This editing session is now read-only')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rejoin/ })).not.toBeInTheDocument();
    // The merge changed nothing: no notice about an earlier copy.
    expect(screen.queryByTestId('collab-merged-copy')).not.toBeInTheDocument();
    expect(document.querySelector('.ProseMirror')).toHaveTextContent('Typed before the limit');
    // The focus the control held is handed to the named editor column, not dropped to <body>.
    await waitFor(() => expect(screen.getByRole('region', { name: 'Page body' })).toHaveFocus());
    expect(Socket.instances).toHaveLength(2);
  });

  it('names an unconfirmed server, keeps Rejoin available and the draft downloadable, and lets it be pressed again', async () => {
    await limitedSession();
    const { rejoin, attempt } = await pressRejoin();
    act(() => { attempt.open(); serve(attempt); sendControl(attempt, { type: 'writable_admission', lifecycleRevision: '1' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(REJOIN_COVERAGE_TIMEOUT_MS); });

    expect(screen.getByTestId('collab-rejoin-status')).toHaveTextContent(UNCONFIRMED);
    expect(screen.getByText(BANNER)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rejoin' })).toBe(rejoin);
    expect(rejoin).not.toHaveAttribute('aria-disabled');
    expect(rejoin).toHaveFocus();
    await expectDraftControls();

    fireEvent.click(rejoin);
    await waitFor(() => expect(Socket.instances).toHaveLength(3));
    expect(screen.getByRole('button', { name: 'Rejoining…' })).toBe(rejoin);
    const again = Socket.instances[2]!;
    act(() => { again.open(); serve(again); sendControl(again, { type: 'writable_admission', lifecycleRevision: '1' }); requestReplay(again); });
    await act(async () => { await Promise.resolve(); });
    act(() => serve(again));
    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
    });
  });

  it('removes Rejoin and rehomes its focus when the attempt is refused, keeping the draft controls', async () => {
    await limitedSession();
    const { attempt } = await pressRejoin();
    act(() => {
      attempt.open();
      sendControl(attempt, { type: 'permission_loss', reason: 'edit_permission_revoked' });
    });

    await waitFor(() => expect(screen.queryByRole('button', { name: /Rejoin/ })).not.toBeInTheDocument());
    expect(screen.getByText('The page or your access changed. Your open draft remains below and is not reapplied automatically.'))
      .toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('region', { name: 'Page body' })).toHaveFocus());
    await expectDraftControls();
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * WINDOW_MS); });
    expect(Socket.instances).toHaveLength(2);
  });

  it('offers no Rejoin for a document that never pinned an epoch', async () => {
    renderPage();
    const socket = await joinWritableSession();
    await pasteBodyText('Typed before the limit');
    act(() => socket.close(4403, 'rate_limited'));
    expect(await screen.findByText(BANNER)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * WINDOW_MS); });
    expect(screen.queryByRole('button', { name: /Rejoin/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('collab-rejoin-status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download draft' })).toBeInTheDocument();
  });

  it.each(['forbidden', 'flag_off', 'readonly', 'something_new', ''])(
    'offers no Rejoin after a pinned 4403 %j',
    async (reason) => {
      await limitedSession(reason);
      await act(async () => { await vi.advanceTimersByTimeAsync(2 * WINDOW_MS); });
      expect(screen.queryByRole('button', { name: /Rejoin/ })).not.toBeInTheDocument();
      expect(screen.queryByTestId('collab-rejoin-status')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Download draft' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Open current version' })).toBeInTheDocument();
      expect(Socket.instances).toHaveLength(1);
    },
  );

  /** The room's published paragraph; the first join hydrates it. */
  function publish(text: string) {
    const paragraph = new Y.XmlElement('paragraph');
    const content = new Y.XmlText();
    content.insert(0, text);
    paragraph.insert(0, [content]);
    room.getXmlFragment('default').push([paragraph]);
  }

  function completeAttempt(socket: Socket) {
    act(() => {
      socket.open();
      serve(socket);
      sendControl(socket, { type: 'writable_admission', lifecycleRevision: '1' });
      requestReplay(socket);
    });
  }

  /** A published paragraph the tab typed into while offline, then removed in the room, then a 4403. */
  async function limitedWithRoomAhead() {
    publish('Published paragraph');
    renderPage();
    const first = await startCollabEdit();
    act(() => {
      first.open();
      sendControl(first, { type: 'doc_epoch', epoch: EPOCH });
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeSyncStep2(encoder, room);
      first.receive(encoding.toUint8Array(encoder));
      sendControl(first, { type: 'writable_admission', lifecycleRevision: '1' });
    });
    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')).toHaveTextContent('Published paragraph');
    });
    // Typed while offline; a peer removes the whole paragraph meanwhile.
    act(() => first.close(1006, 'offline'));
    await pasteBodyText('Typed offline');
    room.transact(() => room.getXmlFragment('default').delete(0, 1));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    const second = Socket.instances[1]!;
    act(() => { second.open(); second.close(4403, 'rate_limited'); });
    await screen.findByText('This editing session is now read-only');
  }

  it('keeps the offline text recoverable through Download draft when the room is ahead and the proof fails', async () => {
    await limitedWithRoomAhead();

    roomDropsUpdates = true;
    const { attempt } = await pressRejoin();
    completeAttempt(attempt);
    await act(async () => { await Promise.resolve(); });
    act(() => serve(attempt));

    // The room's deletion merged into the only open document, taking the text with it.
    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')).not.toHaveTextContent('Typed offline');
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(REJOIN_COVERAGE_TIMEOUT_MS); });
    expect(screen.getByTestId('collab-rejoin-status')).toHaveTextContent(UNCONFIRMED);
    expect(screen.getByTestId('collab-rejoin-status')).not.toHaveTextContent('unchanged');
    for (let press = 0; press < 2; press += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Download draft' }));
      const saved = JSON.parse(await downloads[downloads.length - 1]!.text()) as { bodyHtml: string };
      expect(saved.bodyHtml).toContain('Typed offline');
      if (press === 1) break;
      // Across a further press the export stays the one taken before the first attempt.
      const again = await pressRejoin();
      await act(async () => { await vi.advanceTimersByTimeAsync(REJOIN_COVERAGE_TIMEOUT_MS); });
      expect(again.attempt.readyState).toBe(Socket.CLOSED);
    }
  });

  describe('a successful attempt whose merge removed offline text', () => {
    async function succeedAgainstRoomAhead() {
      await limitedWithRoomAhead();
      const { attempt } = await pressRejoin();
      completeAttempt(attempt);
      await act(async () => { await Promise.resolve(); });
      act(() => serve(attempt));
      // Coverage holds, so editing resumes, with the peer's deletion merged in.
      await waitFor(() => {
        expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
      });
      expect(document.querySelector('.ProseMirror')).not.toHaveTextContent('Typed offline');
      return attempt;
    }

    const downloadedFile = async () => JSON.parse(await downloads[downloads.length - 1]!.text()) as {
      pageId: string; title: string; bodyHtml: string; labels: string[]; lifecycleRevision: string | null;
    };

    it('keeps the earlier copy downloadable until it is downloaded', async () => {
      await succeedAgainstRoomAhead();

      const notice = await screen.findByTestId('collab-merged-copy');
      expect(notice).toHaveTextContent('Your draft was merged with the page');
      expect(screen.queryByText('This editing session is now read-only')).not.toBeInTheDocument();
      const download = screen.getByRole('button', { name: 'Download earlier copy' });
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
      download.focus();
      fireEvent.click(download);

      const saved = JSON.parse(await downloads[downloads.length - 1]!.text()) as { bodyHtml: string };
      expect(saved.bodyHtml).toContain('Typed offline');
      await waitFor(() => expect(screen.queryByTestId('collab-merged-copy')).not.toBeInTheDocument());
      // Keyboard users keep a place: focus goes to the editor column, not <body>.
      await waitFor(() => expect(screen.getByRole('region', { name: 'Page body' })).toHaveFocus());
    });

    it('keeps it until dismissed explicitly, and drops it without a download', async () => {
      await succeedAgainstRoomAhead();

      // Editing carries on; the notice stays.
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * WINDOW_MS); });
      expect(screen.getByTestId('collab-merged-copy')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      await waitFor(() => expect(screen.queryByTestId('collab-merged-copy')).not.toBeInTheDocument());
      expect(downloads).toHaveLength(0);
    });

    it('keeps the copy, with its actions, through a later terminal refusal', async () => {
      const attempt = await succeedAgainstRoomAhead();

      act(() => { attempt.close(4403, 'forbidden'); });
      expect(await screen.findByText('This editing session is now read-only')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Rejoin/ })).not.toBeInTheDocument();
      // Download draft now writes the editor, which no longer has the text; the copy still does.
      fireEvent.click(screen.getByRole('button', { name: 'Download draft' }));
      expect((await downloadedFile()).bodyHtml).not.toContain('Typed offline');
      fireEvent.click(screen.getByRole('button', { name: 'Download earlier copy' }));
      expect((await downloadedFile()).bodyHtml).toContain('Typed offline');
      await waitFor(() => expect(screen.queryByTestId('collab-merged-copy')).not.toBeInTheDocument());
    });

    it('keeps both copies when another merging Rejoin follows in the same session', async () => {
      const attempt = await succeedAgainstRoomAhead();

      // A second limit, then a peer adds a paragraph meanwhile: the next merge changes the draft again.
      act(() => { attempt.close(4403, 'rate_limited'); });
      await screen.findByText('This editing session is now read-only');
      publish('Peer addition');
      const second = await pressRejoin();
      completeAttempt(second.attempt);
      await act(async () => { await Promise.resolve(); });
      act(() => serve(second.attempt));
      await waitFor(() => {
        expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
      });

      const downloads2 = await screen.findAllByRole('button', { name: /^Download earlier copy from / });
      expect(downloads2).toHaveLength(2);
      expect(screen.getAllByRole('button', { name: /^Dismiss copy from / })).toHaveLength(2);
      fireEvent.click(downloads2[0]!);
      const first = await downloadedFile();
      expect(first.bodyHtml).toContain('Typed offline');
      // The other one is still there, and is the draft as it was before the second sequence.
      fireEvent.click(screen.getByRole('button', { name: 'Download earlier copy' }));
      const secondCopy = await downloadedFile();
      expect(secondCopy.bodyHtml).not.toContain('Typed offline');
      expect(secondCopy.bodyHtml).not.toContain('Peer addition');
      await waitFor(() => expect(screen.queryByTestId('collab-merged-copy')).not.toBeInTheDocument());
    });

    it('writes the stored copy unchanged after the title is edited', async () => {
      await succeedAgainstRoomAhead();

      fireEvent.change(screen.getByTestId('edit-title-input'), { target: { value: 'A title typed afterwards' } });
      expect(screen.getByTestId('edit-title-input')).toHaveValue('A title typed afterwards');
      fireEvent.click(screen.getByRole('button', { name: 'Download earlier copy' }));
      expect(await downloadedFile()).toMatchObject({
        pageId: '42', title: 'Recovery article', labels: [], lifecycleRevision: '1',
      });
      expect((await downloadedFile()).bodyHtml).toContain('Typed offline');
    });

    it('hands focus on only when the control owned it: keyboard Dismiss moves to the editor, focus elsewhere stays', async () => {
      await succeedAgainstRoomAhead();

      const title = screen.getByTestId('edit-title-input');
      title.focus();
      // A pointer click that never focused the control leaves focus where it was.
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByTestId('collab-merged-copy')).not.toBeInTheDocument();
      expect(title).toHaveFocus();
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(title).toHaveFocus();
    });

    it('moves focus to the editor column when a focused Dismiss is activated', async () => {
      await succeedAgainstRoomAhead();

      const dismiss = screen.getByRole('button', { name: 'Dismiss' });
      dismiss.focus();
      fireEvent.click(dismiss);
      expect(screen.getByRole('region', { name: 'Page body' })).toHaveFocus();
    });
  });

  it('hands focus to the editor column when the control was only reached by keyboard after the attempt started', async () => {
    await limitedSession();
    await act(async () => { await vi.advanceTimersByTimeAsync(WINDOW_MS); });
    const rejoin = screen.getByRole('button', { name: 'Rejoin' });
    // Activated without taking focus, then reached with Tab while it reads "Rejoining…".
    fireEvent.click(rejoin);
    await waitFor(() => expect(Socket.instances).toHaveLength(2));
    expect(rejoin).not.toHaveFocus();
    rejoin.focus();
    expect(rejoin).toHaveFocus();

    const attempt = Socket.instances[1]!;
    completeAttempt(attempt);
    await act(async () => { await Promise.resolve(); });
    act(() => serve(attempt));
    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
    });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Page body' })).toHaveFocus());
  });

  it('never takes focus from a control that survives the attempt', async () => {
    await limitedSession();
    const { rejoin, attempt } = await pressRejoin();
    const download = screen.getByRole('button', { name: 'Download draft' });
    download.focus();
    expect(rejoin).not.toHaveFocus();
    act(() => {
      attempt.open();
      sendControl(attempt, { type: 'permission_loss', reason: 'edit_permission_revoked' });
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: /Rejoin/ })).not.toBeInTheDocument());
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(download).toHaveFocus();
  });
});
