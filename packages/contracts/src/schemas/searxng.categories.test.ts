import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { SEARXNG_CATEGORIES_DEFAULT, SearxngCategoriesSchema } from './searxng.js';

describe('SearXNG categories contract (#1769)', () => {
  // The sidecar does not depend on this package: mcp-docs/src/index.ts declares
  // `categories: z.string().regex(/^[a-z0-9_]+(,[a-z0-9_]+)*$/).max(200)` and
  // mcp-docs/src/tools/search-web.ts defaults to `general`. The JSON Schema
  // below is literal on purpose — mcp-docs/src/admin-settings.integration.test.ts
  // pins the same object against the running sidecar's tools/list, so the two
  // sides cannot drift apart without one of the two suites going red.
  it("pins the categories pattern and length to the sidecar's search_web argument", () => {
    expect(z.toJSONSchema(SearxngCategoriesSchema)).toMatchObject({
      type: 'string',
      maxLength: 200,
      pattern: '^[a-z0-9_]+(,[a-z0-9_]+)*$',
    });
  });

  it('defaults to the category the sidecar searches when none is sent, and the default is itself valid', () => {
    expect(SEARXNG_CATEGORIES_DEFAULT).toBe('general');
    expect(SearxngCategoriesSchema.safeParse(SEARXNG_CATEGORIES_DEFAULT).success).toBe(true);
  });

  it.each(['general', 'it', 'general,it', 'social_media', 'a1,b2,c3', 'x'.repeat(200)])('accepts %j', (categories) => {
    expect(SearxngCategoriesSchema.safeParse(categories).success).toBe(true);
  });

  it.each([
    'general; drop',
    'general, it',
    'General',
    'social media',
    'it-news',
    '',
    ',it',
    'it,',
    'a,,b',
    'x'.repeat(201),
  ])('rejects %j', (categories) => {
    expect(SearxngCategoriesSchema.safeParse(categories).success).toBe(false);
  });

  it('explains the accepted format in the validation message', () => {
    const result = SearxngCategoriesSchema.safeParse('general; drop');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toContain('general,it');
    }
  });
});
