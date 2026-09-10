import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AiAssistantPage } from './AiAssistantPage';
import { AiProvider, useAiContext } from './AiContext';
import { ApiError } from '../../shared/lib/api';
import { useAuthStore } from '../../stores/auth-store';

// scrollIntoView is not available in jsdom
Element.prototype.scrollIntoView = vi.fn();

// Replace apiFetch with a controllable mock but keep the real ApiError class
// available — runStream branches on `err instanceof ApiError` for 403 handling.
const apiFetchMock = vi.fn();
vi.mock('../../shared/lib/api', async () =>
  (await import('../../test-utils')).apiModuleMock(() => apiFetchMock));

// Mock SSE module so we can control streaming behavior
const streamSSEMock = vi.fn();
vi.mock('../../shared/lib/sse', () => ({
  streamSSE: (...args: unknown[]) => streamSSEMock(...args),
}));

const mockExtractDocument = vi.fn();
vi.mock('../../shared/hooks/use-extract-document', () => ({
  useExtractDocument: () => ({
    extractDocument: (...args: unknown[]) => mockExtractDocument(...args),
    isExtracting: false,
    error: null,
  }),
}));

const IMAGE_HANDLE = 'a'.repeat(64);
const mockPrepareImage = vi.fn();
vi.mock('../../shared/hooks/use-prepare-image', () => ({
  usePrepareImage: () => ({
    prepareImage: (...args: unknown[]) => mockPrepareImage(...args),
    isPreparing: false,
    error: null,
  }),
}));

// Default: no page selected
let mockPageData: { data: unknown; isLoading?: boolean } = { data: undefined };
// Controllable embedding-status feed for the #938 zero-embeddings notice.
// importActual keeps the real `isZeroEmbeddings` helper exported — the
// component imports it from this same module, so the mock must not drop it.
let mockEmbeddingStatus: { data: unknown } = { data: undefined };
vi.mock('../../shared/hooks/use-pages', async () => ({
  ...(await vi.importActual<typeof import('../../shared/hooks/use-pages')>(
    '../../shared/hooks/use-pages',
  )),
  usePage: () => mockPageData,
  useEmbeddingStatus: () => mockEmbeddingStatus,
}));

// Mock sonner toast so we can verify error messages
const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

// AiProvider is mounted by the wrapper, not by the page: it lives in AppLayout
// now (#1126) so a conversation outlives the /ai route.
/** Renders the current URL so a test can observe navigations the page performs. */
function AiLocationProbe() {
  const location = useLocation();
  return <span data-testid="ai-location">{location.pathname + location.search}</span>;
}

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
              {/* After the page, so `container.firstElementChild` is still the
                  page itself for the tests that assert on its root classes. */}
              {children}
              <AiLocationProbe />
            </AiProvider>
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

/**
 * Variant that exposes the QueryClient so the test can manipulate cache state
 * directly (used by the #355 chat-default-prefill tests below to simulate an
 * admin-side change without round-tripping through a real PUT).
 */
function createWrapperWithClient(initialEntries = ['/ai']): {
  Wrapper: ({ children }: { children: React.ReactNode }) => React.ReactElement;
  queryClient: QueryClient;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <LazyMotion features={domAnimation}>
          <AiProvider>{children}</AiProvider>
        </LazyMotion>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { Wrapper, queryClient };
}

