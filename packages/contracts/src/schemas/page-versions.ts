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
