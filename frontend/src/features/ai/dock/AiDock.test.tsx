/**
 * The docked AI assistant (#1126).
 *
 * Mounted the way AppLayout mounts it — beside the route outlet, under the
 * hoisted AiProvider — and mocked only at the network boundary (`apiFetch`,
 * `streamSSE`), so these describe what a user can observe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AiProvider, useAiContext } from '../AiContext';
import { DockPanel } from './DockPanel';
import { useAiDockStore } from '../../../stores/ai-dock-store';

Element.prototype.scrollIntoView = vi.fn();

const apiFetchMock = vi.fn();
vi.mock('../../../shared/lib/api', async () =>
  (await import('../../../test-utils')).apiModuleMock(() => apiFetchMock));

const streamSSEMock = vi.fn();
vi.mock('../../../shared/lib/sse', () => ({
  streamSSE: (...args: unknown[]) => streamSSEMock(...args),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const PAGE = {
  id: 'page-1',
  title: 'Onboarding Guide',
  bodyHtml: '<p>You need a PAT.</p>',
  bodyText: 'You need a PAT.',
  version: 4,
  hasChildren: false,
  labels: [],
  spaceKey: 'ENG',
};

/** An async-iterable stand-in for one `/llm/*` SSE response. */
function sse(...chunks: Array<Record<string, unknown>>) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

let modelsFail = false;

/**
 * Reaches the hoisted provider the way a sibling surface would, so a test can
 * put a finished answer on one page's thread and a running stream on another —
 * the only way to observe which thread the in-flight bubble belongs to (#1361).
 */
function DockThreadTools() {
  const navigate = useNavigate();
  const { setMessages, runStream } = useAiContext();
  return (
    <>
      <button
        data-testid="dock-seed-answer"
        onClick={() =>
          setMessages([
            { id: 'seed-user', role: 'user', content: 'what changed here?' },
            { id: 'seed-answer', role: 'assistant', content: 'answer one' },
          ])
        }
      >
        seed
      </button>
      <button data-testid="dock-ask-here" onClick={() => void runStream('/llm/ask', { question: 'q' })}>
        ask
      </button>
      <button data-testid="dock-go-page-2" onClick={() => navigate('/pages/page-2')}>page 2</button>
      <button data-testid="dock-go-page-1" onClick={() => navigate('/pages/page-1')}>page 1</button>
    </>
  );
}

function renderDock(
  opts: { initialEntry?: string; onClose?: () => void } | string = {},
) {
  const { initialEntry = '/pages/page-1', onClose = () => {} } =
    typeof opts === 'string' ? { initialEntry: opts } : opts;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LazyMotion features={domAnimation}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <AiProvider>
            <button data-testid="dock-trigger">AI Assistant</button>
            <DockThreadTools />
            <Routes>
              <Route path="/pages/:id" element={<div>article</div>} />
              <Route path="/ai" element={<div>ai page</div>} />
            </Routes>
            <DockPanel variant="tab" onClose={onClose} />
          </AiProvider>
        </MemoryRouter>
      </LazyMotion>
    </QueryClientProvider>,
  );
}

/** Open the dock and wait until it has a model, i.e. until Send can run. */
async function openAndSettle() {
  act(() => {
    useAiDockStore.getState().openDock();
  });
  await waitFor(() => {
    expect(screen.getByTestId('ai-dock-send')).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(screen.getByTestId('assistant-action-select')).not.toBeDisabled();
  });
}

async function selectDockAction(action: 'ask' | 'grammar' | 'structure' | 'clarity' | 'technical' | 'completeness' | 'diagram') {
  fireEvent.pointerDown(screen.getByTestId('assistant-action-select'), { button: 0 });
  fireEvent.click(await screen.findByTestId(`assistant-action-${action}`));
}

function composer(): HTMLTextAreaElement {
  return screen.getByTestId('ai-dock-input');
}

