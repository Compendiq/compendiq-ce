import { z } from 'zod';

/**
 * Admin-configurable SearXNG result width (`admin_settings.searxng_max_results`).
 * The range is the sidecar's: mcp-docs `search_web` declares
 * `num_results: z.number().min(1).max(10).default(5)` (mcp-docs/src/index.ts) and
 * `MAX_NUM_RESULTS = 10` / `DEFAULT_NUM_RESULTS = 5` (mcp-docs/src/tools/search-web.ts).
 * The sidecar does not depend on this package, so both sides are pinned with
 * literal tests: schemas/searxng.test.ts (these numbers) and
 * mcp-docs/src/search-web-limits.test.ts (the running sidecar's behaviour).
 * Never widen one side without the other (#1768).
 */
export const SEARXNG_MAX_RESULTS_MIN = 1;
export const SEARXNG_MAX_RESULTS_MAX = 10;
export const SEARXNG_MAX_RESULTS_DEFAULT = 5;

/** GET /api/admin/searxng */
export const SearxngSettingsSchema = z.object({
  url: z.string(),
  maxResults: z.number().int().min(SEARXNG_MAX_RESULTS_MIN).max(SEARXNG_MAX_RESULTS_MAX),
  categories: z.string(),
});
export type SearxngSettings = z.infer<typeof SearxngSettingsSchema>;

/** PUT /api/admin/searxng — every field optional; an absent field is left unchanged. */
export const UpdateSearxngSettingsSchema = z.object({
  url: z.string().url().optional(),
  maxResults: z.number().int().min(SEARXNG_MAX_RESULTS_MIN).max(SEARXNG_MAX_RESULTS_MAX).optional(),
  categories: z.string().max(200).optional(),
});
export type UpdateSearxngSettingsInput = z.infer<typeof UpdateSearxngSettingsSchema>;
