/**
 * #1750: Confluence emoticons survive write-back. confluenceToHtml turns every
 * `ac:emoticon` into `<span class="confluence-emoticon">`, carrying every
 * attribute of the element, in source order, as one JSON object in
 * `data-emoticon-attrs`. The span holds no text: its label (an emoji, else
 * Confluence's own text form, drawn by CSS) and its accessible name are
 * attributes, so body text and embedding input stay as they were. htmlToConfluence writes exactly the carried
 * attributes back, self-closed as Confluence stores them, so an unchanged
 * emoticon goes back byte for byte. `confluenceEmoticon` declares the carrier
 * in both TipTap schemas; the frontend declaration is pinned by Editor.test.tsx
 * and ArticleViewer.test.tsx, the collab one here and in
 * collab-schema-parity.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import {
  confluenceToHtml,
  extractLayoutSkeleton,
  htmlToConfluence,
  htmlToMarkdown,
  htmlToText,
  markdownToHtml,
  protectMedia,
  restoreMedia,
} from './content-converter.js';
import { htmlToYDoc, yDocToHtml } from './collab-schema.js';

// Fixtures in Confluence's own serialization (`<ac:emoticon … />`, attributes in
// the order Confluence writes them, UTF-8 emoji written literally).
const TICK = '<ac:emoticon ac:name="tick" />';
const WARNING = '<ac:emoticon ac:name="warning" />';
const SMILE = '<ac:emoticon ac:name="smile" />';
// Verbatim from a Confluence Cloud space export (exportDescriptor.properties:
// source=cloud, createdByBuildNumber=7103, 2023-10-23), the attachment of
// jira.xwiki.org CONFLUENCE-146.
const CLOUD_CROSS =
  '<ac:emoticon ac:name="cross" ac:emoji-shortname=":cross_mark:" ac:emoji-id="atlassian-cross_mark" ac:emoji-fallback=":cross_mark:" />';
const CLOUD_LAUGH =
  '<ac:emoticon ac:name="laugh" ac:emoji-shortname=":grinning:" ac:emoji-id="1f600" ac:emoji-fallback="😀" />';
const CLOUD_PARTY =
  '<ac:emoticon ac:name="blue-star" ac:emoji-shortname=":partying_face:" ac:emoji-id="1f973" ac:emoji-fallback="🥳" />';
const CLOUD_BLUE_STAR = '<ac:emoticon ac:name="blue-star" />';
// Confluence 7.x and DC 8.5.6 exports quoted in jira.xwiki.org CONFLUENCE-255, a
// DC 8.x keycap in CONFLUENCE-470 (self-closing spelled ` />`, as Confluence
// writes it; the issue's copies were re-wrapped or written `"/>`).
const DC7_CHECK =
  '<ac:emoticon ac:name="blue-star" ac:emoji-shortname=":white_check_mark:" ac:emoji-id="2705" ac:emoji-fallback="✅" />';
const DC85_CLIPBOARD = '<ac:emoticon ac:name="clipboard" ac:emoji-id="1f4cb" />';
const DC8_KEYCAP = '<ac:emoticon ac:name="keycap: 1" ac:emoji-id="31-20e3" />';

const PAGE =
  `<p>Intro</p><p>State ${TICK} complete</p><p>Risk ${WARNING} open</p>`
  + `<p>Great job! ${SMILE}</p><p>Cloud ${CLOUD_CROSS} and ${CLOUD_LAUGH}</p>`;

/**
 * confluenceToHtml(PAGE), byte for byte: the node contract. The frontend
 * Editor and ArticleViewer tests (#1750) load this exact string.
 */
