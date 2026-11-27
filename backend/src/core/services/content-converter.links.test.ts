/**
 * #1748: Confluence page, attachment and anchor links survive write-back.
 * confluenceToHtml turns an `<ac:link>` into an `<a>` whose href carries the
 * whole link — `#confluence-page:<title>`, `#confluence-attachment:<filename>`
 * or `#confluence-anchor:<anchor>`, percent-encoded, then `?` and the link's
 * other attributes (confluence-link.ts) — because TipTap's Link mark keeps the
 * href and drops every data-* attribute when the editor saves. htmlToConfluence
 * rebuilds the `<ac:link>` from the href alone, with its body.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import {
  confluenceToHtml,
  extractLayoutSkeleton,
  htmlToConfluence,
  htmlToMarkdown,
  markdownToHtml,
  protectMedia,
  restoreMedia,
} from './content-converter.js';
import { htmlToYDoc, yDocToHtml } from './collab-schema.js';
import { confluenceLinkCarrier, confluenceLinkCarrierOf, confluenceLinkHrefAttributes } from './confluence-link.js';
import { logger } from '../utils/logger.js';

// Storage as Confluence writes it: self-closing resource elements, CDATA plain bodies.
const CROSS_SPACE =
  '<ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS" />'
  + '<ac:plain-text-link-body><![CDATA[see runbook]]></ac:plain-text-link-body></ac:link>';
const PAGE_ANCHOR = '<ac:link ac:anchor="Restore"><ri:page ri:content-title="Runbook" ri:space-key="OPS" /></ac:link>';
const SAME_PAGE_ANCHOR =
  '<ac:link ac:anchor="Restore"><ac:plain-text-link-body><![CDATA[jump to restore]]></ac:plain-text-link-body></ac:link>';
const ATTACHMENT =
  '<ac:link><ri:attachment ri:filename="report 2024.pdf" />'
  + '<ac:plain-text-link-body><![CDATA[quarterly report]]></ac:plain-text-link-body></ac:link>';
const CROSS_PAGE_ATTACHMENT =
  '<ac:link><ri:attachment ri:filename="logo.png"><ri:page ri:content-title="Shared Assets" ri:space-key="ENG" />'
  + '</ri:attachment></ac:link>';
const RICH =
  '<ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS" /><ac:link-body>the <strong>ops</strong> runbook</ac:link-body></ac:link>';

// What htmlToConfluence writes for each: the same elements, resource elements with an explicit end tag.
const CROSS_SPACE_OUT =
  '<ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS"></ri:page>'
  + '<ac:plain-text-link-body><![CDATA[see runbook]]></ac:plain-text-link-body></ac:link>';
const PAGE_ANCHOR_OUT = '<ac:link ac:anchor="Restore"><ri:page ri:content-title="Runbook" ri:space-key="OPS"></ri:page></ac:link>';
const ATTACHMENT_OUT =
  '<ac:link><ri:attachment ri:filename="report 2024.pdf"></ri:attachment>'
  + '<ac:plain-text-link-body><![CDATA[quarterly report]]></ac:plain-text-link-body></ac:link>';
const CROSS_PAGE_ATTACHMENT_OUT =
  '<ac:link><ri:attachment ri:filename="logo.png"><ri:page ri:content-title="Shared Assets" ri:space-key="ENG"></ri:page>'
  + '</ri:attachment></ac:link>';
const RICH_OUT =
  '<ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS"></ri:page>'
  + '<ac:link-body>the <strong>ops</strong> runbook</ac:link-body></ac:link>';

const PAGE =
  '<p>Intro</p>'
  + `<p>See ${CROSS_SPACE} first.</p>`
  + `<p>Then ${PAGE_ANCHOR} and ${SAME_PAGE_ANCHOR}.</p>`
  + `<p>Download ${ATTACHMENT} or ${CROSS_PAGE_ATTACHMENT}.</p>`
  + `<p>Read ${RICH}.</p>`;

const PAGE_OUT =
  '<p>Intro</p>'
  + `<p>See ${CROSS_SPACE_OUT} first.</p>`
  + `<p>Then ${PAGE_ANCHOR_OUT} and ${SAME_PAGE_ANCHOR}.</p>`
  + `<p>Download ${ATTACHMENT_OUT} or ${CROSS_PAGE_ATTACHMENT_OUT}.</p>`
  + `<p>Read ${RICH_OUT}.</p>`;

/** confluenceToHtml(PAGE), byte for byte: the href grammar is the node contract. */
const PAGE_HTML =
  '<p>Intro</p>'
  + '<p>See <a href="#confluence-page:Runbook?ri:space-key=OPS" data-confluence-link="page">see runbook</a> first.</p>'
  + '<p>Then <a href="#confluence-page:Runbook?ac:anchor=Restore&amp;ri:space-key=OPS" data-confluence-link="page">Runbook</a>'
  + ' and <a href="#confluence-anchor:Restore" data-confluence-link="anchor">jump to restore</a>.</p>'
  + '<p>Download <a href="#confluence-attachment:report%202024.pdf" data-confluence-link="attachment">quarterly report</a>'
  + ' or <a href="#confluence-attachment:logo.png?page.ri:content-title=Shared%20Assets&amp;page.ri:space-key=ENG"'
  + ' data-confluence-link="attachment">logo.png</a>.</p>'
  + '<p>Read <a href="#confluence-page:Runbook?ri:space-key=OPS" data-confluence-link="page">the <strong>ops</strong> runbook</a>.</p>';

/** Every `ac:link` element of a storage body, in document order, as written. */
function links(xhtml: string): string[] {
  return xhtml.match(/<ac:link\b[\s\S]*?<\/ac:link>/g) ?? [];
}

