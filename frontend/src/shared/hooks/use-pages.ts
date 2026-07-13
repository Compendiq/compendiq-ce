import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';

export type EmbeddingStatus = 'not_embedded' | 'embedding' | 'embedded' | 'failed';
export type QualityStatus = 'pending' | 'analyzing' | 'analyzed' | 'failed' | 'skipped';
export type SummaryStatus = 'pending' | 'summarizing' | 'summarized' | 'failed' | 'skipped';
export type PageType = 'page' | 'folder';

interface PageSummary {
  id: string;
  confluenceId: string | null;
  // Standalone pages have no Confluence space — the list/detail routes return
  // null for them (backend pages-crud space_key: string | null). Keep this
  // nullable so consumers guard the dereference instead of assuming a string.
  spaceKey: string | null;
  title: string;
  pageType: PageType;
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
  source: 'confluence' | 'standalone';
  visibility: 'private' | 'shared';
}

interface PageDetail extends PageSummary {
  bodyHtml: string;
  bodyText: string;
  hasChildren: boolean;
  summaryHtml: string | null;
  summaryGeneratedAt: string | null;
  summaryModel: string | null;
  summaryError: string | null;
  /** Creator's user id — set for standalone pages, null for Confluence-synced. */
  createdByUserId?: string | number | null;
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
  source?: 'confluence' | 'standalone';
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
  sort?: 'title' | 'modified' | 'author' | 'quality' | 'relevance';
  /**
   * Gate the keyword list query. Defaults to true. Callers pass `false` to
   * suppress the fetch when the keyword results are not being displayed — e.g.
   * PagesPage in semantic/hybrid search mode, where results come from useSearch
   * and firing this query would just waste a rate-limited request (#874).
   */
  enabled?: boolean;
}

export function usePages(params: PageFilters = {}) {
  const {
    spaceKey, search, author, labels, freshness,
    embeddingStatus, qualityMin, qualityMax, qualityStatus,
    source, dateFrom, dateTo, page, limit, sort,
    enabled = true,
  } = params;

  const queryKey = useMemo(
    () => ['pages', { spaceKey, search, author, labels, freshness, embeddingStatus, qualityMin, qualityMax, qualityStatus, source, dateFrom, dateTo, page, limit, sort }] as const,
    [spaceKey, search, author, labels, freshness, embeddingStatus, qualityMin, qualityMax, qualityStatus, source, dateFrom, dateTo, page, limit, sort],
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
    if (source) sp.set('source', source);
    if (dateFrom) sp.set('dateFrom', dateFrom);
    if (dateTo) sp.set('dateTo', dateTo);
    if (page) sp.set('page', String(page));
    if (limit) sp.set('limit', String(limit));
    if (sort) sp.set('sort', sort);
    return sp.toString();
  }, [spaceKey, search, author, labels, freshness, embeddingStatus, qualityMin, qualityMax, qualityStatus, source, dateFrom, dateTo, page, limit, sort]);

  return useQuery<PaginatedPages>({
    queryKey,
    queryFn: () => apiFetch(`/pages${qs ? `?${qs}` : ''}`),
    enabled,
    // Cache list responses for 30s so rapid back/forward between list and
    // detail pages reuses cached data instead of firing a fresh request on
    // every remount — that pattern can otherwise trip the backend's global
    // rate limit and leave the query in an unrecoverable error state.
    staleTime: 30_000,
    // Keep the previous page's rows on screen while the next key loads so
    // filter/search/pagination changes don't collapse the list to skeletons
    // (matches useSearch). Without this every keystroke re-enters isLoading.
    placeholderData: (prev) => prev,
  });
}

export interface PageTreeItem {
  id: string;
  spaceKey: string;
  title: string;
  pageType: PageType;
  parentId: string | null;
  // Persisted sibling order (PUT /pages/:id/reorder). Confluence pages default
  // to 0, so buildTree falls back to title within a group of equal sortOrder.
  sortOrder: number;
  labels: string[];
  lastModifiedAt: string | null;
  embeddingDirty: boolean;
}

interface PageTreeResponse {
  items: PageTreeItem[];
  total: number;
}

export function usePageTree(params: { spaceKey?: string; enabled?: boolean } = {}) {
  const { spaceKey, enabled = true } = params;

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
    enabled,
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
    mutationFn: (data: { spaceKey: string; title: string; bodyHtml: string; parentId?: string; pageType?: PageType; source?: string }) =>
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

/**
 * Shared zero-embeddings detection (#938), reused by the AI chat and the
 * semantic-search empty state so both surface the real cause instead of
 * blaming the query. True only when pages exist but none are embedded — the
 * exact semantics of GraphPage's `meta.pagesEmbedded === 0` branch. The
 * `totalPages > 0` guard keeps a brand-new install with nothing synced
 * (totalPages === 0) out of the "not embedded yet" state.
 */
export function isZeroEmbeddings(status: EmbeddingStatusData | undefined): boolean {
  return !!status && status.totalPages > 0 && status.embeddedPages === 0;
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
    staleTime: 60_000, // lightweight query (max 8 items) — avoid refetching on every mount
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

// ======== Single-page sync / re-embed (PR right-pane parity) ========
//
// Both endpoints accept an array of IDs; we pass a singleton. The bulk
// routes already do the right per-page validation (auth, ownership,
// queue gating), so wrapping them here is cheaper than adding new
// single-page routes and keeps backend semantics identical between the
// bulk-actions toolbar on /pages and the per-article right pane.

interface SinglePageBulkResult {
  succeeded: number;
  failed: number;
  errors: string[];
}

export function useResyncPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<SinglePageBulkResult>('/pages/bulk/sync', {
        method: 'POST',
        body: JSON.stringify({ ids: [id] }),
      }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['pages', id] });
      // Mark every 'pages'-prefixed query stale; invalidateQueries defaults to
      // refetchType 'active', so only currently mounted queries refetch and
      // inactive (unmounted) entries refetch lazily on next mount. A prior
      // unfiltered refetchQueries here refetched every inactive entry too,
      // fanning one click into N network requests (issue #882).
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
  });
}

export function useReembedPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<SinglePageBulkResult>('/pages/bulk/embed', {
        method: 'POST',
        body: JSON.stringify({ ids: [id] }),
      }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['pages', id] });
      queryClient.invalidateQueries({ queryKey: ['embeddings'], refetchType: 'none' });
      queryClient.invalidateQueries({ queryKey: ['pages'], refetchType: 'none' });
      queryClient.refetchQueries({ queryKey: ['embeddings'] });
    },
  });
}

export function useRequalityPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<SinglePageBulkResult>('/pages/bulk/quality', {
        method: 'POST',
        body: JSON.stringify({ ids: [id] }),
      }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['pages', id] });
      // See useResyncPage: mark stale + refetch only active queries (issue #882).
      queryClient.invalidateQueries({ queryKey: ['pages'] });
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

