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

    it('loses an image-bodied link in the editor, as before #1748: the image is a block node (deferred, decisions.md item 9)', () => {
      // Pins today's editor behaviour (orchestrator decision on critique C2):
      // the converters keep the link (test above), the editor schema lifts the
      // block image out of the paragraph and the link is gone.
      const storage = '<p>See <ac:link><ri:page ri:content-title="Shared Assets" />'
        + '<ac:link-body><ac:image><ri:attachment ri:filename="thumbnail.png" /></ac:image></ac:link-body></ac:link> here.</p>';
      expect(htmlToConfluence(yDocToHtml(htmlToYDoc(confluenceToHtml(storage, '55'))))).toBe(
        '<p>See</p><ac:image><ri:attachment ri:filename="thumbnail.png"></ri:attachment></ac:image><p> here.</p>',
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
