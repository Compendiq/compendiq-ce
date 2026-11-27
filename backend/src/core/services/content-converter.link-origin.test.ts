/**
 * #1955 (decision D2, reviews r3 V1 and r4a W1–W3): the storage htmlToConfluence
 * returns is judged as the string it is. A `ri:url` link whose value is not a
 * navigable URL is in it only as an occurrence the stored page holds; anything
 * else is unwrapped in the document and the string is read again; a string
 * that would still carry one, or that holds such markup and cannot be read,
 * is refused. What is asserted about returned storage is asserted through an
 * independent XML reading of it (`__fixtures__/storage-oracle.ts`).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { confluenceToHtml, htmlToConfluence } from './content-converter.js';
import { JSDOM } from 'jsdom';
import { confluenceLinkAnchor, confluenceLinkCarrier, encodeConfluenceLinkValue } from './confluence-link.js';
import { ConfluenceStorageRefusedError, STORAGE_READER_LIMITS } from './confluence-storage-reader.js';
import { NO_STORAGE_DERIVATION_FEATURES } from './storage-derivation.js';
import { htmlToYDoc, yDocToHtml } from './collab-schema.js';
import { logger } from '../utils/logger.js';
import { oracleElements, oracleLocalNameCount, oracleReads, oracleUrlLinks } from './__fixtures__/storage-oracle.js';

/** A URL link as raw storage markup in HTML handed to the write-back (an API body, a frozen replay). */
function raw(value = '/relative/a', text = 'x'): string {
  return `<ac:link><ri:url ri:value="${value}"></ri:url><ac:plain-text-link-body>${text}</ac:plain-text-link-body></ac:link>`;
}
/** The same link as Confluence stores it. */
function stored(value = '/relative/a', text = 'x'): string {
  return `<ac:link><ri:url ri:value="${value}" /><ac:plain-text-link-body><![CDATA[${text}]]></ac:plain-text-link-body></ac:link>`;
}
/** The same link as write-back writes it. */
function written(value = '/relative/a', text = 'x'): string {
  return `<ac:link><ri:url ri:value="${value}"></ri:url><ac:plain-text-link-body><![CDATA[${text}]]></ac:plain-text-link-body></ac:link>`;
}
/** The same link as body_html carries it. */
function carrier(value = '/relative/a', text = 'x'): string {
  return `<a href="#confluence-url:${encodeConfluenceLinkValue(value)}?body=plain" data-confluence-link="url">${text}</a>`;
}
const FILLER = `<p>${'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. '.repeat(2)}</p>`;

function refusal(html: string, options: Parameters<typeof htmlToConfluence>[1] = {}): string {
  try {
    htmlToConfluence(html, options);
  } catch (error) {
    if (error instanceof ConfluenceStorageRefusedError) return error.reason;
    throw error;
  }
  return 'written';
}

/** The values of every non-navigable ri:url link the oracle finds in `storage`. */
function unsafeLinks(storage: string): Array<string | null> {
  return oracleUrlLinks(storage).map((link) => link.value).filter((value) => value === null || !/^(https?|mailto):/.test(value));
}

