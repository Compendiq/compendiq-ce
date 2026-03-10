import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { m, AnimatePresence } from 'framer-motion';
import { Search, FileText, Plus, RefreshCw, ChevronLeft, ChevronRight, FolderOpen, Filter, X, List, Loader2, Cpu, Pin } from 'lucide-react';
import DOMPurify from 'dompurify';
import { toast } from 'sonner';
import { usePages, usePageFilterOptions, usePage, useEmbeddingStatus, useEmbeddingProcess, usePinnedPages, usePinPage, useUnpinPage, type PageSummary } from '../../shared/hooks/use-pages';
import { useSpaces, useSync, useSyncStatus } from '../../shared/hooks/use-spaces';
import { useSettings } from '../../shared/hooks/use-settings';
import { FreshnessBadge } from '../../shared/components/FreshnessBadge';
import { EmbeddingStatusBadge } from '../../shared/components/EmbeddingStatusBadge';
import { DirectionAwareHover } from '../../shared/components/DirectionAwareHover';
import { MagneticButton } from '../../shared/components/MagneticButton';
import { BulkOperations } from './BulkOperations';
import { KPICards } from './KPICards';
import { PinnedArticlesSection } from './PinnedArticlesSection';
import { SkeletonPageItem } from '../../shared/components/Skeleton';
import { cn } from '../../shared/lib/cn';
import { useIsLightTheme } from '../../shared/hooks/use-is-light-theme';
import { useClickRipple } from '../../shared/hooks/use-click-ripple';
import { useUiStore } from '../../stores/ui-store';

interface PageItemCardProps {
  pageItem: PageSummary;
  selectedIds: Set<string>;
  pinnedIds: Set<string>;
  onToggleSelection: (id: string, e: React.MouseEvent) => void;
  onTogglePin: (e: React.MouseEvent, id: string, title: string) => void;
  onNavigate: (path: string) => void;
}

