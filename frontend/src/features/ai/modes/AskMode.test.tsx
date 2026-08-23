import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AskModeInput, AskExamplePrompts, ASK_EMPTY_TITLE, ASK_EMPTY_SUBTITLE } from './AskMode';
import { ASK_FALLBACK_PROMPTS } from './ask-example-prompts';
import { AiProvider, useAiContext } from '../AiContext';
import { useAuthStore } from '../../../stores/auth-store';
import { ApiError } from '../../../shared/lib/api';

Element.prototype.scrollIntoView = vi.fn();

// Replace apiFetch with a controllable mock but keep the real ApiError class
// available — runStream branches on `err instanceof ApiError` for 403 handling.
const apiFetchMock = vi.fn();
vi.mock('../../../shared/lib/api', async () =>
  (await import('../../../test-utils')).apiModuleMock(() => apiFetchMock));

const streamSSEMock = vi.fn();
vi.mock('../../../shared/lib/sse', () => ({
  streamSSE: (...args: unknown[]) => streamSSEMock(...args),
}));

const IMAGE_HANDLE = 'b'.repeat(64);
const prepareImageMock = vi.fn();
vi.mock('../../../shared/hooks/use-prepare-image', () => ({
  usePrepareImage: () => ({
    prepareImage: (...args: unknown[]) => prepareImageMock(...args),
    isPreparing: false,
    error: null,
  }),
}));

// Example prompts are derived from real instance content, so these three
// queries decide what AskExamplePrompts renders. Overridable per test via
// `promptSourceData` so a populated instance can be simulated.
let promptSourceData: {
  pages?: { title: string; spaceKey: string | null; labels: string[] }[];
  labels?: string[];
  spaces?: { key: string }[];
} = {};

// The chips gate on a RESOLVED embedding status with embedded > 0 (#1257
// post-review), so the suite's default is a healthy resolved status — an
// undefined feed would leave every chip inert and silently skew the tests
// that click one. Overridable per test for the gated windows.
let mockEmbeddingStatusData: unknown;

// importActual keeps the real `isZeroEmbeddings` helper exported — the
// component imports it from this same module, so the mock must not drop it.
vi.mock('../../../shared/hooks/use-pages', async () => ({
  ...(await vi.importActual<typeof import('../../../shared/hooks/use-pages')>(
    '../../../shared/hooks/use-pages',
  )),
  usePage: () => ({ data: undefined }),
  useEmbeddingStatus: () => ({ data: mockEmbeddingStatusData }),
  usePages: () => ({ data: promptSourceData.pages ? { items: promptSourceData.pages } : undefined }),
  usePageFilterOptions: () => ({
    data: promptSourceData.labels ? { authors: [], labels: promptSourceData.labels } : undefined,
  }),
}));

vi.mock('../../../shared/hooks/use-spaces', () => ({
  useSpaces: () => ({ data: promptSourceData.spaces }),
}));

const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: vi.fn(),
  },
}));

