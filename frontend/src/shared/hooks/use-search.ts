import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PageIcon } from '@compendiq/contracts';
import { apiFetch } from '../lib/api';

export interface SearchResultItem {
  id: string | number;
  confluenceId?: string | null;
  title: string;
  spaceKey: string | null;
  icon?: PageIcon | null;
  /** Short excerpt / snippet from the matching content */
  excerpt: string;
  /**
   * Relevance score in whatever unit the mode produced — ts_rank for keyword,
   * cosine for semantic, an RRF fusion value for hybrid. Comparable *within* one
   * result list and meaningless between modes, so it orders rows and nothing
   * else. Rendering it as a percentage is what showed the same page at ~87% in
   * semantic and ~2% in hybrid (#1117).
   */
  score: number;
  /**
   * Cosine similarity, or `null` when no vector leg contributed — a keyword-mode
   * search, or a hybrid row matched only by full-text. The only figure here that
   * is safe to show a user.
   *
   * Nominally [0,1], genuinely [-1,1]: it is `1 - (embedding <=> query)` and
   * pgvector's cosine distance runs to 2. Render sites must not assume a
   * percentage in [0,100] — `/pages` shows it only when positive.
   */
  similarity: number | null;
}

interface SearchApiResponse {
  items: Array<{
    id: string | number;
    confluenceId?: string | null;
    title: string;
    spaceKey: string | null;
    snippet?: string;
    rank?: number;
    score?: number;
    similarity?: number | null;
    icon?: PageIcon | null;
  }>;
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  mode: string;
  hasEmbeddings: boolean;
  warning?: string;
  /**
   * Embedded fraction of the caller-visible embeddable corpus, [0,1] — or
   * null when the mode never measured it (keyword mode skips the probe).
   */
  embeddingCoverage?: number | null;
  /** Why the vector leg under-delivered; null on a healthy, probed response. */
  degradedReason?: 'no_embeddings' | 'partial_embeddings' | null;
}

function mapItems(response: SearchApiResponse): SearchResultItem[] {
  return response.items.map((item) => ({
    id: item.id,
    confluenceId: item.confluenceId,
    title: item.title,
    spaceKey: item.spaceKey,
    excerpt: item.snippet ?? '',
    score: item.score ?? item.rank ?? 0,
    // Absent (keyword mode never sends it) stays null rather than collapsing to
    // 0 — a page nobody measured must render no figure, not "0%".
    similarity: item.similarity ?? null,
    icon: item.icon ?? null,
  }));
}

interface UseSearchParams {
  query: string;
  mode: 'keyword' | 'semantic' | 'hybrid';
  spaceKey?: string;
  page?: number;
  /** Sort order for keyword/immediate results. Semantic & hybrid ignore this (pipeline-ordered server-side — since #1103's stable-head fusion the array order is authoritative and not derivable from any score field; never re-sort it). */
  sort?: 'relevance' | 'modified' | 'title';
  /** Filter to a single author (Confluence display name). */
  author?: string;
  /** Inclusive lower bound on last-modified date (YYYY-MM-DD). */
  dateFrom?: string;
  /** Inclusive upper bound on last-modified date (YYYY-MM-DD). */
  dateTo?: string;
  /** Comma-separated labels; sent to the backend as the `tags` param. */
  labels?: string;
}

interface UseSearchResult {
  /** Fast keyword results — shown first while semantic is loading */
  immediateResults: SearchResultItem[];
  /** Semantic or hybrid results that augment/replace the immediate results */
  enhancedResults: SearchResultItem[] | undefined;
  isLoadingImmediate: boolean;
  isLoadingEnhanced: boolean;
  /**
   * Whether the user has any page embeddings. Derived from the ENHANCED
   * response: the immediate query is always mode=keyword, where the backend
   * skips the coverage probe and reports true unconditionally — deriving from
   * it is why the no-embeddings banner could never fire in production (#1117).
   * Optimistically true before the enhanced response lands, and always true
   * in keyword mode (unmeasured).
   */
  hasEmbeddings: boolean;
  /** Embedded fraction [0,1] from the enhanced response; null when unmeasured. */
  embeddingCoverage: number | null;
  /** Degraded-retrieval verdict from the enhanced response; null when healthy or unmeasured. */
  degradedReason: 'no_embeddings' | 'partial_embeddings' | null;
  /** Server-provided total number of matching results */
  total: number;
  /** Current page number (1-based) */
  page: number;
  /** Total number of pages */
  totalPages: number;
}

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 1;

