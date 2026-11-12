import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { JSDOM } from 'jsdom';
import type { JSONContent } from '@tiptap/core';
import { generateJSON } from '@tiptap/html';
import { z } from 'zod';
import { collabExtensions, htmlToYDoc, yDocToHtml } from '../../core/services/collab-schema.js';
import { htmlToConfluence, htmlToMarkdown, markdownToHtml } from '../../core/services/content-converter.js';
import { pagesImportRoutes } from './pages-import.js';

// The import's real pipeline end to end for draw.io placeholders —
// markdownToHtml, then the route's DOMPurify allowlist — then the editor
// schema and the converters a saved page meets. pages-import.test.ts mocks the
// converter module to pin the route's own contract, which is exactly what
// hides an allowlist gap (#1754). Nothing is mocked here but authentication,
// and nothing touches the database (#1133).

function parse(html: string): Document {
  return new JSDOM(`<body>${html}</body>`).window.document;
}

/** The route's response body; parsed, not cast. */
const PreviewBody = z.object({ bodyHtml: z.string() });

/** `data-diagram-name` of every draw.io placeholder, in document order. */
function diagramNames(html: string): Array<string | null> {
  return [...parse(html).querySelectorAll('div.confluence-drawio')].map((div) => div.getAttribute('data-diagram-name'));
}

/**
 * What a ```drawio fence naming architecture.drawio imports as: the name, and
 * the unavailable marker, because the new page has no preview yet. The
 * frontend DrawioDiagram test in article-extensions.test.ts parses this exact
 * string (#1754).
 */
const IMPORTED_DIAGRAM = '<div class="confluence-drawio" data-diagram-name="architecture.drawio">'
  + '<span class="drawio-preview-unavailable">Draw.io preview unavailable: architecture.drawio</span></div>';

describe('POST /api/pages/import/preview keeps the identity of a draw.io placeholder (#1754)', () => {
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

  it('returns a drawio fence as the placeholder with its diagram name', async () => {
    const bodyHtml = await preview('```drawio\narchitecture.drawio\n```');
    expect(bodyHtml.trim()).toBe(IMPORTED_DIAGRAM);
    expect([...parse(bodyHtml).querySelectorAll('div.confluence-drawio[data-diagram-name="architecture.drawio"]')])
      .toHaveLength(1);
  });

  it('loads the placeholder into the editor schema with its name, and the editor serialisation and the Confluence write-back keep it', async () => {
    const bodyHtml = await preview('```drawio\narchitecture.drawio\n```');
    // generateJSON is typed Record<string, any>; its output is TipTap document JSON.
    const doc = generateJSON(bodyHtml, collabExtensions()) as JSONContent;
    expect((doc.content ?? []).map((node) => [node.type, node.attrs?.diagramName]))
      .toEqual([['drawioDiagram', 'architecture.drawio']]);
    // Create Page saves the editor's serialisation, not the preview HTML.
    const saved = yDocToHtml(htmlToYDoc(bodyHtml));
    expect(saved).toBe(IMPORTED_DIAGRAM);
    // Created in a Confluence space, the macro names the diagram it shows.
    expect(htmlToConfluence(saved))
      .toContain('<ac:parameter ac:name="diagramName">architecture.drawio</ac:parameter>');
  });

  it('admits data-diagram-name by name only: an unrelated data-* attribute is still stripped, elsewhere and on a placeholder', async () => {
    const bodyHtml = await preview(
      '```drawio\narchitecture.drawio\n```\n\n<p data-unrelated="x">kept</p>\n\n'
      + '<div class="confluence-drawio" data-diagram-name="raw" data-macro-name="drawio">raw</div>',
    );
    const doc = parse(bodyHtml);
    expect([...doc.querySelectorAll('div.confluence-drawio')].map((div) => div.getAttributeNames().sort()))
      .toEqual([['class', 'data-diagram-name'], ['class', 'data-diagram-name']]);
    expect(doc.querySelector('p')?.getAttributeNames()).toEqual([]);
    expect(bodyHtml).not.toMatch(/data-(?:unrelated|macro-name)/);
  });

  it('keeps a diagram name that reads like a URI scheme: the name is text, and a link is still checked as a URL', async () => {
    const bodyHtml = await preview('```drawio\nNetwork: DMZ\n```\n\n[run](javascript:alert(1))');
    expect(diagramNames(bodyHtml)).toEqual(['Network: DMZ']);
    expect(parse(bodyHtml).querySelector('a')?.hasAttribute('href')).toBe(false);
  });

  it('strips the source locator and inline XML of an exported fence, and keeps its name, preview and edit link', async () => {
    const fence = JSON.stringify({
      name: 'architecture.drawio',
      source: '/api/attachments/42/architecture.drawio.drawio',
      xml: '<mxfile><diagram id="d"/></mxfile>',
      src: '/api/attachments/42/architecture.drawio.png',
      alt: 'Architecture',
      href: 'https://confluence.example/pages/viewpage.action?pageId=42',
    });
    const bodyHtml = await preview(`\`\`\`drawio\n${fence}\n\`\`\``);
    expect(parse(bodyHtml).querySelector('div.confluence-drawio')?.getAttributeNames().sort())
      .toEqual(['class', 'data-diagram-name']);
    // generateJSON is typed Record<string, any>; its output is TipTap document JSON.
    const doc = generateJSON(bodyHtml, collabExtensions()) as JSONContent;
    expect(doc.content?.[0]?.attrs).toMatchObject({
      diagramName: 'architecture.drawio',
      drawioSource: null,
      xml: null,
      src: '/api/attachments/42/architecture.drawio.png',
      editHref: 'https://confluence.example/pages/viewpage.action?pageId=42',
    });
  });

  it('drops a diagram name that cannot stay one line of Markdown, so it cannot break out of the fence it is written back to', async () => {
    const bodyHtml = await preview(
      '````drawio\na\n```\n# x\n````\n\n'
      + '````drawio\n```\n````\n\n'
      + '<div class="confluence-drawio" data-diagram-name="b&#13;```">raw</div>\n\n'
      + '```drawio\narchitecture.drawio\n```',
    );
    expect(diagramNames(bodyHtml)).toEqual([null, null, null, 'architecture.drawio']);
    // Written back to Markdown (LLM context, quality checks, version diffs), nothing escapes its fence: no stray
    // heading or code block, and the named diagram is still a diagram.
    const roundTrip = parse(await markdownToHtml(htmlToMarkdown(yDocToHtml(htmlToYDoc(bodyHtml)))));
    expect(roundTrip.querySelector('h1, pre')).toBeNull();
    expect([...roundTrip.querySelectorAll('div.confluence-drawio[data-diagram-name="architecture.drawio"]')]).toHaveLength(1);
  });
});
