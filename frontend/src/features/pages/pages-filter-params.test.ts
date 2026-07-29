import { describe, it, expect } from 'vitest';
import {
  readFilterState,
  applyFilterPatch,
  hasAdvancedFilters,
  shouldAdoptUrlSearch,
  FILTER_DEFAULTS,
} from './pages-filter-params';

describe('readFilterState', () => {
  it('returns the defaults for an empty query string', () => {
    expect(readFilterState(new URLSearchParams())).toEqual(FILTER_DEFAULTS);
  });

  it('reads every filter the overview owns', () => {
    const state = readFilterState(
      new URLSearchParams(
        'space=DEV&search=runbook&author=Alice&labels=howto&freshness=stale' +
          '&embedding=pending&quality=poor&from=2025-01-01&to=2025-02-01' +
          '&source=confluence&sort=title&mode=hybrid&page=3',
      ),
    );

    expect(state).toEqual({
      space: 'DEV',
      search: 'runbook',
      author: 'Alice',
      labels: 'howto',
      freshness: 'stale',
      embedding: 'pending',
      quality: 'poor',
      from: '2025-01-01',
      to: '2025-02-01',
      source: 'confluence',
      sort: 'title',
      mode: 'hybrid',
      page: 3,
    });
  });

  // A hand-edited or stale link is ordinary input. An unrecognised enum handed
  // to a <select> renders as blank with no matching <option>, and handed to the
  // API is a 400 the user cannot act on.
  it.each([
    ['sort=bogus', 'sort', FILTER_DEFAULTS.sort],
    ['mode=telepathic', 'mode', FILTER_DEFAULTS.mode],
    ['source=carrier-pigeon', 'source', FILTER_DEFAULTS.source],
    ['freshness=ancient', 'freshness', FILTER_DEFAULTS.freshness],
    ['embedding=maybe', 'embedding', FILTER_DEFAULTS.embedding],
    ['quality=sublime', 'quality', FILTER_DEFAULTS.quality],
  ])('falls back to the default for %s', (queryString, key, expected) => {
    const state = readFilterState(new URLSearchParams(queryString));
    expect(state[key as keyof typeof state]).toBe(expected);
  });

  it.each(['page=0', 'page=-4', 'page=abc', 'page='])('clamps %s to page 1', (queryString) => {
    expect(readFilterState(new URLSearchParams(queryString)).page).toBe(1);
  });

  it('keeps a valid page number', () => {
    expect(readFilterState(new URLSearchParams('page=7')).page).toBe(7);
  });
});

describe('applyFilterPatch', () => {
  it('writes non-default values', () => {
    const next = applyFilterPatch(new URLSearchParams(), { author: 'Alice', page: 2 });
    expect(next.get('author')).toBe('Alice');
    expect(next.get('page')).toBe('2');
  });

  // Otherwise clearing a filter leaves `author=` behind and the "clean" URL of
  // an untouched overview grows a query string of empty strings.
  it('deletes a key that is patched back to its default', () => {
    const next = applyFilterPatch(new URLSearchParams('author=Alice&page=3'), {
      author: '',
      page: 1,
    });
    expect(next.has('author')).toBe(false);
    expect(next.has('page')).toBe(false);
    expect(next.toString()).toBe('');
  });

  it('leaves params it does not own alone', () => {
    const next = applyFilterPatch(new URLSearchParams('focus=42&author=Alice'), { author: 'Bob' });
    expect(next.get('focus')).toBe('42');
    expect(next.get('author')).toBe('Bob');
  });

  it('does not mutate the params it was given', () => {
    const original = new URLSearchParams('author=Alice');
    applyFilterPatch(original, { author: 'Bob' });
    expect(original.get('author')).toBe('Alice');
  });

  it('ignores undefined patch entries', () => {
    const next = applyFilterPatch(new URLSearchParams('author=Alice'), { author: undefined });
    expect(next.get('author')).toBe('Alice');
  });

  it('round-trips through readFilterState', () => {
    const next = applyFilterPatch(new URLSearchParams(), {
      space: 'DEV',
      sort: 'quality',
      mode: 'semantic',
      page: 4,
    });
    const state = readFilterState(next);
    expect(state.space).toBe('DEV');
    expect(state.sort).toBe('quality');
    expect(state.mode).toBe('semantic');
    expect(state.page).toBe(4);
  });
});

describe('hasAdvancedFilters', () => {
  it('is false for the defaults', () => {
    expect(hasAdvancedFilters(FILTER_DEFAULTS)).toBe(false);
  });

  it.each(['author=Alice', 'labels=howto', 'freshness=stale', 'embedding=done', 'quality=good', 'from=2025-01-01', 'to=2025-02-01', 'source=standalone'])(
    'is true for %s',
    (queryString) => {
      expect(hasAdvancedFilters(readFilterState(new URLSearchParams(queryString)))).toBe(true);
    },
  );

  // Space, search, sort, mode and page live outside the advanced panel — they
  // must not force it open.
  it.each(['space=DEV', 'search=runbook', 'sort=title', 'mode=hybrid', 'page=2'])(
    'is false for %s',
    (queryString) => {
      expect(hasAdvancedFilters(readFilterState(new URLSearchParams(queryString)))).toBe(false);
    },
  );
});

describe('shouldAdoptUrlSearch', () => {
  const base = { urlSearch: '', previousUrlSearch: '', boxValue: '', lastWritten: '' };

  it('adopts an external change — back/forward, or a link carrying ?search=', () => {
    expect(shouldAdoptUrlSearch({
      ...base, urlSearch: 'runbook', previousUrlSearch: '', boxValue: 'kube', lastWritten: 'kube',
    })).toBe(true);
  });

  // The race this exists for. The debounce writes "kub"; React Router commits
  // that inside a transition, so the commit can land after the user has typed
  // "x". Adopting "kub" there would delete that character from the box AND
  // from the URL, because the box is what the next debounce writes.
  it('ignores our own write arriving after the user typed another character', () => {
    expect(shouldAdoptUrlSearch({
      urlSearch: 'kub', previousUrlSearch: '', boxValue: 'kubx', lastWritten: 'kub',
    })).toBe(false);
  });

  it('does nothing when the URL has not moved', () => {
    expect(shouldAdoptUrlSearch({
      ...base, urlSearch: 'kube', previousUrlSearch: 'kube', boxValue: 'kubernetes',
    })).toBe(false);
  });

  it('does nothing when the box already holds the URL term', () => {
    expect(shouldAdoptUrlSearch({
      ...base, urlSearch: 'kube', previousUrlSearch: '', boxValue: 'kube',
    })).toBe(false);
  });

  // An external navigation back to a term we happen to have written before is
  // indistinguishable from our own write catching up, so it is treated as
  // ours. Costing at most one stale box until the next keystroke is the right
  // trade against dropping a character on every fast typist.
  it('treats a URL term equal to our last write as ours, even if the box differs', () => {
    expect(shouldAdoptUrlSearch({
      urlSearch: 'kub', previousUrlSearch: 'other', boxValue: 'something else', lastWritten: 'kub',
    })).toBe(false);
  });
});
