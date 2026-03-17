import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
      id: '1',
      confluenceId: 'page-1',
      spaceKey: 'DEV',
      title: 'Getting Started',
      labels: ['howto'],
      embeddingStatus: 'embedded',
      embeddingCount: 5,
      lastModifiedAt: '2026-03-01T00:00:00Z',
      parentId: null,
    },
    {
      id: '2',
      confluenceId: 'page-2',
      spaceKey: 'OPS',
      title: 'Deployment Guide',
      labels: ['ops', 'deployment'],
      embeddingStatus: 'embedded',
      embeddingCount: 3,
      lastModifiedAt: '2026-02-20T00:00:00Z',
      parentId: null,
    },
  ],
  edges: [
    {
      source: '1',
      target: '2',
      type: 'embedding_similarity',
      score: 0.85,
    },
  ],
};

function createWrapper(initialEntries = ['/graph']) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <LazyMotion features={domAnimation}>
          <MemoryRouter initialEntries={initialEntries}>
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
    expect(screen.getByText(/2 articles, 1 connections/)).toBeInTheDocument();

    // Should render ForceGraph2D
    expect(screen.getByTestId('mock-force-graph')).toBeInTheDocument();

    // Should show space legends (text also appears in filter dropdown)
    expect(screen.getAllByText('DEV').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('OPS').length).toBeGreaterThanOrEqual(1);
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

  it('renders error state with error message when fetch fails', async () => {
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

    // Should show the error message for debugging
    expect(screen.getByText('Internal Server Error')).toBeInTheDocument();

    // Should show retry button with testid
    expect(screen.getByTestId('graph-retry')).toBeInTheDocument();
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

  it('renders view mode toggle buttons', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockGraphData,
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('graph-view-individual')).toBeInTheDocument();
    });
    expect(screen.getByTestId('graph-view-clustered')).toBeInTheDocument();
  });

  it('renders space filter when multiple spaces exist', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockGraphData,
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('graph-space-filter')).toBeInTheDocument();
    });
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
      expect(nodes[0].id).toBe('1');
      expect(links[0].source).toBe('1');
      expect(links[0].target).toBe('2');
    });
  });

  it('switches to clustered view when toggle is clicked', async () => {
    // First fetch for individual view
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => mockGraphData,
      } as Response)
      // Second fetch for clustered view
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          nodes: [{
            id: 'cluster-1',
            type: 'cluster',
            spaceKey: 'DEV',
            title: 'Root Section',
            articleCount: 5,
            pageIds: [1, 2, 3, 4, 5],
          }],
          edges: [],
        }),
      } as Response);

    render(<GraphPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('graph-view-clustered')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('graph-view-clustered'));

    await waitFor(() => {
      expect(screen.getByText(/1 clusters, 0 connections/)).toBeInTheDocument();
    });
  });
});
