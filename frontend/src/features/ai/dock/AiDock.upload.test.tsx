/**
 * Attaching a reference document to the docked assistant (#1131).
 *
 * Same shape as `AiDock.test.tsx`: the dock is mounted the way AppLayout mounts
 * it and only the network boundary is mocked. `useExtractDocument` posts with
 * raw `fetch` rather than `apiFetch`, so the upload is stubbed at `fetch`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AiProvider } from '../AiContext';
import { AiDock } from './AiDock';
import { useAiDockStore } from '../../../stores/ai-dock-store';
import { useUiStore } from '../../../stores/ui-store';

Element.prototype.scrollIntoView = vi.fn();

const apiFetchMock = vi.fn();
vi.mock('../../../shared/lib/api', async () =>
  (await import('../../../test-utils')).apiModuleMock(() => apiFetchMock));

const streamSSEMock = vi.fn();
vi.mock('../../../shared/lib/sse', () => ({
  streamSSE: (...args: unknown[]) => streamSSEMock(...args),
}));

const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

function page(id: string, title: string) {
  return {
    id, title,
    bodyHtml: '<p>You need a PAT.</p>',
    bodyText: 'You need a PAT.',
    version: 4,
    hasChildren: false,
    labels: [],
    spaceKey: 'ENG',
  };
}

function sse(...chunks: Array<Record<string, unknown>>) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

const DOCX = new File(['PK'], 'q3-architecture.docx', {
  type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});

/** One `/api/llm/extract-document` response. */
function extractResponse(over: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      format: 'docx',
      text: 'The service must retry three times.',
      fileSize: 12_800,
      preview: 'The service must retry three times.',
      ...over,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

function GoTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button data-testid="go" onClick={() => navigate(to)}>go</button>;
}

function renderDock() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LazyMotion features={domAnimation}>
        <MemoryRouter initialEntries={['/pages/page-1']}>
          <AiProvider>
            <GoTo to="/pages/page-2" />
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

async function openAndSettle() {
  act(() => {
    useAiDockStore.getState().openDock();
  });
  await waitFor(() => expect(screen.getByTestId('ai-dock-send')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByTestId('ai-dock-chip-improve')).not.toBeDisabled());
}

async function attach(file = DOCX) {
  fireEvent.change(screen.getByTestId('ai-dock-doc-file-input'), { target: { files: [file] } });
  return screen.findByTestId('ai-dock-doc-attachment-card');
}

function improveBody(): Record<string, unknown> {
  const call = streamSSEMock.mock.calls.find((c) => c[0] === '/llm/improve');
  expect(call, 'expected an /llm/improve request').toBeDefined();
  return call![1] as Record<string, unknown>;
}

