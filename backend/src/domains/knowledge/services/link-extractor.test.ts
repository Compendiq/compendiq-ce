import { describe, it, expect, afterEach } from 'vitest';
import { extractInternalLinks, getInternalHosts } from './link-extractor.js';

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

  // ── #359 absolute-URL matching against the configured deployment host ──

  it('matches absolute URLs whose host is in internalHosts', () => {
    const hosts = new Set(['kb.example.com']);
    const html = `<a href="https://kb.example.com/pages/123">x</a>`;
    expect(extractInternalLinks(html, new Map(), hosts)).toEqual([
      { targetPageId: 123 },
    ]);
  });

  it('rejects absolute URLs whose host is NOT in internalHosts (foreign host)', () => {
    const hosts = new Set(['kb.example.com']);
    const html = `<a href="https://other.example.com/pages/123">x</a>`;
    expect(extractInternalLinks(html, new Map(), hosts)).toEqual([]);
  });

  it('treats absolute URL host case-insensitively', () => {
    const hosts = new Set(['kb.example.com']);
    const html = `<a href="https://KB.Example.COM/pages/9">x</a>`;
    expect(extractInternalLinks(html, new Map(), hosts)).toEqual([
      { targetPageId: 9 },
    ]);
  });

  it('matches absolute URLs across multiple internal hosts (comma-separated FRONTEND_URL)', () => {
    const hosts = new Set(['kb.example.com', 'staging.example.com']);
    const html = `
      <a href="https://kb.example.com/pages/1">a</a>
      <a href="https://staging.example.com/pages/2">b</a>
    `;
    expect(extractInternalLinks(html, new Map(), hosts)).toEqual([
      { targetPageId: 1 },
      { targetPageId: 2 },
    ]);
  });

  it('rejects absolute URLs to internal host that do not point at /pages/:id', () => {
    const hosts = new Set(['kb.example.com']);
    const html = `<a href="https://kb.example.com/spaces/DEV">x</a>`;
    expect(extractInternalLinks(html, new Map(), hosts)).toEqual([]);
  });

  it('still rejects absolute URLs when internalHosts is empty (default)', () => {
    const html = `<a href="https://kb.example.com/pages/1">x</a>`;
    expect(extractInternalLinks(html, new Map())).toEqual([]);
  });

  it('dedupes a relative /pages/:id and an absolute internal URL to the same id', () => {
    const hosts = new Set(['kb.example.com']);
    const html = `
      <a href="/pages/42">rel</a>
      <a href="https://kb.example.com/pages/42">abs</a>
    `;
    expect(extractInternalLinks(html, new Map(), hosts)).toEqual([
      { targetPageId: 42 },
    ]);
  });
});

describe('getInternalHosts', () => {
  const originalFrontendUrl = process.env.FRONTEND_URL;

  afterEach(() => {
    if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalFrontendUrl;
  });

  it('returns empty set when FRONTEND_URL is unset', () => {
    delete process.env.FRONTEND_URL;
    expect(getInternalHosts().size).toBe(0);
  });

  it('parses single FRONTEND_URL into one lower-cased hostname', () => {
    process.env.FRONTEND_URL = 'https://Kb.Example.COM';
    expect(Array.from(getInternalHosts())).toEqual(['kb.example.com']);
  });

  it('parses comma-separated FRONTEND_URL into multiple hostnames', () => {
    process.env.FRONTEND_URL = 'https://kb.example.com, https://staging.example.com';
    const hosts = Array.from(getInternalHosts()).sort();
    expect(hosts).toEqual(['kb.example.com', 'staging.example.com']);
  });

  it('skips malformed entries silently', () => {
    process.env.FRONTEND_URL = 'not-a-url, https://kb.example.com';
    expect(Array.from(getInternalHosts())).toEqual(['kb.example.com']);
  });
});
