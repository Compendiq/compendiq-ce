/**
 * The pure href grammar of Confluence links (#1748, #1955): one implementation
 * for the backend converter and both editor schemas.
 */
import { describe, it, expect } from 'vitest';
import {
  buildConfluenceLinkHref,
  CONFLUENCE_EMPTY_LINK_LABEL,
  CONFLUENCE_LINK_HREF_PREFIX,
  CONFLUENCE_LINK_KINDS,
  CONFLUENCE_LINK_KINDS_1748,
  CONFLUENCE_LINK_LIMITS,
  CONFLUENCE_LINK_PRIMARY_ATTR,
  confluenceLinkDisplayText,
  encodeConfluenceLinkValue,
  isConfluenceUrlClassCarrierFor,
  isNavigableConfluenceUrl,
  parseConfluenceLinkHref,
  type ConfluenceLinkAttr,
  type ConfluenceLinkKind,
  type ConfluenceLinkTarget,
} from './confluence-link-grammar.js';

function target(kind: ConfluenceLinkKind, value: string, over: Partial<ConfluenceLinkTarget> = {}): ConfluenceLinkTarget {
  return { kind, value, link: [], resource: [], container: null, body: null, legacy: false, ...over };
}

function carrierOf(value: string, over: Partial<ConfluenceLinkTarget> = {}): string {
  return buildConfluenceLinkHref(target('url', value, over), []);
}

describe('confluence-link-grammar: kinds, prefixes and primaries (#1955)', () => {
  it('names eight kinds, each with a `#`-prefixed href prefix that is no prefix of another', () => {
    expect([...CONFLUENCE_LINK_KINDS]).toEqual([
      'page', 'attachment', 'anchor', 'blog-post', 'space', 'shortcut', 'content-entity', 'url',
    ]);
    expect(CONFLUENCE_LINK_HREF_PREFIX).toEqual({
      page: '#confluence-page:',
      attachment: '#confluence-attachment:',
      anchor: '#confluence-anchor:',
      'blog-post': '#confluence-blog-post:',
      space: '#confluence-space:',
      shortcut: '#confluence-shortcut:',
      'content-entity': '#confluence-content-entity:',
      url: '#confluence-url:',
    });
    const prefixes = Object.values(CONFLUENCE_LINK_HREF_PREFIX);
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a !== b) expect(b.startsWith(a)).toBe(false);
      }
    }
  });

  it('keeps the primary attribute the maintainer decision names for each kind', () => {
    expect(CONFLUENCE_LINK_PRIMARY_ATTR).toEqual({
      page: 'ri:content-title',
      attachment: 'ri:filename',
      anchor: 'ac:anchor',
      'blog-post': 'ri:content-title',
      space: 'ri:space-key',
      shortcut: 'ri:key',
      'content-entity': 'ri:content-id',
      url: 'ri:value',
    });
  });
});

