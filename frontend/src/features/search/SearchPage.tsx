import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { m } from 'framer-motion';
import DOMPurify from 'dompurify';
import {
  Search, FileText, ChevronLeft, ChevronRight,
  Filter, X, SlidersHorizontal, Inbox, Loader2, AlertTriangle,
} from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';
import { useSearch, type SearchResultItem } from '../../shared/hooks/use-search';

type SearchMode = 'keyword' | 'semantic' | 'hybrid';
type SortOption = 'relevance' | 'modified' | 'title';

interface SearchFilters {
  source?: 'confluence' | 'local';
  spaceKey?: string;
  author?: string;
  dateFrom?: string;
  dateTo?: string;
  labels?: string;
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

function SearchResultCard({ item, query, navigate }: {
  item: SearchResultItem;
  query: string;
  navigate: (path: string) => void;
}) {
  return (
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
              __html: DOMPurify.sanitize(
                highlightText(item.title, query),
                { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: ['class'] },
              ),
            }}
          />
          {item.excerpt && (
            <p
              className="mt-1 line-clamp-2 text-sm text-muted-foreground"
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(
                  highlightText(item.excerpt.slice(0, 200), query),
                  { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: ['class'] },
                ),
              }}
            />
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {item.spaceKey && (
              <span className="rounded bg-foreground/5 px-1.5 py-0.5">
                {item.spaceKey}
              </span>
            )}
          </div>
        </div>
        {/* Score badge for semantic/hybrid modes */}
        {item.score > 0 && (
          <span className="shrink-0 rounded-full bg-foreground/5 px-2 py-0.5 text-xs text-muted-foreground">
            {(item.score * 100).toFixed(0)}%
          </span>
        )}
      </div>
    </button>
  );
}

export function SearchPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);

  // Initialize from URL params
  const initialQuery = searchParams.get('q') ?? '';
  const [query, setQuery] = useState(initialQuery);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortOption>('relevance');
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<SearchFilters>({});
  const [searchMode, setSearchMode] = useState<SearchMode>('keyword');

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce only for URL sync — useSearch handles its own debounce for API calls.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
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

  // Use raw query for display decisions so results appear immediately
  // without waiting for the URL-sync debounce.
  const activeQuery = query.trim();

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // ── Two-phase progressive search ──────────────────────────────────────────
  const { immediateResults, enhancedResults, isLoadingImmediate, isLoadingEnhanced, hasEmbeddings } = useSearch({
    query,
    mode: searchMode,
    spaceKey: filters.spaceKey,
  });

  // Display enhanced results if available; fall back to immediate results.
  const displayResults: SearchResultItem[] = useMemo(() => {
    if (searchMode !== 'keyword' && enhancedResults !== undefined) {
      return enhancedResults;
    }
    return immediateResults;
  }, [searchMode, immediateResults, enhancedResults]);

  const isLoading = isLoadingImmediate && immediateResults.length === 0;

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

  const showNoEmbeddingsWarning = (searchMode === 'semantic' || searchMode === 'hybrid') && !hasEmbeddings && !!activeQuery;

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
                (isLoadingImmediate || isLoadingEnhanced) ? 'text-primary animate-pulse' : 'text-muted-foreground',
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

        {/* Mode toggle — keyword / semantic / hybrid */}
        <div className="mt-3 flex items-center gap-1.5">
          {(['keyword', 'semantic', 'hybrid'] as const).map((m) => (
            <button
              key={m}
              data-testid={`mode-toggle-${m}`}
              disabled={!query}
              onClick={() => setSearchMode(m)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors capitalize',
                'disabled:cursor-not-allowed disabled:opacity-40',
                searchMode === m
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10',
              )}
            >
              {m}
            </button>
          ))}
          {/* Subtle enhanced-loading indicator — shown whenever the enhanced query is in-flight */}
          {isLoadingEnhanced && (
            <Loader2
              size={14}
              className="ml-1 animate-spin text-primary"
              data-testid="enhanced-loading-indicator"
            />
          )}
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

      {/* No-embeddings warning banner */}
      {showNoEmbeddingsWarning && (
        <div
          className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
          data-testid="no-embeddings-warning"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            No embeddings found — falling back to keyword search.
            Embed your pages to enable semantic search.
          </span>
        </div>
      )}

      {/* Results count */}
      {activeQuery && displayResults.length > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="search-results-count">
          {displayResults.length} {displayResults.length === 1 ? 'result' : 'results'} for &ldquo;{activeQuery}&rdquo;
          {searchMode !== 'keyword' && (
            <span className="ml-2 text-xs capitalize text-muted-foreground/60">
              ({searchMode})
            </span>
          )}
        </p>
      )}

      {/* Results */}
      {!activeQuery ? (
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
      ) : displayResults.length === 0 ? (
        <div className="glass-card flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 rounded-full bg-muted p-3">
            <Inbox size={32} className="text-muted-foreground" />
          </div>
          <p className="text-lg font-medium" data-testid="no-results-title">No results found</p>
          <p className="mt-1 text-sm text-muted-foreground">
            No articles match &ldquo;{activeQuery}&rdquo;
          </p>
          <button
            onClick={() => navigate(`/knowledge-requests?title=${encodeURIComponent(activeQuery)}`)}
            className="mt-4 flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            data-testid="request-content-cta"
          >
            <Filter size={14} />
            Request this content
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {displayResults.map((item, i) => (
            <m.div
              key={item.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
            >
              <SearchResultCard item={item} query={activeQuery} navigate={navigate} />
            </m.div>
          ))}
        </div>
      )}

      {/* Pagination (only for keyword mode with many results) */}
      {searchMode === 'keyword' && displayResults.length >= 20 && (
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
            Page {page}
          </span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={displayResults.length < 20}
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
