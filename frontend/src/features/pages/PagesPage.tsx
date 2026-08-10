import { useState, useCallback, useMemo, useRef, useEffect, memo, type RefObject } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { m } from 'framer-motion';
import { Search, FileText, Plus, ChevronLeft, ChevronRight, FolderOpen, Filter, X, List, Loader2, Trash2, Lock, Globe, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { PageSourceEnum, type PageSource } from '@compendiq/contracts';
import { usePages, usePageFilterOptions, usePage, useEmbeddingStatus, type QualityStatus, type SummaryStatus } from '../../shared/hooks/use-pages';
import { useSpaces, useSync, useSyncStatus } from '../../shared/hooks/use-spaces';
import { useSettings } from '../../shared/hooks/use-settings';
import { useSearch } from '../../shared/hooks/use-search';
import { EmptyState } from '../../shared/components/feedback/EmptyState';
import { QualityScoreBadge } from '../../shared/components/badges/QualityScoreBadge';
import { PageStateBadge } from '../../shared/components/badges/PageStateBadge';
import { KPICards } from './KPICards';
import { BulkActionBar } from './BulkActionBar';
import { bulkWireId } from '../../shared/hooks/use-bulk-page-actions';
import { PinnedArticlesSection } from './PinnedArticlesSection';
import {
  readFilterState,
  applyFilterPatch,
  hasAdvancedFilters,
  shouldAdoptUrlSearch,
  type PageFilterState,
} from './pages-filter-params';
import { cn } from '../../shared/lib/cn';
import { useIsLightTheme } from '../../shared/hooks/use-is-light-theme';
import { ShortcutHint } from '../../shared/components/ShortcutHint';
import { SanitizedHtml } from '../../shared/components/SanitizedHtml';
import { SETTINGS_PANELS } from '../settings/settings-nav';

// User-facing labels for the wire values of PageSourceEnum. Shared between the
// source-filter <option>s and the active-filter pill so they never diverge.
const SOURCE_LABELS: Record<PageSource, string> = {
  confluence: 'Confluence',
  standalone: 'Local',
};

// ---------------------------------------------------------------------------
// Memoized page list item: prevents re-render from embedding-status polling
// ---------------------------------------------------------------------------

interface PageListItemProps {
  pageItem: {
    id: string;
    spaceKey: string | null;
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
    source: 'confluence' | 'standalone';
    visibility?: string;
  };
  index: number;
  onNavigate: (id: string) => void;
  selected?: boolean;
  onToggleSelect?: (id: string, shiftKey: boolean) => void;
}

const PageListItem = memo(function PageListItem({
  pageItem, index: _index, onNavigate, selected = false, onToggleSelect,
}: PageListItemProps) {
  return (
    <m.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
    >
      <div
        className={cn(
          // A list row, not a card: px-3 py-2 and a 6px corner. `p-4` plus a
          // 12px radius is card geometry, and forty of them stacked reads as a
          // gallery of tiles rather than a list you scan down.
          //
          // Hover tints the row instead of colouring its border. An accent
          // border on hover competes with `selected`, which is the state that
          // actually needs to be seen across a long list.
          'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors',
          selected
            ? 'border-primary/50 bg-primary/[0.07]'
            : 'border-border bg-card hover:bg-accent',
        )}
        data-testid={`article-hover-${pageItem.id}`}
      >
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={selected}
            // Shift-click extends from the last toggled row, the convention in
            // every file list users already know.
            onClick={(e) => onToggleSelect(pageItem.id, e.shiftKey)}
            onChange={() => { /* click handler owns this; keeps React controlled */ }}
            aria-label={`Select ${pageItem.title}`}
            className="size-4 shrink-0 cursor-pointer accent-[var(--color-primary)]"
            data-testid={`page-select-${pageItem.id}`}
          />
        )}
        <button
          onClick={() => onNavigate(pageItem.id)}
          className="flex min-w-0 flex-1 items-center gap-4"
        >
          <div className="min-w-0 flex-1 text-left">
            <div className="flex items-center gap-2">
              {/* 13px medium. At 16px the title read as a card heading, which
                  is what made forty rows look like forty cards. */}
              <p className="truncate text-[13px] font-medium">{pageItem.title}</p>
              {/* Source badge */}
              {pageItem.source === 'standalone' ? (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/20 bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success"
                  data-testid="badge-local"
                  data-source-badge={pageItem.id}
                >
                  Local
                </span>
              ) : (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border border-info/20 bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info"
                  data-testid="badge-confluence"
                  data-source-badge={pageItem.id}
                >
                  Confluence
                </span>
              )}
              {/* Visibility badge for standalone articles */}
              {pageItem.source === 'standalone' && (
                (pageItem.visibility === 'shared') ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full border border-info/20 bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info"
                    data-testid="badge-shared"
                    data-visibility-badge={pageItem.id}
                  >
                    <Globe size={10} /> Shared
                  </span>
                ) : (
                  // Private = neutral gray. Was amber, but privacy carries no AI semantic.
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                    data-testid="badge-private"
                    data-visibility-badge={pageItem.id}
                  >
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
          {/* Trailing status cluster. `hidden sm:flex` because none of these
              can shrink: at 390px they held their width, drove the title's
              `min-w-0` block to zero, and rendered on top of the badges inside
              it — the row showed five overlapping pills and no title.

              Hidden rather than dropped, so they stay in the DOM for tests and
              for assistive tech, and so the same row markup serves both widths.
              The facts are not lost on mobile: every one of them is on the page
              itself, which is one tap away. */}
          {/* One pipeline badge, at every width, and it renders NOTHING when the
              page is healthy or the job was deliberately skipped. This replaces
              three near-duplicate pills ("Skipped / Skipped / Not Embedded");
              the severity ladder and the reasoning live in PageStateBadge. */}
          <PageStateBadge
            embeddingDirty={pageItem.embeddingDirty}
            summaryStatus={pageItem.summaryStatus}
            qualityStatus={pageItem.qualityStatus}
          />
          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            {/* Only when a score EXISTS. A number about the content is not
                pipeline state and an author acts on it differently — but
                "Not Scored" IS pipeline state, and PageStateBadge owns that. */}
            {pageItem.qualityScore !== null && pageItem.qualityScore !== undefined && (
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
            )}
            {/* No FreshnessBadge here: it is derived purely from lastModifiedAt,
                which this row already prints as a date three lines above. Two
                renderings of one field read as two facts. It stays on the page
                detail and preview surfaces, where no raw date sits beside it. */}
            {pageItem.labels.length > 0 && (
              <div className="flex gap-1">
                {pageItem.labels.slice(0, 3).map((label) => (
                  <span
                    key={label}
                    className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                    data-testid="label-chip"
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>
        </button>
      </div>
    </m.div>
  );
}, (prev, next) => {
  // Only re-render if the page-item data changed
  if (prev.pageItem.id !== next.pageItem.id) return false;
  if (prev.pageItem.version !== next.pageItem.version) return false;
  if (prev.pageItem.embeddingDirty !== next.pageItem.embeddingDirty) return false;
  if (prev.pageItem.qualityScore !== next.pageItem.qualityScore) return false;
  if (prev.pageItem.qualityStatus !== next.pageItem.qualityStatus) return false;
  if (prev.pageItem.summaryStatus !== next.pageItem.summaryStatus) return false;
  if (prev.index !== next.index) return false;
  // Selection is row-local render state, not page data. Omitting it here made
  // the checkbox permanently unclickable-looking: the Set updated and the
  // action bar counted correctly, but the row skipped its re-render, so React
  // restored the controlled input's DOM back to unchecked.
  if (prev.selected !== next.selected) return false;
  if (prev.onToggleSelect !== next.onToggleSelect) return false;
  return true;
});

// ---------------------------------------------------------------------------

export function PagesPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isLight = useIsLightTheme();

  // Filter / search / sort / pagination state lives in the URL, not in
  // component state (#1124). Opening an article unmounts this page; on the way
  // back React remounts it, and `useState` seeds would come back empty while
  // the URL does not. Routing it through the URL fixes browser back, in-app
  // back and deep links at once, and makes a filtered view shareable — which
  // is the part a Zustand store could not do.
  const filters = useMemo(() => readFilterState(searchParams), [searchParams]);
  const { space: spaceKey, author, labels, freshness, quality: qualityFilter,
    from: dateFrom, to: dateTo, source: sourceFilter, sort, mode: searchMode, page } = filters;
  const embeddingStatus = filters.embedding;

  /**
   * Write a filter change back to the URL.
   *
   * `replace: true` is load-bearing: pushing an entry per filter change would
   * turn the Back button into "undo one filter", so returning to the article
   * you came from would take a dozen presses. With replace, the only pushed
   * entry between the overview and an article is the article itself — so one
   * Back lands on the overview with its filters intact, which is the bug.
   */
  // React Router hands the updater `new URLSearchParams(searchParams)` — the
  // *render-time* value, not the live query string. Two writes in one tick (the
  // search debounce firing while a <select> onChange also writes) would
  // therefore both start from the same base, and the second would silently drop
  // the first's param. `pendingParams` carries the last value we produced so
  // consecutive patches compose; the effect below releases it once the URL has
  // caught up, so a back/forward press starts from the real thing again.
  const pendingParams = useRef<URLSearchParams | null>(null);
  const setFilters = useCallback((patch: Partial<PageFilterState>) => {
    setSearchParams((prev) => {
      const next = applyFilterPatch(pendingParams.current ?? prev, patch);
      pendingParams.current = next;
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  useEffect(() => {
    pendingParams.current = null;
  }, [searchParams]);

  // The search box keeps its own state so typing never waits on a navigation:
  // the URL carries the *settled* term, written once the user pauses. Seeded
  // from the URL so a deep link (or a back-navigation) starts in sync.
  const [searchInput, setSearchInput] = useState(filters.search);
  const search = searchInput;

  // Open the advanced panel when the URL arrives carrying one of its filters —
  // otherwise the user lands on a short result set whose cause is hidden.
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(() => hasAdvancedFilters(filters));

  // Bulk selection. Held as a Set of page ids so toggling stays O(1) and the
  // memoised PageListItem only re-renders for rows whose own state changed.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const lastToggledId = useRef<string | null>(null);

  // Debounce the search term before it reaches the keyword /pages query.
  // Typing stays responsive because `searchInput` drives the input value,
  // clear button, sort switch and semantic-mode gate synchronously; only the
  // network request waits for a 300ms pause (mirrors useSearch). Without this
  // every keystroke minted a new query key and fired a fresh, rate-limited
  // GET /pages?search=… (#874).
  //
  // The URL now *is* the debounced term (#1124), which collapses what used to
  // be two pieces of state into one and keeps a keystroke from writing history
  // on every character. A deep-linked `?search=` therefore fetches on the first
  // render instead of after an empty-list flash plus 300ms.
  const debouncedSearch = filters.search;
  // What this component last pushed into the URL. Compared against on re-seed
  // so our own write, arriving late, cannot overwrite newer typing.
  const lastWrittenSearch = useRef(filters.search);
  useEffect(() => {
    if (searchInput === filters.search) return;
    const timer = setTimeout(() => {
      lastWrittenSearch.current = searchInput;
      setFilters({ search: searchInput, page: 1 });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, filters.search, setFilters]);

  // The date inputs get the same treatment as the search box, for the same
  // reason: holding an arrow key adjusts a segment at OS key-repeat rate, and
  // each of those was a `history.replaceState`. Browsers throttle that (Safari
  // caps it at ~100 calls per 30s), so a few seconds of held arrow could stop
  // the URL updating at all.
  const [dateFromInput, setDateFromInput] = useState(dateFrom);
  const [dateToInput, setDateToInput] = useState(dateTo);
  useEffect(() => {
    if (dateFromInput === filters.from) return;
    const timer = setTimeout(() => setFilters({ from: dateFromInput, page: 1 }), 300);
    return () => clearTimeout(timer);
  }, [dateFromInput, filters.from, setFilters]);
  useEffect(() => {
    if (dateToInput === filters.to) return;
    const timer = setTimeout(() => setFilters({ to: dateToInput, page: 1 }), 300);
    return () => clearTimeout(timer);
  }, [dateToInput, filters.to, setFilters]);
  // Adopt an external change (back/forward, a deep link, or Clear filters),
  // which is unambiguous here: the inputs are only ever written by the user or
  // by us, and our own write leaves the two already equal.
  const [previousUrlDates, setPreviousUrlDates] = useState({ from: dateFrom, to: dateTo });
  if (previousUrlDates.from !== filters.from || previousUrlDates.to !== filters.to) {
    setPreviousUrlDates({ from: filters.from, to: filters.to });
    if (previousUrlDates.from !== filters.from && filters.from !== dateFromInput) setDateFromInput(filters.from);
    if (previousUrlDates.to !== filters.to && filters.to !== dateToInput) setDateToInput(filters.to);
  }

  // Re-seed the box when the URL's term changes underneath us — a back/forward
  // press or an in-app link that lands on `/?search=…` without unmounting this
  // page. Adjusting state during render (rather than in an effect) is the React
  // idiom for this: an effect would let one frame render the stale term, and
  // the debounce above would then push it straight back into the URL, undoing
  // the navigation the user just made.
  //
  // Previous-value held as state, not a ref: React Router commits inside a
  // transition, and a render that gets discarded would leave a ref mutated
  // while the state it guards was rolled back. `shouldAdoptUrlSearch` owns the
  // decision itself — see its comment for why our own writes are excluded.
  const [previousUrlSearch, setPreviousUrlSearch] = useState(filters.search);
  if (previousUrlSearch !== filters.search) {
    setPreviousUrlSearch(filters.search);
    if (shouldAdoptUrlSearch({
      urlSearch: filters.search,
      previousUrlSearch,
      boxValue: searchInput,
      lastWritten: lastWrittenSearch.current,
    })) {
      setSearchInput(filters.search);
    }
  }

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
  const homeBodyHtml = homePage?.bodyHtml ?? '';

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

  // Semantic/hybrid search — only active when there's a search query AND mode is not 'keyword'
  const useSemanticSearch = !!(search && searchMode !== 'keyword');

  // Keep the /pages query key atomic: `search` is debounced, so the `sort` that
  // feeds the key must track the DEBOUNCED term, not the raw one. Otherwise the
  // first keystroke (which flips `sort` to 'relevance' synchronously while the
  // debounced term is still empty) mints a key with sort=relevance + no search
  // and fires an immediate wrong-data GET /pages?sort=relevance before the
  // debounce elapses. The visible `sort` dropdown and the auto-switch-to-
  // relevance UX are unchanged — only the query sort waits for the term (#874).
  const querySort = debouncedSearch.trim()
    ? sort
    : (sort === 'relevance' ? 'modified' : sort);

  const { data: pagesData, isLoading, isFetching: isFetchingPages, error: pagesError, refetch: refetchPages } = usePages({
    spaceKey: spaceKey || undefined,
    search: debouncedSearch || undefined,
    author: author || undefined,
    labels: labels || undefined,
    freshness: (freshness || undefined) as 'fresh' | 'recent' | 'aging' | 'stale' | undefined,
    embeddingStatus: (embeddingStatus || undefined) as 'pending' | 'done' | undefined,
    ...qualityRange,
    source: sourceFilter || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    sort: querySort,
    // In semantic/hybrid mode the rendered results come from useSearch below,
    // so the keyword list query would just fire wasted, rate-limited requests
    // for data that is never shown — gate it off (#874).
    enabled: !useSemanticSearch,
  });
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

  // Focus search input on mount
  useEffect(() => {
    searchInputRef.current?.focus();
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
    // Keys are the URL param names so `clearFilter` can act on them directly.
    if (author) filters.push({ key: 'author', label: `Author: ${author}` });
    if (labels) filters.push({ key: 'labels', label: `Label: ${labels}` });
    if (freshness) filters.push({ key: 'freshness', label: `Freshness: ${freshness}` });
    if (embeddingStatus) filters.push({ key: 'embedding', label: `Embedding: ${embeddingStatus}` });
    if (qualityFilter) filters.push({ key: 'quality', label: `Quality: ${qualityFilter}` });
    if (dateFrom) filters.push({ key: 'from', label: `From: ${dateFrom}` });
    if (dateTo) filters.push({ key: 'to', label: `To: ${dateTo}` });
    if (sourceFilter) filters.push({ key: 'source', label: `Source: ${SOURCE_LABELS[sourceFilter]}` });
    return filters;
  }, [author, labels, freshness, embeddingStatus, qualityFilter, dateFrom, dateTo, sourceFilter]);

  const activeFilterCount = activeFilters.length;

  // The pill keys are the URL param names, so a pill clears exactly the param
  // it renders — no second mapping table to drift out of sync.
  const clearFilter = useCallback((key: string) => {
    setFilters({ [key]: '', page: 1 } as Partial<PageFilterState>);
  }, [setFilters]);

  const clearAllFilters = useCallback(() => {
    setFilters({
      author: '',
      labels: '',
      freshness: '',
      embedding: '',
      quality: '',
      from: '',
      to: '',
      source: '',
      page: 1,
    });
  }, [setFilters]);

  const navigateToPage = useCallback((id: string) => {
    navigate(`/pages/${id}`);
  }, [navigate]);

  // Virtual scrolling for the keyword/browse page list. Memoised because the
  // `?? []` fallback would otherwise mint a new array every render and break
  // the memoisation of every selection callback that depends on it.
  const pageItems = useMemo(() => pagesData?.items ?? [], [pagesData?.items]);
  const scrollMargin = listContainerRef.current?.offsetTop ?? 0;

  const toggleSelect = useCallback((id: string, shiftKey: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const anchor = lastToggledId.current;

      // Shift-click selects the contiguous run between the anchor and this
      // row, matching the file-list convention. Falls back to a plain toggle
      // when either end is no longer in the current result set (filters or
      // pagination changed underneath the selection).
      if (shiftKey && anchor && anchor !== id) {
        const ids = pageItems.map((p) => p.id);
        const from = ids.indexOf(anchor);
        const to = ids.indexOf(id);
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          const selecting = !prev.has(id);
          for (const rangeId of ids.slice(lo, hi + 1)) {
            if (selecting) next.add(rangeId);
            else next.delete(rangeId);
          }
          lastToggledId.current = id;
          return next;
        }
      }

      if (next.has(id)) next.delete(id);
      else next.add(id);
      lastToggledId.current = id;
      return next;
    });
  }, [pageItems]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    lastToggledId.current = null;
  }, []);

  // Drop ids that fell out of the result set, so the action bar never reports
  // a count that includes rows the user can no longer see.
  //
  // Mapped through `bulkWireId`: selection is keyed by row id (the PK, which is
  // what the checkboxes and the memo comparator use), but the bulk routes
  // address synced pages by `confluence_id`. Sending the PK still resolved the
  // row, so the action ran — the server just couldn't match the id back and
  // counted every synced page as not-found.
  const visibleSelectedIds = useMemo(
    () => pageItems.filter((p) => selectedIds.has(p.id)).map(bulkWireId),
    [pageItems, selectedIds],
  );
  const selectedConfluenceCount = useMemo(
    () => pageItems.filter((p) => selectedIds.has(p.id) && p.source === 'confluence').length,
    [pageItems, selectedIds],
  );
  const allVisibleSelected = pageItems.length > 0 && visibleSelectedIds.length === pageItems.length;

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const allSelected = pageItems.length > 0 && pageItems.every((p) => prev.has(p.id));
      if (allSelected) return new Set();
      return new Set(pageItems.map((p) => p.id));
    });
    lastToggledId.current = null;
  }, [pageItems]);

  const virtualizer = useVirtualizer({
    count: pageItems.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => 80,
    overscan: 5,
    scrollMargin,
    useFlushSync: false, // Required for React 19
  });

  return (
    <div className="space-y-3">
      {/* Header. 18px semibold, not 24px bold: this is a route label, and the
          sidebar already says where you are. The old scale plus a subtitle plus
          `space-y-6` spent ~110px of the first viewport restating the nav. */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Pages</h1>
          <p className="text-[13px] text-muted-foreground">
            Browse and manage your knowledge base
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => navigate('/trash')}
            className="rounded-xl border border-border bg-card flex items-center gap-2 px-4 py-2 text-sm hover:bg-foreground/5"
            data-testid="trash-link"
          >
            <Trash2 size={16} />
            <span className="hidden sm:inline">Trash</span>
          </button>
          {/* Sync moved into the Last Sync KPI card, where it sits beside the
              value it acts on. Keeping a second copy here would have made the
              header four buttons wide for no added reach. */}
          {/* The one FILLED control on this route. Everything here was an
              outlined rectangle, so the accent never actually filled anything
              and the page had no fast path to its own primary action — which is
              half of what the brief asked Plane for. `nm-button-primary` is the
              filled recipe; the outline treatment stays for secondary actions,
              which is what makes this one read as primary. */}
          <button
            onClick={() => navigate('/pages/new')}
            className="nm-button-primary"
          >
            <Plus size={16} />
            {/* Labelled at every width. `hidden sm:inline` was survivable while
                this was an outline square matching the one beside it; filling it
                aimed the eye at the only control on the page whose meaning was
                unstated. A saturated icon-only square is a worse affordance than
                a quiet one. */}
            <span>New Page</span>
            {/* Full-opacity ink. At /80 on the accent fill this chip became the
                lowest-contrast text in the frame — the theme guard measures
                `primary-foreground` on `primary`, but nothing measures a
                translucent variant of it, so the alpha put 11px text somewhere
                no test was looking. */}
            <ShortcutHint shortcutId="new-page" className="border-primary-foreground/30 bg-transparent text-primary-foreground" />
          </button>
        </div>
      </div>

      {/* Landmarked and headed so screen-reader users can jump between the
          three regions of this page. Previously the whole dashboard exposed a
          single H1 and nothing else, which made heading navigation — the
          primary wayfinding tool — useless on the app's main screen. */}
      <section aria-labelledby="kb-status-heading">
        <h2 id="kb-status-heading" className="sr-only">Knowledge base status</h2>
        <KPICards
        embeddingStatus={embeddingStatusData}
        spacesCount={spaces?.length ?? 0}
        lastSynced={syncStatus?.lastSynced}
          onSync={() => syncMutation.mutate()}
          isSyncing={syncStatus?.status === 'syncing'}
        />
      </section>

      {/* Sync progress */}
      {syncStatus?.status === 'syncing' && syncStatus.progress && (
        <div className="rounded-xl border border-border bg-card p-3">
          <div className="flex items-center justify-between text-sm">
            <span>Syncing {syncStatus.progress.space}...</span>
            <span>{syncStatus.progress.current}/{syncStatus.progress.total}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-foreground/10">
            <div
              className="h-full rounded-full bg-action transition-all"
              style={{ width: `${(syncStatus.progress.current / syncStatus.progress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Embedding progress */}
      {embeddingStatusData?.isProcessing && (
        <div className="rounded-xl border border-border bg-card flex items-center gap-3 p-3 border border-primary/30" data-testid="embedding-progress-banner">
          <Loader2 size={16} className="animate-spin text-action" />
          <span className="text-sm">
            Embedding in progress — {embeddingStatusData.dirtyPages} pages remaining
          </span>
          <div className="ml-auto flex items-center gap-2">
            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-foreground/10">
              <div
                className="h-full rounded-full bg-action transition-all"
                style={{ width: `${(embeddingStatusData.embeddedPages / Math.max(embeddingStatusData.totalPages, 1)) * 100}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground">
              {embeddingStatusData.embeddedPages}/{embeddingStatusData.totalPages}
            </span>
          </div>
        </div>
      )}

      {/* Pinned Pages */}
      <PinnedArticlesSection />

      {/* Filters */}
      {/* A control row, not a pane. This was a bordered `bg-card` box with
          `p-4`, stacked directly under another bordered box (the status strip)
          and above the list's own bordered rows — three nested container
          levels before the first page. Controls do not need a container: they
          are already legible as controls, and the box was spending ~90px of the
          first viewport to say "these things belong together", which their
          adjacency already said. */}
      <section aria-labelledby="kb-filters-heading" className="space-y-3">
        <h2 id="kb-filters-heading" className="sr-only">Search and filter pages</h2>
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
                setSearchInput(val);
                if (val.trim()) {
                  // Only on the transition, so a URL write costs one navigation
                  // per search rather than one per keystroke.
                  if (sort !== 'relevance') setFilters({ sort: 'relevance', page: 1 });
                } else {
                  // Field emptied: clear the settled term synchronously so the
                  // pending 300ms write never lands the stale one, and drop the
                  // relevance sort back to modified (#874).
                  setFilters({ search: '', page: 1, ...(sort === 'relevance' ? { sort: 'modified' } : {}) });
                }
              }}
              className="nm-input pl-10 pr-10"
            />
            {search && (
              <button
                onClick={() => {
                  setSearchInput('');
                  setFilters({ search: '', page: 1, mode: 'keyword', ...(sort === 'relevance' ? { sort: 'modified' } : {}) });
                  searchInputRef.current?.focus();
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                data-testid="search-clear"
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Search mode toggle — keyword / semantic / hybrid.

              A segmented control on a recessed track, not three loose pills.
              The active segment used to be a near-black `bg-action` fill with a
              coloured shadow and a ring, which read as the most important
              control on the page — louder than "New Page", the actual primary
              action — when all it does is pick a retrieval strategy. Neutral
              fill plus weight carries "selected" here; the accent stays spent
              on actions. */}
          <div
            className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted p-0.5"
            data-testid="search-mode-toggle"
            role="group"
            aria-label="Search mode"
          >
              {(['keyword', 'semantic', 'hybrid'] as const).map((m) => (
                <button
                  key={m}
                  data-testid={`search-mode-${m}`}
                  onClick={() => setFilters({ mode: m, page: 1 })}
                  aria-pressed={searchMode === m}
                  className={cn(
                    'rounded-sm px-2.5 py-1 text-xs font-medium capitalize transition-colors',
                    searchMode === m
                      ? 'nm-pill-active'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {m}
                </button>
              ))}
              {searchResults.isLoadingEnhanced && (
                <Loader2 size={14} className="ml-1 animate-spin text-action" data-testid="search-enhanced-loading" />
              )}
            </div>

          <select
            value={spaceKey}
            onChange={(e) => { setFilters({ space: e.target.value, page: 1 }); setForcePageList(false); }}
            className="nm-select-md w-40 shrink-0"
            aria-label="Filter by space"
          >
            <option value="">All Spaces</option>
            {spaces?.map((s) => (
              <option key={s.key} value={s.key}>{s.name}</option>
            ))}
          </select>

          <select
            value={sourceFilter}
            onChange={(e) => setFilters({ source: e.target.value as PageSource | '', page: 1 })}
            className="nm-select-md w-32 shrink-0"
            data-testid="filter-source"
            aria-label="Filter by source"
          >
            <option value="">All Sources</option>
            {PageSourceEnum.options.map((source) => (
              <option key={source} value={source}>{SOURCE_LABELS[source]}</option>
            ))}
          </select>

          <select
            value={sort}
            onChange={(e) => setFilters({ sort: e.target.value as typeof sort })}
            className="nm-select-md w-40 shrink-0"
            aria-label="Sort pages"
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
                ? 'bg-action/15 text-action'
                : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10',
            )}
            data-testid="advanced-filters-toggle"
          >
            <Filter size={14} />
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-1 flex h-5 w-5 items-center justify-center rounded-full bg-action text-[11px] font-bold text-action-foreground">
                {activeFilterCount}
              </span>
            )}
          </button>

        </div>

        {/* Advanced filters panel */}
        {showAdvancedFilters && (
          <div className="grid grid-cols-2 items-end gap-3 border-t border-border pt-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="advanced-filters-panel">
            {/* Author filter */}
            <div className="min-w-40">
              <label htmlFor="filter-author-select" className="mb-1 block text-xs text-muted-foreground">Author</label>
              <select
                id="filter-author-select"
                value={author}
                onChange={(e) => setFilters({ author: e.target.value, page: 1 })}
                className="nm-select-md w-full"
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
              <label htmlFor="filter-labels-select" className="mb-1 block text-xs text-muted-foreground">Labels</label>
              <select
                id="filter-labels-select"
                value={labels}
                onChange={(e) => setFilters({ labels: e.target.value, page: 1 })}
                className="nm-select-md w-full"
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
              <label htmlFor="filter-freshness-select" className="mb-1 block text-xs text-muted-foreground">Freshness</label>
              <select
                id="filter-freshness-select"
                value={freshness}
                onChange={(e) => setFilters({ freshness: e.target.value, page: 1 })}
                className="nm-select-md w-full"
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
              <label htmlFor="filter-embedding-select" className="mb-1 block text-xs text-muted-foreground">Embedding</label>
              <select
                id="filter-embedding-select"
                value={embeddingStatus}
                onChange={(e) => setFilters({ embedding: e.target.value, page: 1 })}
                className="nm-select-md w-full"
                data-testid="filter-embedding"
              >
                <option value="">Any</option>
                <option value="pending">Needs Embedding</option>
                <option value="done">Embedded</option>
              </select>
            </div>

            {/* Quality score filter */}
            <div className="min-w-36">
              <label htmlFor="filter-quality-select" className="mb-1 block text-xs text-muted-foreground">Quality</label>
              <select
                id="filter-quality-select"
                value={qualityFilter}
                onChange={(e) => setFilters({ quality: e.target.value, page: 1 })}
                className="nm-select-md w-full"
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
              <label htmlFor="filter-date-from-input" className="mb-1 block text-xs text-muted-foreground">Modified From</label>
              <input
                id="filter-date-from-input"
                type="date"
                value={dateFromInput}
                onChange={(e) => setDateFromInput(e.target.value)}
                className="nm-select-md w-full"
                data-testid="filter-date-from"
              />
            </div>
            <div className="min-w-36">
              <label htmlFor="filter-date-to-input" className="mb-1 block text-xs text-muted-foreground">Modified To</label>
              <input
                id="filter-date-to-input"
                type="date"
                value={dateToInput}
                onChange={(e) => setDateToInput(e.target.value)}
                className="nm-select-md w-full"
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

        {/* Active filter pills.
            Semantic/hybrid search ignores advanced filters (the backend
            vector/hybrid paths never receive them), so when semantic search is
            running we visually mark the pills as inactive rather than pretend
            they still filter the results (#945). */}
        {activeFilters.length > 0 && (
          <div
            className={cn(
              'flex flex-wrap items-center gap-2 border-t border-border pt-3',
              useSemanticSearch && 'opacity-50',
            )}
            data-testid="active-filter-pills"
            data-inactive={useSemanticSearch ? 'true' : undefined}
            aria-disabled={useSemanticSearch || undefined}
          >
            {activeFilters.map((f) => (
              <button
                key={f.key}
                onClick={() => clearFilter(f.key)}
                className="inline-flex items-center gap-1 rounded-full bg-action/10 px-2.5 py-0.5 text-xs font-medium text-action"
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

        {/* Honest notice: advanced filters are keyword-only. In semantic/hybrid
            mode the backend ignores them, so tell the user instead of silently
            dropping them (#945). */}
        {useSemanticSearch && activeFilterCount > 0 && (
          <p
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-testid="filters-ignored-notice"
          >
            <AlertTriangle size={12} className="shrink-0 text-warning" aria-hidden="true" />
            Advanced filters apply to keyword search only — they don't affect semantic or hybrid results.
          </p>
        )}
      </section>

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

      {/* Degraded-coverage warning (#1117): semantic search runs, but over a
          partial vector index — during a re-embed, or after failed embedding
          runs. Amber per ADR-010: this is attention, not decoration. The page's
          embedding-status card carries progress and recovery. */}
      {search && searchMode !== 'keyword' && searchResults.hasEmbeddings
        && searchResults.degradedReason === 'partial_embeddings' && (
        <div
          className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
          data-testid="degraded-embeddings-warning"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            {/* floor, not round: 94.9% must not display as the 95% threshold
                that would have made this healthy, and near-zero coverage says
                "less than 1%" rather than the sibling banner's 0% state. The
                epsilon corrects binary floating point (0.29*100 = 28.999…). */}
            Semantic search is degraded — only{' '}
            {Math.floor((searchResults.embeddingCoverage ?? 0) * 100 + 1e-9) === 0
              ? 'less than 1%'
              : `${Math.floor((searchResults.embeddingCoverage ?? 0) * 100 + 1e-9)}%`}{' '}
            of pages are embedded. Results may miss pages that are not embedded yet.
          </span>
        </div>
      )}

      {/* Space home content (when enabled and a space is selected) */}
      {showHomeContent && !forcePageList ? (
        homePageLoading ? (
          <div className="rounded-xl border border-border bg-card h-96 animate-pulse" />
        ) : homePage ? (
          <m.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">{homePage.title}</h2>
              <div className="flex gap-2">
                <button
                  onClick={() => navigate(`/pages/${homePage.id}`)}
                  className="rounded-xl border border-border bg-card flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-foreground/5"
                >
                  <FileText size={14} /> View Full Page
                </button>
                <button
                  onClick={() => setForcePageList(true)}
                  className="rounded-xl border border-border bg-card flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-foreground/5"
                  data-testid="show-page-list"
                >
                  <List size={14} /> Show All Pages
                </button>
              </div>
            </div>
            <SanitizedHtml
              className={`rounded-xl border border-border bg-card prose max-w-none p-6${isLight ? '' : ' prose-invert'}`}
              html={homeBodyHtml}
              additionalAllowedAttrs={['data-diagram-name', 'data-drawio', 'data-color', 'data-layout-type', 'data-cell-width', 'data-border']}
            />
          </m.div>
        ) : null
      ) : (
      <>
      {/* Page list — semantic/hybrid search results */}
      <section aria-labelledby="kb-results-heading">
      <h2 id="kb-results-heading" className="sr-only">Page results</h2>
      {useSemanticSearch ? (
        <>
          {searchResults.isLoadingImmediate && searchResults.immediateResults.length === 0 ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="rounded-xl border border-border bg-card h-16 animate-pulse" />
              ))}
            </div>
          ) : (() => {
            const displayItems = searchResults.enhancedResults ?? searchResults.immediateResults;
            return displayItems.length === 0 ? (
              <EmptyState
                icon={FolderOpen}
                title={searchResults.hasEmbeddings ? 'No pages found' : 'No matching pages'}
                description={
                  searchResults.hasEmbeddings
                    ? 'Try a different search term or switch to keyword mode'
                    // Zero embeddings: the banner above already says keyword
                    // fallback ran, so acknowledge both facts — the query
                    // matched nothing AND semantic search is unavailable
                    // (#938; copy reconciled in the #993 review).
                    : `Keyword search found no matches. Semantic search is unavailable until pages are embedded — configure an embedding provider in Settings → ${SETTINGS_PANELS.models.label} and run an embedding pass.`
                }
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
                        className="rounded-xl border border-border bg-card transition-all hover:border-primary/50 flex w-full items-center gap-3 p-4 text-left"
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
                        {/* Similarity only — `score` carries whatever unit the
                            mode produced, so rendering it showed the same page
                            at ~87% in semantic and ~2% in hybrid (#1117). Null
                            (keyword mode, or a full-text-only hybrid row) shows
                            nothing rather than "0%". The `> 0` half is the
                            pre-#1117 guard, kept: cosine distance runs to 2, so
                            `1 - distance` can be negative for a chunk pointing
                            away from the query, and "-23%" is not a useful
                            badge. */}
                        {item.similarity !== null && item.similarity > 0 && (
                          <span
                            title="Semantic similarity to your query"
                            className="shrink-0 rounded-full bg-foreground/5 px-2 py-0.5 text-xs text-muted-foreground"
                          >
                            {(item.similarity * 100).toFixed(0)}%
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
                onClick={() => setFilters({ page: Math.max(1, page - 1) })}
                disabled={page <= 1}
                aria-label="Previous page"
                className="rounded-xl border border-border bg-card p-2 disabled:opacity-30"
              >
                <ChevronLeft size={18} />
              </button>
              <span className="text-sm text-muted-foreground" aria-live="polite">
                Page {page} of {searchResults.totalPages}
              </span>
              <button
                onClick={() => setFilters({ page: Math.min(searchResults.totalPages, page + 1) })}
                disabled={page >= searchResults.totalPages}
                aria-label="Next page"
                className="rounded-xl border border-border bg-card p-2 disabled:opacity-30"
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
                <div key={i} className="rounded-xl border border-border bg-card h-16 animate-pulse" />
              ))}
            </div>
          ) : pagesError && !pagesData ? (
            <div
              className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm"
              data-testid="pages-error-state"
            >
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-destructive" />
              <div className="flex-1">
                <p className="font-medium text-destructive">Couldn't load pages</p>
                <p className="mt-1 text-muted-foreground">{pagesError.message}</p>
              </div>
              <button
                onClick={() => refetchPages()}
                disabled={isFetchingPages}
                className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-60"
                data-testid="pages-error-retry"
              >
                {isFetchingPages && <Loader2 size={12} className="animate-spin" />}
                {isFetchingPages ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          ) : !pagesData?.items.length ? (
            <EmptyState
              icon={FolderOpen}
              title="No pages found"
              description={search ? 'Try a different search term' : 'Sync your Confluence spaces to see pages here'}
              action={!search ? { label: 'Go to Settings', onClick: () => navigate('/settings') } : undefined}
            />
          ) : (
            <>
            {/* Select-all + bulk actions. The four /pages/bulk/* endpoints
                shipped with no UI, so re-embedding a large space meant one
                row at a time. */}
            <div className="mb-3 space-y-3">
              <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  ref={(el) => {
                    // Partial selection is a third state; without it the box
                    // reads "nothing selected" while rows plainly are.
                    if (el) el.indeterminate = visibleSelectedIds.length > 0 && !allVisibleSelected;
                  }}
                  onChange={toggleSelectAll}
                  aria-label={allVisibleSelected ? 'Deselect all pages' : 'Select all pages'}
                  className="size-4 cursor-pointer accent-[var(--color-action)]"
                  data-testid="select-all-pages"
                />
                Select all on this page
              </label>

              <BulkActionBar
                selectedIds={visibleSelectedIds}
                confluenceCount={selectedConfluenceCount}
                onClear={clearSelection}
              />
            </div>

            <div
              ref={listContainerRef}
              data-testid="virtual-list-container"
              style={{ position: 'relative', height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const pageItem = pageItems[virtualRow.index];
                if (!pageItem) return null;
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
                        onNavigate={navigateToPage}
                        selected={selectedIds.has(pageItem.id)}
                        onToggleSelect={toggleSelect}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            </>
          )}

          {/* Pagination */}
          {pagesData && pagesData.totalPages > 1 && (
            <div className="flex items-center justify-center gap-4">
              <button
                onClick={() => setFilters({ page: Math.max(1, page - 1) })}
                disabled={page <= 1}
                aria-label="Previous page"
                className="rounded-xl border border-border bg-card p-2 disabled:opacity-30"
              >
                <ChevronLeft size={18} />
              </button>
              <span className="text-sm text-muted-foreground" aria-live="polite">
                Page {page} of {pagesData.totalPages}
              </span>
              <button
                onClick={() => setFilters({ page: Math.min(pagesData.totalPages, page + 1) })}
                disabled={page >= pagesData.totalPages}
                aria-label="Next page"
                className="rounded-xl border border-border bg-card p-2 disabled:opacity-30"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          )}
        </>
      )}
      </section>
      </>
      )}
    </div>
  );
}
