/**
 * #1954: Confluence links whose body is an image, inline code or a line break.
 *
 * The converters always kept these links; the editor schemas lost them. These
 * tests drive the converter, the collab schema (`save`) and the non-collab
 * editor path (`edit`: the same schema without Yjs) end to end.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { generateHTML, generateJSON } from '@tiptap/html';
import type { JSONContent } from '@tiptap/core';
import { collabExtensions, htmlToYDoc, yDocToHtml } from './collab-schema.js';
import {
  confluenceToHtml,
  extractLayoutSkeleton,
  htmlToConfluence,
  htmlToMarkdown,
  markdownToHtml,
  protectMedia,
  restoreMedia,
} from './content-converter.js';

/** What a collaborative Save writes: the room's HTML, written back with the stored storage as origin. */
function save(storage: string): string {
  return htmlToConfluence(yDocToHtml(htmlToYDoc(confluenceToHtml(storage, '55'))), { previousStorage: storage });
}

/** What an ordinary editor Save writes: the editor schema without Yjs, then the same write-back. */
function edit(storage: string): string {
  const html = confluenceToHtml(storage, '55');
  const saved = generateHTML(generateJSON(html, collabExtensions()) as JSONContent, collabExtensions());
  return htmlToConfluence(saved, { previousStorage: storage });
}

/** The non-model steps of AI Improve, as the Accept route runs them; the model echoes the Markdown unchanged. */
async function improveAccept(html: string, storage: string): Promise<{ markdown: string; html: string; storage: string }> {
  const { html: protectedHtml, media } = protectMedia(html);
  const markdown = htmlToMarkdown(protectedHtml, { layoutTokens: true });
  const back = restoreMedia(await markdownToHtml(markdown, { layoutSkeleton: extractLayoutSkeleton(protectedHtml) }), media);
  return { markdown, html: back, storage: htmlToConfluence(back, { previousStorage: storage }) };
}

const IMAGE = '<ac:image><ri:attachment ri:filename="thumbnail.png" /></ac:image>';
const IMAGE_OUT = '<ac:image><ri:attachment ri:filename="thumbnail.png"></ri:attachment></ac:image>';

