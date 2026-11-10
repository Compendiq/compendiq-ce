import { z } from 'zod';

/**
 * Admin-configurable SearXNG result width (`admin_settings.searxng_max_results`).
 * Moved here from backend/src/routes/llm/llm-admin.ts unchanged (#1768).
 */
export const SEARXNG_MAX_RESULTS_MIN = 1;
export const SEARXNG_MAX_RESULTS_MAX = 20;
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
