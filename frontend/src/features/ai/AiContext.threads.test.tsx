/**
 * Per-page thread retention (#1126).
 *
 * These tests mount AiProvider the way AppLayout does — ABOVE the router
 * outlet, not inside the /ai route — because that arrangement is the whole
 * point: a conversation has to outlive the component that started it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../shared/lib/api';
import { AiProvider, useAiContext, nextMessageId, resolveAiPageId } from './AiContext';

Element.prototype.scrollIntoView = vi.fn();

const apiFetchMock = vi.fn();
vi.mock('../../shared/lib/api', async () =>
  (await import('../../test-utils')).apiModuleMock(() => apiFetchMock));

const streamSSEMock = vi.fn();
vi.mock('../../shared/lib/sse', () => ({
  streamSSE: (...args: unknown[]) => streamSSEMock(...args),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

/**
 * Reads and writes the active thread through the public context only — no
 * access to the provider's internals, so these tests describe behavior a user
 * can observe rather than the shape of the thread map.
 */
function ThreadProbe() {
  const {
    pageId, mode, setMode, messages, conversationId, input, activeThreadId, composerFocusRequest,
    streamingThreadId, setMessages, setConversationId, setInput, startNewConversation, runStream,
  } = useAiContext();
  const label = pageId ?? 'no page';

  return (
    <div>
      <span data-testid="context-page">{label}</span>
      <span data-testid="mode">{mode}</span>
      <span data-testid="conversation-id">{conversationId ?? 'none'}</span>
      <span data-testid="draft">{input}</span>
      {/* The identity every switch-sensitive effect keys on (#1361). Read as an
          opaque token: the tests compare it against itself across a gesture,
          never against a literal. */}
      <span data-testid="active-thread">{activeThreadId}</span>
      <span data-testid="focus-request">{composerFocusRequest}</span>
      <span data-testid="streaming-thread">{streamingThreadId ?? 'none'}</span>
      <ul data-testid="thread">
        {messages.map((msg) => (
          <li key={msg.id}>{msg.content}</li>
        ))}
      </ul>
      <button
        onClick={() => {
          setMessages((prev) => [
            ...prev,
            { id: nextMessageId(), role: 'user', content: `question about ${label}` },
          ]);
          setConversationId(`conv-${label}`);
          setInput(`draft for ${label}`);
        }}
      >
        add message
      </button>
      <button
        onClick={() =>
          runStream('/llm/ask', { question: label }, { userMessage: `streamed question about ${label}` })
        }
      >
        stream
      </button>
      <button onClick={startNewConversation}>new conversation</button>
      <button onClick={() => setMode('generate')}>go generate</button>
      <button onClick={() => setInput(`typing on ${label}`)}>type</button>
    </div>
  );
}

/** Walks one entry back, so a test can count what New chat pushed. */
function BackButton() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>back</button>;
}

function NavButton({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(to)}>{`go ${to}`}</button>;
}

/** Not an AI consumer — lets a test see URL rewrites the provider performs. */
function LocationDisplay() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname + location.search}</span>;
}

/**
 * Mount the probe under a hoisted provider, with a nav button per destination.
 * `destinations` are the URLs the test navigates between; each gets a button
 * labelled `go <url>`, clicked via `goTo`.
 */
