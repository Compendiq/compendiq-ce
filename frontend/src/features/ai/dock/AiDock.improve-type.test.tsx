/**
 * Choosing an improvement pass from the docked assistant (#1177).
 *
 * Same harness as `AiDock.test.tsx` — the dock is mounted the way AppLayout
 * mounts it, under the hoisted provider, with only `apiFetch` and `streamSSE`
 * mocked — so these describe what a user can see and press.
 *
 * The defect: `/ai?mode=improve` has offered five passes since forever, the dock
 * offered none, and `AiContext` quietly supplied `grammar` for every dock run.
 * The fix is a disclosure on the Improve chip, so the assertions worth having
 * are about reachability (can the fifth pass be selected at all?) and about the
 * value actually arriving in the request body.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AiProvider } from '../AiContext';
import { AiDock } from './AiDock';
import { useAiDockStore } from '../../../stores/ai-dock-store';
import { useUiStore } from '../../../stores/ui-store';
import { IMPROVEMENT_DESCRIPTIONS } from '../improvement-types';

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

function renderDock() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LazyMotion features={domAnimation}>
        <MemoryRouter initialEntries={['/pages/page-1']}>
          <AiProvider>
            <button data-testid="dock-trigger">AI Assistant</button>
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

/** Open the dock and wait until it has a model, i.e. until the chips are live. */
async function openAndSettle() {
  act(() => {
    useAiDockStore.getState().openDock();
  });
  await waitFor(() => {
    expect(screen.getByTestId('ai-dock-chip-summarize')).not.toBeDisabled();
  });
}

const toggle = () => screen.getByTestId('ai-dock-improve-types-toggle');

/** Open the drawer and pick one of the five passes. */
async function chooseType(type: string) {
  fireEvent.click(toggle());
  fireEvent.click(await screen.findByTestId(`ai-dock-improve-type-${type}`));
}

