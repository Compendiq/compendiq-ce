import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
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

  // #1126: /ai is the no-document home for Ask and Generate. Improve,
  // Summarize, Diagram and Quality act on an open document and moved to the
  // dock as chips — offering them here too would be two surfaces for one job
  // on a route that cannot show you the document they operate on.
  it('offers Q&A and Generate, and no document-mode tabs', () => {
    render(<AiAssistantPage />, { wrapper: createWrapper() });
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['Q&A', 'Generate']);
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

  it('does not render a conversations sidebar', () => {
    render(<AiAssistantPage />, { wrapper: createWrapper() });
    expect(screen.queryByText('Conversations')).not.toBeInTheDocument();
    expect(screen.queryByTitle('New conversation')).not.toBeInTheDocument();
  });

  it('renders empty state message for Q&A mode', () => {
    render(<AiAssistantPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Ask questions about your knowledge base')).toBeInTheDocument();
  });

  it('shows "Loading models..." when models have not loaded yet', () => {
    render(<AiAssistantPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Loading models...')).toBeInTheDocument();
  });

  it('shows model selector after models load', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/settings') {
        return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
      }
      if (path.startsWith('/ollama/models')) {
        return Promise.resolve([{ name: 'llama3' }, { name: 'qwen3:latest' }]);
      }
      if (path === '/llm/conversations') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    render(<AiAssistantPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
    });
  });

  describe('models error chip (degraded LLM provider)', () => {
    it('shows "Models unavailable — retry" instead of the loading spinner when the models fetch fails', async () => {
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/settings') {
          return Promise.resolve({ llmProvider: 'ollama', ollamaModel: '', openaiModel: null });
        }
        if (path.startsWith('/ollama/models')) {
          return Promise.reject(new Error('LLM provider unreachable'));
        }
        if (path === '/llm/conversations') {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Models unavailable — retry')).toBeInTheDocument();
      });
      // The infinite spinner must not keep rendering once the fetch has failed.
      expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
    });

    it('refetches models when the retry chip is clicked and recovers to the dropdown', async () => {
      let modelsDown = true;
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/settings') {
          return Promise.resolve({ llmProvider: 'ollama', ollamaModel: '', openaiModel: null });
        }
        if (path.startsWith('/ollama/models')) {
          return modelsDown
            ? Promise.reject(new Error('LLM provider unreachable'))
            : Promise.resolve([{ name: 'llama3' }]);
        }
        if (path === '/llm/conversations') {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Models unavailable — retry')).toBeInTheDocument();
      });

      const modelsCalls = () => apiFetchMock.mock.calls
        .map((args) => args[0])
        .filter((p): p is string => typeof p === 'string' && p.startsWith('/ollama/models'))
        .length;
      const callsBefore = modelsCalls();

      // Provider comes back up; clicking the chip must fire another fetch.
      modelsDown = false;
      fireEvent.click(screen.getByText('Models unavailable — retry'));

      await waitFor(() => {
        expect(modelsCalls()).toBeGreaterThan(callsBefore);
      });

      // Recovered: the chip is replaced by the model dropdown.
      await waitFor(() => {
        expect(document.querySelector('select')).not.toBeNull();
      });
      expect(screen.queryByText('Models unavailable — retry')).not.toBeInTheDocument();
      expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
    });
  });

  describe('improve mode', () => {
    // #1126: Improve is no longer a tab on /ai — it is a chip in the dock. The
    // screen still renders for `?mode=improve` deep links, which is how these
    // reach it now instead of clicking a tab that no longer exists.
    it('shows "Navigate to a page" message when no page is selected', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve']) });

      expect(screen.getByText(/Navigate to a page/)).toBeInTheDocument();
    });

    it('disables improve button when no page is selected', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve']) });

      // The action button should be disabled (no page and no model)
      const buttons = screen.getAllByRole('button');
      const improveBtn = buttons.find((b) => b.textContent?.includes('Loading models'));
      expect(improveBtn).toBeDisabled();
    });

    it('disables improve button when model is not loaded yet', () => {
      mockPageData = {
        data: { id: 'p1', title: 'Test Page', bodyHtml: '<p>Hello</p>', bodyText: 'Hello' },
      };

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve&pageId=p1']) });

      // Mode should be 'improve' since pageId is provided
      // Button should show "Loading models..." and be disabled
      const buttons = screen.getAllByRole('button');
      const loadingBtn = buttons.find((b) => b.textContent?.includes('Loading models'));
      expect(loadingBtn).toBeDefined();
      expect(loadingBtn).toBeDisabled();
    });

    it('shows toast error when improve is called without a model', async () => {
      mockPageData = {
        data: { id: 'p1', title: 'Test Page', bodyHtml: '<p>Hello</p>', bodyText: 'Hello' },
      };

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve&pageId=p1']) });

      // The button is disabled when !model, so we test the handler directly
      // by forcing a click via the button (which is disabled, so we simulate the handler)
      // Actually let's verify the button IS disabled
      const buttons = screen.getAllByRole('button');
      const actionBtn = buttons.find((b) => b.textContent?.includes('Loading models'));
      expect(actionBtn).toBeDisabled();
    });

    it('shows ready state with page title when page is loaded and model available', async () => {
      mockPageData = {
        data: { id: 'p1', title: 'My Article', bodyHtml: '<p>Content</p>', bodyText: 'Content' },
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

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve&pageId=p1']) });

      await waitFor(() => {
        expect(screen.getByText('Ready to improve: My Article')).toBeInTheDocument();
      });
    });

    it('shows "Loading page..." when page data is still being fetched', () => {
      mockPageData = { data: undefined, isLoading: true };

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

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve&pageId=p1']) });

      // Button should show "Loading page..." and be disabled
      const buttons = screen.getAllByRole('button');
      const loadingBtn = buttons.find((b) => b.textContent?.includes('Loading page'));
      expect(loadingBtn).toBeDefined();
      expect(loadingBtn).toBeDisabled();
    });

    // #1126: `?mode=improve` no longer selects a tab — there isn't one — but it
    // must still reach the Improve screen, which is what keeps pre-existing
    // deep links and bookmarks working.
    it('reads mode from the URL query param even without a tab for it', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve']) });

      expect(screen.getByText(/Navigate to a page/)).toBeInTheDocument();
      expect(screen.queryByRole('tab', { selected: true })).toBeNull();
    });

    // WCAG 2.1.1. A roving-tabindex tablist whose selected tab is absent gives
    // every tab tabIndex={-1}, leaving no keyboard entry point at all: someone
    // following an old bookmark could not reach Q&A or Generate without editing
    // the URL. Mouse users click and recover; keyboard users were stranded.
    it('keeps a keyboard tab stop when the active mode has no tab', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve']) });

      const tabs = screen.getAllByRole('tab');
      expect(tabs[0]).toHaveAttribute('tabindex', '0');
    });

    it('recovers to a real tab when arrowing from a mode that has none', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve']) });

      fireEvent.keyDown(screen.getByTestId('ai-mode-tablist'), { key: 'ArrowRight' });

      expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('Q&A');
    });

    it('explains where the mode went instead of leaving the tablist looking broken', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve']) });

      const notice = screen.getByTestId('ai-legacy-mode-notice');
      expect(notice).toBeInTheDocument();

      // The notice sends the reader to a keyboard shortcut, and `ShortcutHint`
      // renders NOTHING for a registry id it cannot find. #1176 renamed this one
      // (`ai-improve` → `ai-assistant`), so asserting only that the notice
      // exists would still pass with the badge silently blank — the sentence
      // would tell the user to "press" nothing at all. Assert the key reached
      // the screen. Alt prints as "Alt" off macOS and ⌥ on it, and `isMac()`
      // reads a real navigator here.
      expect(within(notice).getByText(/(Alt\+|⌥)I/)).toBeInTheDocument();
    });

    it('enables improve button when page is loaded and model is available', async () => {
      mockPageData = {
        data: { id: 'p1', title: 'My Article', bodyHtml: '<p>Content</p>', bodyText: 'Content' },
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

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve&pageId=p1']) });

      await waitFor(() => {
        const buttons = screen.getAllByRole('button');
        const improveBtn = buttons.find((b) => b.textContent?.includes('Improve Page'));
        expect(improveBtn).toBeDefined();
        expect(improveBtn).not.toBeDisabled();
      });
    });

    it('calls streamSSE with correct parameters when improve is triggered', async () => {
      mockPageData = {
        data: { id: 'p1', title: 'My Article', bodyHtml: '<p>Content</p>', bodyText: 'Content' },
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

      // Mock SSE to return an empty generator (just completes immediately)
      async function* fakeStream() {
        // empty - no chunks
      }
      streamSSEMock.mockReturnValue(fakeStream());

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve&pageId=p1']) });

      // Wait for models to load and button to be enabled
      await waitFor(() => {
        const buttons = screen.getAllByRole('button');
        const improveBtn = buttons.find((b) => b.textContent?.includes('Improve Page'));
        expect(improveBtn).not.toBeDisabled();
      });

      // Click improve
      const buttons = screen.getAllByRole('button');
      const improveBtn = buttons.find((b) => b.textContent?.includes('Improve Page'))!;
      fireEvent.click(improveBtn);

      // Should show the user message indicating the improve request was initiated
      await waitFor(() => {
        expect(screen.getByText(/Improve \(grammar\): My Article/)).toBeInTheDocument();
      });

      // Verify streamSSE was called with correct parameters
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/improve',
        expect.objectContaining({
          content: '<p>Content</p>',
          type: 'grammar',
          model: 'llama3',
          pageId: 'p1',
        }),
        expect.any(Object), // AbortSignal
      );
    });

    it('shows error toast when SSE stream fails during improve', async () => {
      mockPageData = {
        data: { id: 'p1', title: 'My Article', bodyHtml: '<p>Content</p>', bodyText: 'Content' },
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

      // Mock SSE to throw an error
      async function* fakeErrorStream() {
        yield { content: 'partial...' };
        throw new Error('LLM server connection lost');
      }
      streamSSEMock.mockReturnValue(fakeErrorStream());

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve&pageId=p1']) });

      await waitFor(() => {
        const buttons = screen.getAllByRole('button');
        const improveBtn = buttons.find((b) => b.textContent?.includes('Improve Page'));
        expect(improveBtn).not.toBeDisabled();
      });

      const buttons = screen.getAllByRole('button');
      const improveBtn = buttons.find((b) => b.textContent?.includes('Improve Page'))!;
      fireEvent.click(improveBtn);

      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith('LLM server connection lost');
      });
    });

    it('calls apiFetch POST /llm/improvements/apply when Accept is clicked after improvement', async () => {
      mockPageData = {
        data: { id: 'p1', title: 'My Article', bodyHtml: '<p>Content</p>', bodyText: 'Content', version: 3 },
      };

      apiFetchMock.mockImplementation((path: string, opts?: RequestInit) => {
        if (path === '/settings') {
          return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
        }
        if (path.startsWith('/ollama/models')) {
          return Promise.resolve([{ name: 'llama3' }]);
        }
        if (path === '/llm/conversations') {
          return Promise.resolve([]);
        }
        if (path === '/llm/improvements/apply' && (opts as RequestInit)?.method === 'POST') {
          return Promise.resolve({ id: 'p1', title: 'My Article', version: 4 });
        }
        return Promise.resolve([]);
      });

      // SSE stream yields improved content and completes
      async function* fakeImproveStream() {
        yield { content: '## Improved heading\n\nBetter content.' };
      }
      streamSSEMock.mockReturnValue(fakeImproveStream());

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve&pageId=p1']) });

      // Wait for models to load and button to be enabled
      await waitFor(() => {
        const btns = screen.getAllByRole('button');
        const improveBtn = btns.find((b) => b.textContent?.includes('Improve Page'));
        expect(improveBtn).not.toBeDisabled();
      });

      // Trigger improve
      const btns = screen.getAllByRole('button');
      const improveBtn = btns.find((b) => b.textContent?.includes('Improve Page'))!;
      fireEvent.click(improveBtn);

      // Wait for Accept button to appear in the DiffView
      await waitFor(() => {
        expect(screen.getByText('Accept')).toBeInTheDocument();
      });

      // Click Accept
      fireEvent.click(screen.getByText('Accept'));

      // Verify the POST to apply endpoint was made with correct payload
      await waitFor(() => {
        const applyCall = apiFetchMock.mock.calls.find(
          (args: unknown[]) =>
            args[0] === '/llm/improvements/apply' && (args[1] as RequestInit | undefined)?.method === 'POST',
        );
        expect(applyCall).toBeDefined();
        const body = JSON.parse((applyCall![1] as RequestInit).body as string);
        expect(body.pageId).toBe('p1');
        expect(body.improvedMarkdown).toBe('## Improved heading\n\nBetter content.');
        expect(body.version).toBe(3);
        expect(body.title).toBe('My Article');
      });

      // Verify success toast
      await waitFor(() => {
        expect(toastSuccessMock).toHaveBeenCalledWith('Page updated and synced to Confluence');
      });
    });

    it('shows error toast when apply improvement API call fails', async () => {
      mockPageData = {
        data: { id: 'p1', title: 'My Article', bodyHtml: '<p>Content</p>', bodyText: 'Content', version: 3 },
      };

      apiFetchMock.mockImplementation((path: string, opts?: RequestInit) => {
        if (path === '/settings') {
          return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
        }
        if (path.startsWith('/ollama/models')) {
          return Promise.resolve([{ name: 'llama3' }]);
        }
        if (path === '/llm/conversations') {
          return Promise.resolve([]);
        }
        if (path === '/llm/improvements/apply' && (opts as RequestInit)?.method === 'POST') {
          return Promise.reject(new Error('Confluence sync failed'));
        }
        return Promise.resolve([]);
      });

      async function* fakeImproveStream() {
        yield { content: '## Improved' };
      }
      streamSSEMock.mockReturnValue(fakeImproveStream());

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve&pageId=p1']) });

      await waitFor(() => {
        const btns = screen.getAllByRole('button');
        const improveBtn = btns.find((b) => b.textContent?.includes('Improve Page'));
        expect(improveBtn).not.toBeDisabled();
      });

      const btns = screen.getAllByRole('button');
      const improveBtn = btns.find((b) => b.textContent?.includes('Improve Page'))!;
      fireEvent.click(improveBtn);

      await waitFor(() => {
        expect(screen.getByText('Accept')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Accept'));

      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith('Confluence sync failed');
      });
    });
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

  describe('diagram mode - Use in page', () => {
    it('shows "Use in page" button after diagram generation when page is selected', async () => {
      mockPageData = {
        data: { id: 'p1', title: 'My Article', bodyHtml: '<p>Content</p>', bodyText: 'Content', version: 3 },
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

      // Mock SSE to return diagram code
      async function* fakeDiagramStream() {
        yield { content: 'graph TD\n  A --> B' };
      }
      streamSSEMock.mockReturnValue(fakeDiagramStream());

      // #1126: Diagram is a dock chip now, so the screen is reached by URL.
      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=diagram&pageId=p1']) });

      // Wait for models to load
      await waitFor(() => {
        const buttons = screen.getAllByRole('button');
        const diagramBtn = buttons.find((b) => b.textContent?.includes('Generate Diagram'));
        expect(diagramBtn).not.toBeDisabled();
      });

      // Click generate
      const buttons = screen.getAllByRole('button');
      const diagramBtn = buttons.find((b) => b.textContent?.includes('Generate Diagram'))!;
      fireEvent.click(diagramBtn);

      // Wait for stream to complete and button to appear
      await waitFor(() => {
        expect(screen.getByText('Use in page')).toBeInTheDocument();
      });
    });

    it('does not show "Use in page" button when no page is selected', async () => {
      mockPageData = { data: undefined };

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

      // #1126: Diagram is a dock chip now, so the screen is reached by URL.
      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=diagram']) });

      // The button should not appear (no page context)
      expect(screen.queryByText('Use in page')).not.toBeInTheDocument();
    });

    it('calls apiFetch with PUT when "Use in page" is clicked in diagram mode', async () => {
      mockPageData = {
        data: { id: 'p1', title: 'My Article', bodyHtml: '<p>Content</p>', bodyText: 'Content', version: 3 },
      };

      apiFetchMock.mockImplementation((path: string, opts?: RequestInit) => {
        if (path === '/settings') {
          return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
        }
        if (path.startsWith('/ollama/models')) {
          return Promise.resolve([{ name: 'llama3' }]);
        }
        if (path === '/llm/conversations') {
          return Promise.resolve([]);
        }
        if (path === '/pages/p1' && opts?.method === 'PUT') {
          return Promise.resolve({ id: 'p1', title: 'My Article', version: 4 });
        }
        return Promise.resolve([]);
      });

      async function* fakeDiagramStream() {
        yield { content: 'graph TD\n  A --> B' };
      }
      streamSSEMock.mockReturnValue(fakeDiagramStream());

      // #1126: Diagram is a dock chip now, so the screen is reached by URL.
      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=diagram&pageId=p1']) });

      // Wait for models to load
      await waitFor(() => {
        const btns = screen.getAllByRole('button');
        const diagramBtn = btns.find((b) => b.textContent?.includes('Generate Diagram'));
        expect(diagramBtn).not.toBeDisabled();
      });

      // Click generate
      const btns = screen.getAllByRole('button');
      const diagramBtn = btns.find((b) => b.textContent?.includes('Generate Diagram'))!;
      fireEvent.click(diagramBtn);

      // Wait for "Use in page" button
      await waitFor(() => {
        expect(screen.getByText('Use in page')).toBeInTheDocument();
      });

      // Click "Use in page"
      fireEvent.click(screen.getByText('Use in page'));

      // Verify the PUT call was made
      await waitFor(() => {
        const putCall = apiFetchMock.mock.calls.find(
          (args: unknown[]) =>
            args[0] === '/pages/p1' && (args[1] as RequestInit | undefined)?.method === 'PUT',
        );
        expect(putCall).toBeDefined();
        const body = JSON.parse((putCall![1] as RequestInit)?.body as string);
        expect(body.title).toBe('My Article');
        expect(body.version).toBe(3);
        expect(body.bodyHtml).toContain('<pre><code class="language-mermaid">');
        expect(body.bodyHtml).toContain('graph TD');
      });

      // Verify success toast
      await waitFor(() => {
        expect(toastSuccessMock).toHaveBeenCalledWith('Diagram inserted into page');
      });
    });
  });

  describe('sub-pages toggle', () => {
    it('does not show toggle when no page is selected', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper() });
      expect(screen.queryByText('+ Sub-pages')).not.toBeInTheDocument();
    });

    it('does not show toggle when page has no children', () => {
      mockPageData = {
        data: { id: 'p1', title: 'Test Page', bodyHtml: '<p>Content</p>', bodyText: 'Content', hasChildren: false },
      };

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve&pageId=p1']) });

      // The page-context chip that used to render the bare title is gone
      // (#1126); the mode's own empty state still names the resolved page.
      expect(screen.getByText('Ready to improve: Test Page')).toBeInTheDocument();
      expect(screen.queryByText('+ Sub-pages')).not.toBeInTheDocument();
    });

    it('shows toggle when page has children', () => {
      mockPageData = {
        data: { id: 'p1', title: 'Parent Page', bodyHtml: '<p>Content</p>', bodyText: 'Content', hasChildren: true },
      };

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve&pageId=p1']) });

      expect(screen.getByText('+ Sub-pages')).toBeInTheDocument();
    });

    it('toggles the checkbox when clicked', () => {
      mockPageData = {
        data: { id: 'p1', title: 'Parent Page', bodyHtml: '<p>Content</p>', bodyText: 'Content', hasChildren: true },
      };

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve&pageId=p1']) });

      const checkbox = screen.getByRole('checkbox', { name: 'Include sub-pages' });
      expect(checkbox).not.toBeChecked();

      fireEvent.click(checkbox);
      expect(checkbox).toBeChecked();

      fireEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();
    });

    it('passes includeSubPages to improve SSE when toggle is on', async () => {
      mockPageData = {
        data: { id: 'p1', title: 'Parent Page', bodyHtml: '<p>Content</p>', bodyText: 'Content', hasChildren: true },
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
        yield { content: 'improved' };
      }
      streamSSEMock.mockReturnValue(fakeStream());

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve&pageId=p1']) });

      // Enable sub-pages toggle
      const checkbox = screen.getByRole('checkbox', { name: 'Include sub-pages' });
      fireEvent.click(checkbox);

      // Wait for models to load
      await waitFor(() => {
        const btns = screen.getAllByRole('button');
        const improveBtn = btns.find((b) => b.textContent?.includes('Improve Page'));
        expect(improveBtn).not.toBeDisabled();
      });

      // Click improve
      const buttons = screen.getAllByRole('button');
      const improveBtn = buttons.find((b) => b.textContent?.includes('Improve Page'))!;
      fireEvent.click(improveBtn);

      await waitFor(() => {
        expect(streamSSEMock).toHaveBeenCalledWith(
          '/llm/improve',
          expect.objectContaining({
            includeSubPages: true,
            pageId: 'p1',
          }),
          expect.any(Object),
        );
      });
    });

    it('passes includeSubPages=false when toggle is off', async () => {
      mockPageData = {
        data: { id: 'p1', title: 'Parent Page', bodyHtml: '<p>Content</p>', bodyText: 'Content', hasChildren: true },
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
        yield { content: 'improved' };
      }
      streamSSEMock.mockReturnValue(fakeStream());

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve&pageId=p1']) });

      // Do NOT enable sub-pages toggle

      await waitFor(() => {
        const btns = screen.getAllByRole('button');
        const improveBtn = btns.find((b) => b.textContent?.includes('Improve Page'));
        expect(improveBtn).not.toBeDisabled();
      });

      const buttons = screen.getAllByRole('button');
      const improveBtn = buttons.find((b) => b.textContent?.includes('Improve Page'))!;
      fireEvent.click(improveBtn);

      await waitFor(() => {
        expect(streamSSEMock).toHaveBeenCalledWith(
          '/llm/improve',
          expect.objectContaining({
            includeSubPages: false,
            pageId: 'p1',
          }),
          expect.any(Object),
        );
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
    it('names the page the answers are scoped to, and lets it be cleared', () => {
      mockPageData = {
        data: { id: 'p1', title: 'My Article', bodyHtml: '<p>Content</p>', bodyText: 'Content' },
      };

      render(<AiAssistantPage />, {
        wrapper: createWrapper(['/ai?pageId=p1']),
      });

      const chip = screen.getByTestId('ai-context-chip');
      expect(chip.tagName).toBe('BUTTON');
      expect(chip).toHaveTextContent('My Article');

      fireEvent.click(chip);

      // `usePage` is mocked here and ignores the id, so the chip itself cannot
      // disappear; what the click has to do is drop the scoping param that
      // AskMode sends to /llm/ask.
      expect(screen.getByTestId('ai-location')).toHaveTextContent('/ai');
      expect(screen.getByTestId('ai-location')).not.toHaveTextContent('pageId');
    });

    it('starts fresh conversation when mounted with different pageId', () => {
      // Mount with p1
      mockPageData = {
        data: { id: 'p1', title: 'First Article', bodyHtml: '<p>Content</p>', bodyText: 'Content' },
      };

      const { unmount } = render(<AiAssistantPage />, {
        wrapper: createWrapper(['/ai?mode=improve&pageId=p1']),
      });

      expect(screen.getByText('Ready to improve: First Article')).toBeInTheDocument();
      unmount();

      // Re-mount with p2 — should show fresh state with new page context
      mockPageData = {
        data: { id: 'p2', title: 'Second Article', bodyHtml: '<p>Other</p>', bodyText: 'Other' },
      };

      render(<AiAssistantPage />, {
        wrapper: createWrapper(['/ai?mode=improve&pageId=p2']),
      });

      // New page resolved, no stale state from p1. Asserted through the mode's
      // empty state rather than the deleted context chip (#1126).
      expect(screen.getByText('Ready to improve: Second Article')).toBeInTheDocument();
      expect(screen.queryByText('Ready to improve: First Article')).not.toBeInTheDocument();
    });

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

    // #1126: this used to default to Improve. With Improve gone from the
    // tablist that would strand the user in a mode they can leave but never
    // return to. A page context is still an input to Ask, so Ask is the
    // default; only an explicit ?mode= reaches a document screen.
    it('defaults to Q&A when a pageId is present but no mode is given', () => {
      mockPageData = {
        data: { id: 'p1', title: 'My Article', bodyHtml: '<p>Content</p>', bodyText: 'Content' },
      };

      render(<AiAssistantPage />, {
        wrapper: createWrapper(['/ai?pageId=p1']),
      });

      expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('Q&A');
      expect(screen.getByText('Ask questions about your knowledge base')).toBeInTheDocument();
    });
  });

  describe('empty state messages', () => {
    it('shows only the correct empty state for improve mode without spurious messages', () => {
      // #1126: reached by URL now that Improve is a dock chip, not a tab.
      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve']) });

      // Should show improve-specific message
      expect(screen.getByText('Select a page and improvement type')).toBeInTheDocument();
      expect(screen.getByText(/Navigate to a page/)).toBeInTheDocument();

      // Should NOT show Q&A message
      expect(screen.queryByText('Ask questions about your knowledge base')).not.toBeInTheDocument();
      // Should NOT show "Open a page first" from other modes bleeding through
      expect(screen.queryByText('AI will create a full page based on your prompt')).not.toBeInTheDocument();
    });

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
    // jsdom does not implement scrollIntoView, and the tablist's arrow-key
    // handler calls it. Stub for this block only and put the prototype back —
    // assigning without restoring would leak into every later test in the file.
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    let scrollIntoViewMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      scrollIntoViewMock = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoViewMock;
    });

    afterEach(() => {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    });

    // At 390px the six-mode row cut off after "Summar…", leaving Diagram and
    // Quality unreachable with no scroll cue. The row is two tabs since #1126
    // and no longer overflows, but the scroll affordance stays: it is what
    // stops a future tab from being silently unreachable again.
    it('lets the mode row scroll horizontally instead of clipping', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper() });

      const tablist = screen.getByTestId('ai-mode-tablist');
      expect(tablist.className).toContain('overflow-x-auto');
      expect(tablist.className).toContain('max-w-full');
      expect(tablist.className).not.toContain('overflow-hidden');
    });

    it('keeps every offered mode present in the tablist', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper() });

      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(2);
      for (const tab of tabs) {
        // shrink-0 stops the flex row squashing tabs into unreadable slivers
        // instead of scrolling.
        expect(tab.className).toContain('shrink-0');
      }
    });

    it('moves focus with the selection when arrowing through modes', () => {
      // The tabs use a roving tabindex, so selecting a tab without focusing it
      // leaves focus on one that just became tabIndex={-1}. Once the row
      // scrolls on a narrow viewport, that stranded tab is also off-screen —
      // the highlighted tab and the focused tab were different tabs.
      render(<AiAssistantPage />, { wrapper: createWrapper() });

      const tabs = screen.getAllByRole('tab');
      const first = tabs[0]!;
      first.focus();
      expect(document.activeElement).toBe(first);

      fireEvent.keyDown(screen.getByTestId('ai-mode-tablist'), { key: 'ArrowRight' });

      const second = screen.getAllByRole('tab')[1]!;
      expect(second).toHaveAttribute('aria-selected', 'true');
      expect(document.activeElement).toBe(second);
      // Focus is the only tab reachable by Tab; the old one steps aside.
      expect(second).toHaveAttribute('tabindex', '0');
      expect(screen.getAllByRole('tab')[0]!).toHaveAttribute('tabindex', '-1');
      expect(scrollIntoViewMock).toHaveBeenCalled();
    });

    it('wraps focus round the ends of the mode row', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper() });

      const tablist = screen.getByTestId('ai-mode-tablist');
      // ArrowLeft from the first tab wraps to the last, which is the tab most
      // likely to be off-screen at 390px.
      fireEvent.keyDown(tablist, { key: 'ArrowLeft' });

      const tabs = screen.getAllByRole('tab');
      expect(document.activeElement).toBe(tabs[tabs.length - 1]);
    });

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
    it('pre-fills the model selector from /llm/usecase-default?usecase=chat on mount', async () => {
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

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      // Wait for the model dropdown to render (i.e. models loaded).
      await waitFor(() => {
        expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
      });

      const select = document.querySelector('select') as HTMLSelectElement | null;
      expect(select).not.toBeNull();
      expect(select!.value).toBe('qwen3:8b');
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

      render(<AiAssistantPage />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
      });

      const select = document.querySelector('select') as HTMLSelectElement | null;
      expect(select).not.toBeNull();
      expect(select!.value).toBe('legacy-llama3');
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

      const { Wrapper, queryClient } = createWrapperWithClient();
      render(<AiAssistantPage />, { wrapper: Wrapper });

      // Initial state: dropdown shows qwen3:8b.
      await waitFor(() => {
        const select = document.querySelector('select') as HTMLSelectElement | null;
        expect(select?.value).toBe('qwen3:8b');
      });

      // Verify dropdown options reflect the initial models list.
      const initialOptions = Array.from(document.querySelectorAll('select option')).map(
        (o) => o.textContent,
      );
      expect(initialOptions).toEqual(['qwen3:8b', 'llama3']);

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

      // Models dropdown should now reflect the new provider's models —
      // proving the admin change propagated without a remount.
      await waitFor(() => {
        const opts = Array.from(document.querySelectorAll('select option')).map(
          (o) => o.textContent,
        );
        expect(opts).toEqual(['gpt-4o-mini', 'gpt-4o']);
      });
    });

    it('startNewConversation resets model to the current chat default (Finding 2, AC-4)', async () => {
      apiFetchMock.mockImplementation((path: string, opts?: RequestInit) => {
        if (path === '/llm/usecase-default?usecase=chat') {
          return Promise.resolve({
            usecase: 'chat',
            providerId: '11111111-1111-4111-8111-111111111111',
            providerName: 'Ollama',
            model: 'qwen3:8b',
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
        if (path === '/llm/conversations/conv-1' && (!opts || !opts.method)) {
          // Loading an old conversation that was created with a different model —
          // this simulates the per-conversation override that previously leaked.
          return Promise.resolve({
            id: 'conv-1',
            model: 'llama3',
            messages: [
              { role: 'user', content: 'old question' },
              { role: 'assistant', content: 'old answer' },
            ],
          });
        }
        if (path === '/settings') {
          return Promise.resolve({ llmProvider: 'ollama', ollamaModel: '', openaiModel: null });
        }
        return Promise.resolve([]);
      });

      // Render the AiContext provider directly so we can call its
      // startNewConversation() and inspect model state.
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

      // Wait for chat default to load and pre-fill model.
      await waitFor(() => {
        expect(captured?.model).toBe('qwen3:8b');
      });

      // Simulate the user picking a different model for the current conversation.
      await act(async () => {
        captured!.setModel('gpt-4o-mini');
      });
      expect(captured?.model).toBe('gpt-4o-mini');

      // Start a new conversation — model must reset to the chat default,
      // not stay on the per-conversation override.
      await act(async () => {
        captured!.startNewConversation();
      });
      expect(captured?.model).toBe('qwen3:8b');
    });
  });

  // #703 — chat content must not bleed through the translucent sticky bars.
  // Both bars carry an opaque bg-background under-mask (z-[-1]) covering
  // exactly the bar's box (inset-0).
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
    it('renders an opaque under-mask behind the top sub-header covering exactly its box', () => {
      const { container } = render(<AiAssistantPage />, { wrapper: createWrapper() });

      // The sticky sub-header wrapper establishes its own stacking context
      // (isolate) so the negative-z mask sits behind it, not behind the page.
      const subHeader = container.querySelector('.sticky.top-0');
      expect(subHeader).not.toBeNull();
      expect(subHeader!.className).toContain('isolate');

      // The under-mask is an aria-hidden, opaque bg-background div behind the
      // bar (z-[-1]), sized to exactly the bar's box (inset-0). Asserted as
      // the whole class set, for the reason above the describe.
      const mask = subHeader!.querySelector('[aria-hidden]');
      expect(mask).not.toBeNull();
      expect(mask!.className).toBe(UNDER_MASK_CLASSES);
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

      const bars = [
        container.querySelector('.sticky.top-0'),
        container.querySelector('.sticky.bottom-0'),
      ];
      for (const bar of bars) {
        expect(bar).not.toBeNull();
        const mask = bar!.querySelector('[aria-hidden]') as HTMLElement;
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

});
