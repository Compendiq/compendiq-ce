/**
 * #283 — the docked assistant under article AI policy, mounted the way
 * AppLayout mounts it with only the network boundary mocked (`apiFetch`
 * for reads, `streamSSE` for the stream).
 *
 * Pinned here:
 *  - a `none` article: Send is aria-disabled with a reachable reason, Enter
 *    in the composer sends nothing, and a PROGRAMMATIC `runStream` with the
 *    article in its body is refused by the same guard — no bytes leave;
 *  - a `local_only` article whose resolved chat provider is not a confirmed
 *    declared-local provider is refused with that reason; one that is, is
 *    allowed and labelled "declared", never "verified";
 *  - an in-band `ai_history_not_replayable` error frame (HTTP 200 already
 *    established) gets the same recovery as the HTTP refusal: the typed
 *    prompt is restored, the thread's earlier turns stay, the seeded turn
 *    and placeholder are withdrawn, and New chat is offered;
 *  - a pre-policy page detail (no `aiPolicyActivation`) is not a denial.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
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

function page(over: Record<string, unknown> = {}) {
  return {
    id: 'page-1', title: 'Onboarding Guide',
    bodyHtml: '<p>You need a PAT.</p>', bodyText: 'You need a PAT.',
    version: 4, hasChildren: false, labels: [], spaceKey: 'ENG',
    aiPolicyActivation: 'active', aiPolicyRevision: 2, canChangeAiPolicy: false,
    ...over,
  };
}

const PROVIDER_ID = '00000000-0000-4000-8000-000000000001';
const CHAT_DEFAULT = { usecase: 'chat', providerId: PROVIDER_ID, providerName: 'GPU box', model: 'llama3', vision: null };

/** The `/llm/usecase-locality` row — the ONLY place locality comes from. */
function chatLocality(over: Record<string, unknown> = {}) {
  return { usecase: 'chat', providerId: PROVIDER_ID, providerName: 'GPU box', locality: 'external', localityConfirmed: false, ...over };
}

function routes(pageDetail: Record<string, unknown>, locality: Record<string, unknown> | null) {
  return (path: string) => {
    if (path === '/pages/page-1') return Promise.resolve(pageDetail);
    if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
    if (path.startsWith('/llm/usecase-locality')) {
      return locality ? Promise.resolve(locality) : Promise.reject(new Error('No provider resolved (HTTP 404)'));
    }
    if (path.startsWith('/llm/usecase-default')) return Promise.resolve(CHAT_DEFAULT);
    if (path === '/llm/conversations') return Promise.resolve([]);
    if (path === '/embeddings/status') return Promise.resolve({ total: 1, embedded: 1, isProcessing: false });
    return Promise.resolve({});
  };
}

function sse(...chunks: Array<Record<string, unknown>>) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

/** A programmatic caller — the shape a keyboard shortcut or a menu item has. */
function Programmatic() {
  const { runStream, pageId } = useAiContext();
  return (
    <button
      data-testid="programmatic-improve"
      onClick={() => void runStream('/llm/improve', { content: '<p>x</p>', type: 'grammar', model: 'llama3', pageId })}
    >
      programmatic
    </button>
  );
}

function renderDock() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LazyMotion features={domAnimation}>
        <MemoryRouter initialEntries={['/pages/page-1']}>
          <AiProvider>
            <Programmatic />
            <Routes>
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
  act(() => { useAiDockStore.getState().openDock(); });
  await waitFor(() => expect(screen.getByTestId('ai-dock-send')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByTestId('assistant-action-select')).not.toBeDisabled());
}

