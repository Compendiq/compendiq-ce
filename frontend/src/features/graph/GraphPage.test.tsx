import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
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
      expect(screen.getByText('Graph')).toBeInTheDocument();
    });

    // Should display node/edge counts
    expect(screen.getByText(/2 pages, 1 connections/)).toBeInTheDocument();

    // Should render ForceGraph2D
    expect(screen.getByTestId('mock-force-graph')).toBeInTheDocument();

    // Should show space legends (text also appears in filter dropdown)
    expect(screen.getAllByText('DEV').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('OPS').length).toBeGreaterThanOrEqual(1);
  });

  it('registers the mousemove tracker only while a node is hovered (perf)', async () => {
    const ForceGraph2DMock = (await import('react-force-graph-2d'))
      .default as unknown as ReturnType<typeof vi.fn>;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockGraphData,
    } as Response);

    const addSpy = vi.spyOn(window, 'addEventListener');
    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

    await waitFor(() => {
      expect(screen.getByTestId('mock-force-graph')).toBeInTheDocument();
    });

    // No global mousemove listener while nothing is hovered — moving the
    // cursor anywhere must not drive a per-event setState/re-render storm
    // on the heavy force-graph canvas.
    const before = addSpy.mock.calls.filter(([evt]) => evt === 'mousemove');
    expect(before).toHaveLength(0);

    // Hovering a node attaches the tracker so the tooltip can follow the
    // cursor; it detaches again when the hover ends.
    const props =
      ForceGraph2DMock.mock.calls[ForceGraph2DMock.mock.calls.length - 1][0];
    act(() => props.onNodeHover(mockGraphData.nodes[0], null));

    await waitFor(() => {
      const after = addSpy.mock.calls.filter(([evt]) => evt === 'mousemove');
      expect(after.length).toBeGreaterThan(0);
    });
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

    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

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

    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

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

    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

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

    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

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

  // ---------- #941: node labels must be theme-aware, not hardcoded white ----------

  // Helper: render the full graph, grab the nodeCanvasObject callback, invoke
  // it against a fillStyle-recording stub context and return the fillStyle
  // values captured during the individual-node label paint.
  async function captureLabelFillStyles(): Promise<string[]> {
    const ForceGraph2DMock = (await import('react-force-graph-2d'))
      .default as unknown as ReturnType<typeof vi.fn>;
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

    const lastCall =
      ForceGraph2DMock.mock.calls[ForceGraph2DMock.mock.calls.length - 1];
    const nodeCanvasObject = lastCall[0].nodeCanvasObject;

    const fillStyles: string[] = [];
    let currentFill = '';
    const mockCtx = {
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      roundRect: vi.fn(),
      measureText: vi.fn(() => ({ width: 10 })),
      // Record the fillStyle in effect at each fillText call — that is the
      // colour the label text is actually painted with.
      fillText: vi.fn(() => fillStyles.push(currentFill)),
      set fillStyle(v: string) { currentFill = v; },
      get fillStyle() { return currentFill; },
      set strokeStyle(_v: string) { /* noop */ },
      set lineWidth(_v: number) { /* noop */ },
      set font(_v: string) { /* noop */ },
      set textAlign(_v: string) { /* noop */ },
      set textBaseline(_v: string) { /* noop */ },
      set globalAlpha(_v: number) { /* noop */ },
    };

    const testNode = { ...mockGraphData.nodes[0], x: 0, y: 0 };
    nodeCanvasObject(testNode, mockCtx, 0.5);
    return fillStyles;
  }

  // The canvas resolves no CSS custom properties, so these inks are literals
  // mirroring --color-foreground per theme. Asserting the LUMINANCE rather than
  // the exact rgba triple keeps the test about the thing that matters — the
  // label is dark on light and light on dark — so a palette retune does not
  // fail it, but painting the wrong theme's ink still does.
  function labelLuminance(fill: string): number {
    const [r, g, b] = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/
      .exec(fill)!
      .slice(1, 4)
      .map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  it('paints node labels in a dark ink on the light theme (#941)', async () => {
    const { useThemeStore } = await import('../../stores/theme-store');
    act(() => useThemeStore.getState().setTheme('paper'));

    const fillStyles = await captureLabelFillStyles();

    // The label is painted after the node circle; on the light theme its ink
    // must be dark — a light label is invisible on the pale surface.
    const labelFill = fillStyles[fillStyles.length - 1];
    expect(labelFill).toBeDefined();
    expect(labelLuminance(labelFill)).toBeLessThan(0.2);

    act(() => useThemeStore.getState().setTheme('graphite'));
  });

  it('keeps node labels light on the dark theme (#941)', async () => {
    const { useThemeStore } = await import('../../stores/theme-store');
    act(() => useThemeStore.getState().setTheme('graphite'));

    const fillStyles = await captureLabelFillStyles();

    const labelFill = fillStyles[fillStyles.length - 1];
    expect(labelLuminance(labelFill)).toBeGreaterThan(0.7);
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

  /**
   * URL-routed fetch mock. The landing gate now probes /embeddings/status
   * before deciding what to render, so tests exercising the default `/graph`
   * entry must answer that URL with an explicit corpus shape instead of
   * letting a single canned body answer every request.
   */
  function mockFetchRoutes(routes: Array<[match: string, body: unknown]>) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const hit = routes.find(([match]) => url.includes(match));
      if (!hit) throw new Error(`Unexpected fetch in test: ${url}`);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => hit[1],
      } as Response;
    });
  }

  const largeEmbeddedStatus = {
    totalPages: 500, embeddedPages: 480, dirtyPages: 20, totalEmbeddings: 4000, isProcessing: false,
  };

  it('renders the article-picker landing for a large corpus — does NOT fetch the global graph (#360)', async () => {
    const fetchSpy = mockFetchRoutes([
      ['/embeddings/status', largeEmbeddedStatus],
      ['/pages/graph', mockGraphData],
    ]);

    render(<GraphPage />, { wrapper: createWrapper(['/graph']) });

    expect(await screen.findByTestId('graph-picker-landing')).toBeInTheDocument();
    expect(screen.getByTestId('graph-picker-input')).toBeInTheDocument();
    expect(screen.getByTestId('graph-show-full-btn')).toBeInTheDocument();
    // Embeddings exist, so no not-embedded notice sits above the picker.
    expect(screen.queryByTestId('graph-not-embedded-notice')).not.toBeInTheDocument();

    // Critically: no global /pages/graph fetch should have fired in default mode.
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/pages/graph?'))).toBe(false);
  });

  it('clicking "Show full graph anyway" sets ?full=1 and fetches the global graph (#360)', async () => {
    const fetchSpy = mockFetchRoutes([
      ['/embeddings/status', largeEmbeddedStatus],
      ['/pages/graph', mockGraphData],
    ]);

    render(<GraphPage />, { wrapper: createWrapper(['/graph']) });

    const escape = await screen.findByTestId('graph-show-full-btn');
    fireEvent.click(escape);

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes('/pages/graph?'))).toBe(true);
    });
  });

  // ---------- landing gate branches on real state (design critique P1) ----------
  // The old gate branched on nothing: every `/graph` visit without ?focus or
  // ?full got "Pick a page to explore — the knowledge graph is large", even at
  // 6 pages total, and even when the true blocker was that nothing was
  // embedded — a state that only surfaced after clicking through the escape
  // hatch. The gate now probes /embeddings/status first. The not-embedded
  // verdict renders a notice ABOVE the picker, never a replacement for it:
  // label, link and parent/child edges exist without embeddings (a
  // dimension-change re-embed truncates page_embeddings but leaves
  // page_relationships intact), so a dead-end empty state here would hide a
  // renderable graph.

  /** Two-node graph payload with no embeddings but a label edge — the
   * "relationships survive a re-embed" shape the gate must not hide. */
  const unembeddedNodes = [
    { id: '1', confluenceId: 'page-1', spaceKey: 'DEV', title: 'Getting Started', labels: ['howto'], embeddingStatus: 'pending', embeddingCount: 0, lastModifiedAt: null, parentId: null },
    { id: '2', confluenceId: 'page-2', spaceKey: 'DEV', title: 'Deployment Guide', labels: ['howto'], embeddingStatus: 'pending', embeddingCount: 0, lastModifiedAt: null, parentId: null },
  ];

  it('names configuration, not scale: a large unembedded corpus keeps the picker operable under a notice', async () => {
    const fetchSpy = mockFetchRoutes([
      ['/embeddings/status', { totalPages: 500, embeddedPages: 0, dirtyPages: 500, totalEmbeddings: 0, isProcessing: false }],
    ]);

    render(<GraphPage />, { wrapper: createWrapper(['/graph']) });

    // The notice names the real blocker, with its count labelled as a
    // workspace total — status counts pages the graph's space filter may
    // not, so it must never be presented as a graph node count.
    const notice = await screen.findByTestId('graph-not-embedded-notice');
    expect(notice.textContent).toMatch(/not embedded/i);
    expect(notice.textContent).toContain('500');
    expect(notice.textContent).toMatch(/pages you can access/);

    // NOTHING becomes unreachable behind the notice: search, local graphs
    // and the full-graph escape hatch all work without embeddings.
    expect(screen.getByTestId('graph-picker-landing')).toBeInTheDocument();
    expect(screen.getByTestId('graph-picker-input')).toBeInTheDocument();
    expect(screen.getByTestId('graph-show-full-btn')).toBeInTheDocument();

    // And no graph payload was fetched to reach the verdict.
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/pages/graph'))).toBe(false);
  });

  it('renders the graph directly for a small embedded corpus — no pick-a-page gate', async () => {
    mockFetchRoutes([
      ['/embeddings/status', { totalPages: 6, embeddedPages: 6, dirtyPages: 0, totalEmbeddings: 12, isProcessing: false }],
      ['/pages/graph', mockGraphData],
    ]);

    render(<GraphPage />, { wrapper: createWrapper(['/graph']) });

    expect(await screen.findByTestId('mock-force-graph')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-picker-landing')).not.toBeInTheDocument();
  });

  it('a small unembedded corpus renders the graph route directly — label/link/parent edges need no embeddings', async () => {
    mockFetchRoutes([
      ['/embeddings/status', { totalPages: 2, embeddedPages: 0, dirtyPages: 2, totalEmbeddings: 0, isProcessing: false }],
      ['/pages/graph', {
        nodes: unembeddedNodes,
        edges: [{ source: '1', target: '2', type: 'label_overlap', score: 1 }],
        meta: { pagesTotal: 2, pagesEmbedded: 0, relationshipsTotal: 1, relationshipsByType: { label_overlap: 1 } },
      }],
    ]);

    render(<GraphPage />, { wrapper: createWrapper(['/graph']) });

    // Zero embeddings does NOT mean nothing to render.
    expect(await screen.findByTestId('mock-force-graph')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-picker-landing')).not.toBeInTheDocument();
  });

  it('a small unembedded corpus with no relationships reaches the real not-embedded empty state', async () => {
    mockFetchRoutes([
      ['/embeddings/status', { totalPages: 2, embeddedPages: 0, dirtyPages: 2, totalEmbeddings: 0, isProcessing: false }],
      ['/pages/graph', {
        nodes: unembeddedNodes,
        edges: [],
        meta: { pagesTotal: 2, pagesEmbedded: 0, relationshipsTotal: 0, relationshipsByType: {} },
      }],
    ]);

    render(<GraphPage />, { wrapper: createWrapper(['/graph']) });

    // Graph-scoped meta, fetched for real — never synthesized from the probe.
    expect(await screen.findByText(/Pages not embedded yet/)).toBeInTheDocument();
    expect(screen.getByText(/2 pages · 0 embedded · 0 relationships/)).toBeInTheDocument();
  });

  it('renders the graph at exactly the 50-page limit — the boundary is inclusive', async () => {
    mockFetchRoutes([
      ['/embeddings/status', { totalPages: 50, embeddedPages: 50, dirtyPages: 0, totalEmbeddings: 100, isProcessing: false }],
      ['/pages/graph', mockGraphData],
    ]);

    render(<GraphPage />, { wrapper: createWrapper(['/graph']) });

    expect(await screen.findByTestId('mock-force-graph')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-picker-landing')).not.toBeInTheDocument();
  });

  it('keeps the gate at 51 pages — one past the limit', async () => {
    const fetchSpy = mockFetchRoutes([
      ['/embeddings/status', { totalPages: 51, embeddedPages: 51, dirtyPages: 0, totalEmbeddings: 102, isProcessing: false }],
    ]);

    render(<GraphPage />, { wrapper: createWrapper(['/graph']) });

    expect(await screen.findByTestId('graph-picker-landing')).toBeInTheDocument();
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/pages/graph'))).toBe(false);
  });

  it('falls back to the picker when the status probe fails — degraded, never a dead end', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/embeddings/status')) {
        return {
          ok: false,
          status: 500,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ message: 'status unavailable' }),
        } as Response;
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });

    render(<GraphPage />, { wrapper: createWrapper(['/graph']) });

    expect(await screen.findByTestId('graph-picker-landing')).toBeInTheDocument();
    // No verdict was reached, so no not-embedded claim is invented…
    expect(screen.queryByTestId('graph-not-embedded-notice')).not.toBeInTheDocument();
    // …and no graph fetch fired either.
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/pages/graph'))).toBe(false);
  });

  it('holds a probe card — not the picker, not a graph promise — while the first probe attempt is in flight', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));

    render(<GraphPage />, { wrapper: createWrapper(['/graph']) });

    // No picker flash for a corpus the probe may reveal as small…
    expect(screen.queryByTestId('graph-picker-landing')).not.toBeInTheDocument();
    // …and the card names the probe instead of promising a graph the
    // verdict may decline to load.
    expect(screen.getByText('Checking your knowledge base…')).toBeInTheDocument();
    expect(screen.queryByText('Loading knowledge graph...')).not.toBeInTheDocument();
  });

  it('latches the skip-gate decision — a status poll crossing the limit must not yank the graph', async () => {
    mockFetchRoutes([
      ['/embeddings/status', { totalPages: 6, embeddedPages: 6, dirtyPages: 0, totalEmbeddings: 12, isProcessing: false }],
      ['/pages/graph', mockGraphData],
    ]);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <LazyMotion features={domAnimation}>
          <MemoryRouter initialEntries={['/graph']}>
            <GraphPage />
          </MemoryRouter>
        </LazyMotion>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('mock-force-graph')).toBeInTheDocument();

    // The status query re-polls every 3s while an embedding pass is
    // processing; simulate the corpus crossing the limit mid-visit through
    // the query cache — the same write a poll response performs.
    act(() => {
      queryClient.setQueryData(['embeddings', 'status'], {
        totalPages: 60, embeddedPages: 60, dirtyPages: 0, totalEmbeddings: 120, isProcessing: true,
      });
    });
    // TanStack notifies subscribers through its scheduler, not synchronously
    // inside the act() above — flush a macrotask so the re-render (if any)
    // has landed before asserting that nothing swapped. Without this the
    // assertions run ahead of the update and pass even without the latch.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Still the graph — never the picker — for the rest of the visit.
    expect(screen.getByTestId('mock-force-graph')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-picker-landing')).not.toBeInTheDocument();
  });

  // ---------- #1257 post-review fixes (batch code review) ----------

  // F-A: the probe card had no exit for a fetch that never SETTLES. Offline,
  // TanStack's networkMode 'online' pauses the query (fetchStatus 'paused',
  // failureCount frozen at 0); a hung connection stays pending forever. Both
  // must fall through to the picker — static content that works without the
  // verdict — instead of pinning /graph on "Checking your knowledge base…".

  it('renders the picker, not a stuck probe card, when the probe is paused offline (F-A)', async () => {
    onlineManager.setOnline(false);
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));

      render(<GraphPage />, { wrapper: createWrapper(['/graph']) });

      expect(await screen.findByTestId('graph-picker-landing')).toBeInTheDocument();
      expect(screen.queryByText('Checking your knowledge base…')).not.toBeInTheDocument();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it('bounds the pending probe: a hung status request falls through to the picker (F-A)', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));

      render(<GraphPage />, { wrapper: createWrapper(['/graph']) });

      // The card holds while the pending window is open…
      expect(screen.getByText('Checking your knowledge base…')).toBeInTheDocument();

      // …and a request still unsettled past PROBE_PENDING_TIMEOUT_MS (3s)
      // stops holding the screen hostage.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });

      expect(screen.getByTestId('graph-picker-landing')).toBeInTheDocument();
      expect(screen.queryByText('Checking your knowledge base…')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // F-C(1): totalPages === 0 is what the probe reads mid-first-sync, so it
  // must never latch "small" — the one-way latch would then pin the growing
  // global graph open as the corpus passed 50, 500, 5000 until route exit.

  it('never latches "small" on totalPages === 0 — first sync must not pin the graph open (F-C)', async () => {
    mockFetchRoutes([
      ['/embeddings/status', { totalPages: 0, embeddedPages: 0, dirtyPages: 0, totalEmbeddings: 0, isProcessing: false }],
      ['/pages/graph', mockGraphData],
    ]);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <LazyMotion features={domAnimation}>
          <MemoryRouter initialEntries={['/graph']}>
            <GraphPage />
          </MemoryRouter>
        </LazyMotion>
      </QueryClientProvider>,
    );

    // A resolved 0 keeps the picker — no skip, no graph fetch commitment.
    expect(await screen.findByTestId('graph-picker-landing')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-force-graph')).not.toBeInTheDocument();

    // The poll then discovers a corpus already past the limit. Had 0 latched
    // "small", this would render the hairball; it must stay the picker.
    act(() => {
      queryClient.setQueryData(['embeddings', 'status'], {
        totalPages: 60, embeddedPages: 10, dirtyPages: 50, totalEmbeddings: 20, isProcessing: true,
      });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByTestId('graph-picker-landing')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-force-graph')).not.toBeInTheDocument();
  });

  it('latches only once the poll resolves a real count within [1, limit] (F-C)', async () => {
    mockFetchRoutes([
      ['/embeddings/status', { totalPages: 0, embeddedPages: 0, dirtyPages: 0, totalEmbeddings: 0, isProcessing: false }],
      ['/pages/graph', mockGraphData],
    ]);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <LazyMotion features={domAnimation}>
          <MemoryRouter initialEntries={['/graph']}>
            <GraphPage />
          </MemoryRouter>
        </LazyMotion>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('graph-picker-landing')).toBeInTheDocument();

    // First sync lands the corpus inside the limit — NOW the skip engages.
    act(() => {
      queryClient.setQueryData(['embeddings', 'status'], {
        totalPages: 6, embeddedPages: 6, dirtyPages: 0, totalEmbeddings: 12, isProcessing: false,
      });
    });

    expect(await screen.findByTestId('mock-force-graph')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-picker-landing')).not.toBeInTheDocument();
  });

  // F-C(2): the status count is a PROXY (its visibility predicate and the
  // graph's space_key-only population are non-nested), so a proxy-approved
  // direct render can fetch a multi-hundred-node graph. The response's exact
  // node count is the authority: over the limit, fall back to the picker —
  // unless the user explicitly opted in.

  /** 51 nodes — one past SMALL_GRAPH_NODE_LIMIT (50). */
  const oversizedGraphPayload = {
    nodes: Array.from({ length: 51 }, (_, i) => ({
      id: String(i + 1),
      confluenceId: `page-${i + 1}`,
      spaceKey: 'DEV',
      title: `Page ${i + 1}`,
      labels: [],
      embeddingStatus: 'embedded',
      embeddingCount: 1,
      lastModifiedAt: null,
      parentId: null,
    })),
    edges: [{ source: '1', target: '2', type: 'label_overlap', score: 1 }],
  };

  it('falls back to the picker when a proxy-approved fetch exceeds the node limit (F-C)', async () => {
    const fetchSpy = mockFetchRoutes([
      // The proxy says 40 — under the limit, so the gate is skipped…
      ['/embeddings/status', { totalPages: 40, embeddedPages: 40, dirtyPages: 0, totalEmbeddings: 80, isProcessing: false }],
      // …but the graph's own population comes back at 51.
      ['/pages/graph', oversizedGraphPayload],
    ]);

    render(<GraphPage />, { wrapper: createWrapper(['/graph']) });

    expect(await screen.findByTestId('graph-picker-landing')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-force-graph')).not.toBeInTheDocument();

    // This is the POST-fetch guard, not the pre-gate: the global fetch ran.
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/pages/graph?'))).toBe(true);

    // The escape hatch still works from the fallback picker: opting in
    // renders whatever comes back, hairball included.
    fireEvent.click(screen.getByTestId('graph-show-full-btn'));
    expect(await screen.findByTestId('mock-force-graph')).toBeInTheDocument();
  });

  it('the explicit ?full=1 opt-in keeps rendering an over-limit graph (F-C)', async () => {
    mockFetchRoutes([
      ['/embeddings/status', { totalPages: 40, embeddedPages: 40, dirtyPages: 0, totalEmbeddings: 80, isProcessing: false }],
      ['/pages/graph', oversizedGraphPayload],
    ]);

    render(<GraphPage />, { wrapper: createWrapper(['/graph?full=1']) });

    expect(await screen.findByTestId('mock-force-graph')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-picker-landing')).not.toBeInTheDocument();
  });

  // F-D: once the latch renders the graph, the status query's 3s processing
  // poll bought nothing — each result forced a full canvas repaint. The poll
  // gates off with the latch; the picker branch keeps live status.

  it('stops the status poll once the small-corpus latch renders the graph (F-D)', async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = mockFetchRoutes([
        ['/embeddings/status', { totalPages: 6, embeddedPages: 3, dirtyPages: 3, totalEmbeddings: 6, isProcessing: true }],
        ['/pages/graph', mockGraphData],
      ]);

      render(<GraphPage />, { wrapper: createWrapper(['/graph']) });

      // Flush the probe → latch → graph-fetch chain without waitFor (which
      // cannot poll under fake timers).
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
      }
      expect(screen.getByTestId('mock-force-graph')).toBeInTheDocument();

      const statusCalls = () =>
        fetchSpy.mock.calls.filter(([u]) => String(u).includes('/embeddings/status')).length;
      const before = statusCalls();

      // isProcessing:true means a live query would re-poll every 3s. Three
      // intervals later, a gated query has fired nothing new.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(statusCalls()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the status poll live on the picker branch while a pass is processing (F-D)', async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = mockFetchRoutes([
        ['/embeddings/status', { totalPages: 500, embeddedPages: 10, dirtyPages: 490, totalEmbeddings: 20, isProcessing: true }],
      ]);

      render(<GraphPage />, { wrapper: createWrapper(['/graph']) });

      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
      }
      expect(screen.getByTestId('graph-picker-landing')).toBeInTheDocument();

      const statusCalls = () =>
        fetchSpy.mock.calls.filter(([u]) => String(u).includes('/embeddings/status')).length;
      const before = statusCalls();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_500);
      });
      expect(statusCalls()).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
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

  // #1218 — this page's root is `h-full`, so AppLayout's min-h-0 chain clamps
  // it to the scrollport, and the filter row with it. The sidebar is a
  // cross-axis-stretched flex item inside that row, so its height is the row's
  // and its content can exceed it; carrying an nm-card border and no overflow,
  // the label chips painted straight through the card's bottom edge onto the
  // page background (measured at 1440x560 as a 39px spill in a headless
  // Chromium fixture, gone with this class, with the card's own scroller
  // taking over). The graph container beside it has always been
  // overflow-hidden — this makes the pair consistent.
  //
  // jsdom performs no layout, so the class is what can be asserted here; the
  // spill itself has no height in this environment.
  it('the filter sidebar scrolls inside its card rather than spilling past it (#1218)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ...mockGraphData, centerId: '1' }),
    } as Response);

    render(<GraphPage />, { wrapper: createWrapper(['/graph?focus=1']) });

    const sidebar = await screen.findByTestId('graph-filter-sidebar');
    expect(sidebar.className).toContain('overflow-y-auto');
  });
});
