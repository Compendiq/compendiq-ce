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
  hybrid: 'Hybrid (Recommended): Combines AI semantic understanding with exact keyword matching.',
  keyword: 'Keyword: Matches exact terms and applies all advanced filters (freshness, quality, date).',
  semantic: 'Semantic: Matches concepts and meaning using vector similarity.',
} as const;
