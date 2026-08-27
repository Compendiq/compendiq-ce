/**
 * The one `search_analytics` query sampler (#1260).
 *
 * Both real-query harnesses — the production retrieval benchmark and the
 * shadow-migration comparison — sample distinct production queries over a
 * window. They differ only in ORDER: the benchmark wants the *latest*
 * distinct queries (what people ask now), the comparison wants the most
 * *frequent* (weight the verdict toward what people actually ask). One
 * sampler with an `orderBy` switch, so the normalisation — TRIM, the 3..1000
 * length gate, case-insensitive dedup keeping the most recent spelling —
 * cannot drift between the two and quietly make their query sets
 * incomparable.
 *
 * Queries are real user data: callers are admin-only, never log the text,
 * and never let it leave the instance.
 */
import { query } from '../../../core/db/postgres.js';

export interface AnalyticsQuerySampleOptions {
  /** Window in days, counted back from now. */
  days: number;
  /** Maximum distinct queries returned. */
  limit: number;
  orderBy: 'recency' | 'frequency';
}

export async function sampleAnalyticsQueries(
  opts: AnalyticsQuerySampleOptions,
): Promise<string[]> {
  // The ORDER BY is chosen from two fixed strings — nothing request-supplied
  // is ever interpolated. Frequency ties break toward the more recent query,
  // so the frequency ordering is deterministic on a corpus of one-off asks.
  const orderBy =
    opts.orderBy === 'frequency'
      ? 'COUNT(*) DESC, MAX(created_at) DESC'
      : 'MAX(created_at) DESC';
  const result = await query<{ query_text: string }>(
    `SELECT (ARRAY_AGG(TRIM(query) ORDER BY created_at DESC))[1] AS query_text
     FROM search_analytics
     WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')
       AND char_length(TRIM(query)) BETWEEN 3 AND 1000
     GROUP BY LOWER(TRIM(query))
     ORDER BY ${orderBy}
     LIMIT $2`,
    [opts.days, opts.limit],
  );
  return result.rows.map((row) => row.query_text);
}