describe('confluence-link-grammar: build and parse', () => {
  it.each<[ConfluenceLinkKind, string, Partial<ConfluenceLinkTarget>, string]>([
    ['page', 'Runbook', { resource: [['ri:space-key', 'OPS']] }, '#confluence-page:Runbook?ri:space-key=OPS'],
    ['anchor', 'Restore', { body: 'plain' }, '#confluence-anchor:Restore?body=plain'],
    [
      'blog-post', 'Q3 Update',
      { link: [['ac:card-appearance', 'inline']], resource: [['ri:posting-day', '2024/05/01'], ['ri:space-key', 'ENG']], body: 'plain' },
      '#confluence-blog-post:Q3%20Update?ac:card-appearance=inline&ri:posting-day=2024%2F05%2F01&ri:space-key=ENG&body=plain',
    ],
    ['space', 'OPS', {}, '#confluence-space:OPS'],
    ['shortcut', 'jira', { resource: [['ri:parameter', 'ABC-1']] }, '#confluence-shortcut:jira?ri:parameter=ABC-1'],
    ['content-entity', '12345', { body: 'rich' }, '#confluence-content-entity:12345?body=rich'],
    ['url', 'javascript:alert(1)', {}, '#confluence-url:javascript%3Aalert%281%29'],
    ['url', '', {}, '#confluence-url:'],
  ])('writes and reads a %s link', (kind, value, over, href) => {
    const link = target(kind, value, over);
    expect(buildConfluenceLinkHref(link, [])).toBe(href);
    expect(parseConfluenceLinkHref(href)).toEqual(link);
  });

  it('reads an href written before #1748 as the legacy shape for a page and an attachment only', () => {
    expect(parseConfluenceLinkHref('#confluence-page:A & B')).toEqual(target('page', 'A & B', { legacy: true }));
    expect(parseConfluenceLinkHref('#confluence-attachment:report 2024.pdf'))
      .toEqual(target('attachment', 'report 2024.pdf', { legacy: true }));
    for (const kind of ['anchor', 'blog-post', 'space', 'shortcut', 'content-entity', 'url'] as const) {
      expect(parseConfluenceLinkHref(`${CONFLUENCE_LINK_HREF_PREFIX[kind]}A B`)).toBeNull();
    }
  });

  it('restricts the kinds it reads to the ones the caller names', () => {
    expect(parseConfluenceLinkHref('#confluence-space:OPS', { kinds: CONFLUENCE_LINK_KINDS_1748 })).toBeNull();
    expect(parseConfluenceLinkHref('#confluence-url:x', { kinds: CONFLUENCE_LINK_KINDS_1748 })).toBeNull();
    expect(parseConfluenceLinkHref('#confluence-page:Runbook', { kinds: CONFLUENCE_LINK_KINDS_1748 }))
      .toEqual(target('page', 'Runbook'));
    expect(parseConfluenceLinkHref('#confluence-page:Runbook', { kinds: ['url'] })).toBeNull();
  });

  it.each([
    ['a container on a kind other than attachment', '#confluence-blog-post:X?page.ri:space-key=ENG'],
    ['a ri:* parameter on an anchor', '#confluence-anchor:X?ri:space-key=ENG'],
    ['a repeated parameter', '#confluence-space:X?ac:anchor=a&ac:anchor=b'],
    ['the primary attribute as a parameter', '#confluence-shortcut:X?ri:key=y'],
    ['an unknown parameter', '#confluence-url:X?title=y'],
    ['a body other than plain or rich', '#confluence-url:X?body=none'],
    ['an escape that does not decode', '#confluence-url:%E0%A4'],
    ['a value XML cannot hold', '#confluence-url:%01'],
    ['more than 16 attributes of one element', `#confluence-shortcut:X?${Array.from({ length: 17 }, (_, i) => `ri:p${i}=v`).join('&')}`],
    ['an href over 16,384 characters', `#confluence-url:${'a'.repeat(16_384)}`],
    ['a value over 1,024 characters', `#confluence-url:${'a'.repeat(1025)}`],
  ])('reads %s as no link', (_name, href) => {
    expect(parseConfluenceLinkHref(href)).toBeNull();
  });

  it('percent-encodes down to the RFC 3986 unreserved set', () => {
    expect(encodeConfluenceLinkValue("a b/c?d=e&f#g%h(i)!*'~._-")).toBe('a%20b%2Fc%3Fd%3De%26f%23g%25h%28i%29%21%2A%27~._-');
    expect(encodeConfluenceLinkValue('日本')).toBe('%E6%97%A5%E6%9C%AC');
  });

  it('drops an optional attribute that would take the href past 16,384 characters, and names it', () => {
    const big = '日'.repeat(1024); // 9,216 characters encoded
    const dropped: string[] = [];
    const href = buildConfluenceLinkHref(
      target('page', 'T', { link: [['ac:a', big], ['ac:b', big], ['ac:c', 'small']] }),
      dropped,
    );
    expect(href.length).toBeLessThanOrEqual(CONFLUENCE_LINK_LIMITS.href);
    expect(dropped).toEqual(['ac:b']);
    expect(parseConfluenceLinkHref(href)?.link.map(([name]) => name)).toEqual(['ac:a', 'ac:c']);
  });

  it('writes the body hint last for a #1748 kind and lets it be the parameter that does not fit, as before #1955', () => {
    const filler = Array.from({ length: 15 }, (_, i): ConfluenceLinkAttr => [`ac:f${i}`, 'x'.repeat(1024)]);
    const before = buildConfluenceLinkHref(target('page', 'T', { link: filler }), []);
    // One more attribute that ends five characters under the cap: `&body=plain` cannot follow it.
    const last: ConfluenceLinkAttr = ['ac:z', 'y'.repeat(CONFLUENCE_LINK_LIMITS.href - 5 - before.length - '&ac:z='.length)];
    const dropped: string[] = [];
    const href = buildConfluenceLinkHref(target('page', 'T', { link: [...filler, last], body: 'plain' }), dropped);
    expect(href.length).toBe(CONFLUENCE_LINK_LIMITS.href - 5);
    expect(dropped).toEqual(['body']);
    // The same attributes on a #1955 kind keep the hint and give up the attribute instead.
    const droppedNew: string[] = [];
    const hrefNew = buildConfluenceLinkHref(target('space', 'T', { link: [...filler, last], body: 'plain' }), droppedNew);
    expect(hrefNew.endsWith('&body=plain')).toBe(true);
    expect(droppedNew).toEqual(['ac:z']);
  });

  it('reserves the body hint of a #1955 kind before the optional attributes (W5)', () => {
    const filler = Array.from({ length: 16 }, (_, i): ConfluenceLinkAttr => [`ac:f${i}`, 'x'.repeat(1024)]);
    for (const body of ['plain', 'rich'] as const) {
      const dropped: string[] = [];
      const href = buildConfluenceLinkHref(target('blog-post', 'T', { link: filler, body }), dropped);
      expect(href.length).toBeLessThanOrEqual(CONFLUENCE_LINK_LIMITS.href);
      expect(href.endsWith(`&body=${body}`)).toBe(true);
      expect(dropped).not.toContain('body');
      expect(dropped.length).toBeGreaterThan(0);
      expect(parseConfluenceLinkHref(href)?.body).toBe(body);
    }
  });

  it('always fits the primary value and the body hint of a #1955 kind, even at the largest encoded value', () => {
    const value = '日'.repeat(CONFLUENCE_LINK_LIMITS.value);
    const href = buildConfluenceLinkHref(target('content-entity', value, { body: 'rich' }), []);
    expect(parseConfluenceLinkHref(href)).toEqual(target('content-entity', value, { body: 'rich' }));
  });
});

