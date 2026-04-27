import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { m } from 'framer-motion';
import ForceGraph2D from 'react-force-graph-2d';
import { ZoomIn, ZoomOut, Maximize, RefreshCw, Info, Layers, Grid3x3, Filter, Search, X } from 'lucide-react';
import { cn } from '../../shared/lib/cn';
import { useSearch } from '../../shared/hooks/use-standalone';
import { useGraphData, useLocalGraphData, type LocalGraphFilters } from './graph-hooks';

// ---------- Types ----------

interface GraphNode {
  id: string;
  confluenceId?: string | null;
  spaceKey: string;
  title: string;
  labels: string[];
  embeddingStatus: string;
  embeddingCount: number;
  lastModifiedAt: string | null;
  parentId?: string | null;
  // Force-graph internal fields
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

interface ClusterNode {
  id: string;
  type: 'cluster';
  spaceKey: string;
  title: string;
  articleCount: number;
  pageIds: number[];
  // Force-graph internal fields
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

type ViewMode = 'individual' | 'clustered';

function isClusterNode(node: GraphNode | ClusterNode): node is ClusterNode {
  return 'type' in node && node.type === 'cluster';
}

// ---------- Helpers ----------

const SPACE_COLORS = [
  '#7c8cf5', '#5cc9a7', '#f59e42', '#e879a8', '#64b5f6',
  '#ab82e6', '#4dd0a1', '#f4c84b', '#e57373', '#81d4fa',
  '#ce93d8', '#a5d6a7',
];

function getSpaceColor(spaceKey: string, spaceKeys: string[]): string {
  const idx = spaceKeys.indexOf(spaceKey);
  return SPACE_COLORS[idx % SPACE_COLORS.length] ?? '#7c8cf5';
}

const EDGE_COLORS: Record<string, string> = {
  embedding_similarity: 'rgba(124, 140, 245, 0.35)',
  label_overlap: 'rgba(92, 201, 167, 0.45)',
  explicit_link: 'rgba(245, 158, 66, 0.5)',
  cluster_relationship: 'rgba(171, 130, 230, 0.4)',
};

const MAX_TOOLTIP_LABELS = 5;

// ---------- Component ----------

export function GraphPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Read initial state from URL search params (#360: shareable views)
  const focusPageId = searchParams.get('focus') ?? undefined;
  const initialView = (searchParams.get('view') as ViewMode) || 'individual';

  const [viewMode, setViewMode] = useState<ViewMode>(focusPageId ? 'individual' : initialView);
  // #360: space filter is now multi-select. Stored as a string[]; URL state
  // round-trips via comma-separated `?space=DEV,OPS`. Empty array == "no
  // filter" (RBAC fallback handled server-side).
  const initialFilterSpaces = (searchParams.get('space') ?? '').split(',').filter(Boolean);
  const [filterSpaces, setFilterSpaces] = useState<string[]>(initialFilterSpaces);

  // #360: filter sidebar state. All optional; mirrored to URL on change
  // so the view is shareable. Empty values = "no filter" (omitted from URL).
  const initialEdgeTypes = (searchParams.get('edgeTypes') ?? '').split(',').filter(Boolean);
  const initialMinScore = searchParams.get('minScore');
  const initialLabels = (searchParams.get('labels') ?? '').split(',').filter(Boolean);
  const initialShowFullGraph = searchParams.get('full') === '1';

  const [edgeTypes, setEdgeTypes] = useState<string[]>(initialEdgeTypes);
  const [minScore, setMinScore] = useState<number | undefined>(
    initialMinScore !== null ? Number.parseFloat(initialMinScore) : undefined,
  );
  const [labels, setLabels] = useState<string[]>(initialLabels);
  const showFilters = true;
  // The "global hairball" view is opt-in (#360). Either an explicit ?full=1
  // in the URL or the user clicking "Show full graph anyway" enables it.
  const [showFullGraph, setShowFullGraph] = useState<boolean>(initialShowFullGraph);

  // Mirror filter state to URL (#360 shareable views).
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const sync = (key: string, value: string | undefined | null) => {
      if (value === undefined || value === null || value === '') next.delete(key);
      else next.set(key, value);
    };
    sync('edgeTypes', edgeTypes.length > 0 ? edgeTypes.join(',') : '');
    sync('minScore', minScore !== undefined ? minScore.toString() : '');
    sync('labels', labels.length > 0 ? labels.join(',') : '');
    sync('full', showFullGraph ? '1' : '');
    // #360 multi-select: encode the space filter as a comma-separated list
    // so it round-trips through the URL the same way edgeTypes/labels do.
    sync('space', filterSpaces.length > 0 ? filterSpaces.join(',') : '');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeTypes, minScore, labels, showFullGraph, filterSpaces]);