/**
 * useSearch — two-phase progressive search hook.
 *
 * Phase 1 (immediate): fires a fast keyword query right away so the user sees
 *   results without waiting for LLM embedding generation.
 *
 * Phase 2 (enhanced): fires a semantic or hybrid query concurrently.
 *   When the enhanced results arrive, the caller should show them instead of
 *   (or merged with) the immediate results.
 *
 * Both queries are debounced 300ms to avoid per-keystroke requests.
 * staleTime: 0 on both — search results are query-specific and must not be
 * served from the TanStack Query cache between different search terms.
 */
export function useSearch({ query, mode, spaceKey, page: requestedPage = 1, sort = 'relevance', author, dateFrom, dateTo, labels }: UseSearchParams): UseSearchResult {
  // Debounce the query string
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query]);

  const trimmedQuery = debouncedQuery.trim();
  const isQueryEnabled = trimmedQuery.length >= MIN_QUERY_LENGTH;

  // Build the base URL params shared by both queries
  function buildUrl(searchMode: 'keyword' | 'semantic' | 'hybrid', pageNum: number = 1) {
    const sp = new URLSearchParams();
    sp.set('q', trimmedQuery);
    sp.set('mode', searchMode);
    sp.set('limit', '10');
    if (pageNum > 1) sp.set('page', String(pageNum));
    if (spaceKey) sp.set('spaceKey', spaceKey);
    // Filters apply to every mode — the backend ANDs them into the WHERE clause.
    if (author) sp.set('author', author);
    if (dateFrom) sp.set('dateFrom', dateFrom);
    if (dateTo) sp.set('dateTo', dateTo);
    if (labels) sp.set('tags', labels); // FE field `labels` → backend query param `tags`
    // Sort only affects keyword results — semantic/hybrid arrive in the
    // server pipeline's order (stable-head fusion, #1103), which is
    // authoritative and never re-sorted client-side.
    if (searchMode === 'keyword' && sort !== 'relevance') sp.set('sort', sort);
    return `/search?${sp.toString()}`;
  }

  // ── Phase 1: Immediate keyword results ──────────────────────────────────
  // Once enhanced results arrive, disable the immediate query so it stops
  // refetching (the enhanced results supersede it).
  const enhancedHasData = useRef(false);

  const immediateQuery = useQuery<SearchApiResponse>({
    queryKey: ['search', 'immediate', trimmedQuery, spaceKey, requestedPage, sort, author, dateFrom, dateTo, labels],
    queryFn: () => apiFetch<SearchApiResponse>(buildUrl('keyword', requestedPage)),
    enabled: isQueryEnabled && !enhancedHasData.current,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  // ── Phase 2: Enhanced semantic/hybrid results ────────────────────────────
  // Only fires when mode is not 'keyword'
  const enhancedQuery = useQuery<SearchApiResponse>({
    queryKey: ['search', 'enhanced', trimmedQuery, mode, spaceKey, requestedPage, author, dateFrom, dateTo, labels],
    queryFn: () => apiFetch<SearchApiResponse>(buildUrl(mode as 'semantic' | 'hybrid', requestedPage)),
    enabled: isQueryEnabled && mode !== 'keyword',
    staleTime: 0,
    // Keep the previous page's results visible while the next page loads —
    // without this, every page flip drops enhanced data to undefined, which
    // re-enables the immediate keyword query and causes visible churn.
    placeholderData: (prev) => prev,
  });

  // Track whether enhanced results have arrived so the immediate query
  // can be disabled on the next render cycle.
  enhancedHasData.current = mode !== 'keyword' && !!enhancedQuery.data && !enhancedQuery.isLoading;

  // The degraded-retrieval signal comes from the ENHANCED response only: the
  // immediate query is always mode=keyword, where the backend skips the
  // coverage probe and answers hasEmbeddings: true with null coverage (#1117).
  const signalResponse = mode !== 'keyword' ? enhancedQuery.data : undefined;
  const hasEmbeddings = signalResponse?.hasEmbeddings ?? true;
  const embeddingCoverage = signalResponse?.embeddingCoverage ?? null;
  const degradedReason = signalResponse?.degradedReason ?? null;

  // Use the active response for pagination metadata
  const activeResponse = (mode !== 'keyword' && enhancedQuery.data) ? enhancedQuery.data : immediateQuery.data;

  return {
    immediateResults: immediateQuery.data ? mapItems(immediateQuery.data) : [],
    enhancedResults: enhancedQuery.data ? mapItems(enhancedQuery.data) : undefined,
    isLoadingImmediate: immediateQuery.isLoading,
    isLoadingEnhanced: enhancedQuery.isLoading,
    hasEmbeddings,
    embeddingCoverage,
    degradedReason,
    total: activeResponse?.total ?? 0,
    page: activeResponse?.page ?? 1,
    totalPages: activeResponse?.totalPages ?? 1,
  };
}
