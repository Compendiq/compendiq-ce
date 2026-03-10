import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { m } from 'framer-motion';
import ForceGraph2D from 'react-force-graph-2d';
import { ZoomIn, ZoomOut, Maximize, RefreshCw, Info } from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';

// ---------- Types ----------

interface GraphNode {
  id: string;
  spaceKey: string;
  title: string;
  labels: string[];
  embeddingStatus: string;
  embeddingCount: number;
  lastModifiedAt: string | null;
  // Force-graph internal fields
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

interface GraphEdge {
  source: string;
  target: string;
  type: 'embedding_similarity' | 'label_overlap' | 'explicit_link';
  score: number;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------- Helpers ----------

// Deterministic color palette for spaces (distinct hues via oklch-inspired hex palette)
const SPACE_COLORS = [
  '#7c8cf5', // blue-purple
  '#5cc9a7', // teal
  '#f59e42', // orange
  '#e879a8', // pink
  '#64b5f6', // sky blue
  '#ab82e6', // violet
  '#4dd0a1', // green
  '#f4c84b', // yellow
  '#e57373', // red
  '#81d4fa', // light blue
  '#ce93d8', // lavender
  '#a5d6a7', // light green
];

function getSpaceColor(spaceKey: string, spaceKeys: string[]): string {
  const idx = spaceKeys.indexOf(spaceKey);
  return SPACE_COLORS[idx % SPACE_COLORS.length];
}

const EDGE_COLORS: Record<string, string> = {
  embedding_similarity: 'rgba(124, 140, 245, 0.35)',
  label_overlap: 'rgba(92, 201, 167, 0.45)',
  explicit_link: 'rgba(245, 158, 66, 0.5)',
};

// ---------- Hook ----------

function useGraphData() {
  return useQuery<GraphData>({
    queryKey: ['pages', 'graph'],
    queryFn: () => apiFetch('/pages/graph'),
    staleTime: 60_000,
  });
}

// ---------- Component ----------

export function GraphPage() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useGraphData();
  const graphRef = useRef<{ zoom: (k: number, ms?: number) => void; zoomToFit: (ms?: number, padding?: number) => void }>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  // Respect prefers-reduced-motion
  const prefersReducedMotion = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  // Resize observer for responsive dimensions
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

  // Derive unique space keys for color assignment
  const spaceKeys = useMemo(() => {
    if (!data?.nodes) return [];
    return [...new Set(data.nodes.map((n) => n.spaceKey))].sort();
  }, [data?.nodes]);

  // Build graph data in the format react-force-graph expects
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
    (node: GraphNode) => {
      if (node.id) navigate(`/pages/${node.id}`);
    },
    [navigate],
  );

  const handleNodeHover = useCallback(
    (node: GraphNode | null, _prev: GraphNode | null) => {
      setHoveredNode(node);
      document.body.style.cursor = node ? 'pointer' : 'default';
    },
    [],
  );

  // Reset cursor on unmount to avoid stale pointer cursor leaking to other pages
  useEffect(() => {
    return () => {
      document.body.style.cursor = 'default';
    };
  }, []);

  // Track mouse position for tooltip
  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      setTooltipPos({ x: e.clientX, y: e.clientY });
    }
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  // Custom node rendering with canvas
  const nodeCanvasObject = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const label = node.title ?? '';
      const fontSize = Math.max(10 / globalScale, 1.5);
      const size = Math.max(3, Math.sqrt(node.embeddingCount || 1) * 2);
      const color = getSpaceColor(node.spaceKey, spaceKeys);
      const isHovered = hoveredNode?.id === node.id;
      const x = node.x ?? 0;
      const y = node.y ?? 0;

      // Node circle
      ctx.beginPath();
      ctx.arc(x, y, isHovered ? size * 1.4 : size, 0, 2 * Math.PI, false);
      ctx.fillStyle = color;
      ctx.fill();

      if (isHovered) {
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 1.5 / globalScale;
        ctx.stroke();
      }

      // Label (show when zoomed in or hovered)
      if (globalScale > 1.5 || isHovered) {
        ctx.font = `${isHovered ? 'bold ' : ''}${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        const truncated = label.length > 30 ? label.slice(0, 27) + '...' : label;
        ctx.fillText(truncated, x, y + size + 2 / globalScale);
      }
    },
    [spaceKeys, hoveredNode],
  );

  // Node hit area for pointer detection
  const nodePointerAreaPaint = useCallback(
    (node: GraphNode, paintColor: string, ctx: CanvasRenderingContext2D) => {
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

  // Loading state
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="glass-card flex flex-col items-center gap-4 p-8">
          <RefreshCw className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Loading knowledge graph...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="glass-card flex flex-col items-center gap-4 p-8">
          <p className="text-destructive">Failed to load graph data</p>
          <button onClick={() => refetch()} className="glass-button-ghost text-sm">
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
        <div className="glass-card flex flex-col items-center gap-4 p-8 text-center">
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
            {data.nodes.length} articles, {data.edges.length} connections
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={zoomIn} className="glass-button-ghost p-2" aria-label="Zoom in" data-testid="graph-zoom-in">
            <ZoomIn size={16} />
          </button>
          <button onClick={zoomOut} className="glass-button-ghost p-2" aria-label="Zoom out" data-testid="graph-zoom-out">
            <ZoomOut size={16} />
          </button>
          <button onClick={fitAll} className="glass-button-ghost p-2" aria-label="Fit to screen" data-testid="graph-fit">
            <Maximize size={16} />
          </button>
          <button
            onClick={() => refetch()}
            className="glass-button-ghost p-2"
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
          nodeVal={(node: GraphNode) => Math.max(1, node.embeddingCount)}
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

        {/* Hover tooltip */}
        {hoveredNode && (
          <div
            className={cn(
              'pointer-events-none fixed z-50 max-w-xs rounded-lg border border-border/50',
              'bg-card/95 px-3 py-2 text-xs shadow-lg backdrop-blur-md',
            )}
            style={{
              left: tooltipPos.x + 12,
              top: tooltipPos.y - 8,
            }}
            data-testid="graph-tooltip"
          >
            <p className="font-medium text-foreground">{hoveredNode.title}</p>
            <p className="text-muted-foreground">
              Space: {hoveredNode.spaceKey}
            </p>
            {hoveredNode.labels.length > 0 && (
              <p className="text-muted-foreground">
                Labels: {hoveredNode.labels.join(', ')}
              </p>
            )}
            <p className="text-muted-foreground">
              Embeddings: {hoveredNode.embeddingCount}
            </p>
          </div>
        )}
      </div>
    </m.div>
  );
}
