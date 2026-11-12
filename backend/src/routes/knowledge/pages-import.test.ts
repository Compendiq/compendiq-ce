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

import { markdownToHtml } from '../../core/services/content-converter.js';

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

    // ── Oversize input: the app's own limit must be the one that fires (#1178)
    //
    // Fastify's default JSON body limit is 1 MiB, so without a per-route
    // `bodyLimit` the schema's 1,000,000-*character* cap is unreachable for
    // anything but plain ASCII: the units differ, and 1,000,000 characters of
    // non-ASCII Markdown is up to 3 MB of UTF-8. The user then gets a generic
    // `FST_ERR_CTP_BODY_TOO_LARGE` 413 that names no limit they can act on.
    it('accepts a body above Fastify\'s 1 MiB default so the schema limit is what rejects', async () => {
      // 1,000,000 characters — exactly the schema maximum — but 3 MB of UTF-8
      // once serialised, because U+20AC encodes to three bytes.
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import/preview',
        payload: { markdown: '€'.repeat(1_000_000) },
      });

      expect(response.statusCode).toBe(200);
    });

    it('rejects Markdown past the schema limit with the route\'s own message, not a transport 413', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import/preview',
        payload: { markdown: 'a'.repeat(1_000_001) },
      });

      // 400 from Zod — not 413 from Fastify's body parser. The distinction is
      // the whole point: only the 400 carries a message naming the real limit.
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).message).toContain('Markdown too large');
    });

    // ── Front-matter that a Windows editor writes (#1178, items 3 and 4) ──────
    // Both of these used to fall through to the body, where the `---` block
    // renders as an <hr> plus an <h2> of the raw YAML — and the import still
    // reported success, so nothing told the user their title and labels were
    // gone.
    it('keeps the title and labels from CRLF front-matter', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import/preview',
        payload: { markdown: '---\r\ntitle: Windows Doc\r\ntags: [api, guide]\r\n---\r\n# Body\r\n' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.title).toBe('Windows Doc');
      expect(body.labels).toEqual(['api', 'guide']);
    });

    it('keeps the title and labels when the file starts with a UTF-8 BOM', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import/preview',
        payload: { markdown: '﻿---\ntitle: BOM Doc\ntags: [bom]\n---\n# Body\n' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.title).toBe('BOM Doc');
      expect(body.labels).toEqual(['bom']);
    });

    // ── Whitespace-only input (#1178, item 5) ────────────────────────────────
    it('rejects whitespace-only Markdown instead of importing an empty article', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import/preview',
        payload: { markdown: '   \n\n \t \n' },
      });

      expect(response.statusCode).toBe(400);
      // Actionable: it has to say the file is blank, not "markdown field required"
      // for a field that was in fact present.
      expect(JSON.parse(response.body).message).toMatch(/blank|empty/i);
    });

    it('rejects Markdown that converts to an empty document', async () => {
      vi.mocked(markdownToHtml).mockResolvedValueOnce('');

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import/preview',
        payload: { markdown: '---\ntitle: Only Front-Matter\n---\n' },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).message).toMatch(/no content|empty/i);
    });

    // ── An unexpected conversion failure is the user's problem to act on ─────
    it('turns an unexpected conversion failure into a 422 naming what to try', async () => {
      vi.mocked(markdownToHtml).mockRejectedValueOnce(new Error('Cannot read properties of undefined'));

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import/preview',
        payload: { markdown: '# Anything' },
      });

      expect(response.statusCode).toBe(422);
      const { message } = JSON.parse(response.body);
      // Not the raw internal error, and not a bare "Internal Server Error".
      expect(message).not.toContain('Cannot read properties');
      expect(message).toMatch(/Markdown/i);
      expect(message.length).toBeGreaterThan(40);
    });
  });

  // ── YAML block lists in front-matter (#1753) ──────────────────────────────
  // `tags:` followed by `- ops` lines is how most editors write tags. It used
  // to import as no labels with no warning — the same silent loss #1178 fixed
  // for CRLF and BOM files.
  describe('front-matter block lists (#1753)', () => {
    const preview = (markdown: string, extra: Record<string, unknown> = {}) => app.inject({
      method: 'POST',
      url: '/api/pages/import/preview',
      payload: { markdown, ...extra },
    });

    it('imports a block-list tags: sequence as labels', async () => {
      const response = await preview('---\ntitle: Import probe\ntags:\n  - ops\n  - runbook\n---\nBody');

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.title).toBe('Import probe');
      expect(body.labels).toEqual(['ops', 'runbook']);
    });

    it('imports a block-list labels: sequence as labels', async () => {
      const response = await preview('---\nlabels:\n  - ops\n  - runbook\n---\nBody');

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).labels).toEqual(['ops', 'runbook']);
    });

    it('unquotes quoted block-list items', async () => {
      const response = await preview('---\ntags:\n  - "ops"\n  - \'runbook\'\n---\nBody');

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).labels).toEqual(['ops', 'runbook']);
    });

    it('imports a CRLF block list, behind a BOM too', async () => {
      const crlf = await preview('---\r\ntags:\r\n  - ops\r\n  - runbook\r\n---\r\n# Body\r\n');
      expect(crlf.statusCode).toBe(200);
      expect(JSON.parse(crlf.body).labels).toEqual(['ops', 'runbook']);

      const bom = await preview('\uFEFF---\r\nlabels:\r\n  - ops\r\n  - runbook\r\n---\r\n# Body\r\n');
      expect(bom.statusCode).toBe(200);
      expect(JSON.parse(bom.body).labels).toEqual(['ops', 'runbook']);
    });

    it('does not leak a block list under an unrelated key into labels', async () => {
      // Two ways to get this wrong: items after `authors:` still landing in the
      // open `labels` list (→ ops, alice, bob), or the nested `  tags:` opening
      // a list of its own, which then wins over `labels` (→ leak).
      const response = await preview(
        '---\nlabels:\n  - ops\nauthors:\n  - alice\n  - bob\nmeta:\n  tags:\n    - leak\n---\nBody',
      );

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).labels).toEqual(['ops']);
    });

    it('bounds a block-list label set the same way as an inline one', async () => {
      const items = Array.from({ length: 60 }, (_, i) => `  - ${i === 0 ? 'x'.repeat(150) : 'l' + i}`).join('\n');
      const response = await preview(`---\ntags:\n${items}\n---\nBody`);

      expect(response.statusCode).toBe(200);
      const { labels } = JSON.parse(response.body);
      expect(labels).toHaveLength(50);
      expect(labels[0]).toBe('x'.repeat(100));
      expect(labels[49]).toBe('l49');
    });

    // Pinned as it was before block lists: a scalar is not a label list.
    it('keeps a scalar tags: ops out of labels, as before', async () => {
      for (const markdown of ['---\ntags: ops\n---\nBody', '---\ntags: "ops"\n---\nBody']) {
        const response = await preview(markdown);
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body).labels).toEqual([]);
      }
    });

    it('prefers a tags block list over labels, and falls back to labels when tags is a scalar', async () => {
      const both = await preview('---\ntags:\n  - ops\nlabels:\n  - x\n---\nBody');
      expect(JSON.parse(both.body).labels).toEqual(['ops']);

      const scalarTags = await preview('---\ntags: ops\nlabels:\n  - x\n---\nBody');
      expect(JSON.parse(scalarTags.body).labels).toEqual(['x']);
    });

    // `title: #1 ranked` is, to YAML, an empty title followed by a comment, so
    // dash lines under it make `title` a list. A list is not a title: the
    // request's title (or the default) is used, exactly as for `title:` alone.
    it('falls back to the request title when the front-matter title is a block list', async () => {
      const empty = await preview('---\ntitle:\n  - a\n---\nBody', { title: 'Given' });
      expect(JSON.parse(empty.body).title).toBe('Given');

      const commented = await preview('---\ntitle: #1 ranked\n  - x\n---\nBody', { title: 'Given' });
      expect(JSON.parse(commented.body).title).toBe('Given');
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

  // ── What a Windows or BOM-writing editor actually produces (#1178) ─────────
  // Real bytes, not a paraphrase: the whole defect was that the regex tested
  // fine against LF fixtures while every CRLF file silently lost its metadata.

  it('parses CRLF front-matter, the line ending every Windows editor writes', () => {
    const result = parseFrontMatter('---\r\ntitle: My Article\r\ntags: [api, guide]\r\n---\r\nBody content\r\n');

    expect(result.metadata.title).toBe('My Article');
    expect(result.metadata.tags).toEqual(['api', 'guide']);
    expect(result.content).toBe('Body content\r\n');
  });

  it('parses front-matter behind a UTF-8 BOM', () => {
    const result = parseFrontMatter('﻿---\ntitle: My Article\ntags: [api]\n---\nBody content');

    expect(result.metadata.title).toBe('My Article');
    expect(result.metadata.tags).toEqual(['api']);
    expect(result.content).toBe('Body content');
  });

  it('parses CRLF front-matter behind a UTF-8 BOM', () => {
    const result = parseFrontMatter('﻿---\r\ntitle: My Article\r\n---\r\nBody content');

    expect(result.metadata.title).toBe('My Article');
    expect(result.content).toBe('Body content');
  });

  it('strips a BOM from a file that has no front-matter at all', () => {
    // Otherwise the invisible U+FEFF leads the first heading and rides into
    // the editor — and from there into whatever the user creates.
    const result = parseFrontMatter('﻿# Heading\n\nText');

    expect(result.metadata).toEqual({});
    expect(result.content).toBe('# Heading\n\nText');
  });

  it('treats a front-matter block with no body as an empty body', () => {
    const result = parseFrontMatter('---\ntitle: Only Front-Matter\n---\n');

    expect(result.metadata.title).toBe('Only Front-Matter');
    expect(result.content).toBe('');
  });
});

