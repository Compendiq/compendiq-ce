import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FlowchartGenerator } from './FlowchartGenerator';
import { useAuthStore } from '../../stores/auth-store';

// Mock mermaid (used by MermaidDiagram)
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg>diagram</svg>' }),
  },
}));

// Mock SSE module so we can control streaming behavior for diagram generation
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

describe('FlowchartGenerator', () => {
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

  it('renders the Diagram button when closed', () => {
    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="Test Page" pageVersion={1} />, { wrapper: createWrapper() });
    expect(screen.getByTitle('Generate diagram from article')).toBeInTheDocument();
  });

  it('expands panel when button is clicked', async () => {
    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="Test Page" pageVersion={1} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByTitle('Generate diagram from article'));

    await waitFor(() => {
      expect(screen.getByText('Generate Diagram')).toBeInTheDocument();
    });
  });

  it('renders only trigger button in renderTriggerOnly mode', () => {
    render(
      <FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="Test Page" pageVersion={1} renderTriggerOnly />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByTitle('Generate diagram from article')).toBeInTheDocument();
    expect(screen.queryByText('Generate Diagram')).not.toBeInTheDocument();
  });

  it('renders nothing in renderPanelOnly mode when closed', () => {
    const { container } = render(
      <FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="Test Page" pageVersion={1} open={false} renderPanelOnly />,
      { wrapper: createWrapper() },
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders panel in renderPanelOnly mode when open', () => {
    render(
      <FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="Test Page" pageVersion={1} open={true} renderPanelOnly />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText('Generate Diagram')).toBeInTheDocument();
  });

  it('button label has responsive hidden class for small screens', () => {
    render(
      <FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="Test Page" pageVersion={1} renderTriggerOnly />,
      { wrapper: createWrapper() },
    );
    const btn = screen.getByTitle('Generate diagram from article');
    const label = btn.querySelector('span');
    expect(label).toHaveClass('hidden', 'sm:inline');
  });

  it('loads models when panel opens', async () => {
    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="Test Page" pageVersion={1} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Diagram'));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/ollama/models');
    });
  });

  it('renders diagram type selector with all types', async () => {
    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="Test Page" pageVersion={1} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Diagram'));

    await waitFor(() => {
      expect(screen.getByText('flowchart')).toBeInTheDocument();
      expect(screen.getByText('sequence')).toBeInTheDocument();
      expect(screen.getByText('state')).toBeInTheDocument();
      expect(screen.getByText('mindmap')).toBeInTheDocument();
    });
  });

  it('defaults to flowchart type with active styling', async () => {
    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="Test Page" pageVersion={1} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Diagram'));

    await waitFor(() => {
      const flowchartBtn = screen.getByText('flowchart');
      expect(flowchartBtn).toHaveClass('bg-primary/15', 'text-primary');
    });
  });

  it('closes panel when X button is clicked', async () => {
    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="Test Page" pageVersion={1} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Diagram'));
    await waitFor(() => {
      expect(screen.getByText('Generate Diagram')).toBeInTheDocument();
    });

    // Find and click the close button
    const closeBtn = screen.getByText('Generate Diagram').closest('div')!.querySelector('button:last-child')!;
    fireEvent.click(closeBtn);

    expect(screen.queryByText('Generate Diagram')).not.toBeInTheDocument();
    expect(screen.getByText('Diagram')).toBeInTheDocument();
  });

  it('sends correct payload when generating a diagram', async () => {
    async function* fakeStream() {
      yield { content: 'graph TD\n  A --> B', done: true };
    }
    streamSSEMock.mockReturnValue(fakeStream());

    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Step 1 then Step 2</p>" pageTitle="Test Page" pageVersion={1} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Diagram'));

    await waitFor(() => {
      expect(screen.getByText('Generate')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Generate'));

    await waitFor(() => {
      expect(streamSSEMock).toHaveBeenCalledWith(
        '/llm/generate-diagram',
        expect.objectContaining({
          content: '<p>Step 1 then Step 2</p>',
          diagramType: 'flowchart',
          pageId: 'page-1',
        }),
        expect.any(Object), // AbortSignal
      );
    });
  });

  it('allows switching diagram type before generating', async () => {
    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="Test Page" pageVersion={1} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Diagram'));

    await waitFor(() => {
      expect(screen.getByText('sequence')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('sequence'));

    // Sequence should now be active
    expect(screen.getByText('sequence')).toHaveClass('bg-primary/15', 'text-primary');
    // Flowchart should be inactive
    expect(screen.getByText('flowchart')).not.toHaveClass('bg-primary/15');
  });

  it('shows generate button with title tooltip', () => {
    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" pageTitle="Test Page" pageVersion={1} />, { wrapper: createWrapper() });

    const btn = screen.getByTitle('Generate diagram from article');
    expect(btn).toBeInTheDocument();
  });

  it('shows "Use in article" button after diagram generation completes', async () => {
    async function* fakeStream() {
      yield { content: 'graph TD\n  A --> B' };
    }
    streamSSEMock.mockReturnValue(fakeStream());

    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Content</p>" pageTitle="Test Page" pageVersion={1} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Diagram'));

    await waitFor(() => {
      expect(screen.getByText('Generate')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Generate'));

    await waitFor(() => {
      expect(screen.getByText('Use in article')).toBeInTheDocument();
    });
  });

  it('does not show "Use in article" button while streaming', async () => {
    // Create a stream that never resolves
    let resolveStream: () => void;
    const streamPromise = new Promise<void>((resolve) => { resolveStream = resolve; });

    async function* fakeStream() {
      yield { content: 'graph TD' };
      await streamPromise; // hang here
    }
    streamSSEMock.mockReturnValue(fakeStream());

    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Content</p>" pageTitle="Test Page" pageVersion={1} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Diagram'));

    await waitFor(() => {
      expect(screen.getByText('Generate')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Generate'));

    // Should show "Generating..." but not "Use in article"
    await waitFor(() => {
      expect(screen.getByText('Generating...')).toBeInTheDocument();
    });
    expect(screen.queryByText('Use in article')).not.toBeInTheDocument();

    // Clean up: resolve the promise so the generator finishes
    resolveStream!();
  });

  it('calls PUT /api/pages/:id when "Use in article" is clicked', async () => {
    async function* fakeStream() {
      yield { content: 'graph TD\n  A --> B' };
    }
    streamSSEMock.mockReturnValue(fakeStream());

    // Mock the PUT call for inserting diagram
    apiFetchMock.mockImplementation((path: string, opts?: RequestInit) => {
      if (path === '/ollama/models') {
        return Promise.resolve([{ name: 'llama3' }]);
      }
      if (path === '/pages/page-1' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 'page-1', title: 'Test Page', version: 2 });
      }
      return Promise.resolve({});
    });

    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Content</p>" pageTitle="Test Page" pageVersion={1} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Diagram'));

    await waitFor(() => {
      expect(screen.getByText('Generate')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Generate'));

    await waitFor(() => {
      expect(screen.getByText('Use in article')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Use in article'));

    await waitFor(() => {
      const putCall = apiFetchMock.mock.calls.find(
        (args: unknown[]) =>
          args[0] === '/pages/page-1' && (args[1] as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit)?.body as string);
      expect(body.title).toBe('Test Page');
      expect(body.version).toBe(1);
      expect(body.bodyHtml).toContain('<pre><code class="language-mermaid">');
      expect(body.bodyHtml).toContain('graph TD');
      expect(body.bodyHtml).toContain('<p>Content</p>');
    });

    // Verify success toast
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith('Diagram inserted into article');
    });
  });

  it('shows error toast when insert fails', async () => {
    async function* fakeStream() {
      yield { content: 'graph TD\n  A --> B' };
    }
    streamSSEMock.mockReturnValue(fakeStream());

    apiFetchMock.mockImplementation((path: string, opts?: RequestInit) => {
      if (path === '/ollama/models') {
        return Promise.resolve([{ name: 'llama3' }]);
      }
      if (path === '/pages/page-1' && opts?.method === 'PUT') {
        return Promise.reject(new Error('Version conflict'));
      }
      return Promise.resolve({});
    });

    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Content</p>" pageTitle="Test Page" pageVersion={1} />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Diagram'));

    await waitFor(() => {
      expect(screen.getByText('Generate')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Generate'));

    await waitFor(() => {
      expect(screen.getByText('Use in article')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Use in article'));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('Version conflict');
    });
  });
});
