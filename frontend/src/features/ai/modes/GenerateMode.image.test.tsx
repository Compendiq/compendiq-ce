import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { GenerateModeInput } from './GenerateMode';
import { AiProvider, useAiContext } from '../AiContext';
import { useAuthStore } from '../../../stores/auth-store';
import { ApiError } from '../../../shared/lib/api';
import { expectComposerFocusOrder } from '../../../test-utils';

Element.prototype.scrollIntoView = vi.fn();

// Same seams as GenerateMode.test.tsx: apiFetch is controlled but the real
// ApiError class survives (runStream and Generate's 410 branch both use
// `instanceof`), and the SSE transport is the only network boundary a submit
// crosses.
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

vi.mock('../../../shared/hooks/use-pages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/hooks/use-pages')>();
  return { ...actual, usePage: () => ({ data: undefined }), useEmbeddingStatus: () => ({ data: undefined }) };
});

// Mutable so the save-panel test can offer a space to select — the save button
// stays disabled without one, and the panel is where `clearAll` is wired.
const mockSpaces = { value: [] as Array<{ key: string; name: string; source: 'confluence' }> };
vi.mock('../../../shared/hooks/use-spaces', () => ({ useSpaces: () => ({ data: mockSpaces.value }) }));
vi.mock('../../../shared/hooks/use-standalone', () => ({ useLocalSpaces: () => ({ data: [] }) }));

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
function renderGenerateMode({ vision }: { vision: boolean | null }) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/llm/usecase-default?usecase=chat') {
      return Promise.resolve({
        usecase: 'chat', providerId: 'p1', providerName: 'Local', model: 'llama3', vision,
      });
    }
    if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
    if (path === '/llm/conversations') return Promise.resolve([]);
    return Promise.resolve([]);
  });

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<><GenerateModeInput /><ModelProbe /><MessagesProbe /></>, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/ai?mode=generate']}>
          <LazyMotion features={domAnimation}>
            <AiProvider>{children}</AiProvider>
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    ),
  });
}

/**
 * The prompt textarea has no testid and its placeholder is CONDITIONAL on
 * whether a *document* is attached (GenerateMode.tsx), so a fixed placeholder
 * query breaks the moment a test attaches one. Query both.
 */
function promptInput(): HTMLTextAreaElement {
  return (
    screen.queryByPlaceholderText('Describe the page to generate...')
    ?? screen.getByPlaceholderText('Instructions for generating from this document...')
  ) as HTMLTextAreaElement;
}

function sendButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement;
}

/**
 * Reports the resolved chat model. Send is disabled until one exists, so
 * without waiting on it a "send is disabled" assertion would pass for the
 * wrong reason — which an early draft of this file did. Reading it off the
 * context is the only unambiguous signal; the composer renders the model's
 * name only on some of the states under test. Contributes no button, so
 * `sendButton()` is unaffected.
 */
function ModelProbe() {
  const { model } = useAiContext();
  return <span data-testid="model-probe">{model}</span>;
}

/**
 * The composer does not render the thread, so a turn it appends is otherwise
 * invisible to the DOM — and a 410 is supposed to leave *none* behind. One row
 * per message, `role:content`, so an empty list is an empty thread.
 * Contributes no button, so `sendButton()` is unaffected.
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

/** Wait until the model has resolved, or every send assertion is about that instead. */
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

async function submit(prompt: string) {
  await act(async () => { fireEvent.change(promptInput(), { target: { value: prompt } }); });
  await act(async () => { fireEvent.click(sendButton()); });
}