function PageItemCard({ pageItem, selectedIds, pinnedIds, onToggleSelection, onTogglePin, onNavigate }: PageItemCardProps) {
  return (
    <DirectionAwareHover
      className={cn(
        'glass-card-hover flex w-full items-center gap-4 p-4 text-left',
        selectedIds.has(pageItem.id) && 'border-primary/40 bg-primary/5',
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
        {selectedIds.has(pageItem.id) && (
          <div className="h-3 w-3 rounded-sm bg-primary" />
        )}
      </button>

      {/* Pin toggle */}
      <button
        onClick={(e) => onTogglePin(e, pageItem.id, pageItem.title)}
        className={cn(
          'shrink-0 rounded p-1 transition-colors',
          pinnedIds.has(pageItem.id)
            ? 'text-primary hover:text-primary/70'
            : 'text-muted-foreground/40 hover:text-primary',
        )}
        aria-label={pinnedIds.has(pageItem.id) ? `Unpin ${pageItem.title}` : `Pin ${pageItem.title}`}
        data-testid={`pin-toggle-${pageItem.id}`}
      >
        <Pin size={14} className={pinnedIds.has(pageItem.id) ? 'fill-current' : ''} />
      </button>

      <button
        onClick={() => onNavigate(`/pages/${pageItem.id}`)}
        className="flex min-w-0 flex-1 items-center gap-4"
      >
        <div className="min-w-0 flex-1 text-left">
          <p className="truncate font-medium">{pageItem.title}</p>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>{pageItem.spaceKey}</span>
            {pageItem.author && <span>{pageItem.author}</span>}
            {pageItem.lastModifiedAt && (
              <span>{new Date(pageItem.lastModifiedAt).toLocaleDateString()}</span>
            )}
          </div>
        </div>
        <EmbeddingStatusBadge
          embeddingStatus={pageItem.embeddingStatus}
          embeddingDirty={pageItem.embeddingDirty}
          embeddedAt={pageItem.embeddedAt}
          embeddingError={pageItem.embeddingError}
        />
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
    </DirectionAwareHover>
  );
}

export function PagesPage() {
  const navigate = useNavigate();
  const isLight = useIsLightTheme();
  const [spaceKey, setSpaceKey] = useState<string>('');
  const [search, setSearch] = useState('');
  const [author, setAuthor] = useState<string>('');
  const [labels, setLabels] = useState<string>('');
  const [freshness, setFreshness] = useState<string>('');
  const [embeddingStatus, setEmbeddingStatus] = useState<string>('');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<'title' | 'modified' | 'author'>('modified');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const reduceEffects = useUiStore((s) => s.reduceEffects);
  const virtualScrollRef = useRef<HTMLDivElement>(null);

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
      ADD_ATTR: ['data-diagram-name', 'data-drawio', 'data-title'],
    }) : ''),
    [homePage],
  );

  const { data: pagesData, isLoading } = usePages({
    spaceKey: spaceKey || undefined,
    search: search || undefined,
    author: author || undefined,
    labels: labels || undefined,
    freshness: (freshness || undefined) as 'fresh' | 'recent' | 'aging' | 'stale' | undefined,
    embeddingStatus: (embeddingStatus || undefined) as 'pending' | 'done' | undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    sort,
  });
  const syncMutation = useSync();
  const { data: syncStatus } = useSyncStatus();
  const { data: embeddingStatusData } = useEmbeddingStatus();
  const embeddingProcess = useEmbeddingProcess();
  const { data: pinnedData } = usePinnedPages();
  const pinMutation = usePinPage();
  const unpinMutation = useUnpinPage();
  const queryClient = useQueryClient();

  const pinnedIds = useMemo(
    () => new Set(pinnedData?.items.map((p) => p.id) ?? []),
    [pinnedData],
  );

  const handleTogglePin = useCallback((e: React.MouseEvent, pageId: string, title: string) => {
    e.stopPropagation();
    if (pinnedIds.has(pageId)) {
      unpinMutation.mutate(pageId, {
        onSuccess: () => toast.success(`Unpinned "${title}"`),
        onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to unpin'),
      });
    } else {
      pinMutation.mutate(pageId, {
        onSuccess: () => toast.success(`Pinned "${title}"`),
        onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to pin'),
      });
    }
  }, [pinnedIds, pinMutation, unpinMutation]);

  // Show completion toast when SSE-based processing finishes
  useEffect(() => {
    if (!embeddingProcess.isProcessing && embeddingProcess.progress.total > 0 && embeddingProcess.progress.percentage === 100) {
      const { completed, failed } = embeddingProcess.progress;
      if (failed > 0) {
        toast.warning(`Embedding done — ${completed} succeeded, ${failed} failed`);
      } else {
        toast.success(`Embedding complete — ${completed} pages embedded`);
      }
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embeddingProcess.isProcessing]);

  const ripple = useClickRipple();

  const pageItems = pagesData?.items ?? [];

  /**
   * Virtual scrolling threshold: only virtualize when the list exceeds this
   * count. Small lists render without virtualization to avoid layout overhead.
   */
  const VIRTUAL_THRESHOLD = 20;
  const useVirtual = pageItems.length > VIRTUAL_THRESHOLD;

  const rowVirtualizer = useVirtualizer({
    count: pageItems.length,
    getScrollElement: () => virtualScrollRef.current,
    estimateSize: () => 80,
    overscan: 5,
    enabled: useVirtual,
  });

  /** Max number of items that receive a stagger entrance animation */
  const STAGGER_LIMIT = 20;

  const activeFilterCount = [author, labels, freshness, embeddingStatus, dateFrom, dateTo].filter(Boolean).length;

  const clearAllFilters = useCallback(() => {
    setAuthor('');
    setLabels('');
    setFreshness('');
    setEmbeddingStatus('');
    setDateFrom('');
    setDateTo('');
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

  const selectAll = useCallback(() => {
    if (pagesData?.items) {
      setSelectedIds(new Set(pagesData.items.map((p) => p.id)));
    }
  }, [pagesData]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Pages</h1>
          <p className="text-sm text-muted-foreground">
            Browse and manage your Confluence knowledge base
          </p>
        </div>
        <div className="flex gap-2">
          <MagneticButton
            onClick={(e) => { ripple(e); syncMutation.mutate(); }}
            disabled={syncStatus?.status === 'syncing'}
            className="ripple-container glass-card flex items-center gap-2 px-4 py-2 text-sm hover:bg-foreground/5 disabled:opacity-50"
            data-testid="sync-btn"
          >
            <RefreshCw size={16} className={cn(syncStatus?.status === 'syncing' && 'animate-spin')} />
            {syncStatus?.status === 'syncing' ? 'Syncing...' : 'Sync'}
          </MagneticButton>
          <MagneticButton
            onClick={(e) => { ripple(e); navigate('/pages/new'); }}
            className="ripple-container flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            data-testid="new-page-btn"
          >
            <Plus size={16} />
            New Page
          </MagneticButton>
        </div>
      </div>

      {/* KPI cards */}
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

      {/* Embedding: real-time SSE progress (user-initiated) or polling fallback (background/other-tab) */}
      {(embeddingProcess.isProcessing || embeddingStatusData?.isProcessing) && (
        <div className="glass-card space-y-2 p-3 border border-primary/30" data-testid="embedding-progress-banner">
          <div className="flex items-center gap-3">
            <Loader2 size={16} className="animate-spin text-primary shrink-0" />
            <span className="text-sm flex-1 truncate">
              {embeddingProcess.isProcessing
                ? (embeddingProcess.progress.isWaiting
                    ? `Waiting for LLM server — ${embeddingProcess.progress.waitReason ?? 'circuit breaker open'}`
                    : embeddingProcess.progress.currentPage
                      ? `Embedding: ${embeddingProcess.progress.currentPage}`
                      : 'Embedding in progress')
                : `Embedding in progress — ${embeddingStatusData!.dirtyPages} pages remaining`}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <div className="h-1.5 w-32 overflow-hidden rounded-full bg-foreground/10">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: embeddingProcess.isProcessing
                    ? `${embeddingProcess.progress.percentage}%`
                    : `${((embeddingStatusData!.totalPages - embeddingStatusData!.dirtyPages) / Math.max(embeddingStatusData!.totalPages, 1)) * 100}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground">
                {embeddingProcess.isProcessing
                  ? `${embeddingProcess.progress.completed}/${embeddingProcess.progress.total}`
                  : `${embeddingStatusData!.totalPages - embeddingStatusData!.dirtyPages}/${embeddingStatusData!.totalPages}`}
              </span>
              {embeddingProcess.progress.failed > 0 && (
                <span className="text-xs text-destructive">
                  {embeddingProcess.progress.failed} failed
                </span>
              )}
            </div>
            {embeddingProcess.isProcessing && (
              <button
                onClick={embeddingProcess.cancel}
                className="rounded p-1 text-muted-foreground hover:text-foreground"
                title="Cancel"
                data-testid="embedding-cancel-btn"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Embed Now / Retry Failed: shown when not actively processing */}
      {!embeddingProcess.isProcessing && embeddingStatusData && (embeddingStatusData.dirtyPages > 0 || (embeddingStatusData.totalPages - embeddingStatusData.embeddedPages - embeddingStatusData.dirtyPages > 0)) && (
        <div className="glass-card flex items-center gap-3 p-3 border border-yellow-500/30" data-testid="embed-now-banner">
          <span className="text-sm">
            {embeddingStatusData.dirtyPages} page{embeddingStatusData.dirtyPages !== 1 ? 's' : ''} pending embedding
          </span>
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => embeddingProcess.start('/embeddings/process').catch((err) => toast.error(err instanceof Error ? err.message : 'Embedding failed'))}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              data-testid="embed-now-btn"
            >
              <Cpu size={14} />
              Embed Now
            </button>
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
              type="text"
              placeholder="Search pages..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="w-full rounded-md bg-foreground/5 py-2 pl-10 pr-4 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
            />
          </div>

          <select
            value={spaceKey}
            onChange={(e) => { setSpaceKey(e.target.value); setPage(1); setForcePageList(false); }}
            className="rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">All Spaces</option>
            {spaces?.map((s) => (
              <option key={s.key} value={s.key}>{s.name}</option>
            ))}
          </select>

          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            className="rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="modified">Last Modified</option>
            <option value="title">Title</option>
            <option value="author">Author</option>
          </select>

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
          <div className="flex flex-wrap items-end gap-3 border-t border-border/50 pt-3" data-testid="advanced-filters-panel">
            {/* Author filter */}
            <div className="min-w-40">
              <label className="mb-1 block text-xs text-muted-foreground">Author</label>
              <select
                value={author}
                onChange={(e) => { setAuthor(e.target.value); setPage(1); }}
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
                value={labels}
                onChange={(e) => { setLabels(e.target.value); setPage(1); }}
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
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
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
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
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="filter-embedding"
              >
                <option value="">Any</option>
                <option value="pending">Needs Embedding</option>
                <option value="done">Embedded</option>
              </select>
            </div>

            {/* Date range */}
            <div className="min-w-36">
              <label className="mb-1 block text-xs text-muted-foreground">Modified From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="filter-date-from"
              />
            </div>
            <div className="min-w-36">
              <label className="mb-1 block text-xs text-muted-foreground">Modified To</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
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
      </div>

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
      {/* Page list */}
      <AnimatePresence mode="wait">
      {isLoading ? (
        <m.div
          key="skeleton"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2 }}
          className="space-y-3"
        >
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonPageItem key={i} />
          ))}
        </m.div>
      ) : !pagesData?.items.length ? (
        <m.div
          key="empty"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="glass-card flex flex-col items-center justify-center py-16 text-center"
        >
          <FolderOpen size={48} className="mb-4 text-muted-foreground" />
          <p className="text-lg font-medium">No pages found</p>
          <p className="text-sm text-muted-foreground">
            {search ? 'Try a different search term' : 'Sync your Confluence spaces to see pages here'}
          </p>
        </m.div>
      ) : (
        <m.div
          key="list"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {useVirtual ? (
            /* Virtualized list for 20+ items: only renders visible rows */
            <div
              ref={virtualScrollRef}
              data-testid="virtual-scroll-container"
              className="overflow-auto"
              style={{ maxHeight: 'calc(100vh - 320px)', minHeight: 200 }}
            >
              <div
                style={{
                  height: `${rowVirtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const pageItem = pageItems[virtualRow.index];
                  const shouldAnimate = !reduceEffects && virtualRow.index < STAGGER_LIMIT;

                  return (
                    <div
                      key={pageItem.id}
                      data-index={virtualRow.index}
                      ref={rowVirtualizer.measureElement}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                      className="pb-2"
                    >
                      {shouldAnimate ? (
                        <m.div
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: virtualRow.index * 0.03 }}
                        >
                          <PageItemCard
                            pageItem={pageItem}
                            selectedIds={selectedIds}
                            pinnedIds={pinnedIds}
                            onToggleSelection={toggleSelection}
                            onTogglePin={handleTogglePin}
                            onNavigate={navigate}
                          />
                        </m.div>
                      ) : (
                        <PageItemCard
                          pageItem={pageItem}
                          selectedIds={selectedIds}
                          pinnedIds={pinnedIds}
                          onToggleSelection={toggleSelection}
                          onTogglePin={handleTogglePin}
                          onNavigate={navigate}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            /* Plain list for small item counts (<=20) */
            <div className="space-y-2">
              {pageItems.map((pageItem, i) => {
                const shouldAnimate = !reduceEffects && i < STAGGER_LIMIT;

                return shouldAnimate ? (
                  <m.div
                    key={pageItem.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.03 }}
                  >
                    <PageItemCard
                      pageItem={pageItem}
                      selectedIds={selectedIds}
                      pinnedIds={pinnedIds}
                      onToggleSelection={toggleSelection}
                      onTogglePin={handleTogglePin}
                      onNavigate={navigate}
                    />
                  </m.div>
                ) : (
                  <div key={pageItem.id}>
                    <PageItemCard
                      pageItem={pageItem}
                      selectedIds={selectedIds}
                      pinnedIds={pinnedIds}
                      onToggleSelection={toggleSelection}
                      onTogglePin={handleTogglePin}
                      onNavigate={navigate}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </m.div>
      )}
      </AnimatePresence>

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
    </div>
  );
}
