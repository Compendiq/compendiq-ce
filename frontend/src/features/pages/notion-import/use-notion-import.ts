import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotionImportRequest } from '@compendiq/contracts';
import {
  NotionConnectionResponseSchema,
  NotionImportResponseSchema,
  NotionTreeResponseSchema,
} from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';

export function useNotionConnection(enabled = true) {
  return useQuery({
    queryKey: ['notion', 'connection'],
    queryFn: async () => NotionConnectionResponseSchema.parse(await apiFetch('/notion/connection')),
    enabled,
  });
}

export function useConnectNotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (token: string) =>
      NotionConnectionResponseSchema.parse(
        await apiFetch('/notion/connection', {
          method: 'PUT',
          body: JSON.stringify({ token }),
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notion'] });
    },
  });
}

export function useDisconnectNotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      NotionConnectionResponseSchema.parse(
        await apiFetch('/notion/connection', { method: 'DELETE' }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notion'] });
    },
  });
}

export function useNotionTree(enabled: boolean) {
  return useQuery({
    queryKey: ['notion', 'tree'],
    queryFn: async () => NotionTreeResponseSchema.parse(await apiFetch('/notion/tree')),
    enabled,
  });
}

export function useRunNotionImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: NotionImportRequest) =>
      NotionImportResponseSchema.parse(
        await apiFetch('/notion/import', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
  });
}
