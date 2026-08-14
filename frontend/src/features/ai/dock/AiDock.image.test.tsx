/**
 * Attaching an image in the docked assistant (#1154).
 *
 * Same harness as `AiDock.upload.test.tsx` — the dock is mounted the way
 * AppLayout mounts it, and only boundaries are mocked — with two additions:
 *
 * - `use-prepare-image` is mocked because the real hook runs `downscaleImage`,
 *   which needs a canvas 2D context jsdom does not implement
 *   (`downscale-image.test.ts` covers that half). `use-extract-document` is
 *   mocked alongside it so both slots are controlled the same way.
 * - `chatVision` is not a prop: it is `chatDefault?.vision` off the
 *   `/llm/usecase-default?usecase=chat` query (see `chatVision` in AiContext), so the only
 *   honest way to set it is through the API mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AiProvider, useAiContext } from '../AiContext';
import { DockPanel } from './DockPanel';
import { ApiError } from '../../../shared/lib/api';
import { useAiDockStore } from '../../../stores/ai-dock-store';
import { expectComposerFocusOrder } from '../../../test-utils';

Element.prototype.scrollIntoView = vi.fn();

const apiFetchMock = vi.fn();
vi.mock('../../../shared/lib/api', async () =>
  (await import('../../../test-utils')).apiModuleMock(() => apiFetchMock));

const streamSSEMock = vi.fn();
vi.mock('../../../shared/lib/sse', () => ({
  streamSSE: (...args: unknown[]) => streamSSEMock(...args),
}));

const HANDLE = 'a'.repeat(64);
const mockPrepareImage = vi.fn();
const mockIsPreparing = { value: false };
vi.mock('../../../shared/hooks/use-prepare-image', () => ({
  usePrepareImage: () => ({
    prepareImage: (...args: unknown[]) => mockPrepareImage(...args),
    isPreparing: mockIsPreparing.value,
    error: null,
  }),
}));

const mockExtractDocument = vi.fn();
const mockIsExtracting = { value: false };
vi.mock('../../../shared/hooks/use-extract-document', () => ({
  useExtractDocument: () => ({
    extractDocument: (...args: unknown[]) => mockExtractDocument(...args),
    isExtracting: mockIsExtracting.value,
    error: null,
  }),
}));

const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: vi.fn(), info: vi.fn(), warning: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function pageFixture(id: string, title: string) {
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

const PNG = () => new File(['x'], 'shot.png', { type: 'image/png' });
const PDF = () => new File(['x'], 'spec.pdf', { type: 'application/pdf' });

function GoTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button data-testid="go" onClick={() => navigate(to)}>go</button>;
}

/**
 * Moves the page out from under a pending diff, through the public context the
 * way a mode does. A stale diff card offers "Re-run Improve" instead of Apply,
 * which is the one remaining caller that reaches `runChip` undisabled.
 */
function DiffProbe() {
  const { setDiffBaseVersion } = useAiContext();
  return <button data-testid="diff-probe" onClick={() => setDiffBaseVersion(1)}>move the page</button>;
}

function renderDock({ chatVision }: { chatVision: boolean | null }) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/pages/page-1') return Promise.resolve(pageFixture('page-1', 'Onboarding Guide'));
    if (path === '/pages/page-2') return Promise.resolve(pageFixture('page-2', 'Runbook'));
    if (path.startsWith('/llm/usecase-default')) {
      return Promise.resolve({
        usecase: 'chat', providerId: 'p1', providerName: 'Local', model: 'llama3',
        vision: chatVision,
      });
    }
    if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
    if (path === '/llm/conversations') return Promise.resolve([]);
    if (path === '/embeddings/status') return Promise.resolve({ total: 1, embedded: 1, isProcessing: false });
    return Promise.resolve({});
  });

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LazyMotion features={domAnimation}>
        <MemoryRouter initialEntries={['/pages/page-1']}>
          <AiProvider>
            <GoTo to="/pages/page-2" />
            <DiffProbe />
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

async function attachImage() {
  await act(async () => {
    fireEvent.change(screen.getByTestId('ai-dock-attach-file-input'), { target: { files: [PNG()] } });
  });
}

async function attachDocument() {
  await act(async () => {
    fireEvent.change(screen.getByTestId('ai-dock-attach-file-input'), { target: { files: [PDF()] } });
  });
}

