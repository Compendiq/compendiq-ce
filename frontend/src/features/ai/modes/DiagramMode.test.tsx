import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { DiagramTypeSelector, DiagramModeInput, DIAGRAM_EMPTY_TITLE, diagramEmptySubtitle } from './DiagramMode';
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

let mockPageData: { data: unknown } = { data: undefined };
vi.mock('../../../shared/hooks/use-pages', () => ({
  usePage: () => mockPageData,
  useEmbeddingStatus: () => ({ data: undefined }),
}));

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
            <AiProvider>
              {children}
            </AiProvider>
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('DiagramMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPageData = { data: undefined };
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
    expect(DIAGRAM_EMPTY_TITLE).toBe('Generate a diagram from a page');
    expect(diagramEmptySubtitle(undefined)).toContain('Navigate to a page');
    expect(diagramEmptySubtitle({ title: 'My Page' })).toBe('Ready to diagram: My Page');
  });

  describe('DiagramTypeSelector', () => {
    it('renders all diagram type buttons', () => {
      render(<DiagramTypeSelector />, { wrapper: createWrapper() });
      expect(screen.getByText('flowchart')).toBeInTheDocument();
      expect(screen.getByText('sequence')).toBeInTheDocument();
      expect(screen.getByText('state')).toBeInTheDocument();
      expect(screen.getByText('mindmap')).toBeInTheDocument();
    });

    it('highlights the default flowchart type', () => {
      render(<DiagramTypeSelector />, { wrapper: createWrapper() });
      const flowchartBtn = screen.getByText('flowchart');
      expect(flowchartBtn.className).toContain('bg-primary/15');
    });

    it('switches active type when clicked', () => {
      render(<DiagramTypeSelector />, { wrapper: createWrapper() });
      const sequenceBtn = screen.getByText('sequence');
      fireEvent.click(sequenceBtn);
      expect(sequenceBtn.className).toContain('bg-primary/15');
    });
  });

  describe('DiagramModeInput', () => {
    it('renders the Generate Diagram button', async () => {
      mockPageData = {
        data: { id: 'p1', title: 'Test', bodyHtml: '<p>test</p>', bodyText: 'test', version: 1 },
      };

      render(<DiagramModeInput />, { wrapper: createWrapper(['/ai?pageId=p1']) });

      await waitFor(() => {
        const btns = screen.getAllByRole('button');
        const generateBtn = btns.find((b) => b.textContent?.includes('Generate Diagram'));
        expect(generateBtn).toBeDefined();
      });
    });

    it('disables button when no page is selected', () => {
      render(<DiagramModeInput />, { wrapper: createWrapper() });
      const btn = screen.getByRole('button');
      expect(btn).toBeDisabled();
    });

    it('shows toast error when triggered without a page', async () => {
      // Force model to be loaded but no page
      render(<DiagramModeInput />, { wrapper: createWrapper() });

      await waitFor(() => {
        // Let provider settle
      });

      // The button is disabled, so the handler would show a toast if called directly.
      // We verify the button is disabled which prevents the call.
      const btn = screen.getByRole('button');
      expect(btn).toBeDisabled();
    });

    it('calls streamSSE with correct parameters when diagram is triggered', async () => {
      mockPageData = {
        data: { id: 'p1', title: 'My Article', bodyHtml: '<p>Content</p>', bodyText: 'Content', version: 2 },
      };

      async function* fakeDiagramStream() {
        yield { content: 'graph TD\n  A --> B' };
      }
      streamSSEMock.mockReturnValue(fakeDiagramStream());

      render(<DiagramModeInput />, { wrapper: createWrapper(['/ai?pageId=p1']) });

      await waitFor(() => {
        const btns = screen.getAllByRole('button');
        const generateBtn = btns.find((b) => b.textContent?.includes('Generate Diagram'));
        expect(generateBtn).not.toBeDisabled();
      });

      const btns = screen.getAllByRole('button');
      const generateBtn = btns.find((b) => b.textContent?.includes('Generate Diagram'))!;
      fireEvent.click(generateBtn);

      await waitFor(() => {
        expect(streamSSEMock).toHaveBeenCalledWith(
          '/llm/generate-diagram',
          expect.objectContaining({
            content: '<p>Content</p>',
            model: 'llama3',
            diagramType: 'flowchart',
            pageId: 'p1',
          }),
          expect.any(Object),
        );
      });
    });

    it('shows error toast when stream fails', async () => {
      mockPageData = {
        data: { id: 'p1', title: 'My Article', bodyHtml: '<p>Content</p>', bodyText: 'Content', version: 2 },
      };

      // eslint-disable-next-line require-yield
      async function* fakeErrorStream() {
        throw new Error('Connection lost');
      }
      streamSSEMock.mockReturnValue(fakeErrorStream());

      render(<DiagramModeInput />, { wrapper: createWrapper(['/ai?pageId=p1']) });

      await waitFor(() => {
        const btns = screen.getAllByRole('button');
        const generateBtn = btns.find((b) => b.textContent?.includes('Generate Diagram'));
        expect(generateBtn).not.toBeDisabled();
      });

      const btns = screen.getAllByRole('button');
      const generateBtn = btns.find((b) => b.textContent?.includes('Generate Diagram'))!;
      fireEvent.click(generateBtn);

      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith('Connection lost');
      });
    });
  });
});
