import { z } from 'zod';

/**
 * SearXNG categories (`admin_settings.searxng_categories`), Settings → Integrations → SearXNG.
 */
export const SEARXNG_CATEGORIES_DEFAULT = 'general';

export const SearxngCategoriesSchema = z.string().max(200);
