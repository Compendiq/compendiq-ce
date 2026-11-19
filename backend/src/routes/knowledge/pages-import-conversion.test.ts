import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { JSDOM } from 'jsdom';
import type { JSONContent } from '@tiptap/core';
import { generateJSON } from '@tiptap/html';
import { z } from 'zod';
import { collabExtensions, htmlToYDoc, yDocToHtml } from '../../core/services/collab-schema.js';
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
});