describe('docked assistant under article AI policy (#283)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAiDockStore.setState({ open: false });
    window.innerWidth = 1400;
    streamSSEMock.mockImplementation(() => sse({ content: 'answer' }, { done: true, final: true, conversationId: null }));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('a No-AI article: Send, Enter and a programmatic call all meet the same refusal before any bytes leave', async () => {
    apiFetchMock.mockImplementation(routes(page({ aiPolicy: 'none' }), chatLocality()));
    renderDock();
    await openAndSettle();

    const reason = await screen.findByTestId('ai-dock-policy-reason');
    expect(reason).toHaveAttribute('data-denied', 'true');
    expect(reason).toHaveTextContent('No AI allowed');
    const send = screen.getByTestId('ai-dock-send');
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send).toHaveAttribute('aria-describedby', 'ai-dock-policy-reason');

    fireEvent.change(screen.getByTestId('ai-dock-input'), { target: { value: 'what is a PAT?' } });
    fireEvent.click(send);
    fireEvent.keyDown(screen.getByTestId('ai-dock-input'), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('programmatic-improve'));

    // The guard is in runStream: the programmatic path records the reason
    // on the thread, and nothing reached the stream boundary.
    await screen.findByTestId('policy-denial-reason');
    expect(streamSSEMock).not.toHaveBeenCalled();
    // The typed prompt survives.
    expect(screen.getByTestId('ai-dock-input')).toHaveValue('what is a PAT?');
  });

  it('a Local-AI-only article is refused when the resolved chat provider is not confirmed declared-local, and names the provider', async () => {
    apiFetchMock.mockImplementation(routes(page({ aiPolicy: 'local_only' }), chatLocality({ locality: 'local', localityConfirmed: false })));
    renderDock();
    await openAndSettle();
    const reason = await screen.findByTestId('ai-dock-policy-reason');
    expect(reason).toHaveAttribute('data-denied', 'true');
    expect(reason).toHaveTextContent('Local AI only');
    expect(reason).toHaveTextContent('GPU box');
    expect(reason).toHaveTextContent('not a confirmed declared-local provider');
    fireEvent.click(screen.getByTestId('programmatic-improve'));
    await screen.findByTestId('policy-denial-reason');
    expect(streamSSEMock).not.toHaveBeenCalled();
  });

  it('a Local-AI-only article is refused when the locality route cannot answer — unknown is never local', async () => {
    apiFetchMock.mockImplementation(routes(page({ aiPolicy: 'local_only' }), null));
    renderDock();
    await openAndSettle();
    const reason = await screen.findByTestId('ai-dock-policy-reason');
    await waitFor(() => expect(reason).toHaveTextContent('provider locality could not be read'));
    expect(reason).toHaveAttribute('data-denied', 'true');
    fireEvent.click(screen.getByTestId('programmatic-improve'));
    await screen.findByTestId('policy-denial-reason');
    expect(streamSSEMock).not.toHaveBeenCalled();
  });

  it('a Local-AI-only article is allowed with a confirmed declared-local provider, described as declared — never verified', async () => {
    apiFetchMock.mockImplementation(routes(page({ aiPolicy: 'local_only' }), chatLocality({ locality: 'local', localityConfirmed: true })));
    renderDock();
    await openAndSettle();
    const reason = await screen.findByTestId('ai-dock-policy-reason');
    expect(reason).not.toHaveAttribute('data-denied');
    expect(reason).toHaveTextContent(/declared local/i);
    // The copy may DISCLAIM verification; it must never CLAIM it.
    expect(reason.textContent).toMatch(/not independently verified/i);
    expect(reason.textContent!.replace(/not independently verified/i, '')).not.toMatch(/verified/i);
    expect(screen.getByTestId('ai-dock-send')).not.toHaveAttribute('aria-disabled');
    fireEvent.click(screen.getByTestId('programmatic-improve'));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalledTimes(1));
  });

  it('an in-band ai_history_not_replayable frame restores the draft, keeps earlier turns, withdraws the seeded turn and offers New chat', async () => {
    apiFetchMock.mockImplementation(routes(page({ aiPolicy: 'all' }), chatLocality()));
    streamSSEMock
      .mockImplementationOnce(() => sse({ content: 'First answer.' }, { done: true, final: true, conversationId: 'c1' }))
      .mockImplementationOnce(() => sse({ error: 'History cannot be replayed', code: 'ai_history_not_replayable' }));
    renderDock();
    await openAndSettle();

    fireEvent.change(screen.getByTestId('ai-dock-input'), { target: { value: 'first question' } });
    fireEvent.click(screen.getByTestId('ai-dock-send'));
    await screen.findByText('First answer.');

    fireEvent.change(screen.getByTestId('ai-dock-input'), { target: { value: 'follow-up about the restricted page' } });
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    const notice = await screen.findByTestId('policy-refusal-notice');
    expect(notice).toHaveTextContent('Nothing was sent');
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
    // Draft restored; earlier exchange intact; the refused turn withdrawn.
    expect(screen.getByTestId('ai-dock-input')).toHaveValue('follow-up about the restricted page');
    expect(screen.getByText('First answer.')).toBeInTheDocument();
    expect(screen.queryByText('follow-up about the restricted page', { selector: 'div' })).toBeNull();
    expect(screen.queryByTestId('message-error')).toBeNull();
  });

  it('a page detail from a pre-policy server (no aiPolicyActivation) is not a denial', async () => {
    const legacy = page({ aiPolicy: undefined, aiPolicyActivation: undefined, aiPolicyRevision: undefined });
    apiFetchMock.mockImplementation(routes(legacy, null));
    renderDock();
    await openAndSettle();
    expect(screen.queryByTestId('ai-dock-policy-reason')).toBeNull();
    fireEvent.click(screen.getByTestId('programmatic-improve'));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalledTimes(1));
  });

  it('a page detail that speaks the contract but reports no readable policy fails closed', async () => {
    apiFetchMock.mockImplementation(routes(page({ aiPolicy: undefined }), chatLocality()));
    renderDock();
    await openAndSettle();
    const reason = await screen.findByTestId('ai-dock-policy-reason');
    expect(reason).toHaveTextContent('could not be read');
    fireEvent.click(screen.getByTestId('programmatic-improve'));
    await screen.findByTestId('policy-denial-reason');
    expect(streamSSEMock).not.toHaveBeenCalled();
  });
});
