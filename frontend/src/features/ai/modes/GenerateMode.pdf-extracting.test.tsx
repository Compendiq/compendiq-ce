import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { GenerateModeInput } from './GenerateMode';
import { AiProvider } from '../AiContext';
import { useAuthStore } from '../../../stores/auth-store';

Element.prototype.scrollIntoView = vi.fn();

const apiFetchMock = vi.fn();
vi.mock('../../../shared/lib/api', async () =>
  (await import('../../../test-utils')).apiModuleMock(() => apiFetchMock));

vi.mock('../../../shared/lib/sse', () => ({
  streamSSE: vi.fn(),
}));

// Per-instance mock of useExtractPdf that mirrors the REAL hook's behaviour:
// each call to useExtractPdf() owns its own `isExtracting` state (the real
// hook keeps it in per-instance useState). `extractPdf` flips that instance's
// state to true and never resolves, so we can observe the busy state.
//
// This is the crux of #940: GenerateModeInput and PdfUploadZone must share a
// single instance. A shared-singleton mock (as in GenerateMode.test.tsx) would
// hide the bug because both instances would read the same value.
vi.mock('../../../shared/hooks/use-extract-pdf', async () => {
  const React = await import('react');
  return {
    useExtractPdf: () => {
      const [isExtracting, setIsExtracting] = React.useState(false);
      const extractPdf = React.useCallback(() => {
        setIsExtracting(true);
        return new Promise(() => { /* stays pending: keeps this instance busy */ });
      }, []);
      return { extractPdf, isExtracting, error: null };
    },
  };
});

vi.mock('../../../shared/hooks/use-pages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/hooks/use-pages')>();
  return { ...actual, usePage: () => ({ data: undefined }), useEmbeddingStatus: () => ({ data: undefined }) };
});

vi.mock('../../../shared/hooks/use-spaces', () => ({
  useSpaces: () => ({ data: [] }),
}));

vi.mock('../../../shared/hooks/use-standalone', () => ({
  useLocalSpaces: () => ({ data: [] }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/ai?mode=generate']}>
          <LazyMotion features={domAnimation}>
            <AiProvider>{children}</AiProvider>
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('GenerateMode PDF extraction busy state (#940)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().setAuth('test-token', { id: '1', username: 'testuser', role: 'user' });
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

  it('shows the "Extracting text..." spinner and disables the upload zone while extraction is in progress', async () => {
    render(<GenerateModeInput />, { wrapper: createWrapper() });

    const uploadZone = screen.getByTestId('pdf-upload-zone');
    expect(uploadZone).not.toBeDisabled();

    // Kick off an extraction that stays pending.
    const fileInput = screen.getByTestId('pdf-file-input');
    const pdfFile = new File(['%PDF-1.4 dummy content'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [pdfFile] } });

    // The busy state must surface: spinner text visible and the zone disabled.
    // With two separate useExtractPdf instances (the #940 bug) the parent's
    // isExtracting never flips, so neither of these ever becomes true.
    await waitFor(() => {
      expect(screen.getByText('Extracting text...')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pdf-upload-zone')).toBeDisabled();
  });
});
