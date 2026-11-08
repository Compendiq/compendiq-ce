import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { ImproveModeInput, ImproveDiffView, IMPROVE_EMPTY_TITLE, improveEmptySubtitle } from './ImproveMode';
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

/**
 * The action button, by name. A bare `getByRole('button')` used to be
 * unambiguous here and stopped being so when #1154 gave this composer its
 * attach triggers; the name also covers the pre-model "Loading models..."
 * label, which is the same button mid-boot.
 */
function improveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Improve Page|Loading models/i }) as HTMLButtonElement;
}

// #1361: a document comes from the article route now — `/ai?pageId=` resolves
// to no page. Improve is a page-scoped action, so its tests mount where the
// page is.
function createWrapper(initialEntries = ['/pages/page-1?mode=improve']) {
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
    expect(improveButton()).toBeInTheDocument();
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
      expect(improveButton()).not.toBeDisabled();
    });

    // Type instruction
    const textarea = screen.getByPlaceholderText(/Additional instructions/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Focus on the intro' } });

    // Click improve
    fireEvent.click(improveButton());

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
      expect(improveButton()).not.toBeDisabled();
    });

    // Click improve without typing instruction
    fireEvent.click(improveButton());

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

  // Layout-token loss warning: when the page's markdown carried [[[…]]]
  // layout boundary tokens but the model's output lost them all, applying
  // will most likely be rejected (422) — warn BEFORE the user hits Accept.
  describe('layout-token loss warning', () => {
    const TOKEN_MD =
      '[[[LAYOUT]]]\n\n[[[LAYOUT-SECTION two_equal]]]\n\n[[[LAYOUT-CELL]]]\n\nLeft\n\n[[[/LAYOUT-CELL]]]\n\n' +
      '[[[LAYOUT-CELL]]]\n\nRight\n\n[[[/LAYOUT-CELL]]]\n\n[[[/LAYOUT-SECTION]]]\n\n[[[/LAYOUT]]]';

    async function runImproveWith(improved: string, original: string) {
      async function* fakeStream() {
        yield { content: improved };
        yield { originalMarkdown: original, done: true, final: true };
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
        expect(screen.getByRole('button', { name: /Improve Page/i })).not.toBeDisabled();
      });
      fireEvent.click(screen.getByRole('button', { name: /Improve Page/i }));
      await waitFor(() => {
        expect(screen.getByTestId('unified-diff')).toBeInTheDocument();
      });
    }

    it('warns when the original markdown had layout tokens but the AI output lost them', async () => {
      await runImproveWith('Left improved\n\nRight improved', TOKEN_MD);
      const warning = screen.getByTestId('layout-token-loss-warning');
      expect(warning.textContent).toMatch(/layout/i);
      expect(warning.textContent).toMatch(/try again|run .*again|retry/i);
    });

    it('shows no warning when the AI output kept the tokens', async () => {
      await runImproveWith(TOKEN_MD.replace('Left', 'Left improved'), TOKEN_MD);
      expect(screen.queryByTestId('layout-token-loss-warning')).not.toBeInTheDocument();
    });

    it('shows no warning for layout-free pages', async () => {
      await runImproveWith('Improved prose', '# Title\n\nOriginal prose');
      expect(screen.queryByTestId('layout-token-loss-warning')).not.toBeInTheDocument();
    });

    // The backend's final SSE event carries an authoritative layoutTokensLost
    // verdict (it runs the real recoverability scan); the client `[[[`
    // heuristic is only the fallback when the flag is absent (e.g. aborted
    // stream).
    it('trusts backend layoutTokensLost=false over the client heuristic (mangled-but-recoverable output)', async () => {
      async function* fakeStream() {
        // Mangled 2-bracket spelling: no literal `[[[`, but the backend's
        // loose scanner can still recover it — so it reports false.
        yield { content: '[[LAYOUT CELL]]\n\nLeft improved' };
        yield { originalMarkdown: TOKEN_MD, layoutTokensLost: false, done: true, final: true };
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
        expect(screen.getByRole('button', { name: /Improve Page/i })).not.toBeDisabled();
      });
      fireEvent.click(screen.getByRole('button', { name: /Improve Page/i }));
      await waitFor(() => {
        expect(screen.getByTestId('unified-diff')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('layout-token-loss-warning')).not.toBeInTheDocument();
    });

    it('trusts backend layoutTokensLost=true even when the output happens to contain bracket text', async () => {
      async function* fakeStream() {
        yield { content: 'Prose mentioning [[[something]]] that is not a real token' };
        yield { originalMarkdown: TOKEN_MD, layoutTokensLost: true, done: true, final: true };
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
        expect(screen.getByRole('button', { name: /Improve Page/i })).not.toBeDisabled();
      });
      fireEvent.click(screen.getByRole('button', { name: /Improve Page/i }));
      await waitFor(() => {
        expect(screen.getByTestId('unified-diff')).toBeInTheDocument();
      });
      expect(screen.getByTestId('layout-token-loss-warning')).toBeInTheDocument();
    });
  });

  // #282: the pending improvement is reusable state whose text proves nothing
  // about the binding it was generated under. Accept hands the durable row the
  // final frame named back BY REFERENCE; the server re-admits its recorded
  // provenance, and only that re-proved text reaches the apply route.
  describe('#282 Accept re-admits the stored improvement by reference', () => {
    const IMPROVEMENT_ID = '3f0b2c4e-7a61-4d2b-9c58-1e4f6a8b0d21';
    const READMIT_PATH = `/llm/improvements/${IMPROVEMENT_ID}/readmit`;
    const IMPROVED = 'Hello, world.';

    async function runImproveNaming(improvementId: string | undefined) {
      async function* fakeStream() {
        yield { content: IMPROVED };
        yield { originalMarkdown: 'Hello world', done: true, final: true, ...(improvementId && { improvementId }) };
      }
      streamSSEMock.mockReturnValue(fakeStream());
      render(
        <>
          <ImproveModeInput />
          <ImproveDiffView />
        </>,
        { wrapper: createWrapper() },
      );
      await waitFor(() => expect(screen.getByRole('button', { name: /Improve Page/i })).not.toBeDisabled());
      fireEvent.click(screen.getByRole('button', { name: /Improve Page/i }));
      await waitFor(() => expect(screen.getByTestId('unified-diff')).toBeInTheDocument());
    }

    /** DiffView's accept control, by name — its exact label is DiffView's. */
    function acceptButton(): HTMLElement {
      return screen.getByRole('button', { name: /accept|apply/i });
    }

    function routesWithReadmit(readmit: (path: string) => Promise<unknown> | null) {
      apiFetchMock.mockImplementation((path: string) => {
        const handled = readmit(path);
        if (handled) return handled;
        if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
        if (path === '/llm/conversations') return Promise.resolve([]);
        return Promise.resolve([]);
      });
    }

    it('calls the readmit route before the apply route and applies the re-admitted text', async () => {
      routesWithReadmit((path) => path === READMIT_PATH
        ? Promise.resolve({ improvementId: IMPROVEMENT_ID, pageId: 1, improvedMarkdown: IMPROVED, aiProvenance: {} })
        : null);
      await runImproveNaming(IMPROVEMENT_ID);

      fireEvent.click(acceptButton());

      await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/llm/improvements/apply', expect.anything()));
      const calls = apiFetchMock.mock.calls.map(([path]) => path as string);
      expect(calls.indexOf(READMIT_PATH)).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf(READMIT_PATH)).toBeLessThan(calls.indexOf('/llm/improvements/apply'));
      expect(apiFetchMock).toHaveBeenCalledWith('/llm/improvements/apply', expect.objectContaining({
        body: JSON.stringify({ pageId: 'page-1', improvedMarkdown: IMPROVED, version: 1, title: 'Test Page' }),
      }));
    });

    it('keeps a 409 ai_history_not_replayable on screen, applies nothing and withdraws Accept', async () => {
      const { ApiError } = await import('../../../shared/lib/api');
      routesWithReadmit((path) => path === READMIT_PATH ? Promise.reject(new ApiError(409, 'Conflict')) : null);
      await runImproveNaming(IMPROVEMENT_ID);

      fireEvent.click(acceptButton());

      expect(await screen.findByTestId('improve-readmit-refused')).toHaveTextContent('can no longer be applied');
      expect(apiFetchMock).not.toHaveBeenCalledWith('/llm/improvements/apply', expect.anything());
      // The diff stays — the verdict is about the binding, not the words.
      expect(screen.getByTestId('unified-diff')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /accept|apply/i })).not.toBeInTheDocument();
      expect(toastErrorMock).not.toHaveBeenCalled();
    });

    it('keeps a 503 ai_policy_unavailable on screen and leaves Accept available to retry', async () => {
      const { ApiError } = await import('../../../shared/lib/api');
      routesWithReadmit((path) => path === READMIT_PATH ? Promise.reject(new ApiError(503, 'Unavailable')) : null);
      await runImproveNaming(IMPROVEMENT_ID);

      fireEvent.click(acceptButton());

      expect(await screen.findByTestId('improve-readmit-refused')).toHaveTextContent('Try Apply again');
      expect(apiFetchMock).not.toHaveBeenCalledWith('/llm/improvements/apply', expect.anything());
      expect(acceptButton()).toBeInTheDocument();
    });

    it('applies the text it has when the stream named no row', async () => {
      routesWithReadmit(() => null);
      await runImproveNaming(undefined);

      fireEvent.click(acceptButton());

      await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/llm/improvements/apply', expect.anything()));
      expect(apiFetchMock.mock.calls.some(([path]) => String(path).endsWith('/readmit'))).toBe(false);
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
      expect(improveButton()).not.toBeDisabled();
    });

    fireEvent.click(improveButton());

    // While streaming, textarea should be disabled
    await waitFor(() => {
      const textarea = screen.getByPlaceholderText(/Additional instructions/i) as HTMLTextAreaElement;
      expect(textarea.disabled).toBe(true);
    });

    // Cleanup
    resolveStream!();
  });
});
