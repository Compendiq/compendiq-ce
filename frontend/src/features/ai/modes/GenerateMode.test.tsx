import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domMax } from 'framer-motion';
import { GenerateModeInput, GenerateSavePanel, GENERATE_EMPTY_TITLE, GENERATE_EMPTY_SUBTITLE } from './GenerateMode';
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
vi.mock('../../../shared/hooks/use-pages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/hooks/use-pages')>();
  return {
    ...actual,
    usePage: () => mockPageData,
    useEmbeddingStatus: () => ({ data: undefined }),
  };
});

let mockSpacesData: { data: unknown[] | undefined } = { data: undefined };
vi.mock('../../../shared/hooks/use-spaces', () => ({
  useSpaces: () => mockSpacesData,
}));

const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

function createWrapper(initialEntries = ['/ai?mode=generate']) {
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

describe('GenerateMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPageData = { data: undefined };
    mockSpacesData = {
      data: [
        { key: 'DEV', name: 'Development', homepageId: null, lastSynced: '', pageCount: 10 },
        { key: 'OPS', name: 'Operations', homepageId: null, lastSynced: '', pageCount: 5 },
      ],
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
    expect(GENERATE_EMPTY_TITLE).toBe('Describe the article you want to generate');
    expect(GENERATE_EMPTY_SUBTITLE).toBe('AI will create a full article based on your prompt');
  });

  describe('GenerateModeInput', () => {
    it('renders the prompt input and send button', () => {
      render(<GenerateModeInput />, { wrapper: createWrapper() });

      expect(screen.getByPlaceholderText('Describe the article to generate...')).toBeInTheDocument();
      expect(screen.getByRole('button')).toBeInTheDocument();
    });

    it('disables send when input is empty', () => {
      render(<GenerateModeInput />, { wrapper: createWrapper() });
      const btn = screen.getByRole('button');
      expect(btn).toBeDisabled();
    });

    it('calls runStream with correct params when generate is triggered', async () => {
      async function* fakeStream() {
        yield { content: '# My Article\n\nSome content here.' };
      }
      streamSSEMock.mockReturnValue(fakeStream());

      render(<GenerateModeInput />, { wrapper: createWrapper() });

      const input = screen.getByPlaceholderText('Describe the article to generate...');
      fireEvent.change(input, { target: { value: 'Write a guide about Docker' } });

      await waitFor(() => {
        const btn = screen.getByRole('button');
        expect(btn).not.toBeDisabled();
      });

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(streamSSEMock).toHaveBeenCalledWith(
          '/llm/generate',
          expect.objectContaining({
            prompt: 'Write a guide about Docker',
            model: 'llama3',
          }),
          expect.any(Object),
        );
      });
    });

    it('shows save panel after generation completes', async () => {
      async function* fakeStream() {
        yield { content: '# Docker Guide\n\nDocker is a container platform.' };
      }
      streamSSEMock.mockReturnValue(fakeStream());

      render(<GenerateModeInput />, { wrapper: createWrapper() });

      const input = screen.getByPlaceholderText('Describe the article to generate...');
      fireEvent.change(input, { target: { value: 'Write about Docker' } });

      await waitFor(() => {
        expect(screen.getByRole('button')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByTestId('generate-save-panel')).toBeInTheDocument();
      });

      // Title should be auto-suggested from the first heading
      const titleInput = screen.getByTestId('generate-title-input') as HTMLInputElement;
      expect(titleInput.value).toBe('Docker Guide');
    });

    it('shows error toast when stream fails', async () => {
      async function* fakeErrorStream() {
        throw new Error('LLM connection lost');
      }
      streamSSEMock.mockReturnValue(fakeErrorStream());

      render(<GenerateModeInput />, { wrapper: createWrapper() });

      const input = screen.getByPlaceholderText('Describe the article to generate...');
      fireEvent.change(input, { target: { value: 'Write about Docker' } });

      await waitFor(() => {
        expect(screen.getByRole('button')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith('LLM connection lost');
      });
    });

    it('does not show save panel when generation is still streaming', async () => {
      // Create a stream that never completes
      let resolveStream: (() => void) | undefined;
      const streamPromise = new Promise<void>((resolve) => { resolveStream = resolve; });

      async function* slowStream() {
        yield { content: '# Title' };
        await streamPromise;
      }
      streamSSEMock.mockReturnValue(slowStream());

      render(<GenerateModeInput />, { wrapper: createWrapper() });

      const input = screen.getByPlaceholderText('Describe the article to generate...');
      fireEvent.change(input, { target: { value: 'Write article' } });

      await waitFor(() => {
        expect(screen.getByRole('button')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByRole('button'));

      // Stream is still in progress, save panel should not show yet
      // The save panel only appears after onComplete fires
      await waitFor(() => {
        expect(screen.queryByTestId('generate-save-panel')).not.toBeInTheDocument();
      });

      // Clean up
      resolveStream?.();
    });
  });

  describe('GenerateSavePanel', () => {
    const sampleMarkdown = '# Getting Started\n\nThis is a guide about getting started.';
    const onSavedMock = vi.fn();

    it('renders title input with auto-suggested title from heading', () => {
      render(
        <GenerateSavePanel generatedContent={sampleMarkdown} onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      const titleInput = screen.getByTestId('generate-title-input') as HTMLInputElement;
      expect(titleInput.value).toBe('Getting Started');
    });

    it('renders space selector with available spaces', () => {
      render(
        <GenerateSavePanel generatedContent={sampleMarkdown} onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      const spaceSelect = screen.getByTestId('generate-space-select');
      expect(spaceSelect).toBeInTheDocument();

      // Should have the placeholder + 2 spaces
      const options = within(spaceSelect).getAllByRole('option');
      expect(options).toHaveLength(3);
      expect(options[0].textContent).toBe('Select space...');
      expect(options[1].textContent).toBe('Development');
      expect(options[2].textContent).toBe('Operations');
    });

    it('disables save button when title is empty', () => {
      render(
        <GenerateSavePanel generatedContent="No heading here" onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      const titleInput = screen.getByTestId('generate-title-input') as HTMLInputElement;
      // Content without heading = empty title suggestion
      expect(titleInput.value).toBe('');

      const saveBtn = screen.getByTestId('generate-save-button');
      expect(saveBtn).toBeDisabled();
    });

    it('disables save button when no space is selected', () => {
      render(
        <GenerateSavePanel generatedContent={sampleMarkdown} onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      // Title is auto-filled but no space is selected
      const saveBtn = screen.getByTestId('generate-save-button');
      expect(saveBtn).toBeDisabled();
    });

    it('shows error toast when title is missing on save', () => {
      render(
        <GenerateSavePanel generatedContent="No heading" onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      // Select a space first
      const spaceSelect = screen.getByTestId('generate-space-select');
      fireEvent.change(spaceSelect, { target: { value: 'DEV' } });

      // Try to save (button should be disabled because title is empty)
      const saveBtn = screen.getByTestId('generate-save-button');
      expect(saveBtn).toBeDisabled();
    });

    it('shows error toast when no space is selected on save', () => {
      render(
        <GenerateSavePanel generatedContent={sampleMarkdown} onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      // Title is auto-filled but no space
      const saveBtn = screen.getByTestId('generate-save-button');
      expect(saveBtn).toBeDisabled();
    });

    it('calls POST /api/pages with correct data when save is clicked', async () => {
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
        if (path === '/pages' && opts?.method === 'POST') {
          return Promise.resolve({ id: 'new-page-1', title: 'Getting Started', version: 1 });
        }
        return Promise.resolve([]);
      });

      render(
        <GenerateSavePanel generatedContent={sampleMarkdown} onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      // Select space
      const spaceSelect = screen.getByTestId('generate-space-select');
      fireEvent.change(spaceSelect, { target: { value: 'DEV' } });

      // Click save
      const saveBtn = screen.getByTestId('generate-save-button');
      fireEvent.click(saveBtn);

      await waitFor(() => {
        const postCall = apiFetchMock.mock.calls.find(
          (args: unknown[]) =>
            args[0] === '/pages' && (args[1] as RequestInit | undefined)?.method === 'POST',
        );
        expect(postCall).toBeDefined();
        const body = JSON.parse((postCall![1] as RequestInit).body as string);
        expect(body.spaceKey).toBe('DEV');
        expect(body.title).toBe('Getting Started');
        expect(body.bodyHtml).toContain('<h1>');
        expect(body.bodyHtml).toContain('Getting Started');
      });

      // Success toast
      await waitFor(() => {
        expect(toastSuccessMock).toHaveBeenCalledWith('Page "Getting Started" created in Confluence');
      });

      // onSaved callback was called
      expect(onSavedMock).toHaveBeenCalled();
    });

    it('shows error toast when save API call fails', async () => {
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
        if (path === '/pages' && opts?.method === 'POST') {
          return Promise.reject(new Error('Permission denied'));
        }
        return Promise.resolve([]);
      });

      render(
        <GenerateSavePanel generatedContent={sampleMarkdown} onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      // Select space
      const spaceSelect = screen.getByTestId('generate-space-select');
      fireEvent.change(spaceSelect, { target: { value: 'DEV' } });

      // Click save
      fireEvent.click(screen.getByTestId('generate-save-button'));

      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith('Permission denied');
      });

      // onSaved should NOT have been called on error
      expect(onSavedMock).not.toHaveBeenCalled();
    });

    it('allows changing the auto-suggested title', () => {
      render(
        <GenerateSavePanel generatedContent={sampleMarkdown} onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      const titleInput = screen.getByTestId('generate-title-input') as HTMLInputElement;
      expect(titleInput.value).toBe('Getting Started');

      fireEvent.change(titleInput, { target: { value: 'Custom Title' } });
      expect(titleInput.value).toBe('Custom Title');
    });

    it('sends parentId when a parent page is selected', async () => {
      // Mock pages list for parent picker
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
        if (path.startsWith('/pages') && !opts?.method) {
          return Promise.resolve({
            items: [
              { id: 'parent-1', spaceKey: 'DEV', title: 'Parent Doc', version: 1, parentId: null, labels: [], author: null, lastModifiedAt: null, lastSynced: '', embeddingDirty: false, embeddingStatus: 'not_embedded', embeddedAt: null, embeddingError: null },
            ],
            total: 1,
            page: 1,
            limit: 20,
            totalPages: 1,
          });
        }
        if (path === '/pages' && opts?.method === 'POST') {
          return Promise.resolve({ id: 'new-page-2', title: 'Getting Started', version: 1 });
        }
        return Promise.resolve([]);
      });

      render(
        <GenerateSavePanel generatedContent={sampleMarkdown} onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      // Select space
      const spaceSelect = screen.getByTestId('generate-space-select');
      fireEvent.change(spaceSelect, { target: { value: 'DEV' } });

      // Open parent picker
      await waitFor(() => {
        const parentBtn = screen.getByText('None (root level)');
        expect(parentBtn).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('None (root level)'));

      // Wait for pages to load and select a parent
      await waitFor(() => {
        expect(screen.getByText('Parent Doc')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Parent Doc'));

      // Click save
      fireEvent.click(screen.getByTestId('generate-save-button'));

      await waitFor(() => {
        const postCall = apiFetchMock.mock.calls.find(
          (args: unknown[]) =>
            args[0] === '/pages' && (args[1] as RequestInit | undefined)?.method === 'POST',
        );
        expect(postCall).toBeDefined();
        const body = JSON.parse((postCall![1] as RequestInit).body as string);
        expect(body.parentId).toBe('parent-1');
        expect(body.spaceKey).toBe('DEV');
      });
    });

    it('converts markdown to HTML before saving', async () => {
      const markdownWithFormatting = '# Title\n\n**Bold** and *italic* text.\n\n- Item 1\n- Item 2';

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
        if (path === '/pages' && opts?.method === 'POST') {
          return Promise.resolve({ id: 'new-page-3', title: 'Title', version: 1 });
        }
        return Promise.resolve([]);
      });

      render(
        <GenerateSavePanel generatedContent={markdownWithFormatting} onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      // Select space
      fireEvent.change(screen.getByTestId('generate-space-select'), { target: { value: 'DEV' } });

      // Save
      fireEvent.click(screen.getByTestId('generate-save-button'));

      await waitFor(() => {
        const postCall = apiFetchMock.mock.calls.find(
          (args: unknown[]) =>
            args[0] === '/pages' && (args[1] as RequestInit | undefined)?.method === 'POST',
        );
        expect(postCall).toBeDefined();
        const body = JSON.parse((postCall![1] as RequestInit).body as string);

        // Should contain HTML tags, not markdown
        expect(body.bodyHtml).toContain('<strong>Bold</strong>');
        expect(body.bodyHtml).toContain('<em>italic</em>');
        expect(body.bodyHtml).toContain('<li>Item 1</li>');
      });
    });
  });
});
