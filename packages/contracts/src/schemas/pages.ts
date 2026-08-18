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
  embeddingError: z.string().nullable().optional(),
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
  verifiedAt: z.coerce.date().nullable().optional(),
});

export const CreatePageSchema = z.object({
  spaceKey: z.string().min(1).optional(),
  title: z.string().min(1).max(500),
  bodyHtml: z.string(),
  parentId: z.union([z.string(), z.number()]).transform(String).optional(),
  pageType: PageTypeEnum.optional().default('page'),
  source: PageSourceEnum.optional(),
  visibility: PageVisibilityEnum.optional().default('shared'),
  /**
   * Labels to apply at creation (#1133). Carried here rather than applied by a
   * follow-up `PUT /pages/:id/labels` because the id this route returns is
   * ambiguous: for a Confluence create it is the *Confluence content id*, which
   * is numeric, and the labels route reads a numeric id as a database primary
   * key — so the follow-up would silently label a different page.
   *
   * Bounds mirror the Markdown-import route the front-matter comes from.
   */
  labels: z.array(z.string().min(1).max(100)).max(50).optional(),
});

export const UpdatePageSchema = z.object({
  title: z.string().min(1).max(500),
  bodyHtml: z.string(),
  version: z.number().int().positive().optional(),
  visibility: PageVisibilityEnum.optional(),
});

/**
 * Body for POST /api/pages/:id/versions/:version/restore.
 *
 * `version` is the optimistic-concurrency guard: the live page version the
 * client believed it was reverting from. If the page has since advanced, the
 * server returns 409 — same contract as {@link UpdatePageSchema}. It is the
 * *current* version, not the target snapshot (which comes from the URL param).
 */
export const RestoreVersionSchema = z.object({
  version: z.number().int().positive().optional(),
});
export type RestoreVersionInput = z.infer<typeof RestoreVersionSchema>;

/** Response shape of a successful version restore. */
export const RestoreVersionResponseSchema = z.object({
  id: z.number(),
  title: z.string(),
  version: z.number(),
  restoredFrom: z.number(),
  source: PageSourceEnum,
  pushedToConfluence: z.boolean(),
});
export type RestoreVersionResponse = z.infer<typeof RestoreVersionResponseSchema>;

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

// ── Trash (GET /api/pages/trash) ──────────────────────────────────────────────

/**
 * One soft-deleted standalone article as it crosses the wire. The backend
 * stringifies the integer PK and serializes all dates to ISO strings
 * (same convention as {@link PageVersionSummarySchema} responses).
 * `autoPurgeAt` = `deletedAt` + the standalone-trash retention window, so the
 * Trash UI shows the same date the maintenance purge acts on.
 */
export const TrashItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  source: PageSourceEnum,
  visibility: PageVisibilityEnum,
  deletedAt: z.string(),
  createdAt: z.string(),
  deletedBy: z.string(),
  autoPurgeAt: z.string(),
});
export type TrashItem = z.infer<typeof TrashItemSchema>;

/** Response shape of GET /api/pages/trash. */
export const TrashListResponseSchema = z.object({
  items: z.array(TrashItemSchema),
  total: z.number().int().nonnegative(),
});
export type TrashListResponse = z.infer<typeof TrashListResponseSchema>;

// -- Relocate between a local space and Confluence (Issue #1123) --

/** Which system the article ends up in after the relocate. */
export const RelocateTargetEnum = z.enum(['confluence', 'local']);
export type RelocateTarget = z.infer<typeof RelocateTargetEnum>;

/**
 * A principal that gains or loses access as a result of a relocate. `label` is
 * display text (username / group name); `kind` distinguishes the well-known
 * pseudo-principals from real rows so the UI can render them differently.
 */
export const RelocatePrincipalSchema = z.object({
  kind: z.enum(['user', 'group', 'everyone', 'owner']),
  label: z.string(),
});
export type RelocatePrincipal = z.infer<typeof RelocatePrincipalSchema>;

/**
 * Who can read the article before vs. after the move (product decision 4 on
 * #1123: the access-model change is warned, then the target model applies —
 * no hybrid state). `gains`/`loses` are the resolved difference, capped by
 * `truncated` when a space has more assignments than the preview enumerates.
 */
export const RelocateAccessChangeSchema = z.object({
  from: z.string(),
  to: z.string(),
  gains: z.array(RelocatePrincipalSchema),
  loses: z.array(RelocatePrincipalSchema),
  truncated: z.boolean().default(false),
});

/**
 * Query for `GET /api/pages/:id/relocate/preview`. Both are optional: the
 * dialog fetches the preview once to render the counts, then re-fetches with
 * the user's chosen destination so `accessChange` names real principals rather
 * than describing the target model generically.
 */
export const RelocatePreviewQuerySchema = z.object({
  spaceKey: z.string().min(1).optional(),
  visibility: PageVisibilityEnum.optional(),
});
export type RelocatePreviewQuery = z.infer<typeof RelocatePreviewQuerySchema>;

