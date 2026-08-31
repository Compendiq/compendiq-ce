import { useState, useCallback, useMemo, useRef, useEffect, memo, type RefObject } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { m } from 'framer-motion';
import { Search, FileText, Plus, ChevronLeft, ChevronRight, ChevronDown, FolderOpen, Filter, X, List, Loader2, Lock, Globe, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { type PageSource, type PageIcon as PageIconValue } from '@compendiq/contracts';
import { usePages, usePageFilterOptions, usePage, useEmbeddingStatus, type QualityStatus, type SummaryStatus } from '../../shared/hooks/use-pages';
import { useSpaces, useSyncStatus } from '../../shared/hooks/use-spaces';
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
import { LibraryFilterDropdown, type FilterDropdownOption } from './LibraryFilterDropdown';
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
import { ShortcutHint } from '../../shared/components/ShortcutHint';
import { PageIcon } from '../../shared/components/page-icon/PageIcon';
import { HeaderHost } from '../../shared/components/layout/header-slot';
import { SanitizedHtml } from '../../shared/components/SanitizedHtml';
import { SETTINGS_PANELS } from '../settings/settings-nav';
import { CONFLUENCE_SETTINGS_PATH, SPACES_SETTINGS_PATH } from '../../shared/lib/routes';
import { OnboardingChecklistCard } from '../onboarding/OnboardingChecklistCard';
import { NotionImportDialog } from './notion-import/NotionImportDialog';
import { prefetchNotionConnection } from './notion-import/use-notion-import';
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

const SOURCE_OPTIONS: readonly FilterDropdownOption[] = [
  { value: '', label: 'All sources' },
  { value: 'confluence', label: 'Confluence' },
  { value: 'standalone', label: 'Local' },
];

const FRESHNESS_OPTIONS: readonly FilterDropdownOption[] = [
  { value: '', label: 'Any' },
  { value: 'fresh', label: 'Fresh (<7 days)' },
  { value: 'recent', label: 'Recent (7-30 days)' },
  { value: 'aging', label: 'Aging (30-90 days)' },
  { value: 'stale', label: 'Stale (>90 days)' },
];

const QUALITY_OPTIONS: readonly FilterDropdownOption[] = [
  { value: '', label: 'Any' },
  { value: 'excellent', label: 'Excellent (90-100)' },
  { value: 'good', label: 'Good (70-89)' },
  { value: 'needs-work', label: 'Needs Work (50-69)' },
  { value: 'poor', label: 'Poor (0-49)' },
];

const EMBEDDING_OPTIONS: readonly FilterDropdownOption[] = [
  { value: '', label: 'Any' },
  { value: 'pending', label: 'Needs Embedding' },
  { value: 'done', label: 'Embedded' },
];

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

function SourceVisibilityBadges({
  pageItem,
  showSource,
  showVisibility,
  className,
}: {
  pageItem: { id: string; source: 'confluence' | 'standalone'; visibility?: string };
  showSource: boolean;
  showVisibility: boolean;
  className?: string;
}) {
  if (!showSource && !showVisibility) return null;
  return (
    <>
      {showSource && (pageItem.source === 'standalone' ? (
        <span
          className={cn('shrink-0', className, neutralChipClass)}
          data-testid="badge-local"
          data-source-badge={pageItem.id}
        >
          Local
        </span>
      ) : (
        <span
          className={cn('shrink-0', className, neutralChipClass)}
          data-testid="badge-confluence"
          data-source-badge={pageItem.id}
        >
          Confluence
        </span>
      ))}
      {showVisibility && pageItem.source === 'standalone' && (
        pageItem.visibility === 'shared' ? (
          <span
            className={cn('shrink-0', className, neutralChipClass)}
            data-testid="badge-shared"
            data-visibility-badge={pageItem.id}
          >
            <Globe size={10} /> Shared
          </span>
        ) : (
          <span
            className={cn('shrink-0', className, neutralChipClass)}
            data-testid="badge-private"
            data-visibility-badge={pageItem.id}
          >
            <Lock size={10} /> Private
          </span>
        )
      )}
    </>
  );
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
  tabIndex?: number;
  onKeyDown?: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
  onFocus?: () => void;
}

const PageListItem = memo(function PageListItem({
  pageItem, index: _index, onNavigate, selected = false, onToggleSelect,
  showSource = false, showVisibility = false, showQuality = false,
  showIdleEmbedding = false, spaceName = null,
  tabIndex = 0, onKeyDown, onFocus,
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
          // tinted with a subtle Steel accent, while hover stays neutral.
          'group nm-focus-ring flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left transition-colors max-sm:items-start',
          selected
            ? 'bg-[color-mix(in_oklab,var(--color-primary)_12%,transparent)] hover:bg-[color-mix(in_oklab,var(--color-primary)_18%,transparent)]'
            : 'hover:bg-accent',
        )}
        data-testid={`article-hover-${pageItem.id}`}
      >
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={selected}
            tabIndex={-1}
            // Shift-click extends from the last toggled row, the convention in
            // every file list users already know.
            onClick={(e) => onToggleSelect(pageItem.id, e.shiftKey)}
            onChange={() => { /* click handler owns this; keeps React controlled */ }}
            aria-label={`Select ${pageItem.title}`}
            // The 2px nudge centres the 16px box on the title's ~20px line
            // when the row top-aligns below `sm`. Checkbox is subtly visible at
            // rest, highlighting on hover/focus, and fully solid when selected.
            className={cn(
              'size-4 shrink-0 cursor-pointer accent-[var(--color-action)] max-sm:mt-0.5 transition-opacity',
              selected
                ? 'opacity-100'
                : 'opacity-40 hover:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 max-sm:opacity-100',
            )}
            data-testid={`page-select-${pageItem.id}`}
          />
        )}
        <button
          type="button"
          onClick={() => onNavigate(pageItem.id)}
          tabIndex={tabIndex}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          data-testid={`page-row-button-${pageItem.id}`}
          // Below `sm` the button may wrap, and `basis-auto` on the title
          // block makes the wrap content-driven: `flex-1`'s basis of 0 never
          // triggers a line break, so with `auto` a block whose content fits
          // keeps today's single line, and only an overflowing one drops the
          // pipeline badge below the block instead of compressing it. At
          // `sm+` the max-sm classes are inert and the layout is untouched.
          className="nm-focus-ring flex min-w-0 flex-1 items-center gap-4 text-left max-sm:flex-wrap max-sm:gap-y-1 rounded-sm"
        >
          <div className="min-w-0 flex-1 text-left max-sm:basis-auto">
            {/* Title line. Below `sm` source/visibility sit in this wrap so a
                long title takes the width and the chips drop under it. At `sm+`
                those copies are `sm:hidden` and the chips live in the right
                rail instead — title line stays a single truncated identity. */}
            <div className="flex items-center gap-2 max-sm:flex-wrap max-sm:gap-y-1">
              <p className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium">
                {pageItem.icon && <PageIcon icon={pageItem.icon} pageId={pageItem.id} size="row" />}
                <span className="min-w-0 truncate" title={pageItem.title}>{pageItem.title}</span>
              </p>
              <SourceVisibilityBadges
                pageItem={pageItem}
                showSource={showSource}
                showVisibility={showVisibility}
                className="sm:hidden"
              />
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
            <SourceVisibilityBadges
              pageItem={pageItem}
              showSource={showSource}
              showVisibility={showVisibility}
            />
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
  // Only re-render if the page-item data or relevant row props changed
  if (prev.pageItem.id !== next.pageItem.id) return false;
  if (prev.pageItem.title !== next.pageItem.title) return false;
  if (prev.pageItem.version !== next.pageItem.version) return false;
  if (prev.pageItem.icon !== next.pageItem.icon) return false;
  if (prev.pageItem.author !== next.pageItem.author) return false;
  if (prev.pageItem.lastModifiedAt !== next.pageItem.lastModifiedAt) return false;
  if (prev.pageItem.source !== next.pageItem.source) return false;
  if (prev.pageItem.visibility !== next.pageItem.visibility) return false;
  if (prev.pageItem.spaceKey !== next.pageItem.spaceKey) return false;
  if (prev.pageItem.embeddingDirty !== next.pageItem.embeddingDirty) return false;
  if (prev.pageItem.qualityScore !== next.pageItem.qualityScore) return false;
  if (prev.pageItem.qualityStatus !== next.pageItem.qualityStatus) return false;
  if (prev.pageItem.qualityError !== next.pageItem.qualityError) return false;
  if (prev.pageItem.qualityAnalyzedAt !== next.pageItem.qualityAnalyzedAt) return false;
  if (prev.pageItem.summaryStatus !== next.pageItem.summaryStatus) return false;
  if (prev.pageItem.labels !== next.pageItem.labels && prev.pageItem.labels.join(',') !== next.pageItem.labels.join(',')) return false;
  if (prev.index !== next.index) return false;
  // Selection is row-local render state, not page data. Omitting it here made
  // the checkbox permanently unclickable-looking: the Set updated and the
  // action bar counted correctly, but the row skipped its re-render, so React
  // restored the controlled input's DOM back to unchecked.
  if (prev.selected !== next.selected) return false;
  if (prev.onNavigate !== next.onNavigate) return false;
  if (prev.onToggleSelect !== next.onToggleSelect) return false;
  if (prev.showSource !== next.showSource) return false;
  if (prev.showVisibility !== next.showVisibility) return false;
  if (prev.showQuality !== next.showQuality) return false;
  if (prev.showIdleEmbedding !== next.showIdleEmbedding) return false;
  if (prev.spaceName !== next.spaceName) return false;
  if (prev.tabIndex !== next.tabIndex) return false;
  if (prev.onKeyDown !== next.onKeyDown) return false;
  if (prev.onFocus !== next.onFocus) return false;
  return true;
});

