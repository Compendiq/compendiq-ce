import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { CollabCommitSchema } from '@compendiq/contracts';
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
      <Routes>
        <Route path="/pages/:id" element={<PageViewPage />} />
        <Route path="/elsewhere" element={<h1>Elsewhere</h1>} />
      </Routes>
    </>
  );
}

function renderPage() {
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
}

async function joinWritableSession() {
  expect(Socket.instances).toHaveLength(0);
  await waitFor(() => {
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/collab/config')).toBe(true);
  });
  fireEvent.click(await screen.findByRole('button', { name: /^Edit/ }));
  await waitFor(() => expect(Socket.instances).toHaveLength(1));
  const socket = Socket.instances[0]!;
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

beforeEach(() => {
  Socket.instances = [];
  currentPage = initialPage;
  rejectNextPageRead = false;
  deferredPageRead = null;
  collabEnabled = true;
  deferredCollabConfig = null;
  commitMode = 'success';
  deferredCommit = null;
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAuthStore.getState().clearAuth();
  useArticleViewStore.getState().setEditing(false);
  useArticleViewStore.getState().setHeadings([]);
});

describe('PageViewPage dirty collaboration recovery', () => {
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

  it('commits through the collaboration wire with the captured lifecycle revision', async () => {
    renderPage();
    await joinWritableSession();
    fireEvent.change(screen.getByLabelText('Page title'), {
      target: { value: 'Committed collaborative title' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(
      fetchMock.mock.calls.some(([url]) => url === '/api/pages/42/collab/commit'),
    ).toBe(true));
    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'Committed collaborative title',
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
