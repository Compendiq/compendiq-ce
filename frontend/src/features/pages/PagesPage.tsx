import { useState, useCallback, useMemo, useRef, useEffect, memo, type RefObject } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { m } from 'framer-motion';
import { Search, FileText, Plus, ChevronLeft, ChevronRight, ChevronDown, FolderOpen, Filter, X, List, Loader2, Lock, Globe, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { PageSourceEnum, type PageSource, type PageIcon as PageIconValue } from '@compendiq/contracts';
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
import { LibrarySpaceFilter } from './LibrarySpaceFilter';
import { LibrarySortFilter } from './LibrarySortFilter';
import {
  readFilterState,
  applyFilterPatch,
  hasAdvancedFilters,
  shouldAdoptUrlSearch,
  FILTER_DEFAULTS,
  type PageFilterState,
} from './pages-filter-params';
import { cn } from '../../shared/lib/cn';
import { neutralChipClass } from '../../shared/components/badges/neutral-chip';
import { useIsLightTheme } from '../../shared/hooks/use-is-light-theme';
import { ShortcutHint } from '../../shared/components/ShortcutHint';
import { PageIcon } from '../../shared/components/page-icon/PageIcon';
import { HeaderHost } from '../../shared/components/layout/header-slot';
import { SanitizedHtml } from '../../shared/components/SanitizedHtml';
import { SETTINGS_PANELS } from '../settings/settings-nav';
import { useKeyboardShortcuts, type ShortcutDefinition } from '../../shared/hooks/use-keyboard-shortcuts';
import { FIND_LABEL, FIND_PLACEHOLDER, LIBRARY_HEADING, SEARCH_MODE_DESCRIPTIONS, SEARCH_MODE_LABELS } from './pages-find';

// User-facing labels for the wire values of PageSourceEnum. Shared between the
// source-filter <option>s and the active-filter pill so they never diverge.
const SOURCE_LABELS: Record<PageSource, string> = {
  confluence: 'Confluence',
  standalone: 'Local',
};

// Human-readable labels for the wire values of the Freshness / Embedding /
// Quality filters, matching each <option>'s own text exactly. Until this
// polish pass only the source pill read a label map like this one — every
// other pill printed the raw enum value (`Freshness: stale`, `Quality:
// poor`) while the dropdown that set it read `Stale (>90 days)`, `Poor
// (0-49)`: two vocabularies for one value, ~40px apart on screen (2026-08-17).
const FRESHNESS_LABELS: Record<string, string> = {
  fresh: 'Fresh (<7 days)',
  recent: 'Recent (7-30 days)',
  aging: 'Aging (30-90 days)',
  stale: 'Stale (>90 days)',
};
const EMBEDDING_LABELS: Record<string, string> = {
  pending: 'Needs Embedding',
  done: 'Embedded',
};
const QUALITY_LABELS: Record<string, string> = {
  excellent: 'Excellent (90-100)',
  good: 'Good (70-89)',
  'needs-work': 'Needs Work (50-69)',
  poor: 'Poor (0-49)',
};

/**
 * "A, B" for up to 3 labels; "A, B, C, and N more" beyond that. Shared by the
 * #945 semantic-search honesty notice and the filtered-to-zero empty state
 * (harden pass, 2026-08-17) so both describe the same active-filter set the
 * same way rather than drifting apart with their own truncation rules.
 */
function summarizeFilterLabels(labels: string[]): string {
  return labels.length <= 3
    ? labels.join(', ')
    : `${labels.slice(0, 3).join(', ')}, and ${labels.length - 3} more`;
}

// ---------------------------------------------------------------------------
// Memoized page list item: prevents re-render from embedding-status polling
// ---------------------------------------------------------------------------

interface PageListItemProps {
  showSource?: boolean;
  showVisibility?: boolean;
  showQuality?: boolean;
  /** When false, hide idle "Not indexed" so an unindexed corpus is not a wall of chips. */
  showIdleEmbedding?: boolean;
  /** True once any row is selected — row checkboxes stay visible for the rest of the pass. */
  selectionArmed?: boolean;
  /** Space display name when known; the key is the fallback. */
  spaceName?: string | null;
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
    icon?: PageIconValue | null;
  };
  index: number;
  onNavigate: (id: string) => void;
  selected?: boolean;
  onToggleSelect?: (id: string, shiftKey: boolean) => void;
}