async function sendRewrite() {
  await act(async () => {
    fireEvent.pointerDown(screen.getByTestId('assistant-action-select'), { button: 0 });
  });
  fireEvent.click(await screen.findByTestId('assistant-action-grammar'));
  await act(async () => { fireEvent.click(screen.getByTestId('ai-dock-send')); });
}

function composerBox(): HTMLElement {
  return screen.getByTestId('ai-dock-input').closest('.nm-composer') as HTMLElement;
}

function improveBody(): Record<string, unknown> {
  const call = streamSSEMock.mock.calls.find((c) => c[0] === '/llm/improve');
  expect(call, 'expected an /llm/improve request').toBeDefined();
  return call![1] as Record<string, unknown>;
}

/** Turns in the thread, `role:content`, read off the rendered dock. */
function threadText(): string {
  return screen.getByTestId('ai-dock-thread').textContent ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsPreparing.value = false;
  mockIsExtracting.value = false;
  mockPrepareImage.mockResolvedValue({
    handle: HANDLE, format: 'webp', width: 800, height: 600, fileSize: 40_000,
    previewUrl: 'blob:preview',
  });
  mockExtractDocument.mockResolvedValue({
    format: 'pdf', text: 'The service must retry three times.', fileSize: 5000,
    preview: 'The service must retry three times.',
  });
  streamSSEMock.mockImplementation(() => sse({ content: 'ok' }, { final: true, done: true }));
  // Spied, not replaced: spreading a class copies neither statics nor construct
  // behaviour, so a `{ ...URL }` stub makes `new URL(...)` throw for the whole file.
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  useAiDockStore.setState({ open: false });
  window.innerWidth = 1400;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useAiDockStore.setState({ open: false });
});

// ---------------------------------------------------------------------------

