import { describe, it, expect } from 'vitest';
import { FIND_LABEL, FIND_PLACEHOLDER, LIBRARY_HEADING, SEARCH_MODE_DESCRIPTIONS, SEARCH_MODE_LABELS } from './pages-find';

describe('Library search copy', () => {
  it('names the local search surface clearly', () => {
    expect(FIND_LABEL).toBe('Search library pages');
    expect(FIND_PLACEHOLDER).toBe('Search your library');
  });

  it('names retrieval modes by their search strategy', () => {
    expect(SEARCH_MODE_LABELS.hybrid).toBe('Hybrid');
    expect(SEARCH_MODE_LABELS.keyword).toBe('Keyword');
    expect(SEARCH_MODE_LABELS.semantic).toBe('Semantic');
  });

  it('tells hybrid and semantic users that Space applies and advanced filters need Keyword', () => {
    expect(SEARCH_MODE_DESCRIPTIONS.hybrid).toMatch(/Space/);
    expect(SEARCH_MODE_DESCRIPTIONS.semantic).toMatch(/Space/);
    expect(SEARCH_MODE_DESCRIPTIONS.hybrid).toMatch(/Keyword/);
    expect(SEARCH_MODE_DESCRIPTIONS.semantic).toMatch(/Keyword/);
    expect(SEARCH_MODE_DESCRIPTIONS.hybrid).toMatch(/filter/i);
    expect(SEARCH_MODE_DESCRIPTIONS.semantic).toMatch(/filter/i);
  });

  it('titles the route as a library, not a corpus admin', () => {
    expect(LIBRARY_HEADING).toBe('Library');
  });
});
