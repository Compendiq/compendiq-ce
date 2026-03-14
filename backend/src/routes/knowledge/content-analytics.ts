import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';

// ── Request schemas ────────────────────────────────────────────────────────────

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });

const FeedbackBodySchema = z.object({
  isHelpful: z.boolean(),
  comment: z.string().max(2000).optional(),
});

const ViewBodySchema = z.object({
  sessionId: z.string().max(256).optional(),
});

const TrendingQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(365).default(7),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const ContentQualityQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
});

const ContentGapsQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(365).default(30),
  minOccurrences: z.coerce.number().int().positive().default(2),
});

// ── Routes ─────────────────────────────────────────────────────────────────────

export async function contentAnalyticsRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // ── POST /api/pages/:id/feedback ─────────────────────────────────────────
  // Submit or update "was this helpful?" vote (one per user per page, upsert)
  fastify.post('/pages/:id/feedback', async (request, reply) => {
    const { id: pageId } = IdParamSchema.parse(request.params);
    const { isHelpful, comment } = FeedbackBodySchema.parse(request.body);
    const userId = request.userId;

    const result = await query<{ id: number }>(
      `INSERT INTO article_feedback (page_id, user_id, is_helpful, comment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (page_id, user_id)
       DO UPDATE SET is_helpful = EXCLUDED.is_helpful,
                     comment    = EXCLUDED.comment,
                     updated_at = NOW()
       RETURNING id`,
      [pageId, userId, isHelpful, comment ?? null],
    );

    reply.status(201).send({ id: result.rows[0].id });
  });

  // ── GET /api/pages/:id/feedback ──────────────────────────────────────────
  // Feedback summary for a specific page + current user's vote
  fastify.get('/pages/:id/feedback', async (request) => {
    const { id: pageId } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    const summary = await query<{
      helpful_count: string;
      not_helpful_count: string;
      total_count: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE is_helpful = TRUE)  AS helpful_count,
         COUNT(*) FILTER (WHERE is_helpful = FALSE) AS not_helpful_count,
         COUNT(*)                                    AS total_count
       FROM article_feedback
       WHERE page_id = $1`,
      [pageId],
    );

    const userVote = await query<{ is_helpful: boolean; comment: string | null }>(
      `SELECT is_helpful, comment
       FROM article_feedback
       WHERE page_id = $1 AND user_id = $2`,
      [pageId, userId],
    );

    const row = summary.rows[0];
    return {
      helpful: parseInt(row.helpful_count, 10),
      notHelpful: parseInt(row.not_helpful_count, 10),
      total: parseInt(row.total_count, 10),
      userVote: userVote.rows.length > 0
        ? { isHelpful: userVote.rows[0].is_helpful, comment: userVote.rows[0].comment }
        : null,
    };
  });

  // ── POST /api/pages/:id/view ─────────────────────────────────────────────
  // Record a page view (deduplicated by session_id within 30 minutes)
  fastify.post('/pages/:id/view', async (request, reply) => {
    const { id: pageId } = IdParamSchema.parse(request.params);
    const { sessionId } = ViewBodySchema.parse(request.body ?? {});
    const userId = request.userId;

    // Deduplicate: skip if same user+page+session viewed within last 30 min
    if (sessionId) {
      const recent = await query<{ id: number }>(
        `SELECT id FROM page_views
         WHERE page_id = $1 AND user_id = $2 AND session_id = $3
           AND viewed_at > NOW() - INTERVAL '30 minutes'
         LIMIT 1`,
        [pageId, userId, sessionId],
      );

      if (recent.rows.length > 0) {
        reply.status(200).send({ recorded: false, reason: 'duplicate' });
        return;
      }
    }

    await query(
      `INSERT INTO page_views (page_id, user_id, session_id)
       VALUES ($1, $2, $3)`,
      [pageId, userId, sessionId ?? null],
    );

    reply.status(201).send({ recorded: true });
  });

  // ── GET /api/analytics/trending ──────────────────────────────────────────
  // Most-viewed articles in the last N days
  fastify.get('/analytics/trending', async (request) => {
    const { days, limit } = TrendingQuerySchema.parse(request.query);

    const result = await query<{
      page_id: number;
      view_count: string;
      unique_viewers: string;
      title: string;
      space_key: string;
      confluence_id: string;
    }>(
      `SELECT
         pv.page_id,
         COUNT(*)                       AS view_count,
         COUNT(DISTINCT pv.user_id)     AS unique_viewers,
         cp.title,
         cp.space_key,
         cp.confluence_id
       FROM page_views pv
       JOIN pages cp ON cp.id = pv.page_id
       WHERE pv.viewed_at >= NOW() - ($1 || ' days')::INTERVAL
       GROUP BY pv.page_id, cp.title, cp.space_key, cp.confluence_id
       ORDER BY COUNT(*) DESC
       LIMIT $2`,
      [String(days), limit],
    );

    return {
      articles: result.rows.map((row) => ({
        pageId: row.page_id,
        confluenceId: row.confluence_id,
        title: row.title,
        spaceKey: row.space_key,
        viewCount: parseInt(row.view_count, 10),
        uniqueViewers: parseInt(row.unique_viewers, 10),
      })),
      periodDays: days,
    };
  });

  // ── GET /api/analytics/content-quality ───────────────────────────────────
  // Dashboard: pages sorted by "needs attention" (low feedback, stale, few views)
  fastify.get('/analytics/content-quality', async (request) => {
    const { limit } = ContentQualityQuerySchema.parse(request.query);

    const result = await query<{
      page_id: number;
      confluence_id: string;
      title: string;
      space_key: string;
      last_modified_at: Date | null;
      helpful_count: string;
      not_helpful_count: string;
      total_feedback: string;
      view_count: string;
    }>(
      `SELECT
         cp.id                                                          AS page_id,
         cp.confluence_id,
         cp.title,
         cp.space_key,
         cp.last_modified_at,
         COALESCE(fb.helpful_count, 0)                                 AS helpful_count,
         COALESCE(fb.not_helpful_count, 0)                             AS not_helpful_count,
         COALESCE(fb.total_feedback, 0)                                AS total_feedback,
         COALESCE(pv.view_count, 0)                                    AS view_count
       FROM pages cp
       LEFT JOIN (
         SELECT page_id,
                COUNT(*) FILTER (WHERE is_helpful = TRUE)  AS helpful_count,
                COUNT(*) FILTER (WHERE is_helpful = FALSE) AS not_helpful_count,
                COUNT(*)                                   AS total_feedback
         FROM article_feedback
         GROUP BY page_id
       ) fb ON fb.page_id = cp.id
       LEFT JOIN (
         SELECT page_id, COUNT(*) AS view_count
         FROM page_views
         WHERE viewed_at >= NOW() - INTERVAL '30 days'
         GROUP BY page_id
       ) pv ON pv.page_id = cp.id
       ORDER BY
         COALESCE(fb.not_helpful_count, 0) DESC,
         cp.last_modified_at ASC NULLS FIRST
       LIMIT $1`,
      [limit],
    );

    return {
      pages: result.rows.map((row) => ({
        pageId: row.page_id,
        confluenceId: row.confluence_id,
        title: row.title,
        spaceKey: row.space_key,
        lastModifiedAt: row.last_modified_at,
        helpful: parseInt(row.helpful_count as string, 10),
        notHelpful: parseInt(row.not_helpful_count as string, 10),
        totalFeedback: parseInt(row.total_feedback as string, 10),
        viewCount: parseInt(row.view_count as string, 10),
      })),
    };
  });

  // ── GET /api/analytics/content-gaps ──────────────────────────────────────
  // Failed/low-score searches → content gap queue (reuses search_analytics table)
  fastify.get('/analytics/content-gaps', async (request) => {
    const { days, minOccurrences } = ContentGapsQuerySchema.parse(request.query);

    const result = await query<{
      query_text: string;
      occurrence_count: string;
      last_searched: Date;
      avg_max_score: number | null;
    }>(
      `SELECT
         LOWER(TRIM(query)) AS query_text,
         COUNT(*)           AS occurrence_count,
         MAX(created_at)    AS last_searched,
         AVG(max_score)     AS avg_max_score
       FROM search_analytics
       WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
         AND (result_count = 0 OR max_score < 0.3)
       GROUP BY LOWER(TRIM(query))
       HAVING COUNT(*) >= $2
       ORDER BY COUNT(*) DESC, MAX(created_at) DESC
       LIMIT 100`,
      [String(days), minOccurrences],
    );

    return {
      gaps: result.rows.map((row) => ({
        query: row.query_text,
        occurrences: parseInt(row.occurrence_count, 10),
        lastSearched: row.last_searched,
        avgMaxScore: row.avg_max_score,
      })),
      total: result.rows.length,
      periodDays: days,
    };
  });
}
