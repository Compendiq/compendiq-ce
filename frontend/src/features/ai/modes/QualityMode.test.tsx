import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QualityModeInput, QUALITY_EMPTY_TITLE, qualityEmptySubtitle } from './QualityMode';
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

function createWrapper(initialEntries = ['/ai?pageId=page-1&mode=quality']) {
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

describe('QualityMode', () => {
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
    expect(QUALITY_EMPTY_TITLE).toBe('Analyze article quality across multiple dimensions');
    expect(qualityEmptySubtitle(undefined)).toContain('Navigate to a page');
    expect(qualityEmptySubtitle({ title: 'My Article' })).toContain('My Article');
  });

  it('renders the Analyze Quality button', () => {
    render(<QualityModeInput />, { wrapper: createWrapper() });
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

    render(<QualityModeInput />, { wrapper: createWrapper() });
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn.textContent).toContain('Loading models');
  });

  it('enables the button when page and model are available', async () => {
    render(<QualityModeInput />, { wrapper: createWrapper() });

    await waitFor(() => {
      const btn = screen.getByRole('button');
      expect(btn).not.toBeDisabled();
    });

    const btn = screen.getByRole('button');
    expect(btn.textContent).toContain('Analyze Quality');
  });

  it('disables the button when no page is selected', () => {
    mockPageData = { data: undefined };

    render(<QualityModeInput />, { wrapper: createWrapper(['/ai?mode=quality']) });

    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
  });

  it('calls stream with correct endpoint when clicked', async () => {
    async function* fakeStream() {
      yield { content: 'Quality analysis result' };
    }
    streamSSEMock.mockReturnValue(fakeStream());

    render(<QualityModeInput />, { wrapper: createWrapper() });

    await waitFor(() => {
      const btn = screen.getByRole('button');
      expect(btn).not.toBeDisabled();
    });

    const btn = screen.getByRole('button');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/analyze-quality',
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

    render(<QualityModeInput />, { wrapper: createWrapper() });

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

  it('qualityEmptySubtitle returns ready message with page title', () => {
    expect(qualityEmptySubtitle({ title: 'Architecture Overview' })).toBe(
      'Ready to analyze: Architecture Overview',
    );
  });

  it('qualityEmptySubtitle returns navigation hint when no page', () => {
    expect(qualityEmptySubtitle(undefined)).toBe(
      'Navigate to a page to analyze its quality',
    );
  });
});