function renderThreadApp(
  initialEntry: string,
  destinations: string[] = [],
  entriesBefore: string[] = [],
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const entries = [...entriesBefore, initialEntry];
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <AiProvider>
          <LocationDisplay />
          <BackButton />
          {destinations.map((to) => (
            <NavButton key={to} to={to} />
          ))}
          <Routes>
            <Route path="/" element={<div>pages list</div>} />
            <Route path="/ai" element={<ThreadProbe />} />
            <Route path="/ai/c/:conversationId" element={<ThreadProbe />} />
            <Route path="/pages/:id" element={<ThreadProbe />} />
          </Routes>
        </AiProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function goTo(url: string) {
  fireEvent.click(screen.getByText(`go ${url}`));
}

function threadContents(): string[] {
  return Array.from(screen.getByTestId('thread').querySelectorAll('li')).map(
    (li) => li.textContent ?? '',
  );
}

describe('AiContext per-page threads (#1126)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the thread when navigating away from /ai and back', () => {
    renderThreadApp('/ai', ['/', '/ai']);

    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about no page']);

    goTo('/');
    expect(screen.getByText('pages list')).toBeInTheDocument();
    expect(screen.queryByTestId('thread')).not.toBeInTheDocument();

    goTo('/ai');
    expect(threadContents()).toEqual(['question about no page']);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('conv-no page');
    expect(screen.getByTestId('draft')).toHaveTextContent('draft for no page');
  });

  it('swaps threads on a page change instead of destroying them', () => {
    // The dock's contract (#1126): walking the page tree with the assistant
    // open swaps which thread is on screen and destroys none of them. Since
    // #1361 a page context comes only from the article route — `/ai?pageId=`
    // resolves to no document — so this is now written where the dock lives.
    renderThreadApp('/pages/page-a', ['/pages/page-a', '/pages/page-b']);

    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about page-a']);

    // A -> B: B starts empty and must not show A's messages.
    goTo('/pages/page-b');
    expect(screen.getByTestId('context-page')).toHaveTextContent('page-b');
    expect(threadContents()).toEqual([]);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');

    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about page-b']);

    // B -> A: A's thread comes back intact, and is still distinct from B's.
    goTo('/pages/page-a');
    expect(threadContents()).toEqual(['question about page-a']);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('conv-page-a');
    expect(screen.getByTestId('draft')).toHaveTextContent('draft for page-a');

    goTo('/pages/page-b');
    expect(threadContents()).toEqual(['question about page-b']);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('conv-page-b');
  });

  it('gives the no-document case a thread a real page cannot collide with', () => {
    // Pages whose ids are literally the sentinel keys are the adversarial case
    // for the thread-key scheme. Both spellings are checked — 'no-page' is
    // today's sentinel and 'draft' is Task 2's — so renaming it cannot quietly
    // open a collision.
    renderThreadApp('/ai', ['/ai', '/pages/no-page', '/pages/draft']);

    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about no page']);

    goTo('/pages/no-page');
    expect(screen.getByTestId('context-page')).toHaveTextContent('no-page');
    expect(threadContents()).toEqual([]);
    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about no-page']);

    goTo('/pages/draft');
    expect(screen.getByTestId('context-page')).toHaveTextContent('draft');
    expect(threadContents()).toEqual([]);
    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about draft']);

    goTo('/ai');
    expect(threadContents()).toEqual(['question about no page']);
  });

  it('starts a fresh draft on New chat and leaves every other thread alone', () => {
    // #1361 changed what New chat means: it is not "clear the thread you are
    // looking at" any more, it is "put a brand-new draft on screen". From a
    // dock thread that means going to /ai; the dock thread itself is untouched.
    renderThreadApp('/pages/page-a', ['/pages/page-a', '/ai']);

    goTo('/ai');
    fireEvent.click(screen.getByText('add message'));
    goTo('/pages/page-a');
    fireEvent.click(screen.getByText('add message'));

    fireEvent.click(screen.getByText('new conversation'));

    expect(screen.getByTestId('location')).toHaveTextContent('/ai');
    expect(threadContents()).toEqual([]);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
    expect(screen.getByTestId('draft')).toHaveTextContent('');

    goTo('/pages/page-a');
    expect(threadContents()).toEqual(['question about page-a']);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('conv-page-a');
  });

  it('does not stack a history entry when New chat is pressed on /ai', () => {
    // react-router pushes even for a same-path navigate, so an unguarded
    // navigate(AI_HOME_PATH) would bury the page the user came from under n
    // dead /ai entries.
    renderThreadApp('/ai', [], ['/']);

    fireEvent.click(screen.getByText('new conversation'));
    fireEvent.click(screen.getByText('new conversation'));
    fireEvent.click(screen.getByText('back'));

    expect(screen.getByTestId('location')).toHaveTextContent('/');
  });

  it('navigates home when New chat is pressed on a conversation URL', () => {
    renderThreadApp('/ai/c/conv-a');

    fireEvent.click(screen.getByText('new conversation'));

    expect(screen.getByTestId('location')).toHaveTextContent('/ai');
    expect(screen.getByTestId('location').textContent).not.toContain('/c/');
  });

  it('lands a New chat on Ask, whatever action was selected', () => {
    // `mode` is provider-wide and the URL-mode effect does not fire on a
    // same-path navigation, so New chat has to set it itself — otherwise a
    // fresh chat opens on Generate and the composer the focus request is aimed
    // at is not on screen.
    renderThreadApp('/ai');

    fireEvent.click(screen.getByText('go generate'));
    expect(screen.getByTestId('mode')).toHaveTextContent('generate');

    fireEvent.click(screen.getByText('new conversation'));
    expect(screen.getByTestId('mode')).toHaveTextContent('ask');
  });

  it('bumps the composer focus request on New chat', () => {
    renderThreadApp('/ai');
    const before = screen.getByTestId('focus-request').textContent;

    fireEvent.click(screen.getByText('new conversation'));

    expect(screen.getByTestId('focus-request').textContent).not.toBe(before);
  });

  it('evicts the least recently used thread once the retention cap is exceeded', () => {
    // MAX_RETAINED_THREADS is 12, so writing 13 threads must drop the oldest.
    const urls = Array.from({ length: 13 }, (_, i) => `/pages/page-${i}`);
    renderThreadApp(urls[0]!, urls);

    for (const [i, url] of urls.entries()) {
      goTo(url);
      fireEvent.click(screen.getByText('add message'));
      expect(threadContents()).toEqual([`question about page-${i}`]);
    }

    // Since #1361 a bare visit files a thread too (needed to stamp an identity
    // before a person can type), so revisiting an already-evicted key consumes
    // a slot and evicts one more victim of its own — visiting page-0 evicts
    // page-1, so page-1 is checked first, before that visit happens.
    goTo(urls[1]!);
    expect(threadContents()).toEqual(['question about page-1']);
    goTo(urls[0]!);
    expect(threadContents()).toEqual([]);
    goTo(urls[12]!);
    expect(threadContents()).toEqual(['question about page-12']);
  });

  it('commits an aborted stream to the thread that started it, not the one navigated to', async () => {
    // Navigating mid-stream still stops the request, but the partial answer
    // belongs to the page that asked the question.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    streamSSEMock.mockImplementation((_endpoint: string, _body: unknown, signal: AbortSignal) =>
      (async function* () {
        yield { content: 'partial answer' };
        await gate;
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        yield { content: ' and the rest' };
      })(),
    );

    renderThreadApp('/pages/page-a', ['/pages/page-a', '/pages/page-b']);

    fireEvent.click(screen.getByText('stream'));
    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalled();
    });

    goTo('/pages/page-b');
    await act(async () => {
      release();
      await Promise.resolve();
    });

    // B never receives page A's answer.
    expect(screen.getByTestId('context-page')).toHaveTextContent('page-b');
    expect(threadContents()).toEqual([]);

    goTo('/pages/page-a');
    await waitFor(() => {
      expect(threadContents()).toEqual([
        'streamed question about page-a',
        'partial answer',
      ]);
    });
  });

  // The ?q= consumer (#957) rewrites the URL with a replace navigation. It ran
  // on mount of /ai before the hoist; it now sees every route in the app.
  describe('?q= composer prefill is scoped to /ai', () => {
    it('consumes ?q= on /ai', () => {
      renderThreadApp('/ai?q=how do I configure sync');

      expect(screen.getByTestId('draft')).toHaveTextContent('how do I configure sync');
      // Consumed, so refresh/back does not re-prefill an asked question.
      expect(screen.getByTestId('location')).toHaveTextContent('/ai');
      expect(screen.getByTestId('location').textContent).not.toContain('q=');
    });

    it('consumes ?q= on a conversation URL too', () => {
      // The guard is the route FAMILY, not the literal '/ai': CommandPalette's
      // two producers both land on bare /ai, but the prefill has to survive a
      // user pasting ?q= onto the conversation they already have open.
      renderThreadApp('/ai/c/conv-1?q=how do I rotate the PAT');

      expect(screen.getByTestId('draft')).toHaveTextContent('how do I rotate the PAT');
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/conv-1');
      expect(screen.getByTestId('location').textContent).not.toContain('q=');
    });

    it('leaves ?q= alone on a route that is not /ai', () => {
      // CommandPalette only ever puts ?q= on /ai, but the provider must not
      // claim the param from an unrelated page that happens to carry it —
      // that would rewrite that page's URL and hijack its search term.
      renderThreadApp('/pages/page-a?q=someone elses search');

      expect(screen.getByTestId('draft')).toHaveTextContent('');
      expect(screen.getByTestId('location').textContent).toContain('q=someone');
    });
  });

  it('applies an explicit ?mode= when navigating onto /ai', () => {
    // The provider no longer remounts on route entry, so a mode carried in the
    // URL has to be applied reactively. Nothing in the app still produces one:
    // #1126 turned the article rail's link into the dock, and #1176 took the
    // last of its Improve wording with it. Bookmarks and links made before that
    // change still arrive here, which is why the mode screens still render.
    renderThreadApp('/ai', ['/ai?mode=improve&pageId=page-a']);

    expect(screen.getByTestId('mode')).toHaveTextContent('ask');
    goTo('/ai?mode=improve&pageId=page-a');
    expect(screen.getByTestId('mode')).toHaveTextContent('improve');
  });

  // The mode-less half of the same contract, and the reason `SidebarTreeView`
  // cannot strand anyone on a retired screen. Clicking a page while already on
  // /ai navigates to `/ai?pageId=…` — a URL carrying no `mode=` — which has to
  // CLEAR an active mode rather than leave it in place. A sticky `improve`
  // would render a document screen with no tab selected and no route back
  // except the URL bar, since #1126 left /ai offering only Ask and Generate.
  //
  // This is what makes SidebarTreeView the thing that *clears* a mode deep
  // link rather than a source of one — it has never built a `?mode=` URL.
  it('clears an active mode when a navigation carries none, the way SidebarTreeView does', () => {
    renderThreadApp('/ai?mode=improve&pageId=page-a', ['/ai?pageId=page-b']);

    expect(screen.getByTestId('mode')).toHaveTextContent('improve');

    goTo('/ai?pageId=page-b');

    expect(screen.getByTestId('mode')).toHaveTextContent('ask');
  });
});

