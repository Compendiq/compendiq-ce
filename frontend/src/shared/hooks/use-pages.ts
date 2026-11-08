import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AiPolicyConflictSchema,
  AiPolicyDeniedSchema,
  AiPolicyLabelConflictSchema,
  type AiPolicy,
  type AiPolicyFilter,
  type PageIcon,
  type PageLifecycleState,
  type SettablePageIcon,
  type PageAiPolicyDetailFields,
  type PageAiPolicyWorkerFields,
  type PageEmbeddingStatus,
  type PageQualityStatus,
  type PageSummaryStatus,
} from '@compendiq/contracts';
import { apiFetch, ApiError } from '../lib/api';
import { useOnboardingActions } from './use-onboarding';

export type EmbeddingStatus = PageEmbeddingStatus;
export type QualityStatus = PageQualityStatus;
export type SummaryStatus = PageSummaryStatus;
export type PageType = 'page' | 'folder';

export interface PageSummary extends PageAiPolicyWorkerFields {
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
  icon?: PageIcon | null;
  /**
   * #277 freeze summary, carried on every page shape by the contract. Optional
   * here for the same reason the tree's copy is: a server that predates the
   * fields sends none, and absent means "not known to be frozen".
   */
  isFrozen?: boolean;
  baselineId?: string | null;
  frozenVersion?: number | null;
  /**
   * #283: the stored article AI policy and its compare-and-set revision on
   * the LIST wire, so a bulk policy action sends `expectedRevision` for every
   * selected row. Absent on a server that predates the fields — unknown,
   * never `all`, and a row without them cannot be included in a bulk policy
   * request.
   */
  aiPolicy?: AiPolicy;
  aiPolicyRevision?: number;
}

interface PageDetail extends PageSummary, Partial<PageLifecycleState>, PageAiPolicyDetailFields {
  bodyHtml: string;
  bodyText: string;
  hasChildren: boolean;
  /**
   * The descendants a trash by the current user would move: live,
   * `source = 'standalone'`, created by this user, the page itself excluded
   * (#1636) — exactly the set `DELETE /pages/:id` cascades, guard for guard.
   * `hasChildren` answers the different question of what the tree shows, and
   * can be true with a count of 0 (a Confluence-sourced or another user's
   * subtree). Optional because the API predates the field: absent means "not
   * known", which the trash dialog must render as the no-sub-articles copy
   * rather than as a guess.
   */
  descendantCount?: number;
  summaryHtml: string | null;
  summaryGeneratedAt: string | null;
  summaryModel: string | null;
  summaryError: string | null;
  /** Creator's user id — set for standalone pages, null for Confluence-synced. */
  createdByUserId?: string | number | null;
  /** Last human verification stamp (`pages.verified_at`). */
  verifiedAt?: string | null;
  /** An unpublished draft exists beside the published body (standalone pages). */
  hasDraft?: boolean;
  draftUpdatedAt?: string | null;
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
  /**
   * #283 Library AI-policy filter — the validated contract value sent as the
   * real `aiPolicy` query parameter and included in the query key, so a
   * filtered list is its own cache entry. `undefined` is "All articles" (no
   * filter), which is NOT the `all` policy.
   */
  aiPolicy?: AiPolicyFilter;
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
    source, aiPolicy, dateFrom, dateTo, page, limit, sort,
    enabled = true,
  } = params;

  const queryKey = useMemo(
    () => ['pages', { spaceKey, search, author, labels, freshness, embeddingStatus, qualityMin, qualityMax, qualityStatus, source, aiPolicy, dateFrom, dateTo, page, limit, sort }] as const,
    [spaceKey, search, author, labels, freshness, embeddingStatus, qualityMin, qualityMax, qualityStatus, source, aiPolicy, dateFrom, dateTo, page, limit, sort],
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
    if (aiPolicy) sp.set('aiPolicy', aiPolicy);
    if (dateFrom) sp.set('dateFrom', dateFrom);
    if (dateTo) sp.set('dateTo', dateTo);
    if (page) sp.set('page', String(page));
    if (limit) sp.set('limit', String(limit));
    if (sort) sp.set('sort', sort);
    return sp.toString();
  }, [spaceKey, search, author, labels, freshness, embeddingStatus, qualityMin, qualityMax, qualityStatus, source, aiPolicy, dateFrom, dateTo, page, limit, sort]);

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
  // Null for a standalone page created outside any local space (the "unfiled
  // page" path) — the backend persists space_key as NULL there, so this was
  // a type lie before it was fixed alongside the sidebar disambiguator bug.
  spaceKey: string | null;
  title: string;
  pageType: PageType;
  parentId: string | null;
  // Persisted sibling order (PUT /pages/:id/reorder). Confluence pages default
  // to 0, so buildTree falls back to title within a group of equal sortOrder.
  sortOrder: number;
  labels: string[];
  lastModifiedAt: string | null;
  embeddingDirty: boolean;
  icon?: PageIcon | null;
  // #277: the tree renders a frozen row's lock from the same summary fields
  // the contract already puts on every page shape. Optional here because a
  // server that predates the field sends none, and absent must read as
  // "not known to be frozen" rather than as frozen.
  isFrozen?: boolean;
  baselineId?: string | null;
  frozenVersion?: number | null;
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
  // #1402: the Getting Started checklist's "Create or edit a page" milestone.
  // Hooked here rather than at the New Page form because every creation path —
  // the form, a template, a Markdown import — lands on this mutation.
  const { markComplete } = useOnboardingActions();
  return useMutation({
    mutationFn: (data: { spaceKey: string; title: string; bodyHtml: string; parentId?: string; pageType?: PageType; source?: string }) =>
      apiFetch<{ id: string; title: string; version: number }>('/pages', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      markComplete('pageCreatedOrEdited');
    },
  });
}