/**
 * Response of `GET /api/pages/:id/relocate/preview` — everything the
 * confirmation dialog must state before the user commits.
 *
 * `localVersionCount` is the exact number of `page_versions` rows destroyed by
 * a move to Confluence; the caller must echo it back as
 * `acknowledgeDiscardedVersions`, so a generic "history will be lost" warning
 * cannot satisfy the confirmation.
 */
export const RelocatePreviewSchema = z.object({
  pageId: z.number().int().positive(),
  title: z.string(),
  source: PageSourceEnum,
  spaceKey: z.string().nullable(),
  confluenceId: z.string().nullable(),
  /** The only direction this page can move in, derived from its current source. */
  target: RelocateTargetEnum,
  /**
   * Direct children whose `parent_id` the move rewrites so the parent link
   * survives. The children themselves are **not** moved.
   */
  childCount: z.number().int().nonnegative(),
  /**
   * What the move does to the subtree, when `childCount > 0` (null otherwise).
   *
   * Children keep their own `source`, `space_key` and `path` while their
   * `parent_id` now points across the boundary — so they stay in the origin
   * space's tree with their parent no longer in it. A bare count cannot convey
   * that, and the confirmation dialog has no other way to learn it.
   */
  subtreeEffect: z
    .object({
      /** Space the children remain in after the move. */
      childrenRemainInSpaceKey: z.string().nullable(),
      /** Space the page itself ends up in. */
      pageMovesToSpaceKey: z.string().nullable(),
      /** True when those differ, i.e. the children visibly detach in the origin tree. */
      childrenDetachFromOriginTree: z.boolean(),
    })
    .nullable(),
  /** Attachments migrated between the two attachment stores. */
  attachmentCount: z.number().int().nonnegative(),
  /** Exact count to echo back in `acknowledgeDiscardedVersions`. 0 for a move to local. */
  localVersionCount: z.number().int().nonnegative(),
  accessChange: RelocateAccessChangeSchema,
  /** Confluence page deleted upstream by this move. Null for a move to Confluence. */
  upstreamDeletion: z
    .object({
      confluenceId: z.string(),
      spaceKey: z.string(),
      title: z.string(),
    })
    .nullable(),
});
export type RelocatePreview = z.infer<typeof RelocatePreviewSchema>;

/**
 * Body of `POST /api/pages/:id/relocate`.
 *
 * Every acknowledgement is a required, non-defaulted field: `z.literal(true)`
 * cannot be omitted, and the two echo-back fields are verified against live
 * state server-side (409 on mismatch). A client cannot blind-confirm a move
 * without naming what it destroys.
 */
export const RelocatePageSchema = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('confluence'),
    /** Confluence space the article is published into. Chosen from a picker. */
    spaceKey: z.string().min(1),
    /**
     * Standalone `private`/`shared` visibility has no Confluence analogue —
     * after the move the space's RBAC governs access, which can widen it.
     */
    acknowledgeAccessChange: z.literal(true),
    /**
     * Exact `page_versions` count that will be discarded (decision 3). Verified
     * against the live count; a stale or guessed number is rejected with 409.
     */
    acknowledgeDiscardedVersions: z.number().int().nonnegative(),
  }),
  z.object({
    target: z.literal('local'),
    /** Target local space, or null for a space-less standalone article. */
    spaceKey: z.string().min(1).nullable().default(null),
    /**
     * Required, never inherited: Confluence has no visibility analogue, so the
     * caller must choose the standalone access model explicitly (decision 4).
     */
    visibility: PageVisibilityEnum,
    acknowledgeAccessChange: z.literal(true),
    /**
     * The Confluence page and space deleted upstream (decision 1). Both are
     * matched against the live row, so the confirmation names exactly what is
     * being destroyed rather than asserting a bare boolean.
     */
    confirmDeleteConfluencePage: z.object({
      confluenceId: z.string().min(1),
      /**
       * Deliberately NOT `.min(1)`: `pages.space_key` is nullable (migration
       * 029) and both the preview and the route encode that NULL as `''`, so
       * an empty string here is the no-space encoding rather than an omission.
       * A `.min(1)` rejects the body before the route can compare it, which
       * makes a space-less Confluence row impossible to relocate at all. The
       * confirmation's force comes from matching the live row, not from
       * non-emptiness.
       */
      spaceKey: z.string(),
    }),
  }),
]);
export type RelocatePageInput = z.infer<typeof RelocatePageSchema>;

/** Response of a successful `POST /api/pages/:id/relocate`. */
export const RelocatePageResponseSchema = z.object({
  pageId: z.number().int().positive(),
  source: PageSourceEnum,
  spaceKey: z.string().nullable(),
  confluenceId: z.string().nullable(),
  childrenRepointed: z.number().int().nonnegative(),
  versionsDiscarded: z.number().int().nonnegative(),
  attachmentsMigrated: z.number().int().nonnegative(),
  /**
   * False when the local side committed but the upstream Confluence delete
   * could not be confirmed. The article is safe either way; the Confluence
   * page may still exist and be re-imported by the next sync as a new row.
   */
  upstreamDeleted: z.boolean(),
  warnings: z.array(z.string()).default([]),
});
export type RelocatePageResponse = z.infer<typeof RelocatePageResponseSchema>;

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
