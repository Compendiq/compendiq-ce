import { describe, it, expect } from 'vitest';
import { extractInternalLinks } from './link-extractor.js';

describe('extractInternalLinks', () => {
  it('returns [] for empty/null html', () => {
    expect(extractInternalLinks(null, new Map())).toEqual([]);
    expect(extractInternalLinks(undefined, new Map())).toEqual([]);
    expect(extractInternalLinks('', new Map())).toEqual([]);
  });

  it('extracts /pages/:id app-route links', () => {
    const html = `<p>See <a href="/pages/42">our doc</a> and <a href="/pages/7/section#x">other</a>.</p>`;
    expect(extractInternalLinks(html, new Map())).toEqual([
      { targetPageId: 42 },
      { targetPageId: 7 },
    ]);
  });

  it('resolves #confluence-page:<title> to ids via the title map', () => {
    const html = `<a href="#confluence-page:Architecture">arch</a>`;
    const map = new Map([['Architecture', 12]]);
    expect(extractInternalLinks(html, map)).toEqual([{ targetPageId: 12 }]);
  });

  it('drops #confluence-page:<title> when title is unknown to the map', () => {
    const html = `<a href="#confluence-page:NoSuchTitle">x</a>`;
    expect(extractInternalLinks(html, new Map())).toEqual([]);
  });

  it('dedupes the same target referenced multiple times in one page', () => {
    const html = `<a href="/pages/5">a</a><a href="/pages/5">b</a>`;
    expect(extractInternalLinks(html, new Map())).toEqual([{ targetPageId: 5 }]);
  });

  it('ignores external URLs and non-page anchors', () => {
    const html = `
      <a href="https://example.com">external</a>
      <a href="mailto:x@y.z">mail</a>
      <a href="#anchor-only">anchor</a>
      <a href="/spaces/DEV">space</a>
    `;
    expect(extractInternalLinks(html, new Map())).toEqual([]);
  });

  it('ignores anchors without an href', () => {
    const html = `<a>no href</a>`;
    expect(extractInternalLinks(html, new Map())).toEqual([]);
  });

  it('handles malformed/garbled HTML without throwing', () => {
    const html = `<a href="/pages/3">ok</a><a href=`;
    expect(extractInternalLinks(html, new Map())).toEqual([{ targetPageId: 3 }]);
  });

  it('rejects /pages/:id when :id is non-numeric', () => {
    const html = `<a href="/pages/new">new page form</a>`;
    expect(extractInternalLinks(html, new Map())).toEqual([]);
  });
});