const PageListItem = memo(function PageListItem({
  pageItem, index: _index, onNavigate, selected = false, onToggleSelect,
  showSource = false, showVisibility = false, showQuality = false,
  showIdleEmbedding = false, selectionArmed = false, spaceName = null,
}: PageListItemProps) {
  return (
    <m.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
    >
      <div
        className={cn(
          // Same row as the page tree and the pinned strip: no card fill, no
          // hairline around every item. A stacked `bg-card` + `border-border`
          // list is forty tiles; the rail is a scan of titles. Selected is
          // the pressed recipe (`bg-accent`), not an extra border — that
          // competed with hover and failed forced-colors without the
          // transparent 1px that becomes `--color-border-interactive`.
          'group nm-focus-ring flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left transition-colors max-sm:items-start',
          selected
            ? 'bg-accent'
            : 'hover:bg-accent',
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
            // The 2px nudge centres the 16px box on the title's ~20px line
            // when the row top-aligns below `sm`. On pointer devices the box
            // stays in the tree (keyboard, tests) but recedes until hover,
            // focus, or an active selection — so the resting scan is titles.
            // Touch has no hover, so the box stays visible below `sm`.
            className={cn(
              'size-4 shrink-0 cursor-pointer accent-[var(--color-primary)] max-sm:mt-0.5',
              !selected && !selectionArmed && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 max-sm:opacity-100',
            )}
            data-testid={`page-select-${pageItem.id}`}
          />
        )}
        <button
          onClick={() => onNavigate(pageItem.id)}
          // Below `sm` the button may wrap, and `basis-auto` on the title
          // block makes the wrap content-driven: `flex-1`'s basis of 0 never
          // triggers a line break, so with `auto` a block whose content fits
          // keeps today's single line, and only an overflowing one drops the
          // pipeline badge below the block instead of compressing it. At
          // `sm+` the max-sm classes are inert and the layout is untouched.
          className="flex min-w-0 flex-1 items-center gap-4 max-sm:flex-wrap max-sm:gap-y-1"
        >
          <div className="min-w-0 flex-1 text-left max-sm:basis-auto">
            {/* Title line. Every badge beside the title is `shrink-0`, so the
                title was the only thing that could give way: at 390px the
                metadata took its width first and the title — the one thing
                identifying a row — absorbed the entire deficit ("Incident
                runbook: Postgres c…", "Quart…"). Below `sm` this row may
                wrap instead: a title short enough to share the line with its
                badges keeps today's layout, and a long one takes the full
                width while the badges drop to their own line beneath it.
                Content-driven, not forced — short rows never pay the extra
                line. Identity beats metadata on a phone, and a taller row
                beats an unreadable one. DOM order is unchanged, so the
                button's accessible name reads exactly as before. */}
            <div className="flex items-center gap-2 max-sm:flex-wrap max-sm:gap-y-1">
              {/* 13px medium. At 16px the title read as a card heading, which
                  is what made forty rows look like forty cards. */}
              <p className="flex min-w-0 items-center gap-1.5 truncate text-[13px] font-medium">
                {pageItem.icon && <PageIcon icon={pageItem.icon} pageId={pageItem.id} size="row" />}
                <span className="min-w-0 truncate" title={pageItem.title}>{pageItem.title}</span>
              </p>
              {/* Source badge. Neutral, like Private below: a source is a
                  category, not a state, so it may not borrow the status
                  greens/indigos — the label is the differentiator. The recipe
                  and its measured rationale live in neutral-chip.ts. */}
              {showSource && (pageItem.source === 'standalone' ? (
                <span
                  className={cn('shrink-0', neutralChipClass)}
                  data-testid="badge-local"
                  data-source-badge={pageItem.id}
                >
                  Local
                </span>
              ) : (
                <span
                  className={cn('shrink-0', neutralChipClass)}
                  data-testid="badge-confluence"
                  data-source-badge={pageItem.id}
                >
                  Confluence
                </span>
              ))}
              {showVisibility && pageItem.source === 'standalone' && (
                (pageItem.visibility === 'shared') ? (
                  <span
                    className={cn('shrink-0', neutralChipClass)}
                    data-testid="badge-shared"
                    data-visibility-badge={pageItem.id}
                  >
                    <Globe size={10} /> Shared
                  </span>
                ) : (
                  <span
                    className={cn('shrink-0', neutralChipClass)}
                    data-testid="badge-private"
                    data-visibility-badge={pageItem.id}
                  >
                    <Lock size={10} /> Private
                  </span>
                )
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {pageItem.spaceKey !== '__local__' && (
                <span title={pageItem.spaceKey ?? undefined}>{spaceName || pageItem.spaceKey}</span>
              )}
              {pageItem.author && <span>{pageItem.author}</span>}
              {pageItem.lastModifiedAt && (
                <span>{new Date(pageItem.lastModifiedAt).toLocaleDateString()}</span>
              )}
            </div>
          </div>
          {/* Labels before pipeline chips: identity, then category, then the
              one state that discriminates. `hidden sm:flex` because none of
              these can shrink: at 390px they held their width, drove the
              title's `min-w-0` block to zero, and rendered on top of the
              badges inside it — the row showed five overlapping pills and
              no title.

              Hidden rather than dropped, so they stay in the DOM for tests and
              for assistive tech, and so the same row markup serves both widths.
              The facts are not lost on mobile: every one of them is on the page
              itself, which is one tap away. */}
          <div className="hidden shrink-0 items-center gap-2 sm:flex">
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
            {/* Only when a score EXISTS. A number about the content is not
                pipeline state and an author acts on it differently — but
                "Not Scored" IS pipeline state, and PageStateBadge owns that. */}
            {showQuality && pageItem.qualityScore !== null && pageItem.qualityScore !== undefined && (
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
          </div>
          {/* One pipeline badge, at every width, and it renders NOTHING when
              the page is healthy, the job was skipped, or idle "Not indexed"
              is suppressed on this list. Failures still show. */}
          <PageStateBadge
            embeddingDirty={pageItem.embeddingDirty}
            summaryStatus={pageItem.summaryStatus}
            qualityStatus={pageItem.qualityStatus}
            showIdleEmbedding={showIdleEmbedding}
          />
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
  if (prev.showSource !== next.showSource) return false;
  if (prev.showVisibility !== next.showVisibility) return false;
  if (prev.showQuality !== next.showQuality) return false;
  if (prev.showIdleEmbedding !== next.showIdleEmbedding) return false;
  if (prev.selectionArmed !== next.selectionArmed) return false;
  if (prev.spaceName !== next.spaceName) return false;
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
  const hasActiveQuery = search.trim().length > 0;

  // Open the advanced panel when the URL arrives carrying one of its filters —
  // otherwise the user lands on a short result set whose cause is hidden.
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(() => hasAdvancedFilters(filters));

  // Bulk selection. Held as a Set of page ids so toggling stays O(1) and the
  // memoised PageListItem only re-renders for rows whose own state changed.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [selectionMode, setSelectionMode] = useState(false);
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
  const useSemanticSearch = hasActiveQuery && searchMode !== 'keyword';

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
  const isKeywordUpdating = searchMode === 'keyword' && hasActiveQuery
    && (searchInput !== debouncedSearch || isFetchingPages);
  const searchProgressLabel = isKeywordUpdating
    ? 'Updating'
    : (searchResults.isLoadingEnhanced
        ? 'Improving'
        : (searchResults.isLoadingImmediate && hasActiveQuery ? 'Searching' : ''));
  const searchResultsBusy = searchProgressLabel.length > 0;

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

  // Focusing the search input unconditionally on mount used to kill every
  // single-key shortcut on the app's own landing route — `useKeyboardShortcuts`
  // correctly suppresses them inside an editable target, so arriving here
  // dropped focus straight into one. `/` (LoginPage's own convention for
  // focusing its primary field) is the explicit path instead: discoverable,
  // and it never fires while already typing in an editable element.
  const focusSearchInput = useCallback(() => {
    searchInputRef.current?.focus();
  }, []);

  useKeyboardShortcuts(useMemo<ShortcutDefinition[]>(() => [
    {
      key: '/',
      keys: ['/'],
      description: 'Filter this list',
      category: 'navigation',
      action: focusSearchInput,
    },
  ], [focusSearchInput]));

  useEffect(() => {
    if (embeddingStatusData?.isProcessing) {
      wasProcessingRef.current = true;
    } else if (wasProcessingRef.current && embeddingStatusData && !embeddingStatusData.isProcessing) {
      wasProcessingRef.current = false;
      toast.success('Embedding complete — all pages are up to date');
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    }
  }, [embeddingStatusData, queryClient]);

  // `space` was excluded from this list until #945's harden pass: at the
  // time, the semantic/hybrid backend branches never read spaceKey either
  // (confirmed against backend/src/routes/knowledge/search.ts — the vector
  // and hybrid blocks built their result set from the query embedding and
  // the user's accessible spaces alone), but the Space select had no pill,
  // was never counted in `activeFilterCount`, and the #945 notice below
  // never mentioned it — so a scoped-to-a-space semantic search silently
  // searched the whole accessible corpus while the UI reported nothing
  // wrong. #1351 later made the backend actually honor spaceKey in both
  // modes; Space stays in `activeFilters` (it is still a real, honored
  // filter worth a pill and a count in every mode) but has since been
  // carved OUT of the notice below, which now describes only what remains
  // genuinely ignored.
  const activeFilters = useMemo(() => {
    const filters: { key: string; label: string }[] = [];
    // Keys are the URL param names so `clearFilter` can act on them directly.
    if (spaceKey) filters.push({ key: 'space', label: `Space: ${selectedSpace?.name ?? spaceKey}` });
    if (author) filters.push({ key: 'author', label: `Author: ${author}` });
    if (labels) filters.push({ key: 'labels', label: `Label: ${labels}` });
    if (freshness) filters.push({ key: 'freshness', label: `Freshness: ${FRESHNESS_LABELS[freshness] ?? freshness}` });
    if (embeddingStatus) filters.push({ key: 'embedding', label: `Embedding: ${EMBEDDING_LABELS[embeddingStatus] ?? embeddingStatus}` });
    if (qualityFilter) filters.push({ key: 'quality', label: `Quality: ${QUALITY_LABELS[qualityFilter] ?? qualityFilter}` });
    if (dateFrom) filters.push({ key: 'from', label: `From: ${dateFrom}` });
    if (dateTo) filters.push({ key: 'to', label: `To: ${dateTo}` });
    if (sourceFilter) filters.push({ key: 'source', label: `Source: ${SOURCE_LABELS[sourceFilter]}` });
    return filters;
  }, [spaceKey, selectedSpace, author, labels, freshness, embeddingStatus, qualityFilter, dateFrom, dateTo, sourceFilter]);

  const activeFilterCount = activeFilters.length;

  // #1351: Space stopped being one of the filters semantic/hybrid ignore —
  // vectorSearch/hybridSearch now apply an explicit space_key predicate
  // (backend/src/domains/llm/services/rag-service.ts). `activeFilters` above
  // stays the full pill set (Space is still a real, honored filter worth a
  // pill and a count in every mode), but the #945 honesty notice must now
  // describe only the filters STILL ignored — author/date/labels/freshness/
  // embedding/quality/source — or it would tell a scoped-to-a-space semantic
  // search that its scoping is being dropped when it no longer is.
  const ignoredFilters = useMemo(
    () => activeFilters.filter((f) => f.key !== 'space'),
    [activeFilters],
  );
  const advancedFilterCount = ignoredFilters.length;

  // Single source of truth for the #945 honesty notice, read by both the
  // visible <p> and the sr-only live-region announcer below it — computed
  // once so the two can never drift out of text with each other.
  const filtersIgnoredMessage = useMemo(() => {
    if (!useSemanticSearch || ignoredFilters.length === 0) return '';
    const summary = summarizeFilterLabels(ignoredFilters.map((f) => f.label));
    const noun = ignoredFilters.length === 1 ? 'filter' : 'filters';
    return `${SEARCH_MODE_LABELS[searchMode]} paused ${ignoredFilters.length} advanced ${noun} — ${summary}. Switch to Keyword to apply them.`;
  }, [useSemanticSearch, ignoredFilters, searchMode]);

  const useKeywordWithFilters = useCallback(() => {
    setFilters({ mode: 'keyword', page: 1 });
  }, [setFilters]);

  const modeHint = useMemo(() => {
    if (searchMode === 'keyword') return SEARCH_MODE_DESCRIPTIONS.keyword;
    if (advancedFilterCount > 0) {
      const noun = advancedFilterCount === 1 ? 'filter' : 'filters';
      if (hasActiveQuery) return `${advancedFilterCount} advanced ${noun} paused. Switch to Keyword to apply them.`;
      return `${advancedFilterCount} advanced ${noun} apply while browsing and will pause when ${SEARCH_MODE_LABELS[searchMode]} search starts.`;
    }
    return SEARCH_MODE_DESCRIPTIONS[searchMode];
  }, [advancedFilterCount, hasActiveQuery, searchMode]);

  const filterStatus = advancedFilterCount === 0
    ? ''
    : (searchMode === 'keyword'
        ? `${advancedFilterCount} active`
        : (hasActiveQuery ? `${advancedFilterCount} paused` : `${advancedFilterCount} Keyword-only`));

  const clearIgnoredFilters = useCallback(() => {
    setFilters({
      author: '', labels: '', freshness: '', embedding: '', quality: '',
      from: '', to: '', source: '', page: 1,
    });
  }, [setFilters]);

  // The pill keys are the URL param names, so a pill clears exactly the param
  // it renders — no second mapping table to drift out of sync.
  const clearFilter = useCallback((key: string) => {
    setFilters({ [key]: '', page: 1 } as Partial<PageFilterState>);
  }, [setFilters]);

  // Clearing filters destroys nothing — it's reversible by definition, which
  // is why the control is quiet (`nm-button-ghost`-weight, never
  // `bg-destructive`) and why a 5s undo toast is enough of a safety net
  // (polish pass, 2026-08-17: this used to be one click with no way back,
  // styled as if it deleted data).
  const clearAllFilters = useCallback(() => {
    const previousFilters: Partial<PageFilterState> = {
      space: spaceKey,
      author,
      labels,
      freshness,
      embedding: embeddingStatus,
      quality: qualityFilter,
      from: dateFrom,
      to: dateTo,
      source: sourceFilter,
    };
    setFilters({
      space: '',
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
    toast('Filters cleared', {
      duration: 5000,
      action: { label: 'Undo', onClick: () => setFilters(previousFilters) },
    });
  }, [setFilters, spaceKey, author, labels, freshness, embeddingStatus, qualityFilter, dateFrom, dateTo, sourceFilter]);

  const navigateToPage = useCallback((id: string) => {
    navigate(`/pages/${id}`);
  }, [navigate]);

  // Virtual scrolling for the keyword/browse page list. Memoised because the
  // `?? []` fallback would otherwise mint a new array every render and break
  // the memoisation of every selection callback that depends on it.
  const pageItems = useMemo(() => pagesData?.items ?? [], [pagesData?.items]);
  const showSourceBadges = useMemo(
    () => new Set(pageItems.map((p) => p.source)).size > 1,
    [pageItems],
  );
  const showVisibilityBadges = useMemo(() => {
    const vis = new Set(
      pageItems.filter((p) => p.source === 'standalone').map((p) => p.visibility ?? 'private'),
    );
    return vis.size > 1;
  }, [pageItems]);
  const showQualityBadges = Boolean(qualityFilter);
  const showIdleEmbedding = embeddingStatus === 'pending';
  const selectionArmed = selectionMode || selectedIds.size > 0;
  const spaceNameByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of spaces ?? []) {
      if (s.key && s.name) map.set(s.key, s.name);
    }
    return map;
  }, [spaces]);
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
    setSelectionMode(false);
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
    estimateSize: () => 52,
    overscan: 5,
    scrollMargin,
    useFlushSync: false, // Required for React 19
  });

  return (
    // max-w-[1100px], matching the app's 1200px document-column convention:
    // uncapped, a short title's flex-1 block stretched to fill whatever the
    // viewport left over (up to AppLayout's own 1280px route cap), leaving
    // ~700px of dead air between a row's title and its right-pinned badges
    // at wide viewports — the eye had nothing to bind them across. No
    // `mx-auto`: this is a workspace pane beside a sidebar, not a centered
    // page, so the cap should keep content flush-left, not float it.
    <div className="max-w-[1180px] space-y-5">
      <HeaderHost fallbackClassName="mb-1">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-[15px] font-semibold sm:text-lg">{LIBRARY_HEADING}</h1>
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => navigate('/pages/new')}
              className="nm-button-primary h-8 px-3 text-xs sm:text-sm"
              data-testid="new-page-button"
            >
              <Plus size={15} />
              <span>New Page</span>
              <ShortcutHint shortcutId="new-page" />
            </button>
          </div>
        </div>
      </HeaderHost>

      {/* Pins are the Library's quickest return path, so keep them in the
          first viewport above discovery controls. Active queries still hide
          the strip so search hands directly to its results. */}
      {!hasActiveQuery && <PinnedArticlesSection />}

      {/* Search leads discovery after the quick-return strip. The results pane
          is the Library's one durable boundary; proximity groups the
          supporting scope and mode controls. */}
      <section
        aria-labelledby="kb-filters-heading"
        className="space-y-3"
        data-testid="library-filter-panel"
      >
        <h2 id="kb-filters-heading" className="sr-only">Filter pages</h2>
        {/* Query, retrieval mode and scope are one command surface. The query
            leads; the supporting controls stay inside the same surface and
            wrap beneath it on narrow screens without changing DOM order. */}
        <div
          className="library-search-surface mx-auto flex w-full max-w-5xl flex-col gap-2 rounded-xl p-2.5 sm:flex-row sm:items-center sm:gap-1 sm:p-2"
          data-testid="page-search-field"
          role="search"
          aria-label="Library pages"
        >
          <div className="flex h-11 min-w-0 flex-1 items-center gap-2 px-2 sm:h-10">
            <Search size={18} className="shrink-0 text-action" aria-hidden="true" />
            <input
              ref={searchInputRef as RefObject<HTMLInputElement>}
              type="text"
              placeholder={FIND_PLACEHOLDER}
              aria-label={FIND_LABEL}
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
              onKeyDown={(e) => {
                if (e.key === 'Escape' && search) {
                  e.preventDefault();
                  e.stopPropagation();
                  setSearchInput('');
                  setFilters({ search: '', page: 1, mode: FILTER_DEFAULTS.mode, ...(sort === 'relevance' ? { sort: 'modified' } : {}) });
                }
              }}
              className="h-9 min-w-0 flex-1 border-0 bg-transparent px-0 text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
            />
            {searchProgressLabel && (
              <span
                className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                role="status"
                aria-live="polite"
                data-testid="search-updating-status"
              >
                <Loader2
                  size={13}
                  className="animate-spin text-action"
                  data-testid={searchResults.isLoadingEnhanced ? 'search-enhanced-loading' : undefined}
                  aria-hidden="true"
                />
                <span className="hidden sm:inline">{searchProgressLabel}</span>
              </span>
            )}
            {search ? (
              <button
                type="button"
                onClick={() => {
                  setSearchInput('');
                  setFilters({ search: '', page: 1, mode: FILTER_DEFAULTS.mode, ...(sort === 'relevance' ? { sort: 'modified' } : {}) });
                  searchInputRef.current?.focus();
                }}
                className="nm-icon-button shrink-0"
                data-testid="search-clear"
                aria-label="Clear search"
                title="Clear search"
              >
                <X size={15} aria-hidden="true" />
              </button>
            ) : (
              <ShortcutHint shortcutId="focus-page-search" className="pointer-events-none shrink-0" />
            )}
          </div>

          <span className="hidden h-5 w-px shrink-0 bg-border sm:block" aria-hidden="true" />

          <div className="grid w-full gap-1.5 sm:flex sm:w-auto sm:shrink-0 sm:items-center sm:gap-1">
            <div
              className="library-search-modes flex w-full min-w-0 items-center gap-0.5 rounded-md p-0.5 sm:w-auto"
              data-testid="search-mode-toggle"
              role="group"
              aria-label="Search strategy"
              aria-describedby="find-mode-hint"
            >
              {([
                'hybrid',
                'keyword',
                ...((searchMode === 'semantic'
                  || embeddingStatusData == null
                  || embeddingStatusData.embeddedPages > 0
                  || embeddingStatusData.totalEmbeddings > 0)
                  ? (['semantic'] as const)
                  : []),
              ] as const).map((m) => (
                <button
                  type="button"
                  key={m}
                  data-testid={`search-mode-${m}`}
                  onClick={() => setFilters({ mode: m, page: 1 })}
                  aria-pressed={searchMode === m}
                  className={cn(
                    'nm-focus-ring min-h-11 flex-1 whitespace-nowrap rounded-sm border border-transparent px-2 py-1 text-sm font-medium transition-colors sm:min-h-0 sm:flex-none sm:px-2.5 sm:text-xs',
                    searchMode === m
                      ? 'library-search-mode-active'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {SEARCH_MODE_LABELS[m]}
                </button>
              ))}
            </div>
            <div className="flex w-full items-center gap-1 sm:w-auto">
              <LibrarySpaceFilter
                spaces={spaces}
                selectedKey={spaceKey}
                selectedName={selectedSpace?.name}
                onSelect={(value) => {
                  setFilters({ space: value, page: 1 });
                  setForcePageList(false);
                }}
              />

              <button
                type="button"
                onClick={() => setShowAdvancedFilters((v) => !v)}
                className={cn(
                  'library-search-select flex h-11 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground sm:h-8 sm:px-2 sm:text-xs',
                  (showAdvancedFilters || advancedFilterCount > 0) && 'bg-accent text-foreground',
                  hasActiveQuery && searchMode !== 'keyword' && advancedFilterCount > 0 && 'text-warning',
                )}
                data-testid="advanced-filters-toggle"
                aria-label={filterStatus ? `Filters, ${filterStatus}` : 'Filters'}
                title={filterStatus ? `Filters (${filterStatus})` : 'Filters'}
                aria-expanded={showAdvancedFilters}
                aria-controls="advanced-filters-panel"
              >
                <Filter size={15} aria-hidden="true" />
                <span>Filters</span>
                {filterStatus && (
                  <span className="rounded bg-foreground/10 px-1.5 py-0.5 text-xs font-semibold tabular-nums" aria-hidden="true">
                    {filterStatus}
                  </span>
                )}
                <ChevronDown
                  size={12}
                  className={cn('ml-auto shrink-0 transition-transform', showAdvancedFilters && 'rotate-180')}
                  data-testid="advanced-filters-chevron"
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
        </div>

        <p id="find-mode-hint" className="mx-auto max-w-5xl px-1 text-xs text-muted-foreground">
          {modeHint}
        </p>

        {/* sr-only live-region announcer for the #945 honesty notice below.
            Always mounted (only its text content changes) rather than
            mounting/unmounting the notice itself with aria-live on it — some
            assistive tech only starts watching a live region once it is
            already present in the accessibility tree, so a region that
            appears for the first time alongside its own content can go
            unannounced. This is the one place that state gets spoken; the
            visible <p> below is purely visual and carries no aria-live of
            its own to avoid a double announcement. */}
        <span role="status" aria-live="polite" className="sr-only" data-testid="filters-live-announcer">
          {filtersIgnoredMessage}
        </span>

        {/* Hybrid and Semantic intentionally leave advanced filters paused.
            Name the exact saved filters and provide the constrained path
            without silently switching search strategy. */}
        {filtersIgnoredMessage && (
          <div
            id="filters-paused-notice"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
            data-testid="filters-ignored-notice"
          >
            <AlertTriangle size={12} className="shrink-0 text-warning" aria-hidden="true" />
            <span>{filtersIgnoredMessage}</span>
            <button type="button" onClick={useKeywordWithFilters} className="nm-button-ghost h-7 px-2 text-xs" data-testid="use-keyword-with-filters">
              Switch to Keyword
            </button>
            <button type="button" onClick={clearIgnoredFilters} className="nm-button-ghost h-7 px-2 text-xs" data-testid="clear-paused-filters">
              Clear paused filters
            </button>
          </div>
        )}

        {/* Advanced filters panel */}
        {showAdvancedFilters && (
          <div
            id="advanced-filters-panel"
            className="rounded-lg bg-card p-3"
            data-testid="advanced-filters-panel"
          >
            <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Refine results</h3>
                <p className="text-xs text-muted-foreground">
                  {advancedFilterCount > 0
                    ? (searchMode === 'keyword' || !hasActiveQuery
                        ? `${advancedFilterCount} active`
                        : `${advancedFilterCount} paused`)
                    : 'Advanced filters apply to Keyword search'}
                </p>
              </div>
              {advancedFilterCount > 0 && (
                <button type="button" onClick={clearIgnoredFilters} className="nm-button-ghost h-7 px-2 text-xs">
                  Clear filters
                </button>
              )}
            </div>

            {!hasActiveQuery && searchMode !== 'keyword' && advancedFilterCount > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md bg-muted/50 px-2.5 py-2 text-xs text-muted-foreground" data-testid="filters-keyword-preview-note">
                <span>These filters apply while browsing and will pause when {SEARCH_MODE_LABELS[searchMode]} search starts.</span>
                <button type="button" onClick={useKeywordWithFilters} className="nm-button-ghost h-7 px-2 text-xs">
                  Keep them active with Keyword
                </button>
              </div>
            )}

            <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,5fr)]">
              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Content</legend>
                <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
                  <div className="min-w-32">
                    <label htmlFor="filter-source-select" className="mb-1 block text-xs text-muted-foreground">Source</label>
                    <select
                      id="filter-source-select"
                      value={sourceFilter}
                      onChange={(e) => setFilters({ source: e.target.value as PageSource | '', page: 1 })}
                      className="nm-select-md w-full"
                      data-testid="filter-source"
                      aria-label="Filter by source"
                    >
                      <option value="">All sources</option>
                      {PageSourceEnum.options.map((source) => (
                        <option key={source} value={source}>{SOURCE_LABELS[source]}</option>
                      ))}
                    </select>
                  </div>
                  <div className="min-w-40">
                    <label htmlFor="filter-author-select" className="mb-1 block text-xs text-muted-foreground">Author</label>
                    <select
                      id="filter-author-select"
                      value={author}
                      onChange={(e) => setFilters({ author: e.target.value, page: 1 })}
                      className="nm-select-md w-full"
                      data-testid="filter-author"
                    >
                      <option value="">All authors</option>
                      {filterOptions?.authors.map((a) => (
                        <option key={a} value={a}>{a}</option>
                      ))}
                    </select>
                  </div>
                  <div className="min-w-40">
                    <label htmlFor="filter-labels-select" className="mb-1 block text-xs text-muted-foreground">Label</label>
                    <select
                      id="filter-labels-select"
                      value={labels}
                      onChange={(e) => setFilters({ labels: e.target.value, page: 1 })}
                      className="nm-select-md w-full"
                      data-testid="filter-labels"
                    >
                      <option value="">All labels</option>
                      {filterOptions?.labels.map((label) => (
                        <option key={label} value={label}>{label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Status &amp; date</legend>
                <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-3 xl:grid-cols-5">
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
                  <div className="min-w-36">
                    <label htmlFor="filter-quality-select" className="mb-1 block text-xs text-muted-foreground">Quality</label>
                    <select id="filter-quality-select" value={qualityFilter} onChange={(e) => setFilters({ quality: e.target.value, page: 1 })} className="nm-select-md w-full" data-testid="filter-quality">
                      <option value="">Any</option><option value="excellent">Excellent (90-100)</option><option value="good">Good (70-89)</option><option value="needs-work">Needs Work (50-69)</option><option value="poor">Poor (0-49)</option>
                    </select>
                  </div>
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
                  <div className="min-w-36">
                    <label htmlFor="filter-date-from-input" className="mb-1 block text-xs text-muted-foreground">Modified from</label>
                    <input id="filter-date-from-input" type="date" value={dateFromInput} onChange={(e) => setDateFromInput(e.target.value)} className="nm-select-md w-full !bg-none" data-testid="filter-date-from" />
                  </div>
                  <div className="min-w-36">
                    <label htmlFor="filter-date-to-input" className="mb-1 block text-xs text-muted-foreground">Modified to</label>
                    <input id="filter-date-to-input" type="date" value={dateToInput} onChange={(e) => setDateToInput(e.target.value)} className="nm-select-md w-full !bg-none" data-testid="filter-date-to" />
                  </div>
                </div>
              </fieldset>
            </div>

            <details className="mt-3 border-t border-border pt-3">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                Index health and sync
              </summary>
              <div className="mt-3">
                <KPICards
                  embeddingStatus={embeddingStatusData}
                  spacesCount={spaces?.length ?? 0}
                  lastSynced={syncStatus?.lastSynced}
                  onSync={() => syncMutation.mutate()}
                  isSyncing={syncStatus?.status === 'syncing'}
                />
              </div>
            </details>
          </div>
        )}

        {/* Active filter pills.
            These stay fully legible and operable in semantic/hybrid mode —
            they are not disabled, removing one really does update the URL,
            and `opacity-50` on a clickable button both fails contrast and
            fools automated "is it enabled" checks the same way it fools a
            sighted user. The #945 honesty notice above is the one place that
            says the OTHER filters are being ignored; each of those pills
            points to it via `aria-describedby` so a screen-reader user
            tabbing onto a pill hears why it's listed. The Space pill is
            deliberately excluded (#1351: it is no longer ignored), so it
            never wires up to a notice about a scoping that IS applying.
            `data-inactive` is a plain state marker for tests/styling, not an
            accessibility claim — true only while the notice it points at is
            actually on screen. */}
        {activeFilters.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-2 border-t border-border pt-3"
            data-testid="active-filter-pills"
            data-inactive={filtersIgnoredMessage ? 'true' : undefined}
          >
            {activeFilters.map((f) => {
              const ignoredBySemanticSearch = useSemanticSearch && f.key !== 'space';
              return (
                <button
                  key={f.key}
                  onClick={() => clearFilter(f.key)}
                  className="nm-button-ghost h-7 gap-1 px-2 text-xs font-medium"
                  aria-label={`Remove ${f.label} filter`}
                  aria-describedby={ignoredBySemanticSearch ? 'filters-paused-notice' : undefined}
                  data-testid={`filter-pill-${f.key}`}
                >
                  {f.label}
                  <X size={12} aria-hidden="true" data-testid={`filter-pill-remove-${f.key}`} />
                </button>
              );
            })}
            <button
              onClick={clearAllFilters}
              className="nm-button-ghost h-7 px-2 text-xs"
              data-testid="clear-all-pill-filters"
            >
              Clear all
            </button>
          </div>
        )}
      </section>

      {/* Browsing support stays out of the active-search path: once a query is
          present, warnings and results follow the command surface directly. */}
      {!hasActiveQuery && (
        <>
      {/* Sync progress */}
      {syncStatus?.status === 'syncing' && syncStatus.progress && (
        <div className="space-y-2 py-1">
          <div className="flex items-center justify-between text-sm">
            <span>Syncing {syncStatus.progress.space}...</span>
            <span className="tabular-nums text-muted-foreground">{syncStatus.progress.current}/{syncStatus.progress.total}</span>
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
        <div className="flex items-center gap-3 py-1" data-testid="embedding-progress-banner">
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

        </>
      )}

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
      {showHomeContent && !forcePageList && !hasActiveQuery ? (
        homePageLoading ? (
          <div className="h-96 animate-pulse rounded-md bg-foreground/5" />
        ) : homePage ? (
          <m.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">{homePage.title}</h2>
              <div className="flex gap-2">
                <button
                  onClick={() => navigate(`/pages/${homePage.id}`)}
                  className="nm-button-ghost h-8 gap-1.5 px-2.5 text-sm"
                >
                  <FileText size={14} /> View Full Page
                </button>
                <button
                  onClick={() => setForcePageList(true)}
                  className="nm-button-ghost h-8 gap-1.5 px-2.5 text-sm"
                  data-testid="show-page-list"
                >
                  <List size={14} /> Show All Pages
                </button>
              </div>
            </div>
            <SanitizedHtml
              className={`prose max-w-none py-2${isLight ? '' : ' prose-invert'}`}
              html={homeBodyHtml}
              additionalAllowedAttrs={['data-diagram-name', 'data-drawio', 'data-color', 'data-layout', 'data-layout-type', 'data-cell-width', 'data-border']}
            />
          </m.div>
        ) : null
      ) : (
      <>
      {/* Page list — semantic/hybrid search results */}
      <section aria-labelledby="kb-results-heading" className="space-y-3" aria-busy={searchResultsBusy} data-testid="library-results-region">
      <h2 id="kb-results-heading" className="sr-only">Page results</h2>
      {useSemanticSearch ? (
        <>
          {searchResults.isLoadingImmediate && searchResults.immediateResults.length === 0 ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-11 animate-pulse rounded-md bg-foreground/5" />
              ))}
            </div>
          ) : (() => {
            const displayItems = searchResults.enhancedResults ?? searchResults.immediateResults;
            return displayItems.length === 0 ? (
              <EmptyState
                icon={FolderOpen}
                className="border-0 bg-transparent"
                title={searchResults.hasEmbeddings ? 'No pages found' : 'No matching pages'}
                description={
                  searchResults.hasEmbeddings
                    ? 'Try a different search term or switch to Keyword'
                    // Zero embeddings: the banner above already says keyword
                    // fallback ran, so acknowledge both facts — the query
                    // matched nothing AND semantic search is unavailable
                    // (#938; copy reconciled in the #993 review).
                    : `Keyword search found no matches. Semantic search is unavailable until pages are embedded — configure an embedding provider in Settings → ${SETTINGS_PANELS.models.label} and run an embedding pass.`
                }
              />
            ) : (
              <>
                <p className="text-sm font-medium text-foreground" data-testid="search-results-count">
                  {searchResults.total} {searchResults.total === 1 ? 'result' : 'results'}
                  <span className="ml-2 text-xs text-muted-foreground/60">({SEARCH_MODE_LABELS[searchMode]})</span>
                </p>
                <div className="overflow-hidden rounded-lg border border-border bg-background">
                  {displayItems.map((item, i) => (
                    <m.div
                      key={item.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.15, delay: i * 0.02 }}
                    >
                      <button
                        onClick={() => navigate(`/pages/${item.id}`)}
                        className="nm-focus-ring flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-accent max-sm:items-start max-sm:flex-wrap max-sm:gap-y-1"
                        data-testid={`article-hover-${item.id}`}
                      >
                        <div className="min-w-0 flex-1 text-left max-sm:basis-auto max-sm:max-w-[calc(100%-30px)]">
                          <p className="flex min-w-0 items-center gap-1.5 truncate text-[13px] font-medium text-foreground">
                            {item.icon && <PageIcon icon={item.icon} pageId={item.id} size="row" />}
                            <span className="min-w-0 truncate" title={item.title}>{item.title}</span>
                          </p>
                          {/* `contain:inline-size` zeroes the excerpt's
                              contribution to the block's intrinsic width.
                              Without it the excerpt's unwrapped length — not
                              the title's — decides the block's content size,
                              and a two-line excerpt is nearly always wider
                              than a phone row, so the chip would drop on
                              virtually every row: forced in practice, not
                              content-driven. Contained, the nowrap title alone
                              drives the wrap. The excerpt's own rendering is
                              unchanged — it still fills the block's final
                              width and clamps at two lines. */}
                          {/* item.excerpt is a full-text-search snippet carrying
                              <mark> highlight tags on its keyword leg (the
                              semantic leg's snippets carry none). Rendering it
                              as plain React text escaped the tags into literal
                              "<mark>…</mark>" on screen for the ~250ms-1.5s
                              every semantic/hybrid search spends showing
                              phase-1 keyword results — on 80-90% of rows, every
                              time. SanitizedHtml with an explicit `mark`-only
                              allowlist renders the highlighting the backend
                              already computed instead of leaking its markup
                              (polish pass, 2026-08-17). */}
                          {item.excerpt && (
                            <SanitizedHtml
                              html={item.excerpt}
                              allowedTags={['mark']}
                              allowedAttrs={[]}
                              className="mt-0.5 line-clamp-2 text-xs text-muted-foreground leading-relaxed max-sm:[contain:inline-size] [&_mark]:rounded-[2px] [&_mark]:bg-foreground/10 [&_mark]:font-medium [&_mark]:text-foreground"
                            />
                          )}
                          {item.spaceKey && (
                            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                              {item.spaceKey !== '__local__' ? (
                                <span
                                  className={cn('shrink-0', neutralChipClass)}
                                  data-testid="badge-confluence"
                                  data-source-badge={item.id}
                                >
                                  {item.spaceKey}
                                </span>
                              ) : (
                                <span
                                  className={cn('shrink-0', neutralChipClass)}
                                  data-testid="badge-local"
                                  data-source-badge={item.id}
                                >
                                  Local
                                </span>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Similarity only — renderable cosine distance percentage */}
                        {item.similarity !== null && item.similarity > 0 && (
                          <span
                            title="Semantic similarity to your query"
                            className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground border border-border/40"
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
                className="nm-icon-button disabled:opacity-30"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm text-muted-foreground" aria-live="polite">
                Page {page} of {searchResults.totalPages}
              </span>
              <button
                onClick={() => setFilters({ page: Math.min(searchResults.totalPages, page + 1) })}
                disabled={page >= searchResults.totalPages}
                aria-label="Next page"
                className="nm-icon-button disabled:opacity-30"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Page list — keyword/browse mode (original) */}
          {isLoading ? (
            <div className="space-y-0.5">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-11 animate-pulse rounded-md bg-foreground/5" />
              ))}
            </div>
          ) : pagesError && !pagesData ? (
            <div
              className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
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
            // Filters first, search second, corpus-emptiness last (harden
            // pass, 2026-08-17): an empty result set with active filters was
            // reported as "Sync your Confluence spaces to see pages here",
            // sending the user to Settings for a problem their own filters
            // caused, with no mention of the filters and no way to clear
            // them from this screen. `activeFilterCount` already reflects
            // exactly what's filtering this list (Space included, since it
            // now participates in `activeFilters` above) — a real empty
            // corpus is the one case where it, and `search`, are both empty.
            <EmptyState
              icon={FolderOpen}
              className="border-0 bg-transparent"
              title="No pages found"
              description={
                activeFilterCount > 0
                  ? (search
                      ? `No pages match "${search}" with ${summarizeFilterLabels(activeFilters.map((f) => f.label))}`
                      : `No pages match ${summarizeFilterLabels(activeFilters.map((f) => f.label))}`)
                  : (search ? 'Try a different search term' : 'Create a page, or connect a Confluence space to fill this list')
              }
              action={
                activeFilterCount > 0
                  ? { label: 'Clear filters', onClick: clearAllFilters }
                  : (!search ? { label: 'Go to Settings', onClick: () => navigate('/settings') } : undefined)
              }
            />
          ) : (
            <>
            <div data-testid="library-results-panel" className="overflow-hidden rounded-lg border border-border bg-background">
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground" data-testid="browse-results-context" aria-live="polite">
              <span>{pagesData.total} {pagesData.total === 1 ? 'page' : 'pages'}</span>
              {selectedSpace && <><span aria-hidden="true"> · </span><span>{selectedSpace.name}</span></>}
              {!selectionArmed && (
                <button type="button" onClick={() => setSelectionMode(true)} className="nm-button-ghost h-8 px-2.5 text-xs" data-testid="enter-selection-mode">
                  Select pages
                </button>
              )}
              <div className="ml-auto flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">Sort</span>
                <LibrarySortFilter
                  value={sort}
                  onChange={(newSort) => setFilters({ sort: newSort, page: 1 })}
                />
              </div>
            </div>
            {/* Select-all + bulk actions. The four /pages/bulk/* endpoints
                shipped with no UI, so re-embedding a large space meant one
                row at a time. */}
            {selectionArmed && (
            <div className="space-y-3 border-b border-border px-3 py-2.5">
              <label
                className={cn(
                  'flex w-fit cursor-pointer items-center gap-2 text-sm text-muted-foreground',
                  !selectionArmed && 'sr-only',
                )}
              >
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
            )}

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
                    <div>
                      <PageListItem
                        pageItem={pageItem}
                        index={virtualRow.index}
                        onNavigate={navigateToPage}
                        selected={selectedIds.has(pageItem.id)}
                        onToggleSelect={toggleSelect}
                        showSource={showSourceBadges}
                        showVisibility={showVisibilityBadges}
                        showQuality={showQualityBadges}
                        showIdleEmbedding={showIdleEmbedding}
                        selectionArmed={selectionArmed}
                        spaceName={pageItem.spaceKey ? spaceNameByKey.get(pageItem.spaceKey) ?? null : null}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
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
                className="nm-icon-button disabled:opacity-30"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm text-muted-foreground" aria-live="polite">
                Page {page} of {pagesData.totalPages}
              </span>
              <button
                onClick={() => setFilters({ page: Math.min(pagesData.totalPages, page + 1) })}
                disabled={page >= pagesData.totalPages}
                aria-label="Next page"
                className="nm-icon-button disabled:opacity-30"
              >
                <ChevronRight size={16} />
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
