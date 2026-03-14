import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { logger } from '../../core/utils/logger.js';

// --- Zod schemas ---

const PageIdParamSchema = z.object({
  pageId: z.coerce.number().int().positive(),
});

const CommentIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const CreateCommentSchema = z.object({
  body: z.string().min(1).max(50_000),
  bodyHtml: z.string().min(1).max(100_000),
  parentId: z.number().int().positive().optional(),
  anchorType: z.enum(['selection', 'block']).optional(),
  anchorData: z.record(z.string(), z.unknown()).optional(),
});

const EditCommentSchema = z.object({
  body: z.string().min(1).max(50_000),
  bodyHtml: z.string().min(1).max(100_000),
});

const ReactionSchema = z.object({
  emoji: z.string().min(1).max(32),
});

const ListCommentsQuerySchema = z.object({
  includeResolved: z.enum(['true', 'false']).default('false'),
});

// --- Helpers ---

/** Extract @mention usernames from plain-text body. Matches @username patterns. */
function extractMentions(body: string): string[] {
  const matches = body.match(/@([a-zA-Z0-9_.-]+)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}

// --- Types ---

interface CommentRow {
  id: number;
  page_id: number;
  user_id: string;
  parent_id: number | null;
  body: string;
  body_html: string;
  is_resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  anchor_type: string | null;
  anchor_data: unknown | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  username: string;
}

interface ReactionRow {
  comment_id: number;
  emoji: string;
  user_id: string;
  username: string;
}

interface FormattedComment {
  id: number;
  pageId: number;
  userId: string;
  username: string;
  parentId: number | null;
  body: string;
  bodyHtml: string;
  isResolved: boolean;
  resolvedBy: string | null;
  resolvedAt: string | null;
  anchorType: string | null;
  anchorData: unknown | null;
  createdAt: string;
  updatedAt: string;
  reactions: Record<string, string[]>;
  replies?: FormattedComment[];
}

function formatComment(row: CommentRow): Omit<FormattedComment, 'reactions' | 'replies'> {
  return {
    id: row.id,
    pageId: row.page_id,
    userId: row.user_id,
    username: row.username,
    parentId: row.parent_id,
    body: row.body,
    bodyHtml: row.body_html,
    isResolved: row.is_resolved,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    anchorType: row.anchor_type,
    anchorData: row.anchor_data,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function commentsRoutes(fastify: FastifyInstance) {
  // All comment routes require authentication
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/pages/:pageId/comments — list threads for a page
  fastify.get('/pages/:pageId/comments', async (request) => {
    const { pageId } = PageIdParamSchema.parse(request.params);
    const { includeResolved } = ListCommentsQuerySchema.parse(request.query);

    let resolvedFilter = '';
    if (includeResolved === 'false') {
      resolvedFilter = 'AND (c.is_resolved = FALSE OR c.parent_id IS NOT NULL)';
    }

    // Fetch all non-deleted comments for the page (both top-level and replies)
    const result = await query<CommentRow>(
      `SELECT c.*, u.username
       FROM comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.page_id = $1 AND c.deleted_at IS NULL ${resolvedFilter}
       ORDER BY c.created_at ASC`,
      [pageId],
    );

    if (result.rows.length === 0) {
      return { comments: [], total: 0 };
    }

    // Fetch reactions for all returned comments
    const commentIds = result.rows.map((r) => r.id);
    const reactionsResult = await query<ReactionRow>(
      `SELECT cr.comment_id, cr.emoji, cr.user_id, u.username
       FROM comment_reactions cr
       JOIN users u ON u.id = cr.user_id
       WHERE cr.comment_id = ANY($1)`,
      [commentIds],
    );

    // Build reactions map: commentId -> { emoji -> [username, ...] }
    const reactionsMap = new Map<number, Record<string, string[]>>();
    for (const r of reactionsResult.rows) {
      if (!reactionsMap.has(r.comment_id)) {
        reactionsMap.set(r.comment_id, {});
      }
      const emojiMap = reactionsMap.get(r.comment_id)!;
      if (!emojiMap[r.emoji]) {
        emojiMap[r.emoji] = [];
      }
      emojiMap[r.emoji].push(r.username);
    }

    // Assemble top-level comments with nested replies (1 level)
    const topLevel: FormattedComment[] = [];
    const repliesMap = new Map<number, FormattedComment[]>();

    for (const row of result.rows) {
      const comment: FormattedComment = {
        ...formatComment(row),
        reactions: reactionsMap.get(row.id) ?? {},
      };

      if (row.parent_id === null) {
        comment.replies = [];
        topLevel.push(comment);
      } else {
        if (!repliesMap.has(row.parent_id)) {
          repliesMap.set(row.parent_id, []);
        }
        repliesMap.get(row.parent_id)!.push(comment);
      }
    }

    // Attach replies to their parent
    for (const comment of topLevel) {
      comment.replies = repliesMap.get(comment.id) ?? [];
    }

    return { comments: topLevel, total: topLevel.length };
  });

  // POST /api/pages/:pageId/comments — create a comment
  fastify.post('/pages/:pageId/comments', async (request, reply) => {
    const { pageId } = PageIdParamSchema.parse(request.params);
    const { body, bodyHtml, parentId, anchorType, anchorData } = CreateCommentSchema.parse(request.body);
    const userId = request.userId;

    // Verify page exists
    const pageCheck = await query('SELECT id FROM pages WHERE id = $1', [pageId]);
    if (pageCheck.rows.length === 0) {
      return reply.notFound('Page not found');
    }

    // If parentId is provided, verify the parent comment exists and belongs to the same page
    if (parentId) {
      const parentCheck = await query<{ id: number; page_id: number }>(
        'SELECT id, page_id FROM comments WHERE id = $1 AND deleted_at IS NULL',
        [parentId],
      );
      if (parentCheck.rows.length === 0) {
        return reply.notFound('Parent comment not found');
      }
      if (parentCheck.rows[0].page_id !== pageId) {
        return reply.badRequest('Parent comment belongs to a different page');
      }
    }

    const result = await query<CommentRow>(
      `INSERT INTO comments (page_id, user_id, parent_id, body, body_html, anchor_type, anchor_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [pageId, userId, parentId ?? null, body, bodyHtml, anchorType ?? null, anchorData ? JSON.stringify(anchorData) : null],
    );

    const commentRow = result.rows[0];

    // Extract and store @mentions
    const mentionedUsernames = extractMentions(body);
    if (mentionedUsernames.length > 0) {
      // Look up user IDs for the mentioned usernames
      const mentionedUsers = await query<{ id: string }>(
        'SELECT id FROM users WHERE username = ANY($1)',
        [mentionedUsernames],
      );

      for (const user of mentionedUsers.rows) {
        await query(
          'INSERT INTO comment_mentions (comment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [commentRow.id, user.id],
        );
      }
    }

    // Fetch the username for the response
    const userResult = await query<{ username: string }>(
      'SELECT username FROM users WHERE id = $1',
      [userId],
    );

    logger.info({ commentId: commentRow.id, pageId, userId }, 'Comment created');

    reply.status(201);
    return {
      ...formatComment({ ...commentRow, username: userResult.rows[0]?.username ?? 'unknown' }),
      reactions: {},
      replies: [],
    };
  });

  // PATCH /api/comments/:id — edit comment body
  fastify.patch('/comments/:id', async (request, reply) => {
    const { id } = CommentIdParamSchema.parse(request.params);
    const { body, bodyHtml } = EditCommentSchema.parse(request.body);
    const userId = request.userId;

    // Only the author can edit their own comment
    const existing = await query<{ user_id: string }>(
      'SELECT user_id FROM comments WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );

    if (existing.rows.length === 0) {
      return reply.notFound('Comment not found');
    }

    if (existing.rows[0].user_id !== userId) {
      return reply.forbidden('You can only edit your own comments');
    }

    const result = await query<CommentRow>(
      `UPDATE comments SET body = $1, body_html = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [body, bodyHtml, id],
    );

    // Re-process @mentions: clear old and insert new
    await query('DELETE FROM comment_mentions WHERE comment_id = $1', [id]);
    const mentionedUsernames = extractMentions(body);
    if (mentionedUsernames.length > 0) {
      const mentionedUsers = await query<{ id: string }>(
        'SELECT id FROM users WHERE username = ANY($1)',
        [mentionedUsernames],
      );
      for (const user of mentionedUsers.rows) {
        await query(
          'INSERT INTO comment_mentions (comment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, user.id],
        );
      }
    }

    const userResult = await query<{ username: string }>(
      'SELECT username FROM users WHERE id = $1',
      [userId],
    );

    logger.info({ commentId: id, userId }, 'Comment edited');

    return {
      ...formatComment({ ...result.rows[0], username: userResult.rows[0]?.username ?? 'unknown' }),
      reactions: {},
    };
  });

  // POST /api/comments/:id/resolve — resolve a thread (top-level only)
  fastify.post('/comments/:id/resolve', async (request, reply) => {
    const { id } = CommentIdParamSchema.parse(request.params);
    const userId = request.userId;

    const existing = await query<{ parent_id: number | null }>(
      'SELECT parent_id FROM comments WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );

    if (existing.rows.length === 0) {
      return reply.notFound('Comment not found');
    }

    if (existing.rows[0].parent_id !== null) {
      return reply.badRequest('Only top-level comments can be resolved');
    }

    await query(
      'UPDATE comments SET is_resolved = TRUE, resolved_by = $1, resolved_at = NOW(), updated_at = NOW() WHERE id = $2',
      [userId, id],
    );

    logger.info({ commentId: id, userId }, 'Comment resolved');
    return { success: true };
  });

  // POST /api/comments/:id/unresolve — unresolve a thread
  fastify.post('/comments/:id/unresolve', async (request, reply) => {
    const { id } = CommentIdParamSchema.parse(request.params);
    const userId = request.userId;

    const existing = await query<{ parent_id: number | null }>(
      'SELECT parent_id FROM comments WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );

    if (existing.rows.length === 0) {
      return reply.notFound('Comment not found');
    }

    if (existing.rows[0].parent_id !== null) {
      return reply.badRequest('Only top-level comments can be unresolved');
    }

    await query(
      'UPDATE comments SET is_resolved = FALSE, resolved_by = NULL, resolved_at = NULL, updated_at = NOW() WHERE id = $1',
      [id],
    );

    logger.info({ commentId: id, userId }, 'Comment unresolved');
    return { success: true };
  });

  // POST /api/comments/:id/reactions — toggle a reaction
  fastify.post('/comments/:id/reactions', async (request, reply) => {
    const { id } = CommentIdParamSchema.parse(request.params);
    const { emoji } = ReactionSchema.parse(request.body);
    const userId = request.userId;

    // Verify comment exists
    const commentCheck = await query(
      'SELECT id FROM comments WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    if (commentCheck.rows.length === 0) {
      return reply.notFound('Comment not found');
    }

    // Toggle: if the reaction exists, remove it; otherwise, add it
    const existing = await query(
      'SELECT 1 FROM comment_reactions WHERE comment_id = $1 AND user_id = $2 AND emoji = $3',
      [id, userId, emoji],
    );

    if (existing.rows.length > 0) {
      await query(
        'DELETE FROM comment_reactions WHERE comment_id = $1 AND user_id = $2 AND emoji = $3',
        [id, userId, emoji],
      );
      logger.info({ commentId: id, userId, emoji, action: 'removed' }, 'Reaction toggled');
      return { action: 'removed', emoji };
    } else {
      await query(
        'INSERT INTO comment_reactions (comment_id, user_id, emoji) VALUES ($1, $2, $3)',
        [id, userId, emoji],
      );
      logger.info({ commentId: id, userId, emoji, action: 'added' }, 'Reaction toggled');
      return { action: 'added', emoji };
    }
  });

  // DELETE /api/comments/:id — soft delete
  fastify.delete('/comments/:id', async (request, reply) => {
    const { id } = CommentIdParamSchema.parse(request.params);
    const userId = request.userId;

    const existing = await query<{ user_id: string }>(
      'SELECT user_id FROM comments WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );

    if (existing.rows.length === 0) {
      return reply.notFound('Comment not found');
    }

    // Only the author or an admin can delete
    if (existing.rows[0].user_id !== userId && request.userRole !== 'admin') {
      return reply.forbidden('You can only delete your own comments');
    }

    await query(
      'UPDATE comments SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1',
      [id],
    );

    logger.info({ commentId: id, userId }, 'Comment soft-deleted');
    return { success: true };
  });
}
