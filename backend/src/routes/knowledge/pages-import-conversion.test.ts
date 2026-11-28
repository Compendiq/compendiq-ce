import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { JSDOM } from 'jsdom';
import type { JSONContent } from '@tiptap/core';
import { generateJSON } from '@tiptap/html';
import { z } from 'zod';
import { collabExtensions, htmlToYDoc, yDocToHtml } from '../../core/services/collab-schema.js';
import {
  extractLayoutSkeleton, htmlToConfluence, htmlToMarkdown, markdownToHtml, protectMedia, restoreMedia,
} from '../../core/services/content-converter.js';
import { pagesImportRoutes } from './pages-import.js';

// The import's real pipeline end to end — markdownToHtml, then the route's
// DOMPurify allowlist — then the editor schema. pages-import.test.ts mocks the
// converter module to pin the route's own contract; a mocked converter is
// exactly what hides a conversion or allowlist gap (#1752). Nothing is mocked
// here but authentication, and nothing touches the database (#1133).

function parse(html: string): Document {
  return new JSDOM(`<body>${html}</body>`).window.document;
}

/** The route's response body; parsed, not cast. */
const PreviewBody = z.object({ bodyHtml: z.string() });

/** `[data-checked, text]` of every task item directly inside a task list. */
function taskItems(html: string): Array<[string | null, string | undefined]> {
  return [...parse(html).querySelectorAll('ul[data-type="taskList"] > li[data-type="taskItem"]')]
    .map((li) => [li.getAttribute('data-checked'), li.textContent?.trim()]);
}