describe('confluence-link-grammar: display text of a body-less link (#1955)', () => {
  it('shows a page, attachment or anchor value as written', () => {
    expect(confluenceLinkDisplayText({ kind: 'page', value: ' A  B ' })).toBe(' A  B ');
    expect(confluenceLinkDisplayText({ kind: 'anchor', value: '' })).toBe('');
  });

  it.each([
    ['Q3 x', 'Q3 x'],
    [' Q3 ', 'Q3'],
    ['Q3  x', 'Q3 x'],
    ['Q3\tx', 'Q3 x'],
    ['Q3\u00a0\nx', 'Q3 x'],
    ['', CONFLUENCE_EMPTY_LINK_LABEL],
    [' ', CONFLUENCE_EMPTY_LINK_LABEL],
    ['\t', CONFLUENCE_EMPTY_LINK_LABEL],
    ['\n', CONFLUENCE_EMPTY_LINK_LABEL],
    ['\u00a0', CONFLUENCE_EMPTY_LINK_LABEL],
  ])('shows %j of a #1955 kind as %j', (value, text) => {
    for (const kind of ['blog-post', 'space', 'shortcut', 'content-entity', 'url'] as const) {
      expect(confluenceLinkDisplayText({ kind, value })).toBe(text);
    }
    expect(CONFLUENCE_EMPTY_LINK_LABEL).toBe('(empty link)');
  });
});

describe('confluence-link-grammar: which ri:url values are navigable (#1955)', () => {
  it.each([
    'http://example.com/',
    'https://example.com/a?b=1&c=2#frag',
    'https://example.com/"quoted"<b>&amp;',
    'https:',
    'mailto:a@b.c',
    'mailto:?to=a@b.c&subject=Hi%20there',
    'https://example.com/CQ_MEDIA_PLACEHOLDER_0',
  ])('%j is a real href', (value) => {
    expect(isNavigableConfluenceUrl(value)).toBe(true);
  });

  it.each([
    ['another case', 'HTTPS://example.com/'],
    ['another case', 'Https://example.com/'],
    ['another case', 'MAILTO:a@b.c'],
    ['javascript', 'javascript:alert(1)'],
    ['javascript, mixed case', 'JavaScript:alert(1)'],
    ['javascript, upper case', 'JAVASCRIPT:alert(1)'],
    ['a tab inside the scheme', 'java\tscript:alert(1)'],
    ['a line feed inside the scheme', 'java\nscript:alert(1)'],
    ['a leading space', ' javascript:alert(1)'],
    ['a leading space before an allowed scheme', ' https://example.com/'],
    ['a trailing space', 'https://example.com/ '],
    ['an embedded space', 'https://example.com/a b'],
    ['a tab after the scheme', 'https:\t//example.com/'],
    ['a carriage return', 'https://example.com/\r'],
    ['a no-break space', 'https://example.com/\u00a0'],
    ['a line separator', 'https://example.com/\u2028'],
    ['an ideographic space', 'https://example.com/\u3000'],
    ['a C1 control', 'https://example.com/\u0085'],
    ['DEL', 'https://example.com/\u007f'],
    ['a zero-width space', 'https://exa\u200bmple.com/'],
    ['a right-to-left override', 'https://example.com/\u202Egnp.exe'],
    ['a byte-order mark', '\uFEFFhttps://example.com/'],
    ['a soft hyphen', 'https://exam\u00adple.com/'],
    ['data', 'data:text/html;base64,PHNjcmlwdD4='],
    ['vbscript', 'vbscript:msgbox(1)'],
    ['file', 'file:///etc/passwd'],
    ['ftp', 'ftp://example.com/'],
    ['tel', 'tel:+123'],
    ['protocol-relative', '//evil.example/'],
    ['an absolute path', '/relative'],
    ['a relative path', 'relative.html'],
    ['a query', '?q=1'],
    ['a fragment', '#frag'],
    ['empty', ''],
    ['a scheme only by an entity left undecoded', '&#x6A;avascript:alert(1)'],
    ['over 1,024 characters', `https://example.com/${'a'.repeat(1024)}`],
    ['a character XML forbids', 'https://example.com/\u0001'],
  ])('%s is not: %j', (_name, value) => {
    expect(isNavigableConfluenceUrl(value)).toBe(false);
  });
});