describe('thread keys follow the location (#1361)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue([]);
  });

  it('gives the draft and each conversation its own thread', () => {
    renderThreadApp('/ai', ['/ai', '/ai/c/conv-a', '/ai/c/conv-b']);

    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about no page']);

    // Opening a conversation is a switch onto a thread of its own — the draft
    // is not "the current thread" that a conversation is loaded into.
    goTo('/ai/c/conv-a');
    expect(threadContents()).toEqual([]);
    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about no page']);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('conv-no page');

    // Two conversations are two threads.
    goTo('/ai/c/conv-b');
    expect(threadContents()).toEqual([]);

    // …and the draft is still where it was left.
    goTo('/ai');
    expect(threadContents()).toEqual(['question about no page']);
  });

  it('keeps the dock thread separate from the draft', () => {
    renderThreadApp('/pages/page-a', ['/pages/page-a', '/ai']);

    fireEvent.click(screen.getByText('add message'));
    goTo('/ai');
    expect(threadContents()).toEqual([]);
    goTo('/pages/page-a');
    expect(threadContents()).toEqual(['question about page-a']);
  });
});

describe('activeThreadId (#1361)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue([]);
  });

  function activeThread(): string {
    return screen.getByTestId('active-thread').textContent ?? '';
  }

  it('changes when a conversation is opened', () => {
    renderThreadApp('/ai', ['/ai/c/conv-a']);
    const before = activeThread();
    goTo('/ai/c/conv-a');
    expect(activeThread()).not.toBe(before);
  });

  it('changes on New chat even when the draft is already empty', () => {
    // The AC that makes Deep Search and staged attachments clear on new->new:
    // a fresh identity is what every composer reset keys on.
    renderThreadApp('/ai');
    const before = activeThread();
    fireEvent.click(screen.getByText('new conversation'));
    expect(activeThread()).not.toBe(before);
  });

  it('changes on a dock page change', () => {
    renderThreadApp('/pages/page-a', ['/pages/page-b']);
    const before = activeThread();
    goTo('/pages/page-b');
    expect(activeThread()).not.toBe(before);
  });

  it('does not change while the user types', () => {
    renderThreadApp('/ai');
    const before = activeThread();
    fireEvent.click(screen.getByText('add message'));
    expect(screen.getByTestId('draft')).toHaveTextContent('draft for no page');
    expect(activeThread()).toBe(before);
  });

  it('does not change when the ?q= prefill writes the composer', () => {
    // A write is not a filing: the prefill lands through the same updateThread
    // path a keystroke does, and must leave the identity alone or every
    // composer reset would fire on a deep link.
    renderThreadApp('/ai', ['/ai?q=how do I rotate the PAT']);
    const before = activeThread();
    goTo('/ai?q=how do I rotate the PAT');
    expect(screen.getByTestId('draft')).toHaveTextContent('how do I rotate the PAT');
    expect(activeThread()).toBe(before);
  });
});

