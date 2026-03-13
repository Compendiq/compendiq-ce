import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// Mock database
const mockQuery = vi.fn();
vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Mock content-converter
vi.mock('../services/content-converter.js', () => ({
  markdownToHtml: vi.fn().mockResolvedValue('<p>Hello world</p>'),
  htmlToText: vi.fn().mockReturnValue('Hello world'),
}));

// Mock audit service
vi.mock('../services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock crypto.randomUUID for deterministic tests
vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto');
  return {
    ...actual,
    randomUUID: vi.fn().mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
  };
});

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

  describe('POST /api/pages/import', () => {
    it('should import a simple markdown article', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import',
        payload: {
          markdown: '# Hello\n\nThis is a test article.',
          title: 'Test Article',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.imported).toBe(1);
      expect(body.total).toBe(1);
      expect(body.articles).toHaveLength(1);
      expect(body.articles[0].title).toBe('Test Article');
      expect(body.articles[0].success).toBe(true);
      expect(body.articles[0].id).toMatch(/^standalone-/);

      // Verify database insert was called with correct params
      expect(mockQuery).toHaveBeenCalledOnce();
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO cached_pages');
      expect(sql).toContain("'standalone'");
      expect(params[0]).toMatch(/^standalone-/);  // confluence_id
      expect(params[1]).toBe('Test Article');       // title
      expect(params[5]).toBe('test-user-id');       // created_by_user_id
    });

    it('should extract title from YAML front-matter', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 2 }] });

      const markdown = `---
title: Front-Matter Title
tags: [api, guide]
---
# Content here

Some body text.`;

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import',
        payload: { markdown },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.articles[0].title).toBe('Front-Matter Title');

      // Tags should be passed as labels
      const [, params] = mockQuery.mock.calls[0];
      expect(params[4]).toEqual(['api', 'guide']); // labels
    });

    it('should merge front-matter tags with request body labels', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 3 }] });

      const markdown = `---
title: Merged Labels Test
tags: [api, guide]
---
Content`;

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import',
        payload: {
          markdown,
          labels: ['guide', 'howto'],  // 'guide' overlaps with front-matter
        },
      });

      expect(response.statusCode).toBe(200);

      const [, params] = mockQuery.mock.calls[0];
      // Should be deduplicated: api, guide, howto
      expect(params[4]).toEqual(expect.arrayContaining(['api', 'guide', 'howto']));
      expect(params[4]).toHaveLength(3);
    });

    it('should return 400 when markdown field is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import',
        payload: { title: 'No markdown' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 when markdown is empty string', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import',
        payload: { markdown: '' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should use "Imported Article" as default title when none provided', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 4 }] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/import',
        payload: { markdown: 'Just some text without title' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.articles[0].title).toBe('Imported Article');
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
