/**
 * Inline diff apply (#1126).
 *
 * Driven end to end through the real Improve stream rather than by handing the
 * card props. The load-bearing assertion in here is not the happy path: it is
 * that Apply goes through `POST /llm/improvements/apply` and therefore keeps
 * that route's media protection (#723) and column-layout guard (#781), and that
 * its 409 / 422 rejections stay visible instead of vanishing into a toast.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { toast } from 'sonner';
import { AiProvider, useAiContext } from '../AiContext';
import { AiDock } from './AiDock';
import { useAiDockStore } from '../../../stores/ai-dock-store';
import { useArticleViewStore } from '../../../stores/article-view-store';
import { ApiError } from '../../../shared/lib/api';

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

function baseRoutes(path: string) {
  if (path === '/pages/page-1') return Promise.resolve(PAGE);
  if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
  if (path.startsWith('/llm/usecase-default')) return Promise.resolve({ model: 'llama3' });
  if (path === '/llm/conversations') return Promise.resolve([]);
  if (path === '/embeddings/status') return Promise.resolve({ total: 1, embedded: 1, isProcessing: false });
  return Promise.resolve({});
}

/** Make `POST /llm/improvements/apply` fail with `status`. */
function failApplyWith(status: number, message: string) {
  apiFetchMock.mockImplementation((path: string) =>
    path === '/llm/improvements/apply'
      ? Promise.reject(new ApiError(status, message))
      : baseRoutes(path));
}

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
    useArticleViewStore.setState({ editing: false });
    window.innerWidth = 1400;
    apiFetchMock.mockImplementation(baseRoutes);
    streamSSEMock.mockImplementation(() => (async function* () {
      yield { content: IMPROVED };
      yield { final: true, done: true, originalMarkdown: PAGE.bodyText, layoutTokensLost: false };
    })());
  });

  afterEach(() => {
    useAiDockStore.setState({ open: false, seed: null });
    useArticleViewStore.setState({ editing: false });
  });

  it('renders the change inline with its own Apply and Skip', async () => {
    renderDock();
    await produceDiff();

    expect(screen.getByText('Proposed changes')).toBeInTheDocument();
    expect(screen.getByTestId('dock-unified-diff')).toHaveTextContent('personal access token');
    expect(screen.getByTestId('dock-diff-apply')).toBeInTheDocument();
    expect(screen.getByTestId('dock-diff-skip')).toBeInTheDocument();
  });

  // The guard that matters. A client-side markdown→HTML round-trip would strip
  // Confluence media and column layouts; the server route re-injects media
  // (#723) and realigns / rejects layouts (#781). Applying must therefore go
  // through that route, carrying the version the diff was produced from.
  it('applies through the server route that protects media and layout', async () => {
    renderDock();
    await produceDiff();

    fireEvent.click(screen.getByTestId('dock-diff-apply'));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/llm/improvements/apply', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          pageId: 'page-1',
          improvedMarkdown: IMPROVED,
          version: 4,
          title: 'Onboarding Guide',
        }),
      }));
    });
    await waitFor(() => expect(screen.queryByTestId('dock-diff-card')).not.toBeInTheDocument());
    expect(toast.success).toHaveBeenCalled();
  });

  it('keeps the 422 layout rejection on the card and offers a re-run', async () => {
    // #781: the backend refused to flatten the page's column layout. The page
    // is unchanged, so this must not read as "applied" and must not disappear.
    failApplyWith(422, "The AI response lost this page's column layout and it could not be recovered, so the change was not applied.");
    renderDock();
    await produceDiff();

    fireEvent.click(screen.getByTestId('dock-diff-apply'));

    expect(await screen.findByTestId('dock-diff-apply-error')).toHaveTextContent('column layout');
    expect(screen.getByTestId('dock-diff-card')).toBeInTheDocument();
    expect(screen.queryByTestId('dock-diff-apply')).not.toBeInTheDocument();
    expect(screen.getByTestId('dock-diff-rerun')).toBeInTheDocument();
    // Recovery is a decision made here, so it is not delegated to a toast.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('keeps the 409 stale-page rejection on the card and re-runs from it', async () => {
    failApplyWith(409, 'Page has been modified since you loaded it. Please refresh and try again.');
    renderDock();
    await produceDiff();

    fireEvent.click(screen.getByTestId('dock-diff-apply'));

    expect(await screen.findByTestId('dock-diff-apply-error')).toHaveTextContent('modified since you loaded it');
    expect(screen.getByTestId('dock-diff-rerun')).toBeInTheDocument();

    streamSSEMock.mockClear();
    fireEvent.click(screen.getByTestId('dock-diff-rerun'));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalledWith('/llm/improve', expect.anything(), expect.anything()));
  });

  it('toasts an unexpected failure but leaves the diff applyable', async () => {
    failApplyWith(500, 'Internal server error');
    renderDock();
    await produceDiff();

    fireEvent.click(screen.getByTestId('dock-diff-apply'));

    expect(await screen.findByTestId('dock-diff-apply-error')).toHaveTextContent('Internal server error');
    expect(toast.error).toHaveBeenCalledWith('Internal server error');
    // Not a 409/422 — the page's state is unknown, so retrying stays available.
    expect(screen.getByTestId('dock-diff-apply')).toBeInTheDocument();
  });

  it('warns before Apply when the response dropped the layout markers', async () => {
    // ImproveMode's pre-flight has to survive into the dock: the user sees this
    // BEFORE spending a round-trip on a change the backend will reject. The
    // backend's final-event verdict is authoritative over any client heuristic.
    streamSSEMock.mockImplementation(() => (async function* () {
      yield { content: IMPROVED };
      yield { final: true, done: true, originalMarkdown: PAGE.bodyText, layoutTokensLost: true };
    })());

    renderDock();
    await produceDiff();

    expect(screen.getByTestId('layout-token-loss-warning')).toBeInTheDocument();
    expect(screen.getByTestId('dock-diff-apply')).toBeInTheDocument();
  });

  it('falls back to the [[[ heuristic when the stream ended without a verdict', async () => {
    streamSSEMock.mockImplementation(() => (async function* () {
      yield { content: 'A rewrite with no layout tokens at all.' };
      yield { final: true, done: true, originalMarkdown: '[[[col]]] Original with layout.' };
    })());

    renderDock();
    await produceDiff();

    expect(screen.getByTestId('layout-token-loss-warning')).toBeInTheDocument();
  });

  it('offers a re-run, not an apply, when the document moved under the diff', async () => {
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
    expect(apiFetchMock).not.toHaveBeenCalledWith('/llm/improvements/apply', expect.anything());
  });

  it('blocks Apply while the editor is open, because it rewrites the saved page', async () => {
    // A server-side apply under an open editor would leave the editor holding a
    // stale copy that the next Save pushes back over the improvement.
    useArticleViewStore.setState({ editing: true });
    renderDock();
    await produceDiff();

    expect(screen.getByTestId('dock-diff-apply')).toBeDisabled();
    expect(screen.getByTestId('dock-diff-editing')).toHaveTextContent('Save or cancel your edit first');
  });

  it('skips without touching the document', async () => {
    renderDock();
    await produceDiff();
    fireEvent.click(screen.getByTestId('dock-diff-skip'));

    await waitFor(() => expect(screen.queryByTestId('dock-diff-card')).not.toBeInTheDocument());
    expect(apiFetchMock).not.toHaveBeenCalledWith('/llm/improvements/apply', expect.anything());
  });
});
