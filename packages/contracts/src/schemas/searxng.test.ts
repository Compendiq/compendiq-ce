import { describe, it, expect } from 'vitest';
import {
  SEARXNG_MAX_RESULTS_DEFAULT,
  SEARXNG_MAX_RESULTS_MAX,
  SEARXNG_MAX_RESULTS_MIN,
  SearxngSettingsSchema,
  UpdateSearxngSettingsSchema,
} from './searxng.js';

describe('SearXNG result-width contract (#1768)', () => {
  // The sidecar does not depend on this package: mcp-docs/src/index.ts declares
  // `num_results: z.number().min(1).max(10).default(5)` and
  // mcp-docs/src/tools/search-web.ts `MAX_NUM_RESULTS = 10`. The numbers below
  // are literal on purpose — mcp-docs/src/search-web-limits.test.ts pins the
  // same literals against the running sidecar, so the two sides cannot drift
  // apart without one of the two suites going red.
  it("pins the shared SearXNG result range to the sidecar's", () => {
    expect({
      min: SEARXNG_MAX_RESULTS_MIN,
      max: SEARXNG_MAX_RESULTS_MAX,
      default: SEARXNG_MAX_RESULTS_DEFAULT,
    }).toEqual({ min: 1, max: 10, default: 5 });
  });

  it.each([0, 11, 20, 2.5])('UpdateSearxngSettingsSchema rejects maxResults %s (outside 1–10 or not an integer)', (value) => {
    const result = UpdateSearxngSettingsSchema.safeParse({ maxResults: value });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('maxResults');
    }
  });

  it('UpdateSearxngSettingsSchema accepts the boundaries 1 and 10 and an absent maxResults', () => {
    expect(UpdateSearxngSettingsSchema.safeParse({ maxResults: 1 }).success).toBe(true);
    expect(UpdateSearxngSettingsSchema.safeParse({ maxResults: 10 }).success).toBe(true);
    expect(UpdateSearxngSettingsSchema.parse({})).toEqual({});
  });

  it('SearxngSettingsSchema parses the GET shape and rejects maxResults 11', () => {
    const settings = { maxResults: 10, categories: 'general' };
    expect(SearxngSettingsSchema.parse(settings)).toEqual(settings);
    expect(SearxngSettingsSchema.safeParse({ ...settings, maxResults: 11 }).success).toBe(false);
  });
});