  const filters = useMemo<LocalGraphFilters>(() => ({
    edgeTypes: edgeTypes.length > 0 ? edgeTypes : undefined,
    minScore,
    labels: labels.length > 0 ? labels : undefined,
  }), [edgeTypes, minScore, labels]);

  // #360: only fetch the global graph when the user opted into the
  // hairball view (otherwise we render an article picker instead).
  const wantsGlobal = !focusPageId && showFullGraph;
  const globalQuery = useGraphData(viewMode, filterSpaces, wantsGlobal);
  const localQuery = useLocalGraphData(focusPageId, filters);
  const activeQuery = focusPageId ? localQuery : (wantsGlobal ? globalQuery : null);

  const data = activeQuery?.data;
  const isLoading = activeQuery?.isLoading ?? false;
  const error = activeQuery?.error;
  const refetch = activeQuery?.refetch ?? (() => {});

  const graphRef = useRef<{ zoom: (k: number, ms?: number) => void; zoomToFit: (ms?: number, padding?: number) => void }>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [hoveredNode, setHoveredNode] = useState<(GraphNode | ClusterNode) | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const prefersReducedMotion = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDimensions({ width: Math.floor(width), height: Math.floor(height) });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Derive unique space keys
  const spaceKeys = useMemo(() => {
    if (!data?.nodes) return [];
    return [...new Set(data.nodes.map((n) => n.spaceKey))].sort();
  }, [data?.nodes]);

  // Build graph data for react-force-graph
  const graphData = useMemo(() => {
    if (!data) return { nodes: [], links: [] };
    return {
      nodes: data.nodes.map((n) => ({ ...n })),
      links: data.edges.map((e) => ({
        source: e.source,
        target: e.target,
        type: e.type,
        score: e.score,
      })),
    };
  }, [data]);

  const handleNodeClick = useCallback(
    (node: GraphNode | ClusterNode) => {
      if (isClusterNode(node)) {
        // Expand cluster: switch to individual view filtered by the cluster's space
        // (#360 multi-select — clicking a cluster scopes to that one space).
        setViewMode('individual');
        setFilterSpaces([node.spaceKey]);
        return;
      }
      if (node.id) navigate(`/pages/${node.id}`);
    },
    [navigate],
  );

  const handleNodeHover = useCallback(
    (node: (GraphNode | ClusterNode) | null, _prev: (GraphNode | ClusterNode) | null) => {
      setHoveredNode(node);
      document.body.style.cursor = node ? 'pointer' : 'default';
    },
    [],
  );

