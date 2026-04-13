import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SearchHybridQuerySchema } from '@compendiq/contracts';
import { query } from '../../core/db/postgres.js';
import { getUserAccessibleSpaces } from '../../core/services/rbac-service.js';
import { getFtsLanguage } from '../../core/services/fts-language.js';
import {
  vectorSearch,
  hybridSearch,
  recordSearchAnalytics,
} from '../../domains/llm/services/rag-service.js';
import { providerGenerateEmbedding } from '../../domains/llm/services/llm-provider.js';
import { logger } from '../../core/utils/logger.js';

/**
 * Fuzzy title similarity threshold for pg_trgm.
 * 0.3 (30%) provides a useful recall without excessive false positives.
 * Named constant makes it easy to tune for specific corpora.
 */
const TRGM_SIMILARITY_THRESHOLD = 0.3;

/**
 * Full search query schema — extends the shared SearchHybridQuerySchema from
 * contracts with keyword-mode specific filter/pagination fields.
 */
const SearchQuerySchema = SearchHybridQuerySchema.extend({
  author: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  tags: z.string().optional(),
  sort: z.enum(['relevance', 'modified', 'title']).default('relevance'),
  page: z.coerce.number().int().positive().default(1),
  includeFacets: z.preprocess((val) => val === 'false' || val === '0' ? false : val === undefined ? undefined : true, z.boolean().default(true)),
});

const LogSearchSchema = z.object({
  query: z.string().min(1).max(500),
  resultCount: z.number().int().min(0),
});

const SuggestionsQuerySchema = z.object({
  q: z.string().min(1).max(200),
});

/**
 * Generate a query embedding, returning a 502 error response on failure.
 * Shared by semantic and hybrid search modes to avoid duplicating the
 * try/catch + error-formatting logic.
 */
async function generateSearchEmbedding(
  userId: string,
  q: string,
  modeName: string,
  reply: import('fastify').FastifyReply,
): Promise<number[] | null> {
  try {
    const embeddings = await providerGenerateEmbedding(userId, q);
    return embeddings[0] ?? null;
  } catch (err) {
    logger.warn({ err }, `Embedding generation failed for ${modeName} search`);
    reply.status(502).send({
      error: 'EmbeddingFailed',
      message: `Embedding generation failed: ${err instanceof Error ? err.message : String(err)}`,
      statusCode: 502,
    });
    return null;
  }
}

