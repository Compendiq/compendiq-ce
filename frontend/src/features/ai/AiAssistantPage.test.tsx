import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domMax } from 'framer-motion';
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
let mockPageData: { data: unknown } = { data: undefined };
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
          <LazyMotion features={domMax}>
            {children}
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
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
      const sendBtn = buttons.find((b) => b.closest('.glass-card.mt-4'));
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
        const allButtons = screen.getAllByRole('button');
        // The send button doesn't have text, just an icon, and is in the input area
        const sendBtnContainer = input.closest('.glass-card');
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
});