  useEffect(() => {
    return () => {
      document.body.style.cursor = 'default';
    };
  }, []);

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      setTooltipPos({ x: e.clientX, y: e.clientY });
    }
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  // Custom node rendering
  const nodeCanvasObject = useCallback(
    (node: GraphNode | ClusterNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const isHovered = hoveredNode?.id === node.id;
      const isCenter = data?.centerId === node.id;
      const color = getSpaceColor(node.spaceKey, spaceKeys);

      if (isClusterNode(node)) {
        // Cluster node: larger rounded rect with count badge
        const width = Math.max(40, Math.sqrt(node.articleCount) * 12);
        const height = width * 0.7;
        const radius = 8 / globalScale;

        ctx.beginPath();
        ctx.roundRect(x - width / 2, y - height / 2, width, height, radius);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.7;
        ctx.fill();
        ctx.globalAlpha = 1;

        // Thicker border for clusters
        ctx.strokeStyle = isHovered ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)';
        ctx.lineWidth = (isHovered ? 2.5 : 1.5) / globalScale;
        ctx.stroke();

        // Title
        const fontSize = Math.max(11 / globalScale, 1.5);
        ctx.font = `bold ${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        const truncated = node.title.length > 20 ? node.title.slice(0, 17) + '...' : node.title;
        ctx.fillText(truncated, x, y - 3 / globalScale);

        // Count badge
        const badgeFontSize = Math.max(9 / globalScale, 1.2);
        ctx.font = `${badgeFontSize}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillText(`${node.articleCount} articles`, x, y + fontSize);
        return;
      }

      // Individual node
      const label = node.title ?? '';
      const fontSize = Math.max(10 / globalScale, 1.5);
      const size = Math.max(3, Math.sqrt(node.embeddingCount || 1) * 2);

      // Node circle
      ctx.beginPath();
      ctx.arc(x, y, isHovered ? size * 1.4 : (isCenter ? size * 1.3 : size), 0, 2 * Math.PI, false);
      ctx.fillStyle = color;
      ctx.fill();

      if (isHovered || isCenter) {
        ctx.strokeStyle = isCenter ? 'rgba(245, 158, 66, 0.9)' : 'rgba(255,255,255,0.8)';
        ctx.lineWidth = (isCenter ? 2 : 1.5) / globalScale;
        ctx.stroke();
      }

      // Label (show when zoomed in or hovered)
      if (globalScale > 0.3 || isHovered || isCenter) {
        ctx.font = `${isHovered || isCenter ? 'bold ' : ''}${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        const truncated = label.length > 30 ? label.slice(0, 27) + '...' : label;
        ctx.fillText(truncated, x, y + size + 2 / globalScale);
      }
    },
    [spaceKeys, hoveredNode, data?.centerId],
  );

  const nodePointerAreaPaint = useCallback(
    (node: GraphNode | ClusterNode, paintColor: string, ctx: CanvasRenderingContext2D) => {
      if (isClusterNode(node)) {
        const width = Math.max(40, Math.sqrt(node.articleCount) * 12);
        const height = width * 0.7;
        ctx.fillStyle = paintColor;
        ctx.fillRect(
          (node.x ?? 0) - width / 2 - 2,
          (node.y ?? 0) - height / 2 - 2,
          width + 4,
          height + 4,
        );
        return;
      }
      const size = Math.max(3, Math.sqrt(node.embeddingCount || 1) * 2);
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, size + 2, 0, 2 * Math.PI, false);
      ctx.fillStyle = paintColor;
      ctx.fill();
    },
    [],
  );

  const zoomIn = useCallback(() => graphRef.current?.zoom(2, 300), []);
  const zoomOut = useCallback(() => graphRef.current?.zoom(0.5, 300), []);
  const fitAll = useCallback(() => graphRef.current?.zoomToFit(400, 40), []);

  // Compute clamped tooltip position
  const tooltipMaxH = 256; // 16rem = max-h-64
  const tooltipTop = Math.min(tooltipPos.y - 8, (typeof window !== 'undefined' ? window.innerHeight : 800) - tooltipMaxH - 16);
  const tooltipLeft = Math.min(tooltipPos.x + 12, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 280);

  // #360: when no article is focused and the user hasn't opted into the
  // global view, render an article picker instead of fetching a hairball.
  // This is the new default state for the Graph page — Obsidian/Logseq-style
  // local-graph-first UX that scales to large knowledge bases.
  if (!focusPageId && !showFullGraph) {
    return (
      <ArticlePickerLanding
        onPick={(pageId) => {
          const next = new URLSearchParams(searchParams);
          next.set('focus', pageId);
          setSearchParams(next, { replace: false });
        }}
        onShowFullGraph={() => setShowFullGraph(true)}
      />
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="nm-card flex flex-col items-center gap-4 p-8">
          <RefreshCw className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Loading knowledge graph...</p>
        </div>
      </div>
    );
  }

  // Error state -- show the error message for better debugging
  if (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return (
      <div className="flex h-full items-center justify-center">
        <div className="nm-card flex flex-col items-center gap-4 p-8 text-center max-w-md">
          <Info className="h-8 w-8 text-destructive" />
          <p className="text-destructive font-medium">Failed to load graph data</p>
          <p className="text-sm text-muted-foreground">{errorMessage}</p>
          <button onClick={() => refetch()} className="nm-icon-button text-sm" data-testid="graph-retry">
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Empty state
  if (!data || data.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="nm-card flex flex-col items-center gap-4 p-8 text-center">
          <Info className="h-8 w-8 text-muted-foreground" />
          <p className="text-muted-foreground">No pages found. Sync and embed pages to see the knowledge graph.</p>
        </div>
      </div>
    );
  }

  return (
    <m.div
      initial={prefersReducedMotion ? {} : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="flex h-full flex-col gap-4"
    >
      {/* Header bar */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Knowledge Graph</h1>
          <p className="text-sm text-muted-foreground">
            {data.nodes.length} {viewMode === 'clustered' ? 'clusters' : 'articles'}, {data.edges.length} connections
            {focusPageId && ' (local view)'}
            {filterSpaces.length > 0 && ` in ${filterSpaces.join(', ')}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          {!focusPageId && (
            <>
              <button
                onClick={() => setViewMode('individual')}
                className={cn(
                  'nm-icon-button p-2',
                  viewMode === 'individual' && 'bg-primary/15 text-primary',
                )}
                aria-label="Individual view"
                data-testid="graph-view-individual"
                title="Individual articles"
              >
                <Grid3x3 size={16} />
              </button>
              <button
                onClick={() => setViewMode('clustered')}
                className={cn(
                  'nm-icon-button p-2',
                  viewMode === 'clustered' && 'bg-primary/15 text-primary',
                )}
                aria-label="Cluster view"
                data-testid="graph-view-clustered"
                title="Topic clusters"
              >
                <Layers size={16} />
              </button>
            </>
          )}

          {/* Space filter — #360: multi-select. Native <details> gives us
              keyboard support, click-to-open/close, and ESC-closes for free
              without pulling a dropdown library. The button label
              summarises selection ("All spaces" / "DEV" / "DEV +1"). */}
          {!focusPageId && spaceKeys.length > 1 && (
            <SpaceMultiSelect
              spaceKeys={spaceKeys}
              selected={filterSpaces}
              onChange={setFilterSpaces}
            />
          )}

          {/* Clear focus */}
          {focusPageId && (
            <button
              onClick={() => navigate('/graph')}
              className="nm-icon-button px-3 py-2 text-xs"
              data-testid="graph-clear-focus"
            >
              Show all
            </button>
          )}

          <button onClick={zoomIn} className="nm-icon-button p-2" aria-label="Zoom in" data-testid="graph-zoom-in">
            <ZoomIn size={16} />
          </button>
          <button onClick={zoomOut} className="nm-icon-button p-2" aria-label="Zoom out" data-testid="graph-zoom-out">
            <ZoomOut size={16} />
          </button>
          <button onClick={fitAll} className="nm-icon-button p-2" aria-label="Fit to screen" data-testid="graph-fit">
            <Maximize size={16} />
          </button>
          <button
            onClick={() => refetch()}
            className="nm-icon-button p-2"
            aria-label="Refresh graph"
            data-testid="graph-refresh"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="font-medium">Spaces:</span>
        {spaceKeys.map((sk) => (
          <span key={sk} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: getSpaceColor(sk, spaceKeys) }}
            />
            {sk}
          </span>
        ))}
        <span className="ml-4 font-medium">Edges:</span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ backgroundColor: '#7c8cf5' }} />
          Similarity
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ backgroundColor: '#5cc9a7' }} />
          Labels
        </span>
      </div>

      {/* #360: filter sidebar appears alongside the graph in focus (ego)
          mode. The full-graph escape hatch keeps the legacy single-pane
          layout to minimise change for power users who opt in. */}
      <div className={cn('flex min-h-0 flex-1 gap-3', !focusPageId && 'block')}>
        {focusPageId && showFilters && (
          <GraphFilterSidebar
            edgeTypes={edgeTypes}
            onEdgeTypesChange={setEdgeTypes}
            minScore={minScore}
            onMinScoreChange={setMinScore}
            labels={labels}
            onLabelsChange={setLabels}
            availableLabels={Array.from(
              new Set(((data?.nodes ?? []) as GraphNode[]).flatMap((n) => n.labels ?? [])),
            ).sort()}
            onClearFocus={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('focus');
              setSearchParams(next, { replace: false });
            }}
          />
        )}

      {/* Graph container */}
      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border/50 bg-background/50"
        data-testid="graph-container"
      >
        <ForceGraph2D
          ref={graphRef as React.MutableRefObject<never>}
          graphData={graphData}
          width={dimensions.width}
          height={dimensions.height}
          nodeId="id"
          nodeCanvasObject={nodeCanvasObject}
          nodeCanvasObjectMode={() => 'replace'}
          nodePointerAreaPaint={nodePointerAreaPaint}
          nodeVal={(node: GraphNode | ClusterNode) =>
            isClusterNode(node) ? Math.max(5, node.articleCount) : Math.max(1, (node as GraphNode).embeddingCount)
          }
          linkColor={(link: { type?: string }) => EDGE_COLORS[link.type ?? 'embedding_similarity'] ?? 'rgba(255,255,255,0.1)'}
          linkWidth={(link: { score?: number }) => Math.max(0.5, (link.score ?? 0.5) * 3)}
          linkDirectionalParticles={0}
          onNodeClick={handleNodeClick}
          onNodeHover={handleNodeHover}
          enableZoomInteraction={true}
          enablePanInteraction={true}
          enableNodeDrag={true}
          cooldownTicks={prefersReducedMotion ? 0 : 100}
          warmupTicks={prefersReducedMotion ? 100 : 0}
          d3AlphaDecay={0.03}
          d3VelocityDecay={0.3}
          backgroundColor="transparent"
        />

        {/* Hover tooltip -- clamped to viewport with max-height and label truncation */}
        {hoveredNode && (
          <div
            className={cn(
              'pointer-events-none fixed z-50 max-w-xs rounded-lg border border-border/50',
              'bg-card/95 px-3 py-2 text-xs shadow-lg backdrop-blur-md',
              'max-h-64 overflow-y-auto',
            )}
            style={{
              left: tooltipLeft,
              top: tooltipTop,
            }}
            data-testid="graph-tooltip"
          >
            <p className="font-medium text-foreground">{hoveredNode.title}</p>
            <p className="text-muted-foreground">
              Space: {hoveredNode.spaceKey}
            </p>
            {isClusterNode(hoveredNode) ? (
              <p className="text-muted-foreground">
                Articles: {hoveredNode.articleCount}
              </p>
            ) : (
              <>
                {(hoveredNode as GraphNode).labels.length > 0 && (
                  <p className="text-muted-foreground">
                    Labels: {
                      (hoveredNode as GraphNode).labels.length > MAX_TOOLTIP_LABELS
                        ? (hoveredNode as GraphNode).labels.slice(0, MAX_TOOLTIP_LABELS).join(', ') +
                          ` +${(hoveredNode as GraphNode).labels.length - MAX_TOOLTIP_LABELS} more`
                        : (hoveredNode as GraphNode).labels.join(', ')
                    }
                  </p>
                )}
                <p className="text-muted-foreground">
                  Embeddings: {(hoveredNode as GraphNode).embeddingCount}
                </p>
              </>
            )}
          </div>
        )}
      </div>
      </div>
    </m.div>
  );
}