describe('AiDock — reference document (#1131)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAiDockStore.setState({ open: false, seed: null, seedPageId: null });
    useUiStore.setState({ aiDockWidth: 420 });
    window.innerWidth = 1400;
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/pages/page-1') return Promise.resolve(page('page-1', 'Onboarding Guide'));
      if (path === '/pages/page-2') return Promise.resolve(page('page-2', 'Runbook'));
      if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
      if (path.startsWith('/llm/usecase-default')) return Promise.resolve({ model: 'llama3' });
      if (path === '/llm/conversations') return Promise.resolve([]);
      if (path === '/embeddings/status') return Promise.resolve({ total: 1, embedded: 1, isProcessing: false });
      return Promise.resolve({});
    });
    streamSSEMock.mockImplementation(() => sse({ content: 'ok' }, { final: true, done: true }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(extractResponse());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAiDockStore.setState({ open: false, seed: null, seedPageId: null });
  });

  it('offers the attach control inside the composer, not as a standing panel', async () => {
    renderDock();
    await openAndSettle();

    const trigger = screen.getByTestId('ai-dock-doc-attach-button');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAccessibleName('Attach a document as reference for Improve');
    // Nothing occupies the column until a document is actually attached.
    expect(screen.queryByTestId('ai-dock-doc-attachment-card')).not.toBeInTheDocument();
    // The trigger shares the prompt box with the textarea and the send button.
    expect(trigger.closest('.nm-composer')).toContainElement(screen.getByTestId('ai-dock-input'));
  });

  it('posts the upload to the canonical extraction route', async () => {
    renderDock();
    await openAndSettle();
    await attach();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/llm/extract-document',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('names the attached document and what it will be used for', async () => {
    renderDock();
    await openAndSettle();

    const card = await attach();
    expect(card).toHaveTextContent('q3-architecture.docx');
    expect(card).toHaveTextContent('docx');
    expect(card).toHaveTextContent('reference for Improve');
  });

  it('sends the extracted text as referenceText, never folded into instruction', async () => {
    renderDock();
    await openAndSettle();
    await attach();

    fireEvent.change(screen.getByTestId('ai-dock-input'), { target: { value: 'tighten the intro' } });
    fireEvent.click(screen.getByTestId('ai-dock-chip-improve'));

    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());
    const body = improveBody();
    expect(body.referenceText).toBe('The service must retry three times.');
    expect(body.instruction).toBe('tighten the intro');
  });

  it('omits referenceText entirely when nothing is attached', async () => {
    renderDock();
    await openAndSettle();

    fireEvent.click(screen.getByTestId('ai-dock-chip-improve'));

    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());
    expect(improveBody().referenceText).toBeUndefined();
  });

  // Ask has no reference field, so the attachment must not silently ride along
  // on a question. The card says "reference for Improve" for this reason.
  it('does not attach the document to a plain question', async () => {
    renderDock();
    await openAndSettle();
    await attach();

    fireEvent.change(screen.getByTestId('ai-dock-input'), { target: { value: 'what is a PAT?' } });
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());
    const askCall = streamSSEMock.mock.calls.find((c) => c[0] === '/llm/ask');
    expect(askCall).toBeDefined();
    expect(askCall![1]).not.toHaveProperty('referenceText');
  });

  it('drops the reference again when it is removed', async () => {
    renderDock();
    await openAndSettle();
    await attach();

    fireEvent.click(screen.getByRole('button', { name: 'Remove document' }));
    expect(screen.queryByTestId('ai-dock-doc-attachment-card')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-dock-chip-improve'));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());
    expect(improveBody().referenceText).toBeUndefined();
  });

  // A document attached while reading one page is not background for the next.
  it('clears the attachment when the open document changes', async () => {
    renderDock();
    await openAndSettle();
    await attach();

    fireEvent.click(screen.getByTestId('go'));

    await waitFor(() => {
      expect(screen.queryByTestId('ai-dock-doc-attachment-card')).not.toBeInTheDocument();
    });
  });

  it('holds Improve back while an extraction is still in flight', async () => {
    let release: ((r: Response) => void) | undefined;
    vi.mocked(globalThis.fetch).mockReturnValue(
      new Promise<Response>((resolve) => { release = resolve; }),
    );

    renderDock();
    await openAndSettle();

    fireEvent.change(screen.getByTestId('ai-dock-doc-file-input'), { target: { files: [DOCX] } });

    // Firing now would send an Improve without the reference that is still
    // being extracted — the #940 failure, in the other surface.
    await waitFor(() => expect(screen.getByTestId('ai-dock-chip-improve')).toBeDisabled());
    // The other three chips do not read the attachment, so they stay live.
    expect(screen.getByTestId('ai-dock-chip-summarize')).not.toBeDisabled();

    await act(async () => {
      release!(extractResponse());
    });
    await waitFor(() => expect(screen.getByTestId('ai-dock-chip-improve')).not.toBeDisabled());
  });

  it('refuses an unsupported file before it reaches the server', async () => {
    renderDock();
    await openAndSettle();

    fireEvent.change(screen.getByTestId('ai-dock-doc-file-input'), {
      target: { files: [new File(['x'], 'diagram.png', { type: 'image/png' })] },
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Only PDF, DOCX, MD, TXT, RTF and ODT files are accepted',
      );
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('surfaces a server rejection and attaches nothing', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ message: 'DOCX contains no extractable text' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderDock();
    await openAndSettle();
    fireEvent.change(screen.getByTestId('ai-dock-doc-file-input'), { target: { files: [DOCX] } });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('DOCX contains no extractable text');
    });
    expect(screen.queryByTestId('ai-dock-doc-attachment-card')).not.toBeInTheDocument();
  });

  it('accepts a file dropped anywhere on the composer', async () => {
    renderDock();
    await openAndSettle();

    const composerBox = screen.getByTestId('ai-dock-input').closest('.nm-composer')!;
    fireEvent.dragEnter(composerBox);
    expect(await screen.findByTestId('ai-dock-doc-drop-hint')).toBeInTheDocument();

    fireEvent.drop(composerBox, { dataTransfer: { files: [DOCX] } });

    await screen.findByTestId('ai-dock-doc-attachment-card');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
