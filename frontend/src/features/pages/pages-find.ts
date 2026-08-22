/** The Library's local search surface; Ctrl/Cmd+K remains the global palette. */
export const FIND_LABEL = 'Search library pages';
export const FIND_PLACEHOLDER = 'Search your library';
export const LIBRARY_HEADING = 'Library';

export const SEARCH_MODE_LABELS = {
  hybrid: 'Hybrid',
  keyword: 'Keyword',
  semantic: 'Semantic',
} as const;

export const SEARCH_MODE_DESCRIPTIONS = {
  hybrid: 'Combines meaning and keyword signals. Space applies; advanced filters require Keyword.',
  keyword: 'Matches terms and applies Space plus every advanced filter.',
  semantic: 'Matches meaning similarity. Space applies; advanced filters require Keyword.',
} as const;
