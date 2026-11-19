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

/**
 * SearXNG categories (`admin_settings.searxng_categories`), Settings → Integrations → SearXNG.
 *
 * The backend sends the saved value with every search as the mcp-docs
 * `search_web` tool's `categories` argument, and the sidecar puts it verbatim
 * into the `categories` query parameter of the SearXNG request (#1769). The
 * sidecar declares the same pattern and length
 * (`categories: z.string().regex(/^[a-z0-9_]+(,[a-z0-9_]+)*$/).max(200)` in
 * mcp-docs/src/index.ts) and searches `general` when the argument is absent
 * (mcp-docs/src/tools/search-web.ts). It does not depend on this package, so
 * both sides are pinned with literal tests on their JSON Schema:
 * schemas/searxng.categories.test.ts here and
 * mcp-docs/src/admin-settings.integration.test.ts against the running
 * sidecar's `tools/list`. Never widen one side alone.
 */
export const SEARXNG_CATEGORIES_DEFAULT = 'general';

export const SearxngCategoriesSchema = z
  .string()
  .max(200)
  .regex(/^[a-z0-9_]+(,[a-z0-9_]+)*$/, {
    message: 'Use SearXNG category names in lowercase, separated by commas without spaces — for example general,it',
  });

/**
 * GET /api/admin/searxng. There is deliberately no `url`: the SearXNG endpoint
 * is `SEARXNG_URL` on the mcp-docs service, not an admin setting (#1769).
 */
export const SearxngSettingsSchema = z.object({
  maxResults: z.number().int().min(SEARXNG_MAX_RESULTS_MIN).max(SEARXNG_MAX_RESULTS_MAX),
  categories: SearxngCategoriesSchema,
});
export type SearxngSettings = z.infer<typeof SearxngSettingsSchema>;

/**
 * PUT /api/admin/searxng — every field optional; an absent field is left unchanged.
 *
 * Deliberately NOT `.strict()`: a `url` sent by a pre-#1769 client (cached SPA,
 * rolling deploy) is stripped and the rest of the body still applies — the
 * reasoning of `UpdateAdminSettingsSchema` in schemas/admin.ts. Nothing is
 * written under `searxng_url`.
 */
export const UpdateSearxngSettingsSchema = z.object({
  maxResults: z.number().int().min(SEARXNG_MAX_RESULTS_MIN).max(SEARXNG_MAX_RESULTS_MAX).optional(),
  categories: SearxngCategoriesSchema.optional(),
});
export type UpdateSearxngSettingsInput = z.infer<typeof UpdateSearxngSettingsSchema>;