describe('identity-bound stream writers (#1361)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue([]);
  });

  /** A stream that yields once, then waits for the test to release it. */
  function gatedStream() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    streamSSEMock.mockImplementation((_endpoint: string, _body: unknown, signal: AbortSignal) =>
      (async function* () {
        yield { content: 'partial answer' };
        await gate;
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        yield { content: ' and the rest' };
      })(),
    );
    return () => release();
  }

  it('drops the aborted answer when New chat replaced the thread that asked', async () => {
    // The whole reason writers bind to identity rather than key: `draft` still
    // exists after New chat (same key, a fresh identity underneath), so a
    // key-bound commit would land the abandoned half-answer there. An empty
    // fresh draft can't tell that apart from a correct drop — `updated[-1]`
    // is undefined either way, so the commit no-ops regardless of which
    // thread it targeted. Giving the fresh draft a message of its own first
    // makes a key-bound write observably WRONG: it has a real last message to
    // clobber.
    const release = gatedStream();
    renderThreadApp('/ai');

    fireEvent.click(screen.getByText('stream'));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());

    fireEvent.click(screen.getByText('new conversation'));
    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about no page']);

    await act(async () => { release(); await Promise.resolve(); });

    // The fresh draft's own message survives untouched — a key-bound writer
    // would have overwritten it with the abandoned stream's partial answer.
    expect(threadContents()).toEqual(['question about no page']);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('conv-no page');
  });

  it('does not abort on a write to the thread that is already active', async () => {
    // A re-key and a write are both non-switches. This pins the write half;
    // the re-key half arrives with the promotion in the next task, which is
    // the first thing that can produce one.
    const release = gatedStream();
    renderThreadApp('/ai');

    fireEvent.click(screen.getByText('stream'));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());

    fireEvent.click(screen.getByText('type'));
    expect(screen.getByTestId('draft')).toHaveTextContent('typing on no page');

    await act(async () => { release(); await Promise.resolve(); });

    await waitFor(() => {
      expect(threadContents()).toEqual([
        'streamed question about no page',
        'partial answer and the rest',
      ]);
    });
  });

  it('names the thread whose answer is streaming, and clears it when the stream ends', async () => {
    const release = gatedStream();
    renderThreadApp('/ai', ['/pages/page-b', '/ai']);

    expect(screen.getByTestId('streaming-thread')).toHaveTextContent('none');

    fireEvent.click(screen.getByText('stream'));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());

    const streaming = screen.getByTestId('streaming-thread').textContent;
    expect(streaming).not.toBe('none');
    expect(streaming).toBe(screen.getByTestId('active-thread').textContent);

    // Switching does not move the marker: it still names the thread that asked,
    // which is what stops the other surface painting this partial answer into
    // whatever bubble happens to be last there.
    goTo('/pages/page-b');
    expect(screen.getByTestId('streaming-thread').textContent).toBe(streaming);
    expect(screen.getByTestId('active-thread').textContent).not.toBe(streaming);

    await act(async () => { release(); await Promise.resolve(); });
    await waitFor(() => {
      expect(screen.getByTestId('streaming-thread')).toHaveTextContent('none');
    });
  });

  it('aborts an in-flight stream when the active thread changes', async () => {
    // The abort effect keys on activeThreadId now, not on the key.
    const release = gatedStream();
    renderThreadApp('/ai', ['/pages/page-b', '/ai']);

    fireEvent.click(screen.getByText('stream'));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());

    goTo('/pages/page-b');
    await act(async () => { release(); await Promise.resolve(); });

    // The partial is committed to the thread that asked, and only there.
    expect(threadContents()).toEqual([]);
    goTo('/ai');
    await waitFor(() => {
      expect(threadContents()).toEqual([
        'streamed question about no page',
        'partial answer',
      ]);
    });
  });
});

