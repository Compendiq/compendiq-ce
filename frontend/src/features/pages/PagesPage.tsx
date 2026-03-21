import { useState, useCallback, useMemo, useRef, useEffect, memo, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { m } from 'framer-motion';
import { Search, FileText, Plus, RefreshCw, ChevronLeft, ChevronRight, FolderOpen, Filter, X, List, Loader2, Trash2, Lock, Globe, AlertTriangle } from 'lucide-react';
import DOMPurify from 'dompurify';
import { toast } from 'sonner';
import { usePages, usePageFilterOptions, usePage, useEmbeddingStatus, type QualityStatus, type SummaryStatus } from '../../shared/hooks/use-pages';
import { useSpaces, useSync, useSyncStatus } from '../../shared/hooks/use-spaces';
import { useSettings } from '../../shared/hooks/use-settings';
import { useSearch } from '../../shared/hooks/use-search';
import { EmptyState } from '../../shared/components/feedback/EmptyState';
import { FreshnessBadge } from '../../shared/components/badges/FreshnessBadge';
import { EmbeddingStatusBadge } from '../../shared/components/badges/EmbeddingStatusBadge';
import { QualityScoreBadge } from '../../shared/components/badges/QualityScoreBadge';
import { SummaryStatusBadge } from '../../shared/components/badges/SummaryStatusBadge';
import { BulkOperations } from './BulkOperations';
import { KPICards } from './KPICards';
import { PinnedArticlesSection } from './PinnedArticlesSection';
import { cn } from '../../shared/lib/cn';
import { useIsLightTheme } from '../../shared/hooks/use-is-light-theme';

// ---------------------------------------------------------------------------
// Memoized page list item: prevents re-render from embedding-status polling
// ---------------------------------------------------------------------------

interface PageListItemProps {
  pageItem: {
    id: string;
    spaceKey: string;
    title: string;
    version: number;
    author: string | null;
    lastModifiedAt: string | null;
    labels: string[];
    embeddingDirty: boolean;
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
    visibility?: string;
  };
  index: number;
  isSelected: boolean;
  onToggleSelection: (id: string, e: React.MouseEvent) => void;
  onNavigate: (id: string) => void;
}

const PageListItem = memo(function PageListItem({
  pageItem, index: _index, isSelected, onToggleSelection, onNavigate,
}: PageListItemProps) {
  return (
    <m.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
    >
      <div
        className={cn(
          'glass-card-hover flex w-full items-center gap-3 p-4 text-left',
          isSelected && 'border-primary/40 bg-primary/5',
        )}
        data-testid={`article-hover-${pageItem.id}`}
      >
        {/* Checkbox for bulk selection */}
        <button
          onClick={(e) => onToggleSelection(pageItem.id, e)}
          className="shrink-0 flex h-5 w-5 items-center justify-center rounded border border-border hover:border-primary/50"
          data-testid={`checkbox-${pageItem.id}`}
          aria-label={`Select ${pageItem.title}`}
        >
          {isSelected && (
            <div className="h-3 w-3 rounded-sm bg-primary" />
          )}
        </button>

        <button
          onClick={() => onNavigate(pageItem.id)}
          className="flex min-w-0 flex-1 items-center gap-4"
        >
          <div className="min-w-0 flex-1 text-left">
            <div className="flex items-center gap-2">
              <p className="truncate font-medium">{pageItem.title}</p>
              {/* Source badge */}
              {pageItem.spaceKey === '__local__' ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-500" data-testid={`source-badge-${pageItem.id}`}>
                  Local
                </span>
              ) : (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-medium text-blue-500" data-testid={`source-badge-${pageItem.id}`}>
                  Confluence
                </span>
              )}
              {/* Visibility badge for standalone articles */}
              {pageItem.spaceKey === '__local__' && (
                (pageItem.visibility === 'shared') ? (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-500" data-testid={`visibility-badge-${pageItem.id}`}>
                    <Globe size={10} /> Shared
                  </span>
                ) : (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-500" data-testid={`visibility-badge-${pageItem.id}`}>
                    <Lock size={10} /> Private
                  </span>
                )
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {pageItem.spaceKey !== '__local__' && <span>{pageItem.spaceKey}</span>}
              {pageItem.author && <span>{pageItem.author}</span>}
              {pageItem.lastModifiedAt && (
                <span>{new Date(pageItem.lastModifiedAt).toLocaleDateString()}</span>
              )}
            </div>
          </div>
          <QualityScoreBadge
            qualityScore={pageItem.qualityScore}
            qualityStatus={pageItem.qualityStatus}
            qualityCompleteness={pageItem.qualityCompleteness}
            qualityClarity={pageItem.qualityClarity}
            qualityStructure={pageItem.qualityStructure}
            qualityAccuracy={pageItem.qualityAccuracy}
            qualityReadability={pageItem.qualityReadability}
            qualitySummary={pageItem.qualitySummary}
            qualityAnalyzedAt={pageItem.qualityAnalyzedAt}
            qualityError={pageItem.qualityError}
          />
          <SummaryStatusBadge status={pageItem.summaryStatus} />
          <EmbeddingStatusBadge embeddingDirty={pageItem.embeddingDirty} />
          {pageItem.lastModifiedAt && (
            <FreshnessBadge lastModified={pageItem.lastModifiedAt} />
          )}
          {pageItem.labels.length > 0 && (
            <div className="flex gap-1">
              {pageItem.labels.slice(0, 3).map((label) => (
                <span key={label} className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
                  {label}
                </span>
              ))}
            </div>
          )}
        </button>
      </div>
    </m.div>
  );
}, (prev, next) => {
  // Only re-render if the page item data or selection state changed
  if (prev.pageItem.id !== next.pageItem.id) return false;
  if (prev.pageItem.version !== next.pageItem.version) return false;
  if (prev.pageItem.embeddingDirty !== next.pageItem.embeddingDirty) return false;
  if (prev.pageItem.qualityScore !== next.pageItem.qualityScore) return false;
  if (prev.pageItem.qualityStatus !== next.pageItem.qualityStatus) return false;
  if (prev.pageItem.summaryStatus !== next.pageItem.summaryStatus) return false;
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.index !== next.index) return false;
  return true;
});

// ---------------------------------------------------------------------------

export function PagesPage() {
  const navigate = useNavigate();
  const isLight = useIsLightTheme();
  const [spaceKey, setSpaceKey] = useState<string>('');
  const [search, setSearch] = useState('');
  const [author, setAuthor] = useState<string>('');
  const [labels, setLabels] = useState<string>('');
  const [freshness, setFreshness] = useState<string>('');
  const [embeddingStatus, setEmbeddingStatus] = useState<string>('');
  const [qualityFilter, setQualityFilter] = useState<string>('');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<'title' | 'modified' | 'author' | 'quality' | 'relevance'>('modified');
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchMode, setSearchMode] = useState<'keyword' | 'semantic' | 'hybrid'>('keyword');

  const { data: settings } = useSettings();
  const { data: spaces } = useSpaces();
  const { data: filterOptions } = usePageFilterOptions();

  // Determine if we should show the space home page content
  const selectedSpace = useMemo(
    () => (spaceKey ? spaces?.find((s) => s.key === spaceKey) : undefined),
    [spaceKey, spaces],
  );
  const showHomeContent = !!(settings?.showSpaceHomeContent && spaceKey && selectedSpace?.homepageId);
  const [forcePageList, setForcePageList] = useState(false);
  const { data: homePage, isLoading: homePageLoading } = usePage(
    showHomeContent && !forcePageList ? selectedSpace?.homepageId ?? undefined : undefined,
  );
  const sanitizedHomeHtml = useMemo(
    () => (homePage ? DOMPurify.sanitize(homePage.bodyHtml, {
      ADD_ATTR: ['data-diagram-name', 'data-drawio', 'data-color', 'data-layout-type', 'data-cell-width', 'data-border'],
    }) : ''),
    [homePage],
  );

  // Map quality filter preset to min/max range
  const qualityRange = useMemo(() => {
    switch (qualityFilter) {
      case 'excellent': return { qualityMin: 90, qualityMax: 100 };
      case 'good': return { qualityMin: 70, qualityMax: 89 };
      case 'needs-work': return { qualityMin: 50, qualityMax: 69 };
      case 'poor': return { qualityMin: 0, qualityMax: 49 };
      default: return {};
    }
  }, [qualityFilter]);

  const { data: pagesData, isLoading } = usePages({
    spaceKey: spaceKey || undefined,
    search: search || undefined,
    author: author || undefined,
    labels: labels || undefined,
    freshness: (freshness || undefined) as 'fresh' | 'recent' | 'aging' | 'stale' | undefined,
    embeddingStatus: (embeddingStatus || undefined) as 'pending' | 'done' | undefined,
    ...qualityRange,
    source: (sourceFilter || undefined) as 'confluence' | 'standalone' | undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    sort,
  });
  // Semantic/hybrid search — only active when there's a search query AND mode is not 'keyword'
  const useSemanticSearch = !!(search && searchMode !== 'keyword');
  const searchResults = useSearch({
    query: useSemanticSearch ? search : '',
    mode: searchMode,
    spaceKey: spaceKey || undefined,
    page,
  });

  const syncMutation = useSync();
  const { data: syncStatus } = useSyncStatus();
  const { data: embeddingStatusData } = useEmbeddingStatus();
  const queryClient = useQueryClient();
  const wasProcessingRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);

  // Locate the app-level scroll container on mount
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-scroll-container]');
    if (el) setScrollElement(el);
  }, []);

  useEffect(() => {
    if (embeddingStatusData?.isProcessing) {
      wasProcessingRef.current = true;
    } else if (wasProcessingRef.current && embeddingStatusData && !embeddingStatusData.isProcessing) {
      wasProcessingRef.current = false;
      toast.success('Embedding complete — all pages are up to date');
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    }
  }, [embeddingStatusData, queryClient]);

  const activeFilters = useMemo(() => {
    const filters: { key: string; label: string }[] = [];
    if (author) filters.push({ key: 'author', label: `Author: ${author}` });
    if (labels) filters.push({ key: 'labels', label: `Label: ${labels}` });
    if (freshness) filters.push({ key: 'freshness', label: `Freshness: ${freshness}` });
    if (embeddingStatus) filters.push({ key: 'embeddingStatus', label: `Embedding: ${embeddingStatus}` });
    if (qualityFilter) filters.push({ key: 'qualityFilter', label: `Quality: ${qualityFilter}` });
    if (dateFrom) filters.push({ key: 'dateFrom', label: `From: ${dateFrom}` });
    if (dateTo) filters.push({ key: 'dateTo', label: `To: ${dateTo}` });
    if (sourceFilter) filters.push({ key: 'sourceFilter', label: `Source: ${sourceFilter}` });
    return filters;
  }, [author, labels, freshness, embeddingStatus, qualityFilter, dateFrom, dateTo, sourceFilter]);

  const activeFilterCount = activeFilters.length;

  const clearFilter = useCallback((key: string) => {
    const setters: Record<string, (v: string) => void> = {
      author: setAuthor,
      labels: setLabels,
      freshness: setFreshness,
      embeddingStatus: setEmbeddingStatus,
      qualityFilter: setQualityFilter,
      dateFrom: setDateFrom,
      dateTo: setDateTo,
      sourceFilter: setSourceFilter,
    };
    setters[key]?.('');
    setPage(1);
  }, []);

  const clearAllFilters = useCallback(() => {
    setAuthor('');
    setLabels('');
    setFreshness('');
    setEmbeddingStatus('');
    setQualityFilter('');
    setDateFrom('');
    setDateTo('');
    setSourceFilter('');
    setPage(1);
  }, []);

  const toggleSelection = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const navigateToPage = useCallback((id: string) => {
    navigate(`/pages/${id}`);
  }, [navigate]);

  const selectAll = useCallback(() => {
    if (pagesData?.items) {
      setSelectedIds(new Set(pagesData.items.map((p) => p.id)));
    }
  }, [pagesData]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // Virtual scrolling for the keyword/browse page list
  const pageItems = pagesData?.items ?? [];
  const scrollMargin = listContainerRef.current?.offsetTop ?? 0;

  const virtualizer = useVirtualizer({
    count: pageItems.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => 80,
    overscan: 5,
    scrollMargin,
    useFlushSync: false, // Required for React 19
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Pages</h1>
          <p className="text-sm text-muted-foreground">
            Browse and manage your knowledge base
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => navigate('/trash')}
            className="glass-card flex items-center gap-2 px-4 py-2 text-sm hover:bg-foreground/5"
            data-testid="trash-link"
          >
            <Trash2 size={16} />
            <span className="hidden sm:inline">Trash</span>
          </button>
          <button
            onClick={() => syncMutation.mutate()}
            disabled={syncStatus?.status === 'syncing'}
            className="glass-card flex items-center gap-2 px-4 py-2 text-sm hover:bg-foreground/5 disabled:opacity-50"
          >
            <RefreshCw size={16} className={cn(syncStatus?.status === 'syncing' && 'animate-spin')} />
            <span className="hidden sm:inline">{syncStatus?.status === 'syncing' ? 'Syncing...' : 'Sync'}</span>
          </button>
          <button
            onClick={() => navigate('/pages/new')}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus size={16} />
            <span className="hidden sm:inline">New Page</span>
            <kbd className="hidden rounded border border-primary-foreground/30 px-1 py-0.5 text-[10px] font-normal sm:inline">
              {navigator.platform?.includes('Mac') ? '\u2325' : 'Alt'}+N
            </kbd>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <KPICards
        embeddingStatus={embeddingStatusData}
        spacesCount={spaces?.length ?? 0}
        lastSynced={syncStatus?.lastSynced}
      />

      {/* Sync progress */}
      {syncStatus?.status === 'syncing' && syncStatus.progress && (
        <div className="glass-card p-3">
          <div className="flex items-center justify-between text-sm">
            <span>Syncing {syncStatus.progress.space}...</span>
            <span>{syncStatus.progress.current}/{syncStatus.progress.total}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-foreground/10">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${(syncStatus.progress.current / syncStatus.progress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Embedding progress */}
      {embeddingStatusData?.isProcessing && (
        <div className="glass-card flex items-center gap-3 p-3 border border-primary/30" data-testid="embedding-progress-banner">
          <Loader2 size={16} className="animate-spin text-primary" />
          <span className="text-sm">
            Embedding in progress — {embeddingStatusData.dirtyPages} pages remaining
          </span>
          <div className="ml-auto flex items-center gap-2">
            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-foreground/10">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${(embeddingStatusData.embeddedPages / Math.max(embeddingStatusData.totalPages, 1)) * 100}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground">
              {embeddingStatusData.embeddedPages}/{embeddingStatusData.totalPages}
            </span>
          </div>
        </div>
      )}

      {/* Pinned Articles */}
      <PinnedArticlesSection />

      {/* Filters */}
      <div className="glass-card space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 min-w-48">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchInputRef as RefObject<HTMLInputElement>}
              type="text"
              placeholder="Search pages..."
              value={search}
              onChange={(e) => {
                const val = e.target.value;
                setSearch(val);
                setPage(1);
                if (val.trim()) {
                  setSort('relevance');
                } else if (sort === 'relevance') {
                  setSort('modified');
                }
              }}
              className="glass-input pl-10 pr-10"
            />
            {search && (
              <button
                onClick={() => { setSearch(''); setPage(1); setSearchMode('keyword'); if (sort === 'relevance') setSort('modified'); searchInputRef.current?.focus(); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                data-testid="search-clear"
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Search mode toggle — keyword / semantic / hybrid */}
          <div className="flex items-center gap-1.5" data-testid="search-mode-toggle">
              {(['keyword', 'semantic', 'hybrid'] as const).map((m) => (
                <button
                  key={m}
                  data-testid={`search-mode-${m}`}
                  onClick={() => { setSearchMode(m); setPage(1); }}
                  aria-pressed={searchMode === m}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-medium transition-all capitalize',
                    searchMode === m
                      ? 'bg-primary text-primary-foreground shadow-md shadow-primary/25 ring-1 ring-primary/50'
                      : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10 border border-transparent hover:border-border/40',
                  )}
                >
                  {m}
                </button>
              ))}
              {searchResults.isLoadingEnhanced && (
                <Loader2 size={14} className="ml-1 animate-spin text-primary" data-testid="search-enhanced-loading" />
              )}
            </div>

          <select
            value={spaceKey}
            onChange={(e) => { setSpaceKey(e.target.value); setPage(1); setForcePageList(false); }}
            className="glass-select"
          >
            <option value="">All Spaces</option>
            {spaces?.map((s) => (
              <option key={s.key} value={s.key}>{s.name}</option>
            ))}
          </select>

          <select
            value={sourceFilter}
            onChange={(e) => { setSourceFilter(e.target.value); setPage(1); }}
            className="glass-select"
            data-testid="filter-source"
          >
            <option value="">All Sources</option>
            <option value="confluence">Confluence</option>
            <option value="local">Local</option>
          </select>

          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            className="glass-select"
          >
            <option value="modified">Last Modified</option>
            <option value="title">Title</option>
            <option value="author">Author</option>
            <option value="quality">Quality Score</option>
            <option value="relevance">Relevance</option>
          </select>

          {/* Divider between sort and filters */}
          <div className="hidden h-6 w-px bg-border/60 sm:block" aria-hidden="true" data-testid="sort-filter-divider" />

          {/* Advanced filters toggle */}
          <button
            onClick={() => setShowAdvancedFilters((v) => !v)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-2 text-sm transition-colors',
              showAdvancedFilters || activeFilterCount > 0
                ? 'bg-primary/15 text-primary'
                : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10',
            )}
            data-testid="advanced-filters-toggle"
          >
            <Filter size={14} />
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                {activeFilterCount}
              </span>
            )}
          </button>

        </div>

        {/* Advanced filters panel */}
        {showAdvancedFilters && (
          <div className="grid grid-cols-2 items-end gap-3 border-t border-border/40 pt-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="advanced-filters-panel">
            {/* Author filter */}
            <div className="min-w-40">
              <label className="mb-1 block text-xs text-muted-foreground">Author</label>
              <select
                value={author}
                onChange={(e) => { setAuthor(e.target.value); setPage(1); }}
                className="glass-select w-full"
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
                value={labels}
                onChange={(e) => { setLabels(e.target.value); setPage(1); }}
                className="glass-select w-full"
                data-testid="filter-labels"
              >
                <option value="">All Labels</option>
                {filterOptions?.labels.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </div>

            {/* Freshness filter */}
            <div className="min-w-32">
              <label className="mb-1 block text-xs text-muted-foreground">Freshness</label>
              <select
                value={freshness}
                onChange={(e) => { setFreshness(e.target.value); setPage(1); }}
                className="glass-select w-full"
                data-testid="filter-freshness"
              >
                <option value="">Any</option>
                <option value="fresh">Fresh (&lt;7 days)</option>
                <option value="recent">Recent (7-30 days)</option>
                <option value="aging">Aging (30-90 days)</option>
                <option value="stale">Stale (&gt;90 days)</option>
              </select>
            </div>

            {/* Embedding status filter */}
            <div className="min-w-36">
              <label className="mb-1 block text-xs text-muted-foreground">Embedding</label>
              <select
                value={embeddingStatus}
                onChange={(e) => { setEmbeddingStatus(e.target.value); setPage(1); }}
                className="glass-select w-full"
                data-testid="filter-embedding"
              >
                <option value="">Any</option>
                <option value="pending">Needs Embedding</option>
                <option value="done">Embedded</option>
              </select>
            </div>

            {/* Quality score filter */}
            <div className="min-w-36">
              <label className="mb-1 block text-xs text-muted-foreground">Quality</label>
              <select
                value={qualityFilter}
                onChange={(e) => { setQualityFilter(e.target.value); setPage(1); }}
                className="glass-select w-full"
                data-testid="filter-quality"
              >
                <option value="">Any</option>
                <option value="excellent">Excellent (90-100)</option>
                <option value="good">Good (70-89)</option>
                <option value="needs-work">Needs Work (50-69)</option>
                <option value="poor">Poor (0-49)</option>
              </select>
            </div>

            {/* Date range */}
            <div className="min-w-36">
              <label className="mb-1 block text-xs text-muted-foreground">Modified From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
                className="glass-input w-full"
                data-testid="filter-date-from"
              />
            </div>
            <div className="min-w-36">
              <label className="mb-1 block text-xs text-muted-foreground">Modified To</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
                className="glass-input w-full"
                data-testid="filter-date-to"
              />
            </div>

            {/* Clear all filters */}
            {activeFilterCount > 0 && (
              <button
                onClick={clearAllFilters}
                className="flex items-center gap-1 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive hover:bg-destructive/20"
                data-testid="clear-filters"
              >
                <X size={14} />
                Clear filters
              </button>
            )}
          </div>
        )}

        {/* Active filter pills */}
        {activeFilters.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-3" data-testid="active-filter-pills">
            {activeFilters.map((f) => (
              <button
                key={f.key}
                onClick={() => clearFilter(f.key)}
                className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
                aria-label={`Remove ${f.label} filter`}
                data-testid={`filter-pill-${f.key}`}
              >
                {f.label}
                <X size={12} aria-hidden="true" data-testid={`filter-pill-remove-${f.key}`} />
              </button>
            ))}
            <button
              onClick={clearAllFilters}
              className="text-xs text-muted-foreground hover:text-foreground"
              data-testid="clear-all-pill-filters"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* No-embeddings warning for semantic/hybrid search */}
      {search && searchMode !== 'keyword' && !searchResults.hasEmbeddings && (
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

      {/* Space home content (when enabled and a space is selected) */}
      {showHomeContent && !forcePageList ? (
        homePageLoading ? (
          <div className="glass-card h-96 animate-pulse" />
        ) : homePage ? (
          <m.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">{homePage.title}</h2>
              <div className="flex gap-2">
                <button
                  onClick={() => navigate(`/pages/${homePage.id}`)}
                  className="glass-card flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-foreground/5"
                >
                  <FileText size={14} /> View Full Page
                </button>
                <button
                  onClick={() => setForcePageList(true)}
                  className="glass-card flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-foreground/5"
                  data-testid="show-page-list"
                >
                  <List size={14} /> Show All Pages
                </button>
              </div>
            </div>
            <div
              className={`glass-card prose max-w-none p-6${isLight ? '' : ' prose-invert'}`}
              dangerouslySetInnerHTML={{ __html: sanitizedHomeHtml }}
            />
          </m.div>
        ) : null
      ) : (
      <>
      {/* Page list — semantic/hybrid search results */}
      {useSemanticSearch ? (
        <>
          {searchResults.isLoadingImmediate && searchResults.immediateResults.length === 0 ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="glass-card h-16 animate-pulse" />
              ))}
            </div>
          ) : (() => {
            const displayItems = searchResults.enhancedResults ?? searchResults.immediateResults;
            return displayItems.length === 0 ? (
              <EmptyState
                icon={FolderOpen}
                title="No pages found"
                description="Try a different search term or switch to keyword mode"
              />
            ) : (
              <>
                <p className="text-sm text-muted-foreground" data-testid="search-results-count">
                  {searchResults.total} {searchResults.total === 1 ? 'result' : 'results'}
                  <span className="ml-2 text-xs capitalize text-muted-foreground/60">({searchMode})</span>
                </p>
                <div className="space-y-2">
                  {displayItems.map((item, i) => (
                    <m.div
                      key={item.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.03 }}
                    >
                      <button
                        onClick={() => navigate(`/pages/${item.id}`)}
                        className="glass-card-hover flex w-full items-center gap-3 p-4 text-left"
                        data-testid={`article-hover-${item.id}`}
                      >
                        <FileText size={18} className="shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1 text-left">
                          <p className="truncate font-medium">{item.title}</p>
                          {item.excerpt && (
                            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.excerpt}</p>
                          )}
                          {item.spaceKey && (
                            <span className="mt-1 inline-block text-xs text-muted-foreground">{item.spaceKey}</span>
                          )}
                        </div>
                        {item.score > 0 && (
                          <span className="shrink-0 rounded-full bg-foreground/5 px-2 py-0.5 text-xs text-muted-foreground">
                            {(item.score * 100).toFixed(0)}%
                          </span>
                        )}
                      </button>
                    </m.div>
                  ))}
                </div>
              </>
            );
          })()}

          {/* Pagination for semantic/hybrid results */}
          {searchResults.totalPages > 1 && (
            <div className="flex items-center justify-center gap-4">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="glass-card p-2 disabled:opacity-30"
              >
                <ChevronLeft size={18} />
              </button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {searchResults.totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(searchResults.totalPages, p + 1))}
                disabled={page >= searchResults.totalPages}
                className="glass-card p-2 disabled:opacity-30"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Page list — keyword/browse mode (original) */}
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="glass-card h-16 animate-pulse" />
              ))}
            </div>
          ) : !pagesData?.items.length ? (
            <EmptyState
              icon={FolderOpen}
              title="No pages found"
              description={search ? 'Try a different search term' : 'Sync your Confluence spaces to see pages here'}
              action={!search ? { label: 'Go to Settings', onClick: () => navigate('/settings') } : undefined}
            />
          ) : (
            <div
              ref={listContainerRef}
              data-testid="virtual-list-container"
              style={{ position: 'relative', height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const pageItem = pageItems[virtualRow.index];
                return (
                  <div
                    key={pageItem.id}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                    }}
                  >
                    <div className="pb-2">
                      <PageListItem
                        pageItem={pageItem}
                        index={virtualRow.index}
                        isSelected={selectedIds.has(pageItem.id)}
                        onToggleSelection={toggleSelection}
                        onNavigate={navigateToPage}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          {pagesData && pagesData.totalPages > 1 && (
            <div className="flex items-center justify-center gap-4">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="glass-card p-2 disabled:opacity-30"
              >
                <ChevronLeft size={18} />
              </button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {pagesData.totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(pagesData.totalPages, p + 1))}
                disabled={page >= pagesData.totalPages}
                className="glass-card p-2 disabled:opacity-30"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          )}

          {/* Bulk Operations Bar */}
          <BulkOperations
            selectedIds={[...selectedIds]}
            totalCount={pagesData?.items.length ?? 0}
            onSelectAll={selectAll}
            onDeselectAll={deselectAll}
            onClose={deselectAll}
          />
        </>
      )}
      </>
      )}
    </div>
  );
}
