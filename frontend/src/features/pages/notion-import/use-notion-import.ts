import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { NotionImportRequest, NotionTreeResponse } from '@compendiq/contracts';
import {
  NotionConnectionResponseSchema,
  NotionImportResponseSchema,
  NotionTreeResponseSchema,
} from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';

async function applyConnection(queryClient: QueryClient, status: { hasToken: boolean }) {
  await queryClient.cancelQueries({ queryKey: ['notion'] });
  queryClient.setQueryData(['notion', 'connection'], status);
  queryClient.removeQueries({ queryKey: ['notion', 'tree'] });
}

export function useNotionConnection(enabled = true) {
  return useQuery({
    queryKey: ['notion', 'connection'],
    queryFn: async () => NotionConnectionResponseSchema.parse(await apiFetch('/notion/connection')),
    enabled,
    staleTime: 60_000,
  });
}

export function prefetchNotionConnection(queryClient: QueryClient): void {
  void queryClient
    .fetchQuery({
      queryKey: ['notion', 'connection'],
      queryFn: async () => NotionConnectionResponseSchema.parse(await apiFetch('/notion/connection')),
      staleTime: 60_000,
    })
    .then((status) => {
      if (!status.hasToken) return;
      void queryClient.prefetchQuery({
        queryKey: ['notion', 'tree'],
        queryFn: async () => NotionTreeResponseSchema.parse(await apiFetch('/notion/tree')),
        staleTime: 30_000,
      });
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
    onSuccess: async (status) => {
      await applyConnection(queryClient, status);
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
    onSuccess: async (status) => {
      await applyConnection(queryClient, status);
    },
  });
}

export function useNotionTree(enabled: boolean) {
  return useQuery({
    queryKey: ['notion', 'tree'],
    queryFn: async () => NotionTreeResponseSchema.parse(await apiFetch('/notion/tree')),
    enabled,
    staleTime: (query) => {
      const data = query.state.data as NotionTreeResponse | undefined;
      return data && data.nodes.length === 0 ? 0 : 30_000;
    },
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
      void queryClient.invalidateQueries({ queryKey: ['notion', 'tree'] });
    },
  });
}