describe('content-converter: #1955 ri:url links are judged on the storage that is written', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('a link the document holds as an element', () => {
    it('keeps the stored link and writes a link with no stored origin as its text', () => {
      const html = `<p>a ${raw()} b</p>`;
      expect(htmlToConfluence(html, { previousStorage: `<p>a ${stored()} b</p>` })).toBe(`<p>a ${written()} b</p>`);
      expect(htmlToConfluence(html)).toBe('<p>a x b</p>');
      expect(htmlToConfluence(html, { previousStorage: '<p>a b</p>' })).toBe('<p>a x b</p>');
      expect(htmlToConfluence(`<p>a ${carrier()} b</p>`)).toBe('<p>a x b</p>');
    });

    it('gives the same answer to a carrier anchor and to raw link markup', () => {
      const origin = `<p>see ${stored('/relative/a', 'docs')} now</p>`;
      for (const link of [carrier('/relative/a', 'docs'), raw('/relative/a', 'docs')]) {
        expect(htmlToConfluence(`<p>see ${link} now</p>`, { previousStorage: origin })).toBe(`<p>see ${written('/relative/a', 'docs')} now</p>`);
        expect(htmlToConfluence(`<p>see ${link} now</p>${FILLER}<p>${link}</p>`, { previousStorage: `${origin}${FILLER}` }))
          .toBe(`<p>see ${written('/relative/a', 'docs')} now</p>${FILLER}<p>docs</p>`);
        expect(htmlToConfluence(`<p>see ${link} now</p>`, { previousStorage: '<p>see now</p>' })).toBe('<p>see docs now</p>');
      }
    });

    it('takes linkOrigin as the evidence when it is stated, and an explicit null as no evidence (W1)', () => {
      const html = `<p>a ${carrier()} b</p>`;
      const origin = `<p>a ${stored()} b</p>`;
      expect(htmlToConfluence(html, { linkOrigin: origin })).toBe(`<p>a ${written()} b</p>`);
      expect(htmlToConfluence(html, { previousStorage: '<p>other</p>', linkOrigin: origin })).toBe(`<p>a ${written()} b</p>`);
      // null is "no evidence", not "look at previousStorage instead".
      expect(htmlToConfluence(html, { previousStorage: origin, linkOrigin: null })).toBe('<p>a x b</p>');
      expect(htmlToConfluence(html, { previousStorage: origin, linkOrigin: undefined })).toBe(`<p>a ${written()} b</p>`);
    });

    it('unwraps only the link it declined, and keeps what that link held (W2)', () => {
      const image = '<img src="/api/attachments/1/x.png" data-confluence-filename="x.png">';
      const acImage = '<ac:image><ri:attachment ri:filename="x.png"></ri:attachment></ac:image>';
      const origin = `<p>see ${stored('/relative/a', 'kept')} now</p>${FILLER}`;
      // A rich body with markup and an image, a plain body, and a link without a body.
      const html = `<p>see ${carrier('/relative/a', 'kept')} now</p>${FILLER}`
        + `<p>q <a href="#confluence-url:%2Fother?body=rich">the <strong>doc</strong> ${image}</a> r</p>`
        + `<p>s ${carrier('/third', 'plain &amp; text')} t</p>`
        + '<p>u <a href="#confluence-url:%2Ffourth">/fourth</a> v</p>';
      const storage = htmlToConfluence(html, { previousStorage: origin });
      expect(storage).toBe(
        `<p>see ${written('/relative/a', 'kept')} now</p>${FILLER}`
        + `<p>q the <strong>doc</strong> ${acImage} r</p>`
        + '<p>s plain &amp; text t</p>'
        + '<p>u /fourth v</p>',
      );
      expect(oracleUrlLinks(storage)).toEqual([{ value: '/relative/a', link: {}, resource: {}, body: 'plain:kept', text: 'kept' }]);
    });

    it('among twins, unwraps the copy and keeps the link in the stored place (W2)', () => {
      const origin = `<p>one</p>${FILLER}<p>see ${stored()} now</p>${FILLER}<p>three</p>`;
      const twin = `<p>see ${carrier()} now</p>`;
      const copy = `<p>copy ${carrier()} here</p>`;
      // The copy before the original, and after it: the same link survives, by its place.
      expect(htmlToConfluence(`<p>one</p>${copy}${FILLER}${twin}${FILLER}<p>three</p>`, { previousStorage: origin }))
        .toBe(`<p>one</p><p>copy x here</p>${FILLER}<p>see ${written()} now</p>${FILLER}<p>three</p>`);
      expect(htmlToConfluence(`<p>one</p>${FILLER}${twin}${FILLER}${copy}<p>three</p>`, { previousStorage: origin }))
        .toBe(`<p>one</p>${FILLER}<p>see ${written()} now</p>${FILLER}<p>copy x here</p><p>three</p>`);
    });

    it('declines a link with a second resource or without a value, whatever is stored, and keeps its body', () => {
      const origin = `<p>q ${stored()} r</p>`;
      for (const markup of [
        '<ac:link><ri:url ri:value="/relative/a"></ri:url><ri:page ri:content-title="X"></ri:page><ac:plain-text-link-body>kept</ac:plain-text-link-body></ac:link>',
        '<ac:link><ri:url></ri:url><ac:plain-text-link-body>kept</ac:plain-text-link-body></ac:link>',
        '<ac:link><ri:attachment ri:filename="a.pdf"><ri:url ri:value="/relative/a"></ri:url></ri:attachment><ac:link-body>kept</ac:link-body></ac:link>',
      ]) {
        const storage = htmlToConfluence(`<p>q ${markup} r</p>`, { previousStorage: origin });
        expect(storage).toBe('<p>q kept r</p>');
        expect(oracleLocalNameCount(storage, 'url')).toBe(0);
      }
    });

    // Review r1, R3: without a body, what such a link shows (a title, a value) is not known here.
    it('refuses a link without a body that is not the exact shape, whatever is stored: what it shows is not known', () => {
      const origin = `<p>q ${stored()} r</p>`;
      for (const markup of [
        '<ac:link><ri:url ri:value="https://ok.example/"></ri:url><ri:url ri:value="/relative/a"></ri:url></ac:link>',
        '<ac:link><ri:attachment ri:filename="a.pdf"><ri:url ri:value="/relative/a"></ri:url></ri:attachment></ac:link>',
        '<x:link xmlns:x="http://atlassian.com/content"><y:url xmlns:y="http://atlassian.com/resource/identifier" y:value="/relative/a"></y:url></x:link>',
        '<ac:link><ri:url ri:value="/relative/a"></ri:url><ri:page ri:content-title="X"></ri:page><ac:plain-text-link-body> </ac:plain-text-link-body></ac:link>',
      ]) {
        expect(refusal(`<p>q ${markup} r</p>`, { previousStorage: origin })).toBe('unapproved-link');
      }
    });

    it('does not take a stored image URL, a stored native anchor or a rebound prefix for the link\'s origin (W1)', () => {
      const html = `<p>a ${carrier()} b</p>`;
      for (const origin of [
        '<p>a <ac:image><ri:url ri:value="/relative/a" /></ac:image> b</p>',
        '<p>a <a href="#confluence-url:%2Frelative%2Fa?body=plain">x</a> b</p>',
        `<div xmlns:ri="urn:other"><p>a ${stored()} b</p></div>`,
        `<div xmlns:ac="urn:other"><p>a ${stored()} b</p></div>`,
        '<p>a <ac:link><ri:url ri:value="/relative/a" /><ri:page ri:content-title="X" /><ac:plain-text-link-body><![CDATA[x]]></ac:plain-text-link-body></ac:link> b</p>',
      ]) {
        expect(htmlToConfluence(html, { previousStorage: origin })).toBe('<p>a x b</p>');
      }
      // The same storage with the Confluence namespaces declared explicitly is the link's origin.
      const declared = '<p>a <ac:link xmlns:ac="http://atlassian.com/content"><ri:url xmlns:ri="http://atlassian.com/resource/identifier" '
        + 'ri:value="/relative/a" /><ac:plain-text-link-body><![CDATA[x]]></ac:plain-text-link-body></ac:link> b</p>';
      expect(htmlToConfluence(html, { previousStorage: declared })).toBe(`<p>a ${written()} b</p>`);
    });

    it('takes stored storage it cannot read for no evidence, and still saves', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      expect(htmlToConfluence(`<p>a ${carrier()} b</p>`, { previousStorage: `<p>a ${stored()} b` })).toBe('<p>a x b</p>');
      expect(warn).toHaveBeenCalledWith({ unproven: 1, ambiguous: 0, retarget: 0 }, 'Confluence URL links without a stored origin written as text (#1955)');
    });

    it('logs counts once per write and no content', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const origin = `${FILLER}<p>see ${stored()} now</p>${FILLER}`;
      htmlToConfluence(
        `${FILLER}<p>see ${carrier()} now</p>${FILLER}<p>${carrier()}</p><p>${carrier('javascript:alert(1)', 'secret')}</p>`,
        { previousStorage: origin },
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith({ unproven: 1, ambiguous: 1, retarget: 0 }, 'Confluence URL links without a stored origin written as text (#1955)');
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|javascript|relative/);
    });
  });

  describe('markup the document does not hold as an element (V1)', () => {
    it('unwraps a link inside a template, where the document can reach it', () => {
      const storage = htmlToConfluence(`<template><p>t ${raw()} u</p></template><p>v</p>`);
      expect(storage).toBe('<template><p>t x u</p></template><p>v</p>');
      expect(oracleLocalNameCount(storage, 'url')).toBe(0);
    });

    it.each(['style', 'script', 'xmp', 'iframe', 'noembed', 'noframes'])(
      'refuses a link in the raw text of <%s>, which is markup in the storage',
      (container) => {
        const html = `<${container}>${raw()}</${container}><p>t</p>`;
        expect(refusal(html)).toBe('unapproved-link');
        // A stored live twin proves nothing for it, and neither does a copy the document can reach.
        expect(refusal(html, { previousStorage: `<p>${stored()}</p>` })).toBe('unapproved-link');
        expect(refusal(`${html}<p>${raw()}</p>`, { previousStorage: `<p>${stored()}</p>` })).toBe('unapproved-link');
        // Without the feature the same body is written as it was before #1955, and holds the link.
        const base = htmlToConfluence(html, { derivationFeatures: NO_STORAGE_DERIVATION_FEATURES });
        expect(unsafeLinks(base)).toEqual(['/relative/a']);
      },
    );

    it('refuses an alias of the Confluence names and an upper-case name in raw text', () => {
      const alias = '<x:link xmlns:x="http://atlassian.com/content"><y:url xmlns:y="http://atlassian.com/resource/identifier" y:value="/relative/a"/></x:link>';
      expect(refusal(`<script>${alias}</script>`)).toBe('unapproved-link');
      expect(refusal('<style><AC:LINK><RI:URL RI:VALUE="/relative/a"/></AC:LINK></style>')).toBe('unapproved-link');
    });

    it('lets a stored dormant link round-trip in its own place', () => {
      const html = `<style>${raw()}</style><p>t</p>`;
      const storage = htmlToConfluence(html, { previousStorage: `<style>${written()}</style><p>t</p>` });
      expect(storage).toBe(`<style>${written()}</style><p>t</p>`);
    });

    it('keeps genuine text as text: a code sample, escaped text, a comment and a textarea holding link markup', () => {
      const navigable = `<p>${raw('https://example.com/')}</p>`;
      const sample = raw().replace(/</g, '&lt;');
      for (const data of [`<pre><code>${sample}</code></pre>`, `<p>${sample}</p>`, `<!-- ${raw()} -->`, `<textarea>${raw()}</textarea>`]) {
        const storage = htmlToConfluence(`${data}${navigable}`);
        expect(storage).toBe(htmlToConfluence(`${data}${navigable}`, { derivationFeatures: NO_STORAGE_DERIVATION_FEATURES }));
        expect(oracleUrlLinks(storage).map((link) => link.value)).toEqual(['https://example.com/']);
      }
      // A plain-text macro body is written as CDATA: link markup inside it is data, and a declined link beside it is still unwrapped.
      const macro = `<ac:structured-macro ac:name="x"><ac:plain-text-body>${raw()}</ac:plain-text-body></ac:structured-macro>`;
      const storage = htmlToConfluence(`${macro}<p>${raw()}</p>`);
      expect(storage).toBe(`<ac:structured-macro ac:name="x"><ac:plain-text-body><![CDATA[${raw()}]]></ac:plain-text-body></ac:structured-macro><p>x</p>`);
      expect(oracleLocalNameCount(storage, 'url')).toBe(0);
    });

    it('keeps an image URL apart from a link: it is neither judged nor evidence', () => {
      const image = '<p><img src="/api/attachments/1/x.png" data-confluence-image-source="external-url" data-confluence-url="/relative/img.png"></p>';
      const storage = htmlToConfluence(image);
      expect(storage).toBe('<p><ac:image><ri:url ri:value="/relative/img.png"></ri:url></ac:image></p>');
      expect(oracleUrlLinks(storage)).toEqual([]);
      expect(oracleElements(storage, 'ri', 'url')).toHaveLength(1);
    });
  });

  describe('a string the reader cannot read (W2)', () => {
    // An ordinary attribute holding `<` is written raw: the storage is not well-formed XML.
    const BAD = '<p title="a<b">x</p>';

    it.each([
      ['prose that mentions the name', '<p>field:url value, and 1 &lt; url &gt; 0</p>'],
      ['a comment holding the markup', `<!-- ${raw()} -->`],
      ['a code sample holding the markup', `<pre><code>${raw().replace(/</g, '&lt;')}</code></pre>`],
      ['a quoted attribute holding the markup', '<p data-x="&lt;ri:url ri:value=&quot;/a&quot;/&gt;">y</p>'],
      ['nothing else', ''],
    ])('does not refuse a body for %s beside an attribute XML cannot hold', (_name, html) => {
      const storage = htmlToConfluence(`${BAD}${html}`);
      expect(storage).toBe(htmlToConfluence(`${BAD}${html}`, { derivationFeatures: NO_STORAGE_DERIVATION_FEATURES }));
      expect(oracleReads(storage)).toBe(false);
    });

    it('refuses the same body once it holds a url element in markup: what it holds cannot be told', () => {
      expect(refusal(`${BAD}<style>${raw()}</style>`)).toBe('not-well-formed');
      expect(refusal(`${BAD}<p>${carrier()}</p>`, { previousStorage: `<p>${stored()}</p>` })).toBe('not-well-formed');
      expect(refusal(`${BAD}<p>${raw('https://example.com/')}</p>`)).toBe('not-well-formed');
      // And with no feature in force nothing is read and nothing is refused.
      expect(refusal(`${BAD}<style>${raw()}</style>`, { derivationFeatures: NO_STORAGE_DERIVATION_FEATURES })).toBe('written');
    });

    it('logs a refusal with its reason only', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      expect(refusal(`<style>${raw('javascript:alert(1)', 'secret')}</style>`)).toBe('unapproved-link');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith({ reason: 'unapproved-link' }, 'Confluence storage refused before dispatch (#1955)');
    });
  });

  // Review r1. Each case states the bytes that are returned, not only that a resource is gone.
  describe('a prefix the first look must not miss (R1)', () => {
    const hostile = (prefix: string): string =>
      `<ac:link><${prefix}:url ri:value="javascript:alert(1)"></${prefix}:url><ac:plain-text-link-body>y</ac:plain-text-link-body></ac:link>`;
    const PREFIXES: Array<[string, string]> = [
      ['300 characters long', 'p'.repeat(300)],
      ['holding U+1680, a name character JavaScript calls white space', 'a\u1680b'],
      ['holding U+FEFF', 'a\uFEFFb'],
    ];

    it.each(PREFIXES)('judges a link whose url element has a prefix %s', (_name, prefix) => {
      // With no feature in force the element is written as it came: the reader reads it as a `url` in a link.
      const base = htmlToConfluence(`<p>x ${hostile(prefix)} z</p>`, { derivationFeatures: NO_STORAGE_DERIVATION_FEATURES });
      expect(base).toContain(`<${prefix}:url ri:value="javascript:alert(1)">`);
      expect(htmlToConfluence(`<p>x ${hostile(prefix)} z</p>`)).toBe('<p>x y z</p>');
    });

    it.each(PREFIXES)('refuses it in a body the reader cannot read, prefix %s', (_name, prefix) => {
      expect(refusal(`<p title="a<b">x</p><p>${hostile(prefix)}</p>`)).toBe('not-well-formed');
    });

    it('refuses a body it cannot read whose tags it cannot account for, once the name is in it', () => {
      // A raw-text element is written raw: `1 < 2` is no tag in any reading, and what follows cannot be told.
      expect(refusal(`<p title="a<b">x</p><style>1 < 2</style><p>${raw('https://example.com/')}</p>`)).toBe('not-well-formed');
      const quiet = '<p title="a<b">x</p><style>1 < 2</style><p>the url is here</p>';
      expect(htmlToConfluence(quiet)).toBe(htmlToConfluence(quiet, { derivationFeatures: NO_STORAGE_DERIVATION_FEATURES }));
    });
  });

  describe('a stored lookalike never inherits a deleted link (R2)', () => {
    const GENUINE = '<ac:link><ri:url ri:value="/docs" /></ac:link>';
    const LOOKALIKE = '<a href="#confluence-url:%2Fdocs">/docs</a>';

    it.each([
      ['the link first', `<p>${GENUINE}</p><p>${LOOKALIKE}</p>`],
      ['the lookalike first', `<p>${LOOKALIKE}</p><p>${GENUINE}</p>`],
    ])('writes the one paragraph left of two as text, %s, on both Saves', (_order, storage) => {
      // body_html holds two anchors with the same href; the editor deletes one paragraph.
      const html = confluenceToHtml(storage);
      expect(html.match(/<a href="#confluence-url:%2Fdocs"/g)).toHaveLength(2);
      const left = '<p><a href="#confluence-url:%2Fdocs">/docs</a></p>';
      const first = htmlToConfluence(left, { previousStorage: storage });
      expect(first).toBe('<p>/docs</p>');
      expect(htmlToConfluence(left, { linkOrigin: first })).toBe(first);
    });

    it('still writes the link of a page without a lookalike when it moves, on both Saves', () => {
      const storage = `${FILLER}<p>a</p><p>${GENUINE}</p>`;
      const moved = `<p><a href="#confluence-url:%2Fdocs">/docs</a></p>${FILLER}<p>a</p>`;
      const first = htmlToConfluence(moved, { previousStorage: storage });
      expect(first).toBe(`<p><ac:link><ri:url ri:value="/docs"></ri:url></ac:link></p>${FILLER}<p>a</p>`);
      expect(htmlToConfluence(moved, { linkOrigin: first })).toBe(first);
    });
  });

  // Review r2, R11: a link of another kind shows text in body_html too, and competes with what it shows.
  describe('a link of another kind showing the same text (R11)', () => {
    const URL_LINK = '<ac:link><ri:url ri:value="/docs"></ri:url></ac:link>';
    const PAGE_LINK = '<ac:link><ri:page ri:content-title="/docs"></ri:page></ac:link>';

    it.each([
      ['the URL link first', `<p>${URL_LINK}</p><p>${PAGE_LINK}</p>`],
      ['the page link first', `<p>${PAGE_LINK}</p><p>${URL_LINK}</p>`],
    ])('writes the one paragraph left, pointing at the URL, as text, %s, on both Saves', (_order, storage) => {
      const html = confluenceToHtml(storage);
      // The forward pass shows the same text for both links.
      expect(html.match(/>\/docs<\/a>/g)).toHaveLength(2);
      expect(htmlToConfluence(html, { previousStorage: storage })).toBe(storage);
      // One paragraph deleted, the other pointed at the URL: which one is left cannot be told.
      const left = '<p><a href="#confluence-url:%2Fdocs">/docs</a></p>';
      const first = htmlToConfluence(left, { previousStorage: storage });
      expect(first).toBe('<p>/docs</p>');
      expect(htmlToConfluence(left, { linkOrigin: first })).toBe(first);
    });
  });

  // Review r2, R12: the HTML parser reads `&lang;` and `&rang;` as U+27E8/U+27E9, XML as U+2329/U+232A. A link
  // of a #1955 kind is written back with the value XML reads from the stored storage, however it is spelled.
  describe('a stored target keeps the value XML reads from it (R12)', () => {
    const SPELLINGS = [
      ['the entity names', '&lang;', '&rang;'],
      ['decimal references', '&#9001;', '&#9002;'],
      ['the XHTML characters', '\u2329', '\u232A'],
      ['the HTML5 characters', '\u27E8', '\u27E9'],
    ] as const;
    const TARGETS: ReadonlyArray<readonly [string, (l: string, r: string) => string]> = [
      ['a space key', (l, r) => `<ac:link><ri:space ri:space-key="K${l}1${r}" /></ac:link>`],
      ['a navigable URL', (l, r) => `<ac:link><ri:url ri:value="https://example.com/a${l}b${r}" /></ac:link>`],
      ['a relative URL', (l, r) => `<ac:link><ri:url ri:value="/a${l}b${r}" /><ac:plain-text-link-body><![CDATA[docs]]></ac:plain-text-link-body></ac:link>`],
      ['a blog post and its anchor', (l, r) => `<ac:link ac:anchor="s${r}"><ri:blog-post ri:content-title="Q${l}3" ri:space-key="ENG" /></ac:link>`],
    ];
    /** Every link and resource element with its attributes as XML reads them, in document order. */
    const values = (storage: string): string[] => [...oracleElements(storage, 'ac', 'link'), ...oracleElements(storage, 'ri', '*')]
      .map((element) => `${element.tagName} ${[...element.attributes].map((attribute) => `${attribute.name}=${attribute.value}`).join(' ')}`);

    const cases = TARGETS.flatMap(([target, build]) => SPELLINGS.map(([spelling, l, r]) => [target, spelling, build(l, r)] as const));
    it.each(cases)('writes %s spelled with %s back with its value, on both Saves', (_target, _spelling, link) => {
      const storage = `<p>see ${link} now</p>`;
      const first = htmlToConfluence(confluenceToHtml(storage), { previousStorage: storage });
      expect(values(first)).toEqual(values(storage));
      expect(htmlToConfluence(confluenceToHtml(first), { previousStorage: first })).toBe(first);
    });

    it('reads the references in the link\'s tags only: a plain body keeps its text as written', () => {
      const storage = '<p><ac:link><ri:space ri:space-key="K&lang;" /><ac:plain-text-link-body><![CDATA[a &lang; b]]></ac:plain-text-link-body></ac:link></p>';
      const first = htmlToConfluence(confluenceToHtml(storage), { previousStorage: storage });
      expect(first).toContain('<![CDATA[a &lang; b]]>');
      expect(values(first)).toEqual(values(storage));
    });

    it('leaves the #1748 kinds and text as the base commit reads them (pre-existing, not rebuilt here)', () => {
      const storage = '<p>t&lang;x <ac:link><ri:page ri:content-title="A&lang;B" /></ac:link></p>';
      // The base commit bff6d4ec writes U+27E8 here too: the HTML parser's value, for a link #1955 does not rebuild.
      expect(confluenceToHtml(storage)).toBe('<p>t\u27E8x <a href="#confluence-page:A%E2%9F%A8B" data-confluence-link="page">A\u27E8B</a></p>');
    });

    // Review r3, R17: an XML processing instruction is no markup to the scan that spells the references, and a
    // key the HTML reading changes is never written unless the XML reading confirms it.
    it.each([
      ['with nothing before it', ''],
      ['after an unrelated processing instruction whose data spells a style tag', '<?meta data="<style>"?>'],
    ])('writes a space key back with the value XML reads, %s (R17)', (_where, before) => {
      for (const [, l, r] of SPELLINGS) {
        const storage = `${before}<p>see <ac:link><ri:space ri:space-key="A${l}B${r}" /></ac:link> now</p>`;
        const first = htmlToConfluence(confluenceToHtml(storage), { previousStorage: storage });
        expect(values(first)).toEqual(values(storage));
      }
    });

    // Review r4, R21: a target is never dropped for a difference between the two readings. The forward pass
    // spells each start tag of a #1955 link so that HTML reads what XML reads; nothing is left to disagree.
    it.each([
      ['a literal TAB, which XML reads as a space', 'Release\tnotes'],
      ['a literal CR LF', 'Release\r\nnotes'],
      ['a C1 numeric reference, which HTML maps to a windows-1252 character', 'Release&#146;s notes'],
      ['a hexadecimal C1 reference', 'Release&#x92;s notes'],
      ['a disputed entity name', 'Release &lang;notes&rang;'],
    ])('writes back both blog links, the second titled with %s, with the XML values, on both Saves (R21)', (_name, title) => {
      const storage = '<p><ac:link><ri:blog-post ri:content-title="Editor\u2019s guide" ri:posting-day="2024/05/01" ri:space-key="ENG" /></ac:link>'
        + ` and <ac:link><ri:blog-post ri:content-title="${title}" ri:posting-day="2024/05/02" ri:space-key="ENG" /></ac:link></p>`;
      const projected = yDocToHtml(htmlToYDoc(confluenceToHtml(storage)));
      const first = htmlToConfluence(projected, { previousStorage: storage });
      expect(values(first)).toEqual(values(storage));
      expect(htmlToConfluence(yDocToHtml(htmlToYDoc(confluenceToHtml(first))), { previousStorage: first })).toBe(first);
    });

    // Review r5, R24 and owner decision D19: a Save that would publish a #1955 link with another XML target than
    // the stored link it carries is refused before any effect; a stored target that survives is written as it is.
    const refusal = (save: () => string): string | null => {
      try {
        save();
        return null;
      } catch (error) {
        if (error instanceof ConfluenceStorageRefusedError) return error.reason;
        throw error;
      }
    };
    const blog = (anchor: string): string =>
      `<p>see <ac:link ac:anchor="${anchor}"><ri:blog-post ri:content-title="Authors" ri:space-key="OPS" /></ac:link> now</p>`;
    const mailto = (subject: string): string =>
      `<p>mail <ac:link><ri:url ri:value="mailto:a@example.com?subject=${subject}" /></ac:link> now</p>`;

    it.each([
      ['a literal `/>` in a blog link\'s section', blog('See /> here'), 'changed-link-target'],
      ['that section with `>` escaped', blog('See /&gt; here'), null],
      ['two attribute names HTML folds into one', '<p><ac:link><ri:blog-post ri:content-title="Release notes" ri:CONTENT-TITLE="Draft notes" ri:space-key="ENG" /></ac:link></p>', 'changed-link-target'],
      ['a literal `/>` in a mailto primary', mailto('Read/>notes'), 'changed-link-target'],
      ['that primary with `>` escaped', mailto('Read/&gt;notes'), null],
    ])('saves an unchanged page holding %s: refused on both Saves, or written with its XML target (D19)', (_name, storage, reason) => {
      const projected = yDocToHtml(htmlToYDoc(confluenceToHtml(storage)));
      const save = (): string => htmlToConfluence(projected, { previousStorage: storage });
      expect(refusal(save)).toBe(reason);
      if (reason !== null) {
        // Nothing changed, so the next Save meets the same stored page and is refused alike.
        expect(refusal(save)).toBe(reason);
        return;
      }
      const first = save();
      expect(values(first)).toEqual(values(storage));
      expect(htmlToConfluence(yDocToHtml(htmlToYDoc(confluenceToHtml(first))), { previousStorage: first })).toBe(first);
    });

    it('refuses only a link carried from a stored one: a new link, a #1748 kind and a page without the link are written (D19)', () => {
      const projected = yDocToHtml(htmlToYDoc(confluenceToHtml(blog('See /> here'))));
      expect(refusal(() => htmlToConfluence(projected, { previousStorage: '<p>other</p>' }))).toBeNull();
      expect(refusal(() => htmlToConfluence('<p>see now</p>', { previousStorage: blog('See /> here') }))).toBeNull();
      const page = '<p>see <ac:link ac:anchor="See /> here"><ri:page ri:content-title="Authors" /></ac:link> now</p>';
      expect(refusal(() => htmlToConfluence(confluenceToHtml(page), { previousStorage: page }))).toBeNull();
    });

    it('refuses a link carried from well-formed stored storage past the reader\'s limits, not from malformed storage (D19)', () => {
      const link = '<p>see <ac:link><ri:blog-post ri:content-title="Ops&lang;guide" ri:space-key="OPS" /></ac:link> now</p>';
      const deep = `${link}${'<div>'.repeat(1_100)}x${'</div>'.repeat(1_100)}`;
      expect(refusal(() => htmlToConfluence(confluenceToHtml(deep), { previousStorage: deep }))).toBe('too-deep');
      const malformed = `${link}<p>unclosed`;
      expect(refusal(() => htmlToConfluence(confluenceToHtml(malformed), { previousStorage: malformed }))).toBeNull();
    });

    // Review r6, R25 and coordinator decision D20: the verdict is the real forward pass's, made where it emits the
    // carrier. An info panel re-parses its body as HTML before its links are read, so a CR in a stored title is an
    // LF in the carrier the editor gets; a paragraph and an expand keep the CR.
    const release = '<ac:link><ri:blog-post ri:content-title="Release&#13;notes" ri:space-key="OPS" /></ac:link>';
    const inPanel = (name: string): string =>
      `<ac:structured-macro ac:name="${name}"><ac:rich-text-body><p>see ${release} now</p></ac:rich-text-body></ac:structured-macro>`;
    it.each([
      ['a paragraph', `<p>see ${release} now</p>`, '%0D', null],
      ['an expand', inPanel('expand'), '%0D', null],
      ['an info panel', inPanel('info'), '%0A', 'changed-link-target'],
    ])('saves an unchanged page with a CR in a blog title in %s: written as XML reads it, or refused, on both Saves (R25)', (_where, storage, emitted, reason) => {
      const projected = yDocToHtml(htmlToYDoc(confluenceToHtml(storage)));
      expect(projected).toContain(`Release${emitted}notes`);
      const save = (): string => htmlToConfluence(projected, { previousStorage: storage });
      expect(refusal(save)).toBe(reason);
      if (reason !== null) {
        expect(refusal(save)).toBe(reason);
        return;
      }
      const first = save();
      expect(values(first)).toEqual(values(storage));
      expect(htmlToConfluence(yDocToHtml(htmlToYDoc(confluenceToHtml(first))), { previousStorage: first })).toBe(first);
    });

    it('refuses a link the forward pass emitted from well-formed storage past the limits, in a panel too, and nothing else (R25)', () => {
      const deep = `${'<div>'.repeat(1_100)}x${'</div>'.repeat(1_100)}`;
      for (const where of [`<p>see ${release} now</p>`, inPanel('info')]) {
        const storage = `${where}${deep}`;
        const projected = yDocToHtml(htmlToYDoc(confluenceToHtml(storage)));
        expect(refusal(() => htmlToConfluence(projected, { previousStorage: storage }))).toBe('too-deep');
        // The link removed, or a distinct new one, is written.
        expect(refusal(() => htmlToConfluence('<p>see now</p>', { previousStorage: storage }))).toBeNull();
        const fresh = confluenceToHtml('<p><ac:link><ri:blog-post ri:content-title="Other" ri:space-key="OPS" /></ac:link></p>');
        expect(refusal(() => htmlToConfluence(fresh, { previousStorage: storage }))).toBeNull();
      }
    });

    // Review r6, R26: an occurrence is a link the forward pass emitted, not a carrier string found anywhere.
    const guide = '<ac:link><ri:blog-post ri:content-title="Guide" ri:space-key="OPS" /></ac:link>';
    const folded = '<ac:link><ri:blog-post ri:content-title="Guide" ri:CONTENT-TITLE="Other" ri:space-key="OPS" /></ac:link>';
    const guideHtml = confluenceToHtml(`<p>${guide}</p>`);

    it('refuses no new link whose carrier only a discarded code-macro parameter held (R26)', () => {
      const storage = `<ac:structured-macro ac:name="code"><ac:parameter ac:name="title">${folded}</ac:parameter>`
        + '<ac:plain-text-body><![CDATA[echo hello]]></ac:plain-text-body></ac:structured-macro>';
      const shown = confluenceToHtml(storage);
      expect(shown).not.toContain('confluence-blog-post');
      expect(refusal(() => htmlToConfluence(`${shown}${guideHtml}`, { previousStorage: storage }))).toBeNull();
    });

    it('refuses a carrier a faithful and an unfaithful emitted link share as ambiguous; the faithful link alone is written (R26)', () => {
      const both = `<p>one ${guide}</p><p>two ${folded}</p>`;
      const warn = vi.spyOn(logger, 'warn');
      expect(refusal(() => htmlToConfluence(guideHtml, { previousStorage: both }))).toBe('changed-link-target');
      expect(warn).toHaveBeenCalledWith({ reason: 'changed-link-target', detail: 'ambiguous' }, expect.any(String));
      warn.mockClear();
      expect(refusal(() => htmlToConfluence(confluenceToHtml(`<p>${folded}</p>`), { previousStorage: `<p>${folded}</p>` })))
        .toBe('changed-link-target');
      expect(warn).toHaveBeenCalledWith({ reason: 'changed-link-target' }, expect.any(String));
      expect(refusal(() => htmlToConfluence(guideHtml, { previousStorage: `<p>${guide}</p>` }))).toBeNull();
    });

    // Review r7, R29 and owner decision D21: only a link that survives in the completed forward result has a
    // verdict. These macros replace their whole subtree after the link loop has already converted the parameter's link.
    it.each([
      ['status', '<ac:parameter ac:name="colour">Grey</ac:parameter>'],
      ['toc', ''],
      ['jira', '<ac:parameter ac:name="key">OPS-1</ac:parameter>'],
      ['an-unknown-macro', ''],
    ])('refuses no new link whose carrier only a parameter of a %s macro held (R29)', (name, more) => {
      const storage = `<p>before</p><ac:structured-macro ac:name="${name}"><ac:parameter ac:name="title">${folded}</ac:parameter>${more}</ac:structured-macro>`;
      const shown = confluenceToHtml(storage);
      const shownDoc = new JSDOM(`<body>${shown}</body>`).window.document;
      expect(shownDoc.querySelectorAll('a[href^="#confluence-blog-post:"]')).toHaveLength(0);
      expect(refusal(() => htmlToConfluence(`${shown}${guideHtml}`, { previousStorage: storage }))).toBeNull();
    });

    // Review r7, R28 and owner decision D21: the stored links, the read failure and the limits are those of the
    // stored string itself, never of its HTML preprocessing (CDATA as text).
    it.each([
      ['escaped `]]>` prose', '<p>]]&gt;</p>'],
      ['CDATA `]]` followed by a literal `>`', '<p><![CDATA[]]]]>></p>'],
    ])('refuses the info-panel CR title after %s on both Saves; the editor shows both pages alike (R28)', (_name, before) => {
      const storage = `${before}${inPanel('info')}`;
      expect(oracleReads(storage)).toBe(true);
      const projected = yDocToHtml(htmlToYDoc(confluenceToHtml(storage)));
      expect(projected).toBe(yDocToHtml(htmlToYDoc(confluenceToHtml(`<p>]]&gt;</p>${inPanel('info')}`))));
      // Nothing changed, so the next Save meets the same stored page and is refused alike.
      expect(refusal(() => htmlToConfluence(projected, { previousStorage: storage }))).toBe('changed-link-target');
      expect(refusal(() => htmlToConfluence(projected, { previousStorage: storage }))).toBe('changed-link-target');
    });

    it('takes the reader\'s length limit on the stored string, not on its CDATA turned into text (R28)', () => {
      const cap = STORAGE_READER_LIMITS.length;
      const head = `<p>${guide}</p><p><![CDATA[`;
      const tail = ']]></p>';
      // One character past the limit; without its CDATA delimiters it would be under it.
      const over = `${head}${'a'.repeat(cap + 1 - head.length - tail.length)}${tail}`;
      expect(over.length).toBe(cap + 1);
      expect(refusal(() => htmlToConfluence(guideHtml, { previousStorage: over }))).toBe('too-large');
      // Within the limit; each `&` would be five characters once the CDATA is text.
      const within = `${head}${'&'.repeat(Math.ceil(cap / 5) + 1)}${tail}`;
      expect(within.length).toBeLessThan(cap);
      expect(refusal(() => htmlToConfluence(guideHtml, { previousStorage: within }))).toBeNull();
    });
  });

  // Review r3, R16: the writer and its second Save give a page link's title and an explicit body showing the same
  // text the same treatment.
  describe('a page link that shows its title, or a body with the same text (R16)', () => {
    const GUIDE = (shown: string): string =>
      `<ac:link><ri:url ri:value="/guide" /><ac:plain-text-link-body><![CDATA[${shown}]]></ac:plain-text-link-body></ac:link>`;

    it.each([
      ['a title with white space the editor collapses', 'Ops  guide', 'Ops guide'],
      ['a title with a disputed entity name', 'Ops&lang;guide', 'Ops\u27E8guide'],
    ])('writes the paragraph left, pointing at the URL, as text, with %s, on both Saves', (_name, title, shown) => {
      for (const body of ['', `<ac:plain-text-link-body><![CDATA[${shown}]]></ac:plain-text-link-body>`]) {
        const storage = `<p>${GUIDE(shown)}</p><p><ac:link><ri:page ri:content-title="${title}" />${body}</ac:link></p>`;
        const left = `<p><a href="#confluence-url:%2Fguide?body=plain">${shown}</a></p>`;
        const first = htmlToConfluence(left, { previousStorage: storage });
        expect(first).toBe(`<p>${shown}</p>`);
        expect(htmlToConfluence(left, { linkOrigin: first })).toBe(first);
      }
    });
  });

  // Review r4, R20: an explicit body whose shown text the XML reading cannot establish (here `&lang;`, which the
  // editor shows as U+27E8 and XML reads as U+2329) is a rival of unknown text, so the two spellings that the editor
  // shows alike are judged alike.
  describe('a rival body whose shown text XML cannot establish (R20)', () => {
    const GUIDE = '<ac:link><ri:url ri:value="/guide" /><ac:plain-text-link-body><![CDATA[Ops\u27E8guide]]></ac:plain-text-link-body></ac:link>';
    const page = (label: string): string => `<ac:link><ri:page ri:content-title="Home" /><ac:link-body>${label}</ac:link-body></ac:link>`;

    it.each([['the entity name', 'Ops&lang;guide'], ['the character the editor shows', 'Ops\u27E8guide']])(
      'writes the paragraph left, pointing at the URL, as text with a rich page body spelled with %s, on both Saves',
      (_name, label) => {
        for (const storage of [`<p>${GUIDE}</p><p>${page(label)}</p>`, `<p>${page(label)}</p><p>${GUIDE}</p>`]) {
          // The editor shows the same document for both spellings.
          expect(yDocToHtml(htmlToYDoc(confluenceToHtml(storage))))
            .toBe(yDocToHtml(htmlToYDoc(confluenceToHtml(storage.replace(label, 'Ops\u27E8guide')))));
          const left = '<p><a href="#confluence-url:%2Fguide?body=plain">Ops\u27E8guide</a></p>';
          const first = htmlToConfluence(left, { previousStorage: storage });
          expect(first).toBe('<p>Ops\u27E8guide</p>');
          expect(htmlToConfluence(left, { linkOrigin: first })).toBe(first);
        }
      },
    );

    // Review r5, R23: an ordinary stored anchor is held to the same rule as a link.
    it.each([['the entity name', 'Ops&lang;guide'], ['the character the editor shows', 'Ops\u27E8guide']])(
      'writes the paragraph left, pointing at the URL, as text beside an ordinary anchor labelled with %s, on both Saves (R23)',
      (_name, label) => {
        const anchor = `<a href="https://example.com/ops">${label}</a>`;
        for (const storage of [`<p>${GUIDE}</p><p>${anchor}</p>`, `<p>${anchor}</p><p>${GUIDE}</p>`]) {
          expect(yDocToHtml(htmlToYDoc(confluenceToHtml(storage))))
            .toBe(yDocToHtml(htmlToYDoc(confluenceToHtml(storage.replace(label, 'Ops\u27E8guide')))));
          const left = '<p><a href="#confluence-url:%2Fguide?body=plain">Ops\u27E8guide</a></p>';
          const first = htmlToConfluence(left, { previousStorage: storage });
          expect(first).toBe('<p>Ops\u27E8guide</p>');
          expect(htmlToConfluence(left, { linkOrigin: first })).toBe(first);
        }
        // The unchanged page keeps its link beside the anchor.
        const storage = `<p>${GUIDE}</p><p>${anchor}</p>`;
        const html = '<p><a href="#confluence-url:%2Fguide?body=plain">Ops\u27E8guide</a></p><p><a href="https://example.com/ops">Ops\u27E8guide</a></p>';
        expect(oracleUrlLinks(htmlToConfluence(html, { previousStorage: storage }))).toHaveLength(1);
      },
    );

    // Review r6, R27 and coordinator decision D20: a stored anchor whose text is not known is released only by an
    // anchor to its target in its own place, never by how many anchors point there.
    it.each([['the entity name', 'Ops&lang;guide'], ['the character the editor shows', 'Ops\u27E8guide']])(
      'writes the moved URL link as text whatever ordinary anchor is written, the rival spelled with %s, on both Saves (R27)',
      (_name, label) => {
        const storage = `<p>${GUIDE}</p><p><a href="https://example.com/ops">${label}</a></p>`;
        const moved = '<p>Moved here: <a href="#confluence-url:%2Fguide?body=plain">Ops\u27E8guide</a></p>';
        for (const anchor of [
          '',
          '<p>See the <a href="https://example.com/ops">Calendar</a> today.</p>',
          '<p>See the <a href="https://example.com/other">Calendar</a> today.</p>',
        ]) {
          const first = htmlToConfluence(`${moved}${anchor}`, { previousStorage: storage });
          expect(oracleUrlLinks(first), anchor).toEqual([]);
          expect(oracleUrlLinks(htmlToConfluence(`${moved}${anchor}`, { linkOrigin: first })), anchor).toEqual([]);
        }
      },
    );

    // Review r7, R30 and owner decision D21: a stored anchor whose text is not known is released only when it owns
    // its place alone on both sides, never by another anchor to the same target in a place of the same signature.
    it.each([['the entity name', 'Ops&lang;guide'], ['the character the editor shows', 'Ops\u27E8guide']])(
      'writes the moved URL link as text when the removed rival, spelled with %s, shared its place signature with a kept anchor (R30)',
      (_name, label) => {
        const around = 'Follow every step of these setup instructions carefully before you continue reading. '.repeat(2);
        const anchorIn = (text: string, words: string): string =>
          `<p>${words}<a href="https://example.com/ops">${text}</a> ${words}</p>`;
        const moved = '<p>Moved here: <a href="#confluence-url:%2Fguide?body=plain">Ops\u27E8guide</a></p>';
        for (const [calendarWords, kind] of [[around, 'repeated'], ['See the calendar for the next dates. ', 'distinct']] as const) {
          const storage = `<p>${GUIDE}</p>${FILLER}${anchorIn(label, around)}${anchorIn('Calendar', calendarWords)}`;
          expect(yDocToHtml(htmlToYDoc(confluenceToHtml(storage))))
            .toBe(yDocToHtml(htmlToYDoc(confluenceToHtml(storage.replace(label, 'Ops\u27E8guide')))));
          const outgoing = `${moved}${FILLER}${anchorIn('Calendar', calendarWords)}`;
          const first = htmlToConfluence(outgoing, { previousStorage: storage });
          expect(oracleUrlLinks(first), kind).toEqual([]);
          expect(oracleUrlLinks(htmlToConfluence(outgoing, { linkOrigin: first })), kind).toEqual([]);
        }
      },
    );
  });

  // Review r8 and the D21 fallback: an occurrence that cannot be shown to supply the link the editor holds grants
  // nothing, and an anchor the editor shows competes whatever its spelling; an unproven non-web link becomes text.
  describe('an unproven non-web link is written as its text (R31, R32)', () => {
    const GUIDE = '<ac:link><ri:url ri:value="/guide" /><ac:plain-text-link-body><![CDATA[Guide]]></ac:plain-text-link-body></ac:link>';
    const moved = '<p>Moved here: <a href="#confluence-url:%2Fguide?body=plain">Guide</a></p>';
    const twoSaves = (html: string, storage: string): string[] => {
      const first = htmlToConfluence(html, { previousStorage: storage });
      return [first, htmlToConfluence(html, { linkOrigin: first })];
    };

    it.each([
      ['`a` with `href`', '<a href="https://example.com/">Guide</a>'],
      ['`A` with `href`', '<A href="https://example.com/">Guide</A>'],
      ['`a` with `HREF`', '<a HREF="https://example.com/">Guide</a>'],
    ])('writes the moved link as text once an ordinary anchor spelled %s and showing the same text is deleted (R31)', (_name, anchor) => {
      const storage = `<p>${GUIDE}</p>${FILLER}<p>Web ${anchor}.</p>`;
      expect(confluenceToHtml(storage)).toBe(confluenceToHtml(`<p>${GUIDE}</p>${FILLER}<p>Web <a href="https://example.com/">Guide</a>.</p>`));
      for (const saved of twoSaves(`${moved}${FILLER}`, storage)) {
        expect(oracleUrlLinks(saved)).toEqual([]);
        expect(saved).toContain('Moved here: Guide');
      }
    });

    it.each([
      ['status', ''],
      ['code', '<ac:plain-text-body><![CDATA[echo hello]]></ac:plain-text-body>'],
      ['toc', ''],
      ['expand', '<ac:rich-text-body><p>inside</p></ac:rich-text-body>'],
    ])('grants nothing for a stored link in a parameter of a %s macro, which the editor never shows (R32)', (name, body) => {
      const storage = `<ac:structured-macro ac:name="${name}"><ac:parameter ac:name="title">${GUIDE}</ac:parameter>${body}</ac:structured-macro>`;
      const shown = confluenceToHtml(storage);
      expect(new JSDOM(`<body>${shown}</body>`).window.document.querySelectorAll('a[href]')).toHaveLength(0);
      for (const saved of twoSaves(`${shown}${moved}`, storage)) {
        expect(oracleUrlLinks(saved)).toEqual([]);
        expect(saved).toContain('Moved here: Guide');
      }
    });

    it('keeps a visible stored link that moved, with nothing competing, on both Saves', () => {
      const storage = `<p>${GUIDE}</p>${FILLER}`;
      for (const saved of twoSaves(`${FILLER}${moved}`, storage)) {
        expect(oracleUrlLinks(saved).map((link) => link.value)).toEqual(['/guide']);
      }
      // With no stored source the same link is text.
      for (const saved of twoSaves(`${FILLER}${moved}`, FILLER)) expect(oracleUrlLinks(saved)).toEqual([]);
    });

    // Review r9, R33 and the D21 disposition: a stored link the forward pass did not show is a competitor only. It
    // grants no written link, in a template either; a stored link that is dormant itself still round-trips there.
    const statusParam = `<ac:structured-macro ac:name="status"><ac:parameter ac:name="title">${GUIDE}</ac:parameter></ac:structured-macro>`;
    const template = `<template><p>t ${raw('/guide', 'Guide')} u</p></template>`;
    it.each([
      ['a discarded status parameter, into an ordinary paragraph', statusParam, (shown: string) => `${shown}${moved}`, 0],
      ['a discarded status parameter, into a new template paragraph', statusParam, (shown: string) => `${shown}${template}`, 0],
      ['no source, into the same template paragraph', FILLER, (shown: string) => `${shown}${template}`, 0],
      ['a stored template occurrence, into itself', `<template><p>t ${written('/guide', 'Guide')} u</p></template>`, () => template, 1],
      ['a visible original with nothing competing, moved into an ordinary paragraph', `<p>${GUIDE}</p>${FILLER}`, () => `${FILLER}${moved}`, 1],
    ])('writes %s with as many url resources on both Saves as its source proves (R33)', (_case, storage, outgoing, urls) => {
      for (const saved of twoSaves(outgoing(confluenceToHtml(storage)), storage)) {
        expect(oracleLocalNameCount(saved, 'url')).toBe(urls);
        expect(saved).toContain('Guide');
      }
    });
  });

  // Review r4, R22: no attribute of the input stands for a decision of the converter.
  describe('an attribute of the stored link is no decision (R22)', () => {
    const STORAGE = '<p><ac:link data-cq-uncertain-link-reading=""><ri:page ri:content-title="Guide" /></ac:link></p>';

    it('reads a #1748 page link with any extra attribute as the page link, with and without the feature', () => {
      const html = confluenceToHtml(STORAGE);
      expect(html).toBe('<p><a href="#confluence-page:Guide" data-confluence-link="page">Guide</a></p>');
      for (const features of [undefined, NO_STORAGE_DERIVATION_FEATURES]) {
        expect(htmlToConfluence(html, { previousStorage: STORAGE, derivationFeatures: features }))
          .toBe('<p><ac:link><ri:page ri:content-title="Guide"></ri:page></ac:link></p>');
      }
      const element = new JSDOM(`<body>${STORAGE}</body>`).window.document.body.querySelector('p')!.firstElementChild!;
      expect(confluenceLinkCarrier(element)).toMatchObject({ kind: 'page', value: 'Guide' });
      expect(confluenceLinkAnchor(element, NO_STORAGE_DERIVATION_FEATURES)?.map((node) => (node as Element).outerHTML))
        .toEqual(['<a href="#confluence-page:Guide" data-confluence-link="page">Guide</a>']);
    });
  });

  describe('what a link held when it is taken away (R3)', () => {
    it('keeps the text of a plain body as the text an XML reader reads from it', () => {
      const html = '<p>a <ac:link><ri:url ri:value="/r"></ri:url><ac:plain-text-link-body>use <b>bold</b> &amp; more</ac:plain-text-link-body></ac:link> z</p>';
      // The body is written as CDATA: its text is the markup, as characters.
      expect(htmlToConfluence(html, { derivationFeatures: NO_STORAGE_DERIVATION_FEATURES }))
        .toContain('<![CDATA[use <b>bold</b> & more]]>');
      expect(htmlToConfluence(html)).toBe('<p>a use &lt;b&gt;bold&lt;/b&gt; &amp; more z</p>');
    });

    it('keeps the nodes of a rich body, and of every body of a link with two', () => {
      const rich = '<ac:link-body>the <b>Annual report</b> <ac:image><ri:attachment ri:filename="a.png"></ri:attachment></ac:image></ac:link-body>';
      expect(htmlToConfluence(`<p>Before <ac:link><ri:url ri:value="/r"></ri:url>${rich}</ac:link> after</p>`)).toBe(
        '<p>Before the <b>Annual report</b> <ac:image><ri:attachment ri:filename="a.png"></ri:attachment></ac:image> after</p>',
      );
      expect(htmlToConfluence(
        '<p>Before <ac:link><ri:url ri:value="/r"></ri:url><ac:link-body><i>one</i></ac:link-body>'
        + '<ac:plain-text-link-body>two</ac:plain-text-link-body></ac:link> after</p>',
      )).toBe('<p>Before <i>one</i>two after</p>');
    });

    it.each([
      [
        'a link element under another prefix, bound to the Confluence namespace',
        '<p>Before <x:link xmlns:x="http://atlassian.com/content"><ri:url ri:value="/r"></ri:url>'
        + '<ac:link-body><b>Annual report</b></ac:link-body></x:link> after</p>',
      ],
      ['text outside its body', '<p>Before <ac:link><ri:url ri:value="/r"></ri:url>Annual report</ac:link> after</p>'],
      ['an element outside its body', '<p>Before <ac:link><ri:url ri:value="/r"></ri:url><b>Annual report</b></ac:link> after</p>'],
      ['content in its resource', '<p>Before <ac:link><ri:url ri:value="/r"><b>Annual report</b></ri:url></ac:link> after</p>'],
      [
        'a body under another prefix',
        '<p>Before <ac:link><ri:url ri:value="/r"></ri:url><x:link-body>Annual report</x:link-body></ac:link> after</p>',
      ],
    ])('refuses a link with %s: nothing it shows is dropped unseen', (_name, html) => {
      expect(refusal(html)).toBe('unapproved-link');
      // The same markup is written as it came when the link is one anyone may write.
      const navigable = html.replace('ri:value="/r"', 'ri:value="https://example.com/"');
      expect(refusal(navigable)).toBe('unapproved-link');
    });
  });

  describe('a long body, and work past the limit (R6)', () => {
    it.each([4_096, 4_097, 60_000])('round-trips an unchanged link whose plain body has %i characters, byte for byte', (length) => {
      const storage = `<p>See ${stored('/guide', 'x'.repeat(length))} now</p>`;
      expect(htmlToConfluence(confluenceToHtml(storage), { previousStorage: storage })).toBe(`<p>See ${written('/guide', 'x'.repeat(length))} now</p>`);
    });

    it('refuses a body it cannot judge within its work limit, and never writes it without its links', () => {
      // 400 links in each other's bodies around 25,000 characters: 400 bodies of 25,000 characters to compare.
      const depth = 400;
      const nested = `${'<ac:link><ri:url ri:value="/r"></ri:url><ac:link-body>'.repeat(depth)}${'x'.repeat(25_000)}${'</ac:link-body></ac:link>'.repeat(depth)}`;
      expect(refusal(`<p>${nested}</p>`)).toBe('too-many-nodes');
      // The stored storage is evidence or the write is refused: it is never silently no evidence.
      expect(refusal(`<p>${carrier()}</p>`, { previousStorage: `<p>${stored()}</p>${nested}` })).toBe('too-many-nodes');
      expect(refusal(`<p>${raw('https://example.com/')}</p>`, { previousStorage: `<p>${stored()}</p>${nested}` })).toBe('written');
    });
  });

  describe('what is returned', () => {
    it('is the first serialisation, byte for byte, when no link is declined', () => {
      const html = `<p>a ${raw()} b &nbsp; <br></p><p>${raw('https://example.com/')}</p>`;
      const origin = `<p>a ${stored()} b</p>`;
      expect(htmlToConfluence(html, { previousStorage: origin }))
        .toBe(htmlToConfluence(html, { previousStorage: origin, derivationFeatures: NO_STORAGE_DERIVATION_FEATURES }));
    });

    it('never holds a link-like marker of the repair, in the storage or in the document\'s next serialisation', () => {
      const storage = htmlToConfluence(`<p>a ${raw()} b ${raw('https://example.com/')}</p><p><ac:link><ri:page ri:content-title="P"></ri:page></ac:link></p>`);
      expect(storage).toBe('<p>a x b <ac:link><ri:url ri:value="https://example.com/"></ri:url>'
        + '<ac:plain-text-link-body><![CDATA[x]]></ac:plain-text-link-body></ac:link></p><p><ac:link><ri:page ri:content-title="P"></ri:page></ac:link></p>');
      expect(storage).not.toContain('data-cq-link');
    });

    it('is the identity on a second write against what the first wrote', () => {
      const origin = `${FILLER}<p>see ${stored()} now</p>${FILLER}`;
      const room = `${FILLER}<p>see ${carrier()} now</p>${FILLER}<p>${carrier()}</p><p>${carrier('/new', 'n')}</p>`;
      const first = htmlToConfluence(room, { linkOrigin: origin });
      expect(unsafeLinks(first)).toEqual(['/relative/a']);
      // A room keeps its anchors; the next Save judges them against the storage this Save wrote.
      expect(htmlToConfluence(room, { linkOrigin: first })).toBe(first);
      // A page re-derived from the returned storage holds one carrier, and writes it again.
      expect(htmlToConfluence(confluenceToHtml(first), { previousStorage: first })).toBe(first);
    });

    it('keeps the text piece of a link the collaborative schema splits, and never a second link (#1954-A)', () => {
      const mixed = '<p>x <ac:link><ri:url ri:value="/relative/a" /><ac:link-body>foo '
        + '<ac:image><ri:attachment ri:filename="i.png" /></ac:image></ac:link-body></ac:link> y</p>';
      const room = yDocToHtml(htmlToYDoc(confluenceToHtml(mixed, '77')));
      // The real projection: the image is a block node, lifted out of the paragraph; since #1954 it keeps the
      // link on the node, so the room holds two pieces with the same unsafe carrier.
      expect(room).toBe(
        '<p>x <a target="_blank" rel="noopener noreferrer nofollow" href="#confluence-url:%2Frelative%2Fa?body=rich">foo</a></p>'
        + '<a target="_blank" rel="noopener noreferrer nofollow" href="#confluence-url:%2Frelative%2Fa?body=rich">'
        + '<img src="/api/attachments/77/i.png" alt="i.png" data-confluence-image-source="attachment" data-confluence-filename="i.png"></a>'
        + '<p> y</p>',
      );
      // Only one piece is written as the stored link; the image keeps its place, without inventing a second link.
      const first = htmlToConfluence(room, { linkOrigin: mixed });
      expect(first).toBe(
        '<p>x <ac:link><ri:url ri:value="/relative/a"></ri:url><ac:link-body>foo</ac:link-body></ac:link></p>'
        + '<ac:image><ri:attachment ri:filename="i.png"></ri:attachment></ac:image><p> y</p>',
      );
      expect(oracleUrlLinks(first)).toHaveLength(1);
      expect(htmlToConfluence(room, { linkOrigin: first })).toBe(first);
    });
  });

  describe('without the link-kinds feature (W7)', () => {
    const HOSTILE = [
      `<style>${raw()}</style>`,
      `<p title="a<b">x</p><style>${raw()}</style>`,
      `<p>${raw()}</p>`,
      `<p>${carrier()}</p>`,
      '<p><a href="https://example.com/" class="#confluence-url:https%3A%2F%2Fexample.com%2F">t</a></p>',
      '<p><a href="#confluence-space:OPS">OPS</a></p>',
    ];

    it('reads nothing, repairs nothing and refuses nothing: the write-back of the base commit', () => {
      const read = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      // The bytes of bff6d4ec for these inputs: raw markup and unknown carriers pass through as they are.
      expect(HOSTILE.map((html) => htmlToConfluence(html, { derivationFeatures: NO_STORAGE_DERIVATION_FEATURES }))).toEqual([
        // (the CDATA pass wraps a plain-text link body wherever its tags stand, raw text included)
        `<style>${written()}</style>`,
        `<p title="a<b">x</p><style>${written()}</style>`,
        `<p>${written()}</p>`,
        '<p><a href="#confluence-url:%2Frelative%2Fa?body=plain" data-confluence-link="url">x</a></p>',
        '<p><a href="https://example.com/" class="#confluence-url:https%3A%2F%2Fexample.com%2F">t</a></p>',
        '<p><a href="#confluence-space:OPS">OPS</a></p>',
      ]);
      expect(read).not.toHaveBeenCalled();
    });

    it('reads the stored tasks of previousStorage without the #1955 kinds, as the base commit did', () => {
      // A stored task whose text ends in a body-less blog-post link: without the feature its text is `Read `.
      const storedTask = '<ac:task-list><ac:task><ac:task-id>7</ac:task-id><ac:task-status>incomplete</ac:task-status>'
        + '<ac:task-body>Read <ac:link><ri:blog-post ri:content-title="Q3" /></ac:link></ac:task-body></ac:task></ac:task-list>';
      const idless = (text: string): string => `<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>${text}</p></li></ul>`;
      const base = { previousStorage: storedTask, derivationFeatures: NO_STORAGE_DERIVATION_FEATURES };
      expect(htmlToConfluence(idless('Read '), base)).toContain('<ac:task-id>7</ac:task-id>');
      expect(htmlToConfluence(idless('Read Q3'), base)).not.toContain('<ac:task-id>7</ac:task-id>');
      // With the feature the stored text includes the link's label.
      expect(htmlToConfluence(idless('Read Q3'), { previousStorage: storedTask })).toContain('<ac:task-id>7</ac:task-id>');
    });

    it('is what an ordinary writer never states: with no set, every case above is judged', () => {
      expect(refusal(HOSTILE[0]!)).toBe('unapproved-link');
      expect(refusal(HOSTILE[1]!)).toBe('not-well-formed');
      expect(htmlToConfluence(HOSTILE[2]!)).toBe('<p>x</p>');
      expect(htmlToConfluence(HOSTILE[3]!)).toBe('<p>x</p>');
      expect(htmlToConfluence(HOSTILE[4]!)).toBe('<p><ac:link><ri:url ri:value="https://example.com/"></ri:url>'
        + '<ac:plain-text-link-body><![CDATA[t]]></ac:plain-text-link-body></ac:link></p>');
      expect(htmlToConfluence(HOSTILE[5]!)).toBe('<p><ac:link><ri:space ri:space-key="OPS"></ri:space></ac:link></p>');
    });
  });
});
