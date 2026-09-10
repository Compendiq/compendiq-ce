import { z } from 'zod';

/**
 * Anchor types supported for comments.
 * - 'selection': inline text selection anchored to a specific range and quote
 * - 'block': anchored to a specific block element
 */
export const CommentAnchorTypeSchema = z.enum(['selection', 'block']);
export type CommentAnchorType = z.infer<typeof CommentAnchorTypeSchema>;

/**
 * Anchor metadata payload attached when a comment targets a text selection or block.
 */
export const CommentAnchorDataSchema = z
  .object({
    text: z.string().optional(),
    quote: z.string().optional(),
    from: z.number().optional(),
    to: z.number().optional(),
    commentId: z.string().optional(),
  })
  .passthrough();

export type CommentAnchorData = z.infer<typeof CommentAnchorDataSchema>;

/**
 * Zod schema for creating a new comment or reply.
 */
export const CreateCommentSchema = z.object({
  body: z.string().min(1).max(50_000),
  bodyHtml: z.string().min(1).max(100_000).optional(),
  parentId: z.coerce.number().int().positive().optional(),
  anchorType: CommentAnchorTypeSchema.optional(),
  anchorData: CommentAnchorDataSchema.optional(),
});

export type CreateCommentInput = z.infer<typeof CreateCommentSchema>;

/**
 * Zod schema for editing an existing comment body.
 */
export const EditCommentSchema = z.object({
  body: z.string().min(1).max(50_000),
  bodyHtml: z.string().min(1).max(100_000).optional(),
});

export type EditCommentInput = z.infer<typeof EditCommentSchema>;

/**
 * Zod schema for toggling emoji reactions.
 */
export const CommentReactionSchema = z.object({
  emoji: z.string().min(1).max(32),
});

export type CommentReactionInput = z.infer<typeof CommentReactionSchema>;

/**
 * Query schema for listing comments.
 */
export const ListCommentsQuerySchema = z.object({
  includeResolved: z.enum(['true', 'false']).default('false'),
});

export type ListCommentsQuery = z.infer<typeof ListCommentsQuerySchema>;

/**
 * Full formatted comment entity schema (matches backend response & frontend consumer).
 */
export const CommentSchema: z.ZodType<CommentDto> = z.lazy(() =>
  z.object({
    id: z.coerce.string(),
    pageId: z.coerce.string(),
    userId: z.string(),
    username: z.string(),
    parentId: z.coerce.string().nullable().optional(),
    body: z.string(),
    bodyHtml: z.string(),
    isResolved: z.boolean(),
    resolvedBy: z.string().nullable().optional(),
    resolvedAt: z.string().nullable().optional(),
    anchorType: CommentAnchorTypeSchema.nullable().optional(),
    anchorData: CommentAnchorDataSchema.nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    reactions: z.record(z.string(), z.array(z.string())).default({}),
    replies: z.array(z.lazy(() => CommentSchema)).optional(),
  }),
);

export interface CommentDto {
  id: string;
  pageId: string;
  userId: string;
  username: string;
  parentId?: string | null;
  body: string;
  bodyHtml: string;
  isResolved: boolean;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  anchorType?: CommentAnchorType | null;
  anchorData?: CommentAnchorData | null;
  createdAt: string;
  updatedAt: string;
  reactions: Record<string, string[]>;
  replies?: CommentDto[];
}

export const CommentsListResponseSchema = z.object({
  comments: z.array(CommentSchema),
  total: z.number(),
});

export type CommentsListResponse = z.infer<typeof CommentsListResponseSchema>;