// ---------- Article picker landing (#360 default state) ----------

interface ArticlePickerLandingProps {
  onPick: (pageId: string) => void;
  onShowFullGraph: () => void;
}

/**
 * Default landing state for /graph (#360). Instead of force-rendering the
 * global article hairball — which is unusable past a few hundred pages — we
 * render a search field and let the user pick an entry-point article. The
 * graph then renders that article's ego graph (1-2 hops) via the existing
 * /graph/local endpoint.
 *
 * "Show full graph anyway" stays available as an opt-in escape hatch with a
 * warning so power users on small corpora aren't blocked.
 */
function ArticlePickerLanding({ onPick, onShowFullGraph }: ArticlePickerLandingProps) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { data, isLoading } = useSearch({ q: q.trim(), page: 1 });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = data?.items ?? [];

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="nm-card w-full max-w-xl p-6" data-testid="graph-picker-landing">
        <h2 className="mb-1 text-lg font-semibold">Pick an article to explore</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          The knowledge graph is large — start from one article and expand from
          there. The default view shows that article and its closest neighbours.
        </p>

        <div className="relative mb-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search articles by title…"
            className="w-full rounded-lg border border-border/40 bg-foreground/5 py-2 pl-9 pr-3 text-sm outline-none focus:ring-1 focus:ring-primary"
            data-testid="graph-picker-input"
          />
        </div>

        {q.trim().length < 2 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Type at least 2 characters to search.
          </p>
        ) : isLoading ? (
          <p className="py-6 text-center text-xs text-muted-foreground">Searching…</p>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground" data-testid="graph-picker-no-results">
            No articles match “{q}”.
          </p>
        ) : (
          <ul role="listbox" aria-label="Search results" className="max-h-72 space-y-1 overflow-y-auto" data-testid="graph-picker-results">
            {items.slice(0, 20).map((item: { id: number | string; title: string; spaceKey?: string }) => (
              <li key={String(item.id)}>
                <button
                  role="option"
                  aria-selected={false}
                  onClick={() => onPick(String(item.id))}
                  className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-foreground/5"
                  data-testid="graph-picker-result"
                >
                  <span className="truncate">{item.title}</span>
                  {item.spaceKey && (
                    <span className="ml-2 shrink-0 rounded bg-foreground/5 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {item.spaceKey}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-5 border-t border-border/30 pt-4 text-xs text-muted-foreground">
          <p>
            Want to see everything anyway? The full graph can be slow on large
            knowledge bases.
          </p>
          <button
            type="button"
            onClick={onShowFullGraph}
            className="mt-2 rounded-md bg-foreground/5 px-3 py-1.5 text-xs hover:bg-foreground/10"
            data-testid="graph-show-full-btn"
          >
            Show full graph anyway
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Filter sidebar (#360) ----------

interface FilterSidebarProps {
  edgeTypes: string[];
  onEdgeTypesChange: (next: string[]) => void;
  minScore: number | undefined;
  onMinScoreChange: (next: number | undefined) => void;
  labels: string[];
  onLabelsChange: (next: string[]) => void;
  availableLabels: string[];
  onClearFocus: () => void;
}

const EDGE_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'embedding_similarity', label: 'Similar (semantic)' },
  { value: 'label_overlap', label: 'Shared labels' },
  { value: 'explicit_link', label: 'Linked' },
  { value: 'parent_child', label: 'Parent / child' },
];

export function GraphFilterSidebar({
  edgeTypes,
  onEdgeTypesChange,
  minScore,
  onMinScoreChange,
  labels,
  onLabelsChange,
  availableLabels,
  onClearFocus,
}: FilterSidebarProps) {
  const toggleEdgeType = (value: string) => {
    if (edgeTypes.includes(value)) onEdgeTypesChange(edgeTypes.filter((t) => t !== value));
    else onEdgeTypesChange([...edgeTypes, value]);
  };

  const toggleLabel = (label: string) => {
    if (labels.includes(label)) onLabelsChange(labels.filter((l) => l !== label));
    else onLabelsChange([...labels, label]);
  };

  return (
    <aside
      className="nm-card w-60 shrink-0 space-y-4 p-4 text-xs"
      role="complementary"
      aria-label="Graph filters"
      data-testid="graph-filter-sidebar"
    >
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 font-semibold">
          <Filter size={12} /> Filters
        </h3>
        <button
          type="button"
          onClick={onClearFocus}
          className="rounded p-1 text-muted-foreground hover:bg-foreground/5"
          title="Pick a different article"
          data-testid="graph-clear-focus-btn"
        >
          <X size={12} />
        </button>
      </div>

      <div>
        <div className="mb-1.5 text-muted-foreground">Edge type</div>
        <div className="space-y-1">
          {EDGE_TYPE_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={edgeTypes.includes(opt.value)}
                onChange={() => toggleEdgeType(opt.value)}
                data-testid={`filter-edge-${opt.value}`}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between text-muted-foreground">
          <span>Minimum score</span>
          <span className="tabular-nums">{minScore !== undefined ? minScore.toFixed(2) : 'off'}</span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={minScore ?? 0}
          onChange={(e) => {
            const v = Number.parseFloat(e.target.value);
            onMinScoreChange(v === 0 ? undefined : v);
          }}
          className="w-full"
          aria-label="Minimum similarity score"
          data-testid="filter-min-score"
        />
      </div>

      {availableLabels.length > 0 && (
        <div>
          <div className="mb-1.5 text-muted-foreground">Labels</div>
          <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
            {availableLabels.map((label) => (
              <button
                key={label}
                type="button"
                onClick={() => toggleLabel(label)}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] transition-colors',
                  labels.includes(label)
                    ? 'bg-primary/20 text-primary'
                    : 'bg-foreground/5 text-muted-foreground hover:text-foreground',
                )}
                data-testid="filter-label-chip"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

// ---------- Space multi-select (#360) ----------

interface SpaceMultiSelectProps {
  spaceKeys: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}

/**
 * Multi-select dropdown for the header space filter (#360). Replaces the
 * legacy single-`<select>` so a user can scope the global graph to any
 * combination of spaces. Behaves like a popover: click the button to
 * open/close, click anywhere outside to dismiss, ESC also dismisses.
 *
 * The button label summarises the selection at a glance — "All spaces"
 * when nothing is picked, otherwise "<first> +N" — keeping the header
 * compact even for users with dozens of spaces.
 */
function SpaceMultiSelect({ spaceKeys, selected, onChange }: SpaceMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click + ESC, mirroring the rest of the app's neumorphic
  // dropdowns. Listening only while open keeps the cost negligible.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (sk: string) => {
    if (selected.includes(sk)) onChange(selected.filter((s) => s !== sk));
    else onChange([...selected, sk]);
  };

  const label = selected.length === 0
    ? 'All spaces'
    : selected.length === 1
      ? selected[0]
      : `${selected[0]} +${selected.length - 1}`;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="nm-icon-button flex items-center gap-1.5 px-3 py-2 text-xs"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Filter by space (multi-select)"
        data-testid="graph-space-filter"
      >
        <Filter size={12} />
        <span>{label}</span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          className="nm-card absolute right-0 top-full z-20 mt-1 max-h-64 w-44 overflow-y-auto p-2 text-xs"
          data-testid="graph-space-filter-menu"
        >
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mb-1 w-full rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-foreground/5"
              data-testid="graph-space-filter-clear"
            >
              Clear all
            </button>
          )}
          {spaceKeys.map((sk) => {
            const checked = selected.includes(sk);
            return (
              <label
                key={sk}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-foreground/5"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(sk)}
                  data-testid={`graph-space-filter-option-${sk}`}
                />
                <span className="font-mono text-[11px]">{sk}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
