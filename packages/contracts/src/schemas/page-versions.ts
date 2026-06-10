import { z } from 'zod';

export const PageVersionSummarySchema = z.object({
  versionNumber: z.number(),
  title: z.string(),
  editedAt: z.string().nullable(),
  syncedAt: z.string().nullable(),
  author: z.string().nullable(),
  message: z.string().nullable(),
  isCurrent: z.boolean(),
});
export type PageVersionSummary = z.infer<typeof PageVersionSummarySchema>;

/**
 * #763: outcome of the lazy on-open Confluence version-list backfill.
 *
 * - `ok` — the historical list was (re)imported; the response is complete.
 * - `skipped_no_credentials` — the viewing user has no stored Confluence
 *   URL/PAT, so the import never ran; historical versions may be missing.
 * - `failed` — the import was attempted but errored (Confluence unreachable,
 *   auth rejected, …); the list may be incomplete.
 */
export const VersionBackfillStatusSchema = z.enum(['ok', 'skipped_no_credentials', 'failed']);
export type VersionBackfillStatus = z.infer<typeof VersionBackfillStatusSchema>;

export const PageVersionsResponseSchema = z.object({
  versions: z.array(PageVersionSummarySchema),
  pageId: z.string(),
  /**
   * Optional for backward compatibility; absent for standalone pages (no
   * Confluence backfill applies) and for older backends. Clients must treat
   * a missing value as "no signal", not as a failure.
   */
  backfillStatus: VersionBackfillStatusSchema.optional(),
  /** Human-readable detail accompanying a non-`ok` backfillStatus. */
  backfillDetail: z.string().optional(),
});
export type PageVersionsResponse = z.infer<typeof PageVersionsResponseSchema>;

/**
 * Detail response for `GET /api/pages/:id/versions/:version`.
 *
 * Bodies may be null when a backfilled version's content has not yet been
 * lazily fetched from Confluence (and the fetch is best-effort). `editedAt` /
 * `syncedAt` / `author` / `message` are absent on the synthetic current row.
 */
export const PageVersionDetailSchema = z.object({
  confluenceId: z.string().nullable(),
  versionNumber: z.number(),
  title: z.string(),
  bodyHtml: z.string().nullable(),
  bodyText: z.string().nullable(),
  editedAt: z.string().nullable().optional(),
  syncedAt: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
  isCurrent: z.boolean(),
});
export type PageVersionDetail = z.infer<typeof PageVersionDetailSchema>;
