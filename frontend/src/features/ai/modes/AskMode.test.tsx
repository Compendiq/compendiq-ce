import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AskModeInput, AskExamplePrompts, ASK_EMPTY_TITLE, ASK_EMPTY_SUBTITLE } from './AskMode';
import { ASK_EXAMPLE_PROMPTS } from './ask-example-prompts';
import { AiProvider } from '../AiContext';
import { useAuthStore } from '../../../stores/auth-store';

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

vi.mock('../../../shared/hooks/use-pages', () => ({
  usePage: () => ({ data: undefined }),
  useEmbeddingStatus: () => ({ data: undefined }),
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
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'testuser',
      role: 'user',
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
    expect(ASK_EMPTY_SUBTITLE).toBe('Your questions will be answered using RAG over your Confluence pages');
  });

  it('renders input field and send button', () => {
    render(<AskModeInput />, { wrapper: createWrapper() });
    expect(screen.getByPlaceholderText('Ask a question...')).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeInTheDocument();
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
    expect(ASK_EXAMPLE_PROMPTS).toHaveLength(4);

    const input = screen.getByPlaceholderText('Ask a question...') as HTMLInputElement;
    fireEvent.click(items[0]!);

    await waitFor(() => {
      expect(input.value).toBe(ASK_EXAMPLE_PROMPTS[0]);
    });
  });

  it('disables send button when input is empty', () => {
    render(<AskModeInput />, { wrapper: createWrapper() });
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
  });

  it('disables send button when model is not loaded even with input', () => {
    render(<AskModeInput />, { wrapper: createWrapper() });
    const input = screen.getByPlaceholderText('Ask a question...');
    fireEvent.change(input, { target: { value: 'test question' } });
    const btn = screen.getByRole('button');
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
      const btn = screen.getByRole('button');
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
      const btn = screen.getByRole('button');
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
      const btn = screen.getByRole('button');
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
});