describe('confluence-link-grammar: the class carrier of a navigable ri:url (#1955)', () => {
  const href = 'https://example.com/a?b=1&c=2';

  it('admits the canonical carrier of the same URL, with or without parameters', () => {
    expect(isConfluenceUrlClassCarrierFor(href, carrierOf(href))).toBe(true);
    expect(isConfluenceUrlClassCarrierFor(href, carrierOf(href, { body: 'plain' }))).toBe(true);
    expect(isConfluenceUrlClassCarrierFor(
      href,
      carrierOf(href, { link: [['ac:card-appearance', 'inline']], resource: [['ri:x', 'y z']], body: 'rich' }),
    )).toBe(true);
    expect(isConfluenceUrlClassCarrierFor('mailto:a@b.c', carrierOf('mailto:a@b.c'))).toBe(true);
  });

  it.each([
    ['the prefix alone', href, '#confluence-url:'],
    ['a carrier of another URL', href, carrierOf('https://example.com/other')],
    ['a carrier that differs in case', href, carrierOf('https://EXAMPLE.com/a?b=1&c=2')],
    ['a legacy-shaped value', href, `#confluence-url:${href}`],
    ['an href that is not navigable', 'javascript:alert(1)', carrierOf('javascript:alert(1)')],
    ['a relative href', '/a', carrierOf('/a')],
    ['an empty href', '', carrierOf('')],
    ['two class tokens', href, `${carrierOf(href)} other`],
    ['a leading class token', href, `other ${carrierOf(href)}`],
    ['white space inside', href, carrierOf(href).replace('%3A', '%3A\t')],
    ['a line feed at the end', href, `${carrierOf(href)}\n`],
    ['an unknown parameter', href, `${carrierOf(href)}?title=x`],
    ['a repeated parameter', href, `${carrierOf(href)}?body=plain&body=plain`],
    ['a container parameter', href, `${carrierOf(href)}?page.ri:space-key=ENG`],
    ['another kind', href, `#confluence-page:${encodeConfluenceLinkValue(href)}`],
    ['a blog-post carrier', href, `#confluence-blog-post:${encodeConfluenceLinkValue(href)}`],
    ['more than 16 attributes', href, `${carrierOf(href)}?${Array.from({ length: 17 }, (_, i) => `ac:p${i}=v`).join('&')}`],
    ['an escape that does not decode', href, '#confluence-url:https%3A%2F%2Fexample.com%2F%E0%A4'],
    ['a value XML cannot hold', 'https://example.com/\u0001', '#confluence-url:https%3A%2F%2Fexample.com%2F%01'],
    ['no class', href, ''],
  ])('refuses %s', (_name, link, className) => {
    expect(isConfluenceUrlClassCarrierFor(link, className)).toBe(false);
  });

  it('refuses a class over 16,384 characters and admits the longest one that fits', () => {
    const long = `https://example.com/${'a'.repeat(1000)}`;
    const params = (count: number): ConfluenceLinkAttr[] =>
      Array.from({ length: count }, (_, i): ConfluenceLinkAttr => [`ac:p${i}`, 'x'.repeat(1024)]);
    const fits = buildConfluenceLinkHref(target('url', long, { link: params(14) }), []);
    expect(fits.length).toBeLessThanOrEqual(CONFLUENCE_LINK_LIMITS.href);
    expect(isConfluenceUrlClassCarrierFor(long, fits)).toBe(true);
    const over = `${fits}&ac:z=${'y'.repeat(CONFLUENCE_LINK_LIMITS.href)}`;
    expect(isConfluenceUrlClassCarrierFor(long, over)).toBe(false);
  });
});