export function useUpdatePage() {
  const queryClient = useQueryClient();
  const { markComplete } = useOnboardingActions();
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
    onSettled: (_data, err, variables) => {
      queryClient.invalidateQueries({ queryKey: ['pages', variables.id] });
      queryClient.invalidateQueries({ queryKey: ['pages'], refetchType: 'none' });
      // The no-error path only: `onSettled` also runs after `onError` rolled
      // the optimistic edit back, and a save that did not land is not a
      // milestone (#1402).
      if (!err) markComplete('pageCreatedOrEdited');
    },
  });
}

export function useUpdatePageIcon() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      icon,
    }: {
      id: string;
      icon: SettablePageIcon | null;
    }) =>
      apiFetch<{ icon: PageIcon | null }>(`/pages/${id}/icon`, {
        method: 'PATCH',
        body: JSON.stringify({ icon }),
      }),
    onMutate: async ({ id, icon }) => {
      await queryClient.cancelQueries({ queryKey: ['pages', id] });
      const previous = queryClient.getQueryData<PageDetail>(['pages', id]);
      queryClient.setQueryData<PageDetail>(['pages', id], (old) =>
        old ? { ...old, icon } : old,
      );
      queryClient.setQueriesData<PageTreeResponse>({ queryKey: ['pages', 'tree'] }, (old) => {
        if (!old?.items) return old;
        return {
          ...old,
          items: old.items.map((item) => (item.id === id ? { ...item, icon } : item)),
        };
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
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
  });
}

export function useUploadPageIcon() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, dataUri }: { id: string; dataUri: string }) =>
      apiFetch<{ icon: PageIcon | null }>(`/pages/${id}/icon-image`, {
        method: 'POST',
        body: JSON.stringify({ dataUri }),
      }),
    onSuccess: (data, variables) => {
      queryClient.setQueryData<PageDetail>(['pages', variables.id], (old) =>
        old ? { ...old, icon: data.icon } : old,
      );
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
  });
}

/**
 * The typed outcome of an article-AI-policy refusal (#283), decoded from the
 * frozen contract bodies the page/label/bulk routes answer with. Anything
 * that is not one of those bodies is `null`, and the caller falls back to the
 * generic message. No body is ever paraphrased into a different verdict.
 */
export type AiPolicyRefusal =
  | { kind: 'denied'; pageIds: number[] }
  | { kind: 'conflict'; pageIds: number[] }
  | { kind: 'label_conflict'; policies: AiPolicy[] }
  | { kind: 'enforcement_unavailable' }
  | { kind: 'unavailable' };

export function describeAiPolicyRefusal(error: unknown): AiPolicyRefusal | null {
  if (!(error instanceof ApiError)) return null;
  const denied = AiPolicyDeniedSchema.safeParse(error.body);
  if (denied.success) return { kind: 'denied', pageIds: denied.data.pageIds };
  const conflict = AiPolicyConflictSchema.safeParse(error.body);
  if (conflict.success) return { kind: 'conflict', pageIds: conflict.data.pageIds };
  const labels = AiPolicyLabelConflictSchema.safeParse(error.body);
  if (labels.success) return { kind: 'label_conflict', policies: labels.data.policies };
  const body = error.body as { error?: unknown } | null;
  if (body?.error === 'ai_policy_enforcement_unavailable') return { kind: 'enforcement_unavailable' };
  if (body?.error === 'ai_policy_unavailable' || error.statusCode === 503) return { kind: 'unavailable' };
  return null;
}

/**
 * Label writes go through the server's normalizer and policy authority
 * (#283): a reserved label (`no-ai`, `local-ai-only`, `all-ai` and their
 * synonyms) can tighten or — with authority — relax the article's policy, a
 * contradictory set is a 422 `ai_policy_label_conflict`, and removing a
 * reserved label alone leaves the policy and its canonical label in place.
 *
 * Therefore NO optimistic update: the label set the server commits is not
 * the set the client asked for (synonyms normalize, a canonical policy label
 * is restored, a refused write changes nothing), and painting the requested
 * set first would show a policy indicator the server never agreed to. Only
 * the committed response enters the cache.
 */
