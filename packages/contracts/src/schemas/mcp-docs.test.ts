import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  MCP_DOCS_CACHE_TTL_DEFAULT,
  MCP_DOCS_CACHE_TTL_MAX,
  MCP_DOCS_CACHE_TTL_MIN,
  MCP_DOCS_MAX_CONTENT_LENGTH_DEFAULT,
  MCP_DOCS_MAX_CONTENT_LENGTH_MAX,
  MCP_DOCS_MAX_CONTENT_LENGTH_MIN,
  UpdateMcpDocsSettingsSchema,
} from './mcp-docs.js';

describe('MCP Docs settings contract shares the sidecar tool ranges (#1769)', () => {
  // Literal on purpose: the sidecar cannot import this package.
  // mcp-docs/src/index.ts declares `cache_ttl: z.number().int().min(60).max(86400)`
  // and `max_length: z.number().max(100_000)` (= ABSOLUTE_MAX_LENGTH in
  // tools/fetch-url.ts); mcp-docs/src/admin-settings.integration.test.ts pins
  // the same numbers against the running sidecar's tools/list.
  it("pins the cacheTtl and maxContentLength ranges to the sidecar's fetch_url arguments", () => {
    expect({
      cacheTtl: { min: MCP_DOCS_CACHE_TTL_MIN, max: MCP_DOCS_CACHE_TTL_MAX, fallback: MCP_DOCS_CACHE_TTL_DEFAULT },
      maxContentLength: {
        min: MCP_DOCS_MAX_CONTENT_LENGTH_MIN,
        max: MCP_DOCS_MAX_CONTENT_LENGTH_MAX,
        fallback: MCP_DOCS_MAX_CONTENT_LENGTH_DEFAULT,
      },
    }).toEqual({
      cacheTtl: { min: 60, max: 86_400, fallback: 3600 },
      maxContentLength: { min: 1000, max: 100_000, fallback: 50_000 },
    });
  });

  it('declares the same ranges on the PUT /api/admin/mcp-docs schema', () => {
    const properties = z.toJSONSchema(UpdateMcpDocsSettingsSchema).properties;
    expect(properties?.cacheTtl).toMatchObject({ type: 'integer', minimum: 60, maximum: 86_400 });
    expect(properties?.maxContentLength).toMatchObject({ type: 'integer', minimum: 1000, maximum: 100_000 });
  });

  it.each([999, 100_001, 500_000, 1000.5])('rejects maxContentLength %s naming the field', (value) => {
    const result = UpdateMcpDocsSettingsSchema.safeParse({ maxContentLength: value });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('maxContentLength');
    }
  });

  it.each([59, 86_401, 60.5])('rejects cacheTtl %s naming the field', (value) => {
    const result = UpdateMcpDocsSettingsSchema.safeParse({ cacheTtl: value });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('cacheTtl');
    }
  });

  it('accepts the boundaries and an empty update', () => {
    expect(UpdateMcpDocsSettingsSchema.parse({ maxContentLength: 1000, cacheTtl: 60 })).toEqual({ maxContentLength: 1000, cacheTtl: 60 });
    expect(UpdateMcpDocsSettingsSchema.parse({ maxContentLength: 100_000, cacheTtl: 86_400 })).toEqual({ maxContentLength: 100_000, cacheTtl: 86_400 });
    expect(UpdateMcpDocsSettingsSchema.parse({})).toEqual({});
  });
});
