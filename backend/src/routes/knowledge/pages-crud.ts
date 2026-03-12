import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import { htmlToConfluence, confluenceToHtml } from '../../core/services/content-converter.js';
import { cleanPageAttachments } from '../../domains/confluence/services/attachment-handler.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { processDirtyPages, isProcessingUser } from '../../domains/llm/services/embedding-service.js';
import { PageListQuerySchema, PageTreeQuerySchema, CreatePageSchema, UpdatePageSchema } from '@kb-creator/contracts';
import { z } from 'zod';
import { logger } from '../../core/utils/logger.js';
import pLimit from 'p-limit';

const BulkIdsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(100) });
const BulkTagSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
  addTags: z.array(z.string()).default([]),
  removeTags: z.array(z.string()).default([]),
});
const IdParamSchema = z.object({ id: z.string().min(1) });

export async function pagesCrudRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  const cache = new RedisCache(fastify.redis);

  // GET /api/pages - list/search pages
  fastify.get('/pages', async (request) => {
    const userId = request.userId;
    const params = PageListQuerySchema.parse(request.query);
    const { spaceKey, search, author, labels, freshness, embeddingStatus, qualityMin, qualityMax, qualityStatus, dateFrom, dateTo, page = 1, limit = 50, sort = 'title' } = params;

    // Cache all page list queries. Filtered queries use a shorter TTL (2 min) vs
    // unfiltered (15 min) since filter results change more frequently (e.g. search
    // results after edits, embedding status during processing).
    const hasFilters = !!(search || author || labels || freshness || embeddingStatus || qualityMin !== undefined || qualityMax !== undefined || qualityStatus || dateFrom || dateTo);
    const filterParts = [spaceKey ?? '', search ?? '', author ?? '', labels ?? '', freshness ?? '', embeddingStatus ?? '', qualityMin ?? '', qualityMax ?? '', qualityStatus ?? '', dateFrom ?? '', dateTo ?? '', page, limit, sort].join(':');
    const cacheKey = `list:${filterParts}`;
    const cacheTtl = hasFilters ? 120 : 900; // 2 min for filtered, 15 min for unfiltered

    const cached = await cache.get(userId, 'pages', cacheKey);
    if (cached) return cached;

    // Build WHERE clause separately for reuse in count query
    // Access control: JOIN user_space_selections so each user only sees pages from
    // their selected spaces (shared tables access pattern).
    let whereClause = 'JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1';
    const values: unknown[] = [userId];
    let paramIdx = 2;

    if (spaceKey) {
      whereClause += ` AND cp.space_key = $${paramIdx++}`;
      values.push(spaceKey);
    }

    if (search && search.trim()) {
      // Full-text search using plainto_tsquery for safe handling of arbitrary user input
      whereClause += ` AND to_tsvector('english', coalesce(cp.title, '') || ' ' || coalesce(cp.body_text, '')) @@ plainto_tsquery('english', $${paramIdx++})`;
      values.push(search.trim());
    }

    if (author) {
      whereClause += ` AND cp.author = $${paramIdx++}`;
      values.push(author);
    }

    if (labels) {
      // labels is a comma-separated string; filter pages that contain ALL specified labels
      const labelList = labels.split(',').map((l) => l.trim()).filter(Boolean);
      if (labelList.length > 0) {
        whereClause += ` AND cp.labels @> $${paramIdx++}`;
        values.push(labelList);
      }
    }

    if (freshness) {
      // Map freshness levels to day ranges based on FreshnessBadge logic
      const freshnessMap: Record<string, [string, string | null]> = {
        fresh:  [`NOW() - INTERVAL '7 days'`, null],
        recent: [`NOW() - INTERVAL '30 days'`, `NOW() - INTERVAL '7 days'`],
        aging:  [`NOW() - INTERVAL '90 days'`, `NOW() - INTERVAL '30 days'`],
        stale:  [null as unknown as string, `NOW() - INTERVAL '90 days'`],
      };
      const [after, before] = freshnessMap[freshness];
      if (after) {
        whereClause += ` AND cp.last_modified_at >= ${after}`;
      }
      if (before) {
        whereClause += ` AND cp.last_modified_at < ${before}`;
      }
    }

    if (embeddingStatus) {
      whereClause += ` AND cp.embedding_dirty = $${paramIdx++}`;
      values.push(embeddingStatus === 'pending');
    }

    if (qualityMin !== undefined) {
      whereClause += ` AND cp.quality_score >= $${paramIdx++}`;
      values.push(qualityMin);
    }

    if (qualityMax !== undefined) {
      whereClause += ` AND cp.quality_score <= $${paramIdx++}`;
      values.push(qualityMax);
    }

    if (qualityStatus) {
      whereClause += ` AND cp.quality_status = $${paramIdx++}`;
      values.push(qualityStatus);
    }

    if (dateFrom) {
      whereClause += ` AND cp.last_modified_at >= $${paramIdx++}`;
      values.push(dateFrom);
    }

    if (dateTo) {
      whereClause += ` AND cp.last_modified_at <= $${paramIdx++}`;
      values.push(dateTo);
    }

    // Sort
    const sortMap: Record<string, string> = {
      title: 'cp.title ASC',
      modified: 'cp.last_modified_at DESC NULLS LAST',
      author: 'cp.author ASC NULLS LAST',
      quality: 'cp.quality_score DESC NULLS LAST',
    };
    const orderBy = sortMap[sort] ?? sortMap.title;

    // Count total (uses same WHERE clause, no fragile regex replacement)
    // When whereClause is a JOIN, it already scopes the count
    const countSql = `SELECT COUNT(*) as count FROM cached_pages cp ${whereClause}`;
    const countResult = await query<{ count: string }>(countSql, values);
    const total = parseInt(countResult.rows[0].count, 10);

    // Build full SELECT with pagination
    const offset = (page - 1) * limit;
    const sql = `
      SELECT cp.confluence_id, cp.space_key, cp.title, cp.version,
             cp.parent_id, cp.labels, cp.author, cp.last_modified_at, cp.last_synced,
             cp.embedding_dirty, cp.embedding_status, cp.embedded_at, cp.embedding_error,
             cp.quality_score, cp.quality_status, cp.quality_completeness, cp.quality_clarity,
             cp.quality_structure, cp.quality_accuracy, cp.quality_readability,
             cp.quality_summary, cp.quality_analyzed_at, cp.quality_error,
             cp.summary_status
      FROM cached_pages cp
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT $${paramIdx++} OFFSET $${paramIdx}
    `;
    values.push(limit, offset);

    const result = await query<{
      confluence_id: string;
      space_key: string;
      title: string;
      version: number;
      parent_id: string | null;
      labels: string[];
      author: string | null;
      last_modified_at: Date | null;
      last_synced: Date;
      embedding_dirty: boolean;
      embedding_status: string;
      embedded_at: Date | null;
      embedding_error: string | null;
      quality_score: number | null;
      quality_status: string | null;
      quality_completeness: number | null;
      quality_clarity: number | null;
      quality_structure: number | null;
      quality_accuracy: number | null;
      quality_readability: number | null;
      quality_summary: string | null;
      quality_analyzed_at: Date | null;
      quality_error: string | null;
      summary_status: string;
    }>(sql, values);

    const response = {
      items: result.rows.map((row) => ({
        id: row.confluence_id,
        spaceKey: row.space_key,
        title: row.title,
        version: row.version,
        parentId: row.parent_id,
        labels: row.labels,
        author: row.author,
        lastModifiedAt: row.last_modified_at,
        lastSynced: row.last_synced,
        embeddingDirty: row.embedding_dirty,
        embeddingStatus: row.embedding_status,
        embeddedAt: row.embedded_at,
        embeddingError: row.embedding_error,
        qualityScore: row.quality_score,
        qualityStatus: row.quality_status,
        qualityCompleteness: row.quality_completeness,
        qualityClarity: row.quality_clarity,
        qualityStructure: row.quality_structure,
        qualityAccuracy: row.quality_accuracy,
        qualityReadability: row.quality_readability,
        qualitySummary: row.quality_summary,
        qualityAnalyzedAt: row.quality_analyzed_at,
        qualityError: row.quality_error,
        summaryStatus: row.summary_status,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };

    await cache.set(userId, 'pages', cacheKey, response, cacheTtl);

    return response;
  });

  // GET /api/pages/tree - all pages with minimal fields for hierarchy view
  fastify.get('/pages/tree', async (request) => {
    const userId = request.userId;
    const params = PageTreeQuerySchema.parse(request.query);

    const cacheKey = `tree:${params.spaceKey ?? 'all'}`;
    const cached = await cache.get(userId, 'pages', cacheKey);
    if (cached) return cached;

    // Access control via space selection join
    const joinClause = 'JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1';
    const values: unknown[] = [userId];
    let treeWhereClause = '';

    if (params.spaceKey) {
      treeWhereClause = 'WHERE cp.space_key = $2';
      values.push(params.spaceKey);
    }

    const result = await query<{
      confluence_id: string;
      space_key: string;
      title: string;
      parent_id: string | null;
      labels: string[];
      last_modified_at: Date | null;
      embedding_dirty: boolean;
      embedding_status: string;
      embedded_at: Date | null;
      embedding_error: string | null;
    }>(
      `SELECT cp.confluence_id, cp.space_key, cp.title, cp.parent_id, cp.labels, cp.last_modified_at,
              cp.embedding_dirty, cp.embedding_status, cp.embedded_at, cp.embedding_error
       FROM cached_pages cp ${joinClause} ${treeWhereClause}
       ORDER BY cp.title ASC`,
      values,
    );

    const response = {
      items: result.rows.map((row) => ({
        id: row.confluence_id,
        spaceKey: row.space_key,
        title: row.title,
        parentId: row.parent_id,
        labels: row.labels,
        lastModifiedAt: row.last_modified_at,
        embeddingDirty: row.embedding_dirty,
        embeddingStatus: row.embedding_status,
        embeddedAt: row.embedded_at,
        embeddingError: row.embedding_error,
      })),
      total: result.rows.length,
    };

    await cache.set(userId, 'pages', cacheKey, response);
    return response;
  });

  // GET /api/pages/filters - get available filter options (distinct authors, labels)
  fastify.get('/pages/filters', async (request) => {
    const userId = request.userId;

    const [authorsResult, labelsResult] = await Promise.all([
      query<{ author: string }>(
        `SELECT DISTINCT cp.author FROM cached_pages cp
         JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
         WHERE cp.author IS NOT NULL ORDER BY cp.author ASC`,
        [userId],
      ),
      query<{ label: string }>(
        `SELECT DISTINCT unnest(cp.labels) AS label FROM cached_pages cp
         JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
         ORDER BY label ASC`,
        [userId],
      ),
    ]);

    return {
      authors: authorsResult.rows.map((r) => r.author),
      labels: labelsResult.rows.map((r) => r.label),
    };
  });

  // GET /api/pages/:id - get page with content
  fastify.get('/pages/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    const result = await query<{
      confluence_id: string;
      space_key: string;
      title: string;
      body_storage: string;
      body_html: string;
      body_text: string;
      version: number;
      parent_id: string | null;
      labels: string[];
      author: string | null;
      last_modified_at: Date | null;
      last_synced: Date;
      embedding_dirty: boolean;
      embedding_status: string;
      embedded_at: Date | null;
      embedding_error: string | null;
      has_children: boolean;
      quality_score: number | null;
      quality_status: string | null;
      quality_completeness: number | null;
      quality_clarity: number | null;
      quality_structure: number | null;
      quality_accuracy: number | null;
      quality_readability: number | null;
      quality_summary: string | null;
      quality_analyzed_at: Date | null;
      quality_error: string | null;
      summary_html: string | null;
      summary_status: string;
      summary_generated_at: Date | null;
      summary_model: string | null;
      summary_error: string | null;
    }>(
      `SELECT cp.confluence_id, cp.space_key, cp.title, cp.body_storage, cp.body_html, cp.body_text,
              cp.version, cp.parent_id, cp.labels, cp.author, cp.last_modified_at, cp.last_synced,
              cp.embedding_dirty, cp.embedding_status, cp.embedded_at, cp.embedding_error,
              cp.quality_score, cp.quality_status, cp.quality_completeness, cp.quality_clarity,
              cp.quality_structure, cp.quality_accuracy, cp.quality_readability,
              cp.quality_summary, cp.quality_analyzed_at, cp.quality_error,
              EXISTS(SELECT 1 FROM cached_pages c2 WHERE c2.parent_id = cp.confluence_id) as has_children,
              cp.summary_html, cp.summary_status, cp.summary_generated_at, cp.summary_model, cp.summary_error
       FROM cached_pages cp
       JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
       WHERE cp.confluence_id = $2`,
      [userId, id],
    );

    if (result.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const row = result.rows[0];

    return {
      id: row.confluence_id,
      spaceKey: row.space_key,
      title: row.title,
      bodyHtml: row.body_html,
      bodyText: row.body_text,
      version: row.version,
      parentId: row.parent_id,
      labels: row.labels,
      author: row.author,
      lastModifiedAt: row.last_modified_at,
      lastSynced: row.last_synced,
      hasChildren: row.has_children,
      embeddingDirty: row.embedding_dirty,
      embeddingStatus: row.embedding_status,
      embeddedAt: row.embedded_at,
      embeddingError: row.embedding_error,
      qualityScore: row.quality_score,
      qualityStatus: row.quality_status,
      qualityCompleteness: row.quality_completeness,
      qualityClarity: row.quality_clarity,
      qualityStructure: row.quality_structure,
      qualityAccuracy: row.quality_accuracy,
      qualityReadability: row.quality_readability,
      qualitySummary: row.quality_summary,
      qualityAnalyzedAt: row.quality_analyzed_at,
      qualityError: row.quality_error,
      summaryHtml: row.summary_html,
      summaryStatus: row.summary_status,
      summaryGeneratedAt: row.summary_generated_at,
      summaryModel: row.summary_model,
      summaryError: row.summary_error,
    };
  });

  /**
   * @deprecated Use the `hasChildren` field from GET /api/pages/:id instead.
   * This dedicated endpoint is kept for backwards compatibility and will be
   * removed in a future release.
   */
  // GET /api/pages/:id/has-children - check if a page has sub-pages
  fastify.get('/pages/:id/has-children', async (request) => {
    const { id } = IdParamSchema.parse(request.params);

    const result = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM cached_pages WHERE parent_id = $1',
      [id],
    );

    return { hasChildren: parseInt(result.rows[0].count, 10) > 0 };
  });

  // POST /api/pages - create page in Confluence + local cache
  fastify.post('/pages', async (request) => {
    const body = CreatePageSchema.parse(request.body);
    const userId = request.userId;

    const client = await getClientForUser(userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }

    // Convert TipTap HTML to Confluence storage format
    const storageBody = htmlToConfluence(body.bodyHtml);

    const page = await client.createPage(body.spaceKey, body.title, storageBody, body.parentId);

    // Convert back to clean HTML for local cache
    const bodyHtml = confluenceToHtml(page.body?.storage?.value ?? storageBody, page.id, body.spaceKey);
    const { htmlToText } = await import('../../core/services/content-converter.js');
    const bodyText = htmlToText(bodyHtml);

    // Store in local cache (shared table, no user_id)
    await query(
      `INSERT INTO cached_pages
         (confluence_id, space_key, title, body_storage, body_html, body_text,
          version, parent_id, embedding_dirty, embedding_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, 'not_embedded')
       ON CONFLICT (confluence_id) DO UPDATE SET
         title = EXCLUDED.title, body_storage = EXCLUDED.body_storage, body_html = EXCLUDED.body_html,
         body_text = EXCLUDED.body_text, version = EXCLUDED.version, last_synced = NOW()`,
      [page.id, body.spaceKey, body.title, page.body?.storage?.value ?? storageBody,
       bodyHtml, bodyText, page.version.number, body.parentId ?? null],
    );

    // Invalidate cache
    await cache.invalidate(userId, 'pages');
    await cache.invalidate(userId, 'spaces');

    await logAuditEvent(userId, 'PAGE_CREATED', 'page', page.id, { spaceKey: body.spaceKey, title: body.title }, request);

    return { id: page.id, title: page.title, version: page.version.number };
  });

  // PUT /api/pages/:id - update page in Confluence + local cache
  fastify.put('/pages/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const body = UpdatePageSchema.parse(request.body);
    const userId = request.userId;

    const client = await getClientForUser(userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }

    // Version conflict check
    const existing = await query<{ version: number; space_key: string }>(
      'SELECT version, space_key FROM cached_pages WHERE confluence_id = $1',
      [id],
    );
    if (existing.rows.length > 0 && body.version !== undefined && body.version < existing.rows[0].version) {
      throw fastify.httpErrors.conflict('Page has been modified since you loaded it. Please refresh and try again.');
    }

    const storageBody = htmlToConfluence(body.bodyHtml);
    const currentVersion = existing.rows[0]?.version ?? body.version ?? 1;

    const page = await client.updatePage(id, body.title, storageBody, currentVersion);

    // Update local cache
    const bodyHtml = confluenceToHtml(
      page.body?.storage?.value ?? storageBody,
      id,
      existing.rows[0]?.space_key,
    );
    const { htmlToText } = await import('../../core/services/content-converter.js');
    const bodyText = htmlToText(bodyHtml);

    await query(
      `UPDATE cached_pages SET
         title = $2, body_storage = $3, body_html = $4, body_text = $5,
         version = $6, last_synced = NOW(), embedding_dirty = TRUE,
         embedding_status = 'not_embedded', embedded_at = NULL
       WHERE confluence_id = $1`,
      [id, body.title, page.body?.storage?.value ?? storageBody,
       bodyHtml, bodyText, page.version.number],
    );

    // Invalidate cache
    await cache.invalidate(userId, 'pages');

    await logAuditEvent(userId, 'PAGE_UPDATED', 'page', id, { title: body.title }, request);

    return { id, title: body.title, version: page.version.number };
  });

  // DELETE /api/pages/:id
  fastify.delete('/pages/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    const client = await getClientForUser(userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }

    await client.deletePage(id);

    // Clean up local data (page_embeddings cascade-deleted via FK)
    await query('DELETE FROM pinned_pages WHERE user_id = $1 AND page_id = $2', [userId, id]);
    await query('DELETE FROM cached_pages WHERE confluence_id = $1', [id]);
    await cleanPageAttachments(userId, id);

    // Invalidate cache
    await cache.invalidate(userId, 'pages');
    await cache.invalidate(userId, 'spaces');

    await logAuditEvent(userId, 'PAGE_DELETED', 'page', id, {}, request);

    return { message: 'Page deleted' };
  });

  // ======== Bulk Operations (Issue #28, parallelized #192) ========

  // POST /api/pages/bulk/delete - delete multiple pages by IDs
  fastify.post('/pages/bulk/delete', async (request) => {
    const { ids } = BulkIdsSchema.parse(request.body);
    const userId = request.userId;

    const client = await getClientForUser(userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }

    // Batch verify access: pages in user's selected spaces
    const existing = await query<{ confluence_id: string; space_key: string }>(
      `SELECT cp.confluence_id, cp.space_key FROM cached_pages cp
       JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
       WHERE cp.confluence_id = ANY($2)`,
      [userId, ids],
    );
    const ownedIds = new Set(existing.rows.map((r) => r.confluence_id));
    const notFoundIds = ids.filter((id) => !ownedIds.has(id));
    const errors: string[] = notFoundIds.map((id) => `Page ${id} not found`);
    let failed = notFoundIds.length;

    // Delete from Confluence in parallel with concurrency control
    const bulkLimit = pLimit(5);
    const deleteResults = await Promise.allSettled(
      [...ownedIds].map((id) => bulkLimit(() => client.deletePage(id))),
    );

    const ownedIdArray = [...ownedIds];
    const deletedIds: string[] = [];
    for (let i = 0; i < deleteResults.length; i++) {
      const result = deleteResults[i];
      if (result.status === 'fulfilled') {
        deletedIds.push(ownedIdArray[i]);
      } else {
        failed++;
        errors.push(
          `Page ${ownedIdArray[i]}: ${result.reason instanceof Error ? result.reason.message : 'Unknown error'}`,
        );
      }
    }

    // Batch cleanup: page_embeddings cascade-deleted via FK
    if (deletedIds.length > 0) {
      await Promise.all([
        query('DELETE FROM pinned_pages WHERE user_id = $1 AND page_id = ANY($2)', [userId, deletedIds]),
        query('DELETE FROM cached_pages WHERE confluence_id = ANY($1)', [deletedIds]),
      ]);
      await Promise.allSettled(deletedIds.map((id) => bulkLimit(() => cleanPageAttachments(userId, id))));
    }
    const succeeded = deletedIds.length;

    await cache.invalidate(userId, 'pages');
    await cache.invalidate(userId, 'spaces');
    await logAuditEvent(userId, 'PAGE_DELETED', 'page', undefined, { bulkIds: ids, succeeded, failed }, request);

    return { succeeded, failed, errors };
  });

  // POST /api/pages/bulk/sync - re-sync multiple pages from Confluence
  fastify.post('/pages/bulk/sync', async (request) => {
    const { ids } = BulkIdsSchema.parse(request.body);
    const userId = request.userId;

    const client = await getClientForUser(userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }

    // Batch verify access: pages in user's selected spaces
    const existing = await query<{ confluence_id: string; space_key: string }>(
      `SELECT cp.confluence_id, cp.space_key FROM cached_pages cp
       JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
       WHERE cp.confluence_id = ANY($2)`,
      [userId, ids],
    );
    const ownedIds = new Set(existing.rows.map((r) => r.confluence_id));
    const spaceKeysById = new Map(existing.rows.map((r) => [r.confluence_id, r.space_key]));
    const notFoundIds = ids.filter((id) => !ownedIds.has(id));
    const errors: string[] = notFoundIds.map((id) => `Page ${id} not found`);
    let failed = notFoundIds.length;

    // Eager-load htmlToText once (avoid repeated dynamic import)
    const { htmlToText } = await import('../../core/services/content-converter.js');

    // Fetch latest from Confluence in parallel with concurrency control
    const bulkLimit = pLimit(5);
    const syncResults = await Promise.allSettled(
      [...ownedIds].map((id) =>
        bulkLimit(async () => {
          const page = await client.getPage(id);
          const bodyHtml = confluenceToHtml(
            page.body?.storage?.value ?? '',
            id,
            spaceKeysById.get(id),
          );
          const bodyText = htmlToText(bodyHtml);

          await query(
            `UPDATE cached_pages SET
               title = $2, body_storage = $3, body_html = $4, body_text = $5,
               version = $6, last_synced = NOW(), embedding_dirty = TRUE,
               embedding_status = 'not_embedded', embedded_at = NULL
             WHERE confluence_id = $1`,
            [id, page.title, page.body?.storage?.value ?? '', bodyHtml, bodyText, page.version.number],
          );
          return id;
        }),
      ),
    );

    let succeeded = 0;
    const ownedIdArray = [...ownedIds];
    for (let i = 0; i < syncResults.length; i++) {
      const result = syncResults[i];
      if (result.status === 'fulfilled') {
        succeeded++;
      } else {
        failed++;
        errors.push(
          `Page ${ownedIdArray[i]}: ${result.reason instanceof Error ? result.reason.message : 'Unknown error'}`,
        );
      }
    }

    await cache.invalidate(userId, 'pages');

    return { succeeded, failed, errors };
  });

  // POST /api/pages/bulk/embed - re-embed multiple pages
  fastify.post('/pages/bulk/embed', async (request) => {
    const { ids } = BulkIdsSchema.parse(request.body);
    const userId = request.userId;

    // Return 409 if embedding is already in progress for this user
    if (await isProcessingUser(userId)) {
      throw fastify.httpErrors.conflict('Embedding processing is already in progress for this user');
    }

    // Batch update: single query with ANY() and RETURNING instead of N updates
    const result = await query<{ confluence_id: string }>(
      `UPDATE cached_pages SET embedding_dirty = TRUE
       WHERE confluence_id = ANY($1)
         AND space_key IN (SELECT space_key FROM user_space_selections WHERE user_id = $2)
       RETURNING confluence_id`,
      [ids, userId],
    );

    const updatedIds = new Set(result.rows.map((r) => r.confluence_id));
    const succeeded = updatedIds.size;
    const notFoundIds = ids.filter((id) => !updatedIds.has(id));
    const failed = notFoundIds.length;
    const errors: string[] = notFoundIds.map((id) => `Page ${id} not found`);

    // Fire-and-forget: trigger processing of dirty pages (same pattern as POST /embeddings/process)
    if (succeeded > 0) {
      processDirtyPages(userId).catch((err) => {
        logger.error({ err, userId }, 'Bulk embed: embedding processing failed');
      });
    }

    return { succeeded, failed, errors };
  });

  // POST /api/pages/bulk/tag - add/remove tags on multiple pages
  fastify.post('/pages/bulk/tag', async (request) => {
    const { ids, addTags, removeTags } = BulkTagSchema.parse(request.body);
    const userId = request.userId;

    if (addTags.length === 0 && removeTags.length === 0) {
      throw fastify.httpErrors.badRequest('At least one of addTags or removeTags must be provided');
    }

    const client = await getClientForUser(userId);

    // Batch fetch labels: single query with space-based access control
    const existing = await query<{ confluence_id: string; labels: string[] }>(
      `SELECT cp.confluence_id, cp.labels FROM cached_pages cp
       JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
       WHERE cp.confluence_id = ANY($2)`,
      [userId, ids],
    );
    const pageLabelsMap = new Map(existing.rows.map((r) => [r.confluence_id, r.labels || []]));
    const notFoundIds = ids.filter((id) => !pageLabelsMap.has(id));
    const errors: string[] = notFoundIds.map((id) => `Page ${id} not found`);
    let failed = notFoundIds.length;

    // Process each owned page: compute new labels, update DB, sync to Confluence
    const bulkLimit = pLimit(5);
    const tagResults = await Promise.allSettled(
      [...pageLabelsMap.entries()].map(([id, currentLabels]) =>
        bulkLimit(async () => {
          let labels = [...currentLabels];

          // Remove tags
          if (removeTags && removeTags.length > 0) {
            const removeSet = new Set(removeTags);
            labels = labels.filter((l) => !removeSet.has(l));
          }

          // Add tags (deduplicating)
          if (addTags && addTags.length > 0) {
            const labelSet = new Set(labels);
            for (const tag of addTags) {
              labelSet.add(tag);
            }
            labels = [...labelSet];
          }

          await query('UPDATE cached_pages SET labels = $2 WHERE confluence_id = $1', [
            id,
            labels,
          ]);

          // Sync label changes to Confluence
          if (client) {
            try {
              if (addTags && addTags.length > 0) {
                await client.addLabels(id, addTags);
              }
              if (removeTags && removeTags.length > 0) {
                for (const label of removeTags) {
                  await client.removeLabel(id, label);
                }
              }
            } catch (err) {
              logger.error({ err, confluenceId: id, userId }, 'Failed to sync labels to Confluence');
            }
          }

          return id;
        }),
      ),
    );

    let succeeded = 0;
    const ownedIdArray = [...pageLabelsMap.keys()];
    for (let i = 0; i < tagResults.length; i++) {
      const result = tagResults[i];
      if (result.status === 'fulfilled') {
        succeeded++;
      } else {
        failed++;
        errors.push(
          `Page ${ownedIdArray[i]}: ${result.reason instanceof Error ? result.reason.message : 'Unknown error'}`,
        );
      }
    }

    await cache.invalidate(userId, 'pages');

    return { succeeded, failed, errors };
  });
}
