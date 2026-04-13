import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../shared/lib/api';

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
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

interface GraphEdge {
  source: string;
  target: string;
  type: string;
  score: number;
}

interface GraphData {
  nodes: (GraphNode | ClusterNode)[];
  edges: GraphEdge[];
  centerId?: string;
}

type ViewMode = 'individual' | 'clustered';

export function useGraphData(view: ViewMode, spaceKey?: string) {
  const params = new URLSearchParams();
  params.set('view', view);
  if (spaceKey) params.set('spaceKey', spaceKey);

  return useQuery<GraphData>({
    queryKey: ['pages', 'graph', view, spaceKey ?? ''],
    queryFn: () => apiFetch(`/pages/graph?${params.toString()}`),
    staleTime: 60_000,
  });
}

export function useLocalGraphData(pageId: string | undefined, hops = 2) {
  return useQuery<GraphData>({
    queryKey: ['pages', 'graph', 'local', pageId, hops],
    queryFn: () => apiFetch(`/pages/${pageId}/graph/local?hops=${hops}`),
    staleTime: 60_000,
    enabled: !!pageId,
  });
}
