/**
 * #1955 (reviews r3 V7, r4a W6): restoreMedia replaces a media token only where
 * it stands as content. The HTML tokenizer says where that is, so restoring
 * media can never rewrite an attribute (a link's href or class), a comment or
 * raw text; and every placement says which element it stands in, so a caller
 * can refuse more of them without reading the HTML a second way.
 */
import { describe, it, expect } from 'vitest';
import {
  locateMediaTokens,
  restoreMedia,
  type MediaTokenContext,
  type MediaTokenPlacement,
} from './content-converter.js';

const T = 'CQ_MEDIA_PLACEHOLDER_0';
const T1 = 'CQ_MEDIA_PLACEHOLDER_1';
const ESCAPED = 'CQ\\_MEDIA\\_PLACEHOLDER\\_0';
const IMG = '<img src="/api/attachments/1/a.png">';
const DRAWIO = '<div class="confluence-drawio" data-diagram-name="d"></div>';
const media = [{ token: T, html: IMG }, { token: T1, html: DRAWIO }];

/** The element chain of a placement, innermost first: `tag` or `tag.class`. */
function chain(placement: MediaTokenPlacement): string[] {
  const out: string[] = [];
  for (let context: MediaTokenContext | null = placement.context; context; context = context.parent) {
    const className = context.attributes.find((attribute) => attribute.name === 'class')?.value;
    out.push(className ? `${context.tagName}.${className}` : context.tagName);
  }
  return out;
}