describe('dock image attach (#1154)', () => {
  it('sends imageHandle when a rewrite skill runs', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachImage();
    await sendRewrite();

    expect(improveBody()).toMatchObject({ imageHandle: HANDLE });
  });

  it('sends referenceText and imageHandle together', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachDocument();
    await attachImage();
    await sendRewrite();

    expect(improveBody()).toMatchObject({
      imageHandle: HANDLE,
      referenceText: 'The service must retry three times.',
    });
  });

  it('omits imageHandle when no image is attached', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await sendRewrite();

    expect(improveBody()).not.toHaveProperty('imageHandle');
  });

  /**
   * #1154: Ask supports image input via imageHandle.
   */
  it('attaches the image to a question', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachImage();

    fireEvent.change(screen.getByTestId('ai-dock-input'), { target: { value: 'what is a PAT?' } });
    await act(async () => { fireEvent.click(screen.getByTestId('ai-dock-send')); });

    const askCall = streamSSEMock.mock.calls.find((c) => c[0] === '/llm/ask');
    expect(askCall).toBeDefined();
    expect(askCall![1]).toHaveProperty('imageHandle', HANDLE);
  });

  it('accepts an image pasted onto the composer', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();

    await act(async () => {
      fireEvent.paste(screen.getByTestId('ai-dock-input'), {
        clipboardData: {
          items: [{ kind: 'file', type: 'image/png', getAsFile: () => PNG() }],
          files: [PNG()],
        },
      });
    });

    await waitFor(() => expect(screen.getByTestId('ai-dock-image-card')).toBeInTheDocument());
    expect(mockPrepareImage).toHaveBeenCalledTimes(1);
  });

  it('accepts an image dropped anywhere on the composer', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();

    await act(async () => {
      fireEvent.drop(composerBox(), { dataTransfer: { files: [PNG()] } });
    });

    await waitFor(() => expect(screen.getByTestId('ai-dock-image-card')).toBeInTheDocument());
    expect(mockPrepareImage).toHaveBeenCalledTimes(1);
  });

  /**
   * One drop, one intake. `useAttachments` listens natively on the composer box
   * while React delegates to its root container, so if `DocumentUploadZone` kept
   * its own handlers the ancestor would fire first and `stopPropagation` could
   * not deduplicate after the fact — passing `isDragOver` is what makes the zone
   * stop listening. The shared attach trigger is the one element both would see.
   */
  it('stages exactly once for an image dropped on the attach trigger', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();

    await act(async () => {
      fireEvent.drop(screen.getByTestId('ai-dock-attach-button'), {
        dataTransfer: { files: [PNG()] },
      });
    });

    await waitFor(() => expect(screen.getByTestId('ai-dock-image-card')).toBeInTheDocument());
    expect(mockPrepareImage).toHaveBeenCalledTimes(1);
  });

  /** Attachments are material for the next action, not part of the conversation. */
  it('clears the image when the page changes', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachImage();
    expect(screen.getByTestId('ai-dock-image-card')).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByTestId('go')); });

    await waitFor(() => {
      expect(screen.queryByTestId('ai-dock-image-card')).not.toBeInTheDocument();
    });
  });

  it.each([false, null, true] as const)(
    'keeps the shared attach control available when vision is %s',
    async (chatVision) => {
      renderDock({ chatVision });
      await openAndSettle();

      const trigger = screen.getByTestId('ai-dock-attach-button');
      expect(trigger).not.toBeDisabled();
      expect(trigger).toHaveAccessibleName('Attach a document or image');
      expect(screen.queryByTestId('ai-dock-image-trigger')).not.toBeInTheDocument();
    },
  );

  /**
   * Disabling the trigger only closes the click path. A drop never touches it,
   * so the capability gate has to live in the intake router as well, or a
   * text-only model is handed a staged image the backend refuses with a 422.
   */
  it('refuses an image dropped while the model is text-only', async () => {
    renderDock({ chatVision: false });
    await openAndSettle();

    await act(async () => {
      fireEvent.drop(composerBox(), { dataTransfer: { files: [PNG()] } });
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "The model assigned to chat (llama3) can't read images — "
        + 'assign a vision-capable model in Settings → AI Models.',
      );
    });
    expect(mockPrepareImage).not.toHaveBeenCalled();
  });

  it('warns when both attachment slots are filled', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachDocument();
    await attachImage();

    expect(screen.getByTestId('ai-dock-attachment-context-warning')).toHaveTextContent(
      'Both attachments will be sent — a small model may not fit them.',
    );
  });

  it.each([
    ['image only', async () => { await attachImage(); }],
    ['document only', async () => { await attachDocument(); }],
  ])('does not warn with %s', async (_label, attach) => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attach();

    expect(screen.queryByTestId('ai-dock-attachment-context-warning')).not.toBeInTheDocument();
  });

  it('holds attachment-aware Send back while an image is being staged', async () => {
    mockIsPreparing.value = true;
    renderDock({ chatVision: true });
    act(() => { useAiDockStore.getState().openDock(); });
    await waitFor(() => expect(screen.getByTestId('ai-dock-send')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('assistant-action-select')).not.toBeDisabled());
    expect(screen.getByTestId('ai-dock-send')).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Composer layout
// ---------------------------------------------------------------------------

/**
 * The dock is the surface where this mattered most: it is the only composer
 * holding both cards and a send button. The shared Attach control follows the
 * cards in both DOM and visual order, so Tab does not cross between rows.
 */
describe('dock composer focus order (#1154)', () => {
  it('reaches every control in reading order: each card, then shared Attach', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachDocument();
    await attachImage();

    expectComposerFocusOrder(composerBox(), [
      'ai-dock-doc-remove-button',
      'ai-dock-image-remove',
      'ai-dock-attach-button',
      'assistant-action-select',
      'ai-dock-input',
      'ai-dock-send',
    ]);
  });

  /**
   * The drop hint replaces the document card while a drag is over the composer,
   * so it is a state no other test reaches — and it carries nothing focusable,
   * which puts it out of reach of the focus-order sweep above. What has to hold
   * for it is structural: the hint belongs to the document zone's row, beside
   * the shared trigger, so mid-drag the composer still reads as rows. A hint
   * that escaped its row would separate the input feedback from Attach.
   */
  it('keeps the mid-drag drop hint in the document zone\'s own row', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachImage();

    await act(async () => { fireEvent.dragEnter(composerBox()); });
    const hint = screen.getByTestId('ai-dock-doc-drop-hint');

    const docRow = screen.getByTestId('ai-dock-doc-row');
    const imageRow = screen.getByTestId('ai-dock-image-row');
    expect(hint.parentElement).toBe(docRow);
    expect(screen.getByTestId('ai-dock-attach-button').closest('.nm-composer')).toBe(composerBox());

    // ...and that row is read before the image's, as the markup has it.
    const rows = Array.from(composerBox().children);
    expect(rows.indexOf(docRow)).toBeLessThan(rows.indexOf(imageRow));
  });
});