describe('content-converter: #1748 Confluence links survive write-back', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('htmlToConfluence(confluenceToHtml(x))', () => {
    it.each([
      ['a cross-space page link with a plain-text body', `<p>See ${CROSS_SPACE} first.</p>`, `<p>See ${CROSS_SPACE_OUT} first.</p>`],
      ['a page link with an anchor and no body', `<p>${PAGE_ANCHOR}</p>`, `<p>${PAGE_ANCHOR_OUT}</p>`],
      ['a link to an anchor on the page', `<p>${SAME_PAGE_ANCHOR}</p>`, `<p>${SAME_PAGE_ANCHOR}</p>`],
      [
        'a body-less, self-closing anchor link and what follows it',
        '<p>Go to <ac:link ac:anchor="Restore" /> now, ask <ac:link><ri:user ri:username="jdoe" /></ac:link>.</p>',
        '<p>Go to <ac:link ac:anchor="Restore"></ac:link> now, ask <ac:link><ri:user ri:username="jdoe"></ri:user></ac:link>.</p>',
      ],
      [
        'a self-closing anchor link whose anchor holds a slash, and the text after it',
        '<p>Go to <ac:link ac:anchor="Step 2/3" /> now.</p>',
        '<p>Go to <ac:link ac:anchor="Step 2/3"></ac:link> now.</p>',
      ],
      ['an attachment link with a plain-text body', `<p>${ATTACHMENT}</p>`, `<p>${ATTACHMENT_OUT}</p>`],
      ["a link to another page's attachment", `<p>${CROSS_PAGE_ATTACHMENT}</p>`, `<p>${CROSS_PAGE_ATTACHMENT_OUT}</p>`],
      ['a rich link body', `<p>${RICH}</p>`, `<p>${RICH_OUT}</p>`],
      [
        'ac:card-appearance, ri:version-at-save and a text-only ac:link-body (Confluence export, XWiki corpus)',
        '<p><ac:link ac:card-appearance="inline"><ri:page ri:content-title="Under Page A" ri:version-at-save="2" />'
        + '<ac:link-body>Under Page A</ac:link-body></ac:link></p>',
        '<p><ac:link ac:card-appearance="inline"><ri:page ri:content-title="Under Page A" ri:version-at-save="2"></ri:page>'
        + '<ac:link-body>Under Page A</ac:link-body></ac:link></p>',
      ],
      [
        'an attachment link with ri:version-at-save first (the title or filename is written first)',
        '<p><ac:link><ri:attachment ri:version-at-save="3" ri:filename="report.pdf" /></ac:link></p>',
        '<p><ac:link><ri:attachment ri:filename="report.pdf" ri:version-at-save="3"></ri:attachment></ac:link></p>',
      ],
      [
        'a plain-text body that repeats the title',
        '<p><ac:link><ri:page ri:content-title="Backup Procedures" />'
        + '<ac:plain-text-link-body><![CDATA[Backup Procedures]]></ac:plain-text-link-body></ac:link></p>',
        '<p><ac:link><ri:page ri:content-title="Backup Procedures"></ri:page>'
        + '<ac:plain-text-link-body><![CDATA[Backup Procedures]]></ac:plain-text-link-body></ac:link></p>',
      ],
      [
        'a title holding a slash (the self-closing ri:page swallows the body)',
        '<p><ac:link><ri:page ri:content-title="CI/CD Runbook" ri:space-key="OPS" />'
        + '<ac:plain-text-link-body><![CDATA[deploy guide]]></ac:plain-text-link-body></ac:link></p>',
        '<p><ac:link><ri:page ri:content-title="CI/CD Runbook" ri:space-key="OPS"></ri:page>'
        + '<ac:plain-text-link-body><![CDATA[deploy guide]]></ac:plain-text-link-body></ac:link></p>',
      ],
      [
        'markup characters, a personal space and a CDATA terminator',
        '<p><ac:link ac:anchor="Step 2: restore"><ri:page ri:content-title="Q&amp;A: &quot;Ops&quot; &lt;draft&gt; 100% #1 / ü"'
        + ' ri:space-key="~jsmith" /><ac:plain-text-link-body><![CDATA[a <b> & ]]]]><![CDATA[> c]]></ac:plain-text-link-body>'
        + '</ac:link></p>',
        '<p><ac:link ac:anchor="Step 2: restore"><ri:page ri:content-title="Q&amp;A: &quot;Ops&quot; &lt;draft&gt; 100% #1 / ü"'
        + ' ri:space-key="~jsmith"></ri:page><ac:plain-text-link-body><![CDATA[a <b> & ]]]]><![CDATA[> c]]>'
        + '</ac:plain-text-link-body></ac:link></p>',
      ],
    ])('rebuilds %s', (_case, storage, written) => {
      expect(htmlToConfluence(confluenceToHtml(storage))).toBe(written);
    });

    it('rebuilds an image link body, the image converted where it now sits', () => {
      const storage = '<p><ac:link><ri:page ri:content-title="Shared Assets" />'
        + '<ac:link-body><ac:image><ri:attachment ri:filename="thumbnail.png" /></ac:image></ac:link-body></ac:link></p>';
      expect(htmlToConfluence(confluenceToHtml(storage, '55'))).toBe(
        '<p><ac:link><ri:page ri:content-title="Shared Assets"></ri:page>'
        + '<ac:link-body><ac:image><ri:attachment ri:filename="thumbnail.png"></ri:attachment></ac:image></ac:link-body></ac:link></p>',
      );
    });

    it('keeps an image-bodied link through the collab schema: one ac:link around the block image (#1954)', () => {
      // The image is still a block node, so it leaves the paragraph as before;
      // the link now rides on the image node (`href`) and comes back around it.
      const storage = '<p>See <ac:link><ri:page ri:content-title="Shared Assets" />'
        + '<ac:link-body><ac:image><ri:attachment ri:filename="thumbnail.png" /></ac:image></ac:link-body></ac:link> here.</p>';
      expect(htmlToConfluence(yDocToHtml(htmlToYDoc(confluenceToHtml(storage, '55'))))).toBe(
        '<p>See</p><ac:link><ri:page ri:content-title="Shared Assets"></ri:page><ac:link-body><ac:image>'
        + '<ri:attachment ri:filename="thumbnail.png"></ri:attachment></ac:image></ac:link-body></ac:link><p> here.</p>',
      );
    });

    it('drops what a link holds besides its resource and body, as before #1748; an anchor link without a body moves it out', () => {
      expect(htmlToConfluence(confluenceToHtml(
        '<p><ac:link><ri:page ri:content-title="Runbook" /><ac:plain-text-link-body><![CDATA[go]]></ac:plain-text-link-body>'
        + '<span>stray</span></ac:link></p>',
      ))).toBe(
        '<p><ac:link><ri:page ri:content-title="Runbook"></ri:page><ac:plain-text-link-body><![CDATA[go]]></ac:plain-text-link-body></ac:link></p>',
      );
      expect(htmlToConfluence(confluenceToHtml('<p><ac:link ac:anchor="Restore"><span>stray</span></ac:link> after</p>')))
        .toBe('<p><ac:link ac:anchor="Restore"></ac:link><span>stray</span> after</p>');
    });

    it('keeps links inside a task, a panel, an expand, a table cell and a layout cell', () => {
      const storage =
        `<ac:task-list><ac:task><ac:task-id>7</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Check ${CROSS_SPACE}</ac:task-body></ac:task></ac:task-list>`
        + `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>${PAGE_ANCHOR}</p></ac:rich-text-body></ac:structured-macro>`
        + `<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">More</ac:parameter><ac:rich-text-body><p>${ATTACHMENT}</p></ac:rich-text-body></ac:structured-macro>`
        + `<table><tbody><tr><td>${CROSS_PAGE_ATTACHMENT}</td></tr></tbody></table>`
        + `<ac:layout><ac:layout-section ac:type="single"><ac:layout-cell><p>${SAME_PAGE_ANCHOR}</p></ac:layout-cell></ac:layout-section></ac:layout>`;
      expect(links(htmlToConfluence(confluenceToHtml(storage)))).toEqual([
        CROSS_SPACE_OUT, PAGE_ANCHOR_OUT, ATTACHMENT_OUT, CROSS_PAGE_ATTACHMENT_OUT, SAME_PAGE_ANCHOR,
      ]);
    });
  });

  describe('the href', () => {
    it('carries the percent-encoded title, filename or anchor, then the ac:*, ri:* and container attributes in source order', () => {
      expect(confluenceToHtml(PAGE)).toBe(PAGE_HTML);
    });

    it('never carries or writes a namespace declaration', () => {
      const storage = '<p><ac:link xmlns:ac="http://atlassian.com/content">'
        + '<ri:page xmlns:ri="http://atlassian.com/resource/identifier" ri:content-title="Runbook" /></ac:link></p>';
      expect(htmlToConfluence(confluenceToHtml(storage))).toBe('<p><ac:link><ri:page ri:content-title="Runbook"></ri:page></ac:link></p>');
    });

    it('skips and logs an attribute it cannot carry: a value over 1,024 characters or one XML forbids', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
      const storage = `<p><ac:link ac:card-appearance="${'x'.repeat(1025)}">`
        + '<ri:page ri:content-title="Runbook" ri:version-at-save="&#1;" /></ac:link></p>';
      expect(htmlToConfluence(confluenceToHtml(storage))).toBe('<p><ac:link><ri:page ri:content-title="Runbook"></ri:page></ac:link></p>');
      expect(warn).toHaveBeenCalledWith(
        { attributes: ['ac:card-appearance', 'ri:version-at-save'], count: 2 },
        'Confluence link attributes not carried (#1748)',
      );
    });

    it('carries at most 16 attributes of an element and logs the rest', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
      const attrs = Array.from({ length: 17 }, (_, i) => `ac:x-${i}="${i}"`);
      const storage = `<p><ac:link ${attrs.join(' ')}><ri:page ri:content-title="Runbook" ri:space-key="OPS" /></ac:link></p>`;
      expect(htmlToConfluence(confluenceToHtml(storage))).toBe(
        `<p><ac:link ${attrs.slice(0, 16).join(' ')}><ri:page ri:content-title="Runbook" ri:space-key="OPS"></ri:page></ac:link></p>`,
      );
      expect(warn).toHaveBeenCalledWith({ attributes: ['ac:x-16'], count: 1 }, 'Confluence link attributes not carried (#1748)');
    });

    it('keeps the href within 16,384 characters and logs the attributes that do not fit', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
      // Each value is 1,024 CJK characters: 9,216 characters once encoded.
      const cjk = '中'.repeat(1024);
      const storage = `<p><ac:link ac:a="${cjk}" ac:b="${cjk}" ac:c="${cjk}"><ri:page ri:content-title="Runbook" /></ac:link></p>`;
      const html = confluenceToHtml(storage);
      expect(new JSDOM(html).window.document.querySelector('a')!.getAttribute('href')!.length).toBeLessThanOrEqual(16_384);
      expect(htmlToConfluence(html)).toBe(`<p><ac:link ac:a="${cjk}"><ri:page ri:content-title="Runbook"></ri:page></ac:link></p>`);
      expect(warn).toHaveBeenCalledWith({ attributes: ['ac:b', 'ac:c'], count: 2 }, 'Confluence link attributes not carried (#1748)');
    });

    it('carries a container name of up to 32 characters and an attribute local name of up to 64, and logs longer ones', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
      const local = 'n'.repeat(64);
      const longLocal = 'o'.repeat(65);
      const container = 'c'.repeat(32);
      const longContainer = 'd'.repeat(33);
      const storage = `<p><ac:link ac:${local}="1" ac:${longLocal}="2"><ri:attachment ri:filename="logo.png">`
        + `<ri:${container} ri:content-title="Shared"></ri:${container}></ri:attachment></ac:link>`
        + ` <ac:link><ri:attachment ri:filename="logo.png"><ri:${longContainer} ri:content-title="Shared"></ri:${longContainer}>`
        + '</ri:attachment></ac:link></p>';
      expect(htmlToConfluence(confluenceToHtml(storage))).toBe(
        `<p><ac:link ac:${local}="1"><ri:attachment ri:filename="logo.png">`
        + `<ri:${container} ri:content-title="Shared"></ri:${container}></ri:attachment></ac:link>`
        + ' <ac:link><ri:attachment ri:filename="logo.png"></ri:attachment></ac:link></p>',
      );
      expect(warn).toHaveBeenCalledWith({ attributes: [`ac:${longLocal}`], count: 1 }, 'Confluence link attributes not carried (#1748)');
      expect(warn).toHaveBeenCalledWith({ attributes: [`ri:${longContainer}`], count: 1 }, 'Confluence link attributes not carried (#1748)');
    });
  });

  describe('reverse pass', () => {
    it('rebuilds a link from an href written before #1748: the title or filename as written, nothing else', () => {
      const html = '<p><a href="#confluence-page:Release Notes" data-confluence-link="page">Release Notes</a>'
        + ' <a href="#confluence-attachment:report 2024.pdf">quarterly report</a></p>';
      expect(htmlToConfluence(html)).toBe(
        '<p><ac:link><ri:page ri:content-title="Release Notes"></ri:page></ac:link>'
        + ' <ac:link><ri:attachment ri:filename="report 2024.pdf"></ri:attachment>'
        + '<ac:plain-text-link-body><![CDATA[quarterly report]]></ac:plain-text-link-body></ac:link></p>',
      );
    });

    it('reads an href written before #1748 that also parses as the grammar by the grammar (accepted): `A%20B`, `x?body=plain`', () => {
      // Every href written since #1748 is encoded, so the encoded reading wins;
      // an older title that happens to look encoded is read as the decoded one.
      expect(htmlToConfluence('<p><a href="#confluence-page:A%20B">A%20B</a></p>')).toBe(
        '<p><ac:link><ri:page ri:content-title="A B"></ri:page>'
        + '<ac:plain-text-link-body><![CDATA[A%20B]]></ac:plain-text-link-body></ac:link></p>',
      );
      expect(htmlToConfluence('<p><a href="#confluence-page:x?body=plain">x?body=plain</a></p>')).toBe(
        '<p><ac:link><ri:page ri:content-title="x"></ri:page>'
        + '<ac:plain-text-link-body><![CDATA[x?body=plain]]></ac:plain-text-link-body></ac:link></p>',
      );
    });

    it('follows an edited link text: new wording is a plain-text body, the title again is no body, markup is ac:link-body', () => {
      const href = '#confluence-page:Runbook?ri:space-key=OPS';
      const page = '<ri:page ri:content-title="Runbook" ri:space-key="OPS"></ri:page>';
      expect(htmlToConfluence(`<p><a href="${href}">the ops runbook</a></p>`))
        .toBe(`<p><ac:link>${page}<ac:plain-text-link-body><![CDATA[the ops runbook]]></ac:plain-text-link-body></ac:link></p>`);
      expect(htmlToConfluence(`<p><a href="${href}">Runbook</a></p>`)).toBe(`<p><ac:link>${page}</ac:link></p>`);
      expect(htmlToConfluence(`<p><a href="${href}"><em>Runbook</em></a></p>`))
        .toBe(`<p><ac:link>${page}<ac:link-body><em>Runbook</em></ac:link-body></ac:link></p>`);
    });

    it('writes <, >, tab, line feed, carriage return and no-break space in a value as character references', () => {
      const storage = '<p><ac:link ac:anchor="a&#9;b&#10;c&#13;d"><ri:page ri:content-title="x &lt; y &gt; z&#160;w" /></ac:link></p>';
      expect(htmlToConfluence(confluenceToHtml(storage)))
        .toBe('<p><ac:link ac:anchor="a&#9;b&#10;c&#13;d"><ri:page ri:content-title="x &lt; y &gt; z&#160;w"></ri:page></ac:link></p>');
    });

    // A guard (true before #1748 too, when no href was converted): an href
    // that breaks the grammar's rules is not a link #1748 can write, so the
    // <a> stays as it is rather than turn into an element Confluence refuses.
    it.each([
      ['a repeated parameter', '#confluence-page:Runbook?ri:space-key=OPS&amp;ri:space-key=ENG'],
      ['the title twice', '#confluence-page:Runbook?ri:content-title=Other'],
      ['a resource attribute on an anchor link', '#confluence-anchor:Restore?ri:space-key=OPS'],
      ['a container on a page link', '#confluence-page:Runbook?page.ri:content-title=Other'],
      ['two containers', '#confluence-attachment:a.png?page.ri:content-title=A&amp;blog-post.ri:content-title=B'],
      ['an unknown body', '#confluence-page:Runbook?body=html'],
      ['a control character XML forbids', '#confluence-page:Run%01book'],
      ['bytes that are not UTF-8', '#confluence-page:%C3'],
      ['a value over 1,024 characters', `#confluence-page:${'a'.repeat(1025)}`],
      ['an anchor outside the grammar', '#confluence-anchor:Step 2'],
      ['17 attributes of one element', `#confluence-page:Runbook?${Array.from({ length: 17 }, (_, i) => `ac:x-${i}=${i}`).join('&amp;')}`],
      ['over 16,384 characters (16 attributes of 1,024)', `#confluence-page:Runbook?${Array.from({ length: 16 }, (_, i) => `ac:x-${i}=${'a'.repeat(1024)}`).join('&amp;')}`],
    ])('leaves an href with %s as the <a> it is', (_case, href) => {
      const html = `<p><a href="${href}">x</a></p>`;
      expect(htmlToConfluence(html)).toBe(html);
    });
  });

  describe('collab TipTap schema', () => {
    it('keeps every link through a collab load, an unrelated edit and write-back', () => {
      const doc = htmlToYDoc(confluenceToHtml(PAGE));
      // Type into the first paragraph, as a co-editor would; no link is touched.
      const intro = doc.getXmlFragment('default').get(0);
      if (!(intro instanceof Y.XmlElement)) throw new Error('PAGE must open with a paragraph');
      const text = intro.get(0);
      if (!(text instanceof Y.XmlText)) throw new Error('the opening paragraph must hold text');
      text.insert(text.length, ' (edited)');

      expect(htmlToConfluence(yDocToHtml(doc))).toBe(PAGE_OUT.replace('<p>Intro</p>', '<p>Intro (edited)</p>'));
    });

    it('loses a link whose text is inline code and splits one around inline code or a line break, as before #1748 (deferred, decisions.md item 12)', () => {
      // Pins today's editor behaviour (orchestrator decision on review r1 F1.1):
      // the converters keep these links, but StarterKit's Code mark excludes
      // every other mark, so the Link mark leaves inline code, and Yjs keeps
      // marks on text only, so a line break splits the link in two.
      const save = (body: string): string => htmlToConfluence(yDocToHtml(htmlToYDoc(confluenceToHtml(
        `<p>See <ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS" /><ac:link-body>${body}</ac:link-body></ac:link> here.</p>`,
      ))));
      const plain = (text: string): string => '<ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS"></ri:page>'
        + `<ac:plain-text-link-body><![CDATA[${text}]]></ac:plain-text-link-body></ac:link>`;
      expect(save('<code>deploy()</code>')).toBe('<p>See <code>deploy()</code> here.</p>');
      expect(save('run <code>deploy()</code> now')).toBe(`<p>See ${plain('run ')}<code>deploy()</code>${plain(' now')} here.</p>`);
      expect(save('line one<br />line two')).toBe(`<p>See ${plain('line one')}<br />${plain('line two')} here.</p>`);
    });
  });

  describe('AI Improve round trip', () => {
    /**
     * The non-model steps of Improve, as llm-conversations.ts runs them:
     * protect → Markdown → (the model, not called: its output is this Markdown
     * unchanged) → HTML → restore → write back. The route itself is covered by
     * apply-improvement.test.ts.
     */
    async function improveAccept(storage: string): Promise<string> {
      const { html: protectedHtml, media } = protectMedia(confluenceToHtml(storage));
      const markdown = htmlToMarkdown(protectedHtml, { layoutTokens: true });
      const html = restoreMedia(
        await markdownToHtml(markdown, { layoutSkeleton: extractLayoutSkeleton(protectedHtml) }),
        media,
      );
      return htmlToConfluence(html);
    }

    it('keeps every link through the Improve conversion chain (no model call): the href is a Markdown link destination', async () => {
      expect(links(await improveAccept(PAGE))).toEqual(links(PAGE_OUT));
      // Markdown's own characters in the title and the text, and a CDATA terminator.
      const hostile = '<p>Ask <ac:link ac:anchor="Step 2: restore"><ri:page ri:content-title="Q&amp;A: (v2) [draft] *x* _y_ ~z" ri:space-key="~jsmith" />'
        + '<ac:plain-text-link-body><![CDATA[a *b* _c_ [d] & ]]]]><![CDATA[> e]]></ac:plain-text-link-body></ac:link> now.</p>';
      expect(await improveAccept(hostile)).toBe(
        '<p>Ask <ac:link ac:anchor="Step 2: restore"><ri:page ri:content-title="Q&amp;A: (v2) [draft] *x* _y_ ~z" ri:space-key="~jsmith"></ri:page>'
        + '<ac:plain-text-link-body><![CDATA[a *b* _c_ [d] & ]]]]><![CDATA[> e]]></ac:plain-text-link-body></ac:link> now.</p>\n',
      );
    });
  });
});

