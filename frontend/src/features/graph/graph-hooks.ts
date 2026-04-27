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

/**
 * #360 multi-select: `spaceKeys` is an array of space keys, encoded as a
 * single comma-separated `spaceKey` query param to match the existing
 * server contract. Empty / undefined means "no filter — RBAC default".
 *
 * Back-compat: callers still passing a single string land in the
 * `typeof === 'string'` branch and get wrapped into a one-element array.
 */
export function useGraphData(
  view: ViewMode,
  spaceKeys?: string | string[],
  enabled = true,
) {
  const normalised: string[] | undefined =
    spaceKeys === undefined
      ? undefined
      : typeof spaceKeys === 'string'
        ? spaceKeys
          ? [spaceKeys]
          : undefined
        : spaceKeys.length > 0
          ? spaceKeys
          : undefined;

  const params = new URLSearchParams();
  params.set('view', view);
  if (normalised && normalised.length > 0) {
    params.set('spaceKey', normalised.join(','));
  }

  // Stable, sorted cache key — `[A,B]` and `[B,A]` are the same selection.
  const cacheKey = normalised ? [...normalised].sort().join(',') : '';

  // #360: `enabled` lets the caller skip the global graph fetch when the
  // user hasn't opted in (article-picker default state). Without this, the
  // hairball would still fire over the wire even though we render the picker.
  return useQuery<GraphData>({
    queryKey: ['pages', 'graph', view, cacheKey],
    queryFn: () => apiFetch(`/pages/graph?${params.toString()}`),
    staleTime: 60_000,
    enabled,
  });
}

/** #360 filter shape for /graph/local. All fields optional; empty arrays
 * mean "no filter" (backend treats them the same as undefined). */
export interface LocalGraphFilters {
  hops?: number;
  edgeTypes?: string[];
  minScore?: number;
  labels?: string[];
}

export function useLocalGraphData(pageId: string | undefined, filters: LocalGraphFilters = {}) {
  const { hops = 2, edgeTypes, minScore, labels } = filters;
  const params = new URLSearchParams();
  params.set('hops', String(hops));
  if (edgeTypes && edgeTypes.length > 0) params.set('edgeTypes', edgeTypes.join(','));
  if (minScore !== undefined) params.set('minScore', String(minScore));
  if (labels && labels.length > 0) params.set('labels', labels.join(','));

  return useQuery<GraphData>({
    queryKey: ['pages', 'graph', 'local', pageId, hops, edgeTypes?.join(','), minScore, labels?.join(',')],
    queryFn: () => apiFetch(`/pages/${pageId}/graph/local?${params.toString()}`),
    staleTime: 60_000,
    enabled: !!pageId,
  });
}
