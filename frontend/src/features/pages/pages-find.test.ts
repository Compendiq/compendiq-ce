import { describe, it, expect } from 'vitest';
import { FIND_LABEL, FIND_PLACEHOLDER, LIBRARY_HEADING, SEARCH_MODE_LABELS } from './pages-find';

describe('start-page Find copy', () => {
  it('does not share a verb with the header Find control', () => {
    expect(FIND_LABEL.startsWith('Find')).toBe(false);
    expect(FIND_PLACEHOLDER.startsWith('Find')).toBe(false);
    expect(FIND_LABEL).toBe('Filter this list');
    expect(FIND_PLACEHOLDER).toBe('Filter this list');
  });

  it('names retrieval modes in plain language', () => {
    expect(SEARCH_MODE_LABELS.hybrid).toBe('Best match');
    expect(SEARCH_MODE_LABELS.keyword).toBe('Exact words');
    expect(SEARCH_MODE_LABELS.semantic).toBe('Meaning only');
  });

  it('titles the route as a library, not a corpus admin', () => {
    expect(LIBRARY_HEADING).toBe('Library');
  });
});
