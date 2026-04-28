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

    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

    expect(screen.getByText('Loading knowledge graph...')).toBeInTheDocument();
  });

  it('renders the graph with nodes and edges when data loads', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockGraphData,
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

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

    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

    await waitFor(() => {
      expect(screen.getByText(/No pages found/)).toBeInTheDocument();
    });
  });

  // ---------- #358 differentiated empty states + admin recompute ----------

  it('shows the "no spaces accessible" empty state when meta.pagesTotal===0', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        nodes: [],
        edges: [],
        meta: { pagesTotal: 0, pagesEmbedded: 0, relationshipsTotal: 0, relationshipsByType: {} },
      }),
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/No accessible pages in your spaces/)).toBeInTheDocument();
    });
  });

  it('shows the "pages not embedded yet" state when pagesTotal>0 but pagesEmbedded===0', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        nodes: [{ id: '1', spaceKey: 'DEV', title: 't', labels: [], embeddingStatus: 'pending', embeddingCount: 0, lastModifiedAt: null }],
        edges: [],
        meta: { pagesTotal: 1, pagesEmbedded: 0, relationshipsTotal: 0, relationshipsByType: {} },
      }),
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/Pages not embedded yet/)).toBeInTheDocument();
    });
  });

  it('shows "no relationships computed yet" with admin recompute button when admin', async () => {
    // Set admin role on the auth store
    const { useAuthStore } = await import('../../stores/auth-store');
    useAuthStore.setState({ user: { id: '1', username: 'a', role: 'admin' }, accessToken: 'tok' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        nodes: [{ id: '1', spaceKey: 'DEV', title: 't', labels: [], embeddingStatus: 'embedded', embeddingCount: 1, lastModifiedAt: null }],
        edges: [],
        meta: { pagesTotal: 1, pagesEmbedded: 1, relationshipsTotal: 0, relationshipsByType: {} },
      }),
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/no relationships computed yet/i)).toBeInTheDocument();
    });
    expect(screen.getByTestId('graph-recompute-btn')).toBeInTheDocument();

    // Reset role to avoid leaking into other tests.
    useAuthStore.setState({ user: null, accessToken: null });
  });

  it('admin recompute click fires POST /api/pages/graph/refresh and triggers re-fetch (AC-3)', async () => {
    // AC-3: clicking Recompute must (a) call POST /api/pages/graph/refresh
    // and (b) invalidate the graph query so the UI re-fetches the new data.
    const { useAuthStore } = await import('../../stores/auth-store');
    useAuthStore.setState({ user: { id: '1', username: 'a', role: 'admin' }, accessToken: 'tok' });

    const initialEmpty = {
      nodes: [{ id: '1', spaceKey: 'DEV', title: 't', labels: [], embeddingStatus: 'embedded', embeddingCount: 1, lastModifiedAt: null }],
      edges: [],
      meta: { pagesTotal: 1, pagesEmbedded: 1, relationshipsTotal: 0, relationshipsByType: {} },
    };
    const recomputed = {
      nodes: [{ id: '1', spaceKey: 'DEV', title: 't', labels: [], embeddingStatus: 'embedded', embeddingCount: 1, lastModifiedAt: null }],
      edges: [{ source: '1', target: '1', type: 'embedding_similarity', score: 0.9 }],
      meta: { pagesTotal: 1, pagesEmbedded: 1, relationshipsTotal: 1, relationshipsByType: { embedding_similarity: 1 } },
    };

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      // 1) initial GET — empty relationships, button visible
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => initialEmpty,
      } as Response)
      // 2) POST /api/pages/graph/refresh from useRefreshGraph mutation
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ message: 'Graph relationships refreshed', edges: 1 }),
      } as Response)
      // 3) re-fetch GET triggered by queryClient.invalidateQueries
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => recomputed,
      } as Response);

    render(<GraphPage />, { wrapper: createWrapper() });

    // Wait for the empty-state Recompute button to render.
    const button = await screen.findByRole('button', { name: /recompute/i });
    expect(button).toBeInTheDocument();

    // Click the button — fires the mutation.
    fireEvent.click(button);

    // Assert the POST to /api/pages/graph/refresh was made with method=POST.
    await waitFor(() => {
      const refreshCall = fetchSpy.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/api/pages/graph/refresh'),
      );
      expect(refreshCall).toBeDefined();
      expect((refreshCall![1] as RequestInit | undefined)?.method).toBe('POST');
    });

    // Assert cache invalidation triggered a re-fetch — the GET to
    // /api/pages/graph runs again (so the count is at least 2 across the
    // initial + the post-invalidation reload).
    await waitFor(() => {
      const getCalls = fetchSpy.mock.calls.filter(
        ([url, init]) => {
          const method = (init as RequestInit | undefined)?.method ?? 'GET';
          return typeof url === 'string' && url.includes('/api/pages/graph') && !url.includes('/refresh') && method === 'GET';
        },
      );
      expect(getCalls.length).toBeGreaterThanOrEqual(2);
    });

    // Reset role to avoid leaking into other tests.
    useAuthStore.setState({ user: null, accessToken: null });
  });

  it('renders error state with error message when fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ message: 'Internal Server Error' }),
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

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

    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

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

    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

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

    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

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

    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

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

    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

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

  it('uses a low globalScale threshold (0.3) for showing node labels', async () => {
    const ForceGraph2DMock = (await import('react-force-graph-2d')).default as unknown as ReturnType<typeof vi.fn>;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockGraphData,
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

    await waitFor(() => {
      expect(screen.getByTestId('mock-force-graph')).toBeInTheDocument();
    });

    // Get the nodeCanvasObject callback passed to ForceGraph2D
    const lastCall = ForceGraph2DMock.mock.calls[ForceGraph2DMock.mock.calls.length - 1];
    const props = lastCall[0];
    const nodeCanvasObject = props.nodeCanvasObject;
    expect(nodeCanvasObject).toBeDefined();

    // Create a mock canvas context
    const fillTextCalls: string[] = [];
    const mockCtx = {
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      roundRect: vi.fn(),
      fillText: vi.fn((...args: unknown[]) => fillTextCalls.push(args[0] as string)),
      set fillStyle(_v: string) { /* noop */ },
      set strokeStyle(_v: string) { /* noop */ },
      set lineWidth(_v: number) { /* noop */ },
      set font(_v: string) { /* noop */ },
      set textAlign(_v: string) { /* noop */ },
      set textBaseline(_v: string) { /* noop */ },
      set globalAlpha(_v: number) { /* noop */ },
    };

    // Call with globalScale=0.5 (above 0.3 threshold, below old 1.5 threshold)
    const testNode = { ...mockGraphData.nodes[0], x: 0, y: 0 };
    nodeCanvasObject(testNode, mockCtx, 0.5);

    // fillText should have been called for the label (in addition to the node circle)
    expect(fillTextCalls.length).toBeGreaterThan(0);
    // The label text should contain the node title (possibly truncated)
    expect(fillTextCalls.some((t: string) => t.includes('Getting Started'))).toBe(true);
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

    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

    await waitFor(() => {
      expect(screen.getByTestId('graph-view-clustered')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('graph-view-clustered'));

    await waitFor(() => {
      expect(screen.getByText(/1 clusters, 0 connections/)).toBeInTheDocument();
    });
  });

  // ---------- #360: ego-graph default + filter sidebar + URL state ----------

  it('renders the article-picker landing by default — does NOT fetch the global graph (#360)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockGraphData,
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper(['/graph']) });

    expect(await screen.findByTestId('graph-picker-landing')).toBeInTheDocument();
    expect(screen.getByTestId('graph-picker-input')).toBeInTheDocument();
    expect(screen.getByTestId('graph-show-full-btn')).toBeInTheDocument();

    // Critically: no global /pages/graph fetch should have fired in default mode.
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/pages/graph?'))).toBe(false);
  });

  it('clicking "Show full graph anyway" sets ?full=1 and fetches the global graph (#360)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockGraphData,
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper(['/graph']) });

    const escape = await screen.findByTestId('graph-show-full-btn');
    fireEvent.click(escape);

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes('/pages/graph?'))).toBe(true);
    });
  });

  it('focus mode sends edgeTypes and minScore filter params to /graph/local (#360)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ...mockGraphData, centerId: '1' }),
    } as Response);

    render(<GraphPage />, {
      wrapper: createWrapper([
        '/graph?focus=1&edgeTypes=embedding_similarity,explicit_link&minScore=0.6',
      ]),
    });

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
      const localCall = calls.find((u) => u.includes('/pages/1/graph/local'));
      expect(localCall).toBeDefined();
      expect(localCall!).toContain('edgeTypes=embedding_similarity%2Cexplicit_link');
      expect(localCall!).toContain('minScore=0.6');
    });
  });

  // ---------- #360: space filter is multi-select ----------

  it('hydrates multi-space filter from `?space=DEV,OPS` and forwards a comma-separated list (#360)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockGraphData,
    } as Response);

    render(<GraphPage />, {
      wrapper: createWrapper(['/graph?full=1&space=DEV,OPS']),
    });

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
      const globalCall = calls.find((u) => u.includes('/pages/graph?'));
      expect(globalCall).toBeDefined();
      // Encoded comma — the backend Zod schema splits on `,` after URL
      // decoding, so DEV and OPS both reach the route handler as separate
      // entries and are intersected with RBAC.
      expect(globalCall!).toContain('spaceKey=DEV%2COPS');
    });
  });

  it('toggles individual spaces via checkbox and updates the request URL (#360)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockGraphData,
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

    // Open the multi-select. Both spaces from mockGraphData (DEV, OPS) are
    // available because spaceKeys is derived from the loaded node set.
    // Note: each space-toggle changes the TanStack Query key and briefly
    // remounts the page (loading state), so we re-open the dropdown
    // between toggles. In real usage `placeholderData` would keep the UI
    // mounted; that's a follow-up.
    const trigger = await screen.findByTestId('graph-space-filter');
    fireEvent.click(trigger);

    const opsOption = await screen.findByTestId('graph-space-filter-option-OPS');
    fireEvent.click(opsOption);

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
      const globalCall = calls.find((u) => u.includes('spaceKey=OPS'));
      expect(globalCall).toBeDefined();
    });

    // Re-open the dropdown after the data refetch finishes and the page
    // remounts — then add DEV. The URL should now carry both spaces.
    const trigger2 = await screen.findByTestId('graph-space-filter');
    fireEvent.click(trigger2);
    const devOption = await screen.findByTestId('graph-space-filter-option-DEV');
    fireEvent.click(devOption);

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
      const both = calls.find((u) =>
        u.includes('spaceKey=OPS%2CDEV') || u.includes('spaceKey=DEV%2COPS'),
      );
      expect(both).toBeDefined();
    });
  });

  it('"Clear all" resets the multi-select selection and drops spaceKey from the URL (#360)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockGraphData,
    } as Response);

    render(<GraphPage />, {
      wrapper: createWrapper(['/graph?full=1&space=DEV,OPS']),
    });

    const trigger = await screen.findByTestId('graph-space-filter');
    fireEvent.click(trigger);

    const clear = await screen.findByTestId('graph-space-filter-clear');
    fireEvent.click(clear);

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
      const cleared = calls.find((u) => u.includes('/pages/graph?') && !u.includes('spaceKey='));
      expect(cleared).toBeDefined();
    });
  });
});
