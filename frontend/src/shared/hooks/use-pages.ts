import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';

export type EmbeddingStatus = 'not_embedded' | 'embedding' | 'embedded' | 'failed';

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
  embeddingStatus: EmbeddingStatus;
  embeddedAt: string | null;
  embeddingError: string | null;
}

interface PageDetail extends PageSummary {
  bodyHtml: string;
  bodyText: string;
  hasChildren: boolean;
}

interface PaginatedPages {
  items: PageSummary[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface PageFilters {
  spaceKey?: string;
  search?: string;
  author?: string;
  labels?: string;
  freshness?: 'fresh' | 'recent' | 'aging' | 'stale';
  embeddingStatus?: 'pending' | 'done';
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
  sort?: 'title' | 'modified' | 'author';
}

export function usePages(params: PageFilters = {}) {
  const {
    spaceKey, search, author, labels, freshness,
    embeddingStatus, dateFrom, dateTo, page, limit, sort,
  } = params;

  const queryKey = useMemo(
    () => ['pages', { spaceKey, search, author, labels, freshness, embeddingStatus, dateFrom, dateTo, page, limit, sort }] as const,
    [spaceKey, search, author, labels, freshness, embeddingStatus, dateFrom, dateTo, page, limit, sort],
  );

  const qs = useMemo(() => {
    const sp = new URLSearchParams();
    if (spaceKey) sp.set('spaceKey', spaceKey);
    if (search) sp.set('search', search);
    if (author) sp.set('author', author);
    if (labels) sp.set('labels', labels);
    if (freshness) sp.set('freshness', freshness);
    if (embeddingStatus) sp.set('embeddingStatus', embeddingStatus);
    if (dateFrom) sp.set('dateFrom', dateFrom);
    if (dateTo) sp.set('dateTo', dateTo);
    if (page) sp.set('page', String(page));
    if (limit) sp.set('limit', String(limit));
    if (sort) sp.set('sort', sort);
    return sp.toString();
  }, [spaceKey, search, author, labels, freshness, embeddingStatus, dateFrom, dateTo, page, limit, sort]);

  return useQuery<PaginatedPages>({
    queryKey,
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
  embeddingDirty: boolean;
}

interface PageTreeResponse {
  items: PageTreeItem[];
  total: number;
}

export function usePageTree(params: { spaceKey?: string } = {}) {
  const { spaceKey } = params;

  const queryKey = useMemo(
    () => ['pages', 'tree', { spaceKey }] as const,
    [spaceKey],
  );

  const qs = useMemo(() => {
    const sp = new URLSearchParams();
    if (spaceKey) sp.set('spaceKey', spaceKey);
    return sp.toString();
  }, [spaceKey]);

  return useQuery<PageTreeResponse>({
    queryKey,
    queryFn: () => apiFetch(`/pages/tree${qs ? `?${qs}` : ''}`),
  });
}

interface FilterOptions {
  authors: string[];
  labels: string[];
}

export function usePageFilterOptions() {
  return useQuery<FilterOptions>({
    queryKey: ['pages', 'filters'],
    queryFn: () => apiFetch('/pages/filters'),
    staleTime: 60_000, // refresh once per minute
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

export function useUpdatePageLabels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, addLabels, removeLabels }: { id: string; addLabels?: string[]; removeLabels?: string[] }) =>
      apiFetch<{ labels: string[] }>(`/pages/${id}/labels`, {
        method: 'PUT',
        body: JSON.stringify({ addLabels, removeLabels }),
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['pages', variables.id] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['pages', 'filters'] });
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

export interface EmbeddingStatusData {
  totalPages: number;
  embeddedPages: number;
  dirtyPages: number;
  totalEmbeddings: number;
  isProcessing: boolean;
}

export function usePageHasChildren(id: string | undefined) {
  return useQuery<{ hasChildren: boolean }>({
    queryKey: ['pages', id, 'has-children'],
    queryFn: () => apiFetch(`/pages/${id}/has-children`),
    enabled: !!id,
    staleTime: 60_000, // refresh once per minute
  });
}

export function useEmbeddingStatus() {
  return useQuery<EmbeddingStatusData>({
    queryKey: ['embeddings', 'status'],
    queryFn: () => apiFetch('/embeddings/status'),
    refetchInterval: (query) => {
      return query.state.data?.isProcessing ? 3000 : false;
    },
  });
}

export function useTriggerEmbedding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch('/embeddings/process', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['embeddings', 'status'] });
    },
  });
}

// ======== Pinned Pages (Issue #144) ========

export interface PinnedPage {
  id: string;
  spaceKey: string;
  title: string;
  author: string | null;
  lastModifiedAt: string | null;
  excerpt: string;
  pinnedAt: string;
  pinOrder: number;
}

interface PinnedPagesResponse {
  items: PinnedPage[];
  total: number;
}

export function usePinnedPages() {
  return useQuery<PinnedPagesResponse>({
    queryKey: ['pages', 'pinned'],
    queryFn: () => apiFetch('/pages/pinned'),
  });
}

export function usePinPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pageId: string) =>
      apiFetch<{ message: string; pageId: string }>(`/pages/${pageId}/pin`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pages', 'pinned'] });
    },
  });
}

export function useUnpinPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pageId: string) =>
      apiFetch<{ message: string; pageId: string }>(`/pages/${pageId}/pin`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pages', 'pinned'] });
    },
  });
}

export type { PageSummary, PageDetail, PaginatedPages, PageTreeItem, PageTreeResponse, FilterOptions };
