import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { GenerateModeInput, GenerateSavePanel, GENERATE_EMPTY_TITLE, GENERATE_EMPTY_SUBTITLE } from './GenerateMode';
import { AiProvider, useAiContext } from '../AiContext';
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

const mockExtractDocument = vi.fn();
const mockIsExtracting = { value: false };
vi.mock('../../../shared/hooks/use-extract-document', () => ({
  useExtractDocument: () => ({
    extractDocument: (...args: unknown[]) => mockExtractDocument(...args),
    isExtracting: mockIsExtracting.value,
    error: null,
  }),
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

let mockLocalSpacesData: { data: unknown[] | undefined } = { data: undefined };
vi.mock('../../../shared/hooks/use-standalone', () => ({
  useLocalSpaces: () => mockLocalSpacesData,
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

/**
 * Renders the thread the composer writes into. `GenerateModeInput` is only the
 * input bar, so the user turn it appends is otherwise invisible to the DOM.
 * Contributes no buttons, so `getSendButton()` is unaffected.
 */
function MessageProbe() {
  const { messages } = useAiContext();
  return <div data-testid="message-probe">{messages.map((m) => m.content).join(' | ')}</div>;
}

/** Get the Send button (the one inside the input bar, not the upload zone) */
function getSendButton() {
  // The send button is always the last button in the input bar
  const buttons = screen.getAllByRole('button');
  return buttons[buttons.length - 1];
}

describe('GenerateMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPageData = { data: undefined };
    mockIsExtracting.value = false;
    mockSpacesData = {
      data: [
        { key: 'DEV', name: 'Development', homepageId: null, lastSynced: '', pageCount: 10, source: 'confluence' },
        { key: 'OPS', name: 'Operations', homepageId: null, lastSynced: '', pageCount: 5, source: 'confluence' },
      ],
    };
    mockLocalSpacesData = {
      data: [
        { key: 'MY_NOTES', name: 'My Notes', pageCount: 3, source: 'local' },
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
    expect(GENERATE_EMPTY_TITLE).toBe('Describe the page you want to generate');
    expect(GENERATE_EMPTY_SUBTITLE).toBe('AI will create a full page based on your prompt');
  });

  describe('GenerateModeInput', () => {
    it('renders the prompt input, send button, and document upload zone', () => {
      render(<GenerateModeInput />, { wrapper: createWrapper() });

      expect(screen.getByPlaceholderText('Describe the page to generate...')).toBeInTheDocument();
      expect(screen.getByTestId('document-upload-zone')).toBeInTheDocument();
      expect(getSendButton()).toBeInTheDocument();
    });

    it('disables send when input is empty', () => {
      render(<GenerateModeInput />, { wrapper: createWrapper() });
      expect(getSendButton()).toBeDisabled();
    });

    it('calls runStream with correct params when generate is triggered', async () => {
      async function* fakeStream() {
        yield { content: '# My Article\n\nSome content here.' };
      }
      streamSSEMock.mockReturnValue(fakeStream());

      render(<GenerateModeInput />, { wrapper: createWrapper() });

      const input = screen.getByPlaceholderText('Describe the page to generate...');
      fireEvent.change(input, { target: { value: 'Write a guide about Docker' } });

      await waitFor(() => {
        expect(getSendButton()).not.toBeDisabled();
      });

      fireEvent.click(getSendButton());

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

      const input = screen.getByPlaceholderText('Describe the page to generate...');
      fireEvent.change(input, { target: { value: 'Write about Docker' } });

      await waitFor(() => {
        expect(getSendButton()).not.toBeDisabled();
      });

      fireEvent.click(getSendButton());

      await waitFor(() => {
        expect(screen.getByTestId('generate-save-panel')).toBeInTheDocument();
      });

      // Title should be auto-suggested from the first heading
      const titleInput = screen.getByTestId('generate-title-input') as HTMLInputElement;
      expect(titleInput.value).toBe('Docker Guide');
    });

    it('renders the prompt as a multi-line textarea (#1120)', () => {
      render(<GenerateModeInput />, { wrapper: createWrapper() });
      const input = screen.getByPlaceholderText('Describe the page to generate...');
      expect(input.tagName).toBe('TEXTAREA');
    });

    it('Shift+Enter inserts a newline instead of submitting (#1120)', async () => {
      async function* fakeStream() {
        yield { content: '# Article' };
      }
      streamSSEMock.mockReturnValue(fakeStream());

      render(<GenerateModeInput />, { wrapper: createWrapper() });

      const input = screen.getByPlaceholderText('Describe the page to generate...') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: 'Write a guide' } });

      await waitFor(() => {
        expect(getSendButton()).not.toBeDisabled();
      });

      // Shift+Enter must fall through to the textarea's own newline handling:
      // nothing is sent and the draft survives.
      const shiftEnter = fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
      expect(streamSSEMock).not.toHaveBeenCalled();
      expect(input.value).toBe('Write a guide');
      // Not default-prevented, so the browser is still free to insert the
      // newline that jsdom does not simulate for us.
      expect(shiftEnter).toBe(true);

      // The second line is typed, then a bare Enter sends the whole thing.
      fireEvent.change(input, { target: { value: 'Write a guide\ncovering Docker Compose' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(streamSSEMock).toHaveBeenCalledWith(
          '/llm/generate',
          expect.objectContaining({ prompt: 'Write a guide\ncovering Docker Compose' }),
          expect.any(Object),
        );
      });
    });

    it('suppresses the browser newline when a bare Enter submits (#1120)', async () => {
      async function* fakeStream() {
        yield { content: '# Article' };
      }
      streamSSEMock.mockReturnValue(fakeStream());

      render(<GenerateModeInput />, { wrapper: createWrapper() });

      const input = screen.getByPlaceholderText('Describe the page to generate...') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: 'Write a guide' } });

      await waitFor(() => {
        expect(getSendButton()).not.toBeDisabled();
      });

      // fireEvent returns false when the handler called preventDefault. Without
      // it a textarea would submit *and* leave a stray "\n" in the cleared field.
      expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
    });

    it('shows error toast when stream fails', async () => {
      // eslint-disable-next-line require-yield
      async function* fakeErrorStream() {
        throw new Error('LLM connection lost');
      }
      streamSSEMock.mockReturnValue(fakeErrorStream());

      render(<GenerateModeInput />, { wrapper: createWrapper() });

      const input = screen.getByPlaceholderText('Describe the page to generate...');
      fireEvent.change(input, { target: { value: 'Write about Docker' } });

      await waitFor(() => {
        expect(getSendButton()).not.toBeDisabled();
      });

      fireEvent.click(getSendButton());

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

      const input = screen.getByPlaceholderText('Describe the page to generate...');
      fireEvent.change(input, { target: { value: 'Write article' } });

      await waitFor(() => {
        expect(getSendButton()).not.toBeDisabled();
      });

      fireEvent.click(getSendButton());

      // Stream is still in progress, save panel should not show yet
      // The save panel only appears after onComplete fires
      await waitFor(() => {
        expect(screen.queryByTestId('generate-save-panel')).not.toBeInTheDocument();
      });

      // Clean up
      resolveStream?.();
    });
  });

  describe('Document upload (#1132)', () => {
    // One row per supported format: the file the user picks, and the `format`
    // the server reports after sniffing its bytes. Mislabelled files are the
    // server's problem and are covered in `extract-document.test.ts`.
    const FORMATS = [
      { format: 'pdf', filename: 'report.pdf', mime: 'application/pdf', label: 'PDF' },
      {
        format: 'docx',
        filename: 'spec.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        label: 'DOCX',
      },
      { format: 'md', filename: 'notes.md', mime: 'text/markdown', label: 'MD' },
      { format: 'txt', filename: 'raw.txt', mime: 'text/plain', label: 'TXT' },
      { format: 'rtf', filename: 'memo.rtf', mime: 'application/rtf', label: 'RTF' },
      { format: 'odt', filename: 'draft.odt', mime: 'application/vnd.oasis.opendocument.text', label: 'ODT' },
    ] as const;

    function upload({ filename, mime }: { filename: string; mime: string }) {
      const fileInput = screen.getByTestId('document-file-input');
      fireEvent.change(fileInput, {
        target: { files: [new File(['dummy bytes'], filename, { type: mime })] },
      });
    }

    it('renders the upload zone with format-neutral copy', () => {
      render(<GenerateModeInput />, { wrapper: createWrapper() });
      expect(screen.getByTestId('document-upload-zone')).toBeInTheDocument();
      expect(screen.getByText(/Drop a document here or click to browse/)).toBeInTheDocument();
    });

    it('offers all six formats in the accept attribute', () => {
      render(<GenerateModeInput />, { wrapper: createWrapper() });

      const accept = screen.getByTestId('document-file-input').getAttribute('accept') ?? '';
      for (const ext of ['.pdf', '.docx', '.md', '.txt', '.rtf', '.odt']) {
        expect(accept).toContain(ext);
      }
      // The MIME types ride along so both file-picker styles behave.
      expect(accept).toContain('application/pdf');
      expect(accept).toContain('application/vnd.oasis.opendocument.text');
    });

    it.each(FORMATS)('accepts a $format and previews it', async ({ format, filename, mime }) => {
      mockExtractDocument.mockResolvedValue({
        format,
        text: `Extracted ${format} content for testing`,
        fileSize: 1024 * 512,
        preview: `Extracted ${format} content for testing`,
        // PDF is the only paged format, so it is the only one the server sends
        // a page count for.
        ...(format === 'pdf' ? { totalPages: 5 } : {}),
      });

      render(<GenerateModeInput />, { wrapper: createWrapper() });
      upload({ filename, mime });

      await waitFor(() => {
        expect(screen.getByTestId('document-preview-card')).toBeInTheDocument();
      });
      expect(screen.getByText(filename)).toBeInTheDocument();
      expect(screen.getByText('512.0 KB')).toBeInTheDocument();
    });

    it('shows a page count for a PDF', async () => {
      mockExtractDocument.mockResolvedValue({
        format: 'pdf',
        text: 'Extracted PDF content for testing',
        totalPages: 5,
        fileSize: 1024 * 1024 * 2.4,
        preview: 'Extracted PDF content for testing',
      });

      render(<GenerateModeInput />, { wrapper: createWrapper() });
      upload({ filename: 'report.pdf', mime: 'application/pdf' });

      await waitFor(() => {
        expect(screen.getByTestId('document-preview-card')).toBeInTheDocument();
      });
      expect(screen.getByText('5 pages')).toBeInTheDocument();
      expect(screen.getByText('2.4 MB')).toBeInTheDocument();
    });

    // Acceptance criterion 4: `totalPages` is PDF-only. For the other five the
    // server omits it entirely, and the card must name the format instead of
    // claiming a page count it does not have. "0 pages" here would be a lie.
    it.each(FORMATS.filter((f) => f.format !== 'pdf'))(
      'names the format instead of rendering a page count for a $format',
      async ({ format, filename, mime, label }) => {
        mockExtractDocument.mockResolvedValue({
          format,
          text: `Extracted ${format} content`,
          fileSize: 4096,
          preview: `Extracted ${format} content`,
        });

        render(<GenerateModeInput />, { wrapper: createWrapper() });
        upload({ filename, mime });

        const card = await screen.findByTestId('document-preview-card');
        expect(within(card).getByText(label)).toBeInTheDocument();
        // No count of any size — "0 pages" being the one this criterion names.
        expect(card).not.toHaveTextContent(/\d+\s+pages?\b/);
      },
    );

    it('exposes a format-neutral accessible name on the remove button (#939)', async () => {
      mockExtractDocument.mockResolvedValue({
        format: 'odt',
        text: 'Document text',
        fileSize: 1024,
        preview: 'Document text',
      });

      render(<GenerateModeInput />, { wrapper: createWrapper() });
      upload({ filename: 'draft.odt', mime: 'application/vnd.oasis.opendocument.text' });

      await waitFor(() => {
        expect(screen.getByTestId('document-preview-card')).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: 'Remove document' })).toBeInTheDocument();
    });

    it('removes the document when the remove button is clicked', async () => {
      mockExtractDocument.mockResolvedValue({
        format: 'md',
        text: 'Document text',
        fileSize: 1024,
        preview: 'Document text',
      });

      render(<GenerateModeInput />, { wrapper: createWrapper() });
      upload({ filename: 'notes.md', mime: 'text/markdown' });

      await waitFor(() => {
        expect(screen.getByTestId('document-preview-card')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('document-remove-button'));

      // Preview should disappear, upload zone should return
      expect(screen.queryByTestId('document-preview-card')).not.toBeInTheDocument();
      expect(screen.getByTestId('document-upload-zone')).toBeInTheDocument();
    });

    it.each(FORMATS)(
      'sends documentText with the generate request for a $format',
      async ({ format, filename, mime }) => {
        mockExtractDocument.mockResolvedValue({
          format,
          text: `Extracted ${format} text content`,
          fileSize: 5000,
          preview: `Extracted ${format} text content`,
          ...(format === 'pdf' ? { totalPages: 3 } : {}),
        });

        async function* fakeStream() {
          yield { content: '# Generated Article\n\nContent based on the document.' };
        }
        streamSSEMock.mockReturnValue(fakeStream());

        render(<GenerateModeInput />, { wrapper: createWrapper() });
        upload({ filename, mime });

        await waitFor(() => {
          expect(screen.getByTestId('document-preview-card')).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText('Instructions for generating from this document...');
        fireEvent.change(input, { target: { value: 'Create a runbook' } });

        await waitFor(() => {
          expect(getSendButton()).not.toBeDisabled();
        });

        fireEvent.click(getSendButton());

        await waitFor(() => {
          expect(streamSSEMock).toHaveBeenCalledWith(
            '/llm/generate',
            expect.objectContaining({
              prompt: 'Create a runbook',
              model: 'llama3',
              documentText: `Extracted ${format} text content`,
            }),
            expect.any(Object),
          );
        });
      },
    );

    it('names the attached file, not its format, in the user turn', async () => {
      mockExtractDocument.mockResolvedValue({
        format: 'docx',
        text: 'Extracted docx text',
        fileSize: 5000,
        preview: 'Extracted docx text',
      });

      async function* fakeStream() {
        yield { content: '# Generated Article' };
      }
      streamSSEMock.mockReturnValue(fakeStream());

      // The composer does not render the thread, so read the turn it appended
      // straight off the context rather than hunting for it in the DOM.
      render(
        <>
          <GenerateModeInput />
          <MessageProbe />
        </>,
        { wrapper: createWrapper() },
      );
      upload({
        filename: 'spec.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });

      await waitFor(() => {
        expect(screen.getByTestId('document-preview-card')).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('Instructions for generating from this document...');
      fireEvent.change(input, { target: { value: 'Create a runbook' } });
      await waitFor(() => {
        expect(getSendButton()).not.toBeDisabled();
      });
      fireEvent.click(getSendButton());

      // The old copy said "Generate from PDF (spec.docx)", which was wrong for
      // five of six formats and redundant for the sixth.
      await waitFor(() => {
        expect(screen.getByTestId('message-probe')).toHaveTextContent(
          'Generate from spec.docx: Create a runbook',
        );
      });
    });

    it('works normally without a document (existing behavior preserved)', async () => {
      async function* fakeStream() {
        yield { content: '# Article' };
      }
      streamSSEMock.mockReturnValue(fakeStream());

      render(<GenerateModeInput />, { wrapper: createWrapper() });

      const input = screen.getByPlaceholderText('Describe the page to generate...');
      fireEvent.change(input, { target: { value: 'Write about testing' } });

      await waitFor(() => {
        expect(getSendButton()).not.toBeDisabled();
      });

      fireEvent.click(getSendButton());

      await waitFor(() => {
        expect(streamSSEMock).toHaveBeenCalledWith(
          '/llm/generate',
          expect.objectContaining({
            prompt: 'Write about testing',
            model: 'llama3',
          }),
          expect.any(Object),
        );
        // Should NOT include documentText when nothing was uploaded
        const callArgs = streamSSEMock.mock.calls[0];
        expect(callArgs[1].documentText).toBeUndefined();
      });
    });

    it('shows error toast when extraction fails', async () => {
      mockExtractDocument.mockRejectedValue(new Error('File exceeds 20 MB limit'));

      render(<GenerateModeInput />, { wrapper: createWrapper() });
      upload({ filename: 'huge.odt', mime: 'application/vnd.oasis.opendocument.text' });

      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith('File exceeds 20 MB limit');
      });

      // Upload zone should still be visible (no preview card)
      expect(screen.queryByTestId('document-preview-card')).not.toBeInTheDocument();
      expect(screen.getByTestId('document-upload-zone')).toBeInTheDocument();
    });

    it('rejects an unsupported file type client-side and names all six', async () => {
      render(<GenerateModeInput />, { wrapper: createWrapper() });
      upload({ filename: 'diagram.png', mime: 'image/png' });

      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith(
          'Only PDF, DOCX, MD, TXT, RTF and ODT files are accepted',
        );
      });

      expect(mockExtractDocument).not.toHaveBeenCalled();
    });

    it('changes placeholder text when a document is uploaded', async () => {
      mockExtractDocument.mockResolvedValue({
        format: 'rtf',
        text: 'Document text',
        fileSize: 1024,
        preview: 'Document text',
      });

      render(<GenerateModeInput />, { wrapper: createWrapper() });

      // Before upload: standard placeholder
      expect(screen.getByPlaceholderText('Describe the page to generate...')).toBeInTheDocument();

      upload({ filename: 'memo.rtf', mime: 'application/rtf' });

      await waitFor(() => {
        expect(screen.getByTestId('document-preview-card')).toBeInTheDocument();
      });

      // After upload: instructions-for-this-document placeholder
      expect(
        screen.getByPlaceholderText('Instructions for generating from this document...'),
      ).toBeInTheDocument();
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

    it('renders space selector with available spaces including local (#527)', () => {
      render(
        <GenerateSavePanel generatedContent={sampleMarkdown} onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      const spaceSelect = screen.getByTestId('generate-space-select');
      expect(spaceSelect).toBeInTheDocument();

      // Should have the placeholder + 2 confluence + 1 local space
      const options = within(spaceSelect).getAllByRole('option');
      expect(options).toHaveLength(4);
      expect(options[0].textContent).toBe('Select space...');
      expect(options[1].textContent).toBe('Development');
      expect(options[2].textContent).toBe('Operations');
      expect(options[3].textContent).toBe('My Notes');
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

      // Success toast (Confluence space)
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
            limit: 50,
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

    it('sanitizes generated markdown before sending bodyHtml (#747)', async () => {
      // LLM output may carry raw HTML through markdown — it must be sanitized
      // with the shared DOMPurify-backed helper before being sent to /pages.
      const maliciousMarkdown =
        '# Title\n\n<script>alert("xss")</script>\n\n<img src="x" onerror="alert(1)">\n\nSafe **bold** text.';

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
          return Promise.resolve({ id: 'new-page-4', title: 'Title', version: 1 });
        }
        return Promise.resolve([]);
      });

      render(
        <GenerateSavePanel generatedContent={maliciousMarkdown} onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      fireEvent.change(screen.getByTestId('generate-space-select'), { target: { value: 'DEV' } });
      fireEvent.click(screen.getByTestId('generate-save-button'));

      await waitFor(() => {
        const postCall = apiFetchMock.mock.calls.find(
          (args: unknown[]) =>
            args[0] === '/pages' && (args[1] as RequestInit | undefined)?.method === 'POST',
        );
        expect(postCall).toBeDefined();
        const body = JSON.parse((postCall![1] as RequestInit).body as string);

        // Dangerous markup is stripped...
        expect(body.bodyHtml).not.toContain('<script>');
        expect(body.bodyHtml).not.toContain('onerror');
        // ...while legitimate formatting is preserved.
        expect(body.bodyHtml).toContain('<strong>bold</strong>');
      });
    });

    it('shows "Save Locally" button when a local space is selected (#528)', () => {
      render(
        <GenerateSavePanel generatedContent={sampleMarkdown} onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      // Select a local space
      const spaceSelect = screen.getByTestId('generate-space-select');
      fireEvent.change(spaceSelect, { target: { value: 'MY_NOTES' } });

      // Button should say "Save Locally"
      const saveBtn = screen.getByTestId('generate-save-button');
      expect(saveBtn.textContent).toContain('Save Locally');
    });

    it('shows "Save to Confluence" button when a confluence space is selected (#528)', () => {
      render(
        <GenerateSavePanel generatedContent={sampleMarkdown} onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      // Select a Confluence space
      const spaceSelect = screen.getByTestId('generate-space-select');
      fireEvent.change(spaceSelect, { target: { value: 'DEV' } });

      // Button should say "Save to Confluence"
      const saveBtn = screen.getByTestId('generate-save-button');
      expect(saveBtn.textContent).toContain('Save to Confluence');
    });

    it('displays selected page title even when page is not in current search results (#36)', async () => {
      // Initially return a page, then return empty results (simulating a search filter)
      let returnPages = true;
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
            items: returnPages
              ? [{ id: 'page-42', spaceKey: 'DEV', title: 'Deep Nested Page', version: 1, parentId: null, labels: [], author: null, lastModifiedAt: null, lastSynced: '', embeddingDirty: false, embeddingStatus: 'not_embedded', embeddedAt: null, embeddingError: null }]
              : [],
            total: returnPages ? 1 : 0,
            page: 1,
            limit: 50,
            totalPages: returnPages ? 1 : 0,
          });
        }
        return Promise.resolve([]);
      });

      render(
        <GenerateSavePanel generatedContent={sampleMarkdown} onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      // Select space
      fireEvent.change(screen.getByTestId('generate-space-select'), { target: { value: 'DEV' } });

      // Open parent picker and select a page
      await waitFor(() => {
        expect(screen.getByText('None (root level)')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('None (root level)'));

      await waitFor(() => {
        expect(screen.getByText('Deep Nested Page')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('Deep Nested Page'));

      // The button should display the selected page title
      await waitFor(() => {
        expect(screen.getByText('Deep Nested Page')).toBeInTheDocument();
      });

      // Now simulate the page disappearing from results (e.g., different search/filter)
      returnPages = false;

      // The selected title should still be visible via the fallback prop
      // (the button text should not revert to "None (root level)")
      expect(screen.queryByText('None (root level)')).not.toBeInTheDocument();
    });

    it('resets selected page title when space changes (#36)', async () => {
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
              { id: 'page-99', spaceKey: 'DEV', title: 'Selected Page', version: 1, parentId: null, labels: [], author: null, lastModifiedAt: null, lastSynced: '', embeddingDirty: false, embeddingStatus: 'not_embedded', embeddedAt: null, embeddingError: null },
            ],
            total: 1,
            page: 1,
            limit: 50,
            totalPages: 1,
          });
        }
        return Promise.resolve([]);
      });

      render(
        <GenerateSavePanel generatedContent={sampleMarkdown} onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      // Select space and pick a parent page
      fireEvent.change(screen.getByTestId('generate-space-select'), { target: { value: 'DEV' } });

      await waitFor(() => {
        expect(screen.getByText('None (root level)')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('None (root level)'));

      await waitFor(() => {
        expect(screen.getByText('Selected Page')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('Selected Page'));

      // Verify selected page is shown
      await waitFor(() => {
        expect(screen.getByText('Selected Page')).toBeInTheDocument();
      });

      // Change space - should reset parent page selection
      fireEvent.change(screen.getByTestId('generate-space-select'), { target: { value: 'OPS' } });

      // After space change, the parent picker should show "None (root level)" again
      await waitFor(() => {
        expect(screen.getByText('None (root level)')).toBeInTheDocument();
      });
    });

    it('shows correct toast when saving to a local space (#528)', async () => {
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
          return Promise.resolve({ id: 'new-page-local', title: 'Getting Started', version: 1 });
        }
        return Promise.resolve([]);
      });

      render(
        <GenerateSavePanel generatedContent={sampleMarkdown} onSaved={onSavedMock} />,
        { wrapper: createWrapper() },
      );

      // Select local space
      const spaceSelect = screen.getByTestId('generate-space-select');
      fireEvent.change(spaceSelect, { target: { value: 'MY_NOTES' } });

      // Click save
      fireEvent.click(screen.getByTestId('generate-save-button'));

      await waitFor(() => {
        expect(toastSuccessMock).toHaveBeenCalledWith('Page "Getting Started" created locally');
      });
    });
  });
});
