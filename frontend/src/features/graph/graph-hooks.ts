import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

/**
 * #358: meta block on the graph response. The UI uses this to differentiate
 * empty states ("no spaces accessible" vs "no pages embedded yet" vs
 * "embedded but no relationships computed yet"). All counts are scoped to the
 * caller's accessible pages — same RBAC as the nodes/edges arrays.
 */
export interface GraphMeta {
  pagesTotal: number;
  pagesEmbedded: number;
  relationshipsTotal: number;
  relationshipsByType: Record<string, number>;
}

interface GraphData {
  nodes: (GraphNode | ClusterNode)[];
  edges: GraphEdge[];
  centerId?: string;
  meta?: GraphMeta;
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

/**
 * #358: admin trigger to recompute page_relationships rows. Wraps the
 * existing POST /api/pages/graph/refresh; returns the new edge count.
 * On success invalidates the global+local graph queries so the UI re-reads.
 */
export function useRefreshGraph() {
  const queryClient = useQueryClient();
  return useMutation<{ message: string; edges: number }>({
    mutationFn: () => apiFetch('/pages/graph/refresh', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pages', 'graph'] });
    },
  });
}