function createWrapper(initialEntries = ['/ai']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>
          <LazyMotion features={domAnimation}>
            <AiProvider>
              {children}
            </AiProvider>
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('AskMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default to an empty instance so prompt-source state can't leak between tests.
    promptSourceData = {};
    mockEmbeddingStatusData = {
      totalPages: 4, embeddedPages: 4, dirtyPages: 0, totalEmbeddings: 8, isProcessing: false,
    };
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'testuser',
      role: 'user',
    });
    prepareImageMock.mockResolvedValue({
      handle: IMAGE_HANDLE,
      format: 'webp',
      width: 800,
      height: 600,
      fileSize: 40_000,
      previewUrl: 'blob:ask-preview',
    });

    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/settings') {
        return Promise.resolve({ llmProvider: 'ollama', ollamaModel: '', openaiModel: null });
      }
      if (path.startsWith('/ollama/models')) {
        return Promise.resolve([]);
      }
      if (path === '/llm/conversations') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('exports correct empty state constants', () => {
    expect(ASK_EMPTY_TITLE).toBe('Ask questions about your knowledge base');
    expect(ASK_EMPTY_SUBTITLE).toBe(
      'Answers are drawn from your synced pages, with links to the ones they came from',
    );
  });

  it('keeps implementation vocabulary out of the empty-state subtitle', () => {
    // "RAG" told the reader how the feature is built, not what it does.
    expect(ASK_EMPTY_SUBTITLE).not.toMatch(/\bRAG\b/);
    expect(ASK_EMPTY_SUBTITLE).not.toMatch(/embedding|vector/i);
  });

  it('renders input field and send button', () => {
    render(<AskModeInput />, { wrapper: createWrapper() });
    expect(screen.getByPlaceholderText('Ask a question...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
  });

  it('sends an extracted document as Q&A reference context', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/settings') {
        return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
      }
      if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
      if (path === '/llm/conversations') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      format: 'txt',
      text: 'The rollout requires two approvals.',
      fileSize: 35,
      preview: 'The rollout requires two approvals.',
    }), { headers: { 'Content-Type': 'application/json' } }));
    streamSSEMock.mockImplementation(async function* fakeStream() {
      yield { content: 'Answer' };
    });

    render(<AskModeInput />, { wrapper: createWrapper() });
    fireEvent.change(screen.getByTestId('ask-doc-file-input'), {
      target: { files: [new File(['policy'], 'policy.txt', { type: 'text/plain' })] },
    });
    await screen.findByTestId('ask-doc-attachment-card');
    fireEvent.change(screen.getByPlaceholderText('Ask a question...'), {
      target: { value: 'What does the rollout require?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(streamSSEMock).toHaveBeenCalledWith(
      '/llm/ask',
      expect.objectContaining({ referenceText: 'The rollout requires two approvals.' }),
      expect.any(Object),
    ));
  });

  it('sends an attached image to Q&A when the selected chat model supports vision', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/settings') {
        return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
      }
      if (path === '/llm/usecase-default?usecase=chat') {
        return Promise.resolve({ model: 'llama3', vision: true });
      }
      if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
      if (path === '/llm/conversations') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    streamSSEMock.mockImplementation(async function* fakeStream() {
      yield { content: 'Answer' };
    });

    render(<AskModeInput />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('ask-image-trigger')).not.toBeDisabled());
    fireEvent.change(screen.getByTestId('ask-image-file-input'), {
      target: { files: [new File(['image'], 'diagram.png', { type: 'image/png' })] },
    });
    await screen.findByTestId('ask-image-card');
    fireEvent.change(screen.getByPlaceholderText('Ask a question...'), {
      target: { value: 'What is shown here?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(streamSSEMock).toHaveBeenCalledWith(
      '/llm/ask',
      expect.objectContaining({ imageHandle: IMAGE_HANDLE }),
      expect.any(Object),
    ));
  });

  /** Exposes the current URL search string so tests can assert ?q was consumed. */
  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="location-search">{location.search}</div>;
  }

  it('prefills the composer from the ?q param carried by the command palette (#957)', async () => {
    render(
      <>
        <AskModeInput />
        <LocationProbe />
      </>,
      { wrapper: createWrapper(['/ai?q=how%20do%20I%20configure%20sync%20intervals']) },
    );
    const input = screen.getByPlaceholderText('Ask a question...') as HTMLInputElement;
    expect(input.value).toBe('how do I configure sync intervals');
    // The param is consumed: refresh / history back must not re-prefill it.
    await waitFor(() => {
      expect(screen.getByTestId('location-search').textContent).not.toContain('q=');
    });
  });

  it('applies the ?q param when already mounted on /ai (#957)', async () => {
    // Simulates the command palette submitting a question while the user is
    // already on /ai: the route element is NOT remounted, only the search
    // params change, so a mount-time initializer alone would drop the question.
    function NavigateWithQuestion() {
      const navigate = useNavigate();
      return (
        <button onClick={() => navigate('/ai?q=what%20changed%20last%20week')}>
          ask from palette
        </button>
      );
    }

    render(
      <>
        <AskModeInput />
        <NavigateWithQuestion />
      </>,
      { wrapper: createWrapper(['/ai']) },
    );

    const input = screen.getByPlaceholderText('Ask a question...') as HTMLInputElement;
    expect(input.value).toBe('');

    fireEvent.click(screen.getByText('ask from palette'));

    await waitFor(() => {
      expect(input.value).toBe('what changed last week');
    });
  });

  it('focuses the input on mount (#350)', async () => {
    render(<AskModeInput />, { wrapper: createWrapper() });
    const input = screen.getByPlaceholderText('Ask a question...');
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
  });

  it('renders 4 example prompts and clicking one fills the input (#350)', async () => {
    const Composed = () => (
      <>
        <AskExamplePrompts />
        <AskModeInput />
      </>
    );
    render(<Composed />, { wrapper: createWrapper() });

    const items = screen.getAllByTestId('ask-example-prompt');
    expect(items).toHaveLength(4);
    expect(ASK_FALLBACK_PROMPTS).toHaveLength(4);

    const input = screen.getByPlaceholderText('Ask a question...') as HTMLInputElement;
    fireEvent.click(items[0]!);

    await waitFor(() => {
      expect(input.value).toBe(ASK_FALLBACK_PROMPTS[0]);
    });
  });

  it('derives example prompts from the real content of the instance', async () => {
    promptSourceData = {
      pages: [
        { title: 'On-call rotation and escalation policy', spaceKey: 'OPS', labels: ['runbook'] },
        { title: 'Postgres connection pool tuning', spaceKey: 'OPS', labels: [] },
      ],
      labels: ['runbook'],
      spaces: [{ key: 'OPS' }],
    };

    const Composed = () => (
      <>
        <AskExamplePrompts />
        <AskModeInput />
      </>
    );
    render(<Composed />, { wrapper: createWrapper() });

    const texts = screen.getAllByTestId('ask-example-prompt').map((el) => el.textContent);
    expect(texts).toContain('Summarize "On-call rotation and escalation policy"');
    expect(texts).toContain('Draft a how-to from pages tagged "runbook"');
    expect(texts).toContain('What changed in the OPS space in the last 7 days?');
  });

  // #1257 post-review (F-B): the chips enable only on a RESOLVED status with
  // at least one embedded page. A fresh install (totalPages === 0) shows no
  // zero-embeddings banner — "not embedded yet" would misname the gap — but a
  // retrieval demo over an empty corpus is no more answerable, so the chips
  // are inert there too, without an aria-describedby to a banner that is not
  // in the DOM.
  it('keeps the chips inert on a fresh install with no pages at all', () => {
    mockEmbeddingStatusData = {
      totalPages: 0, embeddedPages: 0, dirtyPages: 0, totalEmbeddings: 0, isProcessing: false,
    };

    const Composed = () => (
      <>
        <AskExamplePrompts />
        <AskModeInput />
      </>
    );
    render(<Composed />, { wrapper: createWrapper() });

    const chips = screen.getAllByTestId('ask-example-prompt');
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(chip).toHaveAttribute('aria-disabled', 'true');
      expect(chip).not.toHaveAttribute('aria-describedby');
    }

    fireEvent.click(chips[0]!);
    expect((screen.getByPlaceholderText('Ask a question...') as HTMLTextAreaElement).value).toBe('');
  });

  // #1257 post-review (F-B): the composer is DELIBERATELY not gated on
  // embedding status — the asymmetry with the chips is the decision, so pin
  // it. POST /llm/ask never refuses over zero embeddings, and hybridSearch's
  // keyword FTS leg (plus page-tree and externalUrls context) still grounds a
  // typed question without them; gating send would turn a degraded-retrieval
  // state into a total outage of those working paths. See the note above
  // handleAsk in AskMode.tsx.
  it('keeps the composer send path ungated while nothing is embedded', async () => {
    mockEmbeddingStatusData = {
      totalPages: 10, embeddedPages: 0, dirtyPages: 10, totalEmbeddings: 0, isProcessing: false,
    };
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/settings') {
        return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
      }
      if (path.startsWith('/ollama/models')) {
        return Promise.resolve([{ name: 'llama3' }]);
      }
      if (path === '/llm/conversations') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    async function* fakeStream() {
      yield { content: 'keyword-grounded answer' };
    }
    streamSSEMock.mockReturnValue(fakeStream());

    render(<AskModeInput />, { wrapper: createWrapper() });

    const input = screen.getByPlaceholderText('Ask a question...');
    fireEvent.change(input, { target: { value: 'where is the deploy runbook?' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled();
    });

    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/ask',
        expect.objectContaining({ question: 'where is the deploy runbook?' }),
        expect.any(Object),
      );
    });
  });

  it('never names a tag or space the instance does not have', () => {
    // Regression guard for the pre-critique hardcoded list, which referenced
    // an "onboarding" tag and an "engineering" space that never existed.
    promptSourceData = {};

    render(<AskExamplePrompts />, { wrapper: createWrapper() });

    const texts = screen.getAllByTestId('ask-example-prompt').map((el) => el.textContent).join(' ');
    expect(texts).not.toMatch(/onboarding/i);
    expect(texts).not.toMatch(/engineering/i);
    expect(texts).not.toMatch(/tagged "/);
  });

  it('disables send button when input is empty', () => {
    render(<AskModeInput />, { wrapper: createWrapper() });
    const btn = screen.getByRole('button', { name: 'Send message' });
    expect(btn).toBeDisabled();
  });

  it('disables send button when model is not loaded even with input', () => {
    render(<AskModeInput />, { wrapper: createWrapper() });
    const input = screen.getByPlaceholderText('Ask a question...');
    fireEvent.change(input, { target: { value: 'test question' } });
    const btn = screen.getByRole('button', { name: 'Send message' });
    expect(btn).toBeDisabled();
  });

  it('enables send button when model is loaded and input is provided', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/settings') {
        return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
      }
      if (path.startsWith('/ollama/models')) {
        return Promise.resolve([{ name: 'llama3' }]);
      }
      if (path === '/llm/conversations') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    render(<AskModeInput />, { wrapper: createWrapper() });

    // Wait for model to load
    await waitFor(() => {
      // The AiProvider will have loaded models by now
    });

    const input = screen.getByPlaceholderText('Ask a question...');
    fireEvent.change(input, { target: { value: 'test question' } });

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Send message' });
      expect(btn).not.toBeDisabled();
    });
  });

  it('calls streamSSE when ask is triggered via Enter key', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/settings') {
        return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
      }
      if (path.startsWith('/ollama/models')) {
        return Promise.resolve([{ name: 'llama3' }]);
      }
      if (path === '/llm/conversations') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    async function* fakeStream() {
      yield { content: 'Hello!' };
    }
    streamSSEMock.mockReturnValue(fakeStream());

    render(<AskModeInput />, { wrapper: createWrapper() });

    // Wait for model to load
    await waitFor(() => {
      // Let AiProvider settle
    });

    const input = screen.getByPlaceholderText('Ask a question...');
    fireEvent.change(input, { target: { value: 'What is Confluence?' } });

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Send message' });
      expect(btn).not.toBeDisabled();
    });

    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/ask',
        expect.objectContaining({
          question: 'What is Confluence?',
          model: 'llama3',
        }),
        expect.any(Object),
      );
    });
  });

  it('renders the prompt as a multi-line textarea (#1120)', () => {
    render(<AskModeInput />, { wrapper: createWrapper() });
    const input = screen.getByPlaceholderText('Ask a question...');
    expect(input.tagName).toBe('TEXTAREA');
  });

  it('Shift+Enter inserts a newline instead of submitting (#1120)', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/settings') {
        return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
      }
      if (path.startsWith('/ollama/models')) {
        return Promise.resolve([{ name: 'llama3' }]);
      }
      if (path === '/llm/conversations') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    async function* fakeStream() {
      yield { content: 'Answer' };
    }
    streamSSEMock.mockReturnValue(fakeStream());

    render(<AskModeInput />, { wrapper: createWrapper() });

    const input = screen.getByPlaceholderText('Ask a question...') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'first line' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled();
    });

    // Shift+Enter must fall through to the textarea's own newline handling:
    // nothing is sent and the draft survives.
    const shiftEnter = fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(streamSSEMock).not.toHaveBeenCalled();
    expect(input.value).toBe('first line');
    // Not default-prevented, so the browser is still free to insert the newline
    // that jsdom does not simulate for us.
    expect(shiftEnter).toBe(true);

    // The second line is typed, then a bare Enter sends the whole thing.
    fireEvent.change(input, { target: { value: 'first line\nsecond line' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/ask',
        expect.objectContaining({ question: 'first line\nsecond line' }),
        expect.any(Object),
      );
    });
  });

  it('suppresses the browser newline when a bare Enter submits (#1120)', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/settings') {
        return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
      }
      if (path.startsWith('/ollama/models')) {
        return Promise.resolve([{ name: 'llama3' }]);
      }
      if (path === '/llm/conversations') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    async function* fakeStream() {
      yield { content: 'Answer' };
    }
    streamSSEMock.mockReturnValue(fakeStream());

    render(<AskModeInput />, { wrapper: createWrapper() });

    const input = screen.getByPlaceholderText('Ask a question...') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'a question' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled();
    });

    // fireEvent returns false when the handler called preventDefault. Without
    // it a textarea would submit *and* leave a stray "\n" in the cleared field.
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
  });

  it('sends conversationId as undefined (not null) when no conversation is active', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/settings') {
        return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
      }
      if (path.startsWith('/ollama/models')) {
        return Promise.resolve([{ name: 'llama3' }]);
      }
      if (path === '/llm/conversations') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    async function* fakeStream() {
      yield { content: 'Answer' };
    }
    streamSSEMock.mockReturnValue(fakeStream());

    render(<AskModeInput />, { wrapper: createWrapper() });

    await waitFor(() => {
      // Let AiProvider settle
    });

    const input = screen.getByPlaceholderText('Ask a question...');
    fireEvent.change(input, { target: { value: 'test question' } });

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Send message' });
      expect(btn).not.toBeDisabled();
    });

    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalled();
    });

    // Verify the body passed to streamSSE does NOT contain null for conversationId.
    // The backend Zod schema accepts undefined but rejects null.
    const callBody = streamSSEMock.mock.calls[0][1];
    expect(callBody.conversationId).toBeUndefined();
    expect(callBody).not.toHaveProperty('conversationId', null);
  });

  describe('icon-only button accessible names (#939)', () => {
    beforeEach(() => {
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/mcp-docs/status') {
          return Promise.resolve({ enabled: true });
        }
        if (path === '/settings') {
          return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
        }
        if (path.startsWith('/ollama/models')) {
          return Promise.resolve([{ name: 'llama3' }]);
        }
        if (path === '/llm/conversations') {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });
    });

    it('exposes an accessible name on the add-URL and close buttons', async () => {
      render(<AskModeInput />, { wrapper: createWrapper() });

      const attach = await screen.findByTestId('attach-url-button');
      fireEvent.click(attach);

      expect(screen.getByRole('button', { name: 'Add URL' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Close URL input' })).toBeInTheDocument();
    });

    it('exposes an accessible name on each URL chip remove button', async () => {
      render(<AskModeInput />, { wrapper: createWrapper() });

      const attach = await screen.findByTestId('attach-url-button');
      fireEvent.click(attach);

      const urlInput = screen.getByTestId('external-url-input');
      fireEvent.change(urlInput, { target: { value: 'https://docs.example.com/guide' } });
      fireEvent.keyDown(urlInput, { key: 'Enter' });

      expect(
        await screen.findByRole('button', { name: 'Remove docs.example.com' }),
      ).toBeInTheDocument();
    });
  });

  it('clears input after submission', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/settings') {
        return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
      }
      if (path.startsWith('/ollama/models')) {
        return Promise.resolve([{ name: 'llama3' }]);
      }
      if (path === '/llm/conversations') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    async function* fakeStream() {
      yield { content: 'Answer' };
    }
    streamSSEMock.mockReturnValue(fakeStream());

    render(<AskModeInput />, { wrapper: createWrapper() });

    await waitFor(() => {
      // Let AiProvider settle
    });

    const input = screen.getByPlaceholderText('Ask a question...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'my question' } });

    await waitFor(() => {
      expect(input.value).toBe('my question');
    });

    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(input.value).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // Deep search (#1119 / #1112)
  // -------------------------------------------------------------------------
  //
  // The constraint under test is not cosmetic. Measured on the #1102 fixture,
  // multi-query expansion is a win on the vocabulary-gap slice (R@1 .182 ->
  // .424) and a REGRESSION on ordinary queries (R@5 .921 -> .866, McNemar exact
  // p = 0.0225) at +2.4 s/query. It is only net-positive while it is chosen per
  // question, so "the toggle resets" IS the feature, and these are its guard.
  describe('deep search is per-question and never sticky', () => {
    /** A model must resolve or the send button stays disabled. */
    function withModel() {
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/settings') {
          return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
        }
        if (path.startsWith('/ollama/models')) {
          return Promise.resolve([{ name: 'llama3' }]);
        }
        if (path.startsWith('/llm/conversations/')) {
          return Promise.resolve({
            id: 'conv-2',
            title: 'Another conversation',
            titleSource: 'question',
            model: 'llama3',
            pageId: null,
            pageTitle: null,
            createdAt: '2026-08-01T10:00:00.000Z',
            updatedAt: '2026-08-01T11:00:00.000Z',
            historyTruncated: false,
            messages: [],
          });
        }
        if (path === '/llm/conversations') {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });
      streamSSEMock.mockImplementation(async function* fakeStream() {
        yield { content: 'Answer' };
      });
    }

    /** Sends `question` and returns the request body that reached streamSSE. */
    async function askOnce(question: string) {
      const input = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(input, { target: { value: question } });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /send message/i })).not.toBeDisabled();
      });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => {
        expect(streamSSEMock).toHaveBeenCalledWith(
          '/llm/ask',
          expect.objectContaining({ question }),
          expect.any(Object),
        );
      });
      return streamSSEMock.mock.calls.find(
        (c) => (c[1] as { question?: string }).question === question,
      )![1] as Record<string, unknown>;
    }

    /**
     * The two gestures that really change the active thread now that threads
     * are keyed by location (#1361): New chat, which files a fresh draft
     * identity, and opening another conversation, which is a route change.
     *
     * `setConversationId` is deliberately NOT one of them any more — a
     * promotion writes the id onto the SAME thread, so the old stub would go
     * green against a composer that never cleared.
     */
    function ThreadSwitcher() {
      const { startNewConversation } = useAiContext();
      const navigate = useNavigate();
      return (
        <>
          <button onClick={startNewConversation}>new chat</button>
          <button onClick={() => navigate('/ai/c/conv-2')}>open conv-2</button>
        </>
      );
    }

    it('defaults to off and omits the flag entirely — an untouched composer sends the body it always sent', async () => {
      withModel();
      render(<AskModeInput />, { wrapper: createWrapper() });

      expect(screen.getByTestId('ask-deep-search')).not.toBeChecked();
      const body = await askOnce('where is the runbook?');
      expect(body).not.toHaveProperty('deepSearch');
    });

    it('sends deepSearch: true for the question it was switched on for', async () => {
      withModel();
      render(<AskModeInput />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByTestId('ask-deep-search'));
      expect(screen.getByTestId('ask-deep-search')).toBeChecked();

      const body = await askOnce('what governs the retention window?');
      expect(body.deepSearch).toBe(true);
    });

    // NON-STICKINESS TEST 1 — it must not survive a SEND.
    it('switches itself off at submit, and the NEXT question carries no flag', async () => {
      withModel();
      render(<AskModeInput />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByTestId('ask-deep-search'));
      const first = await askOnce('what governs the retention window?');
      expect(first.deepSearch).toBe(true);

      // The control is back to resting, so the user can see the mode ended.
      await waitFor(() => {
        expect(screen.getByTestId('ask-deep-search')).not.toBeChecked();
      });

      // The part that actually matters: the wire body of the next, ordinary
      // question. A toggle that merely *renders* unchecked while still sending
      // the flag would be the same measured regression with a nicer face on it.
      const second = await askOnce('who owns the deploy runbook?');
      expect(second).not.toHaveProperty('deepSearch');
    });

    // NON-STICKINESS TEST 2 — it must not survive a REMOUNT.
    it('is off again after a remount — nothing is read back out of storage', async () => {
      withModel();
      const { unmount } = render(<AskModeInput />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByTestId('ask-deep-search'));
      expect(screen.getByTestId('ask-deep-search')).toBeChecked();

      unmount();
      render(<AskModeInput />, { wrapper: createWrapper() });

      // A remount is the cheapest thing that separates component state from
      // every persisted home this could have been given — localStorage, a
      // Zustand slice, a `?deep=1` search param, an `AiThread` field. All four
      // survive it; `useState` in the composer does not.
      expect(screen.getByTestId('ask-deep-search')).not.toBeChecked();
    });

    it('writes nothing to storage when toggled', () => {
      withModel();
      render(<AskModeInput />, { wrapper: createWrapper() });
      // Spy on the instances, not on `Storage.prototype`: test-setup.ts
      // replaces window.localStorage with a plain object when jsdom's is not
      // functional, and a prototype spy silently misses that one — a green
      // assertion against an object it never patched.
      const local = vi.spyOn(window.localStorage, 'setItem');
      const session = vi.spyOn(window.sessionStorage, 'setItem');

      fireEvent.click(screen.getByTestId('ask-deep-search'));

      expect(local).not.toHaveBeenCalled();
      expect(session).not.toHaveBeenCalled();
    });

    it('names the cost and the lifetime rather than selling the feature', () => {
      withModel();
      render(<AskModeInput />, { wrapper: createWrapper() });

      const hint = screen.getByTestId('ask-deep-search').closest('label')!.getAttribute('title')!;
      // Slower, honest that it is sometimes worse, and explicitly one-shot.
      expect(hint).toMatch(/seconds/i);
      expect(hint).toMatch(/worse/i);
      expect(hint).toMatch(/this question only/i);
      // And the measurement is not rounded in the feature's favour: the delta
      // is 2.36 s (1.40 -> 3.76), so "roughly 2 seconds" undersold it.
      expect(hint).not.toMatch(/roughly 2 seconds/i);
      expect(hint).toMatch(/2\.4 seconds/);
    });

    // The whole reason this ships opt-in is that it is measurably WORSE on
    // ordinary questions. A caveat that lives only in `title` is unreachable by
    // touch, by keyboard and by a screen reader — and the text that WAS visible
    // ("Slower; this question only.") reads as slower-but-better, the inverse of
    // the measurement. So the downside is on screen, at rest, and wired to the
    // control as its description.
    it('shows the downside without hover, before the toggle is switched on', () => {
      withModel();
      render(<AskModeInput />, { wrapper: createWrapper() });

      const toggle = screen.getByTestId('ask-deep-search');
      expect(toggle).not.toBeChecked();

      const caveat = screen.getByTestId('ask-deep-search-caveat');
      expect(caveat).toBeVisible();
      // The two halves of an honest description: what it is for, and what it
      // costs you when it is not.
      expect(caveat).toHaveTextContent(/normal search missed/i);
      expect(caveat).toHaveTextContent(/worse on straightforward questions/i);
      expect(caveat).toHaveTextContent(/2\.4 seconds slower/i);
      expect(caveat).toHaveTextContent(/this question only/i);
    });

    it('describes the control with that text rather than leaving it decorative', () => {
      withModel();
      render(<AskModeInput />, { wrapper: createWrapper() });

      const describedBy = screen.getByTestId('ask-deep-search').getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      // Not just "an id is present": it has to resolve to the element carrying
      // the caveat, or the reference is dangling and announces nothing.
      expect(document.getElementById(describedBy!))
        .toBe(screen.getByTestId('ask-deep-search-caveat'));
    });

    // #1119 review: a switch swaps the thread under a mounted composer, so
    // this boundary is not covered by the remount test above. Since #1361 the
    // boundary is `activeThreadId`, not `conversationId`.
    it('clears an unconsumed toggle when another conversation is opened', async () => {
      withModel();
      render(
        <>
          <ThreadSwitcher />
          <AskModeInput />
        </>,
        { wrapper: createWrapper() },
      );

      fireEvent.click(screen.getByTestId('ask-deep-search'));
      expect(screen.getByTestId('ask-deep-search')).toBeChecked();

      fireEvent.click(screen.getByText('open conv-2'));
      await waitFor(() => {
        expect(screen.getByTestId('ask-deep-search')).not.toBeChecked();
      });
    });

    // NON-STICKINESS TEST 3 — new -> new. Pressing New chat on an already
    // empty draft files a fresh identity precisely so this clears; keyed on
    // `conversationId` it would not, because both drafts carry `null`.
    it('clears an unconsumed toggle when New chat is pressed on an empty draft', async () => {
      withModel();
      render(
        <>
          <ThreadSwitcher />
          <AskModeInput />
        </>,
        { wrapper: createWrapper() },
      );

      fireEvent.click(screen.getByTestId('ask-deep-search'));
      expect(screen.getByTestId('ask-deep-search')).toBeChecked();

      fireEvent.click(screen.getByText('new chat'));
      await waitFor(() => {
        expect(screen.getByTestId('ask-deep-search')).not.toBeChecked();
      });
    });
  });

  // -------------------------------------------------------------------------
  // #1361 — the composer follows the active thread
  // -------------------------------------------------------------------------
  describe('composer state is scoped to the active thread', () => {
    function withModel() {
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/settings') {
          return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
        }
        if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
        if (path === '/mcp-docs/status') return Promise.resolve({ enabled: true });
        return Promise.resolve([]);
      });
      streamSSEMock.mockImplementation(async function* fakeStream() {
        yield { content: 'Answer' };
      });
    }

    function ThreadSwitcher() {
      const { startNewConversation } = useAiContext();
      return <button onClick={startNewConversation}>new chat</button>;
    }

    it('drops attached external URLs when the active thread changes', async () => {
      withModel();
      render(
        <>
          <ThreadSwitcher />
          <AskModeInput />
        </>,
        { wrapper: createWrapper() },
      );

      fireEvent.click(await screen.findByTestId('attach-url-button'));
      fireEvent.change(screen.getByTestId('external-url-input'), {
        target: { value: 'https://docs.example.com/runbook' },
      });
      fireEvent.click(screen.getByLabelText('Add URL'));
      expect(await screen.findByText('docs.example.com')).toBeInTheDocument();

      fireEvent.click(screen.getByText('new chat'));

      // The URLs describe the question they were attached to, and the row that
      // adds them is the same per-send state.
      await waitFor(() => {
        expect(screen.queryByText('docs.example.com')).not.toBeInTheDocument();
      });
      expect(screen.queryByTestId('external-url-input')).not.toBeInTheDocument();
    });

    it('clears staged attachments when the active thread changes', async () => {
      withModel();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        format: 'txt',
        text: 'The rollout requires two approvals.',
        fileSize: 35,
        preview: 'The rollout requires two approvals.',
      }), { headers: { 'Content-Type': 'application/json' } }));

      render(
        <>
          <ThreadSwitcher />
          <AskModeInput />
        </>,
        { wrapper: createWrapper() },
      );

      fireEvent.change(screen.getByTestId('ask-doc-file-input'), {
        target: { files: [new File(['policy'], 'policy.txt', { type: 'text/plain' })] },
      });
      await screen.findByTestId('ask-doc-attachment-card');

      fireEvent.click(screen.getByText('new chat'));

      // `AssistantAttachmentsScope` cleared on `pageId` before #1361, which on
      // /ai is null for every thread — so nothing cleared between conversations
      // and an uploaded source crossed into the next one.
      await waitFor(() => {
        expect(screen.queryByTestId('ask-doc-attachment-card')).not.toBeInTheDocument();
      });
    });

    it('focuses the textarea on every composer focus request', async () => {
      withModel();
      render(
        <>
          <ThreadSwitcher />
          <AskModeInput />
        </>,
        { wrapper: createWrapper() },
      );

      const input = screen.getByTestId('ask-input');
      (screen.getByText('new chat') as HTMLButtonElement).focus();
      expect(document.activeElement).not.toBe(input);

      fireEvent.click(screen.getByText('new chat'));

      // New chat lands the caret where the next question goes (the #1176 dock
      // convention). Opening a row deliberately does not.
      await waitFor(() => {
        expect(document.activeElement).toBe(input);
      });
    });

    it('disables Send while the open conversation is still loading', async () => {
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/settings') {
          return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
        }
        if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
        if (path.startsWith('/llm/conversations/')) return new Promise(() => {});
        return Promise.resolve([]);
      });
      streamSSEMock.mockImplementation(async function* fakeStream() {
        yield { content: 'Answer' };
      });

      render(<AskModeInput />, { wrapper: createWrapper(['/ai/c/pending?q=already typed']) });

      const input = await screen.findByTestId('ask-input');
      await waitFor(() => {
        expect((input as HTMLTextAreaElement).value).toBe('already typed');
      });

      // A ?q= prefill is exactly the case where the composer has text before
      // the history has arrived, so "empty input" is not the guard.
      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();

      // …and Enter must not slip past it: the textarea is not disabled.
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => {
        expect(streamSSEMock).not.toHaveBeenCalled();
      });
    });

    // F2: the guard used to read `threadLoadState === 'loading'` only, so a
    // FAILED load left Send live with `conversationId: null` — sending would
    // silently fork a brand new conversation rather than surface the failure
    // the destructive block above the composer is already reporting.
    it('disables Send while the open conversation failed to load, not only while it is loading', async () => {
      let rejectLoad!: (err: unknown) => void;
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/settings') {
          return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
        }
        if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
        if (path.startsWith('/llm/conversations/')) {
          return new Promise((_resolve, reject) => { rejectLoad = reject; });
        }
        return Promise.resolve([]);
      });
      streamSSEMock.mockImplementation(async function* fakeStream() {
        yield { content: 'Answer' };
      });

      render(<AskModeInput />, { wrapper: createWrapper(['/ai/c/broken?q=already typed']) });

      const input = await screen.findByTestId('ask-input');
      await waitFor(() => {
        expect((input as HTMLTextAreaElement).value).toBe('already typed');
      });
      // Still `loading` here — same assertion the sibling test above makes.
      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();

      // The load fails and the thread moves from `loading` to `error`. A
      // guard reading `threadLoadState === 'loading'` only would let Send go
      // live right here; `!== 'ready'` keeps it disabled through both states.
      await act(async () => {
        rejectLoad(new ApiError(503, 'Service Unavailable (HTTP 503)'));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();

      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => {
        expect(streamSSEMock).not.toHaveBeenCalled();
      });
    });
  });

  // #1361 decision 10, made visible. `selectReplayableHistory` replays only the
  // whole exchanges that fit the model's budget, so a long conversation quietly
  // stops carrying its own beginning; the flag rides each ask's final frame and
  // `GET /llm/conversations/:id`. Both /llm/ask surfaces render it.
  describe('history-truncated note', () => {
    const NOTE = 'Older messages in this conversation are no longer sent to the model.';

    function settleModels() {
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/settings') {
          return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
        }
        if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
        if (path === '/llm/conversations') return Promise.resolve([]);
        return Promise.resolve([]);
      });
    }

    it('is absent until the server says the history was clipped', async () => {
      settleModels();
      render(<AskModeInput />, { wrapper: createWrapper() });
      // Type so the composer settles into its enabled state (the button also
      // gates on `input.trim()`) — that settling is what proves the model
      // fetch has resolved, before asserting the note's absence.
      fireEvent.change(screen.getByPlaceholderText('Ask a question...'), { target: { value: 'q' } });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled(),
      );
      expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    });

    it('appears above the composer once an answer reports it', async () => {
      settleModels();
      streamSSEMock.mockImplementation(async function* fakeStream() {
        yield { content: 'Answer' };
        yield { final: true, conversationId: 'c-1', historyTruncated: true, sources: [], done: true };
      });

      render(<AskModeInput />, { wrapper: createWrapper() });
      fireEvent.change(screen.getByPlaceholderText('Ask a question...'), {
        target: { value: 'and then?' },
      });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled(),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

      const note = await screen.findByTestId('ask-history-truncated');
      expect(note).toHaveTextContent(NOTE);
    });

    it('is muted prose, never a live region', async () => {
      // It is a standing fact about the thread, not an event. In a live region
      // it would be announced again on every re-render the composer does while
      // the user types.
      settleModels();
      streamSSEMock.mockImplementation(async function* fakeStream() {
        yield { content: 'Answer' };
        yield { final: true, conversationId: 'c-1', historyTruncated: true, sources: [], done: true };
      });

      render(<AskModeInput />, { wrapper: createWrapper() });
      fireEvent.change(screen.getByPlaceholderText('Ask a question...'), { target: { value: 'q' } });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled(),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

      const note = await screen.findByTestId('ask-history-truncated');
      expect(note).not.toHaveAttribute('role');
      expect(note).not.toHaveAttribute('aria-live');
      expect(note.className).toContain('text-[11px]');
      expect(note.className).toContain('text-muted-foreground');
    });
  });
});
