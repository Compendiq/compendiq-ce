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
    pageId, mode, messages, conversationId, input,
    setMessages, setConversationId, setInput, startNewConversation, runStream,
  } = useAiContext();
  const label = pageId ?? 'no page';

  return (
    <div>
      <span data-testid="context-page">{label}</span>
      <span data-testid="mode">{mode}</span>
      <span data-testid="conversation-id">{conversationId ?? 'none'}</span>
      <span data-testid="draft">{input}</span>
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
    </div>
  );
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
function renderThreadApp(initialEntry: string, destinations: string[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AiProvider>
          <LocationDisplay />
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

  it('clears only the active thread on a deliberate new conversation', () => {
    renderThreadApp('/pages/page-a', ['/pages/page-a', '/pages/page-b']);

    fireEvent.click(screen.getByText('add message'));
    goTo('/pages/page-b');
    fireEvent.click(screen.getByText('add message'));

    fireEvent.click(screen.getByText('new conversation'));
    expect(threadContents()).toEqual([]);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
    expect(screen.getByTestId('draft')).toHaveTextContent('');

    // A is untouched — a reset is scoped to the thread you are looking at.
    goTo('/pages/page-a');
    expect(threadContents()).toEqual(['question about page-a']);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('conv-page-a');
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

    goTo(urls[0]!);
    expect(threadContents()).toEqual([]);
    goTo(urls[1]!);
    expect(threadContents()).toEqual(['question about page-1']);
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