function lastBody(): Record<string, unknown> {
  return streamSSEMock.mock.calls[streamSSEMock.mock.calls.length - 1]![1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsExtracting.value = false;
  mockIsPreparing.value = false;
  mockSpaces.value = [];
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

describe('GenerateMode image attach (#1154)', () => {
  it('sends imageHandle in the generate body', async () => {
    renderGenerateMode({ vision: true });
    await settle();
    await attachImage();
    await submit('describe this');

    expect(lastBody()).toMatchObject({ imageHandle: HANDLE, prompt: 'describe this' });
  });

  it('omits imageHandle when no image is attached', async () => {
    renderGenerateMode({ vision: true });
    await settle();
    await submit('hello');

    expect(lastBody()).not.toHaveProperty('imageHandle');
  });

  it('sends documentText and imageHandle together', async () => {
    renderGenerateMode({ vision: true });
    await settle();
    await attachDocument();
    await attachImage();
    await submit('reconcile these');

    expect(lastBody()).toMatchObject({
      imageHandle: HANDLE,
      documentText: 'Extracted pdf text',
    });
  });

  it('warns when both slots are filled', async () => {
    renderGenerateMode({ vision: true });
    await settle();
    await attachDocument();
    await attachImage();

    expect(screen.getByTestId('attachment-context-warning')).toBeInTheDocument();
  });

  it.each([
    ['image only', async () => { await attachImage(); }],
    ['document only', async () => { await attachDocument(); }],
  ])('does not warn with %s', async (_label, attach) => {
    renderGenerateMode({ vision: true });
    await settle();
    await attach();

    expect(screen.queryByTestId('attachment-context-warning')).not.toBeInTheDocument();
  });

  it('disables the image trigger when the model is text-only', async () => {
    renderGenerateMode({ vision: false });
    await settle();

    expect(screen.getByTestId('image-attach-trigger')).toBeDisabled();
  });

  /**
   * Disabling the trigger only closes the click path. A drop or a paste never
   * touches it, so the capability gate has to live in the intake router as
   * well — `imageEnabled` — or a text-only model would be handed a staged
   * image the backend then refuses with a 422.
   */
  it('refuses an image dropped on a text-only model', async () => {
    renderGenerateMode({ vision: false });
    await settle();

    await act(async () => {
      fireEvent.drop(screen.getByTestId('document-upload-zone'), {
        dataTransfer: { files: [PNG()] },
      });
    });

    // The refusal happens in a microtask inside the drop handler's `void
    // pickFile(...)`, so wait for it rather than assuming a flush boundary.
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "The model assigned to chat (llama3) can't read images — "
        + 'assign a vision-capable model in Settings → AI Models.',
      );
    });
    expect(mockPrepareImage).not.toHaveBeenCalled();
    expect(screen.queryByTestId('image-attach-card')).not.toBeInTheDocument();
  });

  it('enables the image trigger when the model is vision-capable', async () => {
    renderGenerateMode({ vision: true });
    await settle();

    expect(screen.getByTestId('image-attach-trigger')).not.toBeDisabled();
  });

  it('blocks send while the image is still being prepared', async () => {
    mockIsPreparing.value = true;
    renderGenerateMode({ vision: true });
    await settle();
    await act(async () => { fireEvent.change(promptInput(), { target: { value: 'hi' } }); });

    expect(sendButton()).toBeDisabled();
  });

  /**
   * An image keeps the default placeholder: "from this document" would be a lie
   * about a PNG, and the document copy is asserted verbatim elsewhere.
   */
  it('leaves the placeholder alone for an image-only attachment', async () => {
    renderGenerateMode({ vision: true });
    await settle();
    await attachImage();

    expect(screen.getByPlaceholderText('Describe the page to generate...')).toBeInTheDocument();
  });
});

