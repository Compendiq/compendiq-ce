import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';

const SearchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  spaceKey: z.string().optional(),
  author: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  tags: z.string().optional(),
  sort: z.enum(['relevance', 'modified', 'title']).default('relevance'),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const LogSearchSchema = z.object({
  query: z.string().min(1).max(500),
  resultCount: z.number().int().min(0),
});

const SuggestionsQuerySchema = z.object({
  q: z.string().min(1).max(200),
});

export async function searchRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/search — Enhanced full-text search with facets
  fastify.get('/search', async (request) => {
    const params = SearchQuerySchema.parse(request.query);
    const { q, spaceKey, author, dateFrom, dateTo, tags, sort, page, limit } = params;
    const userId = request.userId;

    const offset = (page - 1) * limit;
    const conditions: string[] = [];
    // $1 = search query, $2 = userId for access control
    const values: unknown[] = [q, userId];
    let paramIndex = 3;

    // Base full-text search condition
    conditions.push(
      `to_tsvector('english', COALESCE(cp.title, '') || ' ' || COALESCE(cp.body_text, '')) @@ plainto_tsquery('english', $1)`,
    );

    // Access control: confluence pages require space selection; standalone pages
    // require shared visibility or ownership by the current user
    conditions.push(
      `(
        (cp.source = 'confluence' AND uss.space_key IS NOT NULL)
        OR (cp.source = 'standalone' AND cp.visibility = 'shared')
        OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $2)
      )`,
    );

    // Exclude soft-deleted pages
    conditions.push('cp.deleted_at IS NULL');

    // Optional filters
    if (spaceKey) {
      conditions.push(`cp.space_key = $${paramIndex}`);
      values.push(spaceKey);
      paramIndex++;
    }

    if (author) {
      conditions.push(`cp.author = $${paramIndex}`);
      values.push(author);
      paramIndex++;
    }

    if (dateFrom) {
      conditions.push(`cp.last_modified_at >= $${paramIndex}`);
      values.push(dateFrom);
      paramIndex++;
    }

    if (dateTo) {
      conditions.push(`cp.last_modified_at <= $${paramIndex}`);
      values.push(dateTo);
      paramIndex++;
    }

    if (tags) {
      const tagArray = tags.split(',').map((t) => t.trim()).filter(Boolean);
      if (tagArray.length > 0) {
        conditions.push(`cp.labels @> $${paramIndex}::text[]`);
        values.push(tagArray);
        paramIndex++;
      }
    }

    const whereClause = conditions.join(' AND ');

    // Access control JOIN — LEFT JOIN so standalone pages (no space selection) are still included
    const accessJoin = `LEFT JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $2`;

    // Determine sort order
    let orderClause: string;
    switch (sort) {
      case 'modified':
        orderClause = 'cp.last_modified_at DESC NULLS LAST';
        break;
      case 'title':
        orderClause = 'cp.title ASC';
        break;
      case 'relevance':
      default:
        orderClause = 'rank DESC';
        break;
    }

    // Count total matches
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pages cp ${accessJoin} WHERE ${whereClause}`,
      values,
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Fetch paginated results with rank and snippet
    const limitParamIndex = paramIndex;
    const offsetParamIndex = paramIndex + 1;

    const dataResult = await query<{
      id: number;
      confluence_id: string;
      title: string;
      space_key: string;
      author: string | null;
      last_modified_at: Date | null;
      labels: string[];
      rank: number;
      snippet: string;
    }>(
      `SELECT cp.id, cp.confluence_id, cp.title, cp.space_key, cp.author,
              cp.last_modified_at, cp.labels,
              ts_rank(to_tsvector('english', COALESCE(cp.title, '') || ' ' || COALESCE(cp.body_text, '')),
                      plainto_tsquery('english', $1)) AS rank,
              ts_headline('english', COALESCE(cp.body_text, ''), plainto_tsquery('english', $1),
                          'MaxWords=30, MinWords=15, StartSel=<mark>, StopSel=</mark>') AS snippet
       FROM pages cp
       ${accessJoin}
       WHERE ${whereClause}
       ORDER BY ${orderClause}
       LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
      [...values, limit, offset],
    );

    // Facet aggregation — get available filter values with counts
    // Uses the same access control JOIN + deleted_at filter
    const facetResult = await query<{
      facet: string;
      value: string;
      count: string;
    }>(
      `SELECT 'space' AS facet, cp.space_key AS value, COUNT(*)::TEXT AS count
       FROM pages cp
       LEFT JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $2
       WHERE to_tsvector('english', COALESCE(cp.title, '') || ' ' || COALESCE(cp.body_text, ''))
             @@ plainto_tsquery('english', $1)
         AND (
           (cp.source = 'confluence' AND uss.space_key IS NOT NULL)
           OR (cp.source = 'standalone' AND cp.visibility = 'shared')
           OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $2)
         )
         AND cp.deleted_at IS NULL
         AND cp.space_key IS NOT NULL
       GROUP BY cp.space_key
       UNION ALL
       SELECT 'author' AS facet, cp.author AS value, COUNT(*)::TEXT AS count
       FROM pages cp
       LEFT JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $2
       WHERE to_tsvector('english', COALESCE(cp.title, '') || ' ' || COALESCE(cp.body_text, ''))
             @@ plainto_tsquery('english', $1)
         AND (
           (cp.source = 'confluence' AND uss.space_key IS NOT NULL)
           OR (cp.source = 'standalone' AND cp.visibility = 'shared')
           OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $2)
         )
         AND cp.deleted_at IS NULL
         AND cp.author IS NOT NULL
       GROUP BY cp.author
       UNION ALL
       SELECT 'tag' AS facet, tag AS value, COUNT(*)::TEXT AS count
       FROM pages cp
       LEFT JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $2
       CROSS JOIN unnest(cp.labels) AS tag
       WHERE to_tsvector('english', COALESCE(cp.title, '') || ' ' || COALESCE(cp.body_text, ''))
             @@ plainto_tsquery('english', $1)
         AND (
           (cp.source = 'confluence' AND uss.space_key IS NOT NULL)
           OR (cp.source = 'standalone' AND cp.visibility = 'shared')
           OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $2)
         )
         AND cp.deleted_at IS NULL
       GROUP BY tag`,
      [q, userId],
    );

    // Organize facets by type
    const facets: Record<string, Array<{ value: string; count: number }>> = {
      spaces: [],
      authors: [],
      tags: [],
    };

    for (const row of facetResult.rows) {
      const entry = { value: row.value, count: parseInt(row.count, 10) };
      switch (row.facet) {
        case 'space':
          facets.spaces.push(entry);
          break;
        case 'author':
          facets.authors.push(entry);
          break;
        case 'tag':
          facets.tags.push(entry);
          break;
      }
    }

    const totalPages = Math.ceil(total / limit);

    return {
      items: dataResult.rows.map((row) => ({
        id: row.id,
        confluenceId: row.confluence_id,
        title: row.title,
        spaceKey: row.space_key,
        author: row.author,
        lastModifiedAt: row.last_modified_at,
        labels: row.labels,
        rank: row.rank,
        snippet: row.snippet,
      })),
      total,
      page,
      limit,
      totalPages,
      facets,
    };
  });

  // POST /api/search/log — Log a search query for content gap detection
  fastify.post('/search/log', async (request) => {
    const body = LogSearchSchema.parse(request.body);

    await query(
      `INSERT INTO search_analytics (user_id, query, result_count, search_type)
       VALUES ($1, $2, $3, 'faceted')`,
      [request.userId, body.query, body.resultCount],
    );

    return { success: true };
  });

  // GET /api/search/suggestions — Autocomplete from popular recent queries
  fastify.get('/search/suggestions', async (request) => {
    const { q } = SuggestionsQuerySchema.parse(request.query);

    const result = await query<{
      query_text: string;
      frequency: string;
    }>(
      `SELECT LOWER(TRIM(query)) AS query_text, COUNT(*) AS frequency
       FROM search_analytics
       WHERE LOWER(TRIM(query)) LIKE LOWER($1) || '%'
       GROUP BY LOWER(TRIM(query))
       ORDER BY COUNT(*) DESC
       LIMIT 10`,
      [q],
    );

    return {
      suggestions: result.rows.map((row) => ({
        query: row.query_text,
        frequency: parseInt(row.frequency, 10),
      })),
    };
  });
}
