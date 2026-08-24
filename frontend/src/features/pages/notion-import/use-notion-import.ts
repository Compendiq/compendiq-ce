import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  NotionConnectionResponse,
  NotionImportRequest,
  NotionImportResponse,
  NotionTreeResponse,
} from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';

export function useNotionConnection(enabled = true) {
  return useQuery({
    queryKey: ['notion', 'connection'],
    queryFn: () => apiFetch<NotionConnectionResponse>('/notion/connection'),
    enabled,
  });
}

export function useConnectNotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      apiFetch<NotionConnectionResponse>('/notion/connection', {
        method: 'PUT',
        body: JSON.stringify({ token }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notion'] });
    },
  });
}

export function useDisconnectNotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<NotionConnectionResponse>('/notion/connection', { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notion'] });
    },
  });
}

export function useNotionTree(enabled: boolean) {
  return useQuery({
    queryKey: ['notion', 'tree'],
    queryFn: () => apiFetch<NotionTreeResponse>('/notion/tree'),
    enabled,
  });
}

export function useRunNotionImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: NotionImportRequest) =>
      apiFetch<NotionImportResponse>('/notion/import', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
  });
}
