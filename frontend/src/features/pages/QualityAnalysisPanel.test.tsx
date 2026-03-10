import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QualityAnalysisPanel } from './QualityAnalysisPanel';
import { useAuthStore } from '../../stores/auth-store';

// Mock SSE module so we can control streaming behavior
const streamSSEMock = vi.fn();
vi.mock('../../shared/lib/sse', () => ({
  streamSSE: (...args: unknown[]) => streamSSEMock(...args),
}));

// Mock apiFetch so we can control API calls
const apiFetchMock = vi.fn();
vi.mock('../../shared/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// Mock sonner toast so we can verify messages
const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  };
}

describe('QualityAnalysisPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'testuser',
      role: 'user',
    });

    // Default: models API returns two models
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/ollama/models') {
        return Promise.resolve([{ name: 'llama3' }, { name: 'qwen3:latest' }]);
      }
      return Promise.resolve({});
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders the Analyze Quality button when closed', () => {
    render(
      <QualityAnalysisPanel pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="Test Page" />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText('Analyze Quality')).toBeInTheDocument();
  });

  it('expands panel when button is clicked', async () => {
    render(
      <QualityAnalysisPanel pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="Test Page" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Analyze Quality'));

    await waitFor(() => {
      expect(screen.getByText('Quality Analysis')).toBeInTheDocument();
    });
  });

  it('shows page title in the panel', async () => {
    render(
      <QualityAnalysisPanel pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="My Article" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Analyze Quality'));

    await waitFor(() => {
      expect(screen.getByText('Analyzing: My Article')).toBeInTheDocument();
    });
  });

  it('loads models when panel opens', async () => {
    render(
      <QualityAnalysisPanel pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="Test Page" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Analyze Quality'));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/ollama/models');
    });
  });

  it('closes panel when X button is clicked', async () => {
    render(
      <QualityAnalysisPanel pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="Test Page" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Analyze Quality'));
    await waitFor(() => {
      expect(screen.getByText('Quality Analysis')).toBeInTheDocument();
    });

    // Find and click the close button
    const closeBtn = screen.getByText('Quality Analysis').closest('div')!.querySelector('button:last-child')!;
    fireEvent.click(closeBtn);

    expect(screen.queryByText('Quality Analysis')).not.toBeInTheDocument();
    expect(screen.getByText('Analyze Quality')).toBeInTheDocument();
  });

  it('sends correct payload when analyzing', async () => {
    async function* fakeStream() {
      yield { content: '## Overall Quality Score: 85/100', done: true };
    }
    streamSSEMock.mockReturnValue(fakeStream());

    render(
      <QualityAnalysisPanel pageId="page-1" bodyHtml="<p>Article content here</p>" pageTitle="Test Page" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Analyze Quality'));

    await waitFor(() => {
      expect(screen.getByText('Analyze')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Analyze'));

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/analyze-quality',
        expect.objectContaining({
          content: '<p>Article content here</p>',
          pageId: 'page-1',
        }),
        expect.any(Object), // AbortSignal
      );
    });
  });

  it('displays streamed quality analysis results', async () => {
    async function* fakeStream() {
      yield { content: '## Overall Quality Score: 85/100' };
    }
    streamSSEMock.mockReturnValue(fakeStream());

    render(
      <QualityAnalysisPanel pageId="page-1" bodyHtml="<p>Content</p>" pageTitle="Test Page" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Analyze Quality'));

    await waitFor(() => {
      expect(screen.getByText('Analyze')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Analyze'));

    await waitFor(() => {
      expect(screen.getByText('Overall Quality Score: 85/100')).toBeInTheDocument();
    });
  });

  it('shows error toast when stream reports error', async () => {
    async function* fakeStream() {
      yield { error: 'Model not found' };
    }
    streamSSEMock.mockReturnValue(fakeStream());

    render(
      <QualityAnalysisPanel pageId="page-1" bodyHtml="<p>Content</p>" pageTitle="Test Page" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Analyze Quality'));

    await waitFor(() => {
      expect(screen.getByText('Analyze')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Analyze'));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('Model not found');
    });
  });

  it('shows Analyzing button state during streaming', async () => {
    let resolveStream: () => void;
    const streamPromise = new Promise<void>((resolve) => { resolveStream = resolve; });

    async function* fakeStream() {
      yield { content: 'Analyzing...' };
      await streamPromise; // hang here
    }
    streamSSEMock.mockReturnValue(fakeStream());

    render(
      <QualityAnalysisPanel pageId="page-1" bodyHtml="<p>Content</p>" pageTitle="Test Page" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Analyze Quality'));

    await waitFor(() => {
      expect(screen.getByText('Analyze')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Analyze'));

    await waitFor(() => {
      expect(screen.getByText('Analyzing...')).toBeInTheDocument();
    });

    // Clean up
    resolveStream!();
  });

  it('has correct title attribute on collapsed button', () => {
    render(
      <QualityAnalysisPanel pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="Test Page" />,
      { wrapper: createWrapper() },
    );

    const btn = screen.getByTitle('Analyze article quality');
    expect(btn).toBeInTheDocument();
  });
});
