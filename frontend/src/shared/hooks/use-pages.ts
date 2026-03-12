import { useMemo, useState, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { streamSSE } from '../lib/sse';

export type EmbeddingStatus = 'not_embedded' | 'embedding' | 'embedded' | 'failed';
export type QualityStatus = 'pending' | 'analyzing' | 'analyzed' | 'failed' | 'skipped';
export type SummaryStatus = 'pending' | 'summarizing' | 'summarized' | 'failed' | 'skipped';

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
  qualityScore: number | null;
  qualityStatus: QualityStatus | null;
  qualityCompleteness: number | null;
  qualityClarity: number | null;
  qualityStructure: number | null;
  qualityAccuracy: number | null;
  qualityReadability: number | null;
  qualitySummary: string | null;
  qualityAnalyzedAt: string | null;
  qualityError: string | null;
  summaryStatus?: SummaryStatus;
}

interface PageDetail extends PageSummary {
  bodyHtml: string;
  bodyText: string;
  hasChildren: boolean;
  summaryHtml: string | null;
  summaryGeneratedAt: string | null;
  summaryModel: string | null;
  summaryError: string | null;
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
  qualityMin?: number;
  qualityMax?: number;
  qualityStatus?: QualityStatus;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
  sort?: 'title' | 'modified' | 'author' | 'quality';
}

export function usePages(params: PageFilters = {}) {
  const {
    spaceKey, search, author, labels, freshness,
    embeddingStatus, qualityMin, qualityMax, qualityStatus,
    dateFrom, dateTo, page, limit, sort,
  } = params;

  const queryKey = useMemo(
    () => ['pages', { spaceKey, search, author, labels, freshness, embeddingStatus, qualityMin, qualityMax, qualityStatus, dateFrom, dateTo, page, limit, sort }] as const,
    [spaceKey, search, author, labels, freshness, embeddingStatus, qualityMin, qualityMax, qualityStatus, dateFrom, dateTo, page, limit, sort],
  );

  const qs = useMemo(() => {
    const sp = new URLSearchParams();
    if (spaceKey) sp.set('spaceKey', spaceKey);
    if (search) sp.set('search', search);
    if (author) sp.set('author', author);
    if (labels) sp.set('labels', labels);
    if (freshness) sp.set('freshness', freshness);
    if (embeddingStatus) sp.set('embeddingStatus', embeddingStatus);
    if (qualityMin !== undefined) sp.set('qualityMin', String(qualityMin));
    if (qualityMax !== undefined) sp.set('qualityMax', String(qualityMax));
    if (qualityStatus) sp.set('qualityStatus', qualityStatus);
    if (dateFrom) sp.set('dateFrom', dateFrom);
    if (dateTo) sp.set('dateTo', dateTo);
    if (page) sp.set('page', String(page));
    if (limit) sp.set('limit', String(limit));
    if (sort) sp.set('sort', sort);
    return sp.toString();
  }, [spaceKey, search, author, labels, freshness, embeddingStatus, qualityMin, qualityMax, qualityStatus, dateFrom, dateTo, page, limit, sort]);

  return useQuery<PaginatedPages>({
    queryKey,
    queryFn: () => apiFetch(`/pages${qs ? `?${qs}` : ''}`),
  });
}

export interface PageTreeItem {
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
    onMutate: async ({ id, title, bodyHtml }) => {
      await queryClient.cancelQueries({ queryKey: ['pages', id] });
      const previous = queryClient.getQueryData<PageDetail>(['pages', id]);
      queryClient.setQueryData<PageDetail>(['pages', id], (old) =>
        old ? { ...old, title, bodyHtml } : old,
      );
      return { previous };
    },
    onError: (_err, variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['pages', variables.id], context.previous);
      }
    },
    onSettled: (_data, _err, variables) => {
      queryClient.invalidateQueries({ queryKey: ['pages', variables.id] });
      queryClient.invalidateQueries({ queryKey: ['pages'], refetchType: 'none' });
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
    onMutate: async ({ id, addLabels = [], removeLabels = [] }) => {
      await queryClient.cancelQueries({ queryKey: ['pages', id] });
      const previous = queryClient.getQueryData<PageDetail>(['pages', id]);
      queryClient.setQueryData<PageDetail>(['pages', id], (old) => {
        if (!old) return old;
        const next = old.labels
          .filter((l) => !removeLabels.includes(l))
          .concat(addLabels.filter((l) => !old.labels.includes(l)));
        return { ...old, labels: next };
      });
      return { previous };
    },
    onError: (_err, variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['pages', variables.id], context.previous);
      }
    },
    onSettled: (_data, _err, variables) => {
      queryClient.invalidateQueries({ queryKey: ['pages', variables.id] });
      queryClient.invalidateQueries({ queryKey: ['pages'], refetchType: 'none' });
      queryClient.invalidateQueries({ queryKey: ['pages', 'filters'], refetchType: 'none' });
    },
  });
}

