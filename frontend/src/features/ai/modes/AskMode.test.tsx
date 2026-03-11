import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domMax } from 'framer-motion';
import { AskModeInput, ASK_EMPTY_TITLE, ASK_EMPTY_SUBTITLE } from './AskMode';
import { AiProvider } from '../AiContext';
import { useAuthStore } from '../../../stores/auth-store';

Element.prototype.scrollIntoView = vi.fn();

const apiFetchMock = vi.fn();
vi.mock('../../../shared/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

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
          <LazyMotion features={domMax}>
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
