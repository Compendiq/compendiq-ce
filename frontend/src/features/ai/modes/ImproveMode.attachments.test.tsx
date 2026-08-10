import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { ImproveModeInput } from './ImproveMode';
import { AiProvider, useAiContext } from '../AiContext';
import { useAuthStore } from '../../../stores/auth-store';
import { ApiError } from '../../../shared/lib/api';
import { expectComposerFocusOrder } from '../../../test-utils';

Element.prototype.scrollIntoView = vi.fn();

// Same seams as GenerateMode.image.test.tsx: apiFetch is controlled but the real
// ApiError class survives (runStream and the 410 branch both use `instanceof`),
// and the SSE transport is the only network boundary a submit crosses. runStream
// itself is deliberately NOT mocked — the 410 rollback is a contract *between*
// this component and runStream, and a mocked runStream would assert nothing
// about who removes which message.
const apiFetchMock = vi.fn();
vi.mock('../../../shared/lib/api', async () =>
  (await import('../../../test-utils')).apiModuleMock(() => apiFetchMock));

const streamSSEMock = vi.fn();
vi.mock('../../../shared/lib/sse', () => ({
  streamSSE: (...args: unknown[]) => streamSSEMock(...args),
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

// Mocked at the same layer as use-extract-document above, and for a harder
// reason: the real hook runs `downscaleImage`, which needs a canvas 2D context
// jsdom does not implement. `downscale-image.test.ts` covers that half.
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

vi.mock('../../../shared/hooks/use-pages', () => ({
  usePage: () => ({
    data: {
      id: 'page-1',
      title: 'Test Page',
      bodyHtml: '<p>Hello world</p>',
      bodyText: 'Hello world',
      version: 1,
    },
  }),
  useEmbeddingStatus: () => ({ data: undefined }),
}));

const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * `chatVision` is not a prop — it is `chatDefault?.vision` off the
 * `/llm/usecase-default?usecase=chat` query (see `chatVision` in AiContext), so the only
 * honest way to set it is through the API mock.
 */
function renderImproveMode({ chatVision }: { chatVision: boolean | null }) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/llm/usecase-default?usecase=chat') {
      return Promise.resolve({
        usecase: 'chat', providerId: 'p1', providerName: 'Local', model: 'llama3',
        vision: chatVision,
      });
    }
    if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
    if (path === '/llm/conversations') return Promise.resolve([]);
    return Promise.resolve([]);
  });

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<><ImproveModeInput /><ModelProbe /><MessagesProbe /></>, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/ai?pageId=page-1&mode=improve']}>
          <LazyMotion features={domAnimation}>
            <AiProvider>{children}</AiProvider>
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    ),
  });
}

/**
 * The instruction textarea has no testid; its placeholder is a fixed string
 * (unlike Generate's, which switches when a document is attached), so one
 * anchored query is enough — and it fails loudly if the copy drifts.
 */
function instructionInput(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(
    /^Additional instructions \(optional\)/,
  ) as HTMLTextAreaElement;
}

function improveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Improve Page/i }) as HTMLButtonElement;
}

/**
 * Reports the resolved chat model. The Improve button is disabled until one
 * exists, so without waiting on it a "the button is disabled" assertion would
 * pass for the wrong reason.
 */
function ModelProbe() {
  const { model } = useAiContext();
  return <span data-testid="model-probe">{model}</span>;
}

/**
 * The composer does not render the thread, so the turn runStream seeds is
 * otherwise invisible to the DOM — and a claimed 410 is supposed to leave
 * *none* behind. One row per message, `role:content`.
 */
function MessagesProbe() {
  const { messages } = useAiContext();
  return (
    <ul data-testid="messages-probe">
      {messages.map((m) => <li key={m.id} data-role={m.role}>{m.role}:{m.content}</li>)}
    </ul>
  );
}

function messageRows(): string[] {
  return Array.from(
    screen.getByTestId('messages-probe').querySelectorAll('li'),
  ).map((li) => li.textContent ?? '');
}

async function settle() {
  await waitFor(() => {
    expect(screen.getByTestId('model-probe')).toHaveTextContent('llama3');
  });
}

