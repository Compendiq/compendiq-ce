import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { ImproveTypeSelector, ImproveModeInput, ImproveDiffView, IMPROVE_EMPTY_TITLE, improveEmptySubtitle } from './ImproveMode';
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

  // #704: the diff must compare the original *markdown* the model was fed
  // (echoed by the backend on the final SSE event) against the improved
  // markdown — not the formatting-stripped page.bodyText.
  describe('#704 diff baseline is original markdown', () => {
    const ORIGINAL_MD = '# Title\n\nThis sentence have a grammar error.\n\n- item one\n- item two';
    const IMPROVED_MD = '# Title\n\nThis sentence has a grammar error.\n\n- item one\n- item two';

    async function runImprove() {
      // Stream the improved markdown, then a final event carrying the original
      // markdown baseline (mirrors the backend's `improveExtras`).
      async function* fakeStream() {
        yield { content: IMPROVED_MD };
        yield { originalMarkdown: ORIGINAL_MD, done: true, final: true };
      }
      streamSSEMock.mockReturnValue(fakeStream());

      render(
        <>
          <ImproveModeInput />
          <ImproveDiffView />
        </>,
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        const btn = screen.getByRole('button', { name: /Improve Page/i });
        expect(btn).not.toBeDisabled();
      });
      fireEvent.click(screen.getByRole('button', { name: /Improve Page/i }));

      await waitFor(() => {
        expect(screen.getByTestId('unified-diff')).toBeInTheDocument();
      });
    }

    it('uses the echoed original markdown (with markup) as the diff baseline, not stripped bodyText', async () => {
      await runImprove();

      const diff = screen.getByTestId('unified-diff');
      // The markdown markup (`#`, list `-`) must be present in the baseline and
      // NOT flagged as additions. With a grammar-only edit, the only highlighted
      // change is the wording — markup carries over unchanged.
      const addedSpans = diff.querySelectorAll('.text-success');
      const addedText = Array.from(addedSpans).map((s) => s.textContent).join('');

      // No markup tokens should appear as additions (the old bug surfaced
      // `#`, `**`, `-` as green additions).
      expect(addedText).not.toContain('#');
      expect(addedText).not.toContain('- item');
      // The genuine grammar edit ("has") is still highlighted.
      expect(addedText).toContain('has');

      // The full diff text preserves the markdown structure (baseline kept its
      // headers/lists rather than being whitespace-collapsed plain text).
      expect(diff.textContent).toContain('# Title');
      expect(diff.textContent).toContain('- item one');
    });

    it('marks only the changed word as removed, leaving markup untouched', async () => {
      await runImprove();

      const diff = screen.getByTestId('unified-diff');
      const removedSpans = diff.querySelectorAll('.text-destructive');
      const removedText = Array.from(removedSpans).map((s) => s.textContent).join('');

      // The replaced word is removed; markup is not.
      expect(removedText).toContain('have');
      expect(removedText).not.toContain('#');
      expect(removedText).not.toContain('- item');
    });
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