// ---------------------------------------------------------------------------

export function PagesPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

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
  const [notionImportOpen, setNotionImportOpen] = useState(false);
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

  const authorOptions = useMemo<FilterDropdownOption[]>(() => [
    { value: '', label: 'All authors' },
    ...(filterOptions?.authors ?? []).map((a) => ({ value: a, label: a })),
  ], [filterOptions?.authors]);

  const labelOptions = useMemo<FilterDropdownOption[]>(() => [
    { value: '', label: 'All labels' },
    ...(filterOptions?.labels ?? []).map((l) => ({ value: l, label: l })),
  ], [filterOptions?.labels]);

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

  /**
   * Why the browse list is empty — four answers, not one (#1402 phase 3).
   *
   * A filter or a search term emptying the list is the user's own doing and
   * already says which. What was left undiagnosed is the unfiltered case: it
   * used to read "create a page, or connect a Confluence space" and offer a
   * `Go to Settings` button to the settings ROOT, whether the user had three
   * spaces synced and genuinely no local pages, or had never entered a PAT and
   * so had no corpus at all. The second reader was told to go find the right
   * panel themselves; the first was sent back to a screen they had finished
   * with.
   *
   * "No PAT" and "PAT but no spaces" are NOT the same dead end, and the first
   * cut of this block collapsed them into one `No Confluence spaces connected`
   * pointing at the PAT panel. On this very screen the Getting Started
   * checklist treats `Connect your Confluence account` and `Choose the spaces
   * to sync` as two separate milestones, and `CONFLUENCE_SETTINGS_PATH` renders
   * only the PAT form — so a user who already had a token read "not connected"
   * directly under a checklist row ticked Done, and the CTA sent them back to
   * the step they had finished. The two branches now name their own gap and
   * deep-link their own panel, wording matched to the checklist milestone so
   * the two surfaces on one screen cannot disagree.
   *
   * Both halves read the `settings` this component already fetches for its
   * KPIs — `hasConfluencePat` and `selectedSpaces` are on `GET /settings` — and
   * both are gated on `settingsKnown`. An unresolved or failed `GET /settings`
   * is not evidence of anything: without the gate a pending fetch (or a 500)
   * rendered "No Confluence spaces connected" at a connected user, which is the
   * same failure-as-empty-state mistake the `pagesError && !pagesData` branch
   * below exists to avoid. Unknown settings fall through to the generic copy,
   * which is true in every state. `use-onboarding` gates on the same
   * `settings !== undefined`, and reads `selectedSpaces` with the same optional
   * chain — `useSettings()` does no runtime validation, so a response missing
   * the field would otherwise throw during render and take the route down.
   */
  const unfilteredEmpty = activeFilterCount === 0 && !search;
  const settingsKnown = settings !== undefined;
  const promptConfluenceConnect =
    unfilteredEmpty && settingsKnown && !settings.hasConfluencePat;
  const promptSelectSpaces =
    unfilteredEmpty &&
    settingsKnown &&
    settings.hasConfluencePat === true &&
    (settings.selectedSpaces?.length ?? 0) === 0;

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
  const showSourceBadges = useMemo(() => {
    // If the library contains mixed sources across spaces/corpus (e.g. Confluence spaces exist and there are standalone pages,
    // or the current page slice has mixed sources), keep source badges visible to ensure stable row layout across pagination.
    const pageSources = new Set(pageItems.map((p) => p.source));
    if (pageSources.size > 1) return true;
    const hasConfluence = (spaces ?? []).some((s) => s.key && s.key !== '__local__') || pageSources.has('confluence');
    const hasStandalone = (spaces ?? []).some((s) => s.key === '__local__') || pageSources.has('standalone');
    return hasConfluence && hasStandalone;
  }, [pageItems, spaces]);
  const showVisibilityBadges = useMemo(() => {
    const vis = new Set(
      pageItems.filter((p) => p.source === 'standalone').map((p) => p.visibility ?? 'private'),
    );
    return vis.size > 1;
  }, [pageItems]);
  const showQualityBadges = Boolean(qualityFilter);
  const showIdleEmbedding = embeddingStatus === 'pending';
  const spaceNameByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of spaces ?? []) {
      if (s.key && s.name) map.set(s.key, s.name);
    }
    return map;
  }, [spaces]);
  const displaySearchItems = useMemo(
    () => searchResults.enhancedResults ?? searchResults.immediateResults,
    [searchResults.enhancedResults, searchResults.immediateResults],
  );

  const currentAddressableItems = useMemo(() => {
    if (useSemanticSearch) {
      return displaySearchItems.map((p) => ({
        id: String(p.id),
        confluenceId: p.confluenceId,
        source: p.spaceKey === '__local__' ? 'standalone' : 'confluence',
      }));
    }
    return pageItems.map((p) => ({
      id: p.id,
      confluenceId: p.confluenceId,
      source: p.source,
    }));
  }, [useSemanticSearch, displaySearchItems, pageItems]);

  const currentIds = useMemo(
    () => (useSemanticSearch ? displaySearchItems.map((p) => String(p.id)) : pageItems.map((p) => p.id)),
    [useSemanticSearch, displaySearchItems, pageItems],
  );

  const toggleSelect = useCallback((id: string, shiftKey: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const anchor = lastToggledId.current;
      const ids = currentIds;

      // Shift-click selects the contiguous run between the anchor and this
      // row, matching the file-list convention.
      if (shiftKey && anchor && anchor !== id) {
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
  }, [currentIds]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    lastToggledId.current = null;
  }, []);

  // Drop ids that fell out of the result set, so the action bar never reports
  // a count that includes rows the user can no longer see.
  const visibleSelectedIds = useMemo(
    () => currentAddressableItems.filter((p) => selectedIds.has(p.id)).map(bulkWireId),
    [currentAddressableItems, selectedIds],
  );
  const selectedConfluenceCount = useMemo(
    () => currentAddressableItems.filter((p) => selectedIds.has(p.id) && p.source === 'confluence').length,
    [currentAddressableItems, selectedIds],
  );
  const allVisibleSelected = currentIds.length > 0 && visibleSelectedIds.length === currentIds.length;

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const allSelected = currentIds.length > 0 && currentIds.every((id) => prev.has(id));
      if (allSelected) return new Set();
      return new Set(currentIds);
    });
    lastToggledId.current = null;
  }, [currentIds]);

  const scrollMargin = listContainerRef.current?.offsetTop ?? 0;

  const virtualizer = useVirtualizer({
    count: pageItems.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => 52,
    overscan: 5,
    scrollMargin,
    useFlushSync: false, // Required for React 19
  });

  const [focusedRowIndex, setFocusedRowIndex] = useState<number>(0);
  const pendingFocusIndexRef = useRef<number | null>(null);

  // Clamp out-of-bounds page parameter back to 1 when a filter reduces totalPages
  useEffect(() => {
    if (pagesData && pagesData.totalPages > 0 && page > pagesData.totalPages) {
      setFilters({ page: 1 });
    }
  }, [pagesData, page, setFilters]);

  // Ensure focus is restored to the virtual row once it mounts after an async scroll jump
  useEffect(() => {
    if (pendingFocusIndexRef.current !== null) {
      const idx = pendingFocusIndexRef.current;
      const el = listContainerRef.current?.querySelector<HTMLButtonElement>(`[data-row-index="${idx}"] button[type="button"]`);
      if (el) {
        el.focus();
        pendingFocusIndexRef.current = null;
      }
    }
  });

  const handleRowKeyDown = useCallback((index: number, id: string, e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = Math.min(pageItems.length - 1, index + 1);
      setFocusedRowIndex(nextIndex);
      pendingFocusIndexRef.current = nextIndex;
      virtualizer.scrollToIndex(nextIndex);
      if (e.shiftKey && nextIndex !== index) {
        if (!selectedIds.has(id) && !lastToggledId.current) {
          toggleSelect(id, false);
        }
        const nextId = pageItems[nextIndex]?.id;
        if (nextId) toggleSelect(nextId, true);
      }
      requestAnimationFrame(() => {
        const nextEl = listContainerRef.current?.querySelector<HTMLButtonElement>(`[data-row-index="${nextIndex}"] button[type="button"]`);
        if (nextEl) {
          nextEl.focus();
          pendingFocusIndexRef.current = null;
        }
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = Math.max(0, index - 1);
      setFocusedRowIndex(prevIndex);
      pendingFocusIndexRef.current = prevIndex;
      virtualizer.scrollToIndex(prevIndex);
      if (e.shiftKey && prevIndex !== index) {
        if (!selectedIds.has(id) && !lastToggledId.current) {
          toggleSelect(id, false);
        }
        const prevId = pageItems[prevIndex]?.id;
        if (prevId) toggleSelect(prevId, true);
      }
      requestAnimationFrame(() => {
        const prevEl = listContainerRef.current?.querySelector<HTMLButtonElement>(`[data-row-index="${prevIndex}"] button[type="button"]`);
        if (prevEl) {
          prevEl.focus();
          pendingFocusIndexRef.current = null;
        }
      });
    } else if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      toggleSelect(id, e.shiftKey);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setFocusedRowIndex(0);
      pendingFocusIndexRef.current = 0;
      virtualizer.scrollToIndex(0);
      requestAnimationFrame(() => {
        const firstEl = listContainerRef.current?.querySelector<HTMLButtonElement>('[data-row-index="0"] button[type="button"]');
        if (firstEl) {
          firstEl.focus();
          pendingFocusIndexRef.current = null;
        }
      });
    } else if (e.key === 'End') {
      e.preventDefault();
      const lastIndex = pageItems.length - 1;
      setFocusedRowIndex(lastIndex);
      pendingFocusIndexRef.current = lastIndex;
      virtualizer.scrollToIndex(lastIndex);
      requestAnimationFrame(() => {
        const lastEl = listContainerRef.current?.querySelector<HTMLButtonElement>(`[data-row-index="${lastIndex}"] button[type="button"]`);
        if (lastEl) {
          lastEl.focus();
          pendingFocusIndexRef.current = null;
        }
      });
    }
  }, [pageItems, selectedIds, toggleSelect, virtualizer]);

  const [focusedSearchRowIndex, setFocusedSearchRowIndex] = useState<number>(0);

  const handleSearchRowKeyDown = useCallback((index: number, id: string, total: number, e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = Math.min(total - 1, index + 1);
      setFocusedSearchRowIndex(nextIndex);
      if (e.shiftKey && nextIndex !== index) {
        if (!selectedIds.has(id) && !lastToggledId.current) {
          toggleSelect(id, false);
        }
        const nextId = currentAddressableItems[nextIndex]?.id;
        if (nextId) toggleSelect(nextId, true);
      }
      const nextEl = document.querySelector<HTMLButtonElement>(`[data-search-row-index="${nextIndex}"] button[type="button"]`);
      nextEl?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = Math.max(0, index - 1);
      setFocusedSearchRowIndex(prevIndex);
      if (e.shiftKey && prevIndex !== index) {
        if (!selectedIds.has(id) && !lastToggledId.current) {
          toggleSelect(id, false);
        }
        const prevId = currentAddressableItems[prevIndex]?.id;
        if (prevId) toggleSelect(prevId, true);
      }
      const prevEl = document.querySelector<HTMLButtonElement>(`[data-search-row-index="${prevIndex}"] button[type="button"]`);
      prevEl?.focus();
    } else if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      toggleSelect(id, e.shiftKey);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setFocusedSearchRowIndex(0);
      const firstEl = document.querySelector<HTMLButtonElement>('[data-search-row-index="0"] button[type="button"]');
      firstEl?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      const lastIndex = total - 1;
      setFocusedSearchRowIndex(lastIndex);
      const lastEl = document.querySelector<HTMLButtonElement>(`[data-search-row-index="${lastIndex}"] button[type="button"]`);
      lastEl?.focus();
    }
  }, [currentAddressableItems, selectedIds, toggleSelect]);

  /**
   * #1402: Dismiss removes the checklist while the user's focus is on its
   * button, which drops focus to `<body>` — the failure CLAUDE.md records for
   * `RetrievalTab`'s Retry. Focus lands on the Library heading, the first
   * thing above what was removed, so a keyboard or screen-reader user resumes
   * where the region was rather than at the top of the document.
   *
   * Guarded like the precedent: `dismiss()` is a network round-trip, and if
   * the user moved on during it their caret stays where they put it.
   */
  const libraryHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const handleChecklistDismissed = useCallback(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    libraryHeadingRef.current?.focus();
  }, []);

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
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          {/* `tabIndex={-1}` adds no tab stop; it is the landing place for
              focus when the #1402 checklist below removes itself under it. */}
          <h1
            ref={libraryHeadingRef}
            tabIndex={-1}
            className="nm-focus-ring min-w-0 truncate text-[15px] font-semibold sm:text-lg"
          >
            {LIBRARY_HEADING}
          </h1>
          <div className="flex flex-wrap items-center gap-3 sm:gap-4">
            <KPICards
              embeddingStatus={embeddingStatusData}
              spacesCount={spaces?.length ?? 0}
              lastSynced={syncStatus?.lastSynced}
            />
            <button
              type="button"
              onClick={() => setNotionImportOpen(true)}
              onMouseEnter={() => prefetchNotionConnection(queryClient)}
              onFocus={() => prefetchNotionConnection(queryClient)}
              className="nm-button-ghost h-8 px-3 text-xs sm:text-sm"
              data-testid="import-notion-button"
            >
              Import from Notion
            </button>
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

      {/* #1402: the Getting Started checklist. A sibling block, not a wrapper:
          it sits above discovery and the tree and never replaces any of their
          loading / failed / failed-with-cache / empty states. It renders
          nothing once the user dismisses it. */}
      <NotionImportDialog open={notionImportOpen} onClose={() => setNotionImportOpen(false)} />
      <OnboardingChecklistCard onDismissed={handleChecklistDismissed} />

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
          className="library-search-surface flex w-full flex-col gap-2 rounded-xl p-2.5 sm:flex-row sm:items-center sm:gap-1 sm:p-2"
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
                } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
                  const firstRow = document.querySelector<HTMLButtonElement>(
                    '[data-search-row-index="0"] button[type="button"], [data-row-index="0"] button[type="button"]',
                  );
                  if (firstRow) {
                    e.preventDefault();
                    firstRow.focus();
                  }
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

          <div className="flex w-full items-center gap-1.5 sm:w-auto sm:shrink-0">
            {/* Inline search strategy switcher */}
            <div
              className="library-search-modes inline-flex items-center gap-0.5 rounded-md p-0.5 shrink-0"
              data-testid="search-mode-toggle"
              role="group"
              aria-label="Search strategy"
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
                  title={SEARCH_MODE_DESCRIPTIONS[m]}
                  className={cn(
                    'nm-focus-ring min-h-11 flex-1 whitespace-nowrap rounded-sm border border-transparent px-2.5 py-1 text-sm font-medium transition-colors sm:min-h-0 sm:flex-none sm:px-2.5 sm:py-1 sm:text-xs',
                    searchMode === m
                      ? 'library-search-mode-active font-semibold shadow-xs'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {SEARCH_MODE_LABELS[m]}
                </button>
              ))}
            </div>

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
                'library-search-select flex h-11 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground sm:h-8 sm:px-2.5 sm:text-xs',
                (showAdvancedFilters || advancedFilterCount > 0) && 'bg-accent text-foreground',
                hasActiveQuery && searchMode !== 'keyword' && advancedFilterCount > 0 && 'text-warning',
              )}
              data-testid="advanced-filters-toggle"
              aria-label={filterStatus ? `Filters, ${filterStatus}` : 'Filters'}
              title={filterStatus ? `Filters (${filterStatus})` : 'Filters'}
              aria-expanded={showAdvancedFilters}
              aria-controls="advanced-filters-panel"
            >
              <Filter size={14} aria-hidden="true" />
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
            className="rounded-xl border border-border bg-card p-4 sm:p-5"
            data-testid="advanced-filters-panel"
          >
            <div className="mb-4 flex min-h-8 flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
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
                <button type="button" onClick={clearIgnoredFilters} className="nm-button-ghost h-7 px-2.5 text-xs">
                  Clear filters
                </button>
              )}
            </div>

            {!hasActiveQuery && searchMode !== 'keyword' && advancedFilterCount > 0 && (
              <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground" data-testid="filters-keyword-preview-note">
                <span>These filters apply while browsing and will pause when {SEARCH_MODE_LABELS[searchMode]} search starts.</span>
                <button type="button" onClick={useKeywordWithFilters} className="nm-button-ghost h-7 px-2 text-xs">
                  Keep them active with Keyword
                </button>
              </div>
            )}

            {/* 2-row spacious filter grid with generous horizontal padding & space */}
            <div className="space-y-4">
              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Content
                </legend>
                <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-3">
                  {/* Row 1: Source, Author, Label */}
                  <div className="min-w-0">
                    <label htmlFor="filter-source-select" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      Source
                    </label>
                    <LibraryFilterDropdown
                      id="filter-source-select"
                      label="Source"
                      ariaLabel="Filter by source"
                      value={sourceFilter}
                      options={SOURCE_OPTIONS}
                      onChange={(val) => setFilters({ source: val as PageSource | '', page: 1 })}
                      placeholder="All sources"
                      testId="filter-source"
                    />
                  </div>

                  <div className="min-w-0">
                    <label htmlFor="filter-author-select" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      Author
                    </label>
                    <LibraryFilterDropdown
                      id="filter-author-select"
                      label="Author"
                      value={author}
                      options={authorOptions}
                      onChange={(val) => setFilters({ author: val, page: 1 })}
                      placeholder="All authors"
                      testId="filter-author"
                      searchable
                    />
                  </div>

                  <div className="min-w-0">
                    <label htmlFor="filter-labels-select" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      Label
                    </label>
                    <LibraryFilterDropdown
                      id="filter-labels-select"
                      label="Label"
                      value={labels}
                      options={labelOptions}
                      onChange={(val) => setFilters({ labels: val, page: 1 })}
                      placeholder="All labels"
                      testId="filter-labels"
                      searchable
                    />
                  </div>
                </div>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Status &amp; date
                </legend>
                <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-5">
                  {/* Row 2: Freshness, Quality, Embedding, From, To */}
                  <div className="min-w-0">
                    <label htmlFor="filter-freshness-select" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      Freshness
                    </label>
                    <LibraryFilterDropdown
                      id="filter-freshness-select"
                      label="Freshness"
                      value={freshness}
                      options={FRESHNESS_OPTIONS}
                      onChange={(val) => setFilters({ freshness: val, page: 1 })}
                      placeholder="Any"
                      testId="filter-freshness"
                    />
                  </div>

                  <div className="min-w-0">
                    <label htmlFor="filter-quality-select" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      Quality
                    </label>
                    <LibraryFilterDropdown
                      id="filter-quality-select"
                      label="Quality"
                      value={qualityFilter}
                      options={QUALITY_OPTIONS}
                      onChange={(val) => setFilters({ quality: val, page: 1 })}
                      placeholder="Any"
                      testId="filter-quality"
                    />
                  </div>

                  <div className="min-w-0">
                    <label htmlFor="filter-embedding-select" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      Embedding
                    </label>
                    <LibraryFilterDropdown
                      id="filter-embedding-select"
                      label="Embedding"
                      value={embeddingStatus}
                      options={EMBEDDING_OPTIONS}
                      onChange={(val) => setFilters({ embedding: val, page: 1 })}
                      placeholder="Any"
                      testId="filter-embedding"
                    />
                  </div>

                  <div className="min-w-0">
                    <label htmlFor="filter-date-from-input" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      Modified from
                    </label>
                    <input
                      id="filter-date-from-input"
                      type="date"
                      value={dateFromInput}
                      max={dateToInput || undefined}
                      onChange={(e) => setDateFromInput(e.target.value)}
                      className="nm-input h-9 w-full px-3 py-1.5 text-xs"
                      data-testid="filter-date-from"
                      aria-label="Modified from"
                    />
                  </div>

                  <div className="min-w-0">
                    <label htmlFor="filter-date-to-input" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      Modified to
                    </label>
                    <input
                      id="filter-date-to-input"
                      type="date"
                      value={dateToInput}
                      min={dateFromInput || undefined}
                      onChange={(e) => setDateToInput(e.target.value)}
                      className="nm-input h-9 w-full px-3 py-1.5 text-xs"
                      data-testid="filter-date-to"
                      aria-label="Modified to"
                    />
                  </div>
                </div>
              </fieldset>
            </div>
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
              className="prose max-w-none py-2"
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
                {/* Unlined since 2026-08-31 (ADR-010, second pass). The
                    results list states its own extent: the Chrome header band
                    at the top, a row divider under every row, and the last
                    divider closing the bottom. A ring around all of that was a
                    third statement of the same boundary — the argument that
                    took the border off the workspace card and the context
                    rail — and the header band's fill is what replaces the
                    header's own `border-b`. */}
                <div data-testid="library-search-results-panel" className="overflow-hidden rounded-lg bg-card">
                  <div className="panel-toolbar flex flex-wrap items-center gap-3 px-3 py-2 text-xs text-muted-foreground" data-testid="search-results-context" aria-live="polite">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = visibleSelectedIds.length > 0 && !allVisibleSelected;
                        }}
                        onChange={toggleSelectAll}
                        aria-label={allVisibleSelected ? 'Deselect all pages' : 'Select all pages'}
                        className="size-4 shrink-0 cursor-pointer accent-[var(--color-action)]"
                        data-testid="select-all-search-pages"
                      />
                      <span className="font-medium text-foreground" data-testid="search-results-count">
                        {visibleSelectedIds.length > 0 ? (
                          `${visibleSelectedIds.length} of ${currentIds.length} selected`
                        ) : (
                          `${searchResults.total} ${searchResults.total === 1 ? 'result' : 'results'}`
                        )}
                        <span className="ml-1.5 font-normal text-muted-foreground/70">({SEARCH_MODE_LABELS[searchMode]})</span>
                      </span>
                      {selectedSpace && (
                        <>
                          <span aria-hidden="true" className="text-muted-foreground/60">·</span>
                          <span className="truncate">{selectedSpace.name}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <BulkActionBar
                    selectedIds={visibleSelectedIds}
                    confluenceCount={selectedConfluenceCount}
                    onClear={clearSelection}
                  />

                  <div role="list" aria-label="Search results">
                    {displayItems.map((item, i) => {
                      const itemId = String(item.id);
                      const isSelected = selectedIds.has(itemId);
                      return (
                        <m.div
                          key={item.id}
                          role="listitem"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: 0.15, delay: i * 0.02 }}
                          data-search-row-index={i}
                        >
                            <div
                              className={cn(
                                'group nm-focus-ring flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left transition-colors last:border-b-0 max-sm:items-start',
                                isSelected
                                  ? 'bg-[color-mix(in_oklab,var(--color-primary)_12%,transparent)] hover:bg-[color-mix(in_oklab,var(--color-primary)_18%,transparent)]'
                                  : 'hover:bg-accent',
                              )}
                              data-testid={`article-hover-${item.id}`}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                tabIndex={-1}
                                onClick={(e) => toggleSelect(itemId, e.shiftKey)}
                                onChange={() => {}}
                                aria-label={`Select ${item.title}`}
                                className={cn(
                                  'size-4 shrink-0 cursor-pointer accent-[var(--color-action)] max-sm:mt-0.5 transition-opacity',
                                  isSelected
                                    ? 'opacity-100'
                                    : 'opacity-40 hover:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 max-sm:opacity-100',
                                )}
                                data-testid={`page-select-${item.id}`}
                              />
                              <button
                                type="button"
                                onClick={() => navigate(`/pages/${item.id}`)}
                                tabIndex={focusedSearchRowIndex === i ? 0 : -1}
                                onFocus={() => setFocusedSearchRowIndex(i)}
                                onKeyDown={(e) => handleSearchRowKeyDown(i, itemId, displayItems.length, e)}
                                className="nm-focus-ring flex min-w-0 flex-1 items-center gap-3 text-left max-sm:flex-wrap max-sm:gap-y-1 rounded-sm"
                              >
                                <div className="min-w-0 flex-1 text-left max-sm:basis-auto max-sm:max-w-[calc(100%-30px)]">
                                  <p className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-foreground">
                                    {item.icon && <PageIcon icon={item.icon} pageId={itemId} size="row" />}
                                    <span className="min-w-0 truncate" title={item.title}>{item.title}</span>
                                  </p>
                                  {item.excerpt && (
                                    <SanitizedHtml
                                      html={item.excerpt}
                                      allowedTags={['mark']}
                                      allowedAttrs={[]}
                                      className="mt-0.5 line-clamp-2 text-xs text-muted-foreground leading-relaxed max-sm:[contain:inline-size] [&_mark]:rounded-[2px] [&_mark]:bg-action/15 [&_mark]:font-medium [&_mark]:text-foreground"
                                    />
                                  )}
                                  {item.spaceKey && item.spaceKey !== '__local__' && (
                                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                                      <span title={item.spaceKey}>{spaceNameByKey.get(item.spaceKey) ?? item.spaceKey}</span>
                                    </div>
                                  )}
                                  {item.spaceKey && (
                                    item.spaceKey !== '__local__' ? (
                                      <span
                                        className={cn('mt-1 sm:hidden shrink-0', neutralChipClass)}
                                        data-testid="badge-confluence"
                                        data-source-badge={item.id}
                                      >
                                        Confluence
                                      </span>
                                    ) : (
                                      <span
                                        className={cn('mt-1 sm:hidden shrink-0', neutralChipClass)}
                                        data-testid="badge-local"
                                        data-source-badge={item.id}
                                      >
                                        Local
                                      </span>
                                    )
                                  )}
                                </div>

                                <div className="hidden shrink-0 items-center gap-2 sm:flex">
                                  {item.spaceKey && (
                                    item.spaceKey !== '__local__' ? (
                                      <span
                                        className={cn('shrink-0', neutralChipClass)}
                                        data-testid="badge-confluence"
                                        data-source-badge={item.id}
                                      >
                                        Confluence
                                      </span>
                                    ) : (
                                      <span
                                        className={cn('shrink-0', neutralChipClass)}
                                        data-testid="badge-local"
                                        data-source-badge={item.id}
                                      >
                                        Local
                                      </span>
                                    )
                                  )}
                                </div>

                                {/* Similarity only — renderable cosine distance percentage */}
                                {item.similarity !== null && item.similarity > 0 && (
                                  <span
                                    title="Semantic similarity to your query"
                                    className="shrink-0 rounded bg-muted/80 px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground border border-border/50"
                                  >
                                    {(item.similarity * 100).toFixed(0)}%
                                  </span>
                                )}
                              </button>
                            </div>
                        </m.div>
                      );
                    })}
                  </div>
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
                <button
                  onClick={() => refetchPages()}
                  disabled={isFetchingPages}
                  className="nm-focus-ring flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-60"
                  data-testid="pages-error-retry"
                >
                  {isFetchingPages && <Loader2 size={12} className="animate-spin" />}
                  {isFetchingPages ? 'Retrying…' : 'Retry'}
                </button>
              </div>
            </div>
          ) : !pagesData?.items.length ? (
            <EmptyState
              icon={FolderOpen}
              className="border-0 bg-transparent"
              title={
                promptConfluenceConnect
                  ? 'No Confluence spaces connected'
                  : promptSelectSpaces
                    ? 'No spaces selected'
                    : 'No pages found'
              }
              description={
                promptConfluenceConnect
                  ? "Connect your Confluence Data Center instance to sync your team's documentation and knowledge bases."
                  : promptSelectSpaces
                    ? 'Your Confluence account is connected. Choose the spaces to sync and their pages will appear here.'
                    : activeFilterCount > 0
                      ? (search
                          ? `No pages match "${search}" with ${summarizeFilterLabels(activeFilters.map((f) => f.label))}`
                          : `No pages match ${summarizeFilterLabels(activeFilters.map((f) => f.label))}`)
                      : (search ? 'Try a different search term' : 'Create a page, or connect a Confluence space to fill this list')
              }
              action={
                promptConfluenceConnect
                  ? { label: 'Connect Confluence', onClick: () => navigate(CONFLUENCE_SETTINGS_PATH) }
                  : promptSelectSpaces
                    ? { label: 'Choose spaces', onClick: () => navigate(SPACES_SETTINGS_PATH) }
                    : activeFilterCount > 0
                      ? { label: 'Clear filters', onClick: clearAllFilters }
                      : (!search ? { label: 'Go to Settings', onClick: () => navigate('/settings') } : undefined)
              }
              /* The checklist one block above asks for this same setup, and
                 the header's `New Page` is this route's own primary action. A
                 filled Steel button here would be the third voice and the
                 loudest — so the setup prompts speak second. */
              actionTone={promptConfluenceConnect || promptSelectSpaces ? 'secondary' : 'primary'}
              secondaryAction={
                unfilteredEmpty
                  ? { label: 'Create a Page', onClick: () => navigate('/pages/new') }
                  : undefined
              }
            />
          ) : (
            <>
              {/* Unlined, same reasoning as the search results panel above. */}
              <div data-testid="library-results-panel" className="overflow-hidden rounded-lg bg-card">
                <div className="panel-toolbar flex flex-wrap items-center gap-3 px-3 py-2 text-xs text-muted-foreground" data-testid="browse-results-context" aria-live="polite">
                  <div className="flex items-center gap-2.5 min-w-0">
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
                      className="size-4 shrink-0 cursor-pointer accent-[var(--color-action)]"
                      data-testid="select-all-pages"
                    />
                    <span className="font-medium text-foreground" data-testid="browse-results-count">
                      {visibleSelectedIds.length > 0 ? (
                        `${visibleSelectedIds.length} of ${currentIds.length} selected`
                      ) : (
                        `${pagesData.total} ${pagesData.total === 1 ? 'page' : 'pages'}`
                      )}
                    </span>
                    {selectedSpace && (
                      <>
                        <span aria-hidden="true" className="text-muted-foreground/60">·</span>
                        <span className="truncate">{selectedSpace.name}</span>
                      </>
                    )}
                  </div>

                  <div className="ml-auto flex items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">Sort</span>
                    <LibrarySortFilter
                      value={sort}
                      onChange={(newSort) => setFilters({ sort: newSort, page: 1 })}
                      hasSearchQuery={hasActiveQuery}
                    />
                  </div>
                </div>

                <BulkActionBar
                  selectedIds={visibleSelectedIds}
                  confluenceCount={selectedConfluenceCount}
                  onClear={clearSelection}
                />

                <div
                  ref={listContainerRef}
                  data-testid="virtual-list-container"
                  role="feed"
                  aria-label="Pages list"
                  aria-rowcount={pagesData.total}
                  aria-busy={isLoading}
                  style={{ position: 'relative', height: virtualizer.getTotalSize() }}
                >
                  {virtualizer.getVirtualItems().map((virtualRow) => {
                    const pageItem = pageItems[virtualRow.index];
                    if (!pageItem) return null;
                    return (
                      <div
                        key={pageItem.id}
                        data-index={virtualRow.index}
                        data-row-index={virtualRow.index}
                        role="article"
                        aria-rowindex={virtualRow.index + 1}
                        aria-posinset={virtualRow.index + 1}
                        aria-setsize={pagesData.total}
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
                            spaceName={pageItem.spaceKey ? spaceNameByKey.get(pageItem.spaceKey) ?? null : null}
                            tabIndex={focusedRowIndex === virtualRow.index ? 0 : -1}
                            onFocus={() => setFocusedRowIndex(virtualRow.index)}
                            onKeyDown={(e) => handleRowKeyDown(virtualRow.index, pageItem.id, e)}
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