/**
 * #1955: links to a blog post, a space, a shortcut, a content entity and a URL
 * are carried like the three #1748 kinds. A `ri:url` is a real href only for
 * a lowercase http, https or mailto URL; any other value is an inert
 * `#confluence-url:` carrier, and such a link is written back only as an
 * occurrence the stored page already holds (content-converter.link-origin.test.ts).
 */
describe('content-converter: #1955 blog-post, space, shortcut, content-entity and url links survive write-back', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Storage as Confluence writes it.
  const BLOG_POST =
    '<ac:link><ri:blog-post ri:content-title="Q3 Update" ri:posting-day="2024/05/01" ri:space-key="ENG" />'
    + '<ac:plain-text-link-body><![CDATA[read the update]]></ac:plain-text-link-body></ac:link>';
  const SPACE = '<ac:link><ri:space ri:space-key="OPS" /></ac:link>';
  const SHORTCUT =
    '<ac:link><ri:shortcut ri:key="jira" ri:parameter="ABC-1" />'
    + '<ac:plain-text-link-body><![CDATA[ABC-1]]></ac:plain-text-link-body></ac:link>';
  const CONTENT_ENTITY =
    '<ac:link><ri:content-entity ri:content-id="12345" /><ac:link-body>the <strong>doc</strong></ac:link-body></ac:link>';
  const URL_HTTPS =
    '<ac:link><ri:url ri:value="https://example.com/a?b=1&amp;c=2" />'
    + '<ac:plain-text-link-body><![CDATA[example]]></ac:plain-text-link-body></ac:link>';
  const URL_MAILTO = '<ac:link><ri:url ri:value="mailto:a@b.c" /></ac:link>';
  const URL_REL =
    '<ac:link><ri:url ri:value="/relative/a" /><ac:plain-text-link-body><![CDATA[docs]]></ac:plain-text-link-body></ac:link>';
  const URL_JS =
    '<ac:link><ri:url ri:value="javascript:alert(1)" /><ac:plain-text-link-body><![CDATA[click]]></ac:plain-text-link-body></ac:link>';
  const URL_EMPTY = '<ac:link><ri:url ri:value="" /></ac:link>';

  /** What write-back writes for storage as Confluence writes it: resource elements with an explicit end tag. */
  const out = (storage: string): string => storage.replace(/<(ri:[a-z-]+)((?: [^\s="]+="[^"]*")*) \/>/g, '<$1$2></$1>');

  const KINDS_PAGE =
    `<p>News: ${BLOG_POST}.</p>`
    + `<p>Space ${SPACE} and ticket ${SHORTCUT}.</p>`
    + `<p>See ${CONTENT_ENTITY}.</p>`
    + `<p>Web ${URL_HTTPS}, mail ${URL_MAILTO}.</p>`
    + `<p>Old ${URL_REL}, odd ${URL_JS}, none ${URL_EMPTY}.</p>`;

  /** confluenceToHtml(KINDS_PAGE), byte for byte. */
  const KINDS_HTML =
    '<p>News: <a href="#confluence-blog-post:Q3%20Update?ri:posting-day=2024%2F05%2F01&amp;ri:space-key=ENG&amp;body=plain"'
    + ' data-confluence-link="blog-post">read the update</a>.</p>'
    + '<p>Space <a href="#confluence-space:OPS" data-confluence-link="space">OPS</a>'
    + ' and ticket <a href="#confluence-shortcut:jira?ri:parameter=ABC-1&amp;body=plain" data-confluence-link="shortcut">ABC-1</a>.</p>'
    + '<p>See <a href="#confluence-content-entity:12345?body=rich" data-confluence-link="content-entity">the <strong>doc</strong></a>.</p>'
    + '<p>Web <a href="https://example.com/a?b=1&amp;c=2"'
    + ' class="#confluence-url:https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2?body=plain" data-confluence-link="url">example</a>,'
    + ' mail <a href="mailto:a@b.c" class="#confluence-url:mailto%3Aa%40b.c" data-confluence-link="url">mailto:a@b.c</a>.</p>'
    + '<p>Old <a href="#confluence-url:%2Frelative%2Fa?body=plain" data-confluence-link="url">docs</a>,'
    + ' odd <a href="#confluence-url:javascript%3Aalert%281%29?body=plain" data-confluence-link="url">click</a>,'
    + ' none <a href="#confluence-url:" data-confluence-link="url">(empty link)</a>.</p>';

  /** Round trip with the page's own storage as the origin of its ri:url links. */
  const roundTrip = (storage: string): string => htmlToConfluence(confluenceToHtml(storage), { previousStorage: storage });

  describe('htmlToConfluence(confluenceToHtml(x))', () => {
    it.each([
      ['a blog post with a plain body, a posting day and a space key', BLOG_POST],
      ['a space without a body', SPACE],
      ['a shortcut with its parameter', SHORTCUT],
      ['a content entity with a rich body', CONTENT_ENTITY],
      ['an https URL with a plain body', URL_HTTPS],
      ['a mailto URL without a body', URL_MAILTO],
      ['a relative URL', URL_REL],
      ['a javascript: URL', URL_JS],
      ['an empty URL', URL_EMPTY],
      [
        'ac:* attributes on a blog-post link',
        '<ac:link ac:card-appearance="inline" ac:anchor="Top"><ri:blog-post ri:content-title="Q3" ri:posting-day="2024/05/01" /></ac:link>',
      ],
      [
        'a text-only rich body',
        '<ac:link><ri:space ri:space-key="OPS" /><ac:link-body>the ops space</ac:link-body></ac:link>',
      ],
      [
        'a plain body equal to the value',
        '<ac:link><ri:shortcut ri:key="jira" /><ac:plain-text-link-body><![CDATA[jira]]></ac:plain-text-link-body></ac:link>',
      ],
      [
        'a version on a content entity',
        '<ac:link><ri:content-entity ri:content-id="12345" ri:version-at-save="3" /></ac:link>',
      ],
      [
        '<, >, tab and line feed in a parameter',
        '<ac:link><ri:shortcut ri:key="search" ri:parameter="a&lt;b&gt;c&#9;d&#10;e &amp; f" /></ac:link>',
      ],
      [
        'a URL holding a quote, an ampersand, markup and a media token spelling',
        '<ac:link><ri:url ri:value="https://example.com/&quot;q&quot;?a=1&amp;b=&lt;b&gt;CQ_MEDIA_PLACEHOLDER_0" /></ac:link>',
      ],
      [
        'a mailto URL with headers',
        '<ac:link><ri:url ri:value="mailto:?to=a@b.c&amp;subject=Hi%20there" />'
        + '<ac:plain-text-link-body><![CDATA[write]]></ac:plain-text-link-body></ac:link>',
      ],
      [
        'extra attributes on an unsafe URL link',
        '<ac:link ac:anchor="x"><ri:url ri:value="/relative/a" ri:note="n" /><ac:link-body>the <em>docs</em></ac:link-body></ac:link>',
      ],
    ])('rebuilds %s', (_name, storage) => {
      expect(roundTrip(`<p>See ${storage} here.</p>`)).toBe(`<p>See ${out(storage)} here.</p>`);
    });

    it('rebuilds a page holding every kind, and converts what it wrote to the same HTML again', () => {
      const html = confluenceToHtml(KINDS_PAGE);
      expect(html).toBe(KINDS_HTML);
      expect(roundTrip(KINDS_PAGE)).toBe(out(KINDS_PAGE));
      expect(confluenceToHtml(roundTrip(KINDS_PAGE))).toBe(html);
    });

    it('writes the primary attribute first, as #1748 does: Atlassian\'s own order for a blog post is normalised', () => {
      const atlassian = '<ac:link><ri:blog-post ri:space-key="ENG" ri:content-title="First Post" ri:posting-day="2012/01/30" /></ac:link>';
      expect(roundTrip(`<p>${atlassian}</p>`)).toBe(
        '<p><ac:link><ri:blog-post ri:content-title="First Post" ri:space-key="ENG" ri:posting-day="2012/01/30"></ri:blog-post></ac:link></p>',
      );
    });

    it('keeps the links inside a task, a table cell and a layout cell', () => {
      const storage =
        '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status>'
        + `<ac:task-body>Read ${out(BLOG_POST)} and ${out(URL_REL)}</ac:task-body></ac:task></ac:task-list>`
        + `<table><tbody><tr><td><p>${out(SPACE)}</p></td></tr></tbody></table>`
        + `<ac:layout><ac:layout-section ac:type="single"><ac:layout-cell><p>${out(SHORTCUT)}</p></ac:layout-cell></ac:layout-section></ac:layout>`;
      expect(links(roundTrip(storage))).toEqual(links(storage));
    });

    it('still writes a resource it does not know, and a primary value no href can carry, as text only', () => {
      expect(confluenceToHtml('<p><ac:link><ri:unknown ri:x="1" /><ac:plain-text-link-body><![CDATA[t]]></ac:plain-text-link-body></ac:link></p>'))
        .toBe('<p><a>t</a></p>');
      expect(confluenceToHtml(`<p><ac:link><ri:space ri:space-key="${'a'.repeat(1025)}" /></ac:link> x</p>`)).toBe('<p><a></a> x</p>');
      expect(confluenceToHtml('<p><ac:link><ri:blog-post ri:posting-day="2024/05/01" /></ac:link> x</p>')).toBe('<p><a></a> x</p>');
    });
  });

  describe('the body', () => {
    // V6: an authored body is never mistaken for "no body", whatever an editor does to its text.
    const blog = (primary: string, body: string): string => `<p>x <ac:link><ri:blog-post ri:content-title="${primary}" />${body}</ac:link> y</p>`;
    const plain = (text: string): string => `<ac:plain-text-link-body><![CDATA[${text}]]></ac:plain-text-link-body>`;
    const viaCollab = (storage: string): string =>
      htmlToConfluence(yDocToHtml(htmlToYDoc(confluenceToHtml(storage))), { linkOrigin: storage });

    it.each([
      ['a plain body that only differs from the value by white space', 'Q3 x', plain('Q3  x'), plain('Q3 x')],
      // The collaborative schema moves a link's leading space out of it and its trailing space in.
      ['a plain body with white space at its ends', 'Q3', plain(' Q3 '), plain('Q3 ')],
      ['the literal label of an empty value as an authored body', '', plain('(empty link)'), plain('(empty link)')],
      ['a plain body equal to the value', 'Q3', plain('Q3'), plain('Q3')],
      ['a rich body whose text is the value', 'Q3 x', '<ac:link-body><span>Q3 x</span></ac:link-body>', '<ac:link-body>Q3 x</ac:link-body>'],
      ['a rich body with markup', 'Q3', '<ac:link-body>the <strong>post</strong></ac:link-body>', '<ac:link-body>the <strong>post</strong></ac:link-body>'],
    ])('carries the kind of %s', (_name, primary, body, afterEditor) => {
      const storage = blog(primary, body);
      const html = confluenceToHtml(storage);
      expect(html).toContain(body.startsWith('<ac:link-body') ? 'body=rich' : 'body=plain');
      // The converter alone writes the body back byte for byte.
      expect(htmlToConfluence(html)).toBe(out(storage));
      // An editor may normalise the text; the body and its kind stay.
      const link = (body: string): string => `<ac:link><ri:blog-post ri:content-title="${primary}"></ri:blog-post>${body}</ac:link>`;
      expect(links(viaCollab(storage))).toEqual([link(afterEditor)]);
    });

    it('carries the body kind of a ri:url link the same way, in the class of a navigable one', () => {
      const html = confluenceToHtml('<p><ac:link><ri:url ri:value="https://example.com/" />'
        + '<ac:plain-text-link-body><![CDATA[https://example.com/]]></ac:plain-text-link-body></ac:link></p>');
      expect(html).toBe('<p><a href="https://example.com/" class="#confluence-url:https%3A%2F%2Fexample.com%2F?body=plain"'
        + ' data-confluence-link="url">https://example.com/</a></p>');
      expect(htmlToConfluence(html)).toBe('<p><ac:link><ri:url ri:value="https://example.com/"></ri:url>'
        + '<ac:plain-text-link-body><![CDATA[https://example.com/]]></ac:plain-text-link-body></ac:link></p>');
    });

    it('treats a blank explicit body as no body, as #1748 does for its kinds (pinned normalisation)', () => {
      for (const body of [plain(' '), plain(''), '<ac:link-body></ac:link-body>', '<ac:link-body> \n</ac:link-body>']) {
        const html = confluenceToHtml(blog('Q3', body));
        expect(html).toBe('<p>x <a href="#confluence-blog-post:Q3" data-confluence-link="blog-post">Q3</a> y</p>');
        expect(htmlToConfluence(html)).toBe('<p>x <ac:link><ri:blog-post ri:content-title="Q3"></ri:blog-post></ac:link> y</p>');
      }
      // The same shapes on a page link are what they were before #1955.
      const page = '<p>x <ac:link><ri:page ri:content-title="Q3" /><ac:plain-text-link-body><![CDATA[ ]]></ac:plain-text-link-body></ac:link> y</p>';
      expect(confluenceToHtml(page)).toBe('<p>x <a href="#confluence-page:Q3" data-confluence-link="page">Q3</a> y</p>');
    });

    it('follows an edited link text: new wording is a plain body, the display text again is no body', () => {
      const html = confluenceToHtml(`<p>${SPACE}</p>`);
      expect(htmlToConfluence(html.replace('>OPS<', '>the ops space<'))).toBe(
        '<p><ac:link><ri:space ri:space-key="OPS"></ri:space><ac:plain-text-link-body><![CDATA[the ops space]]></ac:plain-text-link-body></ac:link></p>',
      );
      expect(htmlToConfluence(html)).toBe('<p><ac:link><ri:space ri:space-key="OPS"></ri:space></ac:link></p>');
    });

    it('leaves the body rule of a page, attachment and anchor link as it was: the hint only when the text cannot tell', () => {
      expect(confluenceToHtml(PAGE)).toBe(PAGE_HTML);
      expect(PAGE_HTML).not.toContain('body=');
    });
  });

  describe('a value an editor cannot show', () => {
    // M4/C5: text that is only white space does not survive an editor, and a link without text is no link there.
    it.each([
      ['an empty value', '', '(empty link)'],
      ['a space', ' ', '(empty link)'],
      ['a tab', '&#9;', '(empty link)'],
      ['a line feed', '&#10;', '(empty link)'],
      ['a no-break space', '&#160;', '(empty link)'],
      ['white space at the ends', ' Q3 ', 'Q3'],
      ['two spaces inside', 'Q3  x', 'Q3 x'],
      ['a tab inside', 'Q3&#9;x', 'Q3 x'],
    ])('shows a label for %s and writes the value back as it was', async (_name, value, label) => {
      for (const [resource, kind, attribute] of [['ri:blog-post', 'blog-post', 'ri:content-title'], ['ri:url', 'url', 'ri:value']] as const) {
        const storage = `<p>before <ac:link><${resource} ${attribute}="${value}" /></ac:link> after</p>`;
        const written = `<p>before <ac:link><${resource} ${attribute}="${value}"></${resource}></ac:link> after</p>`;
        const html = confluenceToHtml(storage);
        expect(html).toContain(`data-confluence-link="${kind}">${label}</a>`);
        expect(htmlToConfluence(html, { previousStorage: storage })).toBe(written);
        // Through the collaborative schema and through Improve the link is still there, with its value.
        expect(htmlToConfluence(yDocToHtml(htmlToYDoc(html)), { linkOrigin: storage })).toBe(written);
        const improved = await markdownToHtml(htmlToMarkdown(html, { layoutTokens: true }));
        expect(htmlToConfluence(improved, { previousStorage: storage }).trim()).toBe(written);
      }
    });
  });

  describe('ri:url', () => {
    it.each([
      'http://example.com/',
      'https://example.com/path?x=1#frag',
      'mailto:a@b.c',
      'mailto:?to=a@b.c&amp;subject=Hi%20there',
    ])('writes %s as a real href with the carrier in the class', (value) => {
      const html = confluenceToHtml(`<p><ac:link><ri:url ri:value="${value}" /></ac:link></p>`);
      const a = new JSDOM(html).window.document.querySelector('a')!;
      expect(a.getAttribute('href')).toBe(value.replace(/&amp;/g, '&'));
      expect(a.getAttribute('class')).toMatch(/^#confluence-url:[A-Za-z0-9%._~-]+$/);
      // No origin is needed: a navigable URL is a link anyone may write.
      expect(htmlToConfluence(html)).toBe(`<p><ac:link><ri:url ri:value="${value}"></ri:url></ac:link></p>`);
    });

    it.each([
      ['javascript:', 'javascript:alert(1)'],
      ['mixed-case javascript:', 'JavaScript:alert(1)'],
      ['upper-case javascript:', 'JAVASCRIPT:alert(1)'],
      ['a tab inside the scheme', 'java&#9;script:alert(1)'],
      ['a line feed inside the scheme', 'java&#10;script:alert(1)'],
      ['an entity-encoded scheme letter', '&#x6A;avascript:alert(1)', 'javascript:alert(1)'],
      ['an entity-encoded colon', 'javascript&#58;alert(1)', 'javascript:alert(1)'],
      ['a leading space', ' javascript:alert(1)'],
      ['data:', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
      ['vbscript:', 'vbscript:msgbox(1)'],
      ['file:', 'file:///etc/passwd'],
      ['ftp:', 'ftp://example.com/'],
      ['an upper-case allowed scheme', 'HTTPS://example.com/'],
      ['a mixed-case allowed scheme', 'Https://example.com/'],
      ['upper-case mailto', 'MAILTO:a@b.c'],
      ['a leading space before https', ' https://example.com/'],
      ['a trailing space', 'https://example.com/ '],
      ['an embedded space', 'https://example.com/a b'],
      ['a tab after the scheme', 'https:&#9;//example.com/'],
      ['a zero-width space', 'https://exa&#x200B;mple.com/', 'https://exa\u200Bmple.com/'],
      ['a right-to-left override', 'https://example.com/&#x202E;gnp.exe', 'https://example.com/\u202Egnp.exe'],
      ['a protocol-relative URL', '//evil.example/'],
      ['an absolute path', '/relative'],
      ['a relative path', 'relative.html'],
      ['a query', '?q=1'],
      ['a fragment', '#frag'],
      ['an empty value', ''],
    ])('keeps %s an inert carrier that still writes back', (_name, value, written = value) => {
      const storage = `<p>see <ac:link><ri:url ri:value="${value}" /><ac:plain-text-link-body><![CDATA[t]]></ac:plain-text-link-body></ac:link> now</p>`;
      const html = confluenceToHtml(storage);
      const anchors = [...new JSDOM(html).window.document.querySelectorAll('a')];
      expect(anchors).toHaveLength(1);
      const href = anchors[0]!.getAttribute('href')!;
      // A fragment of this page, whatever the value: its own characters are all percent-encoded.
      expect(href.startsWith('#confluence-url:')).toBe(true);
      expect(href.slice('#confluence-url:'.length).split('?')[0]).toMatch(/^[A-Za-z0-9%._~-]*$/);
      expect(anchors[0]!.hasAttribute('class')).toBe(false);
      expect(new URL(href, 'https://kb.example/pages/1').origin).toBe('https://kb.example');
      // The collaborative schema keeps it a fragment too.
      expect(yDocToHtml(htmlToYDoc(html))).toContain(`href="${href.replace(/&/g, '&amp;')}"`);
      expect(yDocToHtml(htmlToYDoc(html))).not.toMatch(/href="(?!#confluence-url:)/);
      // With the page's own storage as origin it writes back as it was (a character reference that
      // XML does not need is written as the character, as for every attribute); without, it is text.
      expect(htmlToConfluence(html, { previousStorage: storage })).toBe(out(storage).replace(`"${value}"`, `"${written}"`));
      expect(htmlToConfluence(html)).toBe('<p>see t now</p>');
    });

    it('reads the class only as the carrier of the anchor\'s own URL', () => {
      const carrier = '#confluence-url:https%3A%2F%2Fexample.com%2F?ac:anchor=x';
      const written = '<p><ac:link ac:anchor="x"><ri:url ri:value="https://example.com/"></ri:url></ac:link></p>';
      expect(htmlToConfluence(`<p><a href="https://example.com/" class="${carrier}">https://example.com/</a></p>`)).toBe(written);
      for (const html of [
        // Another URL than the carrier's, a non-navigable href, a second class token, the prefix alone.
        `<p><a href="https://example.com/other" class="${carrier}">t</a></p>`,
        '<p><a href="javascript:alert(1)" class="#confluence-url:javascript%3Aalert%281%29">t</a></p>',
        `<p><a href="https://example.com/" class="${carrier} extra">t</a></p>`,
        '<p><a href="https://example.com/" class="#confluence-url:">t</a></p>',
      ]) {
        expect(htmlToConfluence(html)).toBe(html);
      }
    });

    it('leaves an ordinary link as the <a> it is, with or without the editor\'s target and rel', () => {
      const pasted = '<p><a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com/x">plain</a></p>';
      expect(htmlToConfluence(pasted)).toBe(pasted);
      expect(htmlToConfluence('<p><a href="https://example.com/x" title="T" class="k">plain</a></p>'))
        .toBe('<p><a href="https://example.com/x" title="T" class="k">plain</a></p>');
    });
  });

  describe('the href', () => {
    it('skips and logs an attribute it cannot carry, under the caps of #1748', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const attrs = Array.from({ length: 17 }, (_, i) => `ri:x-${i}="${i}"`).join(' ');
      const html = confluenceToHtml(`<p><ac:link><ri:shortcut ri:key="jira" ${attrs} /></ac:link></p>`);
      expect(new JSDOM(html).window.document.querySelector('a')!.getAttribute('href')!.split('&')).toHaveLength(16);
      expect(warn).toHaveBeenCalledWith({ attributes: ['ri:x-16'], count: 1 }, 'Confluence link attributes not carried (#1748)');
    });

    it('keeps the class of a navigable URL within 16,384 characters and logs the attributes that do not fit', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const big = '日'.repeat(1024);
      const html = confluenceToHtml(
        `<p><ac:link ac:a="${big}" ac:b="${big}" ac:c="${big}"><ri:url ri:value="https://example.com/" />`
        + '<ac:plain-text-link-body><![CDATA[t]]></ac:plain-text-link-body></ac:link></p>',
      );
      const a = new JSDOM(html).window.document.querySelector('a')!;
      expect(a.getAttribute('href')).toBe('https://example.com/');
      expect(a.getAttribute('class')!.length).toBeLessThanOrEqual(16_384);
      // W5: the body kind is kept; an optional attribute gives way instead.
      expect(a.getAttribute('class')!.endsWith('&body=plain')).toBe(true);
      expect(warn).toHaveBeenCalledWith({ attributes: ['ac:b', 'ac:c'], count: 2 }, 'Confluence link attributes not carried (#1748)');
      expect(htmlToConfluence(html)).toBe(
        `<p><ac:link ac:a="${big}"><ri:url ri:value="https://example.com/"></ri:url>`
        + '<ac:plain-text-link-body><![CDATA[t]]></ac:plain-text-link-body></ac:link></p>',
      );
    });

    it.each([
      ['an unencoded value', '#confluence-space:A B'],
      ['a container on a blog post', '#confluence-blog-post:X?page.ri:space-key=ENG'],
      ['a repeated parameter', '#confluence-shortcut:X?ri:parameter=a&amp;ri:parameter=b'],
      ['the primary attribute as a parameter', '#confluence-content-entity:1?ri:content-id=2'],
      ['17 attributes of one element', `#confluence-space:X?${Array.from({ length: 17 }, (_, i) => `ac:x-${i}=${i}`).join('&amp;')}`],
      ['over 16,384 characters', `#confluence-url:${'a'.repeat(1024)}?${Array.from({ length: 16 }, (_, i) => `ac:x-${i}=${'a'.repeat(1024)}`).join('&amp;')}`],
      ['a value over 1,024 characters', `#confluence-url:${'a'.repeat(1025)}`],
    ])('leaves an href with %s as the <a> it is', (_case, href) => {
      const html = `<p><a href="${href}">x</a></p>`;
      expect(htmlToConfluence(html)).toBe(html);
    });
  });

  // What #1953 reconciles a row synced before #1955 with: the carrier of a link its body_storage holds.
  describe('the carrier of a stored link', () => {
    // The document the forward pass reads: resource elements with an end tag, CDATA as text.
    const acLinks = (storage: string): Element[] => {
      const prepared = out(storage).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
      return [...new JSDOM(`<body>${prepared}</body>`).window.document.getElementsByTagName('ac:link')];
    };

    it('is the kind, href and class confluenceToHtml writes for every link of the page', () => {
      const anchors = [...new JSDOM(KINDS_HTML).window.document.querySelectorAll('a')];
      const carriers = acLinks(KINDS_PAGE).map((link) => confluenceLinkCarrier(link)!);

      expect(carriers.map((carrier) => [carrier.kind, carrier.href, carrier.className]))
        .toEqual(anchors.map((a) => [a.getAttribute('data-confluence-link'), a.getAttribute('href'), a.getAttribute('class')]));
      carriers.forEach((carrier, index) => {
        expect(carrier.carrier).toBe(carrier.className ?? carrier.href);
        expect(confluenceLinkCarrierOf(anchors[index]!)).toBe(carrier.carrier);
      });
      expect(carriers[0]).toEqual({
        kind: 'blog-post',
        carrier: '#confluence-blog-post:Q3%20Update?ri:posting-day=2024%2F05%2F01&ri:space-key=ENG&body=plain',
        href: '#confluence-blog-post:Q3%20Update?ri:posting-day=2024%2F05%2F01&ri:space-key=ENG&body=plain',
        className: null,
        value: 'Q3 Update',
        text: 'read the update',
        dropped: [],
      });
      expect(carriers[4]).toEqual({
        kind: 'url',
        carrier: '#confluence-url:https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2?body=plain',
        href: 'https://example.com/a?b=1&c=2',
        className: '#confluence-url:https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2?body=plain',
        value: 'https://example.com/a?b=1&c=2',
        text: 'example',
        dropped: [],
      });
      // Without a plain body the text is what the link shows without one; a rich body is the element's own.
      expect(carriers.map((carrier) => carrier.text))
        .toEqual(['read the update', 'OPS', 'ABC-1', '12345', 'example', 'mailto:a@b.c', 'docs', 'click', '(empty link)']);
    });

    it('is pure: nothing is logged and the link is not changed, even with an attribute the href cannot carry', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const attrs = Array.from({ length: 17 }, (_, i) => `ri:x-${i}="${i}"`).join(' ');
      const [link] = acLinks(`<p><ac:link><ri:shortcut ri:key="jira" ${attrs} /></ac:link></p>`);
      const before = link!.outerHTML;

      const carrier = confluenceLinkCarrier(link!)!;

      expect(carrier.dropped).toEqual(['ri:x-16']);
      expect(carrier.carrier.split('&')).toHaveLength(16);
      expect(link!.outerHTML).toBe(before);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([
      ['a mention', '<ac:link><ri:user ri:userkey="u1" /></ac:link>'],
      ['a resource without its value', '<ac:link><ri:space /></ac:link>'],
      ['a value XML cannot hold in the cap', `<ac:link><ri:url ri:value="${'a'.repeat(1025)}" /></ac:link>`],
    ])('is none for %s', (_case, storage) => {
      expect(confluenceLinkCarrier(acLinks(storage)[0]!)).toBeNull();
    });

    it('gives the href and class of a carrier, and reads the carrier back from them alone', () => {
      const web = '#confluence-url:https%3A%2F%2Fexample.com%2F';
      const odd = '#confluence-url:javascript%3Aalert%281%29';
      expect(confluenceLinkHrefAttributes(web)).toEqual({ href: 'https://example.com/', className: web });
      expect(confluenceLinkHrefAttributes(odd)).toEqual({ href: odd, className: null });
      expect(confluenceLinkHrefAttributes('#confluence-space:ENG')).toEqual({ href: '#confluence-space:ENG', className: null });
      expect(confluenceLinkHrefAttributes('https://example.com/')).toBeNull();

      const element = (attributes: string): Element =>
        new JSDOM(`<a ${attributes}>x</a>`).window.document.querySelector('a')!;
      expect(confluenceLinkCarrierOf(element(`href="https://example.com/" class="${web}"`))).toBe(web);
      expect(confluenceLinkCarrierOf(element(`href="${odd}"`))).toBe(odd);
      // A class is a carrier only for its own element's href, and only as the whole class.
      expect(confluenceLinkCarrierOf(element(`href="https://example.com/other" class="${web}"`))).toBeNull();
      expect(confluenceLinkCarrierOf(element(`href="https://example.com/" class="x ${web}"`))).toBeNull();
      expect(confluenceLinkCarrierOf(element(`href="javascript:alert(1)" class="${odd}"`))).toBeNull();
      expect(confluenceLinkCarrierOf(element(`class="${web}"`))).toBeNull();
      expect(confluenceLinkCarrierOf(element('href="https://example.com/"'))).toBeNull();
    });
  });

  describe('collab TipTap schema', () => {
    it('keeps every #1955 link through a collab load, an unrelated edit and write-back', () => {
      const doc = htmlToYDoc(confluenceToHtml(KINDS_PAGE));
      const first = doc.getXmlFragment('default').get(0);
      if (!(first instanceof Y.XmlElement)) throw new Error('KINDS_PAGE must open with a paragraph');
      const text = first.get(0);
      if (!(text instanceof Y.XmlText)) throw new Error('the opening paragraph must open with text');
      text.insert(0, 'Edited. ');

      const room = yDocToHtml(doc);
      // Every unsafe value is still a fragment in the room.
      for (const a of new JSDOM(room).window.document.querySelectorAll('a')) {
        expect(a.getAttribute('href')).toMatch(/^(#confluence-|https:\/\/example\.com\/|mailto:a@b\.c$)/);
      }
      // A collaborative Save passes the stored storage as the links' origin.
      expect(htmlToConfluence(room, { linkOrigin: KINDS_PAGE }))
        .toBe(out(KINDS_PAGE).replace('<p>News: ', '<p>Edited. News: '));
      // Without it the three unsafe URL links are text, and every other link is still a link.
      expect(links(htmlToConfluence(room))).toEqual(links(out(KINDS_PAGE)).slice(0, 6));
    });
  });

  describe('AI Improve round trip', () => {
    async function improveAccept(storage: string): Promise<string> {
      const { html: protectedHtml, media } = protectMedia(confluenceToHtml(storage));
      const markdown = htmlToMarkdown(protectedHtml, { layoutTokens: true });
      const html = restoreMedia(
        await markdownToHtml(markdown, { layoutSkeleton: extractLayoutSkeleton(protectedHtml) }),
        media,
      );
      return htmlToConfluence(html, { previousStorage: storage });
    }

    it('keeps every #1955 link through the Improve conversion chain (no model call)', async () => {
      expect(links(await improveAccept(KINDS_PAGE))).toEqual(links(out(KINDS_PAGE)));
    });

    it('writes the carrier of a navigable URL as the Markdown destination on Improve only', () => {
      const html = confluenceToHtml(`<p>Web ${URL_HTTPS}, mail ${URL_MAILTO}.</p>`);
      expect(htmlToMarkdown(html, { layoutTokens: true })).toBe(
        'Web [example](#confluence-url:https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2?body=plain),'
        + ' mail [mailto:a@b.c](#confluence-url:mailto%3Aa%40b.c).',
      );
      // Embeddings, diffs, tagging, quality and sub-page context get the URL, as for any link.
      expect(htmlToMarkdown(html)).toBe('Web [example](https://example.com/a?b=1&c=2), mail [mailto:a@b.c](mailto:a@b.c).');
      expect(htmlToMarkdown(html)).toBe(htmlToMarkdown('<p>Web <a href="https://example.com/a?b=1&amp;c=2">example</a>,'
        + ' mail <a href="mailto:a@b.c">mailto:a@b.c</a>.</p>'));
    });

    it('keeps a link title and an ordinary link as the stock rule writes them', () => {
      const carrier = '#confluence-url:https%3A%2F%2Fexample.com%2F';
      expect(htmlToMarkdown(`<p><a href="https://example.com/" class="${carrier}" title='say "hi"'>t</a></p>`, { layoutTokens: true }))
        .toBe(`[t](${carrier} "say \\"hi\\"")`);
      expect(htmlToMarkdown('<p><a href="https://example.com/x" class="k">plain</a></p>', { layoutTokens: true }))
        .toBe('[plain](https://example.com/x)');
    });

    it('turns the carrier of a navigable URL back into the real link, on parsed anchors only', async () => {
      const carrier = '#confluence-url:https%3A%2F%2Fexample.com%2F%22q%22%3Fa%3D1%26b%3D%3Cb%3E?body=plain';
      const html = await markdownToHtml(`See [t](${carrier}) and \`${carrier}\`.\n\n    ${carrier}\n\nPlain ${carrier} text.`);
      const doc = new JSDOM(html).window.document;
      const anchors = [...doc.querySelectorAll('a')];
      expect(anchors).toHaveLength(1);
      expect(anchors[0]!.getAttribute('href')).toBe('https://example.com/"q"?a=1&b=<b>');
      expect(anchors[0]!.getAttribute('class')).toBe(carrier);
      // The value's own quote, ampersand and markup made no element and no attribute.
      expect(doc.querySelectorAll('b')).toHaveLength(0);
      expect(anchors[0]!.getAttributeNames().sort()).toEqual(['class', 'href']);
      expect(doc.querySelector('p code')!.textContent).toBe(carrier);
      expect(doc.querySelector('pre code')!.textContent).toBe(`${carrier}\n`);
      expect(doc.body.textContent).toContain(`Plain ${carrier} text.`);
    });

    it('leaves a carrier that is not navigable, an anchor with a class and a string without a carrier as they are', async () => {
      const inert = '<p><a href="#confluence-url:javascript%3Aalert%281%29">j</a></p>';
      expect((await markdownToHtml(inert)).trim()).toBe(inert);
      const classed = '<p><a href="#confluence-url:https%3A%2F%2Fexample.com%2F" class="mine">c</a></p>';
      expect((await markdownToHtml(classed)).trim()).toBe(classed);
      const raw = '<p><a href="#confluence-url:https%3A%2F%2Fexample.com%2F">r</a></p>';
      expect((await markdownToHtml(raw)).trim())
        .toBe('<p><a href="https://example.com/" class="#confluence-url:https%3A%2F%2Fexample.com%2F">r</a></p>');
      // Nothing to do: the very string marked wrote, not a re-serialisation of it.
      expect(await markdownToHtml('A [link](https://example.com/?a=1&b=2) &amp; text')).toBe(
        '<p>A <a href="https://example.com/?a=1&b=2">link</a> &amp; text</p>\n',
      );
    });
  });

  describe('stored tasks', () => {
    const task = (body: string): string =>
      `<ac:task-list><ac:task><ac:task-id>7</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>${body}</ac:task-body></ac:task></ac:task-list>`;

    it('keeps the id of a task that holds a body-less #1955 link', () => {
      const storage = task(`Read ${SPACE}`);
      const html = confluenceToHtml(storage);
      expect(html).toContain('data-task-id="7"');
      expect(htmlToConfluence(html, { previousStorage: storage })).toBe(task(`Read ${out(SPACE)}`));
      // An id-less task with the same text takes the stored id by its text, which now includes the link's label.
      const idless = html.replace(' data-task-id="7"', '');
      expect(htmlToConfluence(idless, { previousStorage: storage })).toBe(task(`Read ${out(SPACE)}`));
    });
  });
});
