import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';

interface Space {
  key: string;
  name: string;
  homepageId: string | null;
  lastSynced: string | null;
  pageCount: number;
  source: 'confluence' | 'local';
}

interface AvailableSpace {
  key: string;
  name: string;
  type: string;
}

export function useSpaces() {
  return useQuery<Space[]>({
    queryKey: ['spaces'],
    queryFn: () => apiFetch('/spaces'),
  });
}

export function useAvailableSpaces() {
  return useQuery<AvailableSpace[]>({
    queryKey: ['spaces', 'available'],
    queryFn: () => apiFetch('/spaces/available'),
    enabled: false, // Only fetch when triggered
  });
}

export function useSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch('/sync', { method: 'POST' }),
    onSuccess: () => {
      // Invalidate sync status so the UI picks up 'syncing' state and starts polling
      queryClient.invalidateQueries({ queryKey: ['sync', 'status'] });
      queryClient.invalidateQueries({ queryKey: ['settings', 'sync-overview'] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
  });
}

/**
 * #379: PUT /api/spaces/:key/home — set the custom home page for a space.
 * Pass `homePageId: null` to clear the override and fall back to the
 * Confluence default. Backend gates on admin-or-manage; the UI also gates
 * via `usePermission('manage', 'space', key)` so the trigger only renders
 * for permitted users, but a 403 surfaces here as a normal mutation error
 * for the caller to toast.
 */
export function useSetSpaceHome() {
  const queryClient = useQueryClient();
  return useMutation<
    { spaceKey: string; customHomePageId: number | null },
    Error,
    { spaceKey: string; homePageId: number | null }
  >({
    mutationFn: ({ spaceKey, homePageId }) =>
      apiFetch(`/spaces/${encodeURIComponent(spaceKey)}/home`, {
        method: 'PUT',
        body: JSON.stringify({ homePageId }),
      }),
    onSuccess: () => {
      // Backend already invalidates every user's spaces cache via cache-bus
      // (see spaces.ts:167). Frontend just needs to refetch so the sidebar
      // tree picks up the new homepageId immediately.
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
  });
}

export function useSyncStatus() {
  return useQuery<{
    userId: string;
    status: 'idle' | 'syncing' | 'embedding' | 'error';
    progress?: { current: number; total: number; space?: string };
    lastSynced?: string;
    error?: string;
  }>({
    queryKey: ['sync', 'status'],
    queryFn: () => apiFetch('/sync/status'),
    refetchInterval: (query) => {
      return query.state.data?.status === 'syncing' ? 2000 : false;
    },
  });
}