const PNG = () => new File(['x'], 'shot.png', { type: 'image/png' });
const PDF = () => new File(['x'], 'spec.pdf', { type: 'application/pdf' });

async function attachImage() {
  await act(async () => {
    fireEvent.change(screen.getByTestId('image-attach-file-input'), { target: { files: [PNG()] } });
  });
}

async function attachDocument() {
  await act(async () => {
    fireEvent.change(screen.getByTestId('document-file-input'), { target: { files: [PDF()] } });
  });
}

async function submitImprove(instruction?: string) {
  if (instruction !== undefined) {
    await act(async () => {
      fireEvent.change(instructionInput(), { target: { value: instruction } });
    });
  }
  await act(async () => { fireEvent.click(improveButton()); });
}

function lastBody(): Record<string, unknown> {
  return streamSSEMock.mock.calls[streamSSEMock.mock.calls.length - 1]![1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsExtracting.value = false;
  mockIsPreparing.value = false;
  mockPrepareImage.mockResolvedValue({
    handle: HANDLE, format: 'webp', width: 800, height: 600, fileSize: 40_000,
    previewUrl: 'blob:preview',
  });
  mockExtractDocument.mockResolvedValue({
    format: 'pdf', text: 'Extracted pdf text', fileSize: 5000, preview: 'Extracted pdf text',
  });
  streamSSEMock.mockImplementation(async function* () { yield { done: true }; });
  // Spied, not replaced: spreading a class copies neither statics nor construct
  // behaviour, so a `{ ...URL }` stub makes `new URL(...)` throw for the whole file.
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  useAuthStore.getState().setAuth('test-token', { id: '1', username: 'testuser', role: 'user' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.getState().clearAuth();
});

// ---------------------------------------------------------------------------

describe('ImproveMode attachments (#1154, #1131 gap-fill)', () => {
  it('sends referenceText from an attached document', async () => {
    renderImproveMode({ chatVision: true });
    await settle();
    await attachDocument();
    await submitImprove();

    expect(lastBody()).toMatchObject({ referenceText: 'Extracted pdf text' });
  });

  it('sends imageHandle from an attached image', async () => {
    renderImproveMode({ chatVision: true });
    await settle();
    await attachImage();
    await submitImprove();

    expect(lastBody()).toMatchObject({ imageHandle: HANDLE });
  });

  it('sends both fields together', async () => {
    renderImproveMode({ chatVision: true });
    await settle();
    await attachDocument();
    await attachImage();
    await submitImprove();

    expect(lastBody()).toMatchObject({
      referenceText: 'Extracted pdf text',
      imageHandle: HANDLE,
    });
  });

  it('sends neither field when nothing is attached', async () => {
    renderImproveMode({ chatVision: true });
    await settle();
    await submitImprove();

    const body = lastBody();
    expect(body).not.toHaveProperty('referenceText');
    expect(body).not.toHaveProperty('imageHandle');
  });

  it('warns when both slots are filled', async () => {
    renderImproveMode({ chatVision: true });
    await settle();
    await attachDocument();
    await attachImage();

    expect(screen.getByTestId('attachment-context-warning')).toBeInTheDocument();
  });

  it.each([
    ['image only', async () => { await attachImage(); }],
    ['document only', async () => { await attachDocument(); }],
  ])('does not warn with %s', async (_label, attach) => {
    renderImproveMode({ chatVision: true });
    await settle();
    await attach();

    expect(screen.queryByTestId('attachment-context-warning')).not.toBeInTheDocument();
  });

  it('disables the image trigger when vision is unconfirmed', async () => {
    renderImproveMode({ chatVision: null });
    await settle();

    expect(screen.getByTestId('image-attach-trigger')).toBeDisabled();
    expect(screen.getByTestId('image-attach-trigger'))
      .toHaveAttribute('title', expect.stringMatching(/isn't confirmed/i));
  });

  it('disables the image trigger when the model is text-only', async () => {
    renderImproveMode({ chatVision: false });
    await settle();

    expect(screen.getByTestId('image-attach-trigger')).toBeDisabled();
  });

  it('enables the image trigger when the model is vision-capable', async () => {
    renderImproveMode({ chatVision: true });
    await settle();

    expect(screen.getByTestId('image-attach-trigger')).not.toBeDisabled();
  });

  /**
   * Disabling the trigger only closes the click path. A drop never touches it,
   * so the capability gate has to live in the intake router as well, or a
   * text-only model is handed a staged image the backend refuses with a 422.
   */
  it('refuses an image dropped on a text-only model', async () => {
    renderImproveMode({ chatVision: false });
    await settle();

    await act(async () => {
      fireEvent.drop(instructionInput(), { dataTransfer: { files: [PNG()] } });
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "The model assigned to chat (llama3) can't read images — "
        + 'assign a vision-capable model in Settings → AI Models.',
      );
    });
    expect(mockPrepareImage).not.toHaveBeenCalled();
  });

  /** A drop anywhere on the Improve block attaches — including the textarea. */
  it('attaches a document dropped on the instruction field', async () => {
    renderImproveMode({ chatVision: true });
    await settle();

    await act(async () => {
      fireEvent.drop(instructionInput(), { dataTransfer: { files: [PDF()] } });
    });

    await waitFor(() => {
      expect(screen.getByTestId('document-attachment-card')).toBeInTheDocument();
    });
    expect(mockExtractDocument).toHaveBeenCalledTimes(1);
  });

  /**
   * One drop, one extraction. `useAttachments` listens natively on the block
   * while React delegates to its root, so if the zone kept its own handlers the
   * ancestor would fire first and `stopPropagation` could not deduplicate after
   * the fact — passing `isDragOver` is what makes the zone stop listening.
   * Dropping on the trigger itself is the case where both would see the event.
   */
  it('extracts exactly once for a file dropped on the attach trigger', async () => {
    renderImproveMode({ chatVision: true });
    await settle();

    await act(async () => {
      fireEvent.drop(screen.getByTestId('document-attach-button'), {
        dataTransfer: { files: [PDF()] },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('document-attachment-card')).toBeInTheDocument();
    });
    expect(mockExtractDocument).toHaveBeenCalledTimes(1);
  });

  it('stages an image pasted into the instruction field', async () => {
    renderImproveMode({ chatVision: true });
    await settle();

    await act(async () => {
      fireEvent.paste(instructionInput(), {
        clipboardData: {
          items: [{ kind: 'file', type: 'image/png', getAsFile: () => PNG() }],
          files: [PNG()],
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('image-attach-card')).toBeInTheDocument();
    });
    expect(mockPrepareImage).toHaveBeenCalledTimes(1);
  });

  /**
   * #940's lesson, in this surface: firing Improve while an extraction or an
   * image staging round-trip is in flight would send the request without the
   * attachment that is still being prepared.
   */
  it.each([
    ['an extraction', mockIsExtracting],
    ['an image staging', mockIsPreparing],
  ])('blocks Improve while %s is in flight', async (_label, flag) => {
    flag.value = true;
    renderImproveMode({ chatVision: true });
    await settle();

    expect(improveButton()).toBeDisabled();
  });
});

describe('ImproveMode lapsed image handle (#1154)', () => {
  /**
   * A 410 means the staged image is gone — the TTL lapsed, or another surface
   * staged an image and pruned this one. Clear the slot, keep the instruction:
   * the send produced nothing, so nothing typed should be lost.
   */
  it('clears the image but keeps the instruction on a 410', async () => {
    renderImproveMode({ chatVision: true });
    await settle();
    await attachImage();
    expect(screen.getByTestId('image-attach-card')).toBeInTheDocument();

    streamSSEMock.mockImplementation(() => {
      throw new ApiError(410, 'The staged image has expired. Attach it again.');
    });
    await submitImprove('tighten the intro');

    await waitFor(() => {
      expect(screen.queryByTestId('image-attach-card')).not.toBeInTheDocument();
    });
    expect(instructionInput()).toHaveValue('tighten the intro');
    expect(toastErrorMock).toHaveBeenCalledWith('The image expired — attach it again.');
  });

  /**
   * The rollback has to be total. Improve seeds no turn of its own — it passes
   * `userMessage`, so runStream seeds and removes both that turn and the empty
   * assistant placeholder. Leave either and the thread keeps a dead row for a
   * send that produced nothing.
   */
  it('leaves no message behind after a 410', async () => {
    renderImproveMode({ chatVision: true });
    await settle();
    await attachImage();

    streamSSEMock.mockImplementation(() => {
      throw new ApiError(410, 'The staged image has expired. Attach it again.');
    });
    await submitImprove();

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('The image expired — attach it again.');
    });
    expect(messageRows()).toEqual([]);
  });

  /** The contrast case: an unclaimed error keeps the turn and explains itself. */
  it('keeps the turn and shows an inline error on a non-410', async () => {
    renderImproveMode({ chatVision: true });
    await settle();

    streamSSEMock.mockImplementation(() => { throw new ApiError(500, 'LLM connection lost'); });
    await submitImprove();

    await waitFor(() => {
      expect(messageRows()).toEqual([
        'user:Improve (grammar): Test Page',
        'assistant:LLM connection lost',
      ]);
    });
  });

  /** Any other failure keeps its normal inline treatment — no slot is cleared. */
  it('keeps the image on a non-410 failure', async () => {
    renderImproveMode({ chatVision: true });
    await settle();
    await attachImage();

    streamSSEMock.mockImplementation(() => { throw new ApiError(500, 'LLM connection lost'); });
    await submitImprove();

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('LLM connection lost');
    });
    expect(screen.getByTestId('image-attach-card')).toBeInTheDocument();
  });
});

/**
 * The reading-order property is load-bearing on all three composer surfaces, not
 * just the dock's (#1154). Improve's box holds both zones and the instruction
 * field, and no send button — the Improve button sits outside it.
 */
describe('Improve composer focus order (#1154)', () => {
  function composerBox(): HTMLElement {
    return instructionInput().closest('.nm-composer') as HTMLElement;
  }

  it('reaches every control in reading order: each card, then its own trigger', async () => {
    renderImproveMode({ chatVision: true });
    await settle();
    await attachDocument();
    await attachImage();

    expectComposerFocusOrder(composerBox(), [
      'document-remove-button',
      'document-attach-button',
      'image-attach-remove',
      'image-attach-trigger',
      'textarea',
    ]);
  });

  /**
   * The drop hint replaces the document card mid-drag and carries nothing
   * focusable, so the sweep above can never reach it. What has to hold for it is
   * structural: it belongs to the document zone's row, beside that zone's own
   * trigger, so mid-drag the composer still reads as rows.
   */
  it('keeps the mid-drag drop hint in the document zone\'s own row', async () => {
    renderImproveMode({ chatVision: true });
    await settle();
    await attachImage();

    await act(async () => { fireEvent.dragEnter(composerBox()); });
    const hint = screen.getByTestId('document-drop-hint');

    const docRow = screen.getByTestId('document-row');
    const imageRow = screen.getByTestId('image-attach-row');
    expect(hint.parentElement).toBe(docRow);
    expect(screen.getByTestId('document-attach-button').parentElement).toBe(docRow);

    const rows = Array.from(composerBox().children);
    expect(rows.indexOf(docRow)).toBeLessThan(rows.indexOf(imageRow));
  });
});

/**
 * Improve deliberately diverges from Generate here: Generate treats its source
 * material as spent once the generated page is saved and calls `clearAll`,
 * while Improve keeps both slots so the same reference can drive a second pass
 * at a different improvement type. Nothing pinned either half, so either could
 * have flipped unnoticed — Generate's is pinned in `GenerateMode.image.test.tsx`.
 */
describe('Improve attachment lifetime (#1154)', () => {
  it('keeps both attachments after a successful improve', async () => {
    renderImproveMode({ chatVision: true });
    await settle();
    await attachDocument();
    await attachImage();

    streamSSEMock.mockImplementation(async function* () {
      yield { content: 'Improved copy' };
      yield { done: true };
    });
    await submitImprove('tighten the intro');

    await waitFor(() => {
      expect(lastBody()).toMatchObject({ imageHandle: HANDLE });
    });
    expect(screen.getByTestId('image-attach-card')).toBeInTheDocument();
    expect(screen.getByTestId('document-attachment-card')).toBeInTheDocument();
    // The instruction is kept for the same reason — a second pass usually
    // wants the same one.
    expect(instructionInput()).toHaveValue('tighten the intro');
  });
});
