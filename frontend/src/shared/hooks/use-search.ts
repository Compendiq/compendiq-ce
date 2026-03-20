import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';

export interface SearchResultItem {
  id: string | number;
  title: string;
  spaceKey: string | null;
  /** Short excerpt / snippet from the matching content */
  excerpt: string;
  /** Relevance score (ts_rank for keyword, cosine similarity for semantic, RRF for hybrid) */
  score: number;
}

interface SearchApiResponse {
  items: Array<{
    id: string | number;
    title: string;
    spaceKey: string | null;
    snippet?: string;
    rank?: number;
    score?: number;
  }>;
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  mode: string;
  hasEmbeddings: boolean;
  warning?: string;
}

function mapItems(response: SearchApiResponse): SearchResultItem[] {
  return response.items.map((item) => ({
    id: item.id,
    title: item.title,
    spaceKey: item.spaceKey,
    excerpt: item.snippet ?? '',
    score: item.score ?? item.rank ?? 0,
  }));
}

export interface UseSearchParams {
  query: string;
  mode: 'keyword' | 'semantic' | 'hybrid';
  spaceKey?: string;
  page?: number;
}

export interface UseSearchResult {
  /** Fast keyword results — shown first while semantic is loading */
  immediateResults: SearchResultItem[];
  /** Semantic or hybrid results that augment/replace the immediate results */
  enhancedResults: SearchResultItem[] | undefined;
  isLoadingImmediate: boolean;
  isLoadingEnhanced: boolean;
  /** Whether the user has any page embeddings (derived from the immediate query response) */
  hasEmbeddings: boolean;
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
export function useSearch({ query, mode, spaceKey, page: requestedPage = 1 }: UseSearchParams): UseSearchResult {
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
    return `/search?${sp.toString()}`;
  }

  // ── Phase 1: Immediate keyword results ──────────────────────────────────
  const immediateQuery = useQuery<SearchApiResponse>({
    queryKey: ['search', 'immediate', trimmedQuery, spaceKey, requestedPage],
    queryFn: () => apiFetch<SearchApiResponse>(buildUrl('keyword', requestedPage)),
    enabled: isQueryEnabled,
    staleTime: 0,
  });

  // ── Phase 2: Enhanced semantic/hybrid results ────────────────────────────
  // Only fires when mode is not 'keyword'
  const enhancedQuery = useQuery<SearchApiResponse>({
    queryKey: ['search', 'enhanced', trimmedQuery, mode, spaceKey],
    queryFn: () => apiFetch<SearchApiResponse>(buildUrl(mode as 'semantic' | 'hybrid')),
    enabled: isQueryEnabled && mode !== 'keyword',
    staleTime: 0,
  });

  // Derive hasEmbeddings from the immediate response (optimistic: true before first response)
  const hasEmbeddings = immediateQuery.data?.hasEmbeddings ?? true;

  // Use the active response for pagination metadata
  const activeResponse = (mode !== 'keyword' && enhancedQuery.data) ? enhancedQuery.data : immediateQuery.data;

  return {
    immediateResults: immediateQuery.data ? mapItems(immediateQuery.data) : [],
    enhancedResults: enhancedQuery.data ? mapItems(enhancedQuery.data) : undefined,
    isLoadingImmediate: immediateQuery.isLoading,
    isLoadingEnhanced: enhancedQuery.isLoading,
    hasEmbeddings,
    total: activeResponse?.total ?? 0,
    page: activeResponse?.page ?? 1,
    totalPages: activeResponse?.totalPages ?? 1,
  };
}