describe('AiDock (#1126)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modelsFail = false;
    useAiDockStore.setState({ open: false });
    window.innerWidth = 1400;
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/pages/page-1') return Promise.resolve(PAGE);
      if (path.startsWith('/ollama/models')) {
        return modelsFail ? Promise.reject(new Error('provider down')) : Promise.resolve([{ name: 'llama3' }]);
      }
      if (path.startsWith('/llm/usecase-default')) return Promise.resolve({ model: 'llama3' });
      if (path === '/llm/conversations') return Promise.resolve([]);
      if (path === '/embeddings/status') return Promise.resolve({ total: 1, embedded: 1, isProcessing: false });
      return Promise.resolve({});
    });
    streamSSEMock.mockImplementation(() => sse({ content: 'ok' }, { final: true, done: true }));
  });

  afterEach(() => {
    useAiDockStore.setState({ open: false });
  });

  it('renders nothing until it is opened', () => {
    renderDock();
    expect(screen.queryByTestId('ai-dock')).not.toBeInTheDocument();
  });

  // The `<aside aria-label="AI assistant">` assertions went with the column:
  // the assistant is a tabpanel inside ArticleRightPane now, and that pane is
  // the labelled landmark. Focus reaching the composer is the half of this test
  // that was about the assistant rather than its container, and it survives.
  //
  // Two whole describes were removed here rather than rewritten, because the
  // behaviour they guarded no longer has a mechanism:
  //  - `width` covered the column's width cap and resize handle. The tab
  //    inherits ArticleRightPane's width and its resize.
  //  - `focus restore when opening destroyed the trigger` covered a bug where
  //    opening the dock unmounted the very control that opened it (the pane
  //    collapsed to its rail). A tab cannot destroy itself by being selected.
  it('moves focus to the composer when the assistant is shown', async () => {
    renderDock();
    await openAndSettle();

    expect(document.activeElement).toBe(composer());
  });

  // Escape used to unmount the column and hand focus back to whatever opened
  // it. A tabpanel does not unmount on Escape — it asks its host to show a
  // different view, and the host owns what happens to focus. So what this
  // pins now is the half that is still the assistant's own contract: Escape
  // inside the composer asks to leave. In the app, `ArticleRightPane` answers
  // by switching to Outline.
  it('asks its host to close when Escape is pressed in the composer', async () => {
    const onClose = vi.fn();
    renderDock({ onClose });
    await openAndSettle();

    fireEvent.keyDown(composer(), { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  // Two of the three real triggers are DESTROYED by opening the dock: the
  // expanded pane's "AI Assistant" row unmounts when the pane is forced to its
  // rail, and below 1100px the whole pane unmounts. Restoring
  // `document.activeElement` naively hands focus to <body> in both cases.

  // #1176: opening the assistant used to fire a full-page rewrite on the spot.
  // Nothing about the click said which of the five improvement types to use, the
  // dock has no way to stop a run once it starts, and closing it does not abort
  // one — so the only safe thing for an *opening* gesture to do is open.
  it('sends nothing when it opens, and runs a rewrite only from Send', async () => {
    renderDock();
    await openAndSettle();

    expect(streamSSEMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('ai-dock-empty')).toBeInTheDocument();

    await selectDockAction('grammar');
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/improve',
        expect.objectContaining({ pageId: 'page-1' }),
        expect.anything(),
      );
    });
  });

  it('greets an empty thread with the action selector and composer', async () => {
    renderDock();
    await openAndSettle();

    // The empty state names the scope — the open page — rather than echoing
    // the composer's own placeholder back at the reader.
    const empty = screen.getByTestId('ai-dock-empty');
    expect(empty).toHaveTextContent('Onboarding Guide');
    expect(empty).toHaveTextContent('Ask about it, or pick an action.');
    fireEvent.pointerDown(screen.getByTestId('assistant-action-select'), { button: 0 });
    for (const id of ['ask', 'grammar', 'structure', 'clarity', 'technical', 'completeness', 'diagram']) {
      expect(await screen.findByTestId(`assistant-action-${id}`)).toBeInTheDocument();
    }
    expect(screen.queryByText('Summarize')).not.toBeInTheDocument();
    expect(screen.queryByText('Quality')).not.toBeInTheDocument();
  });

  it('runs Diagram against the open document from the same Send button', async () => {
    renderDock();
    await openAndSettle();

    await selectDockAction('diagram');
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/generate-diagram',
        expect.objectContaining({ content: PAGE.bodyHtml, model: 'llama3', pageId: 'page-1' }),
        expect.anything(),
      );
    });
    expect(await screen.findByText('Draw a flowchart diagram of this page.')).toBeInTheDocument();
  });

  // The core of "one thread, four chips". runStream used to `setMessages([...])`
  // for every seeded turn, so each chip wiped the conversation it landed in.
  it('appends chip turns to one continuous thread instead of replacing it', async () => {
    renderDock();
    await openAndSettle();

    fireEvent.change(composer(), { target: { value: 'what does this cover?' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(await screen.findByText('what does this cover?')).toBeInTheDocument();

    await selectDockAction('diagram');
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    expect(await screen.findByText('Draw a flowchart diagram of this page.')).toBeInTheDocument();
    // The earlier question is still there — that is the whole fix.
    expect(screen.getByText('what does this cover?')).toBeInTheDocument();
  });

  it('sends the composer text as Improve instructions and shows the user their own words', async () => {
    renderDock();
    await openAndSettle();

    await selectDockAction('grammar');
    fireEvent.change(composer(), { target: { value: 'tighten the intro' } });
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/improve',
        expect.objectContaining({ instruction: 'tighten the intro', type: 'grammar' }),
        expect.anything(),
      );
    });
    expect(await screen.findByText('tighten the intro')).toBeInTheDocument();
    expect(composer().value).toBe('');
  });

  it('uses composer text as Diagram instructions', async () => {
    renderDock();
    await openAndSettle();

    await selectDockAction('diagram');
    fireEvent.change(composer(), { target: { value: 'focus on the approval flow' } });
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    await waitFor(() => expect(streamSSEMock).toHaveBeenCalledWith(
      '/llm/generate-diagram',
      expect.objectContaining({ instruction: 'focus on the approval flow' }),
      expect.anything(),
    ));
    expect(composer().value).toBe('');
  });

  it('offers a retry instead of chips when the model list cannot be loaded', async () => {
    modelsFail = true;
    renderDock();
    act(() => {
      useAiDockStore.getState().openDock();
    });

    expect(await screen.findByText('Models unavailable — retry')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-action-select')).toBeDisabled();
  });


  it('shows a violet streaming indicator and disables the composer mid-stream', async () => {
    // A stream that never resolves, so the in-flight state is observable.
    streamSSEMock.mockImplementation(() => (async function* () {
      await new Promise(() => {});
      yield {};
    })());

    renderDock();
    await openAndSettle();
    await selectDockAction('diagram');
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    await waitFor(() => {
      expect(screen.getByTestId('ai-dock-streaming')).toBeInTheDocument();
    });
    expect(composer()).toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // Deep search (#1119 / #1112)
  // -------------------------------------------------------------------------
  //
  // The dock posts to the same `/llm/ask` as `/ai`, so a toggle implemented in
  // only one of them degrades silently in the other. The non-stickiness
  // constraint is the same one, for the same measured reason: expansion is a
  // regression on ordinary queries (R@5 .921 -> .866, McNemar p = 0.0225), so
  // it is safe only per-question.
  describe('deep search', () => {
    async function askDock(question: string) {
      fireEvent.change(composer(), { target: { value: question } });
      fireEvent.keyDown(composer(), { key: 'Enter' });
      await waitFor(() => {
        expect(streamSSEMock).toHaveBeenCalledWith(
          '/llm/ask',
          expect.objectContaining({ question }),
          expect.anything(),
        );
      });
      return streamSSEMock.mock.calls.find(
        (c) => (c[1] as { question?: string }).question === question,
      )![1] as Record<string, unknown>;
    }

    it('is off by default and adds nothing to the request', async () => {
      renderDock();
      await openAndSettle();

      expect(screen.getByTestId('ai-dock-deep-search')).not.toBeChecked();
      expect(await askDock('where is the PAT setting?')).not.toHaveProperty('deepSearch');
    });

    // NON-STICKINESS TEST 1 — must not survive a SEND.
    it('sends the flag once, then resets — the next question goes without it', async () => {
      renderDock();
      await openAndSettle();

      fireEvent.click(screen.getByTestId('ai-dock-deep-search'));
      expect((await askDock('what governs the retention window?')).deepSearch).toBe(true);

      await waitFor(() => {
        expect(screen.getByTestId('ai-dock-deep-search')).not.toBeChecked();
      });
      expect(await askDock('who owns this page?')).not.toHaveProperty('deepSearch');
    });

    // Enter on an empty composer reaches `ask()`, which returns early. The
    // reset lives *inside* `ask()` past that guard precisely so a keypress
    // that sends nothing cannot throw the user's choice away.
    it('survives a keypress that sends nothing', async () => {
      renderDock();
      await openAndSettle();

      fireEvent.click(screen.getByTestId('ai-dock-deep-search'));
      fireEvent.change(composer(), { target: { value: '   ' } });
      fireEvent.keyDown(composer(), { key: 'Enter' });

      expect(streamSSEMock).not.toHaveBeenCalled();
      expect(screen.getByTestId('ai-dock-deep-search')).toBeChecked();
    });

    it('is dropped by a selected skill run rather than carried back to Q&A', async () => {
      renderDock();
      await openAndSettle();

      fireEvent.click(screen.getByTestId('ai-dock-deep-search'));
      expect(screen.getByTestId('ai-dock-deep-search')).toBeChecked();

      await selectDockAction('diagram');
      expect(screen.queryByTestId('ai-dock-deep-search')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('ai-dock-send'));
      await waitFor(() => {
        expect(streamSSEMock).toHaveBeenCalledWith(
          '/llm/generate-diagram', expect.anything(), expect.anything(),
        );
      });

      await selectDockAction('ask');
      expect(screen.getByTestId('ai-dock-deep-search')).not.toBeChecked();
      // And it never rode along on the request it was lit for.
      expect(streamSSEMock.mock.calls[0]![1]).not.toHaveProperty('deepSearch');
    });

    // NON-STICKINESS TEST 2 — must not survive a REMOUNT, and must not be
    // written down anywhere on the way.
    //
    // The two halves are here deliberately. The remount assertion alone is a
    // weak discriminator IN THE DOCK: the page-boundary effect clears the flag
    // on mount as well, so it would go green over a persisted implementation
    // and certify nothing. The storage spies are what actually fail when the
    // flag is given a home that outlives the panel. Spy on the instances, not
    // on `Storage.prototype` — test-setup.ts swaps in a plain object when
    // jsdom's Storage is not functional, and a prototype spy never sees it.
    it('is off again after a remount, and was never written to storage', async () => {
      const local = vi.spyOn(window.localStorage, 'setItem');
      const session = vi.spyOn(window.sessionStorage, 'setItem');
      const { unmount } = renderDock();
      await openAndSettle();

      fireEvent.click(screen.getByTestId('ai-dock-deep-search'));
      expect(screen.getByTestId('ai-dock-deep-search')).toBeChecked();
      expect(local).not.toHaveBeenCalled();
      expect(session).not.toHaveBeenCalled();

      unmount();
      renderDock();
      await openAndSettle();

      // The dock's own store is the tempting home for this and is explicitly
      // ruled out: it is ephemeral today, but a store is the thing later work
      // persists. Component state cannot be persisted by someone else's
      // decision.
      expect(screen.getByTestId('ai-dock-deep-search')).not.toBeChecked();
      expect(local).not.toHaveBeenCalled();
      expect(session).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Low-confidence refusal (#1119 / #1105)
  // -------------------------------------------------------------------------
  describe('low-confidence refusal', () => {
    /** Exactly the frames `sendCachedSSE` writes on the #1105 refusal path. */
    function refusalStream() {
      streamSSEMock.mockImplementation(() => sse(
        {
          content: 'The knowledge-base passages I found are not a strong enough match to this'
            + ' question to ground an answer, so I am not answering rather than guessing.'
            + ' The closest partial matches are attached as sources for reference —'
            + ' none matched well enough to use.',
          done: true,
        },
        {
          refused: true,
          confidence: 0.21,
          confidenceBasis: 'similarity',
          conversationId: 'conv-1',
          // The wire shape, not an approximation of it: `Source` is
          // {pageTitle, pageId: number, score, similarity} — the same fixture
          // `/ai`'s refusal suite uses. A hand-rolled {pageId: 'p9', title}
          // renders an empty chip in every implementation, so it could not tell
          // a renderer that reads `pageTitle` from one that reads nothing.
          sources: [{ pageTitle: 'Vaguely related page', pageId: 9, score: 0.01, similarity: 0.21 }],
          done: true,
          final: true,
        },
      ));
    }

    async function askAndRefuse() {
      refusalStream();
      renderDock();
      await openAndSettle();
      fireEvent.change(composer(), { target: { value: 'what is our policy on X?' } });
      fireEvent.keyDown(composer(), { key: 'Enter' });
      return screen.findByTestId('message-refusal');
    }

    it('renders as its own state — not an error, not an empty bubble', async () => {
      const refusal = await askAndRefuse();

      expect(refusal).toHaveTextContent('not answering rather than guessing');
      // Not the destructive path: nothing failed.
      expect(screen.queryByTestId('message-error')).not.toBeInTheDocument();
      // And the state is named, not left to the prose.
      expect(screen.getByTestId('refusal-mark')).toHaveTextContent('Not answered');
    });

    it('labels the weak sources instead of passing them off as citations', async () => {
      await askAndRefuse();

      expect(screen.getByTestId('refusal-sources-label')).toHaveTextContent(/closest matches/i);
      // The chip is a real one built from the wire fields, so the heading is
      // labelling something a user can actually see and follow.
      expect(screen.getByTestId('citation-chip-1')).toHaveAttribute('title', 'Vaguely related page');
    });

    // The announcer is the whole reason this state exists for a screen-reader
    // user: the visible treatment — neutral chip, hairline, no badge — is
    // invisible to them, so "Answer ready" would be the *only* thing they were
    // told about a turn that carries no answer. `/ai` fixed this and the dock
    // did not, which is how the same bug shipped twice; there was no dock test
    // to notice. Two directions, so it discriminates: an ordinary answer must
    // still say "Answer ready".
    it('announces an ordinary answer as an answer', async () => {
      renderDock();
      await openAndSettle();
      fireEvent.change(composer(), { target: { value: 'where is the PAT setting?' } });
      fireEvent.keyDown(composer(), { key: 'Enter' });

      const announcer = screen.getByTestId('ai-dock-answer-announcer');
      await waitFor(() => {
        expect(announcer).toHaveTextContent('Answer ready');
      });
    });

    it('does not announce a refusal as an answer', async () => {
      await askAndRefuse();

      const announcer = screen.getByTestId('ai-dock-answer-announcer');
      await waitFor(() => {
        expect(announcer.textContent).not.toBe('');
      });
      expect(announcer).not.toHaveTextContent('Answer ready');
      expect(announcer).toHaveTextContent(/no answer/i);
      // Polite, not assertive. The request succeeded and the server declined to
      // guess; that is a correct outcome, not one worth interrupting for.
      expect(screen.getByTestId('ai-dock-error-announcer').textContent).toBe('');
    });

    it('wears no warning or destructive colour — a refusal is a verdict, not a fault', async () => {
      const refusal = await askAndRefuse();

      const classes = [refusal, screen.getByTestId('refusal-mark')]
        .map((el) => el.className)
        .join(' ');
      // ADR-010: amber is reserved for warning/attention, and this recurs on
      // every uncovered question — a permanent amber teaches users to ignore
      // amber. Destructive belongs to the error path.
      expect(classes).not.toMatch(/warning|amber/);
      expect(classes).not.toMatch(/destructive/);
      // Nor does it borrow a reserved status hue for what is a measurement.
      expect(classes).not.toMatch(/status-(connected|disconnected|syncing|embedding|ai)/);
    });
  });

  describe('long message collapse/expand', () => {
    it('shows Show more / Show less toggle for long multi-line or lengthy user prompts', async () => {
      renderDock();
      await openAndSettle();

      const longPrompt = 'Line 1\nLine 2\nLine 3\nLine 4: This is a long custom prompt for the assistant with lots of instructions.';
      fireEvent.change(composer(), { target: { value: longPrompt } });
      fireEvent.keyDown(composer(), { key: 'Enter' });

      const toggle = await screen.findByTestId('dock-user-message-expand');
      expect(toggle).toHaveTextContent('Show more');

      fireEvent.click(toggle);
      expect(toggle).toHaveTextContent('Show less');

      fireEvent.click(toggle);
      expect(toggle).toHaveTextContent('Show more');
    });
  });

  it("does not paint another page's in-flight answer onto this thread (#1361)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    streamSSEMock.mockImplementation((_endpoint: string, _body: unknown, signal: AbortSignal) =>
      (async function* () {
        yield { content: 'partial from the other page' };
        await gate;
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      })(),
    );

    renderDock();
    await openAndSettle();

    fireEvent.click(screen.getByTestId('dock-seed-answer'));
    expect(await screen.findByText('answer one')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('dock-go-page-2'));
    fireEvent.click(screen.getByTestId('dock-ask-here'));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('dock-go-page-1'));

    expect(await screen.findByText('answer one')).toBeInTheDocument();
    expect(screen.queryByText('partial from the other page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-dock-typing')).not.toBeInTheDocument();

    await act(async () => { release(); await Promise.resolve(); });
  });

  // The same mechanism on the second /llm/ask surface (#1361). One of two is
  // the divergence CLAUDE.md's refusal note warns about.
  it('renders the history-truncated note when an answer reports it', async () => {
    streamSSEMock.mockImplementation(() =>
      sse({ content: 'Answer' }, { final: true, conversationId: 'c-1', historyTruncated: true, sources: [], done: true }));

    renderDock();
    await openAndSettle();
    fireEvent.change(composer(), { target: { value: 'and then?' } });
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    const note = await screen.findByTestId('ai-dock-history-truncated');
    expect(note).toHaveTextContent('Older messages in this conversation are no longer sent to the model.');
    expect(note).not.toHaveAttribute('role');
    expect(note).not.toHaveAttribute('aria-live');
  });

  it('does not render the note when the answer does not report it', async () => {
    streamSSEMock.mockImplementation(() => sse({ content: 'Answer' }, { final: true, sources: [], done: true }));

    renderDock();
    await openAndSettle();
    fireEvent.change(composer(), { target: { value: 'first question' } });
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    await screen.findByText('Answer');
    expect(screen.queryByTestId('ai-dock-history-truncated')).not.toBeInTheDocument();
  });
});