describe('content-converter: #1955 media tokens are replaced only where they stand as content', () => {
  it('replaces a token in text, a token alone in a paragraph with its paragraph, and the escaped spelling', () => {
    expect(restoreMedia(`<p>a ${T} b</p>\n<p>${T1}</p>\n<p> ${ESCAPED} </p>`, media))
      .toBe(`<p>a ${IMG} b</p>\n${DRAWIO}\n${IMG}`);
    expect(restoreMedia(`<p>CQ_MEDIA_PLACEHOLDER_10 ${T}, ${T}.</p>`, media)).toBe(`<p>CQ_MEDIA_PLACEHOLDER_10 ${IMG}, ${IMG}.</p>`);
    expect(restoreMedia(`<p class="x">${T}</p><p>${T} ${T1}</p>`, media)).toBe(`<p class="x">${IMG}</p><p>${IMG} ${DRAWIO}</p>`);
    expect(restoreMedia('<p>no token</p>', media)).toBe('<p>no token</p>');
    expect(restoreMedia(`<p>${T}</p>`, [])).toBe(`<p>${T}</p>`);
  });

  it('injects an original verbatim and never scans it again', () => {
    const entries = [
      { token: T, html: `<img alt="${T1} $& $1 $$" src="/a?x=$'">` },
      { token: T1, html: '<i>second</i>' },
    ];
    expect(restoreMedia(`<p>${T}</p><p>${T1}</p>`, entries)).toBe(`<img alt="${T1} $& $1 $$" src="/a?x=$'"><i>second</i>`);
  });

  it.each([
    ['a link\'s href and class', `<p><a href="https://e.com/${T}" class="#confluence-url:https%3A%2F%2Fe.com%2F${T}">t</a> ${T}</p>`,
      `<p><a href="https://e.com/${T}" class="#confluence-url:https%3A%2F%2Fe.com%2F${T}">t</a> ${IMG}</p>`],
    ['a comment holding `>` before a real link', `<!-- a > b ${T} --><p><a href="https://e.com/${T}">t</a> ${T}</p>`,
      `<!-- a > b ${T} --><p><a href="https://e.com/${T}">t</a> ${IMG}</p>`],
    ['a comment with an unmatched quote before a real link', `<!-- it's "${T} --><p><a href="https://e.com/${T}">t</a> ${T}</p>`,
      `<!-- it's "${T} --><p><a href="https://e.com/${T}">t</a> ${IMG}</p>`],
    ['a quoted attribute holding the wrapped spelling', `<p><a href="https://e.com/" title="<p>${T}</p>">t</a></p><p>${T}</p>`,
      `<p><a href="https://e.com/" title="<p>${T}</p>">t</a></p>${IMG}`],
    ['an unquoted and a single-quoted attribute', `<p><a href=https://e.com/${T} title='${T} > x'>t</a>${T}</p>`,
      `<p><a href=https://e.com/${T} title='${T} > x'>t</a>${IMG}</p>`],
    ['an attribute holding `>` before the token', `<p><a title="a > b" href="x">t</a>${T}</p>`, `<p><a title="a > b" href="x">t</a>${IMG}</p>`],
    ['raw text and RCDATA', `<style>${T}</style><textarea>${T}</textarea><script>${T}</script><title>${T}</title><p>${T}</p>`,
      `<style>${T}</style><textarea>${T}</textarea><script>${T}</script><title>${T}</title>${IMG}`],
    ['bogus comments and a tag name', `<p><!${T}></p><p><?${T}?></p><p></${T}></p><${T}>x</${T}><p>y ${T}</p>`,
      `<p><!${T}></p><p><?${T}?></p><p></${T}></p><${T}>x</${T}><p>y ${IMG}</p>`],
    ['an attribute name', `<p ${T}="1" data-${T}>x ${T}</p>`, `<p ${T}="1" data-${T}>x ${IMG}</p>`],
    ['an unterminated tag at the end', `<p>${T}</p><a href="${T}`, `${IMG}<a href="${T}`],
  ])('leaves the spelling in %s as written and replaces the content token', (_name, html, expected) => {
    expect(restoreMedia(html, media)).toBe(expected);
  });

  it('takes text the tree builder moved or joined across markup for no placement (W6)', () => {
    // Text directly inside a table is foster-parented before it; two such runs are joined into one node.
    const table = `<table>${T}<tr><td title="${T}">x</td></tr>${T}</table>`;
    expect(locateMediaTokens(table, media)).toEqual([]);
    expect(restoreMedia(table, media)).toBe(table);
    // A single foster-parented run, and text after a stray end tag joined to the text before it.
    expect(restoreMedia(`<table>${T}<tr><td>x</td></tr></table>`, media)).toBe(`<table>${T}<tr><td>x</td></tr></table>`);
    expect(restoreMedia(`x</p>${T}<p>y</p>`, media)).toBe(`x</p>${T}<p>y</p>`);
    // The cell's own text is content.
    expect(restoreMedia(`<table><tr><td>${T}</td></tr></table>`, media)).toBe(`<table><tr><td>${IMG}</td></tr></table>`);
  });

  // Review r1, R7: the tree builder moves a whole element out of a table, not only bare text. Its place in
  // the tree (before the table, under no ancestor) is not where its source stands (inside the table).
  it('takes an element the tree builder moved out of a table for no placement, with everything in it (R7)', () => {
    const html = `<table class="generated"><div><p>${T}</p><span>a ${T1} b</span></div><tr><td>${T1}</td></tr></table>`;
    // Only the ordinary cell: its chain is the one its source stands in.
    expect(locateMediaTokens(html, media).map((placement) => [placement.token, chain(placement)]))
      .toEqual([[T1, ['td', 'tr', 'tbody', 'table.generated']]]);
    expect(restoreMedia(html, media))
      .toBe(`<table class="generated"><div><p>${T}</p><span>a ${T1} b</span></div><tr><td>${DRAWIO}</td></tr></table>`);
    // A caller that refuses everything in the marked container replaces nothing inside the table.
    const outsideGenerated = (placement: MediaTokenPlacement): boolean => !chain(placement).includes('table.generated');
    expect(restoreMedia(html, media, { accept: outsideGenerated })).toBe(html);
    // Several moved elements, and one nested in a row group.
    expect(locateMediaTokens(`<table><p>${T}</p><div>${T1}</div><tbody><section>${T}</section><tr><td>x</td></tr></tbody></table>`, media)).toEqual([]);
  });

  it('takes misnested formatting, which the tree builder rebuilds, for no placement (R7)', () => {
    expect(locateMediaTokens(`<p><b><i>x</b>${T}</i></p>`, media)).toEqual([]);
    expect(locateMediaTokens(`<b><p>${T}</b>y</p>`, media)).toEqual([]);
  });

  it('still places a token in elements the string never closes, and in cells whose end tags are left out', () => {
    expect(locateMediaTokens(`<ul><li>${T}<li>b`, media).map(chain)).toEqual([['li', 'ul']]);
    expect(locateMediaTokens(`<p>a</p><div>${T1}`, media).map(chain)).toEqual([['div']]);
    expect(locateMediaTokens(`<table><tr><td>a<td>${T}</table>`, media).map(chain)).toEqual([['td', 'tr', 'tbody', 'table']]);
    expect(locateMediaTokens(`<table><tr><td>${T}</td></tr></table><template><p>x ${T1}</p></template>`, media).map(chain))
      .toEqual([['td', 'tr', 'tbody', 'table'], ['p', 'template']]);
  });

  it('reports each placement by its range of the original string, in source order, never overlapping (W6)', () => {
    const html = `<p>a &amp; ${T} &lt;</p>\r\n<p> ${ESCAPED}\n</p><div>${T1}${T}</div>`;
    const placements = locateMediaTokens(html, media);
    expect(placements.map((placement) => [html.slice(placement.start, placement.end), placement.token, placement.wrapped])).toEqual([
      [T, T, false],
      [`<p> ${ESCAPED}\n</p>`, T, true],
      [T1, T1, false],
      [T, T, false],
    ]);
    for (let index = 1; index < placements.length; index += 1) {
      expect(placements[index]!.start).toBeGreaterThanOrEqual(placements[index - 1]!.end);
    }
    expect(locateMediaTokens('<p>none</p>', media)).toEqual([]);
    expect(locateMediaTokens(html, [])).toEqual([]);
  });

  it('says which element each placement stands in, with its attributes and ancestors (W6)', () => {
    const html = `<div class="figure-index"><p>${T}</p></div><div><p>${T}</p></div><template><p>x ${T}</p></template>`
      + `<pre><code class="language-js">${T}</code></pre><p><a href="#confluence-page:A">see ${T}</a></p>`
      + `<p><a href="#confluence-page:A">${T}</a></p>`;
    const placements = locateMediaTokens(html, media);
    expect(placements.map(chain)).toEqual([
      ['div.figure-index'],
      ['div'],
      ['p', 'template'],
      ['code.language-js', 'pre'],
      ['a', 'p'],
      ['a', 'p'],
    ]);
    // The same tag with another class is another context; a context knows its own range.
    const [index, plain] = placements;
    expect(html.slice(index!.context!.start!, index!.context!.end!)).toBe(`<div class="figure-index"><p>${T}</p></div>`);
    expect(html.slice(plain!.context!.start!, plain!.context!.end!)).toBe(`<div><p>${T}</p></div>`);
    // Siblings share one context object: no list is copied per placement.
    const both = locateMediaTokens(`<section><p>a ${T} b ${T1}</p></section>`, media);
    expect(both[0]!.context).toBe(both[1]!.context);
    expect(both[0]!.context!.parent!.tagName).toBe('section');
  });

  it('lets a caller refuse placements by their context: a code sample, a generated index, a template, a link label', () => {
    const html = `<div class="figure-index"><p>${T}</p></div><div><p>${T}</p></div><template><p>${T}</p></template>`
      + `<pre><code>${T}</code></pre><p><a href="#confluence-page:A">label ${T}</a> and ${T1}</p>`;
    const inside = (placement: MediaTokenPlacement, test: (context: MediaTokenContext) => boolean): boolean => {
      for (let context = placement.context; context; context = context.parent) {
        if (test(context)) return true;
      }
      return false;
    };
    const protectedContext = (context: MediaTokenContext): boolean =>
      context.tagName === 'pre' || context.tagName === 'template' || context.tagName === 'a'
      || context.attributes.some((attribute) => attribute.name === 'class' && attribute.value === 'figure-index');
    expect(restoreMedia(html, media, { accept: (placement) => !inside(placement, protectedContext) })).toBe(
      `<div class="figure-index"><p>${T}</p></div><div>${IMG}</div><template><p>${T}</p></template>`
      + `<pre><code>${T}</code></pre><p><a href="#confluence-page:A">label ${T}</a> and ${DRAWIO}</p>`,
    );
    // The default takes every placement: what a token in text did before #1955.
    expect(restoreMedia(html, media)).toBe(
      `<div class="figure-index">${IMG}</div><div>${IMG}</div><template>${IMG}</template>`
      + `<pre><code>${IMG}</code></pre><p><a href="#confluence-page:A">label ${IMG}</a> and ${DRAWIO}</p>`,
    );
  });

  it('visits a wide and a deep document once: placements grow with the tokens, not with the depth', () => {
    const deep = `${'<div>'.repeat(300)}<p>x ${T}</p>${'</div>'.repeat(300)}`;
    const [placement] = locateMediaTokens(deep, media);
    expect(chain(placement!)).toHaveLength(301);
    const wide = Array.from({ length: 2_000 }, () => `<p>w ${T}</p>`).join('');
    const placements = locateMediaTokens(wide, media);
    expect(placements).toHaveLength(2_000);
    expect(restoreMedia(wide, media)).toBe(Array.from({ length: 2_000 }, () => `<p>w ${IMG}</p>`).join(''));
  });
});
