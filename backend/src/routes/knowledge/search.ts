import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SearchHybridQuerySchema } from '@compendiq/contracts';
import { query } from '../../core/db/postgres.js';
// Use the request-scoped memoised wrapper so the search route and downstream
// rag-service calls resolve the readable-space set once per request. See
// ADR-022.
import { getUserAccessibleSpacesMemoized as getUserAccessibleSpaces } from '../../core/services/rbac-service.js';
import { getFtsLanguage } from '../../core/services/fts-language.js';
import { chooseLexicalParser } from '../../core/utils/lexical-query.js';
import { visiblePagesPredicate } from '../../core/services/page-visibility.js';
import {
  vectorSearch,
  hybridSearch,
  recordSearchAnalytics,
  getEmbeddingCoverage,
  deriveDegradedReason,
  resolveStageLimit,
  type DegradedReason,
  type EmbeddingCoverage,
} from '../../domains/llm/services/rag-service.js';
import { getRagFetchWidth } from '../../core/services/admin-settings-service.js';
import { markdownToSnippetText } from '../../core/services/content-converter.js';
import { resolveUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import { generateEmbedding } from '../../domains/llm/services/openai-compatible-client.js';
import { formatQueryForEmbedding } from '../../domains/llm/services/query-instruction.js';
import { CircuitBreakerOpenError } from '../../core/services/circuit-breaker.js';
import { toUserFacingEmbeddingError } from '../../domains/llm/services/embedding-error-message.js';

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
 * Generate a query embedding for `mode=semantic`.
 *
 * Only that mode: `mode=hybrid` delegates to `hybridSearch`, which resolves the
 * provider and embeds the question itself. That split is why the #1114
 * instruction prefix has to be applied in both places — see the call below.
 *
 * Errors are handled separately by where they originate, because they carry
 * very different disclosure risk:
 *
 * - `resolveUsecase` is a DB lookup and can also throw app-authored text
 *   naming an internal provider UUID or the existence of an EE org policy
 *   (see llm-provider-resolver.ts). Its failures are always rethrown so
 *   app.ts's global handler answers a sanitized 500 — never shown to the
 *   caller.
 * - `generateEmbedding` actually calls the embedding provider. A
 *   `CircuitBreakerOpenError` there becomes a 503 with retry-shortly
 *   semantics (mirrors llm-ask.ts's hybridSearch handling). Any other
 *   failure is a genuine embedding-provider error, categorized through
 *   `toUserFacingEmbeddingError` into a fixed, non-sensitive message —
 *   never the raw `err.message`.
 * - A provider can also "succeed" with an empty (or missing) embeddings
 *   array. That is not an exception, so it does not hit the catch above,
 *   but returning `null` for it is indistinguishable from this function's
 *   own "already replied" sentinel — the caller would return having sent
 *   nothing, a 200 with an empty body. Treated as a failed embedding: a 502
 *   with a fixed constant message (there is no error object here, so
 *   nothing is interpolated and `toUserFacingEmbeddingError` does not apply).
 */
async function generateSearchEmbedding(
  request: FastifyRequest,
  q: string,
  modeName: string,
  reply: FastifyReply,
): Promise<number[] | null> {
  let resolved: Awaited<ReturnType<typeof resolveUsecase>>;
  try {
    resolved = await resolveUsecase('embedding');
  } catch (err) {
    request.log.error({ err }, `Failed to resolve embedding provider for ${modeName} search`);
    throw err;
  }

  try {
    // #1114: instruction-aware models (Qwen3) want a preamble on the QUERY and
    // nothing on the document. This route is the app's SECOND query-side
    // embedding call — `rag-service.ts`'s vector leg is the other, and it is
    // the one `mode=hybrid` reaches. `mode=semantic` embeds here instead, so it
    // needs the asymmetry applied independently or a user picking Semantic on
    // the Pages search bar silently gets the un-prefixed, lower-recall query.
    //
    // Keyed off the RESOLVED model exactly as the vector leg is, so it turns on
    // at a swap and off at a rollback with no separate setting; a no-op for
    // every model that is not instruction-aware, which is why it runs
    // unconditionally rather than behind a second flag that could drift.
    // `query-instruction.test.ts` enumerates both query sites and every
    // document site, and asserts on the CALL's arguments rather than on the
    // file, so neither half can be added or dropped unnoticed — and dropping
    // the wrapper here while leaving the import behind is red, not green.
    const embeddings = await generateEmbedding(
      resolved.config, resolved.model, formatQueryForEmbedding(resolved.model, q),
    );
    const embedding = embeddings[0];
    // `!embedding` alone would miss a zero-length inner vector ([[]]) — an
    // empty array is truthy in JS — so check length explicitly too.
    if (!embedding || embedding.length === 0) {
      request.log.error({ modeName }, `Embedding provider returned no result for ${modeName} search`);
      reply.status(502).send({
        error: 'EmbeddingFailed',
        message: 'Embedding generation returned no result.',
        statusCode: 502,
      });
      return null;
    }
    return embedding;
  } catch (err) {
    if (err instanceof CircuitBreakerOpenError) {
      reply.status(503).send({
        error: 'LLM service temporarily unavailable',
        message: 'The AI service circuit breaker is open. Please try again later.',
        statusCode: 503,
      });
      return null;
    }
    request.log.error({ err }, `Embedding generation failed for ${modeName} search`);
    reply.status(502).send({
      error: 'EmbeddingFailed',
      message: toUserFacingEmbeddingError(err),
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
    // Coverage-aware since #1117 stage 2: the old boolean EXISTS probe flipped
    // healthy the moment ONE visible page had an embedding row, so a re-embed
    // in progress (or a 1%-embedded corpus) looked identical to full coverage.
    // `embeddingCoverage`/`degradedReason` stay null in keyword mode — the
    // signal is unmeasured there, not healthy. This one probe reading is also
    // handed to hybridSearch below so a hybrid request never counts twice.
    //
    // The wire fields describe CORPUS state measured before retrieval ran. A
    // provider failing mid-request degrades that request only — hybridSearch
    // records it on the analytics row and its span; the response's
    // `degradedReason` deliberately does not flip for it.
    let hasEmbeddings = true;
    let effectiveMode = mode;
    let warning: string | undefined;
    let embeddingCoverage: number | null = null;
    let degradedReason: DegradedReason | null = null;
    let cov: EmbeddingCoverage | null = null;

    if (mode !== 'keyword') {
      // Best-effort, matching hybridSearch's own probe handling: a probe
      // failure degrades the *signal* to "unmeasured" (null), never the
      // search — the requested mode keeps running optimistically.
      cov = await getEmbeddingCoverage(userId).catch((err) => {
        request.log.warn({ err }, 'Embedding-coverage probe failed');
        return null;
      });
      if (cov) {
        embeddingCoverage = cov.coverage;
        degradedReason = deriveDegradedReason(false, cov);
        if (cov.embeddedPages === 0) {
          hasEmbeddings = false;
          effectiveMode = 'keyword';
          warning = 'No embeddings found — falling back to keyword search. Embed your pages to enable semantic search.';
        } else if (degradedReason === 'partial_embeddings') {
          // Keep the mode running — half a vector index still beats none — but
          // say so. The frontend banner keys on `degradedReason`, not this text.
          // Floor with an epsilon (0.29*100 is 28.999… in binary floating
          // point) and never claim 0% — that is the sibling no-embeddings
          // state's copy. Mirrors the PagesPage banner exactly.
          const pct = Math.floor(cov.coverage * 100 + 1e-9);
          warning = `Semantic search is degraded — ${pct === 0 ? 'less than 1%' : `${pct}%`} of pages are embedded. Results may be incomplete until embedding completes.`;
        }
      }
    }

    // ── Semantic mode ─────────────────────────────────────────────────────────
    if (effectiveMode === 'semantic') {
      const questionEmbedding = await generateSearchEmbedding(request, q, 'semantic', reply);
      if (!questionEmbedding) return;

      // Fetch width decoupled from return width here too (#1103). Since
      // #1106 the vector leg is page-denominated — `limit` counts distinct
      // pages and vectorSearch over-fetches raw chunk rows internally, so
      // the chunks-vs-pages under-delivery this comment used to describe is
      // resolved at the source. Widening is order-preserving in this mode —
      // cosine ordering is a stable prefix, so a deeper fetch can only
      // append pages after the ones a narrower fetch found, never reorder
      // them. (Exact while ef_search is constant: ef now covers the RAW
      // fetch, 8x the stage limit, so the constant range is stage limits
      // <= RAG_EF_SEARCH/8 = 12 — still true at the default width 10, but
      // narrower than the pre-#1106 <= 50. Beyond it, a raised ef explores
      // more of the HNSW graph and can genuinely surface a nearer neighbour
      // above previous results — an accuracy improvement, not the RRF
      // dilution the hybrid path guards against.)
      const stageLimit = resolveStageLimit(limit, await getRagFetchWidth(), false);
      // #1351: the Space filter now actually narrows semantic results — see
      // the matching note on vectorSearch. Previously this call ignored
      // `spaceKey` entirely, so a user scoping semantic search to one space
      // silently got answers from the whole accessible corpus.
      const vectorResults = await vectorSearch(userId, questionEmbedding, stageLimit, { spaceKey });

      // Deduplicate by pageId (take best chunk per page), then honour the
      // caller's return width — the wider fetch is ranking headroom, not a
      // bigger response.
      const seen = new Set<number>();
      const deduped = vectorResults
        .filter((r) => {
          if (seen.has(r.pageId)) return false;
          seen.add(r.pageId);
          return true;
        })
        .slice(0, limit);

      const maxScore = deduped.length > 0 ? Math.max(...deduped.map((r) => r.score)) : null;
      recordSearchAnalytics(userId, q, deduped.length, maxScore, 'semantic', {
        degradedReason,
        embeddingCoverage,
      }).catch(() => {});

      const items = deduped.map((r) => ({
        id: r.pageId,
        confluenceId: r.confluenceId,
        title: r.pageTitle,
        spaceKey: r.spaceKey,
        author: null as string | null,
        lastModifiedAt: null as Date | null,
        labels: [] as string[],
        // `rank` is the ordering quantity in whatever unit this mode produced
        // (cosine for semantic, RRF fusion for hybrid). `similarity` is the
        // cosine — the only field with one meaning across modes, and the only
        // one safe to render — or null when no vector leg contributed. Its
        // range is [-1,1], not [0,1]; see `SearchResult.vectorScore` in
        // rag-service.ts (#1117).
        rank: r.score,
        // chunk_text is Markdown-shaped since #1265; flatten for display so
        // vector snippets match the keyword rows' plain-text shape.
        snippet: markdownToSnippetText(r.chunkText).slice(0, 300),
        score: r.score,
        similarity: r.vectorScore,
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
        embeddingCoverage,
        degradedReason,
      };
    }

    // ── Hybrid mode ───────────────────────────────────────────────────────────
    // Delegates to rag-service's hybridSearch which handles embedding generation,
    // parallel vector + keyword search, RRF fusion, and deduplication internally.
    if (effectiveMode === 'hybrid') {
      let deduped;
      try {
        // Hand over this request's coverage reading (null = probe failed) so
        // hybridSearch skips its own probe — one COUNT per request, and the
        // wire and analytics describe the same measurement.
        // #1351: spaceKey narrows both legs — see HybridSearchOptions.spaceKey.
        deduped = await hybridSearch(userId, q, limit, cov, { spaceKey });
      } catch (err) {
        if (err instanceof CircuitBreakerOpenError) {
          reply.status(503).send({
            error: 'LLM service temporarily unavailable',
            message: 'The AI service circuit breaker is open. Please try again later.',
            statusCode: 503,
          });
          return;
        }
        // hybridSearch (rag-service.ts) swallows its own embedding failures
        // internally and rethrows only CircuitBreakerOpenError, so anything
        // reaching here is predominantly a DATABASE error (keywordSearch,
        // the ACL post-filter, etc. — see the #1223 AI review call-graph
        // analysis). Never format err.message into the client-visible body:
        // log it server-side and let app.ts's global handler answer a
        // sanitized 500.
        request.log.error({ err }, 'Hybrid search failed');
        throw err;
      }

      const items = deduped.map((r) => ({
        id: r.pageId,
        confluenceId: r.confluenceId,
        title: r.pageTitle,
        spaceKey: r.spaceKey,
        author: null as string | null,
        lastModifiedAt: null as Date | null,
        labels: [] as string[],
        // Same three-field contract as the semantic branch above: `rank` orders,
        // `similarity` is the renderable cosine or null (#1117).
        rank: r.score,
        // chunk_text is Markdown-shaped since #1265; flatten for display so
        // vector snippets match the keyword rows' plain-text shape.
        snippet: markdownToSnippetText(r.chunkText).slice(0, 300),
        score: r.score,
        similarity: r.vectorScore,
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
        embeddingCoverage,
        degradedReason,
      };
    }

    // ── Keyword mode (default) ────────────────────────────────────────────────
    const offset = (page - 1) * limit;
    const conditions: string[] = [];
    // $1 = search query, $2 = accessible space keys, $3 = userId for standalone access
    // $1 carries the RAW q for every path — the tsquery match, ts_rank,
    // ts_headline and the pg_trgm title query alike. #1110 does not rewrite
    // the query; it chooses which parser reads it, so there is no
    // sanitised-vs-raw asymmetry left to keep in step.
    const parser = chooseLexicalParser(q);
    const values: unknown[] = [q, searchSpaces, userId];
    let paramIndex = 4;

    // Base full-text search condition
    conditions.push(
      `cp.tsv @@ ${parser}('${ftsLang}', $1)`,
    );

    // Access control: RBAC-based space access for confluence pages; standalone pages
    // require shared visibility or ownership by the current user
    conditions.push(visiblePagesPredicate(2, 3));

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
              ts_rank(cp.tsv, ${parser}('${ftsLang}', $1)) AS rank,
              ts_headline('${ftsLang}', COALESCE(cp.body_text, ''), ${parser}('${ftsLang}', $1),
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
       -- cp.title % $1 is the sargable pg_trgm operator: it lets the planner use
       -- the GIN index idx_pages_title_trgm (Bitmap Index Scan) instead of a Seq
       -- Scan. The % operator uses pg_trgm's default 0.3 threshold, which matches
       -- TRGM_SIMILARITY_THRESHOLD, so the retained similarity() > $4 keeps the
       -- threshold check exact without changing which rows match.
       WHERE cp.title % $1
         AND similarity(cp.title, $1) > $4
         AND cp.title IS NOT NULL
         AND ${visiblePagesPredicate(2, 3)}
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
           WHERE cp.tsv @@ ${parser}('${ftsLang}', $1)
             AND ${visiblePagesPredicate(2, 3)}
             AND cp.deleted_at IS NULL
             AND cp.space_key IS NOT NULL
           GROUP BY cp.space_key
           UNION ALL
           SELECT 'author' AS facet, cp.author AS value, COUNT(*)::TEXT AS count
           FROM pages cp
           WHERE cp.tsv @@ ${parser}('${ftsLang}', $1)
             AND ${visiblePagesPredicate(2, 3)}
             AND cp.deleted_at IS NULL
             AND cp.author IS NOT NULL
           GROUP BY cp.author
           UNION ALL
           SELECT 'tag' AS facet, tag AS value, COUNT(*)::TEXT AS count
           FROM pages cp
           CROSS JOIN unnest(cp.labels) AS tag
           WHERE cp.tsv @@ ${parser}('${ftsLang}', $1)
             AND ${visiblePagesPredicate(2, 3)}
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
    // A semantic/hybrid request downgraded here for zero coverage is the WORST
    // degradation state — during a re-embed window every hybrid search lands
    // on this line. Carry the measured signal onto the row (both fields are
    // null for a genuine keyword-mode request, whose probe never ran) or the
    // outage records as healthy user-chosen keyword searches.
    recordSearchAnalytics(userId, q, ftsItems.length, maxFtsScore, 'keyword', {
      degradedReason,
      embeddingCoverage,
    }).catch(() => {});

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
      embeddingCoverage,
      degradedReason,
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
       WHERE user_id = $2
         AND LOWER(TRIM(query)) LIKE LOWER($1) || '%' ESCAPE '\\'
       GROUP BY LOWER(TRIM(query))
       ORDER BY COUNT(*) DESC
       LIMIT 10`,
      [escapedQ, request.userId],
    );

    return {
      suggestions: result.rows.map((row) => ({
        query: row.query_text,
        frequency: parseInt(row.frequency, 10),
      })),
    };
  });
}
