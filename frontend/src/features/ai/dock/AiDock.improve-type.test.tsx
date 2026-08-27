import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AiProvider } from '../AiContext';
import { DockPanel } from './DockPanel';

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
};

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
            <Routes><Route path="/pages/:id" element={<div>article</div>} /></Routes>
            <DockPanel variant="tab" onClose={() => {}} />
          </AiProvider>
        </MemoryRouter>
      </LazyMotion>
    </QueryClientProvider>,
  );
}

async function choose(action: string) {
  await waitFor(() => expect(screen.getByTestId('assistant-action-select')).not.toBeDisabled());
  fireEvent.pointerDown(screen.getByTestId('assistant-action-select'), { button: 0 });
  fireEvent.click(await screen.findByTestId(`assistant-action-${action}`));
}

describe('docked Assistant action selector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/pages/page-1') return Promise.resolve(PAGE);
      if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
      if (path.startsWith('/llm/usecase-default')) return Promise.resolve({ model: 'llama3' });
      if (path === '/llm/conversations') return Promise.resolve([]);
      return Promise.resolve({});
    });
    streamSSEMock.mockImplementation(() => sse({ content: 'ok' }, { final: true, done: true }));
  });


  it('renders a labelled, visually distinct Skill control in the right panel', async () => {
    renderDock();

    const control = await screen.findByTestId('assistant-action-select');
    expect(control).toHaveTextContent('Skill');
    expect(control).toHaveTextContent('Q&A');
    expect(control.className).toContain('bg-status-ai/10');
  });
  it('offers all five rewrite skills as standalone choices', async () => {
    renderDock();
    fireEvent.pointerDown(await screen.findByTestId('assistant-action-select'), { button: 0 });

    for (const type of ['grammar', 'structure', 'clarity', 'technical', 'completeness']) {
      expect(await screen.findByTestId(`assistant-action-${type}`)).toBeInTheDocument();
    }
  });

  // #1361 / owner ruling 3: Generate IS offered here now. #1401 already routed
  // it — `sendSelectedAction` (DockPanel.tsx:154-165) sends a plain `generate`
  // through `runCreateSkill('custom')`, and the dock's empty state already
  // offers that same custom skill — so the old assertion pinned a hidden menu
  // item rather than a missing capability. Summarize and Quality are still not
  // assistant modes at all, on any surface.
  it('does not offer Summarize or Quality in the article Assistant', async () => {
    renderDock();
    fireEvent.pointerDown(await screen.findByTestId('assistant-action-select'), { button: 0 });

    expect(screen.queryByText('Summarize')).not.toBeInTheDocument();
    expect(screen.queryByText('Quality')).not.toBeInTheDocument();
    expect(await screen.findByTestId('assistant-action-generate')).toBeInTheDocument();
  });

  it('uses the selected rewrite skill when Send is clicked and keeps it selected', async () => {
    renderDock();
    await choose('technical');

    expect(screen.getByTestId('assistant-action-select')).toHaveAccessibleName('Selected action: Technical');
    fireEvent.change(screen.getByTestId('ai-dock-input'), { target: { value: 'check every command' } });
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    await waitFor(() => expect(streamSSEMock).toHaveBeenCalledWith(
      '/llm/improve',
      expect.objectContaining({ type: 'technical', instruction: 'check every command' }),
      expect.anything(),
    ));
    expect(screen.getByTestId('assistant-action-select')).toHaveAccessibleName('Selected action: Technical');
  });

  it('runs the selected rewrite skill with no typed instruction', async () => {
    renderDock();
    await choose('completeness');

    expect(screen.getByTestId('ai-dock-send')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    await waitFor(() => expect(streamSSEMock).toHaveBeenCalledWith(
      '/llm/improve',
      expect.objectContaining({ type: 'completeness' }),
      expect.anything(),
    ));
  });
});
