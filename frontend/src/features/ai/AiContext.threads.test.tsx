/**
 * Per-page thread retention (#1126).
 *
 * These tests mount AiProvider the way AppLayout does — ABOVE the router
 * outlet, not inside the /ai route — because that arrangement is the whole
 * point: a conversation has to outlive the component that started it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
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
          {destinations.map((to) => (
            <NavButton key={to} to={to} />
          ))}
          <Routes>
            <Route path="/" element={<div>pages list</div>} />
            <Route path="/ai" element={<ThreadProbe />} />
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
    // The sidebar navigates exactly like this while on /ai — the click that
    // used to silently discard an in-progress conversation.
    renderThreadApp('/ai?pageId=page-a', ['/ai?pageId=page-a', '/ai?pageId=page-b']);

    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about page-a']);

    // A -> B: B starts empty and must not show A's messages.
    goTo('/ai?pageId=page-b');
    expect(screen.getByTestId('context-page')).toHaveTextContent('page-b');
    expect(threadContents()).toEqual([]);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');

    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about page-b']);

    // B -> A: A's thread comes back intact, and is still distinct from B's.
    goTo('/ai?pageId=page-a');
    expect(threadContents()).toEqual(['question about page-a']);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('conv-page-a');
    expect(screen.getByTestId('draft')).toHaveTextContent('draft for page-a');

    goTo('/ai?pageId=page-b');
    expect(threadContents()).toEqual(['question about page-b']);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('conv-page-b');
  });

  it('gives the no-document case a thread a real page cannot collide with', () => {
    // A page whose id is literally the no-document key is the adversarial case
    // for the thread-key scheme.
    renderThreadApp('/ai', ['/ai', '/ai?pageId=no-page']);

    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about no page']);

    goTo('/ai?pageId=no-page');
    expect(screen.getByTestId('context-page')).toHaveTextContent('no-page');
    expect(threadContents()).toEqual([]);

    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about no-page']);

    goTo('/ai');
    expect(threadContents()).toEqual(['question about no page']);
  });

  it('shares one thread between /ai?pageId=x and the article route for x', () => {
    // ?pageId= is an input to context resolution, not its definition: the open
    // document resolves to the same thread.
    renderThreadApp('/pages/page-a', ['/pages/page-a', '/ai?pageId=page-a']);

    expect(screen.getByTestId('context-page')).toHaveTextContent('page-a');
    fireEvent.click(screen.getByText('add message'));

    goTo('/ai?pageId=page-a');
    expect(threadContents()).toEqual(['question about page-a']);

    goTo('/pages/page-a');
    expect(threadContents()).toEqual(['question about page-a']);
  });

  it('clears only the active thread on a deliberate new conversation', () => {
    renderThreadApp('/ai?pageId=page-a', ['/ai?pageId=page-a', '/ai?pageId=page-b']);

    fireEvent.click(screen.getByText('add message'));
    goTo('/ai?pageId=page-b');
    fireEvent.click(screen.getByText('add message'));

    fireEvent.click(screen.getByText('new conversation'));
    expect(threadContents()).toEqual([]);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
    expect(screen.getByTestId('draft')).toHaveTextContent('');

    // A is untouched — a reset is scoped to the thread you are looking at.
    goTo('/ai?pageId=page-a');
    expect(threadContents()).toEqual(['question about page-a']);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('conv-page-a');
  });

  it('evicts the least recently used thread once the retention cap is exceeded', () => {
    // MAX_RETAINED_THREADS is 12, so writing 13 threads must drop the oldest.
    const urls = Array.from({ length: 13 }, (_, i) => `/ai?pageId=page-${i}`);
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

    renderThreadApp('/ai?pageId=page-a', ['/ai?pageId=page-a', '/ai?pageId=page-b']);

    fireEvent.click(screen.getByText('stream'));
    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalled();
    });

    goTo('/ai?pageId=page-b');
    await act(async () => {
      release();
      await Promise.resolve();
    });

    // B never receives page A's answer.
    expect(screen.getByTestId('context-page')).toHaveTextContent('page-b');
    expect(threadContents()).toEqual([]);

    goTo('/ai?pageId=page-a');
    await waitFor(() => {
      expect(threadContents()).toEqual([
        'streamed question about page-a',
        'partial answer',
      ]);
    });
  });

  it('applies an explicit ?mode= when navigating onto /ai', () => {
    // The provider no longer remounts on route entry, so the mode carried by
    // the article rail's "AI Improve" link has to be applied reactively.
    renderThreadApp('/ai', ['/ai?mode=improve&pageId=page-a']);

    expect(screen.getByTestId('mode')).toHaveTextContent('ask');
    goTo('/ai?mode=improve&pageId=page-a');
    expect(screen.getByTestId('mode')).toHaveTextContent('improve');
  });
});

describe('resolveAiPageId', () => {
  it('prefers an explicit ?pageId= over the route', () => {
    expect(resolveAiPageId('/pages/from-route', new URLSearchParams('pageId=explicit')))
      .toBe('explicit');
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