export function useDeletePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/pages/${id}`, { method: 'DELETE' }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['pages'] });
      // Remove from all paginated list caches optimistically
      queryClient.setQueriesData<PaginatedPages>({ queryKey: ['pages'] }, (old) => {
        if (!old?.items) return old;
        return { ...old, items: old.items.filter((p) => p.id !== id), total: Math.max(0, old.total - 1) };
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['spaces'], refetchType: 'none' });
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

export function useEmbeddingStatus() {
  return useQuery<EmbeddingStatusData>({
    queryKey: ['embeddings', 'status'],
    queryFn: () => apiFetch('/embeddings/status'),
    refetchInterval: (query) => {
      return query.state.data?.isProcessing ? 3000 : false;
    },
  });
}

export interface EmbeddingProgress {
  total: number;
  completed: number;
  failed: number;
  percentage: number;
  currentPage?: string;
  errors: string[];
  isWaiting: boolean;
  waitReason?: string;
}

const INITIAL_PROGRESS: EmbeddingProgress = {
  total: 0, completed: 0, failed: 0, percentage: 0,
  errors: [], isWaiting: false,
};

/**
 * Hook to trigger embedding processing with real-time SSE progress.
 * Replaces the old JSON-based useTriggerEmbedding. The backend streams
 * progress events (type: 'progress' | 'complete' | 'waiting' | 'paused')
 * over SSE for the duration of the job.
 */
export function useEmbeddingProcess() {
  const queryClient = useQueryClient();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<EmbeddingProgress>(INITIAL_PROGRESS);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async (endpoint: '/embeddings/process' | '/embeddings/retry-failed' = '/embeddings/process') => {
    if (isProcessing) return;
    abortRef.current = new AbortController();
    setIsProcessing(true);
    setProgress(INITIAL_PROGRESS);

    try {
      for await (const event of streamSSE<{ type: string; total?: number; completed?: number; failed?: number; percentage?: number; currentPage?: string; reason?: string; errors?: string[] }>(
        endpoint, {}, abortRef.current.signal,
      )) {
        if (event.type === 'progress' || event.type === 'paused') {
          setProgress({
            total: event.total ?? 0,
            completed: event.completed ?? 0,
            failed: event.failed ?? 0,
            percentage: event.percentage ?? 0,
            currentPage: event.currentPage,
            errors: [],
            isWaiting: false,
          });
        } else if (event.type === 'waiting') {
          setProgress((prev) => ({ ...prev, isWaiting: true, waitReason: event.reason }));
        } else if (event.type === 'complete') {
          setProgress({
            total: event.total ?? 0,
            completed: event.completed ?? 0,
            failed: event.failed ?? 0,
            percentage: 100,
            errors: event.errors ?? [],
            isWaiting: false,
          });
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        throw err;
      }
    } finally {
      setIsProcessing(false);
      abortRef.current = null;
      queryClient.invalidateQueries({ queryKey: ['embeddings', 'status'] });
      queryClient.invalidateQueries({ queryKey: ['pages'], refetchType: 'none' });
    }
  }, [isProcessing, queryClient]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { start, cancel, isProcessing, progress };
}

// ======== Quality Analysis Status ========

export interface QualityStatusData {
  totalPages: number;
  analyzedPages: number;
  pendingPages: number;
  failedPages: number;
  skippedPages: number;
  averageScore: number | null;
  isProcessing: boolean;
}

export function useQualityStatus() {
  return useQuery<QualityStatusData>({
    queryKey: ['quality', 'status'],
    queryFn: () => apiFetch('/llm/quality-status'),
    refetchInterval: (query) => {
      return query.state.data?.isProcessing ? 5000 : 30_000;
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
    onMutate: async (pageId) => {
      await queryClient.cancelQueries({ queryKey: ['pages', 'pinned'] });
      const previous = queryClient.getQueryData<PinnedPagesResponse>(['pages', 'pinned']);
      queryClient.setQueryData<PinnedPagesResponse>(['pages', 'pinned'], (old) =>
        old
          ? {
              ...old,
              items: [...old.items, { id: pageId, spaceKey: '', title: '', author: null, lastModifiedAt: null, excerpt: '', pinnedAt: new Date().toISOString(), pinOrder: old.items.length + 1 }],
              total: old.total + 1,
            }
          : { items: [{ id: pageId, spaceKey: '', title: '', author: null, lastModifiedAt: null, excerpt: '', pinnedAt: new Date().toISOString(), pinOrder: 1 }], total: 1 },
      );
      return { previous };
    },
    onError: (_err, _pageId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['pages', 'pinned'], context.previous);
      }
    },
    onSettled: () => {
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
    onMutate: async (pageId) => {
      await queryClient.cancelQueries({ queryKey: ['pages', 'pinned'] });
      const previous = queryClient.getQueryData<PinnedPagesResponse>(['pages', 'pinned']);
      queryClient.setQueryData<PinnedPagesResponse>(['pages', 'pinned'], (old) =>
        old
          ? {
              ...old,
              items: old.items.filter((item) => item.id !== pageId),
              total: Math.max(0, old.total - 1),
            }
          : { items: [], total: 0 },
      );
      return { previous };
    },
    onError: (_err, _pageId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['pages', 'pinned'], context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['pages', 'pinned'] });
    },
  });
}

// ======== Summary Regeneration (Issue #323) ========

export function useSummaryRegenerate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pageId: string) =>
      apiFetch<{ message: string; pageId: string }>(`/llm/summary-regenerate/${pageId}`, {
        method: 'POST',
      }),
    onSuccess: (_data, pageId) => {
      queryClient.invalidateQueries({ queryKey: ['pages', pageId] });
    },
  });
}

export type { PageSummary, PageDetail, PaginatedPages, PageTreeResponse, FilterOptions };
