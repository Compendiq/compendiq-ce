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

export const PageVersionsResponseSchema = z.object({
  versions: z.array(PageVersionSummarySchema),
  pageId: z.string(),
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
