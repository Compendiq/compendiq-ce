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
 *   `/llm/usecase-default?usecase=chat` query (AiContext.tsx:904), so the only
 *   honest way to set it is through the API mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AiProvider } from '../AiContext';
import { AiDock } from './AiDock';
import { ApiError } from '../../../shared/lib/api';
import { useAiDockStore } from '../../../stores/ai-dock-store';
import { useUiStore } from '../../../stores/ui-store';
import { expectExplicitComposerOrder } from '../../../test-utils';

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

async function attachImage() {
  await act(async () => {
    fireEvent.change(screen.getByTestId('ai-dock-image-file-input'), { target: { files: [PNG()] } });
  });
}

async function attachDocument() {
  await act(async () => {
    fireEvent.change(screen.getByTestId('ai-dock-doc-file-input'), { target: { files: [PDF()] } });
  });
}

async function clickChip(id: string) {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`ai-dock-chip-${id}`));
  });
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
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() });
  useAiDockStore.setState({ open: false, seed: null, seedPageId: null });
  useUiStore.setState({ aiDockWidth: 420 });
  window.innerWidth = 1400;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useAiDockStore.setState({ open: false, seed: null, seedPageId: null });
});

// ---------------------------------------------------------------------------

describe('dock image attach (#1154)', () => {
  it('sends imageHandle when the Improve chip runs', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachImage();
    await clickChip('improve');

    expect(improveBody()).toMatchObject({ imageHandle: HANDLE });
  });

  it('sends referenceText and imageHandle together', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachDocument();
    await attachImage();
    await clickChip('improve');

    expect(improveBody()).toMatchObject({
      imageHandle: HANDLE,
      referenceText: 'The service must retry three times.',
    });
  });

  it('omits imageHandle when no image is attached', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await clickChip('improve');

    expect(improveBody()).not.toHaveProperty('imageHandle');
  });

  /**
   * Ask has no image field, so an attachment must not silently ride along on a
   * question — the same contract the reference document has had since #1131.
   */
  it('does not attach the image to a plain question', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachImage();

    fireEvent.change(screen.getByTestId('ai-dock-input'), { target: { value: 'what is a PAT?' } });
    await act(async () => { fireEvent.click(screen.getByTestId('ai-dock-send')); });

    const askCall = streamSSEMock.mock.calls.find((c) => c[0] === '/llm/ask');
    expect(askCall).toBeDefined();
    expect(askCall![1]).not.toHaveProperty('imageHandle');
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
   * stop listening. The attach trigger is the one element both would see.
   */
  it('stages exactly once for an image dropped on the attach trigger', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();

    await act(async () => {
      fireEvent.drop(screen.getByTestId('ai-dock-doc-attach-button'), {
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

  it('disables the image trigger on a text-only model', async () => {
    renderDock({ chatVision: false });
    await openAndSettle();

    expect(screen.getByTestId('ai-dock-image-trigger')).toBeDisabled();
    expect(screen.getByTestId('ai-dock-image-trigger'))
      .toHaveAttribute('title', expect.stringMatching(/can't read images/i));
  });

  it('disables the image trigger while vision is unconfirmed', async () => {
    renderDock({ chatVision: null });
    await openAndSettle();

    expect(screen.getByTestId('ai-dock-image-trigger')).toBeDisabled();
    expect(screen.getByTestId('ai-dock-image-trigger'))
      .toHaveAttribute('title', expect.stringMatching(/isn't confirmed/i));
  });

  it('enables the image trigger on a vision-capable model', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();

    expect(screen.getByTestId('ai-dock-image-trigger')).not.toBeDisabled();
  });

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
        "llama3 can't read images — assign a vision-capable model in Settings → LLM.",
      );
    });
    expect(mockPrepareImage).not.toHaveBeenCalled();
  });

  it('warns when both slots are filled', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachDocument();
    await attachImage();

    expect(screen.getByTestId('ai-dock-attachment-context-warning')).toBeInTheDocument();
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

  /**
   * #940's lesson widened to the image slot: firing Improve while a staging
   * round-trip is in flight sends the request without the attachment being
   * prepared for it. The other three chips do not read attachments, so they
   * stay live.
   */
  it('holds Improve back while an image is being staged', async () => {
    mockIsPreparing.value = true;
    renderDock({ chatVision: true });
    act(() => { useAiDockStore.getState().openDock(); });
    await waitFor(() => expect(screen.getByTestId('ai-dock-send')).toBeInTheDocument());
    // Summarize reads no attachment, so it goes live as soon as the page and
    // the model resolve. Waiting on it is what makes the assertion below mean
    // "held back by the staging" rather than "nothing has loaded yet" — the
    // state every chip starts in.
    await waitFor(() => expect(screen.getByTestId('ai-dock-chip-summarize')).not.toBeDisabled());

    expect(screen.getByTestId('ai-dock-chip-improve')).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Composer layout
// ---------------------------------------------------------------------------

/**
 * The two zones each emit a full-width card and a trigger as one fragment, so in
 * document order a card lands between the two triggers and strands one alone on
 * a wrap line. Explicit `order-*` on every flex child is what prevents that —
 * and a child added later without one defaults to `order: 0` and jumps ahead of
 * the cards, which is exactly what this test is here to catch.
 */
describe('dock composer ordering (#1154)', () => {
  it('orders every composer child explicitly: cards, triggers, field, send', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachDocument();
    await attachImage();

    expectExplicitComposerOrder(composerBox(), {
      'ai-dock-doc-attachment-card': 1,
      'ai-dock-image-card': 1,
      'ai-dock-doc-attach-button': 2,
      'ai-dock-image-trigger': 2,
      'ai-dock-input': 3,
      'ai-dock-send': 4,
    });
  });

  /**
   * The drop hint replaces the document card while a drag is over the
   * composer, so it is a composer child that exists in no other scenario — and
   * the sweep above, which only sees what its own render produced, can never
   * reach it. Losing its `order-1` would drop the hint to `order: 0`, ahead of
   * the image card, mid-drag.
   */
  it('orders the drop hint, which only exists mid-drag', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachImage();

    await act(async () => { fireEvent.dragEnter(composerBox()); });
    expect(screen.getByTestId('ai-dock-doc-drop-hint')).toBeInTheDocument();

    expectExplicitComposerOrder(composerBox(), {
      'ai-dock-doc-drop-hint': 1,
      'ai-dock-image-card': 1,
      'ai-dock-doc-attach-button': 2,
      'ai-dock-image-trigger': 2,
      'ai-dock-input': 3,
      'ai-dock-send': 4,
    });
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
    await clickChip('improve');

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
    await clickChip('improve');

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('The image expired — attach it again.');
    });
    expect(screen.getByTestId('ai-dock-empty')).toBeInTheDocument();
  });

  /** The contrast case: an unclaimed error keeps the turn and explains itself. */
  it('keeps the turn, the image and the inline error on a non-410', async () => {
    renderDock({ chatVision: true });
    await openAndSettle();
    await attachImage();

    streamSSEMock.mockImplementation(() => { throw new ApiError(500, 'LLM connection lost'); });
    await clickChip('improve');

    await waitFor(() => expect(threadText()).toContain('LLM connection lost'));
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
    await clickChip('improve');

    await waitFor(() => {
      expect(threadText()).toContain('The staged image has expired.');
    });
    expect(toastErrorMock).not.toHaveBeenCalledWith('The image expired — attach it again.');
  });
});