describe('AiDock improvement type (#1177)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAiDockStore.setState({ open: false });
    useUiStore.setState({ aiDockWidth: 420 });
    window.innerWidth = 1400;
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/pages/page-1') return Promise.resolve(PAGE);
      if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
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

  it('keeps the five passes folded away until they are asked for', async () => {
    renderDock();
    await openAndSettle();

    // The whole point of the disclosure: a 420px column does not spend a line on
    // a control most runs leave alone.
    expect(screen.queryByTestId('ai-dock-improve-types')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-dock-improve-type-structure')).not.toBeInTheDocument();
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    // Nothing to report while it is the documented default.
    expect(screen.queryByTestId('ai-dock-improve-type-label')).not.toBeInTheDocument();
  });

  it('reveals all five, with grammar selected and described', async () => {
    renderDock();
    await openAndSettle();

    fireEvent.click(toggle());

    expect(await screen.findByTestId('ai-dock-improve-types')).toBeInTheDocument();
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    for (const type of ['grammar', 'structure', 'clarity', 'technical', 'completeness']) {
      expect(screen.getByTestId(`ai-dock-improve-type-${type}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('ai-dock-improve-type-grammar')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('ai-dock-improve-type-structure')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText(IMPROVEMENT_DESCRIPTIONS.grammar)).toBeInTheDocument();
  });

  it('names the pass on the chip once it is no longer the default', async () => {
    renderDock();
    await openAndSettle();

    await chooseType('completeness');

    // A chip that would rewrite the page differently than it reads is exactly
    // the surprise #1176 removed from the rail — so the label says so.
    expect(screen.getByTestId('ai-dock-improve-type-label')).toHaveTextContent('completeness');
    expect(screen.getByTestId('ai-dock-chip-improve').getAttribute('title'))
      .toContain('completeness pass');
    expect(screen.getByText(IMPROVEMENT_DESCRIPTIONS.completeness)).toBeInTheDocument();
    expect(screen.getByTestId('ai-dock-improve-type-completeness')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('ai-dock-improve-type-grammar')).toHaveAttribute('aria-pressed', 'false');
  });

  // The defect itself: before this, every dock Improve was a grammar pass no
  // matter what the user wanted.
  it('sends the chosen pass to /llm/improve instead of the grammar default', async () => {
    renderDock();
    await openAndSettle();

    await chooseType('structure');
    fireEvent.click(screen.getByTestId('ai-dock-chip-improve'));

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/improve',
        expect.objectContaining({ type: 'structure', content: PAGE.bodyHtml, pageId: 'page-1' }),
        expect.anything(),
      );
    });
    // And the turn in the thread says which pass ran, so the answer above it is
    // readable a scroll later.
    expect(await screen.findByText('Improve this page (structure).')).toBeInTheDocument();
  });

  it('carries the chosen pass alongside typed instructions', async () => {
    renderDock();
    await openAndSettle();

    fireEvent.change(screen.getByTestId('ai-dock-input'), { target: { value: 'tighten the intro' } });
    await chooseType('clarity');
    fireEvent.click(screen.getByTestId('ai-dock-chip-improve'));

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/improve',
        expect.objectContaining({ type: 'clarity', instruction: 'tighten the intro' }),
        expect.anything(),
      );
    });
  });

  it('folds the drawer away once the run it configured has started', async () => {
    renderDock();
    await openAndSettle();

    await chooseType('technical');
    expect(screen.getByTestId('ai-dock-improve-types')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-dock-chip-improve'));

    // The choice is committed; the column goes back to one row of chips, with
    // the chip still saying what it will do next time.
    await waitFor(() => {
      expect(screen.queryByTestId('ai-dock-improve-types')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('ai-dock-improve-type-label')).toHaveTextContent('technical');
  });

  it('leaves the drawer alone when a chip that ignores it is pressed', async () => {
    renderDock();
    await openAndSettle();

    fireEvent.click(toggle());
    expect(await screen.findByTestId('ai-dock-improve-types')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-dock-chip-summarize'));

    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());
    // Summarize has no pass to choose, so it has no business closing the
    // control the user opened.
    expect(screen.getByTestId('ai-dock-improve-types')).toBeInTheDocument();
  });

  it('closes on a second press of the disclosure, keeping the selection', async () => {
    renderDock();
    await openAndSettle();

    await chooseType('clarity');
    fireEvent.click(toggle());

    await waitFor(() => {
      expect(screen.queryByTestId('ai-dock-improve-types')).not.toBeInTheDocument();
    });
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('ai-dock-improve-type-label')).toHaveTextContent('clarity');
  });

  // The panel root closes the whole assistant on Escape. Without a stop, tidying
  // the drawer away would take the conversation with it.
  it('gives Escape to the drawer first, and hands focus back to the caret', async () => {
    renderDock();
    await openAndSettle();

    fireEvent.click(toggle());
    const drawer = await screen.findByTestId('ai-dock-improve-types');

    fireEvent.keyDown(drawer, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('ai-dock-improve-types')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('ai-dock')).toBeInTheDocument();
    expect(document.activeElement).toBe(toggle());

    // The next one is the dock's again.
    fireEvent.keyDown(toggle(), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('ai-dock')).not.toBeInTheDocument();
    });
  });

  it('goes quiet with the chip it belongs to while a stream is in flight', async () => {
    // A stream that never resolves, so the in-flight state is observable.
    streamSSEMock.mockImplementation(() => (async function* () {
      await new Promise(() => {});
      yield {};
    })());

    renderDock();
    await openAndSettle();
    fireEvent.click(toggle());
    fireEvent.click(screen.getByTestId('ai-dock-chip-summarize'));

    await waitFor(() => {
      expect(screen.getByTestId('ai-dock-chip-improve')).toBeDisabled();
    });
    // One control, one disabled state — a half-lit split chip reads as a
    // rendering fault.
    expect(toggle()).toBeDisabled();
    expect(screen.getByTestId('ai-dock-improve-type-structure')).toBeDisabled();
  });
});
