import { describe, it, expect } from 'vitest';
import { resolveSourceTarget } from './source-target';
import type { Source } from './SourceCitations';

function source(partial: Partial<Source>): Source {
  return { pageTitle: 'T', spaceKey: 'DOCS', confluenceId: null, ...partial };
}

describe('resolveSourceTarget', () => {
  it('routes a knowledge-base hit by its internal page id', () => {
    expect(resolveSourceTarget(source({ pageId: 42, confluenceId: 'page-abc' })))
      .toEqual({ kind: 'internal', path: '/pages/42' });
  });

  it('routes a locally-created page (null confluenceId) by page id', () => {
    // #1125: standalone pages are inserted with confluence_id NULL, so the old
    // `/pages/${confluenceId}` target resolved to the literal '/pages/null'.
    expect(resolveSourceTarget(source({ pageId: 7, confluenceId: null })))
      .toEqual({ kind: 'internal', path: '/pages/7' });
  });

  it('opens a web source as an external link, never as a page route', () => {
    expect(resolveSourceTarget(source({
      pageTitle: 'Linux',
      spaceKey: 'Web',
      pageId: 0,
      confluenceId: 'https://en.wikipedia.org/wiki/Linux',
      url: 'https://en.wikipedia.org/wiki/Linux',
    }))).toEqual({ kind: 'external', url: 'https://en.wikipedia.org/wiki/Linux' });
  });

  it('recognises a URL stuffed into confluenceId (persisted pre-fix conversations)', () => {
    expect(resolveSourceTarget(source({
      spaceKey: 'Web',
      confluenceId: 'http://example.com/docs',
    }))).toEqual({ kind: 'external', url: 'http://example.com/docs' });
  });

  it('prefers the explicit url over any other field', () => {
    expect(resolveSourceTarget(source({
      pageId: 5,
      confluenceId: 'page-abc',
      url: 'https://example.com/a',
    }))).toEqual({ kind: 'external', url: 'https://example.com/a' });
  });

  it('falls back to confluenceId when pageId is absent (legacy stored sources)', () => {
    expect(resolveSourceTarget(source({ confluenceId: 'page-123' })))
      .toEqual({ kind: 'internal', path: '/pages/page-123' });
  });

  it('percent-encodes a confluenceId fallback so it stays one path segment', () => {
    expect(resolveSourceTarget(source({ confluenceId: 'a b/c' })))
      .toEqual({ kind: 'internal', path: '/pages/a%20b%2Fc' });
  });

  it('ignores a zero or negative pageId', () => {
    expect(resolveSourceTarget(source({ pageId: 0, confluenceId: 'page-abc' })))
      .toEqual({ kind: 'internal', path: '/pages/page-abc' });
    expect(resolveSourceTarget(source({ pageId: -1, confluenceId: null })))
      .toEqual({ kind: 'none' });
  });

  it('has no target when neither a page id nor a confluence id is present', () => {
    expect(resolveSourceTarget(source({ confluenceId: null }))).toEqual({ kind: 'none' });
    expect(resolveSourceTarget(source({ confluenceId: '  ' }))).toEqual({ kind: 'none' });
  });

  it('refuses a non-http scheme rather than routing it into /pages/', () => {
    for (const hostile of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd']) {
      expect(resolveSourceTarget(source({ confluenceId: hostile }))).toEqual({ kind: 'none' });
      expect(resolveSourceTarget(source({ url: hostile, pageId: 3 }))).toEqual({ kind: 'none' });
    }
  });
});
