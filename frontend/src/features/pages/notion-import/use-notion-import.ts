import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { NotionImportRequest, NotionImportResponse, NotionTreeResponse } from '@compendiq/contracts';
import {
  NotionConnectionResponseSchema,
  NotionImportStatusSchema,
  NotionTreeResponseSchema,
} from '@compendiq/contracts';
import { ApiError, apiFetch } from '../../../shared/lib/api';

const IMPORT_POLL_MS = 1000;

async function waitForNotionImport(): Promise<NotionImportResponse> {
  for (;;) {
    const status = NotionImportStatusSchema.parse(await apiFetch('/notion/import/status'));
    if (status.status === 'complete') return { items: status.items };
    if (status.status === 'error') throw new ApiError(502, status.error);
    if (status.status === 'idle') {
      throw new ApiError(502, 'Notion import did not start');
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, IMPORT_POLL_MS);
    await promise;
  }
}

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
    mutationFn: async (body: NotionImportRequest) => {
      await apiFetch('/notion/import', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return waitForNotionImport();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pages'] });
      void queryClient.invalidateQueries({ queryKey: ['notion', 'tree'] });
    },
  });
}