describe('content-converter: a Confluence link whose body is an image (#1954)', () => {
  describe('every link kind keeps its image body', () => {
    // [kind, the resource and link attributes, as Confluence writes them, then as write-back writes them]
    const kinds: Array<[string, string, string]> = [
      ['page', '<ac:link><ri:page ri:content-title="Shared Assets" ri:space-key="ENG" />',
        '<ac:link><ri:page ri:content-title="Shared Assets" ri:space-key="ENG"></ri:page>'],
      ['attachment', '<ac:link><ri:attachment ri:filename="report.pdf" />',
        '<ac:link><ri:attachment ri:filename="report.pdf"></ri:attachment>'],
      ['anchor', '<ac:link ac:anchor="Gallery">', '<ac:link ac:anchor="Gallery">'],
      ['blog-post', '<ac:link><ri:blog-post ri:content-title="Q3" ri:posting-day="2024/05/01" />',
        '<ac:link><ri:blog-post ri:content-title="Q3" ri:posting-day="2024/05/01"></ri:blog-post>'],
      ['space', '<ac:link><ri:space ri:space-key="ENG" />', '<ac:link><ri:space ri:space-key="ENG"></ri:space>'],
      ['shortcut', '<ac:link><ri:shortcut ri:key="jira" ri:parameter="ABC-1" />',
        '<ac:link><ri:shortcut ri:key="jira" ri:parameter="ABC-1"></ri:shortcut>'],
      ['content-entity', '<ac:link><ri:content-entity ri:content-id="123" />',
        '<ac:link><ri:content-entity ri:content-id="123"></ri:content-entity>'],
      ['navigable ri:url', '<ac:link><ri:url ri:value="https://example.com/z" />',
        '<ac:link><ri:url ri:value="https://example.com/z"></ri:url>'],
      ['stored relative ri:url', '<ac:link><ri:url ri:value="/docs/guide" />',
        '<ac:link><ri:url ri:value="/docs/guide"></ri:url>'],
    ];

    it.each(kinds)('a %s link, through the converter, a collaborative Save and an editor Save', (_kind, open, openOut) => {
      const storage = `<p>${open}<ac:link-body>${IMAGE}</ac:link-body></ac:link></p>`;
      const link = `${openOut}<ac:link-body>${IMAGE_OUT}</ac:link-body></ac:link>`;
      expect(htmlToConfluence(confluenceToHtml(storage, '55'), { previousStorage: storage })).toBe(`<p>${link}</p>`);
      // The image is a block node: it leaves its paragraph, exactly as an unlinked image does.
      expect(save(storage)).toBe(`<p></p>${link}`);
      expect(edit(storage)).toBe(`<p></p>${link}`);
    });

    it('moves the link with the image as an unlinked image moves: the only difference is the ac:link around it', () => {
      const linked = '<p>See <ac:link><ri:page ri:content-title="Shared Assets" />'
        + `<ac:link-body>${IMAGE}</ac:link-body></ac:link> here.</p>`;
      const unlinked = `<p>See ${IMAGE} here.</p>`;
      const wrap = (image: string): string =>
        `<ac:link><ri:page ri:content-title="Shared Assets"></ri:page><ac:link-body>${image}</ac:link-body></ac:link>`;
      expect(save(linked)).toBe(save(unlinked).replace(IMAGE_OUT, wrap(IMAGE_OUT)));
      expect(edit(linked)).toBe(save(linked));
    });
  });

  describe('bodies that hold more than one image, or an image and text (documented)', () => {
    it('gives each image of a link its own ac:link to the same target', () => {
      const storage = `<p><ac:link><ri:page ri:content-title="Gallery" /><ac:link-body>${IMAGE}`
        + '<ac:image><ri:attachment ri:filename="b.png" /></ac:image></ac:link-body></ac:link></p>';
      const one = (image: string): string =>
        `<ac:link><ri:page ri:content-title="Gallery"></ri:page><ac:link-body>${image}</ac:link-body></ac:link>`;
      expect(save(storage)).toBe(`<p></p>${one(IMAGE_OUT)}${one('<ac:image><ri:attachment ri:filename="b.png"></ri:attachment></ac:image>')}`);
    });

    it('splits a link mixing an image and text into one link per piece, each to the same target', () => {
      const storage = `<p><ac:link><ri:page ri:content-title="Gallery" /><ac:link-body>before ${IMAGE} after</ac:link-body></ac:link></p>`;
      const page = '<ri:page ri:content-title="Gallery"></ri:page>';
      expect(save(storage)).toBe(
        `<p><ac:link>${page}<ac:plain-text-link-body><![CDATA[before]]></ac:plain-text-link-body></ac:link></p>`
        + `<ac:link>${page}<ac:link-body>${IMAGE_OUT}</ac:link-body></ac:link>`
        + `<p><ac:link>${page}<ac:plain-text-link-body><![CDATA[ after]]></ac:plain-text-link-body></ac:link></p>`,
      );
    });
  });

  describe('the image resource inside the link', () => {
    it('keeps an image owned by another page and an external image', () => {
      const owner = '<p><ac:link><ri:page ri:content-title="Runbook" /><ac:link-body><ac:image><ri:attachment ri:filename="o.png">'
        + '<ri:page ri:content-title="Shared Assets" ri:space-key="ENG" /></ri:attachment></ac:image></ac:link-body></ac:link></p>';
      expect(save(owner)).toBe(
        '<p></p><ac:link><ri:page ri:content-title="Runbook"></ri:page><ac:link-body><ac:image><ri:attachment ri:filename="o.png">'
        + '<ri:page ri:content-title="Shared Assets" ri:space-key="ENG"></ri:page></ri:attachment></ac:image></ac:link-body></ac:link>',
      );
      const external = '<p><ac:link><ri:url ri:value="https://example.com/doc" /><ac:link-body><ac:image>'
        + '<ri:url ri:value="https://cdn.example.com/x.png" /></ac:image></ac:link-body></ac:link></p>';
      expect(save(external)).toBe(
        '<p></p><ac:link><ri:url ri:value="https://example.com/doc"></ri:url><ac:link-body><ac:image>'
        + '<ri:url ri:value="https://cdn.example.com/x.png"></ri:url></ac:image></ac:link-body></ac:link>',
      );
    });

    // The HTML an editor holds after a copy out of read mode and a paste (Editor.test.tsx, the same fixture).
    it('writes back the HTML of a linked image copied out of read mode and pasted into the editor (M9)', () => {
      const pasted = readFileSync(new URL('./__fixtures__/linked-image-copy.html', import.meta.url), 'utf8').trim();
      expect(htmlToConfluence(pasted)).toBe(
        '<p>Owner</p><p></p><ac:link><ri:page ri:content-title="Runbook"></ri:page><ac:link-body><ac:image>'
        + '<ri:attachment ri:filename="o.png"><ri:page ri:content-title="Shared Assets" ri:space-key="ENG"></ri:page>'
        + '</ri:attachment></ac:image></ac:link-body></ac:link><p>Web</p><p></p><ac:link><ri:url ri:value="https://example.com/doc"></ri:url>'
        + '<ac:link-body><ac:image><ri:url ri:value="https://cdn.example.com/x.png"></ri:url></ac:image></ac:link-body></ac:link><p></p>',
      );
    });
  });

  describe('the origin of an unsafe ri:url on an image link (#1955 rules, no image branch)', () => {
    const STORED = '<ac:link><ri:url ri:value="/docs/guide" /><ac:link-body><ac:image><ri:attachment ri:filename="g.png" />'
      + '</ac:image></ac:link-body></ac:link>';
    const FILLER = `<p>${'Unrelated prose that keeps the paragraphs apart. '.repeat(3)}</p>`;
    const STORAGE = `<p>See ${STORED} first.</p>${FILLER}`;
    const ROOM = yDocToHtml(htmlToYDoc(confluenceToHtml(STORAGE, '55')));
    const LINKED_G = '<ac:link><ri:url ri:value="/docs/guide"></ri:url><ac:link-body><ac:image><ri:attachment ri:filename="g.png">'
      + '</ri:attachment></ac:image></ac:link-body></ac:link>';
    const BARE_G = '<ac:image><ri:attachment ri:filename="g.png"></ri:attachment></ac:image>';
    // The editor schema drops the paragraph's trailing space, as it does on any page.
    const FILLER_OUT = FILLER.replace(' </p>', '</p>');

    it('writes the stored link back with its image', () => {
      expect(htmlToConfluence(ROOM, { previousStorage: STORAGE })).toBe(`<p>See</p>${LINKED_G}<p> first.</p>${FILLER_OUT}`);
    });

    it('keeps the image and drops the link for a copy on a second image, an edited target and a link with no stored origin', () => {
      const copy = '<p>Copy</p><a href="#confluence-url:%2Fdocs%2Fguide?body=rich"><img src="/api/attachments/55/h.png" alt="h.png"'
        + ' data-confluence-image-source="attachment" data-confluence-filename="h.png"></a>';
      expect(htmlToConfluence(ROOM + copy, { previousStorage: STORAGE })).toBe(
        `<p>See</p>${LINKED_G}<p> first.</p>${FILLER_OUT}<p>Copy</p><ac:image><ri:attachment ri:filename="h.png"></ri:attachment></ac:image>`,
      );
      expect(htmlToConfluence(ROOM.replace('%2Fdocs%2Fguide', '%2Fdocs%2Fother'), { previousStorage: STORAGE }))
        .toBe(`<p>See</p>${BARE_G}<p> first.</p>${FILLER_OUT}`);
      // Markdown import, page create and an Accept with no stored origin.
      expect(htmlToConfluence(ROOM, { linkOrigin: null })).toBe(`<p>See</p>${BARE_G}<p> first.</p>${FILLER_OUT}`);
    });
  });

  describe('AI Improve', () => {
    it('writes a linked image as [![alt](src)](href) in Markdown', () => {
      const html = confluenceToHtml(`<p><ac:link><ri:page ri:content-title="Shared Assets" /><ac:link-body>${IMAGE}</ac:link-body></ac:link></p>`, '55');
      expect(htmlToMarkdown(html)).toBe('[![thumbnail.png](/api/attachments/55/thumbnail.png)](#confluence-page:Shared%20Assets)');
    });

    it('keeps an image-bodied link from a collaborative room through the Improve chain', async () => {
      const storage = `<p>See <ac:link><ri:page ri:content-title="Shared Assets" /><ac:link-body>${IMAGE}</ac:link-body></ac:link> here.</p>`;
      const result = await improveAccept(yDocToHtml(htmlToYDoc(confluenceToHtml(storage, '55'))), storage);
      expect(result.markdown).toBe('See\n\n[CQ\\_MEDIA\\_PLACEHOLDER\\_0](#confluence-page:Shared%20Assets)\n\nhere.');
      expect(result.storage).toBe(
        '<p>See</p>\n<p><ac:link><ri:page ri:content-title="Shared Assets"></ri:page><ac:link-body>'
        + `${IMAGE_OUT}</ac:link-body></ac:link></p>\n<p>here.</p>\n`,
      );
    });

    it('keeps the href and class of a linked image whose URL spells a media placeholder (D2)', async () => {
      const url = 'https://example.com/CQ_MEDIA_PLACEHOLDER_0/a?q="x"&b=<b>';
      const storage = '<p><ac:link><ri:url ri:value="https://example.com/CQ_MEDIA_PLACEHOLDER_0/a?q=&quot;x&quot;&amp;b=&lt;b&gt;" />'
        + '<ac:link-body><ac:image><ri:attachment ri:filename="a.png" /></ac:image></ac:link-body></ac:link></p>'
        + '<p>Other <ac:image><ri:attachment ri:filename="z.png" /></ac:image></p>';
      const room = yDocToHtml(htmlToYDoc(confluenceToHtml(storage, '55')));
      const result = await improveAccept(room, storage);
      const doc = new JSDOM(result.html).window.document;
      const anchor = doc.querySelector('a')!;
      expect(anchor.getAttribute('href')).toBe(url);
      expect(anchor.getAttribute('class')).toBe(
        '#confluence-url:https%3A%2F%2Fexample.com%2FCQ_MEDIA_PLACEHOLDER_0%2Fa%3Fq%3D%22x%22%26b%3D%3Cb%3E?body=rich',
      );
      // Each frozen image is restored once, the linked one inside its link.
      expect([...doc.querySelectorAll('img')].map((img) => [img.getAttribute('alt'), img.parentElement!.tagName]))
        .toEqual([['a.png', 'A'], ['z.png', 'BODY']]);
      expect(result.storage).toBe(
        '<p><ac:link><ri:url ri:value="https://example.com/CQ_MEDIA_PLACEHOLDER_0/a?q=&quot;x&quot;&amp;b=&lt;b&gt;"></ri:url>'
        + '<ac:link-body><ac:image><ri:attachment ri:filename="a.png"></ri:attachment></ac:image></ac:link-body></ac:link></p>\n'
        + '<p>Other</p>\n<ac:image><ri:attachment ri:filename="z.png"></ri:attachment></ac:image>\n',
      );
    });
  });

  // #1954 registers no storage-derivation feature: no slice changes what htmlToConfluence writes for HTML that
  // already exists. These literals were written by this call on #1955's head, before any #1954 change.
  describe('the restore derivation of existing body_html is unchanged (D1)', () => {
    it.each([
      ['an image link', '<p><a href="#confluence-page:Shared%20Assets" data-confluence-link="page"><img src="/api/attachments/55/thumbnail.png"'
        + ' alt="thumbnail.png" data-confluence-image-source="attachment" data-confluence-filename="thumbnail.png"></a></p>',
      '<p><ac:link><ri:page ri:content-title="Shared Assets"></ri:page><ac:link-body>'
        + '<ac:image><ri:attachment ri:filename="thumbnail.png"></ri:attachment></ac:image></ac:link-body></ac:link></p>'],
      ['a code link', '<p><a href="#confluence-page:Runbook" data-confluence-link="page"><code>deploy()</code></a></p>',
        '<p><ac:link><ri:page ri:content-title="Runbook"></ri:page><ac:link-body><code>deploy()</code></ac:link-body></ac:link></p>'],
      ['a mixed body', '<p><a href="#confluence-page:Runbook" data-confluence-link="page">run <code>deploy()</code> now</a></p>',
        '<p><ac:link><ri:page ri:content-title="Runbook"></ri:page><ac:link-body>run <code>deploy()</code> now</ac:link-body></ac:link></p>'],
      ['a line-break body', '<p><a href="#confluence-page:Runbook" data-confluence-link="page">line one<br>line two</a></p>',
        '<p><ac:link><ri:page ri:content-title="Runbook"></ri:page><ac:link-body>line one<br />line two</ac:link-body></ac:link></p>'],
      ['a split line-break body', '<p><a href="#confluence-page:Runbook">line one</a><br><a href="#confluence-page:Runbook">line two</a></p>',
        '<p><ac:link><ri:page ri:content-title="Runbook"></ri:page><ac:plain-text-link-body><![CDATA[line one]]></ac:plain-text-link-body></ac:link>'
        + '<br /><ac:link><ri:page ri:content-title="Runbook"></ri:page><ac:plain-text-link-body><![CDATA[line two]]></ac:plain-text-link-body></ac:link></p>'],
    ])('%s', (_case, bodyHtml, storage) => {
      expect(htmlToConfluence(bodyHtml)).toBe(storage);
    });
  });
});
