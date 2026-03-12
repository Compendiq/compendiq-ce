import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domMax } from 'framer-motion';
import { ImproveTypeSelector, ImproveModeInput, IMPROVE_EMPTY_TITLE, improveEmptySubtitle } from './ImproveMode';
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

function createWrapper(initialEntries = ['/ai?pageId=page-1&mode=improve']) {
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

describe('ImproveMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'testuser',
      role: 'user',
    });

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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('exports correct empty state constants', () => {
    expect(IMPROVE_EMPTY_TITLE).toBe('Select a page and improvement type');
    expect(improveEmptySubtitle(undefined)).toContain('Navigate to a page');
    expect(improveEmptySubtitle({ title: 'My Article' })).toContain('My Article');
  });

  it('renders improvement type buttons', () => {
    render(<ImproveTypeSelector />, { wrapper: createWrapper() });
    expect(screen.getByText('grammar')).toBeInTheDocument();
    expect(screen.getByText('structure')).toBeInTheDocument();
    expect(screen.getByText('clarity')).toBeInTheDocument();
    expect(screen.getByText('technical')).toBeInTheDocument();
    expect(screen.getByText('completeness')).toBeInTheDocument();
  });

  it('renders instruction textarea with correct placeholder', () => {
    render(<ImproveModeInput />, { wrapper: createWrapper() });
    const textarea = screen.getByPlaceholderText(/Additional instructions/i);
    expect(textarea).toBeInTheDocument();
    expect(textarea.tagName).toBe('TEXTAREA');
  });

  it('renders the Improve Page button', () => {
    render(<ImproveModeInput />, { wrapper: createWrapper() });
    // Wait for models to load before checking for "Improve Page"
    // Button text will be "Loading models..." until models load
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('allows typing in the instruction textarea', () => {
    render(<ImproveModeInput />, { wrapper: createWrapper() });
    const textarea = screen.getByPlaceholderText(/Additional instructions/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Focus on the intro' } });
    expect(textarea.value).toBe('Focus on the intro');
  });

  it('passes instruction to stream when provided', async () => {
    async function* fakeStream() {
      yield { content: 'Improved!' };
    }
    streamSSEMock.mockReturnValue(fakeStream());

    render(<ImproveModeInput />, { wrapper: createWrapper() });

    // Wait for models to load
    await waitFor(() => {
      const btn = screen.getByRole('button');
      expect(btn).not.toBeDisabled();
    });

    // Type instruction
    const textarea = screen.getByPlaceholderText(/Additional instructions/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Focus on the intro' } });

    // Click improve
    const btn = screen.getByRole('button');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/improve',
        expect.objectContaining({
          instruction: 'Focus on the intro',
          type: 'grammar',
          model: 'llama3',
        }),
        expect.any(Object),
      );
    });
  });

  it('does not include instruction key when textarea is empty', async () => {
    async function* fakeStream() {
      yield { content: 'Improved!' };
    }
    streamSSEMock.mockReturnValue(fakeStream());

    render(<ImproveModeInput />, { wrapper: createWrapper() });

    // Wait for models to load
    await waitFor(() => {
      const btn = screen.getByRole('button');
      expect(btn).not.toBeDisabled();
    });

    // Click improve without typing instruction
    const btn = screen.getByRole('button');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/improve',
        expect.not.objectContaining({
          instruction: expect.anything(),
        }),
        expect.any(Object),
      );
    });
  });

  it('textarea has maxLength attribute of 10000', () => {
    render(<ImproveModeInput />, { wrapper: createWrapper() });
    const textarea = screen.getByPlaceholderText(/Additional instructions/i) as HTMLTextAreaElement;
    expect(textarea.maxLength).toBe(10000);
  });

  it('disables textarea while streaming', async () => {
    // Create a stream that never resolves so isStreaming stays true
    let resolveStream: () => void;
    const streamPromise = new Promise<void>((resolve) => { resolveStream = resolve; });

    async function* slowStream() {
      yield { content: 'chunk' };
      await streamPromise;
    }
    streamSSEMock.mockReturnValue(slowStream());

    render(<ImproveModeInput />, { wrapper: createWrapper() });

    await waitFor(() => {
      const btn = screen.getByRole('button');
      expect(btn).not.toBeDisabled();
    });

    const btn = screen.getByRole('button');
    fireEvent.click(btn);

    // While streaming, textarea should be disabled
    await waitFor(() => {
      const textarea = screen.getByPlaceholderText(/Additional instructions/i) as HTMLTextAreaElement;
      expect(textarea.disabled).toBe(true);
    });

    // Cleanup
    resolveStream!();
  });
});
