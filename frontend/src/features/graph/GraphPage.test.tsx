import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { GraphPage } from './GraphPage';

// Mock react-force-graph-2d since it uses canvas
vi.mock('react-force-graph-2d', () => {
  return {
    default: vi.fn().mockImplementation((props) => (
      <div data-testid="mock-force-graph" data-nodes={JSON.stringify(props.graphData?.nodes ?? [])} data-links={JSON.stringify(props.graphData?.links ?? [])} />
    )),
  };
});

const mockGraphData = {
  nodes: [
    {
      id: 'page-1',
      spaceKey: 'DEV',
      title: 'Getting Started',
      labels: ['howto'],
      embeddingStatus: 'embedded',
      embeddingCount: 5,
      lastModifiedAt: '2026-03-01T00:00:00Z',
    },
    {
      id: 'page-2',
      spaceKey: 'OPS',
      title: 'Deployment Guide',
      labels: ['ops', 'deployment'],
      embeddingStatus: 'embedded',
      embeddingCount: 3,
      lastModifiedAt: '2026-02-20T00:00:00Z',
    },
  ],
  edges: [
    {
      source: 'page-1',
      target: 'page-2',
      type: 'embedding_similarity',
      score: 0.85,
    },
  ],
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <LazyMotion features={domAnimation}>
          <MemoryRouter>
            {children}
          </MemoryRouter>
        </LazyMotion>
      </QueryClientProvider>
    );
  };
}

describe('GraphPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading state initially', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise(() => {}), // never resolves
    );

    render(<GraphPage />, { wrapper: createWrapper() });

    expect(screen.getByText('Loading knowledge graph...')).toBeInTheDocument();
  });

  it('renders the graph with nodes and edges when data loads', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockGraphData,
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Knowledge Graph')).toBeInTheDocument();
    });

    // Should display node/edge counts
    expect(screen.getByText('2 articles, 1 connections')).toBeInTheDocument();

    // Should render ForceGraph2D
    expect(screen.getByTestId('mock-force-graph')).toBeInTheDocument();

    // Should show space legends
    expect(screen.getByText('DEV')).toBeInTheDocument();
    expect(screen.getByText('OPS')).toBeInTheDocument();
  });

  it('renders empty state when no pages exist', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ nodes: [], edges: [] }),
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/No pages found/)).toBeInTheDocument();
    });
  });

  it('renders error state when fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ message: 'Internal Server Error' }),
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Failed to load graph data')).toBeInTheDocument();
    });

    // Should show retry button
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('renders zoom controls', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockGraphData,
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('graph-zoom-in')).toBeInTheDocument();
    });

    expect(screen.getByTestId('graph-zoom-out')).toBeInTheDocument();
    expect(screen.getByTestId('graph-fit')).toBeInTheDocument();
    expect(screen.getByTestId('graph-refresh')).toBeInTheDocument();
  });

  it('renders the graph container', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockGraphData,
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('graph-container')).toBeInTheDocument();
    });
  });

  it('passes correct graph data to ForceGraph2D', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockGraphData,
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      const graph = screen.getByTestId('mock-force-graph');
      const nodes = JSON.parse(graph.getAttribute('data-nodes') ?? '[]');
      const links = JSON.parse(graph.getAttribute('data-links') ?? '[]');
      expect(nodes).toHaveLength(2);
      expect(links).toHaveLength(1);
      expect(nodes[0].id).toBe('page-1');
      expect(links[0].source).toBe('page-1');
      expect(links[0].target).toBe('page-2');
    });
  });
});
