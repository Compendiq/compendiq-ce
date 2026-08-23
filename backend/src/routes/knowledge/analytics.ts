import { FastifyInstance } from 'fastify';
import { KNOWLEDGE_GAP_PREDICATE_SQL, GAP_AVG_MAX_SCORE_SQL } from './_gap-predicate.js';
import { z } from 'zod';
import { ConfidenceDistributionSchema } from '@compendiq/contracts';
import type {
  ConfidenceDistribution,
  ConfidenceDistributionBucket,
} from '@compendiq/contracts';
import { query } from '../../core/db/postgres.js';

const KnowledgeGapsQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(365).default(30),
  minOccurrences: z.coerce.number().int().positive().default(1),
});

const SearchTrendsQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(365).default(30),
});

/**
 * #1284 — the confidence readout's window, surface and bases. Fixed rather
 * than query parameters: the readout is one line under a knob, not a report,
 * and every one of these is a claim the panel's copy makes on screen.
 */
const CONFIDENCE_WINDOW_DAYS = 7;
const CONFIDENCE_SURFACE = 'ask' as const;
const CONFIDENCE_BASES = ['similarity', 'rerank'] as const;

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
         ${GAP_AVG_MAX_SCORE_SQL}
       FROM search_analytics
       WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
         -- Rationale + derivation live in _gap-predicate.ts — one shared
         -- fragment for both routes and the pinning test.
         AND ${KNOWLEDGE_GAP_PREDICATE_SQL}
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

  /**
   * GET /api/analytics/confidence-distribution — #1284.
   *
   * What the #1105 refuse gate has actually been measuring on this
   * deployment, per basis, over a fixed window. The Retrieval panel renders
   * it beside each threshold input, because both scales are
   * deployment-specific (the embedding model moves the cosine distribution,
   * the reranker's normalisation the relevance one) and the panel's only
   * previous advice was "go read your own logs".
   *
   * Four decisions are load-bearing.
   *
   * **`surface = 'ask'`.** The gate is evaluated on `/llm/ask` and nowhere
   * else. Page searches file rows through the same writer, so without this
   * filter a busy `/search` would decide the percentiles an operator tunes
   * the ASSISTANT's refusal policy against. A row whose surface is NULL
   * (everything before migration 098) is unknown, and unknown is not 'ask'.
   *
   * **Per basis, never merged.** The basis flips per request, and the two
   * scales are unrelated — one distribution over both would be a number with
   * no meaning on either knob.
   *
   * **`confidence IS NOT NULL`.** A `none`-basis row, and any row whose
   * verdict had no number, is excluded rather than counted as 0: an
   * unmeasurable set is not a weak one, and admitting it would drag both
   * percentiles toward the floor and make every threshold look generous.
   *
   * **A fixed 7-day window**, comfortably inside the default 90-day
   * `search_analytics` retention. A shorter configured retention simply
   * shrinks the sample, which the `count` on the wire makes visible.
   */
  fastify.get('/analytics/confidence-distribution', async () => {
    const result = await query<{
      basis: string;
      sample_count: string;
      p50: string | number | null;
      p90: string | number | null;
    }>(
      `SELECT
         confidence_basis AS basis,
         COUNT(*) AS sample_count,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY confidence) AS p50,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY confidence) AS p90
       FROM search_analytics
       WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
         AND surface = $2
         AND confidence IS NOT NULL
         AND confidence_basis = ANY($3::text[])
       GROUP BY confidence_basis`,
      [String(CONFIDENCE_WINDOW_DAYS), CONFIDENCE_SURFACE, [...CONFIDENCE_BASES]],
    );

    const empty = (): ConfidenceDistributionBucket => ({ p50: null, p90: null, count: 0 });
    const buckets: Record<(typeof CONFIDENCE_BASES)[number], ConfidenceDistributionBucket> = {
      similarity: empty(),
      rerank: empty(),
    };
    for (const row of result.rows) {
      if (row.basis !== 'similarity' && row.basis !== 'rerank') continue;
      buckets[row.basis] = {
        // `percentile_cont` over a REAL column answers double precision,
        // which node-postgres hands back as a JS number — but a grouped row
        // can only exist with at least one non-null value, so a null here
        // would be a contradiction rather than an empty sample. Coalesced to
        // null anyway: the contract says "null, never NaN", and `Number(null)`
        // is 0, which is exactly the lie this route must not tell.
        p50: row.p50 === null ? null : Number(row.p50),
        p90: row.p90 === null ? null : Number(row.p90),
        count: parseInt(row.sample_count, 10),
      };
    }

    const body: ConfidenceDistribution = {
      windowDays: CONFIDENCE_WINDOW_DAYS,
      surface: CONFIDENCE_SURFACE,
      similarity: buckets.similarity,
      rerank: buckets.rerank,
    };
    // Parsed, not merely typed (review r1). The comments above and the schema
    // itself promise "null, never NaN" and a non-negative integer count —
    // claims a `ConfidenceDistribution` annotation cannot enforce, because
    // `Number()` and `parseInt()` both answer NaN inside the `number` type and
    // `JSON.stringify` then quietly ships it as `null`. That is the one lie
    // this route must not tell: an operator reading `p50 null` concludes their
    // assistant measured nothing. Parsing turns it into a 500 the logs show.
    // Security §4 — a Zod schema on every API boundary, this one included.
    return ConfidenceDistributionSchema.parse(body);
  });
}