describe('parseFrontMatter block lists (#1753)', () => {
  it('reads an indented block list into an array and keeps the body', () => {
    const result = parseFrontMatter('---\ntitle: Import probe\ntags:\n  - ops\n  - runbook\n---\nBody');

    expect(result.metadata).toEqual({ title: 'Import probe', tags: ['ops', 'runbook'] });
    expect(result.content).toBe('Body');
  });

  it("accepts items at the key's own indentation and ends the list at the next key", () => {
    const result = parseFrontMatter('---\ntags:\n- ops\n- runbook\ntitle: T\n---\nBody');

    expect(result.metadata).toEqual({ tags: ['ops', 'runbook'], title: 'T' });
  });

  it('skips blank and comment lines inside a list and drops trailing comments', () => {
    const result = parseFrontMatter('---\ntags:\n\n  # primary first\n  - ops # the team\n\n  - runbook\n---\nBody');

    expect(result.metadata.tags).toEqual(['ops', 'runbook']);
  });

  it('opens a list after a key whose value is only a comment', () => {
    const result = parseFrontMatter('---\ntags: # list\n  - ops\n  - runbook\n---\nBody');

    expect(result.metadata.tags).toEqual(['ops', 'runbook']);
  });

  it('unquotes items and keeps the colons and # that YAML keeps', () => {
    const result = parseFrontMatter(
      "---\ntags:\n  - \"ops: core\"\n  - 'it''s'\n  - \"a # b\"\n  - http://x\n  - c# lang\n  - '#hash' # c\n---\nBody",
    );

    // Also proves the item lines no longer turn into junk keys like `- "ops`.
    expect(result.metadata).toEqual({ tags: ['ops: core', "it's", 'a # b', 'http://x', 'c# lang', '#hash'] });
  });

  it("parses CRLF and BOM block lists and leaves the body's line endings alone", () => {
    const result = parseFrontMatter('\uFEFF---\r\ntitle: Win\r\ntags:\r\n  - ops\r\n  - runbook\r\n---\r\nBody\r\n');

    expect(result.metadata).toEqual({ title: 'Win', tags: ['ops', 'runbook'] });
    expect(result.content).toBe('Body\r\n');
  });

  it('gives a block list under an unrelated key to that key only', () => {
    const result = parseFrontMatter('---\nauthors:\n  - alice\n  - bob\ntags:\n  - ops\nrelated:\n  - leak\n---\nBody');

    expect(result.metadata).toEqual({ authors: ['alice', 'bob'], tags: ['ops'], related: ['leak'] });
  });

  it('does not open a list from an indented key', () => {
    const result = parseFrontMatter('---\ntags:\n  - ops\nmeta:\n  labels:\n    - leak\n---\nBody');

    expect(result.metadata.tags).toEqual(['ops']);
    expect(JSON.stringify(result.metadata)).not.toContain('leak');
  });

  it('reads a list of only empty items as an empty array', () => {
    const result = parseFrontMatter('---\ntags:\n  -\n  - ""\n---\nBody');

    expect(result.metadata.tags).toEqual([]);
  });

  // YAML reads an unquoted `#` after the dash as a comment, so `- #ops` is an
  // empty item; quoting it keeps the hash.
  it('drops a plain item that is only a comment and keeps a quoted #tag', () => {
    const result = parseFrontMatter("---\ntags:\n  - #ops\n  - '#runbook'\n  - ops\n---\nBody");

    expect(result.metadata.tags).toEqual(['#runbook', 'ops']);
  });

  // Pinned as it was before block lists.
  it('keeps a key with no items and a scalar tags value as the strings they were', () => {
    expect(parseFrontMatter('---\ntags:\ntitle: X\n---\nBody').metadata).toEqual({ tags: '', title: 'X' });
    expect(parseFrontMatter('---\ntags: ops\n---\nBody').metadata.tags).toBe('ops');
    expect(parseFrontMatter('---\ntags: "ops"\n---\nBody').metadata.tags).toBe('ops');
  });
});
