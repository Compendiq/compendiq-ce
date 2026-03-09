import { z } from 'zod';

export const PageSummarySchema = z.object({
  id: z.string(),
  spaceKey: z.string(),
  title: z.string(),
  author: z.string().nullable(),
  lastModifiedAt: z.coerce.date().nullable(),
  lastSynced: z.coerce.date(),
  version: z.number(),
  parentId: z.string().nullable(),
  labels: z.array(z.string()),
  embeddingDirty: z.boolean(),
});

export const PageDetailSchema = PageSummarySchema.extend({
  bodyHtml: z.string(),
  bodyText: z.string(),
});

export const CreatePageSchema = z.object({
  spaceKey: z.string().min(1),
  title: z.string().min(1).max(500),
  bodyHtml: z.string(),
  parentId: z.string().optional(),
});

export const UpdatePageSchema = z.object({
  title: z.string().min(1).max(500),
  bodyHtml: z.string(),
  version: z.number().int().positive().optional(),
});

export const PageListQuerySchema = z.object({
  spaceKey: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sort: z.enum(['title', 'modified', 'author']).default('title'),
});

export type PageSummary = z.infer<typeof PageSummarySchema>;
export type PageDetail = z.infer<typeof PageDetailSchema>;
export type CreatePageInput = z.infer<typeof CreatePageSchema>;
export type UpdatePageInput = z.infer<typeof UpdatePageSchema>;
export const PageTreeItemSchema = z.object({
  id: z.string(),
  spaceKey: z.string(),
  title: z.string(),
  parentId: z.string().nullable(),
  labels: z.array(z.string()),
  lastModifiedAt: z.coerce.date().nullable(),
});

export const PageTreeQuerySchema = z.object({
  spaceKey: z.string().optional(),
});

export type PageListQuery = z.infer<typeof PageListQuerySchema>;
export type PageTreeItem = z.infer<typeof PageTreeItemSchema>;