describe('GenerateMode lapsed image handle (#1154)', () => {
  /** A 410 means the 15-minute staging TTL lapsed. Clear the slot, keep the prompt. */
  it('clears the image but keeps the prompt on a 410', async () => {
    renderGenerateMode({ vision: true });
    await settle();
    await attachImage();
    expect(screen.getByTestId('image-attach-card')).toBeInTheDocument();

    streamSSEMock.mockImplementation(() => {
      throw new ApiError(410, 'The staged image has expired. Attach it again.');
    });
    await submit('describe this');

    await waitFor(() => {
      expect(screen.queryByTestId('image-attach-card')).not.toBeInTheDocument();
    });
    expect(promptInput()).toHaveValue('describe this');
    expect(toastErrorMock).toHaveBeenCalledWith('The image expired — attach it again.');
  });

  /**
   * The rollback has to be total. Generate seeds its own user turn by hand, so
   * it removes that one; runStream removes the empty assistant placeholder it
   * added. Leave either and the thread keeps a dead row for a send that
   * produced nothing — and the prompt is back in the composer, so the user is
   * about to send it again and get a duplicate.
   */
  it('leaves no message behind after a 410', async () => {
    renderGenerateMode({ vision: true });
    await settle();
    await attachImage();

    streamSSEMock.mockImplementation(() => {
      throw new ApiError(410, 'The staged image has expired. Attach it again.');
    });
    await submit('describe this');

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('The image expired — attach it again.');
    });
    expect(messageRows()).toEqual([]);
  });

  /** The contrast case: an unclaimed error keeps the turn and explains itself. */
  it('keeps the turn and shows an inline error on a non-410', async () => {
    renderGenerateMode({ vision: true });
    await settle();

    streamSSEMock.mockImplementation(() => { throw new ApiError(500, 'LLM connection lost'); });
    await submit('describe this');

    await waitFor(() => {
      expect(messageRows()).toEqual([
        'user:Generate: describe this',
        'assistant:LLM connection lost',
      ]);
    });
  });

  /** Any other failure keeps its normal inline treatment — no slot is cleared. */
  it('keeps the image on a non-410 failure', async () => {
    renderGenerateMode({ vision: true });
    await settle();
    await attachImage();

    streamSSEMock.mockImplementation(() => { throw new ApiError(500, 'LLM connection lost'); });
    await submit('describe this');

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('LLM connection lost');
    });
    expect(screen.getByTestId('image-attach-card')).toBeInTheDocument();
  });
});

