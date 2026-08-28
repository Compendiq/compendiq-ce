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

/** Picker copy for unsupported Notion types (databases, linked views, canvases, …). */
export const NOTION_UNSUPPORTED_LABEL = 'Not supported — stays in Notion' as const;

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

export type NotionTreeSkippedNode = {
  id: string;
  title: string;
  type: 'database' | 'unsupported';
  selectable: false;
  skipReason: string;
  reasonCode?: string;
  /** Notion database id when `id` is a linked-view key, not the object id. */
  linkedFromId?: string;
  url?: string;
  children: NotionTreeNode[];
};

export type NotionTreeNode = NotionTreePageNode | NotionTreeSkippedNode;

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
        type: z.enum(['database', 'unsupported']),
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
  })
  .strict();
export type NotionImportItem = z.infer<typeof NotionImportItemSchema>;

export const NotionImportResponseSchema = z
  .object({
    items: z.array(NotionImportItemSchema),
  })
  .strict();
export type NotionImportResponse = z.infer<typeof NotionImportResponseSchema>;
