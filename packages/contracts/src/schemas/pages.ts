import { z } from 'zod';

export const PageEmbeddingStatusEnum = z.enum(['not_embedded', 'embedding', 'embedded', 'failed']);
export type PageEmbeddingStatus = z.infer<typeof PageEmbeddingStatusEnum>;

export const PageQualityStatusEnum = z.enum(['pending', 'analyzing', 'analyzed', 'failed', 'skipped']);
export type PageQualityStatus = z.infer<typeof PageQualityStatusEnum>;

export const PageSummaryStatusEnum = z.enum(['pending', 'summarizing', 'summarized', 'failed', 'skipped']);
export type PageSummaryStatus = z.infer<typeof PageSummaryStatusEnum>;

export const PageSourceEnum = z.enum(['confluence', 'standalone']);
export type PageSource = z.infer<typeof PageSourceEnum>;

export const PageVisibilityEnum = z.enum(['private', 'shared']);
export type PageVisibility = z.infer<typeof PageVisibilityEnum>;

export const PageSummarySchema = z.object({
  id: z.union([z.string(), z.number()]),
  spaceKey: z.string().nullable(),
  title: z.string(),
  author: z.string().nullable(),
  lastModifiedAt: z.coerce.date().nullable(),
  lastSynced: z.coerce.date(),
  version: z.number(),
  parentId: z.string().nullable(),
  labels: z.array(z.string()),
  embeddingDirty: z.boolean(),
  embeddingStatus: PageEmbeddingStatusEnum.default('not_embedded'),
  embeddedAt: z.coerce.date().nullable().optional(),
  qualityScore: z.number().nullable().optional(),
  qualityStatus: PageQualityStatusEnum.nullable().optional(),
  qualityCompleteness: z.number().nullable().optional(),
  qualityClarity: z.number().nullable().optional(),
  qualityStructure: z.number().nullable().optional(),
  qualityAccuracy: z.number().nullable().optional(),
  qualityReadability: z.number().nullable().optional(),
  qualitySummary: z.string().nullable().optional(),
  qualityAnalyzedAt: z.coerce.date().nullable().optional(),
  qualityError: z.string().nullable().optional(),
  summaryStatus: PageSummaryStatusEnum.default('pending').optional(),
  source: PageSourceEnum.default('confluence'),
  visibility: PageVisibilityEnum.default('shared'),
  createdByUserId: z.union([z.string(), z.number()]).nullable().optional(),
  deletedAt: z.string().nullable().optional(),
  confluenceId: z.string().nullable().optional(),
});

export const PageDetailSchema = PageSummarySchema.extend({
  bodyHtml: z.string(),
  bodyText: z.string(),
  hasChildren: z.boolean().default(false),
  hasDraft: z.boolean().optional(),
  draftUpdatedAt: z.string().nullable().optional(),
  summaryHtml: z.string().nullable().optional(),
  summaryGeneratedAt: z.coerce.date().nullable().optional(),
  summaryModel: z.string().nullable().optional(),
  summaryError: z.string().nullable().optional(),
});

export const CreatePageSchema = z.object({
  spaceKey: z.string().min(1).optional(),
  title: z.string().min(1).max(500),
  bodyHtml: z.string(),
  parentId: z.string().optional(),
  source: PageSourceEnum.optional().default('standalone'),
  visibility: PageVisibilityEnum.optional().default('shared'),
});

export const UpdatePageSchema = z.object({
  title: z.string().min(1).max(500),
  bodyHtml: z.string(),
  version: z.number().int().positive().optional(),
  visibility: PageVisibilityEnum.optional(),
});

export const SaveDraftSchema = z.object({
  bodyHtml: z.string().min(1),
});

export const PublishDraftSchema = z.object({
  version: z.number().int().positive().optional(),
});

export const PageListQuerySchema = z.object({
  spaceKey: z.string().optional(),
  search: z.string().optional(),
  author: z.string().optional(),
  labels: z.string().optional(), // comma-separated label names
  freshness: z.enum(['fresh', 'recent', 'aging', 'stale']).optional(),
  embeddingStatus: z.enum(['pending', 'done']).optional(),
  qualityMin: z.coerce.number().int().min(0).max(100).optional(),
  qualityMax: z.coerce.number().int().min(0).max(100).optional(),
  qualityStatus: z.enum(['pending', 'analyzing', 'analyzed', 'failed', 'skipped']).optional(),
  source: PageSourceEnum.optional(),
  visibility: PageVisibilityEnum.optional(),
  dateFrom: z.string().optional(), // ISO date string
  dateTo: z.string().optional(),   // ISO date string
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sort: z.enum(['title', 'modified', 'author', 'quality']).default('title'),
});

export type PageSummary = z.infer<typeof PageSummarySchema>;
export type PageDetail = z.infer<typeof PageDetailSchema>;
export type CreatePageInput = z.infer<typeof CreatePageSchema>;
export type UpdatePageInput = z.infer<typeof UpdatePageSchema>;
export type SaveDraftInput = z.infer<typeof SaveDraftSchema>;
export type PublishDraftInput = z.infer<typeof PublishDraftSchema>;
export const PageTreeItemSchema = z.object({
  id: z.union([z.string(), z.number()]),
  spaceKey: z.string().nullable(),
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