const PAGE_HTML =
  '<p>Intro</p>'
  + '<p>State <span class="confluence-emoticon" data-emoticon-attrs="{&quot;ac:name&quot;:&quot;tick&quot;}"'
  + ' data-emoticon-label="✅" role="img" aria-label="tick"></span> complete</p>'
  + '<p>Risk <span class="confluence-emoticon" data-emoticon-attrs="{&quot;ac:name&quot;:&quot;warning&quot;}"'
  + ' data-emoticon-label="⚠️" role="img" aria-label="warning"></span> open</p>'
  + '<p>Great job! <span class="confluence-emoticon" data-emoticon-attrs="{&quot;ac:name&quot;:&quot;smile&quot;}"'
  + ' data-emoticon-label="🙂" role="img" aria-label="smile"></span></p>'
  + '<p>Cloud <span class="confluence-emoticon" data-emoticon-attrs="{&quot;ac:name&quot;:&quot;cross&quot;,'
  + '&quot;ac:emoji-shortname&quot;:&quot;:cross_mark:&quot;,&quot;ac:emoji-id&quot;:&quot;atlassian-cross_mark&quot;,'
  + '&quot;ac:emoji-fallback&quot;:&quot;:cross_mark:&quot;}" data-emoticon-label="❌" role="img" aria-label="cross mark"></span>'
  + ' and <span class="confluence-emoticon" data-emoticon-attrs="{&quot;ac:name&quot;:&quot;laugh&quot;,'
  + '&quot;ac:emoji-shortname&quot;:&quot;:grinning:&quot;,&quot;ac:emoji-id&quot;:&quot;1f600&quot;,'
  + '&quot;ac:emoji-fallback&quot;:&quot;😀&quot;}" data-emoticon-label="😀" role="img" aria-label="grinning"></span></p>';

/** Every `ac:emoticon` element of a storage body, in document order, as written. */
function emoticons(xhtml: string): string[] {
  return xhtml.match(/<ac:emoticon\b[^>]*\/>/g) ?? [];
}

/** Each emoticon placeholder of an HTML body: its parsed carrier, label, accessible name and text. */
function placeholders(html: string): Array<{ attrs: unknown; label: string | null; name: string | null; text: string | null }> {
  const body = new JSDOM(`<body>${html}</body>`).window.document.body;
  return [...body.querySelectorAll('span.confluence-emoticon')].map((span) => ({
    attrs: JSON.parse(span.getAttribute('data-emoticon-attrs') ?? 'null'),
    label: span.getAttribute('data-emoticon-label'),
    name: span.getAttribute('aria-label'),
    text: span.textContent,
  }));
}

/** `<p>State X complete</p>`: an emoticon inside prose. */
const inProse = (emoticon: string): string => `<p>State ${emoticon} complete</p>`;