describe('POST /api/pages/import/preview through the real converter (#1752)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'test-user-id';
      request.username = 'testuser';
      request.userRole = 'user';
    });
    await app.register(pagesImportRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function preview(markdown: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/api/pages/import/preview', payload: { markdown } });
    expect(response.statusCode).toBe(200);
    return PreviewBody.parse(JSON.parse(response.body)).bodyHtml;
  }

  it('returns GFM task items as the editor task list with their checked state', async () => {
    expect(taskItems(await preview('- [x] done\n- [ ] todo'))).toEqual([['true', 'done'], ['false', 'todo']]);
  });

  it('returns an ordered list that starts at its first number', async () => {
    expect(parse(await preview('3. a\n4. b')).querySelector('ol')?.getAttribute('start')).toBe('3');
  });

  it('loads task state and the list start into the editor schema, and the editor serialisation keeps them', async () => {
    const bodyHtml = await preview('- [x] done\n- [ ] todo\n\n3. a\n4. b');
    // generateJSON is typed Record<string, any>; its output is TipTap document JSON.
    const doc = generateJSON(bodyHtml, collabExtensions()) as JSONContent;
    expect((doc.content ?? []).map((node) => node.type)).toEqual(['taskList', 'orderedList']);
    expect((doc.content?.[0]?.content ?? [])
      .map((item) => [item.type, item.attrs?.checked, item.content?.[0]?.content?.[0]?.text]))
      .toEqual([['taskItem', true, 'done'], ['taskItem', false, 'todo']]);
    expect(doc.content?.[1]?.attrs?.start).toBe(3);
    // Create Page saves the editor's serialisation, not the preview HTML.
    const saved = yDocToHtml(htmlToYDoc(bodyHtml));
    expect(saved.match(/data-checked="(?:true|false)"/g)).toEqual(['data-checked="true"', 'data-checked="false"']);
    expect(saved).toContain('<ol start="3">');
  });

  it('keeps the numbering type the editor models, and drops reversed, which it does not', async () => {
    const bodyHtml = await preview('<ol type="a" start="2" reversed><li>x</li></ol>');
    const ol = parse(bodyHtml).querySelector('ol');
    expect(ol?.getAttribute('type')).toBe('a');
    expect(ol?.getAttribute('start')).toBe('2');
    expect(ol?.hasAttribute('reversed')).toBe(false);
    // generateJSON is typed Record<string, any>; its output is TipTap document JSON.
    const doc = generateJSON(bodyHtml, collabExtensions()) as JSONContent;
    expect(doc.content?.[0]?.attrs).toEqual({ start: 2, type: 'a' });
  });

  it('keeps a task item that holds a diagram as a plain item with its marker, so its text and the diagram reach the editor', async () => {
    const bodyHtml = await preview('- [x] done\n\n  ```drawio\n  arch.drawio\n  ```\n\n- [ ] todo');
    // generateJSON is typed Record<string, any>; its output is TipTap document JSON.
    const doc = generateJSON(bodyHtml, collabExtensions()) as JSONContent;
    expect((doc.content ?? []).map((node) => node.type)).toEqual(['bulletList', 'taskList']);
    const kept = doc.content?.[0]?.content?.[0];
    expect((kept?.content ?? []).map((node) => node.type)).toEqual(['paragraph', 'drawioDiagram']);
    expect(kept?.content?.[0]?.content?.[0]?.text).toBe('[x] done');
    expect((doc.content?.[1]?.content ?? []).map((item) => [item.attrs?.checked, item.content?.[0]?.content?.[0]?.text]))
      .toEqual([[false, 'todo']]);
  });

  it('admits data-type and data-checked by name only: every other data-* attribute is still stripped', async () => {
    const bodyHtml = await preview(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true" data-task-id="42" data-macro-name="html">raw task</li></ul>\n\n'
      + '<p data-unrelated="x">kept</p>',
    );
    const doc = parse(bodyHtml);
    expect(doc.querySelector('li')?.getAttributeNames().sort()).toEqual(['data-checked', 'data-type']);
    expect(doc.querySelector('p')?.getAttributeNames()).toEqual([]);
    expect(bodyHtml).not.toMatch(/data-(?:task-id|macro-name|unrelated)/);
  });

  it('still strips <input> outside a task item, in a paragraph or a plain list item, and never makes a raw checkbox a task', async () => {
    const bodyHtml = await preview(
      'Accept <input type="checkbox" checked> terms\n\n- [ ] todo\n\n<ul><li><input type="checkbox" checked> raw</li></ul>',
    );
    expect(taskItems(bodyHtml)).toEqual([['false', 'todo']]);
    const doc = parse(bodyHtml);
    expect(doc.querySelectorAll('input')).toHaveLength(0);
    const raw = [...doc.querySelectorAll('li')].find((li) => li.textContent?.trim() === 'raw');
    expect(raw?.getAttributeNames()).toEqual([]);
  });

  describe('table column alignment (#1956)', () => {
    const ALIGNED = '| a | b | c | d |\n|:--- |:---:| ---:| --- |\n| 1 | 2 | 3 | 4 |';
    const aligns = (html: string, tag: string): Array<string | null> =>
      [...parse(html).querySelectorAll(tag)].map((cell) => cell.getAttribute('align'));

    it('keeps column alignment from a GFM table (:--- :---: ---:) on every header and body cell', async () => {
      const bodyHtml = await preview(ALIGNED);
      expect(aligns(bodyHtml, 'th')).toEqual(['left', 'center', 'right', null]);
      expect(aligns(bodyHtml, 'td')).toEqual(['left', 'center', 'right', null]);
    });

    it('loads the aligned table into the collaborative schema and back with its alignment', async () => {
      const saved = yDocToHtml(htmlToYDoc(await preview(ALIGNED)));
      expect(aligns(saved, 'th')).toEqual(['left', 'center', 'right', null]);
      expect(aligns(saved, 'td')).toEqual(['left', 'center', 'right', null]);
      expect(saved).not.toMatch(/<t[dh][^>]*style=/);
    });

    // The persisting Improve chain on an unchanged echo (`_helpers.ts`, then Accept in `llm-conversations.ts`).
    async function improveChain(body: string): Promise<{ markdown: string; applied: string }> {
      const markdown = htmlToMarkdown(protectMedia(body).html, { layoutTokens: true }).trim();
      const { html: protectedBody, media } = protectMedia(body);
      const applied = await markdownToHtml(markdown, { layoutSkeleton: extractLayoutSkeleton(protectedBody), protectedMedia: media });
      return { markdown, applied: restoreMedia(applied, media) };
    }

    it('reaches AI Improve as a GFM table with the same alignment, and back', async () => {
      const { markdown, applied } = await improveChain(await preview(ALIGNED));
      expect(markdown.split('\n')).toEqual([
        '| a | b | c | d |',
        '| :-- | :-: | --: | --- |',
        '| 1 | 2 | 3 | 4 |',
      ]);
      expect(aligns(applied, 'th')).toEqual(['left', 'center', 'right', null]);
      expect([...parse(applied).querySelectorAll('td')].map((cell) => cell.textContent)).toEqual(['1', '2', '3', '4']);
      expect(htmlToConfluence(applied)).toContain('<th style="text-align: center;">b</th>');
    });

    it('keeps the alignment through AI Improve after an editor serialisation, which the stock rule keeps as HTML', async () => {
      const editorHtml = yDocToHtml(htmlToYDoc(await preview(ALIGNED)));
      expect(editorHtml).toContain('<colgroup>');
      const { markdown, applied } = await improveChain(editorHtml);
      expect(markdown).toBe(editorHtml);
      expect(aligns(applied, 'th')).toEqual(['left', 'center', 'right', null]);
      expect(aligns(applied, 'td')).toEqual(['left', 'center', 'right', null]);
    });

    it('writes the imported alignment to Confluence as text-align styles after the collaborative load', async () => {
      const storage = htmlToConfluence(yDocToHtml(htmlToYDoc(await preview(ALIGNED))));
      expect(storage).toMatch(/<th colspan="1" rowspan="1" style="text-align: left;">/);
      expect(storage).toMatch(/<td colspan="1" rowspan="1" style="text-align: right;">/);
      expect(storage).not.toContain('align="');
    });

    it('strips align from p, img, div, h1, table, tr, a and span', async () => {
      const bodyHtml = await preview(
        '<p align="center">p</p>\n\n<div align="right"><span align="left">s</span></div>\n\n<h1 align="center">h</h1>\n\n'
        + '<img src="https://example.com/x.png" align="right" alt="i">\n\n<a href="https://example.com" align="center">l</a>\n\n'
        + '<table align="center"><tbody><tr align="right"><td>x</td></tr></tbody></table>',
      );
      expect(bodyHtml).not.toMatch(/align=/);
    });

    it('drops align values other than left, center and right (justify, javascript:, centre, empty)', async () => {
      const bodyHtml = await preview(
        '<table><tbody><tr><th align="justify">a</th><th align="javascript:alert(1)">b</th><th align="centre">c</th><th align="">d</th></tr>'
        + '<tr><td align="char">1</td><td align="-webkit-center">2</td><td align="left center">3</td><td align="data:text/html,x">4</td></tr></tbody></table>',
      );
      expect(bodyHtml).not.toMatch(/align=/);
      expect(parse(bodyHtml).querySelectorAll('th, td')).toHaveLength(8);
    });

    it('writes the value canonical: case and surrounding whitespace are normalised', async () => {
      const bodyHtml = await preview('<table><tbody><tr><th ALIGN=" CENTER ">a</th><td align="Right">1</td></tr></tbody></table>');
      expect(aligns(bodyHtml, 'th')).toEqual(['center']);
      expect(aligns(bodyHtml, 'td')).toEqual(['right']);
    });

    it('still strips every data-* attribute and style from a cell while keeping its align', async () => {
      const bodyHtml = await preview(
        '<table><tbody><tr><th align="center" data-x="1" data-task-id="2" style="text-align: right" data-drawio-xml="y">a</th>'
        + '<td align="right" style="color: red" data-highlight-colour="red">1</td></tr></tbody></table>',
      );
      const cells = [...parse(bodyHtml).querySelectorAll('th, td')];
      expect(cells.map((cell) => cell.getAttributeNames())).toEqual([['align'], ['align']]);
      expect(cells.map((cell) => cell.getAttribute('align'))).toEqual(['center', 'right']);
    });
  });
});