describe('GenerateMode drop target (#1154)', () => {
  /**
   * The dashed zone's own drop handler sat on a button that goes
   * `pointer-events-none` while extracting, so a file dropped mid-extraction
   * reached NO handler and the browser ran its default action: navigate the tab
   * to the dropped file, taking the typed prompt with it. The hook's listener
   * is registered even while busy precisely so this cannot happen.
   */
  it('swallows a drop that lands while an extraction is in flight', async () => {
    // Sets the scenario rather than the outcome: the hook registers its
    // listener regardless of this flag. What it does change is the dashed
    // zone's button, which goes `pointer-events-none` while extracting — which
    // is why the drop below is aimed at the prompt field instead. Both are
    // descendants of the surface the hook listens on, and the event bubbles.
    mockIsExtracting.value = true;
    renderGenerateMode({ vision: true });
    await settle();

    const notPrevented = fireEvent.drop(promptInput(), { dataTransfer: { files: [PDF()] } });

    // fireEvent returns false when a handler called preventDefault. `true` here
    // means the browser would have navigated away from the composer.
    expect(notPrevented).toBe(false);
  });

  /**
   * One drop, one extraction. The zone's React handler and the hook's native
   * ancestor listener would both see the same bubbling event, and the native
   * one runs first, so `stopPropagation` could not deduplicate it after the
   * fact — the zone has to not be listening at all.
   */
  it('extracts exactly once for a file dropped on the dashed zone', async () => {
    renderGenerateMode({ vision: true });
    await settle();

    await act(async () => {
      fireEvent.drop(screen.getByTestId('document-upload-zone'), {
        dataTransfer: { files: [PDF()] },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('document-preview-card')).toBeInTheDocument();
    });
    expect(mockExtractDocument).toHaveBeenCalledTimes(1);
  });

  it('stages exactly once for an image dropped on the dashed zone', async () => {
    renderGenerateMode({ vision: true });
    await settle();

    await act(async () => {
      fireEvent.drop(screen.getByTestId('document-upload-zone'), {
        dataTransfer: { files: [PNG()] },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('image-attach-card')).toBeInTheDocument();
    });
    expect(mockPrepareImage).toHaveBeenCalledTimes(1);
  });

  /**
   * The paste listener moved to the outer block, so it now sees pastes into the
   * textarea. It must let plain text through untouched — an image item is the
   * only thing it may claim, and claiming a text paste would stop the character
   * from ever reaching the field the user is typing in.
   */
  it('lets a plain-text paste reach the textarea untouched', async () => {
    renderGenerateMode({ vision: true });
    await settle();

    const notPrevented = fireEvent.paste(promptInput(), {
      clipboardData: { items: [{ kind: 'string', type: 'text/plain' }], files: [] },
    });

    expect(notPrevented).toBe(true);
    expect(mockPrepareImage).not.toHaveBeenCalled();
    expect(mockExtractDocument).not.toHaveBeenCalled();
  });

  it('stages an image pasted into the textarea', async () => {
    renderGenerateMode({ vision: true });
    await settle();

    await act(async () => {
      fireEvent.paste(promptInput(), {
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

  it('accepts a file dropped on the prompt box, not just the dashed zone', async () => {
    renderGenerateMode({ vision: true });
    await settle();

    await act(async () => {
      fireEvent.drop(promptInput().closest('.nm-composer')!, {
        dataTransfer: { files: [PDF()] },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('document-preview-card')).toBeInTheDocument();
    });
  });
});

/**
 * Generate's box holds one zone rather than two — the document zone is the
 * standing dashed dropzone above it, outside the composer — so it never had the
 * interleaving the dock and Improve did. It is pinned anyway (#1154): a
 * convention that holds on two of three surfaces is one someone will violate on
 * the third, and this is the surface where a second zone would most plausibly
 * be added later.
 */
describe('Generate composer focus order (#1154)', () => {
  function composerBox(): HTMLElement {
    return promptInput().closest('.nm-composer') as HTMLElement;
  }

  it('reaches every control in reading order: card, its trigger, field, send', async () => {
    renderGenerateMode({ vision: true });
    await settle();
    await attachImage();

    // The field and the send button carry no testid on this surface, so they
    // are matched by tag — positionally, which is exactly what is being pinned.
    expectComposerFocusOrder(composerBox(), [
      'image-attach-remove',
      'image-attach-trigger',
      'assistant-action-select',
      'textarea',
      'button',
    ]);
  });
});

/**
 * What happens to the attachments after a send is a design decision, not an
 * accident, and the two `/ai` surfaces deliberately differ: Generate treats
 * the source material as spent once the generated page has been *saved*, while
 * Improve keeps it (see `ImproveMode.attachments.test.tsx`). Neither was
 * pinned by a test, so either could have flipped unnoticed.
 */
describe('Generate attachment lifetime (#1154)', () => {
  it('keeps both attachments after a successful generation, before saving', async () => {
    renderGenerateMode({ vision: true });
    await settle();
    await attachDocument();
    await attachImage();

    streamSSEMock.mockImplementation(async function* () {
      yield { content: '# Runbook' };
      yield { done: true };
    });
    await submit('write it up');

    await waitFor(() => expect(screen.getByTestId('generate-save-panel')).toBeInTheDocument());
    expect(screen.getByTestId('image-attach-card')).toBeInTheDocument();
    expect(screen.getByTestId('document-preview-card')).toBeInTheDocument();
  });

  it('clears both attachments once the generated page is saved', async () => {
    mockSpaces.value = [{ key: 'DOC', name: 'Docs', source: 'confluence' }];
    renderGenerateMode({ vision: true });
    await settle();
    await attachDocument();
    await attachImage();

    streamSSEMock.mockImplementation(async function* () {
      yield { content: '# Runbook' };
      yield { done: true };
    });
    await submit('write it up');
    await waitFor(() => expect(screen.getByTestId('generate-save-panel')).toBeInTheDocument());

    // The title is seeded from the first heading; only the space is missing.
    await act(async () => {
      fireEvent.change(screen.getByTestId('generate-space-select'), { target: { value: 'DOC' } });
    });
    await act(async () => { fireEvent.click(screen.getByTestId('generate-save-button')); });

    await waitFor(() => {
      expect(screen.queryByTestId('image-attach-card')).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId('document-preview-card')).not.toBeInTheDocument();
  });
});
