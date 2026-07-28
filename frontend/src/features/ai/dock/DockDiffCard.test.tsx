/**
 * Inline diff apply (#1126).
 *
 * Driven end to end through the real Improve stream rather than by handing the
 * card props, because the interesting behavior is the handoff: the dock lives
 * in AppLayout, the editor lives in the route, and they meet through the two
 * capabilities PageViewPage registers on the article view store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AiProvider, useAiContext } from '../AiContext';
import { AiDock } from './AiDock';
import { useAiDockStore } from '../../../stores/ai-dock-store';
import { useArticleViewStore } from '../../../stores/article-view-store';

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

const IMPROVED = 'You need a personal access token.';

/** Writes through the public context, the way a mode does — no internals. */
function DiffProbe() {
  const { setDiffBaseVersion } = useAiContext();
  return <button onClick={() => setDiffBaseVersion(1)}>move the page</button>;
}

function renderDock() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LazyMotion features={domAnimation}>
        <MemoryRouter initialEntries={['/pages/page-1']}>
          <AiProvider>
            <DiffProbe />
            <Routes>
              <Route path="/pages/:id" element={<div>article</div>} />
            </Routes>
            <AiDock />
          </AiProvider>
        </MemoryRouter>
      </LazyMotion>
    </QueryClientProvider>,
  );
}

