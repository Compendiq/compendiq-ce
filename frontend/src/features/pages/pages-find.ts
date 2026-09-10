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
  hybrid: 'Hybrid (Recommended): Combines meaning and keyword matching. Space applies; advanced filters require Keyword.',
  keyword: 'Keyword: Matches exact terms and applies all advanced filters (author, labels, freshness, quality, date, embedding, source).',
  semantic: 'Semantic: Matches concepts and meaning. Space applies; advanced filters require Keyword.',
} as const;