describe('content-converter: #1750 Confluence emoticons survive write-back', () => {
  describe('htmlToConfluence(confluenceToHtml(x))', () => {
    it.each([
      ['tick', TICK],
      ['warning', WARNING],
      ['smile', SMILE],
    ])('writes <ac:emoticon ac:name="%s" /> back byte for byte', (_name, emoticon) => {
      expect(htmlToConfluence(confluenceToHtml(inProse(emoticon)))).toBe(inProse(emoticon));
    });

    it.each([
      ['Cloud cross (atlassian-* id, shortname fallback)', CLOUD_CROSS],
      ['Cloud laugh (emoji fallback)', CLOUD_LAUGH],
      ['Cloud blue-star stand-in for a non-classic emoji', CLOUD_PARTY],
      ['Confluence 7 blue-star with all three ac:emoji-*', DC7_CHECK],
      ['DC 8.5 CLDR name + ac:emoji-id', DC85_CLIPBOARD],
      ['DC 8 keycap with a two-code-point id', DC8_KEYCAP],
    ])('writes an emoticon carrying ac:emoji-* attributes back byte for byte: %s', (_case, emoticon) => {
      expect(htmlToConfluence(confluenceToHtml(inProse(emoticon)))).toBe(inProse(emoticon));
    });

    it.each([
      ['no ac:name at all', '<ac:emoticon ac:emoji-shortname=":face_exhaling:" />'],
      ['an attribute no Confluence version is known to write', '<ac:emoticon ac:name="smile" ac:future-flag="kept" />'],
      ['ac:name not first', '<ac:emoticon ac:emoji-id="2705" ac:name="check mark button" />'],
      ['no attribute at all', '<ac:emoticon />'],
    ])('keeps every attribute in source order: %s', (_case, emoticon) => {
      expect(htmlToConfluence(confluenceToHtml(inProse(emoticon)))).toBe(inProse(emoticon));
    });

    it('keeps the text after an emoticon whose attribute value holds a slash', () => {
      // The self-closing expansion (`[^>/]*`) does not match such a tag, so the
      // HTML parser opens the element and nests the rest of the paragraph in it.
      const storage = '<p>State <ac:emoticon ac:name="tick" ac:emoji-fallback="a/b" /> complete</p><p>Next</p>';
      expect(htmlToConfluence(confluenceToHtml(storage))).toBe(storage);
    });

    it('keeps hostile attribute values (" < > &) inert and intact', () => {
      const storage = '<p><ac:emoticon ac:name="x&quot;&gt;&lt;br&gt;&amp;" ac:emoji-fallback="&lt;div class=&quot;y&quot;&gt;" /></p>';
      const html = confluenceToHtml(storage);
      // body_html: the values are inside one JSON attribute with `<` / `>` as
      // \u003c / \u003e, so no element or attribute escapes from them and the
      // placeholder's HTML holds no `<` or `>` outside its own tags.
      const body = new JSDOM(`<body>${html}</body>`).window.document.body;
      expect(body.querySelectorAll('br, div')).toHaveLength(0);
      const span = body.querySelector('span.confluence-emoticon');
      expect(span?.getAttributeNames()).toEqual(['class', 'data-emoticon-attrs', 'data-emoticon-label', 'role', 'aria-label']);
      // No `<` or `>` anywhere inside the placeholder's own tags: a label or name holding one is not used.
      expect(span?.outerHTML).toMatch(/^<span [^<>]*><\/span>$/);
      expect([span?.getAttribute('data-emoticon-label'), span?.getAttribute('aria-label')]).toEqual(['(emoticon)', 'emoticon']);
      expect(JSON.parse(span?.getAttribute('data-emoticon-attrs') ?? 'null'))
        .toEqual({ 'ac:name': 'x"><br>&', 'ac:emoji-fallback': '<div class="y">' });
      // Storage: escaped back to what Confluence wrote, through the converter and the collab schema.
      expect(htmlToConfluence(html)).toBe(storage);
      expect(htmlToConfluence(yDocToHtml(htmlToYDoc(html)))).toBe(storage);
    });

    it('writes a tab, line feed or carriage return in a value as a character reference', () => {
      // Written raw, XML attribute-value normalization would turn each into a space on Confluence's side.
      const storage = inProse('<ac:emoticon ac:name="a&#10;b" ac:emoji-fallback="&#9;x&#13;" />');
      const html = confluenceToHtml(storage);
      expect(placeholders(html).map((p) => p.attrs)).toEqual([{ 'ac:name': 'a\nb', 'ac:emoji-fallback': '\tx\r' }]);
      expect(htmlToConfluence(html)).toBe(storage);
      expect(htmlToConfluence(yDocToHtml(htmlToYDoc(html)))).toBe(storage);
    });

    it('carries and writes back a value holding a bidi override or a C1 control (only labels and names refuse them)', () => {
      const emoticon = '<ac:emoticon ac:name="\u202Ekcit" ac:emoji-fallback="\u0085x" />';
      const html = confluenceToHtml(inProse(emoticon));
      expect(placeholders(html).map((p) => p.attrs)).toEqual([{ 'ac:name': '\u202Ekcit', 'ac:emoji-fallback': '\u0085x' }]);
      expect(htmlToConfluence(html)).toBe(inProse(emoticon));
      expect(htmlToConfluence(yDocToHtml(htmlToYDoc(html)))).toBe(inProse(emoticon));
    });

    it('keeps emoticons inside a task, a link body, a table cell, a heading, a panel, an expand and an unknown macro', () => {
      const storage =
        `<ac:task-list><ac:task><ac:task-id>11</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Ship ${TICK} today</ac:task-body></ac:task></ac:task-list>`
        + `<p><ac:link><ri:page ri:content-title="Home" /><ac:link-body>Go ${SMILE}</ac:link-body></ac:link></p>`
        + `<table><tbody><tr><td><p>${TICK}</p></td></tr></tbody></table>`
        + `<h2>Release ${WARNING}</h2>`
        + `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Note ${CLOUD_LAUGH}</p></ac:rich-text-body></ac:structured-macro>`
        + `<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">More</ac:parameter><ac:rich-text-body><p>Hidden ${DC85_CLIPBOARD}</p></ac:rich-text-body></ac:structured-macro>`
        + `<ac:structured-macro ac:name="widget"><ac:rich-text-body><p>Unknown ${CLOUD_CROSS}</p></ac:rich-text-body></ac:structured-macro>`;
      const expected = [TICK, SMILE, TICK, WARNING, CLOUD_LAUGH, DC85_CLIPBOARD, CLOUD_CROSS];
      const html = confluenceToHtml(storage);
      expect(emoticons(htmlToConfluence(html))).toEqual(expected);
      expect(emoticons(htmlToConfluence(yDocToHtml(htmlToYDoc(html))))).toEqual(expected);
    });
  });

  describe('the placeholder', () => {
    it('carries every attribute in source order in data-emoticon-attrs, and holds no text', () => {
      expect(confluenceToHtml(PAGE)).toBe(PAGE_HTML);
    });

    it.each([
      ['tick', TICK, '✅'],
      ['warning', WARNING, '⚠️'],
      ['smile', SMILE, '🙂'],
      ['the classic emoji when the fallback is a shortname', CLOUD_CROSS, '❌'],
      ['the emoji in ac:emoji-fallback', CLOUD_LAUGH, '😀'],
      ['the code points of ac:emoji-id', DC85_CLIPBOARD, '📋'],
      ['a keycap id', DC8_KEYCAP, '1\u20E3'],
      ['the shortname when nothing gives an emoji', '<ac:emoticon ac:emoji-shortname=":face_exhaling:" />', ':face_exhaling:'],
      ['(name) for a classic emoticon without an emoji', CLOUD_BLUE_STAR, '(blue-star)'],
      ['(emoticon) when nothing names it', '<ac:emoticon />', '(emoticon)'],
      // Values XML allows, so they are carried (and written back), but no label may show them:
      // a bidi override, and a C1 control as a literal character (`&#x85;` would parse as `…`).
      ['the next candidate when one holds a bidi override', '<ac:emoticon ac:name="tick" ac:emoji-fallback="&#x202E;x" />', '✅'],
      ['the next candidate when one holds a C1 control', '<ac:emoticon ac:name="tick" ac:emoji-fallback="\u0085x" />', '✅'],
      ['(emoticon) when the only name holds a bidi override', '<ac:emoticon ac:name="&#x202E;kcit" />', '(emoticon)'],
      ['(emoticon) when the only name holds a C1 control', '<ac:emoticon ac:name="\u0085tick" />', '(emoticon)'],
    ])('labels %s', (_case, emoticon, label) => {
      expect(placeholders(confluenceToHtml(inProse(emoticon))).map((p) => p.label)).toEqual([label]);
    });

    it.each([
      ['tick', TICK, 'tick'],
      ['a classic name in words', '<ac:emoticon ac:name="thumbs-up" />', 'thumbs up'],
      ['the shortname over ac:name', CLOUD_CROSS, 'cross mark'],
      ['the shortname over a blue-star stand-in', CLOUD_PARTY, 'partying face'],
      ['a CLDR name', DC8_KEYCAP, 'keycap: 1'],
      ['emoticon when nothing names it', '<ac:emoticon />', 'emoticon'],
      ['emoticon when ac:name holds a bidi override', '<ac:emoticon ac:name="&#x202E;kcit" />', 'emoticon'],
      ['emoticon when ac:name holds a C1 control', '<ac:emoticon ac:name="\u0085tick" />', 'emoticon'],
      ['ac:name when the shortname holds a bidi override', '<ac:emoticon ac:name="tick" ac:emoji-shortname=":&#x202E;x:" />', 'tick'],
    ])('names %s, and holds no text', (_case, emoticon, name) => {
      expect(placeholders(confluenceToHtml(inProse(emoticon))).map((p) => [p.name, p.text])).toEqual([[name, '']]);
    });
  });

  describe('reverse pass', () => {
    it.each([
      ['no carrier', '<span class="confluence-emoticon">✅</span>'],
      ['a carrier that is not JSON', '<span class="confluence-emoticon" data-emoticon-attrs="{oops">✅</span>'],
      ['a carrier that is not an object', '<span class="confluence-emoticon" data-emoticon-attrs="[&quot;ac:name&quot;]">✅</span>'],
      ['a label but no carrier', '<span class="confluence-emoticon" data-emoticon-label="✅" role="img" aria-label="tick"></span>'],
    ])('writes a span the forward pass did not make (%s) as its label, inventing no emoticon', (_case, span) => {
      expect(htmlToConfluence(`<p>a ${span} b</p>`)).toBe('<p>a ✅ b</p>');
    });

    it('never carries or writes a namespace declaration (xmlns, xmlns:*)', () => {
      // From storage: the declaration is not carried, so it is not written back.
      expect(htmlToConfluence(confluenceToHtml(inProse('<ac:emoticon xmlns:ac="urn:x" ac:name="tick" xmlns="urn:y" />'))))
        .toBe(inProse(TICK));
      // From a carrier (pasted HTML): `xmlns:ac` would rebind the element's own prefix.
      const carrier = JSON.stringify({ xmlns: 'urn:y', 'xmlns:ac': 'urn:x', 'ac:name': 'tick', 'XMLNS:ri': 'urn:z' }).replace(/"/g, '&quot;');
      expect(htmlToConfluence(`<p><span class="confluence-emoticon" data-emoticon-attrs="${carrier}"></span></p>`))
        .toBe(`<p>${TICK}</p>`);
    });

    it('never carries or writes a value XML cannot hold or one over 1,024 characters', () => {
      const long = 'x'.repeat(1025);
      expect(htmlToConfluence(confluenceToHtml(inProse(`<ac:emoticon ac:name="tick" ac:future="${long}" />`))))
        .toBe(inProse(TICK));
      const carrier = JSON.stringify({ 'ac:name': 'tick', 'ac:bell': 'a\u0007b', 'ac:long': long, 'ac:emoji-id': '2705' })
        .replace(/"/g, '&quot;');
      expect(htmlToConfluence(`<p><span class="confluence-emoticon" data-emoticon-attrs="${carrier}"></span></p>`))
        .toBe('<p><ac:emoticon ac:name="tick" ac:emoji-id="2705" /></p>');
    });

    it('skips a carried attribute it cannot write: a name that is not an XML QName, a value that is not a string', () => {
      // `a b` and `1x` would make setAttribute throw; `ac:x:y` it would accept but XML namespaces do not.
      const carrier = JSON.stringify({ 'ac:name': 'tick', 'ac:x:y': 'z', 'a b': 'x', '1x': 'y', 'ac:n': 7, 'ac:emoji-id': '2705' })
        .replace(/"/g, '&quot;');
      expect(htmlToConfluence(`<p><span class="confluence-emoticon" data-emoticon-attrs="${carrier}">✅</span></p>`))
        .toBe('<p><ac:emoticon ac:name="tick" ac:emoji-id="2705" /></p>');
    });
  });

  describe('collab TipTap schema', () => {
    it('keeps every placeholder byte for byte (htmlToYDoc → yDocToHtml on getCollabSchema())', () => {
      expect(yDocToHtml(htmlToYDoc(PAGE_HTML))).toBe(PAGE_HTML);
    });

    it('keeps every emoticon through a collab load, an unrelated edit and write-back', () => {
      const doc = htmlToYDoc(confluenceToHtml(PAGE));
      // Type into the first paragraph, as a co-editor would; no emoticon is touched.
      const intro = doc.getXmlFragment('default').get(0);
      if (!(intro instanceof Y.XmlElement)) throw new Error('PAGE must open with a paragraph');
      const text = intro.get(0);
      if (!(text instanceof Y.XmlText)) throw new Error('the opening paragraph must hold text');
      text.insert(text.length, ' (edited)');

      expect(htmlToConfluence(yDocToHtml(doc))).toBe(PAGE.replace('<p>Intro</p>', '<p>Intro (edited)</p>'));
    });
  });

  describe('AI Improve round trip', () => {
    it('freezes each emoticon as its own inline <span> token, never as a div', () => {
      const { html, media } = protectMedia(PAGE_HTML);
      const spans = [...new JSDOM(`<body>${PAGE_HTML}</body>`).window.document.querySelectorAll('span.confluence-emoticon')]
        .map((span) => span.outerHTML);
      expect(media.map((entry) => entry.html)).toEqual(spans);
      expect(html).not.toContain('confluence-emoticon');
      // #1752 keeps a task item plain when a token's HTML holds a <div; even a
      // value that reads `<div` is \u003c-escaped in the carrier.
      const hostile = protectMedia(confluenceToHtml('<p><ac:emoticon ac:name="x" ac:emoji-fallback="&lt;div&gt;" /></p>'));
      expect(hostile.media).toHaveLength(1);
      expect(hostile.media[0]!.html).not.toMatch(/<div[\s/>]/i);
    });

    it('keeps every emoticon in a paragraph through Improve Accept, byte for byte', async () => {
      // The Improve apply exactly (llm-conversations.ts): protect → markdown → rebuild → restore → write back.
      const { html: protectedHtml, media } = protectMedia(confluenceToHtml(PAGE));
      const markdown = htmlToMarkdown(protectedHtml, { layoutTokens: true });
      const html = restoreMedia(
        await markdownToHtml(markdown, { layoutSkeleton: extractLayoutSkeleton(protectedHtml) }),
        media,
      );
      const xhtml = htmlToConfluence(html);
      expect(emoticons(xhtml)).toEqual([TICK, WARNING, SMILE, CLOUD_CROSS, CLOUD_LAUGH]);
      expect(xhtml).toContain(`<p>State ${TICK} complete</p>`);
      expect(xhtml).toContain(`<p>Great job! ${SMILE}</p>`);
    });

    it('restores a lone emoticon without its paragraph, as every inline placeholder since #901', async () => {
      // restoreMedia consumes a token's wrapping <p>: the emoticon survives byte for byte at block level.
      const { html: protectedHtml, media } = protectMedia(confluenceToHtml(`<p>${TICK}</p>`));
      const markdown = htmlToMarkdown(protectedHtml, { layoutTokens: true });
      const html = restoreMedia(
        await markdownToHtml(markdown, { layoutSkeleton: extractLayoutSkeleton(protectedHtml) }),
        media,
      );
      expect(htmlToConfluence(html)).toBe(`${TICK}\n`);
    });
  });

  describe('Markdown and plain text outside Improve', () => {
    // A guard (true before #1750 too, when emoticons were deleted): the
    // placeholder adds no text, so body_text, embedding input, Markdown context
    // and #1751's task text are unchanged by it.
    it('adds no text to Markdown or plain text', () => {
      const without = PAGE.replace(/<ac:emoticon\b[^>]*\/>/g, '');
      expect(htmlToMarkdown(confluenceToHtml(PAGE))).toBe(htmlToMarkdown(confluenceToHtml(without)));
      expect(htmlToText(confluenceToHtml(PAGE))).toBe(htmlToText(confluenceToHtml(without)));
    });
  });
});
