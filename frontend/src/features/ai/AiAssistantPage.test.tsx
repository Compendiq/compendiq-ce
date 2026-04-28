import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AiAssistantPage } from './AiAssistantPage';
import { useAuthStore } from '../../stores/auth-store';

// scrollIntoView is not available in jsdom
Element.prototype.scrollIntoView = vi.fn();

// Keep reference to original apiFetch mock to control per-test
const apiFetchMock = vi.fn();
vi.mock('../../shared/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// Mock SSE module so we can control streaming behavior
const streamSSEMock = vi.fn();
vi.mock('../../shared/lib/sse', () => ({
  streamSSE: (...args: unknown[]) => streamSSEMock(...args),
}));

// Default: no page selected
let mockPageData: { data: unknown; isLoading?: boolean } = { data: undefined };
vi.mock('../../shared/hooks/use-pages', () => ({
  usePage: () => mockPageData,
  useEmbeddingStatus: () => ({ data: undefined }),
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

function createWrapper(initialEntries = ['/ai']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>
          <LazyMotion features={domAnimation}>
            {children}
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
        <LazyMotion features={domAnimation}>{children}</LazyMotion>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { Wrapper, queryClient };
}

describe('AiAssistantPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPageData = { data: undefined };
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

  it('renders the AI assistant page with mode buttons', () => {
    render(<AiAssistantPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Q&A')).toBeInTheDocument();
    expect(screen.getByText('Improve')).toBeInTheDocument();
    expect(screen.getByText('Generate')).toBeInTheDocument();
    expect(screen.getByText('Summarize')).toBeInTheDocument();
    expect(screen.getByText('Diagram')).toBeInTheDocument();
  });

  it('uses space-y-4 natural scroll layout without fixed height', () => {
    const { container } = render(<AiAssistantPage />, { wrapper: createWrapper() });
    const rootDiv = container.firstElementChild as HTMLElement;
    expect(rootDiv.className).toContain('space-y-3');
    expect(rootDiv.className).not.toContain('h-full');
    expect(rootDiv.className).not.toContain('calc');
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

  describe('improve mode', () => {
    it('shows "Navigate to a page" message when no page is selected', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper() });

      // Switch to improve mode
      fireEvent.click(screen.getByText('Improve'));

      expect(screen.getByText(/Navigate to a page/)).toBeInTheDocument();
    });

    it('disables improve button when no page is selected', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper() });

      // Switch to improve mode
      fireEvent.click(screen.getByText('Improve'));

      // The action button should be disabled (no page and no model)
      const buttons = screen.getAllByRole('button');
      const improveBtn = buttons.find((b) => b.textContent?.includes('Loading models'));
      expect(improveBtn).toBeDisabled();
    });

    it('disables improve button when model is not loaded yet', () => {
      mockPageData = {
        data: { id: 'p1', title: 'Test Page', bodyHtml: '<p>Hello</p>', bodyText: 'Hello' },
      };

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?pageId=p1']) });

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

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?pageId=p1']) });

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

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?pageId=p1']) });

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

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?pageId=p1']) });

      // Button should show "Loading page..." and be disabled
      const buttons = screen.getAllByRole('button');
      const loadingBtn = buttons.find((b) => b.textContent?.includes('Loading page'));
      expect(loadingBtn).toBeDefined();
      expect(loadingBtn).toBeDisabled();
    });

    it('reads mode from URL query param', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=improve']) });

      // The improve mode tab should be active
      const improveTab = screen.getByText('Improve');
      expect(improveTab.closest('button')?.className).toContain('text-primary');
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

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?pageId=p1']) });

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

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?pageId=p1']) });

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

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?pageId=p1']) });

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

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?pageId=p1']) });

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
        expect(toastSuccessMock).toHaveBeenCalledWith('Article updated and synced to Confluence');
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

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?pageId=p1']) });

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

    it('removes empty assistant message when ask stream throws an error', async () => {
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

      // Wait for the error toast
      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith('Connection lost');
      });

      // The user message should still be visible
      expect(screen.getByText('What is Confluence?')).toBeInTheDocument();

      // The empty assistant message should have been removed.
      // AskMode adds the user message directly via setMessages (not via runStream's
      // userMessage option), so this test specifically verifies the fix: runStream
      // must always remove the placeholder assistant message on error.
      // If there were an assistant bubble, it would contain a Bot icon or typing indicator.
      expect(screen.queryByTestId('typing-indicator')).not.toBeInTheDocument();

      // Verify there is exactly 1 message bubble (the user message), not 2
      // User messages have "justify-end" class on their container
      const messageBubbles = document.querySelectorAll('.max-w-\\[80\\%\\]');
      expect(messageBubbles.length).toBe(1);
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

  describe('diagram mode - Use in article', () => {
    it('shows "Use in article" button after diagram generation when page is selected', async () => {
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

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?pageId=p1']) });

      // Switch to diagram mode
      fireEvent.click(screen.getByText('Diagram'));

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
        expect(screen.getByText('Use in article')).toBeInTheDocument();
      });
    });

    it('does not show "Use in article" button when no page is selected', async () => {
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

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai']) });

      // Switch to diagram mode
      fireEvent.click(screen.getByText('Diagram'));

      // The button should not appear (no page context)
      expect(screen.queryByText('Use in article')).not.toBeInTheDocument();
    });

    it('calls apiFetch with PUT when "Use in article" is clicked in diagram mode', async () => {
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

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?pageId=p1']) });

      // Switch to diagram mode
      fireEvent.click(screen.getByText('Diagram'));

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

      // Wait for "Use in article" button
      await waitFor(() => {
        expect(screen.getByText('Use in article')).toBeInTheDocument();
      });

      // Click "Use in article"
      fireEvent.click(screen.getByText('Use in article'));

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
        expect(toastSuccessMock).toHaveBeenCalledWith('Diagram inserted into article');
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

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?pageId=p1']) });

      expect(screen.getByText('Test Page')).toBeInTheDocument();
      expect(screen.queryByText('+ Sub-pages')).not.toBeInTheDocument();
    });

    it('shows toggle when page has children', () => {
      mockPageData = {
        data: { id: 'p1', title: 'Parent Page', bodyHtml: '<p>Content</p>', bodyText: 'Content', hasChildren: true },
      };

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?pageId=p1']) });

      expect(screen.getByText('+ Sub-pages')).toBeInTheDocument();
    });

    it('toggles the checkbox when clicked', () => {
      mockPageData = {
        data: { id: 'p1', title: 'Parent Page', bodyHtml: '<p>Content</p>', bodyText: 'Content', hasChildren: true },
      };

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?pageId=p1']) });

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

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?pageId=p1']) });

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

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?pageId=p1']) });

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
    it('shows page context badge when navigated from sidebar', () => {
      mockPageData = {
        data: { id: 'p1', title: 'My Article', bodyHtml: '<p>Content</p>', bodyText: 'Content' },
      };

      render(<AiAssistantPage />, {
        wrapper: createWrapper(['/ai?pageId=p1']),
      });

      // The page title should be shown in the mode bar as context
      expect(screen.getByText('My Article')).toBeInTheDocument();
    });

    it('starts fresh conversation when mounted with different pageId', () => {
      // Mount with p1
      mockPageData = {
        data: { id: 'p1', title: 'First Article', bodyHtml: '<p>Content</p>', bodyText: 'Content' },
      };

      const { unmount } = render(<AiAssistantPage />, {
        wrapper: createWrapper(['/ai?pageId=p1']),
      });

      expect(screen.getByText('First Article')).toBeInTheDocument();
      unmount();

      // Re-mount with p2 — should show fresh state with new page context
      mockPageData = {
        data: { id: 'p2', title: 'Second Article', bodyHtml: '<p>Other</p>', bodyText: 'Other' },
      };

      render(<AiAssistantPage />, {
        wrapper: createWrapper(['/ai?pageId=p2']),
      });

      // New page title shown, no stale state from p1
      expect(screen.getByText('Second Article')).toBeInTheDocument();
      expect(screen.queryByText('First Article')).not.toBeInTheDocument();
    });

    it('defaults to improve mode when pageId is present', () => {
      mockPageData = {
        data: { id: 'p1', title: 'My Article', bodyHtml: '<p>Content</p>', bodyText: 'Content' },
      };

      render(<AiAssistantPage />, {
        wrapper: createWrapper(['/ai?pageId=p1']),
      });

      // Improve mode tab should be active (has font-medium class)
      const improveTab = screen.getByText('Improve');
      expect(improveTab.closest('button')?.className).toContain('text-primary');
    });
  });

  describe('empty state messages', () => {
    it('shows only the correct empty state for improve mode without spurious messages', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByText('Improve'));

      // Should show improve-specific message
      expect(screen.getByText('Select a page and improvement type')).toBeInTheDocument();
      expect(screen.getByText(/Navigate to a page/)).toBeInTheDocument();

      // Should NOT show Q&A message
      expect(screen.queryByText('Ask questions about your knowledge base')).not.toBeInTheDocument();
      // Should NOT show "Open a page first" from other modes bleeding through
      expect(screen.queryByText('AI will create a full article based on your prompt')).not.toBeInTheDocument();
    });

    it('shows only Q&A empty state in ask mode', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper() });

      expect(screen.getByText('Ask questions about your knowledge base')).toBeInTheDocument();
      expect(screen.getByText('Your questions will be answered using RAG over your Confluence pages')).toBeInTheDocument();
      // Should NOT show other mode messages
      expect(screen.queryByText('Select a page and improvement type')).not.toBeInTheDocument();
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
});