export function useUpdatePageLabels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, addLabels, removeLabels }: { id: string; addLabels?: string[]; removeLabels?: string[] }) =>
      apiFetch<{ labels: string[] }>(`/pages/${id}/labels`, {
        method: 'PUT',
        body: JSON.stringify({ addLabels, removeLabels }),
      }),
    onSuccess: (data, variables) => {
      if (Array.isArray(data?.labels)) {
        queryClient.setQueryData<PageDetail>(['pages', variables.id], (old) =>
          old ? { ...old, labels: data.labels } : old,
        );
      }
    },
    onSettled: (_data, _err, variables) => {
      queryClient.invalidateQueries({ queryKey: ['pages', variables.id] });
      queryClient.invalidateQueries({ queryKey: ['pages'], refetchType: 'none' });
      queryClient.invalidateQueries({ queryKey: ['pages', 'filters'], refetchType: 'none' });
    },
  });
}

/** One selected row's compare-and-set key for the bulk policy request. */
export interface BulkAiPolicyItem {
  pageId: number;
  expectedRevision: number;
}

/**
 * The route's success body is not relied on for the UI's verdict: a 2xx
 * means the server committed the policy on EVERY item (all-or-nothing), and
 * the lists are re-read from the server rather than painted from this.
 */
export type BulkAiPolicyResult = Record<string, unknown> | undefined;

/**
 * `POST /pages/bulk/ai-policy` (#283): the all-or-nothing policy change for
 * a Library selection. Every item carries the revision the list showed; the
 * server refuses the WHOLE request on any unauthorized (403), stale (409) or
 * inaccessible row, and the caller shows that verdict — never a partial
 * success and never a title the caller could not otherwise read. No cache is
 * touched until the server commits; on success every page query is
 * invalidated so lists and details re-read the committed state.
 */
export function useBulkUpdateAiPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ aiPolicy, items }: { aiPolicy: AiPolicy; items: BulkAiPolicyItem[] }) =>
      apiFetch<BulkAiPolicyResult>('/pages/bulk/ai-policy', {
        method: 'POST',
        body: JSON.stringify({ aiPolicy, items }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
  });
}

export function useDeletePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/pages/${id}`, { method: 'DELETE' }),
    onSuccess: async (_data, id) => {
      // A list request already in flight can contain the deleted row. Cancel it
      // before applying the confirmed result so that stale response cannot put
      // the row back while the settlement invalidation starts a fresh request.
      await queryClient.cancelQueries({ queryKey: ['pages'] });
      queryClient.setQueriesData<PaginatedPages>({
        queryKey: ['pages'],
        predicate: (query) => (
          query.queryKey.length === 2
          && typeof query.queryKey[1] === 'object'
          && query.queryKey[1] !== null
        ),
      }, (old) => {
        if (!old?.items?.some((page) => page.id === id)) return old;
        const total = Math.max(0, old.total - 1);
        return {
          ...old,
          items: old.items.filter((page) => page.id !== id),
          total,
          totalPages: total === 0 ? 0 : Math.ceil(total / old.limit),
        };
      });
      // Standalone deletes move the confirmed row into Trash. Confluence and
      // permanent deletes leave it absent there; either way the server owns
      // the resulting collection.
      queryClient.invalidateQueries({ queryKey: ['trash'] });
    },
    onSettled: () => {
      // Prefix invalidation reconciles active lists, trees, pins and details,
      // while marking inactive entries stale for a fetch when next mounted.
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

/**
 * `enabled` gates both the fetch and its 3s processing poll. AiProvider passes
 * false while no AI surface is mounted — it lives in AppLayout now, so an
 * ungated query there would poll on every route in the app.
 */
export function useEmbeddingStatus(enabled = true) {
  return useQuery<EmbeddingStatusData>({
    queryKey: ['embeddings', 'status'],
    queryFn: () => apiFetch('/embeddings/status'),
    enabled,
    refetchInterval: (query) => {
      return query.state.data?.isProcessing ? 3000 : false;
    },
  });
}

// ======== Pinned Pages (Issue #144) ========

export interface PinnedPage {
  id: string;
  // Same nullability as PageTreeItem.spaceKey — an unfiled standalone page
  // can be pinned too, and its space_key is NULL in the DB.
  spaceKey: string | null;
  title: string;
  author: string | null;
  lastModifiedAt: string | null;
  excerpt: string;
  pinnedAt: string;
  pinOrder: number;
  icon?: PageIcon | null;
}

interface PinnedPagesResponse {
  items: PinnedPage[];
  total: number;
}

export function usePinnedPages() {
  return useQuery<PinnedPagesResponse>({
    queryKey: ['pages', 'pinned'],
    queryFn: () => apiFetch('/pages/pinned'),
    // A hand-curated per-user list with SQL-truncated excerpts, so it stays
    // cheap even unbounded (#1130 removed the 8-pin cap) — but there is no
    // ceiling on the row count any more, so cache it rather than refetching on
    // every mount.
    staleTime: 60_000,
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
              // Prepended, not appended: the server returns
              // `ORDER BY pinned_at DESC`, so a new pin is the *first* item.
              // Appending put it last, which since #1130 means it lands beyond
              // the collapsed cut-off — the card vanishes until the refetch
              // moves it to the top.
              items: [{ id: pageId, spaceKey: '', title: '', author: null, lastModifiedAt: null, excerpt: '', pinnedAt: new Date().toISOString(), pinOrder: old.items.length + 1 }, ...old.items],
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

