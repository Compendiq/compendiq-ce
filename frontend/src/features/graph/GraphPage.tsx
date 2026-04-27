import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { m } from 'framer-motion';
import ForceGraph2D from 'react-force-graph-2d';
import { toast } from 'sonner';
import { ZoomIn, ZoomOut, Maximize, RefreshCw, Info, Layers, Grid3x3, Filter, Settings, Loader2 } from 'lucide-react';
import { cn } from '../../shared/lib/cn';
import { useAuthStore } from '../../stores/auth-store';
import { useGraphData, useLocalGraphData, useRefreshGraph } from './graph-hooks';

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
  // #362: parent_child edges get a distinct hue and higher opacity so the
  // hierarchy is legible against the semantic-similarity haze.
  parent_child: 'rgba(232, 176, 106, 0.7)',
  cluster_relationship: 'rgba(171, 130, 230, 0.4)',
};

const MAX_TOOLTIP_LABELS = 5;

// ---------- Component ----------

export function GraphPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Read initial state from URL search params
  const focusPageId = searchParams.get('focus') ?? undefined;
  const initialView = (searchParams.get('view') as ViewMode) || 'individual';

  const [viewMode, setViewMode] = useState<ViewMode>(focusPageId ? 'individual' : initialView);
  const [filterSpace, setFilterSpace] = useState<string | undefined>(searchParams.get('space') ?? undefined);

  // Use local graph when focusing on a specific page
  const globalQuery = useGraphData(viewMode, filterSpace);
  const localQuery = useLocalGraphData(focusPageId);
  const activeQuery = focusPageId ? localQuery : globalQuery;

  const { data, isLoading, error, refetch } = activeQuery;

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
        setViewMode('individual');
        setFilterSpace(node.spaceKey);
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

  // #358: differentiate empty states using meta counts so users get an
  // actionable message instead of a generic "no pages found".
  if (!data || data.nodes.length === 0 || (data.meta && data.meta.relationshipsTotal === 0)) {
    return <GraphEmptyState meta={data?.meta} />;
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
            {filterSpace && ` in ${filterSpace}`}
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

          {/* Space filter */}
          {!focusPageId && spaceKeys.length > 1 && (
            <div className="relative">
              <select
                value={filterSpace ?? ''}
                onChange={(e) => setFilterSpace(e.target.value || undefined)}
                className="nm-icon-button appearance-none py-2 pl-8 pr-3 text-xs"
                data-testid="graph-space-filter"
                aria-label="Filter by space"
              >
                <option value="">All spaces</option>
                {spaceKeys.map((sk) => (
                  <option key={sk} value={sk}>{sk}</option>
                ))}
              </select>
              <Filter size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            </div>
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
    </m.div>
  );
}


// ---------- Empty-state branches (#358) ----------

interface GraphEmptyStateProps {
  meta: import('./graph-hooks').GraphMeta | undefined;
}

/**
 * Differentiated empty state for the knowledge graph. Picks a message based
 * on the meta counts so users know which step they're stuck at:
 *   - no spaces accessible (RBAC)            → check sync settings
 *   - no pages embedded yet                  → embed pages from Settings → LLM
 *   - embedded but no relationships computed → admin can press Recompute
 * Falls back to a generic message if meta is missing (older backend).
 */
function GraphEmptyState({ meta }: GraphEmptyStateProps) {
  const role = useAuthStore((s) => s.user?.role);
  const isAdmin = role === 'admin';
  const refresh = useRefreshGraph();

  const onRecompute = async () => {
    try {
      const res = await refresh.mutateAsync();
      toast.success(`Graph relationships recomputed — ${res.edges} edges`);
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Failed to recompute graph';
      toast.error(msg);
    }
  };

  let title = 'No pages found';
  let body =
    'Sync a Confluence space and run embeddings to see the knowledge graph.';

  if (meta) {
    if (meta.pagesTotal === 0) {
      title = 'No accessible pages in your spaces';
      body =
        'Sync a Confluence space or check that your role grants access to at least one space, then return here.';
    } else if (meta.pagesEmbedded === 0) {
      title = 'Pages not embedded yet';
      body =
        'Pages exist but no embeddings have been generated. Configure an embedding provider in Settings → LLM, then run an embedding pass.';
    } else if (meta.relationshipsTotal === 0) {
      title = 'Embedded — but no relationships computed yet';
      body = isAdmin
        ? 'Press Recompute below to build the relationship graph from current embeddings.'
        : 'Ask an admin to recompute the relationship graph (Settings → Knowledge → Graph).';
    }
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div className="nm-card flex flex-col items-center gap-4 p-8 text-center max-w-md" data-testid="graph-empty-state">
        <Info className="h-8 w-8 text-muted-foreground" />
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
        {meta && (
          <p className="text-xs text-muted-foreground/70">
            {meta.pagesTotal} pages · {meta.pagesEmbedded} embedded · {meta.relationshipsTotal} relationships
          </p>
        )}
        {isAdmin && meta && meta.pagesEmbedded > 0 && meta.relationshipsTotal === 0 && (
          <button
            onClick={onRecompute}
            disabled={refresh.isPending}
            className="nm-button-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
            data-testid="graph-recompute-btn"
          >
            {refresh.isPending ? (
              <><Loader2 size={14} className="animate-spin" /> Recomputing…</>
            ) : (
              <><Settings size={14} /> Recompute relationships</>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
