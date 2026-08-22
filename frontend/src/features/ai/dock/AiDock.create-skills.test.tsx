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

/** An async-iterable stand-in for one `/llm/*` SSE response. */
function sse(...chunks: Array<Record<string, unknown>>) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

function renderDock(initialEntry = '/pages/new') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LazyMotion features={domAnimation}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <AiProvider>
            <Routes>
              <Route path="/pages/new" element={<div>new page</div>} />
              <Route path="/pages/:id" element={<div>article</div>} />
            </Routes>
            <DockPanel variant="tab" onClose={() => {}} />
          </AiProvider>
        </MemoryRouter>
      </LazyMotion>
    </QueryClientProvider>,
  );
}

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

function composer(): HTMLTextAreaElement {
  return screen.getByTestId('ai-dock-input');
}

describe('AiDock Create Skills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAiDockStore.setState({ open: false });
    window.innerWidth = 1400;
    apiFetchMock.mockImplementation((path: string) => {
      if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
      if (path.startsWith('/llm/usecase-default')) return Promise.resolve({ model: 'llama3' });
      if (path === '/llm/conversations') return Promise.resolve([]);
      if (path === '/embeddings/status') return Promise.resolve({ total: 1, embedded: 1, isProcessing: false });
      return Promise.resolve({});
    });
    streamSSEMock.mockImplementation(() => sse({ content: '# Draft Spec\n\nSpec content' }, { final: true, done: true }));
  });

  afterEach(() => {
    useAiDockStore.setState({ open: false });
  });

  it('renders create skills in empty state when no page is open', async () => {
    renderDock('/pages/new');
    await openAndSettle();

    expect(screen.getByTestId('dock-empty-skills')).toBeInTheDocument();
    expect(screen.getByTestId('dock-empty-skill-spec')).toHaveTextContent('Technical Spec / RFC');
    expect(screen.getByTestId('dock-empty-skill-guide')).toHaveTextContent('How-To Guide / Runbook');
    expect(screen.getByTestId('dock-empty-skill-notes')).toHaveTextContent('Meeting Notes & Actions');
    expect(screen.getByTestId('dock-empty-skill-postmortem')).toHaveTextContent('Incident Post-Mortem');
    expect(screen.getByTestId('dock-empty-skill-custom')).toHaveTextContent('Custom Topic / Free Prompt');
  });

  it('clicking a create skill in empty state selects the action and focuses composer with suggested prompt', async () => {
    renderDock('/pages/new');
    await openAndSettle();

    fireEvent.click(screen.getByTestId('dock-empty-skill-spec'));
    expect(screen.getByTestId('assistant-action-select')).toHaveTextContent('Tech Spec');
    expect(composer()).toHaveValue('Draft a technical specification and RFC for a distributed real-time notification service with WebSocket connection management and Redis pub/sub.');
  });

  it('offers all create skills in the action select dropdown', async () => {
    renderDock('/pages/new');
    await openAndSettle();

    fireEvent.pointerDown(screen.getByTestId('assistant-action-select'), { button: 0 });

    expect(await screen.findByTestId('assistant-action-create-spec')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-action-create-guide')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-action-create-notes')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-action-create-postmortem')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-action-create-custom')).toBeInTheDocument();
  });

  it('runs create skill via POST /llm/generate and renders DockDraftCard', async () => {
    renderDock('/pages/new');
    await openAndSettle();

    fireEvent.click(screen.getByTestId('dock-empty-skill-spec'));
    fireEvent.change(composer(), { target: { value: 'Distributed Cache Service' } });
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/generate',
        expect.objectContaining({
          prompt: 'Draft a technical specification and RFC for: Distributed Cache Service',
          template: 'spec',
          model: 'llama3',
        }),
        expect.anything(),
      );
    });

    const draftCard = await screen.findByTestId('dock-draft-card');
    expect(draftCard).toBeInTheDocument();
    expect(screen.getByTestId('dock-draft-apply')).toBeInTheDocument();
  });

  it('dispatches compendiq:apply-draft event when Apply to Page is clicked', async () => {
    renderDock('/pages/new');
    await openAndSettle();

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    fireEvent.click(screen.getByTestId('dock-empty-skill-guide'));
    fireEvent.change(composer(), { target: { value: 'Deployment Runbook' } });
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    const applyBtn = await screen.findByTestId('dock-draft-apply');
    fireEvent.click(applyBtn);

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'compendiq:apply-draft',
        detail: expect.objectContaining({
          markdown: '# Draft Spec\n\nSpec content',
          title: 'Draft Spec',
        }),
      }),
    );
  });
});