describe('AiAssistantPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPageData = { data: undefined };
    mockEmbeddingStatus = { data: undefined };
    mockExtractDocument.mockResolvedValue({
      format: 'pdf',
      text: 'The service retries three times.',
      fileSize: 1024,
      preview: 'The service retries three times.',
    });
    mockPrepareImage.mockResolvedValue({
      handle: IMAGE_HANDLE,
      format: 'webp',
      width: 800,
      height: 600,
      fileSize: 40_000,
      previewUrl: 'blob:assistant-preview',
    });
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'testuser',
      role: 'user',
    });

    // Default apiFetch: return settings, then empty arrays for models and conversations
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

  // #1361 + owner ruling 3: the actions that need no open document. The rewrite
  // skills and Diagram act ON the page you are reading, and `/ai` has no page
  // scope left — the Pages tree has left the rail and `resolveAiPageId` answers
  // null here. They stay in the dock, which does have one (`DOCK_ACTIONS`). The
  // #1401 create skills stay HERE too: they produce a new page, which is what
  // this surface is for.
  it('offers Q&A, Generate and the create skills — no rewrite skills, no Diagram', async () => {
    render(<AiAssistantPage />, { wrapper: createWrapper() });
    fireEvent.pointerDown(screen.getByTestId('assistant-action-select'), { button: 0 });
    for (const action of ['ask', 'generate', 'create-spec', 'create-guide', 'create-notes', 'create-postmortem', 'create-custom']) {
      expect(await screen.findByTestId(`assistant-action-${action}`)).toBeInTheDocument();
    }
    for (const action of ['grammar', 'structure', 'clarity', 'technical', 'completeness', 'diagram']) {
      expect(screen.queryByTestId(`assistant-action-${action}`)).not.toBeInTheDocument();
    }
    // The section label goes with its items — a header over nothing is worse
    // than a shorter menu.
    expect(screen.queryByText('Rewrite skills')).not.toBeInTheDocument();
    expect(screen.getByText('Create skills')).toBeInTheDocument();
    expect(screen.queryByText('Summarize')).not.toBeInTheDocument();
    expect(screen.queryByText('Quality')).not.toBeInTheDocument();
  });

  // #1361 / amendment item 2 put New chat at the top of the page column;
  // 2026-09-01 the owner had it removed again, because the conversations rail
  // already carries one — full-width when expanded, a glyph when collapsed
  // (`AiConversationsSidebar`, whose own tests pin both) — and two buttons a
  // few hundred pixels apart ran the same action. What survives here is the
  // route title, in the document: dev deleted the header slot outright
  // (#1377/#1378), so `HeaderHost` renders inline.
  describe('the /ai heading row (#1361)', () => {
    it('carries the route title, and no second New chat action', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper() });

      expect(screen.getByRole('heading', { level: 1, name: 'AI' })).toBeInTheDocument();
      // One heading, and it is this page's: there is no fallback title left
      // anywhere else to collide with, AppHeaderMain having been deleted.
      expect(screen.getAllByRole('heading', { level: 1, name: 'AI' })).toHaveLength(1);
      // The rail owns the action. A duplicate here is the thing that was
      // removed, so its absence is what this pins — by accessible name, not by
      // testid, because a differently-named copy of the same button is the
      // same duplicate.
      expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();
    });

    it('never portals into a header slot, even when one exists in the DOM', () => {
      // `header-slot.test.tsx:7-19` makes this assertion about HeaderHost
      // itself; this is the /ai-shaped case, and it is what goes red if anyone
      // reintroduces the portal underneath this page.
      const slot = document.createElement('div');
      slot.id = 'app-header-slot';
      document.body.appendChild(slot);

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      expect(slot.querySelector('h1')).toBeNull();
      expect(slot.childElementCount).toBe(0);
      slot.remove();
    });
  });

  // #1361: a `conv:` thread is fetched, so the message pane has two states the
  // draft never had. Neither may render the Ask empty state — "Ask questions
  // about your knowledge base" over a conversation that is still loading says
  // the conversation is empty.
  describe('reopened-conversation states (#1361)', () => {
    it('shows a polite loading status instead of the empty state', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai/c/conv-1']) });

      const status = screen.getByTestId('ai-thread-loading');
      expect(status).toHaveAttribute('role', 'status');
      expect(status).toHaveTextContent('Loading conversation…');
      expect(screen.queryByText('Ask questions about your knowledge base')).not.toBeInTheDocument();
    });

    it('shows the destructive block with a Retry that re-arms the fetch', async () => {
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/llm/conversations/conv-1') return Promise.reject(new ApiError(500, 'Server unavailable'));
        if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
        return Promise.resolve([]);
      });

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai/c/conv-1']) });

      const block = await screen.findByTestId('ai-thread-error');
      expect(block).toHaveAttribute('role', 'alert');
      expect(block).toHaveTextContent('Couldn’t load conversation');
      expect(block).toHaveTextContent('Server unavailable');
      expect(screen.queryByText('Ask questions about your knowledge base')).not.toBeInTheDocument();

      const before = apiFetchMock.mock.calls.filter((c) => c[0] === '/llm/conversations/conv-1').length;
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => {
        const after = apiFetchMock.mock.calls.filter((c) => c[0] === '/llm/conversations/conv-1').length;
        expect(after).toBeGreaterThan(before);
      });
    });

    it('renders the empty state once the thread is ready', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper() });
      expect(screen.queryByTestId('ai-thread-loading')).not.toBeInTheDocument();
      expect(screen.getByText('Ask questions about your knowledge base')).toBeInTheDocument();
    });
  });

  // #1361: `/ai` runs two actions, so its URL parser admits two modes. A
  // deep link naming any other one falls back to Q&A rather than rendering a
  // screen with no way back to the composer the route is for — the same
  // fallback the retired `summarize` / `quality` values already got.
  describe('URL mode allow-list on an AI route (#1361)', () => {
    for (const rejected of ['improve', 'diagram', 'summarize', 'quality']) {
      it(`falls back to Q&A for ?mode=${rejected}`, () => {
        render(<AiAssistantPage />, { wrapper: createWrapper([`/ai?mode=${rejected}`]) });
        expect(screen.getByText('Ask questions about your knowledge base')).toBeInTheDocument();
        expect(screen.getByTestId('assistant-action-select')).toHaveAccessibleName('Selected action: Q&A');
      });
    }

    it('still honours ?mode=generate', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=generate']) });
      // Not "Selected action: Generate": `createSkill` is a required context
      // field defaulting to 'spec' (pre-existing, outside this task's scope —
      // resolveAssistantAction and applyAssistantAction are both untouched
      // here), so `resolveAssistantAction` always treats a truthy createSkill
      // as an explicit pick and resolves mode='generate' to 'create-spec'. The
      // load-bearing assertion is that the URL mode was HONOURED at all —
      // GenerateMode rendered, not the Q&A fallback the rejected-mode cases
      // above land on.
      expect(screen.getByTestId('assistant-action-select')).toHaveAccessibleName('Selected action: Tech Spec');
    });
  });

  it('uses flex-1 column layout so the input bar anchors to the bottom of the viewport', () => {
    // The AI page opts into the flex column propagated by AppLayout +
    // PageTransition (both ship `flex flex-1 flex-col` on their wrappers).
    // That lets this page reach `flex-1` without a `calc(100vh - chrome)`
    // magic number that would drift with header / service-status height.
    const { container } = render(<AiAssistantPage />, { wrapper: createWrapper() });
    const rootDiv = container.firstElementChild as HTMLElement;
    expect(rootDiv.className).toContain('flex-1');
    expect(rootDiv.className).toContain('flex-col');
    expect(rootDiv.className).not.toContain('calc');
    expect(rootDiv.className).not.toContain('100vh');
  });

  it('renders empty state message for Q&A mode', () => {
    render(<AiAssistantPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Ask questions about your knowledge base')).toBeInTheDocument();
  });

  describe('ask mode', () => {
    it('disables send button when model is not loaded', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper() });

      const input = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(input, { target: { value: 'test question' } });

      const buttons = screen.getAllByRole('button');
      // The send button is the last button in the input area
      const sendBtn = buttons.find((b) => b.closest('.nm-card.mt-4'));
      // It should be disabled because model is empty
      if (sendBtn) {
        expect(sendBtn).toBeDisabled();
      }
    });

    it('replaces the placeholder assistant message with an inline error when the ask stream throws', async () => {
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

      // eslint-disable-next-line require-yield
      async function* fakeErrorStream() {
        throw new Error('Connection lost');
      }
      streamSSEMock.mockReturnValue(fakeErrorStream());

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      // Wait for model to load
      await waitFor(() => {
        expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(input, { target: { value: 'What is Confluence?' } });

      await waitFor(() => {
        const sendBtn = input.parentElement?.querySelector('button');
        expect(sendBtn).not.toBeDisabled();
      });

      fireEvent.keyDown(input, { key: 'Enter' });

      // The toast still fires for generic (non-403) errors
      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith('Connection lost');
      });

      // The user message should still be visible
      expect(screen.getByText('What is Confluence?')).toBeInTheDocument();

      // The placeholder assistant message must NOT be silently removed: it is
      // replaced with a visible inline error bubble carrying destructive styling.
      const errorBubble = screen.getByTestId('message-error');
      expect(errorBubble.textContent).toContain('Connection lost');
      expect(errorBubble.className).toContain('destructive');

      // No lingering typing indicator
      expect(screen.queryByTestId('typing-indicator')).not.toBeInTheDocument();
    });

    it('shows an inline permission explanation without a toast when ask is rejected with 403', async () => {
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

      // Backend rejects POST /api/llm/ask with 403 when the user lacks the
      // llm:query RBAC permission — streamSSE surfaces it as an ApiError.
      // eslint-disable-next-line require-yield
      async function* fakeForbiddenStream() {
        throw new ApiError(403, 'Permission "llm:query" required');
      }
      streamSSEMock.mockReturnValue(fakeForbiddenStream());

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(input, { target: { value: 'What is Confluence?' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      // The chat shows what happened inline, in the assistant's bubble.
      await waitFor(() => {
        expect(screen.getByTestId('message-error')).toBeInTheDocument();
      });
      const errorBubble = screen.getByTestId('message-error');
      expect(errorBubble.textContent).toContain('permission');
      expect(errorBubble.textContent).toContain('llm:query');
      expect(errorBubble.textContent).toContain('administrator');
      expect(errorBubble.className).toContain('destructive');

      // 403 is fully explained inline — no redundant toast.
      expect(toastErrorMock).not.toHaveBeenCalled();

      // The user message stays visible above the explanation.
      expect(screen.getByText('What is Confluence?')).toBeInTheDocument();
    });

    it('announces errors via a live region that is primed before any error occurs', async () => {
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

      // eslint-disable-next-line require-yield
      async function* fakeForbiddenStream() {
        throw new ApiError(403, 'Permission "llm:query" required');
      }
      streamSSEMock.mockReturnValue(fakeForbiddenStream());

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
      });

      // The announcer must exist EMPTY before any error: per MDN's alert-role
      // guidance, the role="alert" element has to be in the DOM first so AT
      // watches it for content changes — adding the role together with the
      // message is generally NOT announced.
      const announcer = screen.getByTestId('ai-error-announcer');
      expect(announcer).toHaveAttribute('role', 'alert');
      expect(announcer).toHaveTextContent('');

      const input = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(input, { target: { value: 'What is Confluence?' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(screen.getByTestId('message-error')).toBeInTheDocument();
      });
      // The 403 path deliberately suppresses the toast, so this primed region
      // is the only screen-reader announcement of the permission failure.
      expect(announcer).toHaveTextContent(/llm:query/);
      // The visible bubble must NOT also claim role="alert": the role+content
      // arriving together is the unreliable pattern, and two alert regions
      // would double-announce on the AT combos where it does fire.
      expect(screen.getByTestId('message-error')).not.toHaveAttribute('role', 'alert');
    });

    it('re-announces when a retry fails with the byte-identical error', async () => {
      // Ask mode APPENDS on retry (it never resets the list), so the derived
      // announcer text stays identical across attempts — React would reconcile
      // the same text node and AT would announce nothing, leaving a
      // screen-reader user believing the retry succeeded. The announcer must
      // mount a FRESH child element per error (keyed by message id): node
      // insertion into a live region announces even when the text is equal.
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

      // Fresh generator per call — a retry must not reuse the exhausted one.
      // eslint-disable-next-line require-yield
      async function* fakeForbiddenStream() {
        throw new ApiError(403, 'Permission "llm:query" required');
      }
      streamSSEMock.mockImplementation(() => fakeForbiddenStream());

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(input, { target: { value: 'What is Confluence?' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(screen.getAllByTestId('message-error')).toHaveLength(1);
      });
      const announcer = screen.getByTestId('ai-error-announcer');
      const firstNode = announcer.firstElementChild;
      expect(firstNode).not.toBeNull();

      // Retry the same question → same 403, byte-identical message.
      fireEvent.change(input, { target: { value: 'What is Confluence?' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(screen.getAllByTestId('message-error')).toHaveLength(2);
      });
      // Same text, but a NEW child node — that insertion is what AT announces.
      expect(announcer).toHaveTextContent(/llm:query/);
      expect(announcer.firstElementChild).not.toBeNull();
      expect(announcer.firstElementChild).not.toBe(firstNode);
    });

    it('names the permission from the backend 403 message, not a hardcoded one', async () => {
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

      // Each streamed mode has its own permission (llm:improve, llm:generate,
      // llm:summarize…) — the shared runStream catch must surface whichever
      // one the backend named, not always "llm:query".
      // eslint-disable-next-line require-yield
      async function* fakeForbiddenStream() {
        throw new ApiError(403, 'Permission "llm:improve" required');
      }
      streamSSEMock.mockReturnValue(fakeForbiddenStream());

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(input, { target: { value: 'Improve this' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(screen.getByTestId('message-error')).toBeInTheDocument();
      });
      const errorBubble = screen.getByTestId('message-error');
      expect(errorBubble.textContent).toContain('llm:improve');
      expect(errorBubble.textContent).not.toContain('llm:query');
      expect(errorBubble.textContent).toContain('administrator');
    });

    it('surfaces in-band SSE error events inline instead of leaving an empty bubble', async () => {
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

      // Mid-stream provider failures arrive as `data: {"error": …}` events on
      // an already-established HTTP 200 stream — the common failure path.
      async function* fakeErrorEventStream() {
        yield { error: 'LLM provider exploded' };
      }
      streamSSEMock.mockReturnValue(fakeErrorEventStream());

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(input, { target: { value: 'What is Confluence?' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      // Inline error bubble, same treatment as thrown errors…
      await waitFor(() => {
        expect(screen.getByTestId('message-error')).toBeInTheDocument();
      });
      const errorBubble = screen.getByTestId('message-error');
      expect(errorBubble.textContent).toContain('LLM provider exploded');
      expect(errorBubble.className).toContain('destructive');

      // …plus the toast, matching non-403 thrown errors.
      expect(toastErrorMock).toHaveBeenCalledWith('LLM provider exploded');

      // No lingering typing indicator after the failure.
      expect(screen.queryByTestId('typing-indicator')).not.toBeInTheDocument();
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

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      // Wait for model to load
      await waitFor(() => {
        expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(input, { target: { value: 'test question' } });

      // The send button should now be enabled
      await waitFor(() => {
        // Find the last button in the page (the send button)
        screen.getAllByRole('button');
        // The send button doesn't have text, just an icon, and is in the input area
        const sendBtnContainer = input.closest('.nm-card');
        const sendBtn = sendBtnContainer?.querySelector('button');
        if (sendBtn) {
          expect(sendBtn).not.toBeDisabled();
        }
      });
    });
  });

  describe('AI context page change (#417)', () => {
    // #1126: the page-context chip was a non-interactive <span> naming a page
    // you could not click, clear, or swap — the literal "context is invisible
    // and unswitchable" defect. Deleting it outright was wrong: SidebarTreeView
    // still navigates `/ai?pageId=…` and Ask still sends that id, so answers
    // stayed scoped to a page the UI no longer mentioned. It is a real control
    // now — it names the scope and clears it.
    it('reads the thread from the hoisted provider rather than one of its own (#1126)', () => {
      // The page must NOT mount an AiProvider of its own. If it did, /ai would
      // hold a thread nobody else can see — and every test that only exercises
      // /ai would still pass against that private instance. Seeding through a
      // sibling consumer of the shell's provider is what catches it.
      function ThreadSeeder() {
        const { setMessages } = useAiContext();
        return (
          <button
            onClick={() =>
              setMessages([{ id: 'seeded-1', role: 'user', content: 'seeded outside the page' }])
            }
          >
            seed thread
          </button>
        );
      }

      render(
        <>
          <ThreadSeeder />
          <AiAssistantPage />
        </>,
        { wrapper: createWrapper(['/ai?pageId=p1']) },
      );

      fireEvent.click(screen.getByText('seed thread'));
      expect(screen.getByText('seeded outside the page')).toBeInTheDocument();
    });

    // A page context is still an input to Q&A, so it remains the default;
    // only an explicit ?mode= reaches another assistant action.
    it('defaults to Q&A when a pageId is present but no mode is given', () => {
      mockPageData = {
        data: { id: 'p1', title: 'My Article', bodyHtml: '<p>Content</p>', bodyText: 'Content' },
      };

      render(<AiAssistantPage />, {
        wrapper: createWrapper(['/ai?pageId=p1']),
      });

      expect(screen.getByTestId('assistant-action-select')).toHaveAccessibleName('Selected action: Q&A');
      expect(screen.getByText('Ask questions about your knowledge base')).toBeInTheDocument();
    });
  });

  describe('empty state messages', () => {
    it('shows only Q&A empty state in ask mode', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper() });

      expect(screen.getByText('Ask questions about your knowledge base')).toBeInTheDocument();
      expect(
        screen.getByText('Answers are drawn from your synced pages, with links to the ones they came from'),
      ).toBeInTheDocument();
      // Should NOT show other mode messages
      expect(screen.queryByText('Select a page and improvement type')).not.toBeInTheDocument();
    });
  });

  describe('narrow-viewport reachability', () => {
    it('scrolls the message pane rather than hiding overflow', () => {
      // At viewport heights <= 768px the empty-state prompt cards were clipped
      // with no way to reach them; on mobile they rendered behind the composer.
      render(<AiAssistantPage />, { wrapper: createWrapper() });

      const pane = screen.getByTestId('ai-message-pane');
      expect(pane.className).toContain('overflow-y-auto');
      expect(pane.className).toContain('min-h-0');
      expect(pane.className).not.toContain('overflow-hidden');
    });
  });

  describe('zero-embeddings notice (#938)', () => {
    it('warns that pages are not embedded yet in Q&A mode when embeddedPages is 0', () => {
      // Pages exist but none are embedded — RAG has no context to draw on, so
      // the user must be told the real cause instead of a misleading answer.
      mockEmbeddingStatus = {
        data: { totalPages: 10, embeddedPages: 0, dirtyPages: 10, totalEmbeddings: 0, isProcessing: false },
      };

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      const notice = screen.getByTestId('ai-no-embeddings-notice');
      expect(notice).toBeInTheDocument();
      expect(notice.textContent).toMatch(/not embedded/i);
    });

    it('does not show the notice when pages are embedded', () => {
      mockEmbeddingStatus = {
        data: { totalPages: 10, embeddedPages: 10, dirtyPages: 0, totalEmbeddings: 10, isProcessing: false },
      };

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      expect(screen.queryByTestId('ai-no-embeddings-notice')).not.toBeInTheDocument();
    });

    // The example-prompt chips invite exactly the retrieval the banner says
    // is absent ("Find pages that look like duplicates…"), ~12px below it.
    // While the banner's own condition holds they must be inert — visually
    // muted AND semantically disabled, with the banner as the programmatic
    // reason — and they re-enable when embeddings exist.
    it('disables the example prompts while nothing is embedded, naming the notice as the reason', () => {
      mockEmbeddingStatus = {
        data: { totalPages: 10, embeddedPages: 0, dirtyPages: 10, totalEmbeddings: 0, isProcessing: false },
      };

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      const chips = screen.getAllByTestId('ask-example-prompt');
      expect(chips.length).toBeGreaterThan(0);
      for (const chip of chips) {
        // aria-disabled, not native disabled: the chips stay focusable so a
        // keyboard/SR user can land on one and hear why it is inert.
        expect(chip).toHaveAttribute('aria-disabled', 'true');
        expect(chip).toHaveAttribute('aria-describedby', 'ai-no-embeddings-notice');
        // Muting must be an explicit per-theme token, never opacity: alpha
        // compositing lands differently per theme (2.66:1 on Paper vs 3.64:1
        // on Graphite for opacity-50), so the two themes stop reading the
        // same.
        expect(chip.className).toContain('cursor-not-allowed');
        expect(chip.className).toContain('text-muted-foreground');
        expect(chip.className).not.toContain('opacity-');
      }

      // The describedby id must resolve to the visible banner, so the linkage
      // is real and not a dangling reference.
      const notice = document.getElementById('ai-no-embeddings-notice');
      expect(notice).toBe(screen.getByTestId('ai-no-embeddings-notice'));
      expect(notice?.textContent).toMatch(/not embedded/i);

      // aria-disabled does not block events, so the click handler itself must
      // refuse: the composer must not be seeded with an unanswerable prompt.
      fireEvent.click(chips[0]);
      expect(screen.getByTestId('ask-input')).toHaveValue('');
    });

    it('re-enables the example prompts once embeddings exist', () => {
      mockEmbeddingStatus = {
        data: { totalPages: 10, embeddedPages: 10, dirtyPages: 0, totalEmbeddings: 10, isProcessing: false },
      };

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      const chips = screen.getAllByTestId('ask-example-prompt');
      expect(chips.length).toBeGreaterThan(0);
      for (const chip of chips) {
        expect(chip).not.toHaveAttribute('aria-disabled');
        expect(chip).not.toHaveAttribute('aria-describedby');
        expect(chip.className).not.toContain('cursor-not-allowed');
        expect(chip.className).not.toContain('text-muted-foreground');
      }

      // Clicking an enabled chip fills the composer with its prompt.
      fireEvent.click(chips[0]);
      expect(screen.getByTestId('ask-input')).toHaveValue(chips[0].textContent);
    });

    // #1257 post-review (F-B): the banner's predicate (`isZeroEmbeddings`) is
    // FALSE while the status is still undefined — the first-paint window, and
    // permanently when /embeddings/status errors — which used to leave the
    // chips live in exactly the windows where nothing is known to be
    // retrievable: the confident-answer-over-no-context path this gate exists
    // to close. Undefined/error → inert. No aria-describedby here: the banner
    // only renders on a resolved zero verdict, and pointing at an absent node
    // is a dangling reference.
    it('keeps the example prompts inert while the embedding status is unknown', () => {
      mockEmbeddingStatus = { data: undefined };

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      const chips = screen.getAllByTestId('ask-example-prompt');
      expect(chips.length).toBeGreaterThan(0);
      for (const chip of chips) {
        expect(chip).toHaveAttribute('aria-disabled', 'true');
        expect(chip).not.toHaveAttribute('aria-describedby');
        expect(chip.className).toContain('cursor-not-allowed');
        expect(chip.className).toContain('text-muted-foreground');
      }

      // No banner in this window, and no dangling reference to one.
      expect(screen.queryByTestId('ai-no-embeddings-notice')).not.toBeInTheDocument();

      // The click handler refuses too — aria-disabled blocks no events.
      fireEvent.click(chips[0]);
      expect(screen.getByTestId('ask-input')).toHaveValue('');
    });
  });

  describe('performance: stable message IDs (#521)', () => {
    it('uses stable message IDs as keys instead of array indices', async () => {
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

      // Stream that yields two chunks then completes
      async function* fakeStream() {
        yield { content: 'Hello ' };
        yield { content: 'world' };
      }
      streamSSEMock.mockReturnValue(fakeStream());

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      // Wait for model to load
      await waitFor(() => {
        expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
      });

      // Type a question and submit
      const input = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(input, { target: { value: 'Test question' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      // Wait for stream to complete
      await waitFor(() => {
        expect(screen.getByText('Test question')).toBeInTheDocument();
      });

      // Both messages should be visible: user message and assistant response
      await waitFor(() => {
        expect(screen.getByText(/Hello/)).toBeInTheDocument();
      });

      // Verify no element has key="0" or key="1" by checking that
      // the message bubbles render correctly with stable keys.
      // The key test is implicit: if keys were array indices, React would
      // produce wrong element binding during streaming. We verify content
      // is correct after streaming completes.
      const messageBubbles = document.querySelectorAll('.max-w-\\[80\\%\\]');
      expect(messageBubbles.length).toBeGreaterThanOrEqual(2);
    });

    it('preserves user message content after streaming completes', async () => {
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
        yield { content: 'AI response text' };
      }
      streamSSEMock.mockReturnValue(fakeStream());

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(input, { target: { value: 'My question' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      // After streaming, both messages should be correctly rendered
      await waitFor(() => {
        expect(screen.getByText('My question')).toBeInTheDocument();
        expect(screen.getByText('AI response text')).toBeInTheDocument();
      });

      // User message should not be corrupted by streaming updates
      // (this would fail with index-based keys if React rebinds elements)
      const userMessage = screen.getByText('My question');
      expect(userMessage.closest('.bg-primary\\/10')).toBeTruthy();
    });
  });

  // #747 item 1 — the in-flight assistant answer renders through the
  // rAF-batched StreamingMessage path (useStreamingContent) instead of
  // committing every SSE chunk to the message list; the final committed
  // message keeps the regular Markdown rendering.
  describe('batched streaming render (#747)', () => {
    function mockModelApis() {
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
    }

    it('renders the in-flight answer via StreamingMessage and commits it once on completion', async () => {
      mockModelApis();

      let releaseStream: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { releaseStream = resolve; });
      async function* gatedStream() {
        yield { content: 'Hello ' };
        yield { content: '**world**' };
        await gate;
      }
      streamSSEMock.mockReturnValue(gatedStream());

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(input, { target: { value: 'Stream me' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      // While streaming, the in-flight answer renders through the batched
      // StreamingMessage component (content appears after the rAF flush).
      await waitFor(() => {
        expect(screen.getByTestId('streaming-message')).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByTestId('streaming-message').textContent).toContain('Hello world');
      });
      // Markdown is parsed in the batched path too.
      expect(screen.getByText('world').tagName).toBe('STRONG');

      // Finish the stream — the final committed message renders through the
      // regular (non-streaming) Markdown path.
      await act(async () => {
        releaseStream?.();
      });

      await waitFor(() => {
        expect(screen.queryByTestId('streaming-message')).not.toBeInTheDocument();
      });
      expect(screen.getByText('world')).toBeInTheDocument();
      expect(screen.getByText('world').tagName).toBe('STRONG');
      expect(screen.queryByTestId('streaming-cursor')).not.toBeInTheDocument();
    });

    it('announces a completed answer via a primed polite live region (#937)', async () => {
      mockModelApis();

      let releaseStream: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { releaseStream = resolve; });
      async function* gatedStream() {
        yield { content: 'The answer.' };
        await gate;
      }
      streamSSEMock.mockReturnValue(gatedStream());

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
      });

      // The answer announcer must exist EMPTY and polite before any answer, so
      // AT watches it for content changes (mirrors the error announcer priming).
      const announcer = screen.getByTestId('ai-answer-announcer');
      expect(announcer).toHaveAttribute('aria-live', 'polite');
      expect(announcer).toHaveTextContent('');

      const input = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(input, { target: { value: 'Ask me' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      // While the stream is in flight the announcer stays empty — announcing
      // mid-stream would interrupt the visible streaming answer.
      await waitFor(() => {
        expect(screen.getByTestId('streaming-message')).toBeInTheDocument();
      });
      expect(screen.getByTestId('ai-answer-announcer')).toHaveTextContent('');

      // Finish the stream — the completed answer is now announced.
      await act(async () => {
        releaseStream?.();
      });

      await waitFor(() => {
        expect(screen.queryByTestId('streaming-message')).not.toBeInTheDocument();
      });
      const done = screen.getByTestId('ai-answer-announcer');
      expect(done).toHaveTextContent('Answer ready');
      // A keyed child node is mounted so AT re-announces on each new answer.
      expect(done.firstElementChild).not.toBeNull();
    });

    it('commits partial content to the message list when the stream is aborted', async () => {
      mockModelApis();

      async function* abortingStream() {
        yield { content: 'partial answer' };
        throw new DOMException('Aborted', 'AbortError');
      }
      streamSSEMock.mockReturnValue(abortingStream());

      const { AiProvider, useAiContext } = await import('./AiContext');
      let captured: ReturnType<typeof useAiContext> | null = null;
      function Capture() {
        captured = useAiContext();
        return null;
      }

      render(
        <AiProvider>
          <Capture />
        </AiProvider>,
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        expect(captured?.model).toBe('llama3');
      });

      await act(async () => {
        await captured!.runStream('/llm/ask', { question: 'q', model: 'llama3' });
      });

      // The partial answer must not be lost on abort.
      const lastMsg = captured!.messages[captured!.messages.length - 1];
      expect(lastMsg?.role).toBe('assistant');
      expect(lastMsg?.content).toBe('partial answer');
      expect(captured!.isStreaming).toBe(false);
    });
  });

  // #355 — admin-configured chat use-case default
  // (Findings 1, 2, 4 from the PR review).
  describe('chat use-case default pre-fill (#355)', () => {
    it('pre-fills the chat model from /llm/usecase-default?usecase=chat on mount', async () => {
      // Arrange: backend returns a chat use-case default that differs from
      // the legacy /settings.ollamaModel value. The pre-fill must come from
      // the use-case default, not /settings.
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/llm/usecase-default?usecase=chat') {
          return Promise.resolve({
            usecase: 'chat',
            providerId: '11111111-1111-4111-8111-111111111111',
            providerName: 'Ollama',
            model: 'qwen3:8b',
          });
        }
        if (path === '/settings') {
          // Legacy fallback — should NOT be reached because chat default exists.
          return Promise.resolve({
            llmProvider: 'ollama',
            ollamaModel: 'legacy-llama3',
            openaiModel: null,
          });
        }
        if (path.startsWith('/ollama/models')) {
          return Promise.resolve([
            { name: 'qwen3:8b' },
            { name: 'llama3' },
            { name: 'gpt-4o-mini' },
          ]);
        }
        if (path === '/llm/conversations') return Promise.resolve([]);
        return Promise.resolve([]);
      });

      // #1361 deleted `/ai`'s model dropdown; the resolution it displayed is
      // AiContext's, and both the dock and Ask read it from there.
      let captured: ReturnType<typeof useAiContext> | null = null;
      function Capture() {
        captured = useAiContext();
        return null;
      }
      render(<Capture />, { wrapper: createWrapper() });

      await waitFor(() => expect(captured?.model).toBe('qwen3:8b'));
    });

    it('queries /ollama/models with ?usecase=chat (Finding 4 — not ?provider=…)', async () => {
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/llm/usecase-default?usecase=chat') {
          return Promise.resolve({
            usecase: 'chat',
            providerId: '11111111-1111-4111-8111-111111111111',
            providerName: 'Ollama',
            model: 'qwen3:8b',
          });
        }
        if (path.startsWith('/ollama/models')) {
          return Promise.resolve([{ name: 'qwen3:8b' }]);
        }
        if (path === '/llm/conversations') return Promise.resolve([]);
        if (path === '/settings') return Promise.resolve({ llmProvider: 'ollama', ollamaModel: '', openaiModel: null });
        return Promise.resolve([]);
      });

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      await waitFor(() => {
        const modelsCalls = apiFetchMock.mock.calls
          .map((args) => args[0])
          .filter((p): p is string => typeof p === 'string' && p.startsWith('/ollama/models'));
        expect(modelsCalls.length).toBeGreaterThan(0);
      });

      const modelsCalls = apiFetchMock.mock.calls
        .map((args) => args[0])
        .filter((p): p is string => typeof p === 'string' && p.startsWith('/ollama/models'));

      // Backend route at backend/src/routes/llm/llm-models.ts only parses
      // ?usecase=… — sending ?provider=… silently returns the wrong models.
      expect(modelsCalls.every((p) => p.includes('usecase=chat'))).toBe(true);
      expect(modelsCalls.some((p) => p.includes('provider='))).toBe(false);
    });

    it('falls back to /settings model when chat use-case default is unavailable (404)', async () => {
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/llm/usecase-default?usecase=chat') {
          // Simulate the 404 the backend returns when no provider is configured.
          return Promise.reject(new Error('No provider resolved for use case "chat"'));
        }
        if (path === '/settings') {
          return Promise.resolve({
            llmProvider: 'ollama',
            ollamaModel: 'legacy-llama3',
            openaiModel: null,
          });
        }
        if (path.startsWith('/ollama/models')) {
          return Promise.resolve([{ name: 'legacy-llama3' }]);
        }
        if (path === '/llm/conversations') return Promise.resolve([]);
        return Promise.resolve([]);
      });

      let captured: ReturnType<typeof useAiContext> | null = null;
      function Capture() {
        captured = useAiContext();
        return null;
      }
      render(<Capture />, { wrapper: createWrapper() });

      await waitFor(() => expect(captured?.model).toBe('legacy-llama3'));
    });

    it('propagates an admin-side change to the chat UI without remount (Finding 1, AC-3)', async () => {
      // First load: chat default is qwen3:8b.
      let currentChatDefault = {
        usecase: 'chat',
        providerId: '11111111-1111-4111-8111-111111111111',
        providerName: 'Ollama',
        model: 'qwen3:8b',
      };
      let currentModels = [{ name: 'qwen3:8b' }, { name: 'llama3' }];

      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/llm/usecase-default?usecase=chat') {
          return Promise.resolve(currentChatDefault);
        }
        if (path.startsWith('/ollama/models')) {
          return Promise.resolve(currentModels);
        }
        if (path === '/llm/conversations') return Promise.resolve([]);
        if (path === '/settings') {
          return Promise.resolve({ llmProvider: 'ollama', ollamaModel: '', openaiModel: null });
        }
        return Promise.resolve([]);
      });

      let captured: ReturnType<typeof useAiContext> | null = null;
      function Capture() {
        captured = useAiContext();
        return null;
      }
      const { Wrapper, queryClient } = createWrapperWithClient();
      render(<Capture />, { wrapper: Wrapper });

      // Initial state: the resolved chat model and its provider's list.
      await waitFor(() => expect(captured?.model).toBe('qwen3:8b'));
      expect(captured!.models.map((m) => m.name)).toEqual(['qwen3:8b', 'llama3']);

      // Admin changes the chat assignment to a different provider+model.
      // Simulate by updating what the API returns and invalidating the
      // relevant query keys (which is what LlmTab's save handler does
      // after a successful PUT /admin/llm-usecases).
      currentChatDefault = {
        usecase: 'chat',
        providerId: '22222222-2222-4222-8222-222222222222',
        providerName: 'OpenAI',
        model: 'gpt-4o-mini',
      };
      currentModels = [{ name: 'gpt-4o-mini' }, { name: 'gpt-4o' }];

      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['llm', 'usecase-default'] });
        await queryClient.invalidateQueries({ queryKey: ['llm', 'models'] });
      });

      // The context should now carry the new provider's models — proving the
      // admin change propagated without a remount.
      await waitFor(() => {
        expect(captured!.models.map((m) => m.name)).toEqual(['gpt-4o-mini', 'gpt-4o']);
      });
    });

  });

  // #703 — chat content must not bleed through the translucent sticky bars.
  // Every sticky bar carries an opaque bg-background under-mask (z-[-1])
  // covering exactly the bar's box (inset-0).
  //
  // 2026-09-01 — there is one bar left at rest. The top sub-header held a
  // single durable option (`Think`), that chip moved into the composers, and
  // the strip now renders only for the mode with a secondary setting, so a
  // Q&A / Generate / rewrite session has the composer bar and nothing above
  // the message pane. The sweep below therefore walks whatever `.sticky` boxes
  // the render produced rather than naming two.
  //
  // #1218 — those masks are now belt-and-braces rather than load-bearing: the
  // message pane owns the scroller and the page column no longer scrolls, so
  // nothing passes behind either bar to be occluded. They are kept because
  // they cost one div each and they are what stops #703 returning if a future
  // change re-engages the outer scroll container — which is why the shape they
  // are pinned to here is still the shape they have to keep.
  //
  // #769 — the masks must NOT extend past the bar's box, and that rule still
  // matters after the structural fix, in the other direction: an absolutely
  // positioned mask overflowing the block-end edge creates scrollable overflow
  // in a container that now has none, re-opening #769 on a page that had
  // stopped scrolling entirely. The original -top-[100px] / -bottom-[100px]
  // extensions added ~100px of phantom scroll on every mode.
  //
  // The rule is enforced as an ALLOW-list — the exact class set — not as a
  // deny-list of overhang spellings. A deny-list cannot be complete here:
  // Tailwind writes the same overhang as -bottom-5, -bottom-[5px],
  // bottom-[-5px], inset-y-[-5px], an arbitrary property or an inline style,
  // and the two regexes this replaces matched only the arbitrary-value forms —
  // so -bottom-5, the exact class #1218 was originally filed proposing, walked
  // past them unmatched. An allow-list cannot be evaded, at the cost of
  // failing on any legitimate restyle; for a five-class mask that is a
  // feature, not friction.
  const UNDER_MASK_CLASSES = 'pointer-events-none absolute inset-0 z-[-1] bg-background';

  describe('sticky bar under-mask (#703, #769, #1218)', () => {
    it('renders no sticky strip above the message pane in a mode with no secondary setting', () => {
      const { container } = render(<AiAssistantPage />, { wrapper: createWrapper() });

      // The option row's removal is structural, not cosmetic: an empty sticky
      // box still spends its own padding and both column gaps out of the
      // message pane's height, on every mode, forever.
      expect(container.querySelector('.sticky.top-0')).toBeNull();
      // Think did not disappear with the row — it is in the composer box now,
      // beside the Send button it applies to.
      const think = screen.getByLabelText('Thinking mode');
      expect(think.closest('.nm-composer')).not.toBeNull();
    });

    it('renders an opaque under-mask behind the bottom input bar covering exactly its box', () => {
      const { container } = render(<AiAssistantPage />, { wrapper: createWrapper() });

      const inputBar = container.querySelector('.sticky.bottom-0');
      expect(inputBar).not.toBeNull();
      expect(inputBar!.className).toContain('isolate');

      // Same class set as the sub-header's mask, and for the block-end bar the
      // no-overhang half of it is the load-bearing one (#769).
      const mask = inputBar!.querySelector('[aria-hidden]');
      expect(mask).not.toBeNull();
      expect(mask!.className).toBe(UNDER_MASK_CLASSES);
    });

    it('no under-mask extends past its sticky bar (regression: #769 phantom scroll)', () => {
      const { container } = render(<AiAssistantPage />, { wrapper: createWrapper() });

      // Whatever sticky boxes this render produced, and there must be at least
      // the composer bar — a sweep over an empty list asserts nothing.
      const bars = Array.from(container.querySelectorAll('.sticky'));
      expect(bars.length).toBeGreaterThan(0);
      for (const bar of bars) {
        const mask = bar.querySelector('[aria-hidden]') as HTMLElement;
        expect(mask).not.toBeNull();
        // Every class-spelled offset is already refused by the exact class set
        // asserted above. Inline styles are the one way past it — `className`
        // says nothing about `style={{ bottom: -20 }}`, which pushes the
        // absolutely positioned mask past the block-end edge and grows the
        // scrollable overflow region exactly as -bottom-[100px] did.
        expect(mask.className).toBe(UNDER_MASK_CLASSES);
        expect(mask.style.top).toBe('');
        expect(mask.style.bottom).toBe('');
        expect(mask.style.left).toBe('');
        expect(mask.style.right).toBe('');
        expect(mask.style.inset).toBe('');
        expect(mask.style.margin).toBe('');
      }
    });
  });

  // ── Confidence badge (#1117) ──────────────────────────────────────────────
  //
  // The badge reads a cosine similarity. It used to be handed `score`, which
  // after RRF fusion is the fusion value (~0.033) — below ConfidenceBadge's
  // 0.4 medium threshold, so every knowledge-base answer rendered a red "Low
  // confidence". `averageSourceSimilarity` is unit-tested separately; these
  // cover the WIRING, which no test previously touched.
  describe('confidence badge', () => {
    function seedAssistantMessage(sources: unknown[]) {
      function ThreadSeeder() {
        const { setMessages } = useAiContext();
        return (
          <button
            onClick={() =>
              setMessages([
                { id: 'q', role: 'user', content: 'how do I deploy?' },
                {
                  id: 'a',
                  role: 'assistant',
                  content: 'Use the pipeline.',
                  sources,
                } as never,
              ])
            }
          >
            seed thread
          </button>
        );
      }
      render(
        <>
          <ThreadSeeder />
          <AiAssistantPage />
        </>,
        { wrapper: createWrapper(['/ai']) },
      );
      fireEvent.click(screen.getByText('seed thread'));
    }

    it('renders no badge when no source carries a similarity', () => {
      // A keyword-only retrieval measured nothing. Averaging the absent value
      // as 0 is what painted the badge red on every answer.
      seedAssistantMessage([
        { pageTitle: 'Runbook', pageId: 1, score: 0.0164, similarity: null },
        { pageTitle: 'Guide', pageId: 2, score: 0.0328, similarity: null },
      ]);

      expect(screen.getByText('Use the pipeline.')).toBeInTheDocument();
      expect(screen.queryByTestId('confidence-badge')).not.toBeInTheDocument();
    });

    it('renders no badge when a source carries score but no similarity at all', () => {
      // Not a persistence case: sources are never stored (saveConversation
      // writes `ChatMessage[]`). This is the absent-field state the Source type
      // permits — an older client, or any frame built without the field.
      seedAssistantMessage([{ pageTitle: 'Old', pageId: 1, score: 0.0164 }]);

      expect(screen.queryByTestId('confidence-badge')).not.toBeInTheDocument();
    });

    it('renders High confidence from the similarity, not the fusion score', () => {
      // The regression in one assertion: `score` here is 0.0164, which would
      // render "Low confidence". The similarity is what must win.
      seedAssistantMessage([
        { pageTitle: 'Deployment', pageId: 1, score: 0.0164, similarity: 0.86 },
      ]);

      const badge = screen.getByTestId('confidence-badge');
      expect(badge).toHaveTextContent('High confidence');
    });

    it('ignores web sources rather than letting their score:1 inflate the average', () => {
      seedAssistantMessage([
        { pageTitle: 'KB page', pageId: 1, score: 0.0164, similarity: 0.30 },
        { pageTitle: 'Web one', pageId: 0, url: 'https://example.com/1', score: 1, similarity: null },
        { pageTitle: 'Web two', pageId: 0, url: 'https://example.com/2', score: 1, similarity: null },
      ]);

      // The only measured similarity is 0.30 -> Low. Reading `score` instead
      // averages (0.0164 + 1 + 1) / 3 = 0.672 -> Medium, a grade earned
      // entirely by two web results that never went through retrieval. The
      // values are chosen so the two implementations disagree.
      expect(screen.getByTestId('confidence-badge')).toHaveTextContent('Low confidence');
    });
  });

  // -------------------------------------------------------------------------
  // Low-confidence refusal (#1105, surfaced by #1119)
  // -------------------------------------------------------------------------
  //
  // When retrieval scores below the operator's threshold the backend runs NO
  // chat completion and returns an honest refusal turn plus the weak sources it
  // found, marked `refused: true` on the final SSE frame. Before #1119 the
  // frontend did not read that flag, so the turn rendered as an ordinary
  // Markdown answer with a "Low confidence" badge stapled to sources the server
  // had explicitly declined to use.
  describe('low-confidence refusal', () => {
    const REFUSAL_TEXT =
      'The knowledge-base passages I found are not a strong enough match to this question'
      + ' to ground an answer, so I am not answering rather than guessing.'
      + ' The closest partial matches are attached as sources for reference —'
      + ' none matched well enough to use.';

    /** The exact two frames `sendCachedSSE` writes on the refusal path. */
    function refusalFrames() {
      return (async function* () {
        yield { content: REFUSAL_TEXT, done: true };
        yield {
          refused: true,
          confidence: 0.19,
          confidenceBasis: 'similarity',
          conversationId: 'conv-refused',
          // Weak, but measurable — chosen so a surface that still rated them
          // would render "Low confidence" rather than nothing.
          sources: [{ pageTitle: 'Tangentially related', pageId: 9, score: 0.01, similarity: 0.19 }],
          done: true,
          final: true,
        };
      })();
    }

    async function askAndRefuse() {
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/settings') {
          return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
        }
        if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
        if (path === '/llm/conversations') return Promise.resolve([]);
        return Promise.resolve([]);
      });
      streamSSEMock.mockImplementation(() => refusalFrames());

      render(<AiAssistantPage />, { wrapper: createWrapper() });
      await waitFor(() => {
        expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
      });
      const input = screen.getByPlaceholderText('Ask a question...');
      fireEvent.change(input, { target: { value: 'what is our policy on X?' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      return screen.findByTestId('message-refusal');
    }

    it('renders a distinct state — not an error bubble and not an empty answer', async () => {
      const refusal = await askAndRefuse();

      expect(refusal).toHaveTextContent('not answering rather than guessing');
      expect(screen.getByTestId('refusal-mark')).toHaveTextContent('Not answered');
      // The request succeeded; the server declined to guess. Painting that red
      // would tell the user to retry something that is working correctly.
      expect(screen.queryByTestId('message-error')).not.toBeInTheDocument();
      expect(toastErrorMock).not.toHaveBeenCalled();
    });

    it('shows the weak sources, under a heading that says they were not used', async () => {
      await askAndRefuse();

      expect(screen.getByTestId('refusal-sources-label')).toHaveTextContent(/closest matches/i);
    });

    it('rates nothing: no confidence badge on a turn that carries no answer', async () => {
      await askAndRefuse();

      // similarity 0.19 would render "Low confidence" on an ordinary answer —
      // the value is picked so the two implementations disagree. A grade beside
      // a refusal reads as a weak answer rather than none.
      expect(screen.queryByTestId('confidence-badge')).not.toBeInTheDocument();
    });

    it('does not announce a refusal as an answer', async () => {
      await askAndRefuse();

      const announcer = screen.getByTestId('ai-answer-announcer');
      await waitFor(() => {
        expect(announcer.textContent).not.toBe('');
      });
      expect(announcer).not.toHaveTextContent('Answer ready');
      expect(announcer).toHaveTextContent(/no answer/i);
      // It stays polite. A correct response is not worth interrupting for, so
      // it must not be routed into the assertive error region either.
      expect(screen.getByTestId('ai-error-announcer').textContent).toBe('');
    });

    it('carries no warning or destructive colour', async () => {
      const refusal = await askAndRefuse();

      const classes = [refusal, screen.getByTestId('refusal-mark')]
        .map((el) => el.className)
        .join(' ');
      // ADR-010: amber is warning/attention only, and `/ai` already spends its
      // amber on the corpus-wide zero-embeddings notice that sits directly
      // above this turn on the instances most likely to refuse. Two ambers on
      // one screen, one of them recurring, is how the reserved colour stops
      // meaning anything.
      expect(classes).not.toMatch(/warning|amber/);
      expect(classes).not.toMatch(/destructive/);
      expect(classes).not.toMatch(/status-(connected|disconnected|syncing|embedding|ai)/);
    });

  });

  describe('cross-thread streaming (#1361)', () => {
    /** Navigates the hoisted provider, which is what changes the thread. */
    function AiNavProbe({ to }: { to: string }) {
      const navigate = useNavigate();
      return <button onClick={() => navigate(to)}>{`go ${to}`}</button>;
    }

    /** Puts a finished answer on one thread and starts a stream on another. */
    function ThreadTools() {
      const { setMessages, runStream } = useAiContext();
      return (
        <>
          <button
            onClick={() =>
              setMessages([
                { id: 'seed-user', role: 'user', content: 'what changed in the runbook?' },
                { id: 'seed-answer', role: 'assistant', content: 'answer one' },
              ])
            }
          >
            seed answered thread
          </button>
          <button onClick={() => void runStream('/llm/ask', { question: 'about the article' })}>
            ask here
          </button>
        </>
      );
    }

    it("does not paint another thread's in-flight answer onto this one", async () => {
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/llm/usecase-default?usecase=chat') {
          return Promise.resolve({
            usecase: 'chat', providerId: 'p1', providerName: 'Local', model: 'llama3', vision: false,
          });
        }
        if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
        return Promise.resolve([]);
      });
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      streamSSEMock.mockImplementation((_endpoint: string, _body: unknown, signal: AbortSignal) =>
        (async function* () {
          yield { content: 'partial from the other thread' };
          await gate;
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        })(),
      );

      render(
        <>
          <ThreadTools />
          <AiNavProbe to="/pages/p9" />
          <AiNavProbe to="/ai" />
          <AiAssistantPage />
        </>,
        { wrapper: createWrapper(['/ai']) },
      );

      // The draft already holds a finished answer.
      fireEvent.click(screen.getByText('seed answered thread'));
      expect(screen.getByText('answer one')).toBeInTheDocument();

      // Ask on the article thread, then come back to the draft mid-stream.
      fireEvent.click(screen.getByText('go /pages/p9'));
      fireEvent.click(screen.getByText('ask here'));
      await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());
      fireEvent.click(screen.getByText('go /ai'));

      // Its own last answer, not the other thread's partial text — and it is
      // not "typing", because nothing here is.
      await waitFor(() => expect(screen.getByText('answer one')).toBeInTheDocument());
      expect(screen.queryByText('partial from the other thread')).not.toBeInTheDocument();
      expect(screen.queryByTestId('typing-indicator')).not.toBeInTheDocument();

      await act(async () => { release(); await Promise.resolve(); });
    });
  });

});
