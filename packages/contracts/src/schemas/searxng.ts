import { z } from 'zod';

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
