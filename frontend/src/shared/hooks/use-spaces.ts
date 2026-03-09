import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';

interface Space {
  key: string;
  name: string;
  homepageId: string | null;
  lastSynced: string;
  pageCount: number;
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
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
  });
}

export function useSyncStatus() {
  return useQuery<{
    userId: string;
    status: 'idle' | 'syncing' | 'error';
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
