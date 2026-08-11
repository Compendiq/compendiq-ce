import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';

const KnowledgeGapsQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(365).default(30),
  minOccurrences: z.coerce.number().int().positive().default(1),
});

const SearchTrendsQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(365).default(30),
});

export async function analyticsRoutes(fastify: FastifyInstance) {
  // All analytics routes require admin role
  fastify.addHook('onRequest', fastify.requireAdmin);

  // GET /api/analytics/knowledge-gaps - queries with 0 results or low scores
  fastify.get('/analytics/knowledge-gaps', async (request) => {
    const { days: daysNum, minOccurrences: minOcc } = KnowledgeGapsQuerySchema.parse(request.query);

    // Get queries with 0 results, grouped by normalized query text
    const result = await query<{
      query_text: string;
      occurrence_count: string;
      last_searched: Date;
      avg_max_score: number | null;
    }>(
      `SELECT
         LOWER(TRIM(query)) AS query_text,
         COUNT(*) AS occurrence_count,
         MAX(created_at) AS last_searched,
         AVG(max_score) AS avg_max_score
       FROM search_analytics
       WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
         -- max_score carries a DIFFERENT unit per search_type (the
         -- pre-existing defect 09-flow's score table documents), so the
         -- low-score half of the gap predicate must be per-unit (#1269
         -- review m13 + follow-up): fusion rows are bounded at
         -- rrfWorstCase(true) ~0.0328 since #1106's best-chunk-only rule —
         -- 0.03 sits between "found by one leg" (~0.0164) and "found by
         -- both" (~0.0328), so a gap is "best hit single-leg only". The old
         -- 0.3 would classify EVERY fusion row as a gap. Semantic rows are
         -- cosines and keyword rows raw ts_rank — both keep the 0.3 the
         -- reports were tuned against. Fusion rows persisted before the
         -- #1106 deploy carry the summed scale and are imprecise under any
         -- constant; the 09-flow caveat applies.
         AND (result_count = 0 OR CASE
           WHEN search_type IN ('hybrid', 'hybrid_rerank', 'keyword_fallback') THEN max_score < 0.03
           ELSE max_score < 0.3
         END)
       GROUP BY LOWER(TRIM(query))
       HAVING COUNT(*) >= $2
       ORDER BY COUNT(*) DESC, MAX(created_at) DESC
       LIMIT 100`,
      [String(daysNum), minOcc],
    );

    return {
      gaps: result.rows.map((row) => ({
        query: row.query_text,
        occurrences: parseInt(row.occurrence_count, 10),
        lastSearched: row.last_searched,
        avgMaxScore: row.avg_max_score,
      })),
      total: result.rows.length,
      periodDays: daysNum,
    };
  });

  // GET /api/analytics/search-trends - popular queries and search volume
  fastify.get('/analytics/search-trends', async (request) => {
    const { days: daysNum } = SearchTrendsQuerySchema.parse(request.query);

    // Top queries by frequency
    const topQueries = await query<{
      query_text: string;
      search_count: string;
      avg_results: string;
      avg_score: number | null;
    }>(
      `SELECT
         LOWER(TRIM(query)) AS query_text,
         COUNT(*) AS search_count,
         AVG(result_count)::NUMERIC(10,1) AS avg_results,
         AVG(max_score) AS avg_score
       FROM search_analytics
       WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
       GROUP BY LOWER(TRIM(query))
       ORDER BY COUNT(*) DESC
       LIMIT 50`,
      [String(daysNum)],
    );

    // Daily search volume
    const volumeResult = await query<{
      day: string;
      total_searches: string;
      zero_result_searches: string;
    }>(
      `SELECT
         DATE(created_at) AS day,
         COUNT(*) AS total_searches,
         COUNT(*) FILTER (WHERE result_count = 0) AS zero_result_searches
       FROM search_analytics
       WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
       GROUP BY DATE(created_at)
       ORDER BY DATE(created_at) DESC`,
      [String(daysNum)],
    );

    return {
      topQueries: topQueries.rows.map((row) => ({
        query: row.query_text,
        searchCount: parseInt(row.search_count, 10),
        avgResults: parseFloat(row.avg_results),
        avgScore: row.avg_score,
      })),
      dailyVolume: volumeResult.rows.map((row) => ({
        date: row.day,
        totalSearches: parseInt(row.total_searches, 10),
        zeroResultSearches: parseInt(row.zero_result_searches, 10),
      })),
      periodDays: daysNum,
    };
  });
}
