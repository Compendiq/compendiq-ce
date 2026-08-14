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
const YAML = new File(['services:\n  - api'], 'config.yaml', {
  type: 'application/yaml',
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
  await waitFor(() => expect(screen.getByTestId('ai-dock-send')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByTestId('assistant-action-select')).not.toBeDisabled());
}

async function selectAction(action: string) {
  fireEvent.pointerDown(screen.getByTestId('assistant-action-select'), { button: 0 });
  fireEvent.click(await screen.findByTestId(`assistant-action-${action}`));
}

async function attach(file = DOCX) {
  fireEvent.change(screen.getByTestId('ai-dock-attach-file-input'), { target: { files: [file] } });
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
    useAiDockStore.setState({ open: false });
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
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => extractResponse());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAiDockStore.setState({ open: false });
  });

  it('offers one combined attach control inside the composer, not as a standing panel', async () => {
    renderDock();
    await openAndSettle();

    const trigger = screen.getByTestId('ai-dock-attach-button');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAccessibleName('Attach a document or image');
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
    expect(card).toHaveTextContent('context for Q&A or rewriting');
  });

  it('sends the extracted text as referenceText, never folded into instruction', async () => {
    renderDock();
    await openAndSettle();
    await attach();
    await selectAction('grammar');

    fireEvent.change(screen.getByTestId('ai-dock-input'), { target: { value: 'tighten the intro' } });
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());
    const body = improveBody();
    expect(body.referenceText).toBe('The service must retry three times.');
    expect(body.instruction).toBe('tighten the intro');
  });

  it('sends multiple extracted documents with filename boundaries', async () => {
    renderDock();
    await openAndSettle();
    fireEvent.change(screen.getByTestId('ai-dock-attach-file-input'), {
      target: { files: [DOCX, YAML] },
    });
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    await screen.findByTestId('ai-dock-doc-attachment-card-1');
    await selectAction('grammar');

    fireEvent.click(screen.getByTestId('ai-dock-send'));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());

    const referenceText = improveBody().referenceText as string;
    expect(referenceText).toContain('--- q3-architecture.docx ---');
    expect(referenceText).toContain('--- config.yaml ---');
  });

  it('omits referenceText entirely when nothing is attached', async () => {
    renderDock();
    await openAndSettle();
    await selectAction('grammar');

    fireEvent.click(screen.getByTestId('ai-dock-send'));

    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());
    expect(improveBody().referenceText).toBeUndefined();
  });

  it('attaches the document as reference context to a Q&A request', async () => {
    renderDock();
    await openAndSettle();
    await attach();

    fireEvent.change(screen.getByTestId('ai-dock-input'), { target: { value: 'what is a PAT?' } });
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());
    const askCall = streamSSEMock.mock.calls.find((c) => c[0] === '/llm/ask');
    expect(askCall).toBeDefined();
    expect(askCall![1]).toHaveProperty('referenceText', 'The service must retry three times.');
  });

  it('drops the reference again when it is removed', async () => {
    renderDock();
    await openAndSettle();
    await attach();
    await selectAction('grammar');

    fireEvent.click(screen.getByRole('button', { name: 'Remove document' }));
    expect(screen.queryByTestId('ai-dock-doc-attachment-card')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-dock-send'));
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

  it('holds attachment-aware actions back while extraction is in flight', async () => {
    let release: ((r: Response) => void) | undefined;
    vi.mocked(globalThis.fetch).mockReturnValue(
      new Promise<Response>((resolve) => { release = resolve; }),
    );

    renderDock();
    await openAndSettle();

    fireEvent.change(screen.getByTestId('ai-dock-input'), { target: { value: 'what changed?' } });
    fireEvent.change(screen.getByTestId('ai-dock-attach-file-input'), { target: { files: [DOCX] } });

    // Firing now would send without the reference that is still being
    // extracted, so the shared Send control waits for intake to finish.
    await waitFor(() => expect(screen.getByTestId('ai-dock-send')).toBeDisabled());

    await act(async () => {
      release!(extractResponse());
    });
    await waitFor(() => expect(screen.getByTestId('ai-dock-send')).not.toBeDisabled());
  });

  /**
   * #1154 changed which refusal this is, not whether there is one. A PNG is no
   * longer "not a document" — it is an image the dock cannot use yet, because
   * the resolved chat model has not been probed as vision-capable. The refusal
   * still happens client-side, before any upload.
   *
   * This fixture's `/llm/usecase-default` response carries no `vision` field,
   * so `chatVision` is `null` — capability unestablished, not denied — and the
   * message is the tri-state "not confirmed" one rather than a claim the model
   * cannot read images. (It was the generic fallback until the dock started
   * supplying `imageDisabledReason`; the fallback now only covers a caller that
   * passes none.)
   */
  it('refuses an image while the model has no vision capability, before it reaches the server', async () => {
    renderDock();
    await openAndSettle();

    fireEvent.change(screen.getByTestId('ai-dock-attach-file-input'), {
      target: { files: [new File(['x'], 'diagram.png', { type: 'image/png' })] },
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Image support for the model assigned to chat (llama3) isn't "
        + 'confirmed yet — try again shortly.',
      );
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ai-dock-doc-attachment-card')).not.toBeInTheDocument();
  });

  /** A file that is neither a document nor an image still gets the one
   *  "we don't take that" message, naming both accepted sets. */
  it('refuses an unsupported file before it reaches the server', async () => {
    renderDock();
    await openAndSettle();

    fireEvent.change(screen.getByTestId('ai-dock-attach-file-input'), {
      target: { files: [new File(['x'], 'archive.zip', { type: 'application/zip' })] },
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringContaining('Unsupported file.'),
      );
    });
    const message = toastErrorMock.mock.calls[0]![0] as string;
    expect(message).toContain('PDF');
    expect(message).toContain('DOCX');
    expect(message).toContain('ODT');
    expect(message).toContain('PNG');
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
    fireEvent.change(screen.getByTestId('ai-dock-attach-file-input'), { target: { files: [DOCX] } });

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