// ---------------------------------------------------------------------------
// Lapsed handle
// ---------------------------------------------------------------------------

/**
 * A 410 is an ordinary event on this surface: `pruneOlderStagedImages` keeps
 * only the newest staged image per user, so attaching an image on `/ai` while
 * the dock holds one invalidates the dock's with no TTL lapse at all.
 */
describe('dock lapsed image handle (#1154)', () => {
  const gone = () => {
    streamSSEMock.mockImplementation(() => {
      throw new ApiError(410, 'The staged image has expired. Attach it again.');
    });
  };

  it('clears the image and puts the instruction back on a 410', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachImage();
    fireEvent.change(screen.getByTestId('ai-dock-input'), { target: { value: 'tighten the intro' } });

    gone();
    await sendRewrite();

    await waitFor(() => {
      expect(screen.queryByTestId('ai-dock-image-card')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('ai-dock-input')).toHaveValue('tighten the intro');
    expect(toastErrorMock).toHaveBeenCalledWith('The image expired — attach it again.');
  });

  /**
   * The rollback has to be total. The dock passes `userMessage`, so runStream
   * seeds and withdraws both the user turn and the empty assistant placeholder;
   * leaving either would keep a dead row for a send that produced nothing.
   */
  it('leaves no turn behind after a 410', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachImage();

    gone();
    await sendRewrite();

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('The image expired — attach it again.');
    });
    expect(screen.getByTestId('ai-dock-empty')).toBeInTheDocument();
  });

  /** The contrast case: an unclaimed error keeps the turn and explains itself. */
  it('keeps the turn and the inline error on a non-410', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachImage();

    streamSSEMock.mockImplementation(() => { throw new ApiError(500, 'LLM connection lost'); });
    await sendRewrite();

    await waitFor(() => expect(threadText()).toContain('LLM connection lost'));
  });

  /**
   * `runChip` is reached from two places and only one of them — the composer
   * Send button — is disabled while an attachment is staging. `DockDiffCard`'s "Re-run
   * Improve" calls it directly, so the wait has to live inside the handler or
   * Improve goes out with `imageHandle` undefined while the image card is still
   * on screen. That is #940's shape, and it is why `/ai`'s Generate and Improve
   * re-check `isBusy` inside their handlers too.
   *
   * (#1176 removed the third caller, the seed effect that ran Improve the moment
   * the dock opened. The guard outlives it because the re-run button does.)
   */
  it('refuses a re-run of Improve while an attachment is still being prepared', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachImage();
    await sendRewrite();
    await waitFor(() => expect(screen.getByTestId('dock-diff-card')).toBeInTheDocument());

    // The page moved under the pending diff, so the card offers a re-run in
    // place of Apply — the undisabled way back into `runChip`.
    act(() => { fireEvent.click(screen.getByTestId('diff-probe')); });
    expect(screen.getByTestId('dock-diff-rerun')).toBeInTheDocument();

    // A fresh image goes on while that offer sits there. `isPreparing` is read
    // on render, so the composer keystroke is what re-renders the panel with it.
    mockIsPreparing.value = true;
    fireEvent.change(screen.getByTestId('ai-dock-input'), { target: { value: 'x' } });

    streamSSEMock.mockClear();
    await act(async () => { fireEvent.click(screen.getByTestId('dock-diff-rerun')); });

    expect(streamSSEMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(/still attaching/i));
  });

  /**
   * Ask and Improve both carry images when vision is supported.
   */
  it('uses the shared trigger for an image and then shows its card', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();

    expect(screen.getByTestId('ai-dock-attach-button'))
      .toHaveAttribute('aria-label', 'Attach a document or image');

    await attachImage();
    expect(screen.getByTestId('ai-dock-image-card')).toBeInTheDocument();
  });

  /**
   * Only the image path can produce a 410 today (`httpErrors.gone` is raised
   * for a missing staged handle and nothing else), so a 410 with no image
   * attached is somebody else's error: it keeps its normal inline treatment
   * rather than being claimed with a misleading "the image expired" toast.
   */
  it('does not claim a 410 when no image was sent', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();

    gone();
    await sendRewrite();

    await waitFor(() => {
      expect(threadText()).toContain('The staged image has expired.');
    });
    expect(toastErrorMock).not.toHaveBeenCalledWith('The image expired — attach it again.');
  });
});
