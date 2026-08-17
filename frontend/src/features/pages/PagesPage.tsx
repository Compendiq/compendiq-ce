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
import { neutralChipClass } from '../../shared/components/badges/neutral-chip';
import { useIsLightTheme } from '../../shared/hooks/use-is-light-theme';
import { ShortcutHint } from '../../shared/components/ShortcutHint';
import { SanitizedHtml } from '../../shared/components/SanitizedHtml';
import { SETTINGS_PANELS } from '../settings/settings-nav';
import { useKeyboardShortcuts, type ShortcutDefinition } from '../../shared/hooks/use-keyboard-shortcuts';

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
          // `items-start` below sm: when the badge cluster wraps the row grows
          // past one line, and a centred checkbox drifts down to the author/
          // date line. Top-aligned (plus the input's own 2px nudge) it stays
          // on the title line, which is the thing it selects.
          'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors max-sm:items-start',
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
            // The 2px nudge centres the 16px box on the title's ~20px line
            // when the row top-aligns below `sm`.
            className="size-4 shrink-0 cursor-pointer accent-[var(--color-primary)] max-sm:mt-0.5"
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
              <p className="truncate text-[13px] font-medium">{pageItem.title}</p>
              {/* Source badge. Neutral, like Private below: a source is a
                  category, not a state, so it may not borrow the status
                  greens/indigos — the label is the differentiator. The recipe
                  and its measured rationale live in neutral-chip.ts. */}
              {pageItem.source === 'standalone' ? (
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
              )}
              {/* Visibility badge for standalone articles */}
              {pageItem.source === 'standalone' && (
                (pageItem.visibility === 'shared') ? (
                  <span
                    className={cn('shrink-0', neutralChipClass)}
                    data-testid="badge-shared"
                    data-visibility-badge={pageItem.id}
                  >
                    <Globe size={10} /> Shared
                  </span>
                ) : (
                  // Private = neutral gray. Was amber, but privacy carries no AI semantic.
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
      description: 'Focus page search',
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

  // Single source of truth for the #945 honesty notice, read by both the
  // visible <p> and the sr-only live-region announcer below it — computed
  // once so the two can never drift out of text with each other.
  const filtersIgnoredMessage = useMemo(() => {
    if (!useSemanticSearch || ignoredFilters.length === 0) return '';
    const summary = summarizeFilterLabels(ignoredFilters.map((f) => f.label));
    return `Semantic and hybrid search ignore your active filters — ${summary}. They apply to keyword search only.`;
  }, [useSemanticSearch, ignoredFilters]);

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
    // max-w-[1100px], matching the app's 1200px document-column convention:
    // uncapped, a short title's flex-1 block stretched to fill whatever the
    // viewport left over (up to AppLayout's own 1280px route cap), leaving
    // ~700px of dead air between a row's title and its right-pinned badges
    // at wide viewports — the eye had nothing to bind them across. No
    // `mx-auto`: this is a workspace pane beside a sidebar, not a centered
    // page, so the cap should keep content flush-left, not float it.
    <div className="max-w-[1100px] space-y-3">
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
              // The one control in this section with no aria-label — every
              // sibling (space/source/sort selects, the mode toggle, every
              // advanced field) already has one; this is the field the
              // route's own `/` shortcut exists to focus (polish pass,
              // 2026-08-17).
              aria-label="Search pages"
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
                // The universal convention on search inputs, missing here —
                // the only way out was the 18px clear `×`. Mirrors the clear
                // button's own effect; consumed so a page-level Escape
                // handler doesn't also fire on the same keystroke
                // (polish pass, 2026-08-17).
                if (e.key === 'Escape' && search) {
                  e.preventDefault();
                  e.stopPropagation();
                  setSearchInput('');
                  setFilters({ search: '', page: 1, mode: 'keyword', ...(sort === 'relevance' ? { sort: 'modified' } : {}) });
                }
              }}
              className="nm-input pl-10 pr-10"
            />
            {search ? (
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
            ) : (
              // The `/` shortcut that focuses this field was completely
              // undiscoverable — "New Page" carries a visible hint chip, this
              // field (the only other shortcut on the route) carried nothing.
              // Same slot the clear button uses once there's a query to clear,
              // so the two never compete for space (polish pass, 2026-08-17).
              <ShortcutHint
                shortcutId="focus-page-search"
                className="pointer-events-none absolute right-3 top-1/2 ml-0 -translate-y-1/2"
              />
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
                    'nm-focus-ring',
                    searchMode === m
                      ? 'nm-pill-active'
                      // `nm-pill-active` carries its own 1px border; matching it here
                      // with a same-width *transparent* border (rather than no border
                      // at all) keeps every segment's box size identical, so selecting
                      // a mode doesn't reflow the other two by the border's width (was
                      // 24px inactive vs 26px active, shifting all three horizontally
                      // on every click — polish pass, 2026-08-17).
                      : 'border border-transparent text-muted-foreground hover:text-foreground',
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

          {/* Divider between the filters (space/source) and Sort. It used to
              sit between Sort and Filters instead, which visually grouped
              Sort with the advanced-filters toggle rather than separating
              it — Sort isn't a filter (polish pass, 2026-08-17). */}
          <div className="hidden h-6 w-px bg-border/60 sm:block" aria-hidden="true" data-testid="source-sort-divider" />

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

          {/* Advanced filters toggle */}
          <button
            onClick={() => setShowAdvancedFilters((v) => !v)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-2 text-sm transition-colors',
              'nm-focus-ring',
              showAdvancedFilters || activeFilterCount > 0
                ? 'bg-action/15 text-action'
                : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10',
            )}
            data-testid="advanced-filters-toggle"
            aria-expanded={showAdvancedFilters}
            aria-controls="advanced-filters-panel"
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

        {/* Honest notice: every filter in `ignoredFilters` above is silently
            ignored by semantic and hybrid search (#945's original scope was
            "advanced filters"; the harden pass folded Space in too — #1351
            later took it back out once the backend started honoring it — see
            the comments on `activeFilters`/`ignoredFilters`). Placed here,
            ahead of the advanced panel and the pill row, so it is the first
            thing seen after switching mode rather than something a user has
            to scroll past two other blocks to find. */}
        {filtersIgnoredMessage && (
          <p
            id="filters-ignored-notice"
            className="flex items-start gap-1.5 text-xs text-muted-foreground"
            data-testid="filters-ignored-notice"
          >
            <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
            <span>{filtersIgnoredMessage}</span>
          </p>
        )}

        {/* Advanced filters panel */}
        {showAdvancedFilters && (
          <div id="advanced-filters-panel" className="grid grid-cols-2 items-end gap-3 border-t border-border pt-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="advanced-filters-panel">
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
                // nm-select-md paints a dropdown chevron for the border/height/
                // focus-ring recipe it's borrowed here for; a date input has its
                // own native calendar-picker icon in that exact spot, and the
                // two rendered side by side at 390px (polish pass, 2026-08-17).
                // `!` forces this past nm-select-md's own background-image —
                // same specificity, and cascade order between a hand-authored
                // @utility and a built-in Tailwind utility isn't safe to assume.
                className="nm-select-md w-full !bg-none"
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
                className="nm-select-md w-full !bg-none"
                data-testid="filter-date-to"
              />
            </div>

            {/* A "clear everything" control used to live here too — "Clear
                filters" in filled destructive red — duplicating the pill
                row's plain-text "Clear all" below under a different label
                and opposite visual weight, for the identical
                `clearAllFilters` call. Clearing filters destroys no data,
                so the destructive-red treatment was also just wrong. The
                pill row's "Clear all" is now the one control (polish pass,
                2026-08-17); it sits beside the pills it clears, which the
                panel does not. */}
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
                  className="inline-flex items-center gap-1 rounded-full bg-action/10 px-2.5 py-0.5 text-xs font-medium text-action"
                  aria-label={`Remove ${f.label} filter`}
                  aria-describedby={ignoredBySemanticSearch ? 'filters-ignored-notice' : undefined}
                  data-testid={`filter-pill-${f.key}`}
                >
                  {f.label}
                  <X size={12} aria-hidden="true" data-testid={`filter-pill-remove-${f.key}`} />
                </button>
              );
            })}
            <button
              onClick={clearAllFilters}
              className="rounded-sm text-xs text-muted-foreground hover:text-foreground nm-focus-ring"
              data-testid="clear-all-pill-filters"
            >
              Clear all
            </button>
          </div>
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
              additionalAllowedAttrs={['data-diagram-name', 'data-drawio', 'data-color', 'data-layout', 'data-layout-type', 'data-cell-width', 'data-border']}
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
                        // Same content-driven wrap as the browse rows above
                        // (PageListItem): the similarity chip is `shrink-0`, so
                        // below `sm` the truncating title absorbed the entire
                        // width deficit. `max-sm:flex-wrap` lets the chip drop
                        // to its own line instead — and only when the title
                        // actually needs the width (see the title block below).
                        // Every added class is `max-sm:*`, so `sm+` keeps
                        // today's single-line layout untouched.
                        className="rounded-xl border border-border bg-card transition-all hover:border-primary/50 flex w-full items-center gap-3 p-4 text-left max-sm:flex-wrap max-sm:gap-y-1"
                        data-testid={`article-hover-${item.id}`}
                      >
                        <FileText size={18} className="shrink-0 text-muted-foreground" />
                        {/* `basis-auto` makes the wrap content-driven —
                            `flex-1`'s basis of 0 never triggers a line break —
                            but this row's anatomy differs from the browse row's
                            in one load-bearing way: the file icon is the FIRST
                            flex item inside the wrap container (the browse
                            row's checkbox sits outside it), and a block whose
                            content overflows the line wraps WHOLESALE below
                            the icon, stranding an 18px glyph alone on its own
                            line. The max-width clamp — 100% minus the icon's
                            18px and the 12px `gap-3` — caps the block's
                            hypothetical main size at exactly the space beside
                            the icon, so the block always shares the icon's
                            line and the chip is the thing that wraps. */}
                        <div className="min-w-0 flex-1 text-left max-sm:basis-auto max-sm:max-w-[calc(100%-30px)]">
                          <p className="truncate font-medium">{item.title}</p>
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
                              className="mt-0.5 line-clamp-2 text-xs text-muted-foreground max-sm:[contain:inline-size] [&_mark]:rounded-[2px] [&_mark]:bg-foreground/10 [&_mark]:font-medium [&_mark]:text-foreground"
                            />
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
              title="No pages found"
              description={
                activeFilterCount > 0
                  ? (search
                      ? `No pages match "${search}" with ${summarizeFilterLabels(activeFilters.map((f) => f.label))}`
                      : `No pages match ${summarizeFilterLabels(activeFilters.map((f) => f.label))}`)
                  : (search ? 'Try a different search term' : 'Sync your Confluence spaces to see pages here')
              }
              action={
                activeFilterCount > 0
                  ? { label: 'Clear filters', onClick: clearAllFilters }
                  : (!search ? { label: 'Go to Settings', onClick: () => navigate('/settings') } : undefined)
              }
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