export async function searchRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/search — Enhanced full-text search with facets, plus semantic/hybrid mode support.
  fastify.get('/search', async (request, reply) => {
    const params = SearchQuerySchema.parse(request.query);
    const { q, mode, spaceKey, author, dateFrom, dateTo, tags, sort, page, limit, includeFacets } = params;
    const userId = request.userId;

    const searchSpaces = await getUserAccessibleSpaces(userId);
    const ftsLang = await getFtsLanguage();

    // ── Embeddings availability check (only needed for semantic/hybrid) ──────
    let hasEmbeddings = true;
    let effectiveMode = mode;
    let warning: string | undefined;

    if (mode !== 'keyword') {
      const embResult = await query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1
           FROM page_embeddings pe
           JOIN pages cp ON pe.page_id = cp.id
           WHERE (
             (cp.source = 'confluence' AND cp.space_key = ANY($1::text[]))
             OR (cp.source = 'standalone' AND cp.visibility = 'shared')
             OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $2)
           )
           AND cp.deleted_at IS NULL
           LIMIT 1
         ) AS exists`,
        [searchSpaces, userId],
      );
      if (!embResult.rows[0]?.exists) {
        hasEmbeddings = false;
        effectiveMode = 'keyword';
        warning = 'No embeddings found — falling back to keyword search. Embed your pages to enable semantic search.';
      }
    }

    // ── Semantic mode ─────────────────────────────────────────────────────────
    if (effectiveMode === 'semantic') {
      const questionEmbedding = await generateSearchEmbedding(userId, q, 'semantic', reply);
      if (!questionEmbedding) return;

      const vectorResults = await vectorSearch(userId, questionEmbedding, limit);

      // Deduplicate by pageId (take best chunk per page)
      const seen = new Set<number>();
      const deduped = vectorResults.filter((r) => {
        if (seen.has(r.pageId)) return false;
        seen.add(r.pageId);
        return true;
      });

      const maxScore = deduped.length > 0 ? Math.max(...deduped.map((r) => r.score)) : null;
      recordSearchAnalytics(userId, q, deduped.length, maxScore, 'semantic').catch(() => {});

      const items = deduped.map((r) => ({
        id: r.pageId,
        confluenceId: r.confluenceId,
        title: r.pageTitle,
        spaceKey: r.spaceKey,
        author: null as string | null,
        lastModifiedAt: null as Date | null,
        labels: [] as string[],
        rank: r.score,
        snippet: r.chunkText.slice(0, 300),
        score: r.score,
      }));

      return {
        items,
        total: items.length,
        page: 1,
        limit,
        totalPages: 1,
        facets: { spaces: [], authors: [], tags: [] },
        mode: effectiveMode,
        hasEmbeddings,
        warning,
      };
    }

    // ── Hybrid mode ───────────────────────────────────────────────────────────
    // Delegates to rag-service's hybridSearch which handles embedding generation,
    // parallel vector + keyword search, RRF fusion, and deduplication internally.
    if (effectiveMode === 'hybrid') {
      let deduped;
      try {
        deduped = await hybridSearch(userId, q, limit);
      } catch (err) {
        logger.warn({ err }, 'Hybrid search failed (embedding generation error)');
        reply.status(502).send({
          error: 'EmbeddingFailed',
          message: `Embedding generation failed: ${err instanceof Error ? err.message : String(err)}`,
          statusCode: 502,
        });
        return;
      }

      const items = deduped.map((r) => ({
        id: r.pageId,
        confluenceId: r.confluenceId,
        title: r.pageTitle,
        spaceKey: r.spaceKey,
        author: null as string | null,
        lastModifiedAt: null as Date | null,
        labels: [] as string[],
        rank: r.score,
        snippet: r.chunkText.slice(0, 300),
        score: r.score,
      }));

      return {
        items,
        total: items.length,
        page: 1,
        limit,
        totalPages: 1,
        facets: { spaces: [], authors: [], tags: [] },
        mode: effectiveMode,
        hasEmbeddings,
        warning,
      };
    }

    // ── Keyword mode (default) ────────────────────────────────────────────────
    const offset = (page - 1) * limit;
    const conditions: string[] = [];
    // $1 = search query, $2 = accessible space keys, $3 = userId for standalone access
    const values: unknown[] = [q, searchSpaces, userId];
    let paramIndex = 4;

    // Base full-text search condition
    conditions.push(
      `cp.tsv @@ plainto_tsquery('${ftsLang}', $1)`,
    );

    // Access control: RBAC-based space access for confluence pages; standalone pages
    // require shared visibility or ownership by the current user
    conditions.push(
      `(
        (cp.source = 'confluence' AND cp.space_key = ANY($2::text[]))
        OR (cp.source = 'standalone' AND cp.visibility = 'shared')
        OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $3)
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

    // No JOIN needed — access control is handled via WHERE clause with RBAC space keys

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

    // Run FTS data query (with COUNT(*) OVER() to eliminate separate count query),
    // trigram query, and facet query in parallel since they are independent.
    const limitParamIndex = paramIndex;
    const offsetParamIndex = paramIndex + 1;

    const dataQueryPromise = query<{
      id: number;
      confluence_id: string;
      title: string;
      space_key: string;
      author: string | null;
      last_modified_at: Date | null;
      labels: string[];
      rank: number;
      snippet: string;
      total_count: string;
    }>(
      `SELECT cp.id, cp.confluence_id, cp.title, cp.space_key, cp.author,
              cp.last_modified_at, cp.labels,
              ts_rank(cp.tsv, plainto_tsquery('${ftsLang}', $1)) AS rank,
              ts_headline('${ftsLang}', COALESCE(cp.body_text, ''), plainto_tsquery('${ftsLang}', $1),
                          'MaxWords=30, MinWords=15, StartSel=<mark>, StopSel=</mark>') AS snippet,
              COUNT(*) OVER() AS total_count
       FROM pages cp
       WHERE ${whereClause}
       ORDER BY ${orderClause}
       LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
      [...values, limit, offset],
    );

    // Path B: Fuzzy title matching via pg_trgm (separate from FTS)
    // Merges additional title-match results that the FTS query may have missed.
    const trgmQueryPromise = query<{
      id: number;
      confluence_id: string;
      title: string;
      space_key: string;
      body_text: string;
      rank: number;
    }>(
      `SELECT cp.id, cp.confluence_id, cp.title, cp.space_key,
              substring(cp.body_text, 1, 300) AS body_text,
              similarity(cp.title, $1) AS rank
       FROM pages cp
       WHERE similarity(cp.title, $1) > $4
         AND cp.title IS NOT NULL
         AND (
           (cp.source = 'confluence' AND cp.space_key = ANY($2::text[]))
           OR (cp.source = 'standalone' AND cp.visibility = 'shared')
           OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $3)
         )
         AND cp.deleted_at IS NULL
       ORDER BY rank DESC
       LIMIT $5`,
      [q, searchSpaces, userId, TRGM_SIMILARITY_THRESHOLD, limit],
    );

    // Facet aggregation — opt-in via includeFacets (default: true).
    // Skipping facets avoids 3 UNION ALL subqueries when the caller doesn't need them.
    const facetQueryPromise = includeFacets
      ? query<{ facet: string; value: string; count: string }>(
          `SELECT 'space' AS facet, cp.space_key AS value, COUNT(*)::TEXT AS count
           FROM pages cp
           WHERE cp.tsv @@ plainto_tsquery('${ftsLang}', $1)
             AND (
               (cp.source = 'confluence' AND cp.space_key = ANY($2::text[]))
               OR (cp.source = 'standalone' AND cp.visibility = 'shared')
               OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $3)
             )
             AND cp.deleted_at IS NULL
             AND cp.space_key IS NOT NULL
           GROUP BY cp.space_key
           UNION ALL
           SELECT 'author' AS facet, cp.author AS value, COUNT(*)::TEXT AS count
           FROM pages cp
           WHERE cp.tsv @@ plainto_tsquery('${ftsLang}', $1)
             AND (
               (cp.source = 'confluence' AND cp.space_key = ANY($2::text[]))
               OR (cp.source = 'standalone' AND cp.visibility = 'shared')
               OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $3)
             )
             AND cp.deleted_at IS NULL
             AND cp.author IS NOT NULL
           GROUP BY cp.author
           UNION ALL
           SELECT 'tag' AS facet, tag AS value, COUNT(*)::TEXT AS count
           FROM pages cp
           CROSS JOIN unnest(cp.labels) AS tag
           WHERE cp.tsv @@ plainto_tsquery('${ftsLang}', $1)
             AND (
               (cp.source = 'confluence' AND cp.space_key = ANY($2::text[]))
               OR (cp.source = 'standalone' AND cp.visibility = 'shared')
               OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $3)
             )
             AND cp.deleted_at IS NULL
           GROUP BY tag`,
          [q, searchSpaces, userId],
        )
      : Promise.resolve({ rows: [] as Array<{ facet: string; value: string; count: string }> });

    // Execute all three queries in parallel
    const [dataResult, trgmResult, facetResult] = await Promise.all([
      dataQueryPromise,
      trgmQueryPromise,
      facetQueryPromise,
    ]);

    // Extract total from window function (available on every row, take from first)
    const total = dataResult.rows.length > 0 ? parseInt(dataResult.rows[0]!.total_count, 10) : 0;

    // Merge: start with FTS results (higher weight), add trgm-only hits
    const ftsItems = dataResult.rows.map((row) => ({
      id: row.id,
      confluenceId: row.confluence_id,
      title: row.title,
      spaceKey: row.space_key,
      author: row.author,
      lastModifiedAt: row.last_modified_at,
      labels: row.labels,
      rank: row.rank,
      snippet: row.snippet,
    }));

    const ftsIds = new Set(ftsItems.map((r) => r.id));
    for (const trgmRow of trgmResult.rows) {
      if (!ftsIds.has(trgmRow.id)) {
        ftsItems.push({
          id: trgmRow.id,
          confluenceId: trgmRow.confluence_id,
          title: trgmRow.title,
          spaceKey: trgmRow.space_key,
          author: null,
          lastModifiedAt: null,
          labels: [],
          rank: trgmRow.rank,
          snippet: trgmRow.body_text,
        });
      }
    }

    // After merging trgm results, the actual item count may exceed the FTS-only
    // total. Adjust so that `total` is never less than the items returned.
    const adjustedTotal = Math.max(total, ftsItems.length);
    const totalPages = Math.ceil(adjustedTotal / limit);

    const maxFtsScore = ftsItems.length > 0 ? Math.max(...ftsItems.map((r) => r.rank)) : null;
    recordSearchAnalytics(userId, q, ftsItems.length, maxFtsScore, 'keyword').catch(() => {});

    // Parse facets from result
    const facets: Record<string, Array<{ value: string; count: number }>> = {
      spaces: [],
      authors: [],
      tags: [],
    };

    for (const row of facetResult.rows) {
      const entry = { value: row.value, count: parseInt(row.count, 10) };
      switch (row.facet) {
        case 'space':
          facets.spaces!.push(entry);
          break;
        case 'author':
          facets.authors!.push(entry);
          break;
        case 'tag':
          facets.tags!.push(entry);
          break;
      }
    }

    return {
      items: ftsItems,
      total: adjustedTotal,
      page,
      limit,
      totalPages,
      facets,
      mode: effectiveMode,
      hasEmbeddings,
      warning,
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

    // Escape LIKE metacharacters (%, _, \) to prevent pattern injection
    const escapedQ = q.replace(/[%_\\]/g, '\\$&');

    const result = await query<{
      query_text: string;
      frequency: string;
    }>(
      `SELECT LOWER(TRIM(query)) AS query_text, COUNT(*) AS frequency
       FROM search_analytics
       WHERE LOWER(TRIM(query)) LIKE LOWER($1) || '%' ESCAPE '\\'
       GROUP BY LOWER(TRIM(query))
       ORDER BY COUNT(*) DESC
       LIMIT 10`,
      [escapedQ],
    );

    return {
      suggestions: result.rows.map((row) => ({
        query: row.query_text,
        frequency: parseInt(row.frequency, 10),
      })),
    };
  });
}
