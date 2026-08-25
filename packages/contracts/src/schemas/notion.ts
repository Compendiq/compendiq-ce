import { z } from 'zod';

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
  url?: string;
  children: NotionTreeNode[];
};

export type NotionTreeSkippedNode = {
  id: string;
  title: string;
  type: 'database' | 'unsupported';
  selectable: false;
  skipReason: typeof NOTION_UNSUPPORTED_LABEL;
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
        skipReason: z.literal(NOTION_UNSUPPORTED_LABEL),
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
