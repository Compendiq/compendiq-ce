/**
 * The docked AI assistant (#1126).
 *
 * Mounted the way AppLayout mounts it — beside the route outlet, under the
 * hoisted AiProvider — and mocked only at the network boundary (`apiFetch`,
 * `streamSSE`), so these describe what a user can observe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AiProvider } from '../AiContext';
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

/** Open the dock and wait until it has a model, i.e. until the chips are live. */
async function openAndSettle() {
  act(() => {
    useAiDockStore.getState().openDock();
  });
  await waitFor(() => {
    expect(screen.getByTestId('ai-dock-send')).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(screen.getByTestId('ai-dock-chip-summarize')).not.toBeDisabled();
  });
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
  it('sends nothing when it opens, and improves only once the chip is pressed', async () => {
    renderDock();
    await openAndSettle();

    expect(streamSSEMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('ai-dock-empty')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-dock-chip-improve'));

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/improve',
        expect.objectContaining({ pageId: 'page-1' }),
        expect.anything(),
      );
    });
  });

  it('greets an empty thread with the chips and composer, not placeholder bubbles', async () => {
    renderDock();
    await openAndSettle();

    // The empty state names the scope — the open page — rather than echoing
    // the composer's own placeholder back at the reader.
    const empty = screen.getByTestId('ai-dock-empty');
    expect(empty).toHaveTextContent('Onboarding Guide');
    expect(empty).toHaveTextContent('Ask about it, or pick an action.');
    for (const id of ['improve', 'summarize', 'diagram', 'quality']) {
      expect(screen.getByTestId(`ai-dock-chip-${id}`)).toBeInTheDocument();
    }
  });

  it('runs a chip against the open document without a mode switch', async () => {
    renderDock();
    await openAndSettle();

    fireEvent.click(screen.getByTestId('ai-dock-chip-summarize'));

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/summarize',
        expect.objectContaining({ content: PAGE.bodyHtml, model: 'llama3', pageId: 'page-1' }),
        expect.anything(),
      );
    });
    expect(await screen.findByText('Summarize this page.')).toBeInTheDocument();
  });

  // The core of "one thread, four chips". runStream used to `setMessages([...])`
  // for every seeded turn, so each chip wiped the conversation it landed in.
  it('appends chip turns to one continuous thread instead of replacing it', async () => {
    renderDock();
    await openAndSettle();

    fireEvent.change(composer(), { target: { value: 'what does this cover?' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(await screen.findByText('what does this cover?')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-dock-chip-quality'));

    expect(await screen.findByText('Analyze this page’s quality.')).toBeInTheDocument();
    // The earlier question is still there — that is the whole fix.
    expect(screen.getByText('what does this cover?')).toBeInTheDocument();
  });

  it('sends the composer text as Improve instructions and shows the user their own words', async () => {
    renderDock();
    await openAndSettle();

    fireEvent.change(composer(), { target: { value: 'tighten the intro' } });
    fireEvent.click(screen.getByTestId('ai-dock-chip-improve'));

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

  it('leaves the composer text alone for a chip that cannot carry it', async () => {
    renderDock();
    await openAndSettle();

    fireEvent.change(composer(), { target: { value: 'a question for later' } });
    fireEvent.click(screen.getByTestId('ai-dock-chip-summarize'));

    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());
    expect(composer().value).toBe('a question for later');
  });

  it('offers a retry instead of chips when the model list cannot be loaded', async () => {
    modelsFail = true;
    renderDock();
    act(() => {
      useAiDockStore.getState().openDock();
    });

    expect(await screen.findByText('Models unavailable — retry')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-dock-chip-improve')).not.toBeInTheDocument();
  });


  it('shows a violet streaming indicator and disables the composer mid-stream', async () => {
    // A stream that never resolves, so the in-flight state is observable.
    streamSSEMock.mockImplementation(() => (async function* () {
      await new Promise(() => {});
      yield {};
    })());

    renderDock();
    await openAndSettle();
    fireEvent.click(screen.getByTestId('ai-dock-chip-summarize'));

    await waitFor(() => {
      expect(screen.getByTestId('ai-dock-streaming')).toBeInTheDocument();
    });
    expect(composer()).toBeDisabled();
  });
});
