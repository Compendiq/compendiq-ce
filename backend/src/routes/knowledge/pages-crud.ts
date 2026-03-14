import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import { htmlToConfluence, confluenceToHtml } from '../../core/services/content-converter.js';
import { cleanPageAttachments } from '../../domains/confluence/services/attachment-handler.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { processDirtyPages, isProcessingUser } from '../../domains/llm/services/embedding-service.js';
import { PageListQuerySchema, PageTreeQuerySchema, CreatePageSchema, UpdatePageSchema, SaveDraftSchema } from '@kb-creator/contracts';
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

    // Exclude soft-deleted pages from normal listings
    whereClause += ' AND cp.deleted_at IS NULL';

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
    const countSql = `SELECT COUNT(*) as count FROM pages cp ${whereClause}`;
    const countResult = await query<{ count: string }>(countSql, values);
    const total = parseInt(countResult.rows[0].count, 10);

    // Build full SELECT with pagination
    const offset = (page - 1) * limit;
    const sql = `
      SELECT cp.id, cp.confluence_id, cp.space_key, cp.title, cp.version,
             cp.parent_id, cp.labels, cp.author, cp.last_modified_at, cp.last_synced,
             cp.embedding_dirty, cp.embedding_status, cp.embedded_at, cp.embedding_error,
             cp.quality_score, cp.quality_status, cp.quality_completeness, cp.quality_clarity,
             cp.quality_structure, cp.quality_accuracy, cp.quality_readability,
             cp.quality_summary, cp.quality_analyzed_at, cp.quality_error,
             cp.summary_status, cp.source, cp.visibility
      FROM pages cp
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT $${paramIdx++} OFFSET $${paramIdx}
    `;
    values.push(limit, offset);

    const result = await query<{
      id: number;
      confluence_id: string | null;
      space_key: string | null;
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
      source: string;
      visibility: string;
    }>(sql, values);

    const response = {
      items: result.rows.map((row) => ({
        id: row.id,
        confluenceId: row.confluence_id,
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
        source: row.source,
        visibility: row.visibility,
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
       FROM pages cp ${joinClause} ${treeWhereClause}
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
        `SELECT DISTINCT cp.author FROM pages cp
         JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
         WHERE cp.author IS NOT NULL ORDER BY cp.author ASC`,
        [userId],
      ),
      query<{ label: string }>(
        `SELECT DISTINCT unnest(cp.labels) AS label FROM pages cp
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

  // GET /api/pages/trash - list soft-deleted standalone articles for the current user
  // Registered before /pages/:id to avoid Fastify treating "trash" as an :id param
  fastify.get('/pages/trash', async (request) => {
    const userId = request.userId;

    const result = await query<{
      id: number; title: string; source: string; visibility: string;
      deleted_at: Date; created_at: Date;
    }>(
      `SELECT id, title, source, visibility, deleted_at, created_at
       FROM pages
       WHERE source = 'standalone' AND deleted_at IS NOT NULL AND created_by_user_id = $1
       ORDER BY deleted_at DESC`,
      [userId],
    );

    return {
      items: result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        source: row.source,
        visibility: row.visibility,
        deletedAt: row.deleted_at,
        createdAt: row.created_at,
      })),
      total: result.rows.length,
    };
  });

  // GET /api/pages/:id - get page with content
  // Accepts integer page id (universal) or confluence_id string (backward compat)
  fastify.get('/pages/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    // Determine lookup strategy: numeric ids use the integer PK, strings use confluence_id
    const isNumericId = /^\d+$/.test(id);

    const result = await query<{
      id: number;
      confluence_id: string | null;
      space_key: string | null;
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
      source: string;
      visibility: string;
      created_by_user_id: string | null;
      has_draft: boolean;
      draft_updated_at: Date | null;
    }>(
      `SELECT cp.id, cp.confluence_id, cp.space_key, cp.title, cp.body_storage, cp.body_html, cp.body_text,
              cp.version, cp.parent_id, cp.labels, cp.author, cp.last_modified_at, cp.last_synced,
              cp.embedding_dirty, cp.embedding_status, cp.embedded_at, cp.embedding_error,
              cp.quality_score, cp.quality_status, cp.quality_completeness, cp.quality_clarity,
              cp.quality_structure, cp.quality_accuracy, cp.quality_readability,
              cp.quality_summary, cp.quality_analyzed_at, cp.quality_error,
              EXISTS(SELECT 1 FROM pages c2 WHERE c2.parent_id = cp.confluence_id AND cp.confluence_id IS NOT NULL) as has_children,
              cp.summary_html, cp.summary_status, cp.summary_generated_at, cp.summary_model, cp.summary_error,
              cp.source, cp.visibility, cp.created_by_user_id,
              (cp.draft_body_html IS NOT NULL) as has_draft, cp.draft_updated_at
       FROM pages cp
       WHERE ${isNumericId ? 'cp.id = $2' : 'cp.confluence_id = $2'}
         AND cp.deleted_at IS NULL`,
      [userId, isNumericId ? parseInt(id, 10) : id],
    );

    if (result.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const row = result.rows[0];

    // Access control: Confluence pages require space selection; standalone pages
    // require ownership or shared visibility
    if (row.source === 'confluence') {
      const accessCheck = await query(
        'SELECT 1 FROM user_space_selections WHERE space_key = $1 AND user_id = $2',
        [row.space_key, userId],
      );
      if (accessCheck.rows.length === 0) {
        throw fastify.httpErrors.notFound('Page not found');
      }
    } else {
      // Standalone: owner or shared
      if (row.created_by_user_id !== userId && row.visibility !== 'shared') {
        throw fastify.httpErrors.notFound('Page not found');
      }
    }

    return {
      id: row.id,
      confluenceId: row.confluence_id,
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
      source: row.source,
      visibility: row.visibility,
      hasDraft: row.has_draft,
      draftUpdatedAt: row.draft_updated_at?.toISOString() ?? null,
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
      'SELECT COUNT(*) as count FROM pages WHERE parent_id = $1',
      [id],
    );

    return { hasChildren: parseInt(result.rows[0].count, 10) > 0 };
  });

  // POST /api/pages/:id/restore - restore a soft-deleted standalone article from trash
  fastify.post('/pages/:id/restore', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    const existing = await query<{
      id: number; title: string; source: string;
      created_by_user_id: string | null; deleted_at: Date | null;
    }>(
      'SELECT id, title, source, created_by_user_id, deleted_at FROM pages WHERE id = $1',
      [id],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const page = existing.rows[0];
    if (page.source !== 'standalone') {
      throw fastify.httpErrors.badRequest('Only standalone articles can be restored');
    }
    if (page.created_by_user_id !== userId) {
      throw fastify.httpErrors.forbidden('Not the owner');
    }
    if (!page.deleted_at) {
      throw fastify.httpErrors.badRequest('Page is not in trash');
    }

    await query('UPDATE pages SET deleted_at = NULL WHERE id = $1', [page.id]);

    await cache.invalidate(userId, 'pages');
    await logAuditEvent(userId, 'PAGE_RESTORED', 'page', String(id),
      { source: 'standalone', title: page.title }, request);

    return { id: page.id, title: page.title, restored: true };
  });

  // POST /api/pages - create page (standalone local or Confluence + local cache)
  fastify.post('/pages', async (request) => {
    const body = CreatePageSchema.parse(request.body);
    const userId = request.userId;
    const isStandalone = body.source === 'standalone' || !body.spaceKey;

    if (isStandalone) {
      // --- Standalone article: no Confluence call, store locally ---
      const { htmlToText } = await import('../../core/services/content-converter.js');
      const bodyText = htmlToText(body.bodyHtml);

      // If spaceKey is provided, verify it's a local space
      let spaceKey: string | null = null;
      if (body.spaceKey) {
        const spaceCheck = await query<{ source: string }>(
          'SELECT source FROM cached_spaces WHERE space_key = $1',
          [body.spaceKey],
        );
        if (spaceCheck.rows.length > 0 && spaceCheck.rows[0].source === 'local') {
          spaceKey = body.spaceKey;
        }
      }

      // Compute path and depth if parentId is provided
      let parentPath: string | null = null;
      if (body.parentId) {
        const parentResult = await query<{ path: string | null }>(
          'SELECT path FROM pages WHERE id = $1 AND deleted_at IS NULL',
          [body.parentId],
        );
        if (parentResult.rows.length > 0) {
          parentPath = parentResult.rows[0].path;
        }
      }

      const result = await query<{ id: number; title: string; version: number }>(
        `INSERT INTO pages
           (title, body_html, body_text, body_storage, source, created_by_user_id,
            visibility, version, space_key, confluence_id, parent_id,
            embedding_dirty, embedding_status, last_synced)
         VALUES ($1, $2, $3, NULL, 'standalone', $4, $5, 1, $6, NULL, $7,
                 TRUE, 'not_embedded', NOW())
         RETURNING id, title, version`,
        [body.title, body.bodyHtml, bodyText, userId,
         body.visibility ?? 'shared', spaceKey, body.parentId ?? null],
      );

      const newPage = result.rows[0];

      // Compute and set materialized path now that we have the page id
      const newPath = parentPath ? `${parentPath}/${newPage.id}` : `/${newPage.id}`;
      const depth = newPath.split('/').filter(Boolean).length - 1;
      await query('UPDATE pages SET path = $1, depth = $2 WHERE id = $3',
        [newPath, depth, newPage.id]);

      await cache.invalidate(userId, 'pages');
      await logAuditEvent(userId, 'PAGE_CREATED', 'page', String(newPage.id),
        { source: 'standalone', title: body.title, visibility: body.visibility ?? 'shared', spaceKey }, request);

      return { id: newPage.id, title: newPage.title, version: newPage.version, source: 'standalone' };
    }

    // --- Confluence article: existing flow ---
    const client = await getClientForUser(userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }

    // Convert TipTap HTML to Confluence storage format
    const storageBody = htmlToConfluence(body.bodyHtml);

    const page = await client.createPage(body.spaceKey!, body.title, storageBody, body.parentId);

    // Convert back to clean HTML for local cache
    const bodyHtml = confluenceToHtml(page.body?.storage?.value ?? storageBody, page.id, body.spaceKey!);
    const { htmlToText } = await import('../../core/services/content-converter.js');
    const bodyText = htmlToText(bodyHtml);

    // Store in local cache (shared table, no user_id)
    await query(
      `INSERT INTO pages
         (confluence_id, space_key, title, body_storage, body_html, body_text,
          version, parent_id, source, embedding_dirty, embedding_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confluence', TRUE, 'not_embedded')
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

    return { id: page.id, title: page.title, version: page.version.number, source: 'confluence' };
  });

  // PUT /api/pages/:id - update page (standalone local or Confluence + local cache)
  // Accepts integer page id (universal) or confluence_id string (backward compat)
  fastify.put('/pages/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const body = UpdatePageSchema.parse(request.body);
    const userId = request.userId;

    const isNumericId = /^\d+$/.test(id);

    // Load the page to determine source
    const existing = await query<{
      id: number; version: number; space_key: string | null;
      source: string; created_by_user_id: string | null;
      visibility: string; confluence_id: string | null; deleted_at: Date | null;
    }>(
      `SELECT id, version, space_key, source, created_by_user_id, visibility, confluence_id, deleted_at FROM pages WHERE ${isNumericId ? 'id = $1' : 'confluence_id = $1'}`,
      [isNumericId ? parseInt(id, 10) : id],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }
    const existingPage = existing.rows[0];

    if (existingPage.deleted_at) {
      throw fastify.httpErrors.badRequest('Cannot edit a page that is in the trash');
    }

    if (existingPage.source === 'standalone') {
      // --- Standalone article: no Confluence call ---

      // Access control: only owner or shared pages can be edited
      if (existingPage.created_by_user_id !== userId && existingPage.visibility !== 'shared') {
        throw fastify.httpErrors.forbidden('Not authorized to edit this page');
      }

      // Optimistic concurrency check
      if (body.version !== undefined && body.version < existingPage.version) {
        throw fastify.httpErrors.conflict('Page has been modified since you loaded it. Please refresh and try again.');
      }

      const { htmlToText } = await import('../../core/services/content-converter.js');
      const bodyText = htmlToText(body.bodyHtml);
      const newVersion = existingPage.version + 1;

      await query(
        `UPDATE pages SET
           title = $2, body_html = $3, body_text = $4,
           version = $5, last_modified_at = NOW(), embedding_dirty = TRUE,
           embedding_status = 'not_embedded', embedded_at = NULL
           ${body.visibility ? ', visibility = $6' : ''}
         WHERE id = $1`,
        body.visibility
          ? [id, body.title, body.bodyHtml, bodyText, newVersion, body.visibility]
          : [id, body.title, body.bodyHtml, bodyText, newVersion],
      );

      await cache.invalidate(userId, 'pages');
      await logAuditEvent(userId, 'PAGE_UPDATED', 'page', String(id), { source: 'standalone', title: body.title }, request);

      return { id: existingPage.id, title: body.title, version: newVersion, source: 'standalone' };
    }

    // --- Confluence article: existing flow ---
    const client = await getClientForUser(userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }

    // Version conflict check
    if (body.version !== undefined && body.version < existingPage.version) {
      throw fastify.httpErrors.conflict('Page has been modified since you loaded it. Please refresh and try again.');
    }

    const storageBody = htmlToConfluence(body.bodyHtml);
    const currentVersion = existingPage.version ?? body.version ?? 1;

    const confPage = await client.updatePage(existingPage.confluence_id!, body.title, storageBody, currentVersion);

    // Update local cache
    const bodyHtml = confluenceToHtml(
      confPage.body?.storage?.value ?? storageBody,
      existingPage.confluence_id!,
      existingPage.space_key ?? undefined,
    );
    const { htmlToText } = await import('../../core/services/content-converter.js');
    const bodyText = htmlToText(bodyHtml);

    await query(
      `UPDATE pages SET
         title = $2, body_storage = $3, body_html = $4, body_text = $5,
         version = $6, last_synced = NOW(), embedding_dirty = TRUE,
         embedding_status = 'not_embedded', embedded_at = NULL
       WHERE id = $1`,
      [id, body.title, confPage.body?.storage?.value ?? storageBody,
       bodyHtml, bodyText, confPage.version.number],
    );

    // Invalidate cache
    await cache.invalidate(userId, 'pages');

    await logAuditEvent(userId, 'PAGE_UPDATED', 'page', String(id), { title: body.title }, request);

    return { id: existingPage.id, title: body.title, version: confPage.version.number, source: 'confluence' };
  });

  // DELETE /api/pages/:id
  // Accepts integer page id (universal) or confluence_id string (backward compat)
  fastify.delete('/pages/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    // Parse query for permanent flag
    const queryParams = z.object({ permanent: z.string().optional() }).parse(request.query);
    const isNumericId = /^\d+$/.test(id);

    // Load the page to determine source
    const existing = await query<{
      id: number; source: string; created_by_user_id: string | null;
      confluence_id: string | null;
    }>(
      `SELECT id, source, created_by_user_id, confluence_id FROM pages WHERE ${isNumericId ? 'id = $1' : 'confluence_id = $1'}`,
      [isNumericId ? parseInt(id, 10) : id],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }
    const existingPage = existing.rows[0];

    if (existingPage.source === 'standalone') {
      // --- Standalone article ---
      // Access control: only owner can delete
      if (existingPage.created_by_user_id !== userId) {
        throw fastify.httpErrors.forbidden('Not authorized to delete this page');
      }

      if (queryParams.permanent === 'true') {
        // Hard delete
        await query('DELETE FROM pinned_pages WHERE user_id = $1 AND page_id = $2', [userId, existingPage.id]);
        await query('DELETE FROM pages WHERE id = $1', [existingPage.id]);
      } else {
        // Soft delete — move to trash
        await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [existingPage.id]);
      }

      await cache.invalidate(userId, 'pages');
      await logAuditEvent(userId, 'PAGE_DELETED', 'page', String(id),
        { source: 'standalone', permanent: queryParams.permanent === 'true' }, request);

      return { message: queryParams.permanent === 'true' ? 'Page permanently deleted' : 'Page moved to trash' };
    }

    // --- Confluence article: existing flow ---
    const client = await getClientForUser(userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }

    await client.deletePage(existingPage.confluence_id!);

    // Clean up local data (page_embeddings cascade-deleted via FK)
    await query('DELETE FROM pinned_pages WHERE user_id = $1 AND page_id = $2', [userId, existingPage.id]);
    await query('DELETE FROM pages WHERE id = $1', [existingPage.id]);
    if (existingPage.confluence_id) {
      await cleanPageAttachments(userId, existingPage.confluence_id);
    }

    // Invalidate cache
    await cache.invalidate(userId, 'pages');
    await cache.invalidate(userId, 'spaces');

    await logAuditEvent(userId, 'PAGE_DELETED', 'page', String(id), {}, request);

    return { message: 'Page deleted' };
  });

  // ======== Draft-while-published (#362) ========

  // PUT /api/pages/:id/draft — save draft (does not affect live content)
  fastify.put('/pages/:id/draft', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const body = SaveDraftSchema.parse(request.body);
    const userId = request.userId;
    const pageId = parseInt(id, 10);

    const existing = await query<{
      id: number; source: string; created_by_user_id: string | null;
      visibility: string; deleted_at: Date | null;
    }>(
      'SELECT id, source, created_by_user_id, visibility, deleted_at FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [pageId],
    );
    if (!existing.rows.length) throw fastify.httpErrors.notFound('Page not found');

    const page = existing.rows[0];

    // Access control: standalone pages require ownership or shared visibility
    if (page.source === 'standalone' && page.created_by_user_id !== userId && page.visibility !== 'shared') {
      throw fastify.httpErrors.forbidden('Not authorized to edit this page');
    }

    const { htmlToText } = await import('../../core/services/content-converter.js');
    const draftText = htmlToText(body.bodyHtml);

    await query(
      `UPDATE pages SET draft_body_html = $1, draft_body_text = $2, draft_updated_at = NOW(), draft_updated_by = $3 WHERE id = $4`,
      [body.bodyHtml, draftText, userId, page.id],
    );

    return { id: page.id, hasDraft: true, draftUpdatedAt: new Date().toISOString() };
  });

  // GET /api/pages/:id/draft — get draft content
  fastify.get('/pages/:id/draft', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const pageId = parseInt(id, 10);

    const result = await query<{
      id: number; source: string; created_by_user_id: string | null;
      visibility: string; draft_body_html: string | null;
      draft_body_text: string | null; draft_updated_at: Date | null;
      draft_updated_by: string | null;
    }>(
      `SELECT id, source, created_by_user_id, visibility, draft_body_html, draft_body_text, draft_updated_at, draft_updated_by FROM pages WHERE id = $1 AND deleted_at IS NULL`,
      [pageId],
    );
    if (!result.rows.length) throw fastify.httpErrors.notFound('Page not found');

    const row = result.rows[0];

    // Access control
    if (row.source === 'standalone' && row.created_by_user_id !== userId && row.visibility !== 'shared') {
      throw fastify.httpErrors.notFound('Page not found');
    }

    if (!row.draft_body_html) throw fastify.httpErrors.notFound('No draft exists');

    return {
      id: row.id,
      bodyHtml: row.draft_body_html,
      bodyText: row.draft_body_text,
      updatedAt: row.draft_updated_at,
      updatedBy: row.draft_updated_by,
    };
  });

  // POST /api/pages/:id/draft/publish — atomically publish draft to live
  fastify.post('/pages/:id/draft/publish', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const pageId = parseInt(id, 10);

    const existing = await query<{
      id: number; version: number; title: string;
      body_html: string | null; body_text: string | null; body_storage: string | null;
      source: string; created_by_user_id: string | null;
      visibility: string; confluence_id: string | null;
      draft_body_html: string | null; draft_body_storage: string | null;
    }>(
      `SELECT id, version, title, body_html, body_text, body_storage, source, created_by_user_id, visibility, confluence_id, draft_body_html, draft_body_storage FROM pages WHERE id = $1 AND deleted_at IS NULL`,
      [pageId],
    );
    if (!existing.rows.length) throw fastify.httpErrors.notFound('Page not found');

    const page = existing.rows[0];

    // Access control
    if (page.source === 'standalone' && page.created_by_user_id !== userId && page.visibility !== 'shared') {
      throw fastify.httpErrors.forbidden('Not authorized to publish this page');
    }

    if (!page.draft_body_html) throw fastify.httpErrors.badRequest('No draft to publish');

    // Atomically: save current live to page_versions, swap draft -> live, clear draft
    await query('BEGIN');
    try {
      // Save current live version to page_versions
      await query(
        `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text, synced_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT DO NOTHING`,
        [page.id, page.version, page.title, page.body_html, page.body_text],
      );

      // Swap draft -> live, increment version, mark embedding dirty, clear draft
      await query(
        `UPDATE pages SET
          body_html = draft_body_html, body_text = draft_body_text,
          body_storage = COALESCE(draft_body_storage, body_storage),
          version = version + 1, embedding_dirty = TRUE,
          embedding_status = 'not_embedded', embedded_at = NULL,
          last_modified_at = NOW(),
          draft_body_html = NULL, draft_body_text = NULL, draft_body_storage = NULL,
          draft_updated_at = NULL, draft_updated_by = NULL
         WHERE id = $1`,
        [page.id],
      );

      await query('COMMIT');
    } catch (err) {
      await query('ROLLBACK');
      throw err;
    }

    // For Confluence articles, push updated content upstream (best-effort)
    if (page.source === 'confluence' && page.confluence_id) {
      try {
        const client = await getClientForUser(userId);
        if (client) {
          const storageBody = htmlToConfluence(page.draft_body_html!);
          await client.updatePage(page.confluence_id, page.title, storageBody, page.version + 1);
        }
      } catch (err) {
        // Log but don't fail — local publish succeeded
        request.log.error({ err }, 'Failed to push draft to Confluence');
      }
    }

    await cache.invalidate(userId, 'pages');
    await logAuditEvent(userId, 'DRAFT_PUBLISHED', 'page', String(page.id),
      { version: page.version + 1 }, request);

    return { id: page.id, version: page.version + 1, published: true };
  });

  // DELETE /api/pages/:id/draft — discard draft
  fastify.delete('/pages/:id/draft', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const pageId = parseInt(id, 10);

    const existing = await query<{
      id: number; source: string; created_by_user_id: string | null;
      visibility: string;
    }>(
      'SELECT id, source, created_by_user_id, visibility FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [pageId],
    );
    if (!existing.rows.length) throw fastify.httpErrors.notFound('Page not found');

    const page = existing.rows[0];

    // Access control
    if (page.source === 'standalone' && page.created_by_user_id !== userId && page.visibility !== 'shared') {
      throw fastify.httpErrors.forbidden('Not authorized to discard this draft');
    }

    await query(
      `UPDATE pages SET draft_body_html = NULL, draft_body_text = NULL, draft_body_storage = NULL, draft_updated_at = NULL, draft_updated_by = NULL WHERE id = $1`,
      [page.id],
    );

    return { id: page.id, hasDraft: false };
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
      `SELECT cp.confluence_id, cp.space_key FROM pages cp
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
        query('DELETE FROM pages WHERE confluence_id = ANY($1)', [deletedIds]),
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
      `SELECT cp.confluence_id, cp.space_key FROM pages cp
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
            `UPDATE pages SET
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
      `UPDATE pages SET embedding_dirty = TRUE
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
      `SELECT cp.confluence_id, cp.labels FROM pages cp
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

          await query('UPDATE pages SET labels = $2 WHERE confluence_id = $1', [
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
