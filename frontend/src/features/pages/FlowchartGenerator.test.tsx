import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FlowchartGenerator } from './FlowchartGenerator';
import { useAuthStore } from '../../stores/auth-store';

// Mock mermaid (used by MermaidDiagram)
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg>diagram</svg>' }),
  },
}));

// Track fetch calls
let fetchSpy: ReturnType<typeof vi.spyOn>;

function mockModelsResponse() {
  return new Response(JSON.stringify([{ name: 'llama3' }, { name: 'qwen3:latest' }]), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockSSEResponse(chunks: string[]) {
  const body = chunks
    .map((c, i) => `data: ${JSON.stringify({ content: c, done: i === chunks.length - 1 })}`)
    .join('\n\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('FlowchartGenerator', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'testuser',
      role: 'user',
    });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders the Diagram button when closed', () => {
    fetchSpy.mockResolvedValue(mockModelsResponse());
    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" />);
    expect(screen.getByText('Diagram')).toBeInTheDocument();
  });

  it('expands panel when button is clicked', async () => {
    fetchSpy.mockResolvedValue(mockModelsResponse());
    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" />);

    fireEvent.click(screen.getByText('Diagram'));

    await waitFor(() => {
      expect(screen.getByText('Generate Diagram')).toBeInTheDocument();
    });
  });

  it('loads models when panel opens', async () => {
    fetchSpy.mockResolvedValue(mockModelsResponse());
    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" />);

    fireEvent.click(screen.getByText('Diagram'));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/ollama/models'),
        expect.any(Object),
      );
    });
  });

  it('renders diagram type selector with all types', async () => {
    fetchSpy.mockResolvedValue(mockModelsResponse());
    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" />);

    fireEvent.click(screen.getByText('Diagram'));

    await waitFor(() => {
      expect(screen.getByText('flowchart')).toBeInTheDocument();
      expect(screen.getByText('sequence')).toBeInTheDocument();
      expect(screen.getByText('state')).toBeInTheDocument();
      expect(screen.getByText('mindmap')).toBeInTheDocument();
    });
  });

  it('defaults to flowchart type with active styling', async () => {
    fetchSpy.mockResolvedValue(mockModelsResponse());
    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" />);

    fireEvent.click(screen.getByText('Diagram'));

    await waitFor(() => {
      const flowchartBtn = screen.getByText('flowchart');
      expect(flowchartBtn).toHaveClass('bg-primary/15', 'text-primary');
    });
  });

  it('closes panel when X button is clicked', async () => {
    fetchSpy.mockResolvedValue(mockModelsResponse());
    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" />);

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
    fetchSpy
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockSSEResponse(['graph TD\n  A --> B']));

    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Step 1 then Step 2</p>" />);

    fireEvent.click(screen.getByText('Diagram'));

    await waitFor(() => {
      expect(screen.getByText('Generate')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Generate'));

    await waitFor(() => {
      // Verify the generate-diagram API was called
      const calls = fetchSpy.mock.calls;
      const diagramCall = calls.find(([url]) =>
        typeof url === 'string' && url.includes('/llm/generate-diagram'),
      );
      expect(diagramCall).toBeDefined();
      const body = JSON.parse(diagramCall![1]?.body as string);
      expect(body.content).toBe('<p>Step 1 then Step 2</p>');
      expect(body.diagramType).toBe('flowchart');
      expect(body.pageId).toBe('page-1');
    });
  });

  it('allows switching diagram type before generating', async () => {
    fetchSpy.mockResolvedValue(mockModelsResponse());
    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" />);

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
    fetchSpy.mockResolvedValue(mockModelsResponse());
    render(<FlowchartGenerator pageId="page-1" bodyHtml="<p>Test</p>" />);

    const btn = screen.getByTitle('Generate diagram from article');
    expect(btn).toBeInTheDocument();
  });
});
