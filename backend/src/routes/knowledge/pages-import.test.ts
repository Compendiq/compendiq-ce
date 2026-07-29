import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// Mock content-converter. `markdownToHtml` is the only pipeline entry point
// this route still touches — the DB, audit and randomUUID mocks went with the
// insert it no longer performs (#1133).
vi.mock('../../core/services/content-converter.js', () => ({
  markdownToHtml: vi.fn().mockResolvedValue('<p>Hello world</p>'),
}));

// No database mock: the route must not import `core/db/postgres.js` at all.
// A mock here would be decorative — an unimported module's `query` can never
// throw — so the invariant is asserted directly against the source instead
// (see 'never touches the database' below).

import { pagesImportRoutes, parseFrontMatter } from './pages-import.js';

describe('Pages import routes', () => {
  let app: ReturnType<typeof Fastify>;

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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/pages/import/preview', () => {
    it('returns the converted article without persisting anything', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import/preview',
        payload: {
          markdown: '# Hello\n\nThis is a test article.',
          title: 'Test Article',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toEqual({
        title: 'Test Article',
        bodyHtml: '<p>Hello world</p>',
        labels: [],
      });
      // No id, because nothing was created. The old envelope handed back a
      // synthetic `standalone-<uuid>` and the caller navigated straight to it.
      expect(body).not.toHaveProperty('id');
      expect(body).not.toHaveProperty('articles');
    });

    // The whole point of #1133: the old route hardcoded space_key='_standalone'
    // on insert, so a page imported while a Confluence space was selected was
    // filed in the wrong place. Asserted against the source because it is a
    // statement about what the module *cannot* do — a runtime assertion would
    // only cover the paths the tests happen to walk.
    it('never touches the database, so it cannot file the page in any space', () => {
      // Comments stripped: the file's docblock necessarily names the old
      // behaviour it replaced, and that prose is not what is being asserted.
      const code = readFileSync(new URL('./pages-import.ts', import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(code).not.toContain('core/db/postgres.js');
      expect(code).not.toMatch(/INSERT INTO/i);
      expect(code).not.toContain('_standalone');
    });

    it('bounds a front-matter title and label set the same way request input is bounded', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import/preview',
        payload: {
          markdown: `---\ntitle: ${'T'.repeat(900)}\ntags: [${Array.from({ length: 60 }, (_, i) => 'l' + i).join(', ')}]\n---\nBody`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.title).toHaveLength(500);
      expect(body.labels).toHaveLength(50);
    });

    it('is no longer reachable at the old path', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import',
        payload: { markdown: '# Hello' },
      });

      // 404, not a 200 that silently created nothing — a client still calling
      // the old route has to find out.
      expect(response.statusCode).toBe(404);
    });

    it('should extract title from YAML front-matter', async () => {
      const markdown = `---
title: Front-Matter Title
tags: [api, guide]
---
# Content here

Some body text.`;

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import/preview',
        payload: { markdown },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.title).toBe('Front-Matter Title');
      expect(body.labels).toEqual(['api', 'guide']);
    });

    it('should merge front-matter tags with request body labels', async () => {
      const markdown = `---
title: Merged Labels Test
tags: [api, guide]
---
Content`;

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import/preview',
        payload: {
          markdown,
          labels: ['guide', 'howto'],  // 'guide' overlaps with front-matter
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      // Should be deduplicated: api, guide, howto
      expect(body.labels).toEqual(expect.arrayContaining(['api', 'guide', 'howto']));
      expect(body.labels).toHaveLength(3);
    });

    it('should return 400 when markdown field is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import/preview',
        payload: { title: 'No markdown' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 when markdown is empty string', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import/preview',
        payload: { markdown: '' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should use "Imported Article" as default title when none provided', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import/preview',
        payload: { markdown: 'Just some text without title' },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).title).toBe('Imported Article');
    });
  });
});

describe('parseFrontMatter', () => {
  it('should return raw content when no front-matter present', () => {
    const result = parseFrontMatter('Just plain markdown');
    expect(result.metadata).toEqual({});
    expect(result.content).toBe('Just plain markdown');
  });

  it('should parse key-value pairs', () => {
    const md = `---
title: My Article
author: John
---
Body content`;

    const result = parseFrontMatter(md);
    expect(result.metadata.title).toBe('My Article');
    expect(result.metadata.author).toBe('John');
    expect(result.content).toBe('Body content');
  });

  it('should parse bracket arrays', () => {
    const md = `---
tags: [api, guide, "howto"]
---
Body`;

    const result = parseFrontMatter(md);
    expect(result.metadata.tags).toEqual(['api', 'guide', 'howto']);
  });

  it('should strip surrounding quotes from values', () => {
    const md = `---
title: "Quoted Title"
---
Body`;

    const result = parseFrontMatter(md);
    expect(result.metadata.title).toBe('Quoted Title');
  });

  it('should handle values containing colons', () => {
    const md = `---
title: My Article: A Subtitle
---
Body`;

    const result = parseFrontMatter(md);
    expect(result.metadata.title).toBe('My Article: A Subtitle');
  });
});
