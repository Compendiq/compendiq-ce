import { z } from 'zod';

export const PageTypeEnum = z.enum(['page', 'folder']);
export type PageType = z.infer<typeof PageTypeEnum>;

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
  pageType: PageTypeEnum.default('page'),
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
  summaryHtml: z.string().nullable().optional(),
  summaryGeneratedAt: z.coerce.date().nullable().optional(),
  summaryModel: z.string().nullable().optional(),
  summaryError: z.string().nullable().optional(),
  hasDraft: z.boolean().default(false),
  draftUpdatedAt: z.coerce.date().nullable().optional(),
});

export const CreatePageSchema = z.object({
  spaceKey: z.string().min(1).optional(),
  title: z.string().min(1).max(500),
  bodyHtml: z.string(),
  parentId: z.union([z.string(), z.number()]).transform(String).optional(),
  pageType: PageTypeEnum.optional().default('page'),
  source: PageSourceEnum.optional(),
  visibility: PageVisibilityEnum.optional().default('shared'),
});

export const UpdatePageSchema = z.object({
  title: z.string().min(1).max(500),
  bodyHtml: z.string(),
  version: z.number().int().positive().optional(),
  visibility: PageVisibilityEnum.optional(),
});

// ── Hybrid / semantic search ──────────────────────────────────────────────────

export const SearchModeEnum = z.enum(['keyword', 'semantic', 'hybrid']);
export type SearchMode = z.infer<typeof SearchModeEnum>;

/** Shared query schema for the GET /api/search endpoint's mode parameter. */
export const SearchHybridQuerySchema = z.object({
  q: z.string().min(1).max(500),
  mode: SearchModeEnum.default('keyword'),
  spaceKey: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export type SearchHybridQuery = z.infer<typeof SearchHybridQuerySchema>;

/** Shape of a single search result returned by the hybrid endpoint. */
export const SearchResultItemSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string(),
  spaceKey: z.string().nullable(),
  excerpt: z.string(),
  score: z.number(),
});
export type SearchResultItem = z.infer<typeof SearchResultItemSchema>;

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
  sort: z.enum(['title', 'modified', 'author', 'quality', 'relevance']).default('title'),
});

export type PageSummary = z.infer<typeof PageSummarySchema>;
export type PageDetail = z.infer<typeof PageDetailSchema>;
export type CreatePageInput = z.infer<typeof CreatePageSchema>;
export type UpdatePageInput = z.infer<typeof UpdatePageSchema>;
export const PageTreeItemSchema = z.object({
  id: z.union([z.string(), z.number()]),
  spaceKey: z.string().nullable(),
  title: z.string(),
  pageType: PageTypeEnum.default('page'),
  parentId: z.string().nullable(),
  labels: z.array(z.string()),
  lastModifiedAt: z.coerce.date().nullable(),
});

export const PageTreeQuerySchema = z.object({
  spaceKey: z.string().optional(),
});

export const SaveDraftSchema = z.object({
  title: z.string().min(1).max(500),
  bodyHtml: z.string(),
});

export const PublishDraftSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  bodyHtml: z.string().optional(),
});

// -- Duplicates & Export validation schemas (Issue #580) --

export const DuplicatesQuerySchema = z.object({
  threshold: z.coerce.number().min(0).max(1).default(0.15),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const AdminDuplicatesQuerySchema = z.object({
  threshold: z.coerce.number().min(0).max(1).default(0.15),
});

export const BatchExportBodySchema = z.object({
  pageIds: z.array(z.coerce.number().int().positive()).min(1).max(50),
});

export type DuplicatesQuery = z.infer<typeof DuplicatesQuerySchema>;
export type AdminDuplicatesQuery = z.infer<typeof AdminDuplicatesQuerySchema>;
export type BatchExportBody = z.infer<typeof BatchExportBodySchema>;

export type PageListQuery = z.infer<typeof PageListQuerySchema>;
export type PageTreeItem = z.infer<typeof PageTreeItemSchema>;
export type SaveDraftInput = z.infer<typeof SaveDraftSchema>;
export type PublishDraftInput = z.infer<typeof PublishDraftSchema>;
