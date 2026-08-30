import { z } from 'zod';
import { PageVisibilityEnum } from './pages.js';

/**
 * Notion internal integration token — write-only. Never appears on a
 * response schema (issue #1462 / #1459). Same never-echo contract as
 * `confluencePat` / `hasConfluencePat`.
 */
export const ConnectNotionSchema = z.object({
  token: z.string().trim().min(1).max(4096),
});
export type ConnectNotionInput = z.infer<typeof ConnectNotionSchema>;

export const NotionConnectionResponseSchema = z
  .object({
    hasToken: z.boolean(),
  })
  .strict();
export type NotionConnectionResponse = z.infer<typeof NotionConnectionResponseSchema>;

/**
 * Picker copy for Notion object types this importer cannot represent locally
 * (linked views, data sources, canvases, …). Databases are NOT in this set
 * anymore — see `NotionTreeDatabaseNode` (#1459 follow-up).
 */
export const NOTION_UNSUPPORTED_LABEL = 'Not supported — stays in Notion' as const;

/**
 * How a selected Notion database is imported.
 *
 * - `table` — one local page whose body is the rows × properties table. Only
 *   offered when every sampled row page is body-less, because flattening a row
 *   that has content would drop that content.
 * - `pages` — the database becomes a container page and each row is imported
 *   as an article, nested structure preserved. The wiki shape.
 * - `skip`  — excluded, rows excluded.
 */
export const NotionDatabaseModeEnum = z.enum(['skip', 'table', 'pages']);
export type NotionDatabaseMode = z.infer<typeof NotionDatabaseModeEnum>;

export type NotionTreePageNode = {
  id: string;
  title: string;
  type: 'page';
  selectable: true;
  alreadyImported?: boolean;
  localPageId?: number;
  isDatabaseRow?: boolean;
  url?: string;
  children: NotionTreeNode[];
};

/**
 * A database the importer CAN take.
 *
 * `recommendedMode` is the workspace scan's verdict and the picker's default;
 * the picker may override it. The scan is a bounded sample, so it is advisory —
 * the import re-checks every row before it flattens anything into a table.
 */
export type NotionTreeDatabaseNode = {
  id: string;
  title: string;
  type: 'database';
  selectable: true;
  recommendedMode: 'table' | 'pages';
  /**
   * Whether the sampled row pages carried body content. `unknown` means the
   * scan could not tell (nothing sampled, or every sample failed).
   */
  rowContent: 'none' | 'some' | 'unknown';
  /** Notion wiki database — its row pages carry a `verification` property. */
  isWiki: boolean;
  /** Row pages visible to the integration. */
  rowCount: number;
  /** Property names, in the database's own order. */
  columns: string[];
  alreadyImported?: boolean;
  localPageId?: number;
  url?: string;
  children: NotionTreeNode[];
};

/** An object type with no local representation. Never a database. */
export type NotionTreeSkippedNode = {
  id: string;
  title: string;
  type: 'unsupported';
  selectable: false;
  skipReason: string;
  reasonCode?: string;
  /** Notion database id when `id` is a linked-view key, not the object id. */
  linkedFromId?: string;
  url?: string;
  children: NotionTreeNode[];
};

export type NotionTreeNode = NotionTreePageNode | NotionTreeDatabaseNode | NotionTreeSkippedNode;

export const NotionTreeNodeSchema: z.ZodType<NotionTreeNode> = z.lazy(() =>
  z.union([
    z
      .object({
        id: z.string().min(1),
        title: z.string(),
        type: z.literal('page'),
        selectable: z.literal(true),
        alreadyImported: z.boolean().optional(),
        localPageId: z.number().int().positive().optional(),
        isDatabaseRow: z.boolean().optional(),
        url: z.string().optional(),
        children: z.array(NotionTreeNodeSchema),
      })
      .strict(),
    z
      .object({
        id: z.string().min(1),
        title: z.string(),
        type: z.literal('database'),
        selectable: z.literal(true),
        recommendedMode: z.enum(['table', 'pages']),
        rowContent: z.enum(['none', 'some', 'unknown']),
        isWiki: z.boolean(),
        rowCount: z.number().int().nonnegative(),
        columns: z.array(z.string()),
        alreadyImported: z.boolean().optional(),
        localPageId: z.number().int().positive().optional(),
        url: z.string().optional(),
        children: z.array(NotionTreeNodeSchema),
      })
      .strict(),
    z
      .object({
        id: z.string().min(1),
        title: z.string(),
        type: z.literal('unsupported'),
        selectable: z.literal(false),
        skipReason: z.string().min(1),
        reasonCode: z.string().min(1).optional(),
        linkedFromId: z.string().min(1).optional(),
        url: z.string().optional(),
        children: z.array(NotionTreeNodeSchema),
      })
      .strict(),
  ]),
);

export const NotionTreeResponseSchema = z
  .object({
    nodes: z.array(NotionTreeNodeSchema),
  })
  .strict();
export type NotionTreeResponse = z.infer<typeof NotionTreeResponseSchema>;

/** Confirmed selection + local destination for a one-shot Notion import (#1465). */
export const NotionImportRequestSchema = z
  .object({
    pageIds: z.array(z.string().trim().min(1).max(128)).min(1).max(200),
    spaceKey: z.string().min(1).optional(),
    parentId: z.union([z.string(), z.number()]).transform(String).optional(),
    visibility: PageVisibilityEnum.optional().default('shared'),
    overwriteExisting: z.boolean().optional(),
    databaseModes: z.record(z.string(), NotionDatabaseModeEnum).optional(),
  })
  .strict();
export type NotionImportRequest = z.infer<typeof NotionImportRequestSchema>;

export const NotionImportItemStatusEnum = z.enum(['success', 'skip', 'fail', 'already_imported']);
export type NotionImportItemStatus = z.infer<typeof NotionImportItemStatusEnum>;

export const NotionImportItemSchema = z
  .object({
    notionPageId: z.string().min(1),
    status: NotionImportItemStatusEnum,
    localPageId: z.number().int().positive().optional(),
    reason: z.string().optional(),
    updated: z.boolean().optional(),
    /**
     * What the row actually became. `table` marks a database flattened into one
     * page; `article` marks a wiki row carrying its property metadata.
     */
    importedAs: z.enum(['page', 'article', 'table']).optional(),
  })
  .strict();
export type NotionImportItem = z.infer<typeof NotionImportItemSchema>;

export const NotionImportResponseSchema = z
  .object({
    items: z.array(NotionImportItemSchema),
  })
  .strict();
export type NotionImportResponse = z.infer<typeof NotionImportResponseSchema>;
