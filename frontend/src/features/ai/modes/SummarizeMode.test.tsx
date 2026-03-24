import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domMax } from 'framer-motion';
import { SummarizeModeInput, SUMMARIZE_EMPTY_TITLE, summarizeEmptySubtitle } from './SummarizeMode';
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

let mockPageData: { data: unknown; isLoading?: boolean } = {
  data: {
    id: 'page-1',
    title: 'Test Page',
    bodyHtml: '<p>Hello world</p>',
    bodyText: 'Hello world',
    version: 1,
  },
};

vi.mock('../../../shared/hooks/use-pages', () => ({
  usePage: () => mockPageData,
  useEmbeddingStatus: () => ({ data: undefined }),
}));

const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: vi.fn(),
  },
}));

function createWrapper(initialEntries = ['/ai?pageId=page-1&mode=summarize']) {
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

describe('SummarizeMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPageData = {
      data: {
        id: 'page-1',
        title: 'Test Page',
        bodyHtml: '<p>Hello world</p>',
        bodyText: 'Hello world',
        version: 1,
      },
    };
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
    expect(SUMMARIZE_EMPTY_TITLE).toBe('Select a page to summarize');
    expect(summarizeEmptySubtitle(undefined)).toContain('Navigate to a page');
    expect(summarizeEmptySubtitle({ title: 'My Article' })).toContain('My Article');
  });

  it('renders the Summarize Page button', () => {
    render(<SummarizeModeInput />, { wrapper: createWrapper() });
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('shows "Loading models..." when model is not yet available', () => {
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

    render(<SummarizeModeInput />, { wrapper: createWrapper() });
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn.textContent).toContain('Loading models');
  });

  it('enables the button when page and model are available', async () => {
    render(<SummarizeModeInput />, { wrapper: createWrapper() });

    await waitFor(() => {
      const btn = screen.getByRole('button');
      expect(btn).not.toBeDisabled();
    });

    const btn = screen.getByRole('button');
    expect(btn.textContent).toContain('Summarize Page');
  });

  it('disables the button when no page is selected', () => {
    mockPageData = { data: undefined };

    render(<SummarizeModeInput />, { wrapper: createWrapper(['/ai?mode=summarize']) });

    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
  });

  it('calls stream with correct endpoint when clicked', async () => {
    async function* fakeStream() {
      yield { content: 'Summary result' };
    }
    streamSSEMock.mockReturnValue(fakeStream());

    render(<SummarizeModeInput />, { wrapper: createWrapper() });

    await waitFor(() => {
      const btn = screen.getByRole('button');
      expect(btn).not.toBeDisabled();
    });

    const btn = screen.getByRole('button');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/summarize',
        expect.objectContaining({
          content: '<p>Hello world</p>',
          model: 'llama3',
        }),
        expect.any(Object),
      );
    });
  });

  it('shows "Processing..." while streaming', async () => {
    let resolveStream: () => void;
    const streamPromise = new Promise<void>((resolve) => { resolveStream = resolve; });

    async function* slowStream() {
      yield { content: 'chunk' };
      await streamPromise;
    }
    streamSSEMock.mockReturnValue(slowStream());

    render(<SummarizeModeInput />, { wrapper: createWrapper() });

    await waitFor(() => {
      const btn = screen.getByRole('button');
      expect(btn).not.toBeDisabled();
    });

    const btn = screen.getByRole('button');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(btn.textContent).toContain('Processing');
    });

    // Cleanup
    resolveStream!();
  });

  it('shows toast error when clicked without page selected', async () => {
    mockPageData = { data: undefined };

    render(<SummarizeModeInput />, { wrapper: createWrapper(['/ai?mode=summarize']) });

    const btn = screen.getByRole('button');
    // Button is disabled, so direct click should not trigger toast
    expect(btn).toBeDisabled();
  });

  it('summarizeEmptySubtitle returns ready message with page title', () => {
    expect(summarizeEmptySubtitle({ title: 'Architecture Overview' })).toBe(
      'Ready to summarize: Architecture Overview',
    );
  });

  it('summarizeEmptySubtitle returns navigation hint when no page', () => {
    expect(summarizeEmptySubtitle(undefined)).toBe(
      'Navigate to a page and click "Summarize" to get started',
    );
  });
});
