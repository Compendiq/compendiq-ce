/**
 * Library list filter copy. Header Find (command palette) stays "Find" —
 * pages and commands. This field only filters the list on this route, so it
 * must not share that verb.
 */
export const FIND_LABEL = 'Filter this list';
export const FIND_PLACEHOLDER = 'Filter this list';
export const LIBRARY_HEADING = 'Library';

export const SEARCH_MODE_LABELS = {
  hybrid: 'Best match',
  keyword: 'Exact words',
  semantic: 'Meaning only',
} as const;