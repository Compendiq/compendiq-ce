import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { m } from 'framer-motion';
import DOMPurify from 'dompurify';
import {
  Search, FileText, ChevronLeft, ChevronRight,
  Filter, X, SlidersHorizontal, Inbox,
} from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { FreshnessBadge } from '../../shared/components/badges/FreshnessBadge';
import { cn } from '../../shared/lib/cn';

interface SearchResult {
  id: string;
  spaceKey: string;
  title: string;
  author: string | null;
  lastModifiedAt: string | null;
  labels: string[];
  /** Plain-text excerpt with potential highlights */
  excerpt?: string;
  /** Quality score 0-100 if available */
  qualityScore?: number | null;
  /** Source: confluence or local */
  source?: 'confluence' | 'local';
}

interface SearchResponse {
  items: SearchResult[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

type SortOption = 'relevance' | 'modified' | 'title';

interface SearchFilters {
  source?: 'confluence' | 'local';
  spaceKey?: string;
  author?: string;
  dateFrom?: string;
  dateTo?: string;
  labels?: string;
}

function useSearchResults(params: {
  query: string;
  filters: SearchFilters;
  sort: SortOption;
  page: number;
}) {
  const { query, filters, sort, page } = params;

  const qs = useMemo(() => {
    const sp = new URLSearchParams();
    if (query) sp.set('search', query);
    if (filters.source) sp.set('source', filters.source);
    if (filters.spaceKey) sp.set('spaceKey', filters.spaceKey);
    if (filters.author) sp.set('author', filters.author);
    if (filters.dateFrom) sp.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) sp.set('dateTo', filters.dateTo);
    if (filters.labels) sp.set('labels', filters.labels);
    if (sort) sp.set('sort', sort === 'relevance' ? 'modified' : sort);
    sp.set('page', String(page));
    return sp.toString();
  }, [query, filters, sort, page]);

  return useQuery<SearchResponse>({
    queryKey: ['search', { query, ...filters, sort, page }],
    queryFn: () => apiFetch(`/pages?${qs}`),
    enabled: query.length > 0,
    placeholderData: (prev) => prev,
  });
}

function useFilterOptions() {
  return useQuery<{ authors: string[]; labels: string[] }>({
    queryKey: ['pages', 'filters'],
    queryFn: () => apiFetch('/pages/filters'),
    staleTime: 60_000,
  });
}

function useSpacesForFilter() {
  return useQuery<Array<{ key: string; name: string }>>({
    queryKey: ['spaces'],
    queryFn: () => apiFetch('/spaces'),
    staleTime: 60_000,
  });
}

/**
 * Highlight search terms in text by wrapping matches in <mark> tags.
 * Uses case-insensitive string splitting instead of RegExp to avoid ReDoS.
 * Output is sanitized with DOMPurify before rendering.
 */
function highlightText(text: string, query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return DOMPurify.sanitize(text);

  const lowerText = text.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();
  const parts: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const idx = lowerText.indexOf(lowerQuery, cursor);
    if (idx === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    if (idx > cursor) {
      parts.push(text.slice(cursor, idx));
    }
    const matched = text.slice(idx, idx + trimmed.length);
    parts.push(`<mark class="bg-primary/20 text-foreground rounded px-0.5">${matched}</mark>`);
    cursor = idx + trimmed.length;
  }

  return DOMPurify.sanitize(parts.join(''), { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: ['class'] });
}

export function SearchPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);

  // Initialize from URL params
  const initialQuery = searchParams.get('q') ?? '';
  const [query, setQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortOption>('relevance');
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<SearchFilters>({});

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search input
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query);
      setPage(1);
      if (query) {
        setSearchParams({ q: query }, { replace: true });
      } else {
        setSearchParams({}, { replace: true });
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, setSearchParams]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const { data, isLoading, isFetching } = useSearchResults({
    query: debouncedQuery,
    filters,
    sort,
    page,
  });

  const { data: filterOptions } = useFilterOptions();
  const { data: spaces } = useSpacesForFilter();

  const activeFilterCount = [
    filters.source, filters.spaceKey, filters.author,
    filters.dateFrom, filters.dateTo, filters.labels,
  ].filter(Boolean).length;

  const clearFilters = useCallback(() => {
    setFilters({});
    setPage(1);
  }, []);

  const updateFilter = useCallback(<K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value || undefined }));
    setPage(1);
  }, []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Search</h1>
        <p className="text-sm text-muted-foreground">
          Find articles across your knowledge base
        </p>
      </div>

      {/* Search bar */}
      <div className="glass-card p-4">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search
              size={18}
              className={cn(
                'absolute left-3 top-1/2 -translate-y-1/2',
                isFetching ? 'text-primary animate-pulse' : 'text-muted-foreground',
              )}
            />
            <input
              ref={inputRef}
              type="text"
              placeholder="Search articles by title, content, or keywords..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-lg bg-foreground/5 py-3 pl-11 pr-4 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/50"
              data-testid="search-input"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X size={16} />
              </button>
            )}
          </div>

          {/* Sort */}
          <select
            value={sort}
            onChange={(e) => { setSort(e.target.value as SortOption); setPage(1); }}
            className="rounded-md bg-foreground/5 px-3 py-3 text-sm outline-none focus:ring-1 focus:ring-primary"
            data-testid="search-sort"
          >
            <option value="relevance">Relevance</option>
            <option value="modified">Last Modified</option>
            <option value="title">Title</option>
          </select>

          {/* Filters toggle */}
          <button
            onClick={() => setShowFilters((v) => !v)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-3 text-sm transition-colors',
              showFilters || activeFilterCount > 0
                ? 'bg-primary/15 text-primary'
                : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10',
            )}
            data-testid="search-filters-toggle"
          >
            <SlidersHorizontal size={14} />
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {/* Filter panel */}
        {showFilters && (
          <div
            className="mt-3 flex flex-wrap items-end gap-3 border-t border-border/50 pt-3"
            data-testid="search-filters-panel"
          >
            {/* Source filter */}
            <div className="min-w-32">
              <label className="mb-1 block text-xs text-muted-foreground">Source</label>
              <select
                value={filters.source ?? ''}
                onChange={(e) => updateFilter('source', e.target.value as SearchFilters['source'])}
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="filter-source"
              >
                <option value="">All Sources</option>
                <option value="confluence">Confluence</option>
                <option value="local">Local</option>
              </select>
            </div>

            {/* Space filter */}
            <div className="min-w-40">
              <label className="mb-1 block text-xs text-muted-foreground">Space</label>
              <select
                value={filters.spaceKey ?? ''}
                onChange={(e) => updateFilter('spaceKey', e.target.value)}
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="filter-space"
              >
                <option value="">All Spaces</option>
                {spaces?.map((s) => (
                  <option key={s.key} value={s.key}>{s.name}</option>
                ))}
              </select>
            </div>

            {/* Author filter */}
            <div className="min-w-40">
              <label className="mb-1 block text-xs text-muted-foreground">Author</label>
              <select
                value={filters.author ?? ''}
                onChange={(e) => updateFilter('author', e.target.value)}
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="filter-author"
              >
                <option value="">All Authors</option>
                {filterOptions?.authors.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>

            {/* Labels filter */}
            <div className="min-w-40">
              <label className="mb-1 block text-xs text-muted-foreground">Labels</label>
              <select
                value={filters.labels ?? ''}
                onChange={(e) => updateFilter('labels', e.target.value)}
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="filter-labels"
              >
                <option value="">All Labels</option>
                {filterOptions?.labels.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </div>

            {/* Date range */}
            <div className="min-w-36">
              <label className="mb-1 block text-xs text-muted-foreground">From</label>
              <input
                type="date"
                value={filters.dateFrom ?? ''}
                onChange={(e) => updateFilter('dateFrom', e.target.value)}
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="filter-date-from"
              />
            </div>
            <div className="min-w-36">
              <label className="mb-1 block text-xs text-muted-foreground">To</label>
              <input
                type="date"
                value={filters.dateTo ?? ''}
                onChange={(e) => updateFilter('dateTo', e.target.value)}
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="filter-date-to"
              />
            </div>

            {/* Clear all */}
            {activeFilterCount > 0 && (
              <button
                onClick={clearFilters}
                className="flex items-center gap-1 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive hover:bg-destructive/20"
                data-testid="clear-search-filters"
              >
                <X size={14} />
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>

      {/* Results count */}
      {debouncedQuery && data && (
        <p className="text-sm text-muted-foreground" data-testid="search-results-count">
          {data.total} {data.total === 1 ? 'result' : 'results'} for &ldquo;{debouncedQuery}&rdquo;
        </p>
      )}

      {/* Results */}
      {!debouncedQuery ? (
        <div className="glass-card flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 rounded-full bg-muted p-3">
            <Search size={32} className="text-muted-foreground" />
          </div>
          <p className="text-lg font-medium">Start searching</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Type a query above to search your knowledge base
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Tip: Press <kbd className="rounded border border-border/50 px-1 py-0.5 text-[10px]">
              {typeof navigator !== 'undefined' && navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}+K
            </kbd> to search from anywhere
          </p>
        </div>
      ) : isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="glass-card h-24 animate-pulse" />
          ))}
        </div>
      ) : !data?.items.length ? (
        <div className="glass-card flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 rounded-full bg-muted p-3">
            <Inbox size={32} className="text-muted-foreground" />
          </div>
          <p className="text-lg font-medium" data-testid="no-results-title">No results found</p>
          <p className="mt-1 text-sm text-muted-foreground">
            No articles match &ldquo;{debouncedQuery}&rdquo;
          </p>
          <button
            onClick={() => navigate(`/knowledge-requests?title=${encodeURIComponent(debouncedQuery)}`)}
            className="mt-4 flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            data-testid="request-content-cta"
          >
            <Filter size={14} />
            Request this content
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {data.items.map((item, i) => (
            <m.div
              key={item.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
            >
              <button
                onClick={() => navigate(`/pages/${item.id}`)}
                className="glass-card-hover w-full p-4 text-left"
                data-testid={`search-result-${item.id}`}
              >
                <div className="flex items-start gap-3">
                  <FileText size={18} className="mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p
                      className="font-medium"
                      dangerouslySetInnerHTML={{
                        __html: DOMPurify.sanitize(highlightText(item.title, debouncedQuery), { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: ['class'] }),
                      }}
                    />
                    {item.excerpt && (
                      <p
                        className="mt-1 line-clamp-2 text-sm text-muted-foreground"
                        dangerouslySetInnerHTML={{
                          __html: DOMPurify.sanitize(highlightText(item.excerpt, debouncedQuery), { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: ['class'] }),
                        }}
                      />
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="rounded bg-foreground/5 px-1.5 py-0.5">
                        {item.spaceKey}
                      </span>
                      {item.source && (
                        <span className={cn(
                          'rounded px-1.5 py-0.5',
                          item.source === 'confluence' ? 'bg-info/10 text-info' : 'bg-primary/10 text-primary',
                        )}>
                          {item.source === 'confluence' ? 'Confluence' : 'Local'}
                        </span>
                      )}
                      {item.author && <span>{item.author}</span>}
                      {item.labels.slice(0, 3).map((label) => (
                        <span key={label} className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {item.qualityScore != null && (
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs font-medium',
                          item.qualityScore >= 80 ? 'bg-success/15 text-success' :
                          item.qualityScore >= 50 ? 'bg-warning/15 text-warning' :
                          'bg-destructive/15 text-destructive',
                        )}
                      >
                        Q:{item.qualityScore}
                      </span>
                    )}
                    {item.lastModifiedAt && (
                      <FreshnessBadge lastModified={item.lastModifiedAt} />
                    )}
                  </div>
                </div>
              </button>
            </m.div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="glass-card p-2 disabled:opacity-30"
            data-testid="search-prev-page"
          >
            <ChevronLeft size={18} />
          </button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {data.totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
            disabled={page >= data.totalPages}
            className="glass-card p-2 disabled:opacity-30"
            data-testid="search-next-page"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
