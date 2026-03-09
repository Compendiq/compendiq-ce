import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';

interface PageSummary {
  id: string;
  spaceKey: string;
  title: string;
  version: number;
  parentId: string | null;
  labels: string[];
  author: string | null;
  lastModifiedAt: string | null;
  lastSynced: string;
  embeddingDirty: boolean;
}

interface PageDetail extends PageSummary {
  bodyHtml: string;
  bodyText: string;
}

interface PaginatedPages {
  items: PageSummary[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export function usePages(params: {
  spaceKey?: string;
  search?: string;
  page?: number;
  limit?: number;
  sort?: 'title' | 'modified' | 'author';
} = {}) {
  const searchParams = new URLSearchParams();
  if (params.spaceKey) searchParams.set('spaceKey', params.spaceKey);
  if (params.search) searchParams.set('search', params.search);
  if (params.page) searchParams.set('page', String(params.page));
  if (params.limit) searchParams.set('limit', String(params.limit));
  if (params.sort) searchParams.set('sort', params.sort);

  const qs = searchParams.toString();
  return useQuery<PaginatedPages>({
    queryKey: ['pages', params],
    queryFn: () => apiFetch(`/pages${qs ? `?${qs}` : ''}`),
  });
}

interface PageTreeItem {
  id: string;
  spaceKey: string;
  title: string;
  parentId: string | null;
  labels: string[];
  lastModifiedAt: string | null;
}

interface PageTreeResponse {
  items: PageTreeItem[];
  total: number;
}

export function usePageTree(params: { spaceKey?: string } = {}) {
  const searchParams = new URLSearchParams();
  if (params.spaceKey) searchParams.set('spaceKey', params.spaceKey);
  const qs = searchParams.toString();

  return useQuery<PageTreeResponse>({
    queryKey: ['pages', 'tree', params],
    queryFn: () => apiFetch(`/pages/tree${qs ? `?${qs}` : ''}`),
  });
}

export function usePage(id: string | undefined) {
  return useQuery<PageDetail>({
    queryKey: ['pages', id],
    queryFn: () => apiFetch(`/pages/${id}`),
    enabled: !!id,
  });
}

export function useCreatePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { spaceKey: string; title: string; bodyHtml: string; parentId?: string }) =>
      apiFetch<{ id: string; title: string; version: number }>('/pages', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

export function useUpdatePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; title: string; bodyHtml: string; version?: number }) =>
      apiFetch<{ id: string; title: string; version: number }>(`/pages/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['pages', variables.id] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
  });
}

export function useDeletePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/pages/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

export function useEmbeddingStatus() {
  return useQuery<{
    totalPages: number;
    dirtyPages: number;
    totalEmbeddings: number;
    isProcessing: boolean;
  }>({
    queryKey: ['embeddings', 'status'],
    queryFn: () => apiFetch('/embeddings/status'),
    refetchInterval: (query) => {
      return query.state.data?.isProcessing ? 3000 : false;
    },
  });
}

export type { PageSummary, PageDetail, PaginatedPages, PageTreeItem, PageTreeResponse };