describe('resolveAiPageId', () => {
  it('prefers an explicit ?pageId= over the route', () => {
    expect(resolveAiPageId('/pages/from-route', new URLSearchParams('pageId=explicit')))
      .toBe('explicit');
  });

  it('resolves to no document on an AI route, even with ?pageId=', () => {
    // #1361: `/ai` and `/ai/c/:id` are conversation routes, not document ones.
    // A legacy `/ai?pageId=…` bookmark therefore opens a plain new chat rather
    // than a page-scoped one — the three producers of that URL go in Task 14.
    expect(resolveAiPageId('/ai', new URLSearchParams('pageId=explicit'))).toBeNull();
    expect(resolveAiPageId('/ai', new URLSearchParams())).toBeNull();
    expect(resolveAiPageId('/ai/c/conv-1', new URLSearchParams('pageId=explicit'))).toBeNull();
  });

  it('falls back to the open document on an article route', () => {
    expect(resolveAiPageId('/pages/abc', new URLSearchParams())).toBe('abc');
  });

  it('treats /pages/new as no document — it is the create route', () => {
    expect(resolveAiPageId('/pages/new', new URLSearchParams())).toBeNull();
  });

  it('resolves to no document on unrelated routes', () => {
    expect(resolveAiPageId('/graph', new URLSearchParams())).toBeNull();
    expect(resolveAiPageId('/pages/abc/history', new URLSearchParams())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #1361 — the conversation state machine
// ---------------------------------------------------------------------------

/**
 * Reads the state-machine surface of the context and drives the four gestures
 * the table's rows are about: an ask that carries the thread's own id (what
 * `AskMode` builds), a typed draft, a claimed id (what a dock answer leaves
 * behind), and a delete.
 *
 * Deliberately a second probe rather than a grown `ThreadProbe`: the #1126
 * cells above are about retention across page changes and fail for entirely
 * different reasons than these do.
 */
function StateProbe() {
  const {
    messages, conversationId, input, mode, model, activeThreadId,
    threadLoadState, threadLoadError, historyTruncated, retryThreadLoad,
    setInput, setConversationId, purgeConversation, runStream,
  } = useAiContext();
  const navigate = useNavigate();

  return (
    <div>
      <span data-testid="conversation-id">{conversationId ?? 'none'}</span>
      <span data-testid="active-thread-id">{activeThreadId}</span>
      <span data-testid="draft">{input}</span>
      <span data-testid="mode">{mode}</span>
      <span data-testid="model">{model}</span>
      <span data-testid="load-state">{threadLoadState}</span>
      <span data-testid="load-error">{threadLoadError ?? 'none'}</span>
      <span data-testid="history-truncated">{historyTruncated ? 'yes' : 'no'}</span>
      <ul data-testid="thread">
        {messages.map((msg) => (
          <li
            key={msg.id}
            data-refusal={msg.isRefusal ? 'yes' : 'no'}
            data-error={msg.isError ? 'yes' : 'no'}
          >
            {msg.content}
          </li>
        ))}
      </ul>
      <button
        onClick={() =>
          runStream(
            '/llm/ask',
            { question: 'q', conversationId: conversationId ?? undefined },
            { userMessage: 'q' },
          )
        }
      >
        ask
      </button>
      <button onClick={() => setInput('half-typed question')}>type</button>
      <button onClick={() => setConversationId('c-1')}>claim c-1</button>
      <button onClick={() => purgeConversation('c-1')}>purge c-1</button>
      <button onClick={retryThreadLoad}>retry</button>
      <button onClick={() => navigate(-1)}>back</button>
      <button onClick={() => navigate(1)}>forward</button>
    </div>
  );
}

function renderStateApp(initialEntry: string, destinations: string[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AiProvider>
          <LocationDisplay />
          {destinations.map((to) => (
            <NavButton key={to} to={to} />
          ))}
          <Routes>
            <Route path="/ai" element={<StateProbe />} />
            <Route path="/ai/c/:conversationId" element={<StateProbe />} />
            <Route path="/pages/:id" element={<StateProbe />} />
          </Routes>
        </AiProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, queryClient, invalidate };
}

/** An /llm/ask stream whose final frame carries `id`. */
function askStreamReturning(id: string | null, answer = 'the answer') {
  return async function* fakeStream() {
    yield { content: answer };
    yield { done: true, final: true, conversationId: id, sources: [] };
  };
}

describe('AiContext conversation state machine (#1361)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/llm/usecase-default?usecase=chat') {
        return Promise.resolve({ model: 'llama3', vision: null });
      }
      if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
      return Promise.resolve([]);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('promotes the first answer on /ai: re-keys the draft, replaces the URL, files a fresh draft', async () => {
    streamSSEMock.mockImplementation(askStreamReturning('c-1'));
    const { invalidate } = renderStateApp('/ai', ['/ai']);

    fireEvent.click(screen.getByRole('button', { name: 'ask' }));

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    });
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('c-1');
    expect(threadContents()).toEqual(['q', 'the answer']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm', 'conversations'] });

    // A fresh draft was filed under `draft`, so /ai is a new chat again rather
    // than a second view of the conversation that just grew out of it.
    goTo('/ai');
    expect(threadContents()).toEqual([]);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
  });

  it('leaves activeThreadId unchanged across the promotion', async () => {
    streamSSEMock.mockImplementation(askStreamReturning('c-1'));
    renderStateApp('/ai');

    const before = screen.getByTestId('active-thread-id').textContent;
    expect(before).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    });

    // A re-key is not a switch: the same object moved keys, so every
    // switch-sensitive effect (abort, Deep Search, attachments) must sit still.
    // This also pins that the map write and the navigation land in ONE render —
    // an unbatched pair would show the fresh draft's identity in between.
    expect(screen.getByTestId('active-thread-id')).toHaveTextContent(before!);
  });

  it('does not promote a first answer that was stopped', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    streamSSEMock.mockImplementation((_endpoint: string, _body: unknown, signal: AbortSignal) =>
      (async function* () {
        yield { content: 'partial' };
        await gate;
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        yield { done: true, final: true, conversationId: 'c-1', sources: [] };
      })(),
    );

    const { invalidate } = renderStateApp('/ai', ['/pages/p1', '/ai']);
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());

    goTo('/pages/p1');
    await act(async () => { release(); await Promise.resolve(); });

    goTo('/ai');
    // Decision 9: the partial stays under the origin key with no id, and the
    // URL never became a conversation URL.
    expect(screen.getByTestId('location')).toHaveTextContent('/ai');
    expect(screen.getByTestId('location').textContent).not.toContain('/ai/c/');
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
    expect(threadContents()).toEqual(['q', 'partial']);
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['llm', 'conversations'] });
  });

  it('re-keys but does not navigate when a completion outruns its own abort', async () => {
    // The `activeKeyRef` guard is belt-and-braces behind the abort effect, so
    // this is the synthetic race that reaches it: a stream that ignores its
    // signal and finishes after the user has already moved. The thread is
    // still promoted (the answer is real and the server saved it); the user is
    // not dragged back to it.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    streamSSEMock.mockImplementation(() =>
      (async function* () {
        yield { content: 'the answer' };
        await gate;
        yield { done: true, final: true, conversationId: 'c-1', sources: [] };
      })(),
    );

    renderStateApp('/ai', ['/pages/p1', '/ai/c/c-1']);
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());

    goTo('/pages/p1');
    await act(async () => { release(); await Promise.resolve(); });

    expect(screen.getByTestId('location')).toHaveTextContent('/pages/p1');
    goTo('/ai/c/c-1');
    await waitFor(() => {
      expect(threadContents()).toEqual(['q', 'the answer']);
    });
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('c-1');
  });

  it('sets the id on a fresh page: thread without re-keying or navigating', async () => {
    streamSSEMock.mockImplementation(askStreamReturning('c-dock', 'dock answer'));
    const { invalidate } = renderStateApp('/pages/p1', ['/ai']);

    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await waitFor(() => {
      expect(screen.getByTestId('conversation-id')).toHaveTextContent('c-dock');
    });

    // `runStream` is shared by both surfaces; without the key half of the
    // promotion guard the dock's first answer would re-key its thread out from
    // under /pages/p1 and teleport the user to /ai.
    expect(screen.getByTestId('location')).toHaveTextContent('/pages/p1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm', 'conversations'] });

    goTo('/ai');
    expect(threadContents()).toEqual([]);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
  });

  it('clears the id and stays put on a stale 404, then the next ask promotes with the draft untouched', async () => {
    streamSSEMock.mockImplementation(askStreamReturning('c-1'));
    const { invalidate } = renderStateApp('/ai');

    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    });

    // Someone deleted the row in another tab. The server refuses before the
    // SSE header, so this is a thrown ApiError, not an in-band error frame.
    streamSSEMock.mockImplementation(() => { throw new ApiError(404, 'Conversation not found'); });
    fireEvent.click(screen.getByText('type'));
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));

    await waitFor(() => {
      expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
    });
    // The turn explains itself; the URL does not move and no re-key happens.
    expect(threadContents()).toContain(
      'This conversation no longer exists — your next question starts a new one.',
    );
    expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm', 'conversations'] });
    // The user turn is never marked as the error.
    const rows = Array.from(screen.getByTestId('thread').querySelectorAll('li'));
    expect(rows.filter((li) => li.getAttribute('data-error') === 'yes')).toHaveLength(1);
    expect(screen.getByTestId('draft')).toHaveTextContent('half-typed question');

    // The next ask is a fresh conversation, and it promotes the SAME thread —
    // origin key `conv:c-1` with no id — onto the new row.
    streamSSEMock.mockImplementation(askStreamReturning('c-2', 'a fresh answer'));
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-2');
    });
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('c-2');
    // The half-typed draft is composer state on a thread that was re-keyed,
    // not switched — it survives untouched.
    expect(screen.getByTestId('draft')).toHaveTextContent('half-typed question');
  });

  it('clears the id on a final frame carrying conversationId: null, keeping the messages', async () => {
    streamSSEMock.mockImplementation(askStreamReturning('c-1'));
    const { invalidate } = renderStateApp('/ai');

    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    });
    invalidate.mockClear();

    // Deleted in another tab mid-answer: the append hit zero rows.
    streamSSEMock.mockImplementation(askStreamReturning(null, 'answered anyway'));
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));

    await waitFor(() => {
      expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
    });
    // The on-screen exchange stays; history does not get it; nothing navigates
    // and the deleted conversation is not resurrected.
    expect(threadContents()).toEqual(['q', 'the answer', 'q', 'answered anyway']);
    expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm', 'conversations'] });
  });

  it('ignores a final frame naming a different conversation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    streamSSEMock.mockImplementation(askStreamReturning('c-1'));
    renderStateApp('/ai');

    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    });

    streamSSEMock.mockImplementation(askStreamReturning('c-999', 'answer from elsewhere'));
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await waitFor(() => {
      expect(threadContents()).toContain('answer from elsewhere');
    });

    expect(screen.getByTestId('conversation-id')).toHaveTextContent('c-1');
    expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    expect(warn).toHaveBeenCalledWith(
      '[ai] final frame named a different conversation; ignored',
      { originKey: 'conv:c-1', frameId: 'c-999' },
    );
  });

  it('mirrors a completed exchange into every other retained thread carrying the id', async () => {
    streamSSEMock.mockImplementation(askStreamReturning('c-1'));
    renderStateApp('/ai', ['/pages/p1', '/ai/c/c-1']);

    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    });

    // The dock's thread on the page this conversation started from holds the
    // same server row.
    goTo('/pages/p1');
    fireEvent.click(screen.getByText('claim c-1'));
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('c-1');

    goTo('/ai/c/c-1');
    streamSSEMock.mockImplementation(askStreamReturning('c-1', 'follow-up answer'));
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await waitFor(() => {
      expect(threadContents()).toEqual(['q', 'the answer', 'q', 'follow-up answer']);
    });

    // Server history is the truth; a second view of it that silently lags is
    // what the mirror prevents.
    goTo('/pages/p1');
    expect(threadContents()).toEqual(['q', 'follow-up answer']);
  });

  it('purges a deleted conversation: its thread goes, other threads keep their messages and lose the id', async () => {
    streamSSEMock.mockImplementation(askStreamReturning('c-1'));
    renderStateApp('/ai', ['/pages/p1', '/ai/c/c-1']);

    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    });

    goTo('/pages/p1');
    fireEvent.click(screen.getByText('claim c-1'));
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await waitFor(() => {
      expect(threadContents()).toEqual(['q', 'the answer']);
    });

    fireEvent.click(screen.getByText('purge c-1'));

    // The page thread keeps its messages and loses the id, so its next
    // question starts a fresh row instead of 404-looping.
    await waitFor(() => {
      expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
    });
    expect(threadContents()).toEqual(['q', 'the answer']);
    // Not open, so nothing navigated.
    expect(screen.getByTestId('location')).toHaveTextContent('/pages/p1');

    // And `conv:c-1` really is gone from the map — reopening it is a blank
    // placeholder, not the retained copy.
    goTo('/ai/c/c-1');
    expect(threadContents()).toEqual([]);
  });

  it('leaves the dead URL with a replace navigation when the purged conversation is open', async () => {
    streamSSEMock.mockImplementation(askStreamReturning('c-1'));
    renderStateApp('/ai');

    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    });

    fireEvent.click(screen.getByText('purge c-1'));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai');
    });
    expect(screen.getByTestId('location').textContent).not.toContain('/ai/c/');
  });

  /** A `GET /llm/conversations/:id` payload shaped like PR 1's contract. */
  function conversationDetail(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      title: `Conversation ${id}`,
      titleSource: 'question',
      model: 'a-model-nobody-selected',
      pageId: null,
      pageTitle: null,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T11:00:00.000Z',
      historyTruncated: false,
      messages: [
        { role: 'user', content: `question in ${id}` },
        { role: 'assistant', content: `answer in ${id}` },
      ],
      ...overrides,
    };
  }

  /** Route `/llm/conversations/:id` to `detail`, leaving the model queries alone. */
  function withConversations(detail: (id: string) => unknown) {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/llm/usecase-default?usecase=chat') {
        return Promise.resolve({ model: 'llama3', vision: null });
      }
      if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
      if (path.startsWith('/llm/conversations/')) {
        return Promise.resolve(detail(path.slice('/llm/conversations/'.length)));
      }
      return Promise.resolve([]);
    });
  }

  it('shows the loading state on the first render of /ai/c/X, never the Ask empty state', async () => {
    withConversations(() => new Promise(() => {}));
    renderStateApp('/ai/c/c-1');

    // The read path yields `seedFor('conv:c-1')`, so the very first paint is
    // already `loading` — the empty state renders only on `ready`.
    expect(screen.getByTestId('load-state')).toHaveTextContent('loading');
    expect(threadContents()).toEqual([]);
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/llm/conversations/c-1');
    });
  });

  it('fetches into conv:<id>, never into the thread that was on screen', async () => {
    withConversations((id) => conversationDetail(id));
    renderStateApp('/ai', ['/ai', '/ai/c/c-1']);

    fireEvent.click(screen.getByText('type'));
    expect(screen.getByTestId('draft')).toHaveTextContent('half-typed question');

    goTo('/ai/c/c-1');
    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-1', 'answer in c-1']);
    });
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('c-1');
    expect(screen.getByTestId('load-state')).toHaveTextContent('ready');
    // Opening loads, never sends (#1176), and sets the action to Q&A…
    expect(screen.getByTestId('mode')).toHaveTextContent('ask');
    // …but never the model: the per-conversation dropdown is gone (#355 AC-4).
    expect(screen.getByTestId('model')).toHaveTextContent('llama3');

    // The draft it was fetched next to is untouched.
    goTo('/ai');
    expect(threadContents()).toEqual([]);
    expect(screen.getByTestId('draft')).toHaveTextContent('half-typed question');
  });

  it('renders a reopened refusal as a refusal, not as an ordinary answer', async () => {
    withConversations((id) => conversationDetail(id, {
      messages: [
        { role: 'system', content: 'you are a helpful assistant' },
        { role: 'user', content: 'what is the retention window?' },
        { role: 'assistant', content: 'I am not answering that.', refused: true },
      ],
    }));
    renderStateApp('/ai/c/c-1');

    await waitFor(() => {
      expect(threadContents()).toEqual([
        'what is the retention window?',
        'I am not answering that.',
      ]);
    });
    const rows = Array.from(screen.getByTestId('thread').querySelectorAll('li'));
    expect(rows[1]!.getAttribute('data-refusal')).toBe('yes');
  });

  it('toasts and redirects to /ai when the id is unknown', async () => {
    const { toast } = await import('sonner');
    withConversations(() => Promise.reject(new ApiError(404, 'Conversation not found')));
    renderStateApp('/ai/c/gone');

    // A plain `toHaveTextContent('/ai')` substring-matches the dead URL
    // itself (`/ai/c/gone` contains `/ai`), so it can resolve before the
    // redirect actually lands — assert the real postcondition instead.
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).not.toContain('/ai/c/');
    });
    expect(toast.error).toHaveBeenCalledWith('Conversation not found');
    // The placeholder thread is removed, so /ai is the ordinary draft.
    expect(screen.getByTestId('load-state')).toHaveTextContent('ready');
    expect(threadContents()).toEqual([]);
  });

  it('keeps the URL and records the error on a network failure, then retries', async () => {
    const { toast } = await import('sonner');
    withConversations(() => Promise.reject(new ApiError(503, 'Service Unavailable (HTTP 503)')));
    renderStateApp('/ai/c/c-1');

    await waitFor(() => {
      expect(screen.getByTestId('load-state')).toHaveTextContent('error');
    });
    // Redirecting on a blip would lose a URL the user typed.
    expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    expect(screen.getByTestId('load-error')).toHaveTextContent('Service Unavailable (HTTP 503)');
    expect(toast.error).not.toHaveBeenCalled();

    withConversations((id) => conversationDetail(id));
    fireEvent.click(screen.getByText('retry'));
    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-1', 'answer in c-1']);
    });
    expect(screen.getByTestId('load-state')).toHaveTextContent('ready');
  });

  it('still hydrates when the URL also carries a ?q= prefill', async () => {
    withConversations((id) => conversationDetail(id));
    renderStateApp('/ai/c/c-1?q=and one more thing');

    expect(screen.getByTestId('load-state')).toHaveTextContent('loading');
    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-1', 'answer in c-1']);
    });
    // The prefill is a WRITE to `conv:c-1`, which files the key — and files it
    // through `seedFor`, so hydration is not suppressed by the write arriving
    // first. Both landed.
    expect(screen.getByTestId('draft')).toHaveTextContent('and one more thing');
  });

  it('walks two conversations with Back and Forward', async () => {
    withConversations((id) => conversationDetail(id));
    renderStateApp('/ai/c/c-1', ['/ai/c/c-2']);

    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-1', 'answer in c-1']);
    });
    goTo('/ai/c/c-2');
    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-2', 'answer in c-2']);
    });

    fireEvent.click(screen.getByText('back'));
    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-1', 'answer in c-1']);
    });
    fireEvent.click(screen.getByText('forward'));
    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-2', 'answer in c-2']);
    });
    // Retained, so walking back and forward costs one fetch each, not four.
    expect(apiFetchMock.mock.calls.filter(
      (call) => String(call[0]).startsWith('/llm/conversations/'),
    )).toHaveLength(2);
  });

  it('treats an evicted conversation reopened as a switch and refetches it', async () => {
    withConversations((id) => conversationDetail(id));
    const pages = Array.from({ length: 12 }, (_, i) => `/pages/p${i}`);
    renderStateApp('/ai/c/c-1', [...pages, '/ai/c/c-1']);

    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-1', 'answer in c-1']);
    });
    const firstIdentity = screen.getByTestId('active-thread-id').textContent;

    // draft + conv:c-1 + twelve page threads is fourteen entries against a cap
    // of twelve, so the two oldest go.
    for (const page of pages) goTo(page);

    goTo('/ai/c/c-1');
    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-1', 'answer in c-1']);
    });
    expect(apiFetchMock.mock.calls.filter(
      (call) => call[0] === '/llm/conversations/c-1',
    )).toHaveLength(2);
    // A re-filed thread is a new identity, and opening is a switch by
    // definition — Deep Search and staged attachments clear.
    expect(screen.getByTestId('active-thread-id').textContent).not.toBe(firstIdentity);
  });

  it('reads historyTruncated from the reopen and from each ask’s final frame', async () => {
    withConversations((id) => conversationDetail(id, { historyTruncated: true }));
    renderStateApp('/ai/c/c-1');

    // Decision 10's reopen half: a long conversation says so the moment it
    // opens, not after the next question has already been clipped.
    await waitFor(() => {
      expect(screen.getByTestId('history-truncated')).toHaveTextContent('yes');
    });

    // …and the live half, which can also take it back down: the frame omits
    // the field when the whole history fitted.
    streamSSEMock.mockImplementation(askStreamReturning('c-1', 'shorter now'));
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await waitFor(() => {
      expect(screen.getByTestId('history-truncated')).toHaveTextContent('no');
    });

    streamSSEMock.mockImplementation(async function* () {
      yield { content: 'clipped' };
      yield { done: true, final: true, conversationId: 'c-1', sources: [], historyTruncated: true };
    });
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await waitFor(() => {
      expect(screen.getByTestId('history-truncated')).toHaveTextContent('yes');
    });
  });
});
