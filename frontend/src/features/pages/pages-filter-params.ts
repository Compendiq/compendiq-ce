/**
 * URL search params as the source of truth for the pages overview's filter,
 * search, sort and pagination state (#1124).
 *
 * These lived in `useState`, so opening an article and coming back re-mounted
 * `PagesPage` with every filter reset. React Router keeps the URL across that
 * round trip, so putting the state there fixes browser back, in-app back and
 * deep-linking with one mechanism — and makes a filtered view shareable, which
 * a Zustand store could not do.
 *
 * Every value is optional and every default is written as *absence*, so an
 * untouched overview stays at a bare `/` rather than carrying a query string of
 * empty strings.
 */

import { PageSourceEnum, type PageSource } from '@compendiq/contracts';

export type SortKey = 'title' | 'modified' | 'author' | 'quality' | 'relevance';
export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

export interface PageFilterState {
  space: string;
  search: string;
  author: string;
  labels: string;
  freshness: string;
  embedding: string;
  quality: string;
  from: string;
  to: string;
  source: PageSource | '';
  sort: SortKey;
  mode: SearchMode;
  page: number;
}

export const FILTER_DEFAULTS: PageFilterState = {
  space: '',
  search: '',
  author: '',
  labels: '',
  freshness: '',
  embedding: '',
  quality: '',
  from: '',
  to: '',
  source: '',
  sort: 'modified',
  mode: 'keyword',
  page: 1,
};

/**
 * The keys the advanced-filters panel owns. A URL carrying any of them has to
 * open the panel on entry, or the user lands on a filtered list whose controls
 * are hidden and cannot see why the result set is short.
 */
export const ADVANCED_FILTER_KEYS = [
  'author',
  'labels',
  'freshness',
  'embedding',
  'quality',
  'from',
  'to',
  'source',
] as const satisfies readonly (keyof PageFilterState)[];

const SORT_KEYS: readonly SortKey[] = ['title', 'modified', 'author', 'quality', 'relevance'];
const SEARCH_MODES: readonly SearchMode[] = ['keyword', 'semantic', 'hybrid'];

const FRESHNESS_VALUES = ['fresh', 'recent', 'aging', 'stale'] as const;
const EMBEDDING_VALUES = ['pending', 'done'] as const;
const QUALITY_VALUES = ['excellent', 'good', 'needs-work', 'poor'] as const;

/** Falls back to `fallback` unless the raw value is one the UI can render. */
function oneOf<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * Read the filter state out of a URL.
 *
 * A hand-edited or stale link is normal input here, not an error: an
 * unrecognised `sort`, `mode`, `source` or enum filter falls back to its
 * default rather than being handed to a `<select>` that has no such option
 * (which would silently render as blank) or to the API.
 */
export function readFilterState(params: URLSearchParams): PageFilterState {
  const rawPage = Number.parseInt(params.get('page') ?? '', 10);

  return {
    space: params.get('space') ?? FILTER_DEFAULTS.space,
    search: params.get('search') ?? FILTER_DEFAULTS.search,
    author: params.get('author') ?? FILTER_DEFAULTS.author,
    labels: params.get('labels') ?? FILTER_DEFAULTS.labels,
    freshness: oneOf(params.get('freshness'), FRESHNESS_VALUES, '' as never),
    embedding: oneOf(params.get('embedding'), EMBEDDING_VALUES, '' as never),
    quality: oneOf(params.get('quality'), QUALITY_VALUES, '' as never),
    from: params.get('from') ?? FILTER_DEFAULTS.from,
    to: params.get('to') ?? FILTER_DEFAULTS.to,
    source: oneOf(params.get('source'), PageSourceEnum.options, '' as PageSource | ''),
    sort: oneOf(params.get('sort'), SORT_KEYS, FILTER_DEFAULTS.sort),
    mode: oneOf(params.get('mode'), SEARCH_MODES, FILTER_DEFAULTS.mode),
    page: Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : FILTER_DEFAULTS.page,
  };
}

/**
 * Apply a patch on top of an existing query string, returning a new
 * `URLSearchParams`.
 *
 * A key set to its default is *deleted* rather than written, so clearing a
 * filter shortens the URL instead of littering it with `author=`. Params this
 * module does not own are carried through untouched.
 */
export function applyFilterPatch(
  params: URLSearchParams,
  patch: Partial<PageFilterState>,
): URLSearchParams {
  const next = new URLSearchParams(params);

  for (const [key, value] of Object.entries(patch) as [keyof PageFilterState, unknown][]) {
    if (value === undefined) continue;
    if (value === FILTER_DEFAULTS[key]) {
      next.delete(key);
    } else {
      next.set(key, String(value));
    }
  }

  return next;
}

/** True when the URL carries any filter the advanced panel owns. */
export function hasAdvancedFilters(state: PageFilterState): boolean {
  return ADVANCED_FILTER_KEYS.some((key) => state[key] !== FILTER_DEFAULTS[key]);
}