/** Open the dock and run Improve to completion, leaving a pending diff. */
async function produceDiff() {
  act(() => {
    useAiDockStore.getState().openDock();
  });
  await waitFor(() => expect(screen.getByTestId('ai-dock-chip-improve')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('ai-dock-chip-improve'));
  await waitFor(() => expect(screen.getByTestId('dock-diff-card')).toBeInTheDocument());
}

describe('DockDiffCard (#1126)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAiDockStore.setState({ open: false, seed: null });
    useArticleViewStore.setState({
      editing: false, editorDirty: false, requestEdit: null, applyContent: null,
    });
    window.innerWidth = 1400;
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/pages/page-1') return Promise.resolve(PAGE);
      if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
      if (path.startsWith('/llm/usecase-default')) return Promise.resolve({ model: 'llama3' });
      if (path === '/llm/conversations') return Promise.resolve([]);
      if (path === '/embeddings/status') return Promise.resolve({ total: 1, embedded: 1, isProcessing: false });
      return Promise.resolve({});
    });
    streamSSEMock.mockImplementation(() => (async function* () {
      yield { content: IMPROVED };
      yield { final: true, done: true, originalMarkdown: PAGE.bodyText, layoutTokensLost: false };
    })());
  });

  afterEach(() => {
    useAiDockStore.setState({ open: false, seed: null });
    useArticleViewStore.setState({ editing: false, editorDirty: false, requestEdit: null, applyContent: null });
  });

  it('renders the change inline with its own Apply and Skip', async () => {
    renderDock();
    await produceDiff();

    expect(screen.getByText('Proposed changes')).toBeInTheDocument();
    expect(screen.getByTestId('dock-unified-diff')).toHaveTextContent('personal access token');
    expect(screen.getByTestId('dock-diff-apply')).toBeInTheDocument();
    expect(screen.getByTestId('dock-diff-skip')).toBeInTheDocument();
  });

  it('writes into the open editor rather than the server, and clears itself', async () => {
    const applyContent = vi.fn().mockReturnValue('applied' as const);
    useArticleViewStore.setState({ editing: true, applyContent });

    renderDock();
    await produceDiff();

    expect(screen.getByTestId('dock-diff-apply')).toHaveTextContent('Apply');
    fireEvent.click(screen.getByTestId('dock-diff-apply'));

    expect(applyContent).toHaveBeenCalledTimes(1);
    // Markdown in, sanitized HTML out — the editor speaks HTML.
    expect(applyContent.mock.calls[0]![0]).toContain('personal access token');
    expect(applyContent.mock.calls[0]![0]).toMatch(/^<p>/);
    // Nothing was published: no apply round-trip to the server.
    expect(apiFetchMock).not.toHaveBeenCalledWith('/llm/improvements/apply', expect.anything());
    await waitFor(() => expect(screen.queryByTestId('dock-diff-card')).not.toBeInTheDocument());
  });

  it('offers to open the editor in read mode instead of failing', async () => {
    const applyContent = vi.fn().mockReturnValue('applied' as const);
    const requestEdit = vi.fn();
    useArticleViewStore.setState({ editing: false, requestEdit, applyContent: null });

    renderDock();
    await produceDiff();

    // The button names what it will actually do.
    expect(screen.getByTestId('dock-diff-apply')).toHaveTextContent('Edit & apply');
    fireEvent.click(screen.getByTestId('dock-diff-apply'));

    expect(requestEdit).toHaveBeenCalledTimes(1);
    expect(applyContent).not.toHaveBeenCalled();
    expect(screen.getByTestId('dock-diff-awaiting-editor')).toBeInTheDocument();

    // PageViewPage enters edit mode; the editor registers itself one tick later,
    // which is exactly the ordering the deferred apply has to tolerate.
    act(() => useArticleViewStore.setState({ editing: true }));
    expect(applyContent).not.toHaveBeenCalled();
    act(() => useArticleViewStore.setState({ applyContent }));

    await waitFor(() => expect(applyContent).toHaveBeenCalledTimes(1));
  });

  it('lets the user back out while the editor is still being asked for', async () => {
    // handleStartEditing can defer behind the "Restore draft?" dialog and the
    // user may dismiss it, so the waiting state must never be a dead end.
    useArticleViewStore.setState({ editing: false, requestEdit: vi.fn(), applyContent: null });

    renderDock();
    await produceDiff();
    fireEvent.click(screen.getByTestId('dock-diff-apply'));
    expect(screen.getByTestId('dock-diff-awaiting-editor')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByTestId('dock-diff-awaiting-editor')).not.toBeInTheDocument();
    expect(screen.getByTestId('dock-diff-apply')).toBeInTheDocument();
  });

  it('offers a re-run, not an overwrite, when the document moved under the diff', async () => {
    const applyContent = vi.fn().mockReturnValue('applied' as const);
    useArticleViewStore.setState({ editing: true, applyContent });

    renderDock();
    await produceDiff();

    act(() => {
      fireEvent.click(screen.getByText('move the page'));
    });

    expect(screen.getByTestId('dock-diff-stale')).toBeInTheDocument();
    expect(screen.queryByTestId('dock-diff-apply')).not.toBeInTheDocument();

    streamSSEMock.mockClear();
    fireEvent.click(screen.getByTestId('dock-diff-rerun'));

    await waitFor(() => expect(streamSSEMock).toHaveBeenCalledWith('/llm/improve', expect.anything(), expect.anything()));
    expect(applyContent).not.toHaveBeenCalled();
  });

  it('warns that applying replaces unsaved editor work, and still allows it', async () => {
    const applyContent = vi.fn().mockReturnValue('applied' as const);
    useArticleViewStore.setState({ editing: true, editorDirty: true, applyContent });

    renderDock();
    await produceDiff();

    // The improvement was computed from the published body, not from what is in
    // the editor — so say what applying costs. TipTap history makes it undoable,
    // which is why this warns rather than blocks.
    expect(screen.getByTestId('dock-diff-unsaved')).toHaveTextContent('unsaved changes');
    fireEvent.click(screen.getByTestId('dock-diff-apply'));
    expect(applyContent).toHaveBeenCalledTimes(1);
  });

  it('skips without touching the document', async () => {
    const applyContent = vi.fn().mockReturnValue('applied' as const);
    useArticleViewStore.setState({ editing: true, applyContent });

    renderDock();
    await produceDiff();
    fireEvent.click(screen.getByTestId('dock-diff-skip'));

    await waitFor(() => expect(screen.queryByTestId('dock-diff-card')).not.toBeInTheDocument());
    expect(applyContent).not.toHaveBeenCalled();
  });

  it('surfaces the backend layout-token verdict before the user can apply', async () => {
    streamSSEMock.mockImplementation(() => (async function* () {
      yield { content: IMPROVED };
      yield { final: true, done: true, originalMarkdown: PAGE.bodyText, layoutTokensLost: true };
    })());
    useArticleViewStore.setState({ editing: true, applyContent: vi.fn().mockReturnValue('applied' as const) });

    renderDock();
    await produceDiff();

    expect(screen.getByTestId('layout-token-loss-warning')).toBeInTheDocument();
  });
});
