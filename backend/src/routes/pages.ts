import { FastifyInstance } from 'fastify';
import { query } from '../db/postgres.js';
import { RedisCache } from '../services/redis-cache.js';
import { getClientForUser } from '../services/sync-service.js';
import { htmlToConfluence, confluenceToHtml } from '../services/content-converter.js';
import { cleanPageAttachments } from '../services/attachment-handler.js';
import { logAuditEvent } from '../services/audit-service.js';
import { findDuplicates, scanAllDuplicates } from '../services/duplicate-detector.js';
import { autoTagPage, applyTags, autoTagAllPages, ALLOWED_TAGS, AllowedTag } from '../services/auto-tagger.js';
import { getVersionHistory, getVersion, getSemanticDiff, saveVersionSnapshot } from '../services/version-tracker.js';
import { processDirtyPages, isProcessingUser, computePageRelationships } from '../services/embedding-service.js';
import { PageListQuerySchema, PageTreeQuerySchema, CreatePageSchema, UpdatePageSchema } from '@kb-creator/contracts';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import pLimit from 'p-limit';

const BulkIdsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(100) });
const BulkTagSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
  addTags: z.array(z.string()).default([]),
  removeTags: z.array(z.string()).default([]),
});
const SemanticDiffSchema = z.object({
  v1: z.number().int().positive(),
  v2: z.number().int().positive(),
  model: z.string().optional(),
});
const IdParamSchema = z.object({ id: z.string().min(1) });
const VersionParamSchema = z.object({ id: z.string().min(1), version: z.coerce.number().int().positive() });
const AutoTagBodySchema = z.object({ model: z.string().min(1) });
const ApplyTagsBodySchema = z.object({ tags: z.array(z.string().min(1)).min(1) });
const UpdateLabelsBodySchema = z.object({
  addLabels: z.array(z.string().min(1).max(100)).default([]),
  removeLabels: z.array(z.string().min(1).max(100)).default([]),
});

export async function pagesRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  const cache = new RedisCache(fastify.redis);

  // GET /api/pages - list/search pages
  fastify.get('/pages', async (request) => {
    const userId = request.userId;
    const params = PageListQuerySchema.parse(request.query);
    const { spaceKey, search, author, labels, freshness, embeddingStatus, dateFrom, dateTo, page = 1, limit = 50, sort = 'title' } = params;

    // Cache all page list queries. Filtered queries use a shorter TTL (2 min) vs
    // unfiltered (15 min) since filter results change more frequently (e.g. search
    // results after edits, embedding status during processing).
    const hasFilters = !!(search || author || labels || freshness || embeddingStatus || dateFrom || dateTo);
    const filterParts = [spaceKey ?? '', search ?? '', author ?? '', labels ?? '', freshness ?? '', embeddingStatus ?? '', dateFrom ?? '', dateTo ?? '', page, limit, sort].join(':');
    const cacheKey = `list:${filterParts}`;
    const cacheTtl = hasFilters ? 120 : 900; // 2 min for filtered, 15 min for unfiltered

    const cached = await cache.get(userId, 'pages', cacheKey);
    if (cached) return cached;

    // Build WHERE clause separately for reuse in count query
    let whereClause = 'WHERE cp.user_id = $1';
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
    };
    const orderBy = sortMap[sort] ?? sortMap.title;

    // Count total (uses same WHERE clause, no fragile regex replacement)
    const countSql = `SELECT COUNT(*) as count FROM cached_pages cp ${whereClause}`;
    const countResult = await query<{ count: string }>(countSql, values);
    const total = parseInt(countResult.rows[0].count, 10);

    // Build full SELECT with pagination
    const offset = (page - 1) * limit;
    const sql = `
      SELECT cp.id, cp.confluence_id, cp.space_key, cp.title, cp.version,
             cp.parent_id, cp.labels, cp.author, cp.last_modified_at, cp.last_synced,
             cp.embedding_dirty, cp.embedding_status, cp.embedded_at, cp.embedding_error
      FROM cached_pages cp
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT $${paramIdx++} OFFSET $${paramIdx}
    `;
    values.push(limit, offset);

    const result = await query<{
      id: number;
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

    let whereClause = 'WHERE user_id = $1';
    const values: unknown[] = [userId];

    if (params.spaceKey) {
      whereClause += ' AND space_key = $2';
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
      `SELECT confluence_id, space_key, title, parent_id, labels, last_modified_at,
              embedding_dirty, embedding_status, embedded_at, embedding_error
       FROM cached_pages ${whereClause}
       ORDER BY title ASC`,
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
        `SELECT DISTINCT author FROM cached_pages WHERE user_id = $1 AND author IS NOT NULL ORDER BY author ASC`,
        [userId],
      ),
      query<{ label: string }>(
        `SELECT DISTINCT unnest(labels) AS label FROM cached_pages WHERE user_id = $1 ORDER BY label ASC`,
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
    }>(
      `SELECT cp.confluence_id, cp.space_key, cp.title, cp.body_storage, cp.body_html, cp.body_text,
              cp.version, cp.parent_id, cp.labels, cp.author, cp.last_modified_at, cp.last_synced,
              cp.embedding_dirty, cp.embedding_status, cp.embedded_at, cp.embedding_error,
              EXISTS(SELECT 1 FROM cached_pages c2 WHERE c2.user_id = $1 AND c2.parent_id = cp.confluence_id) as has_children
       FROM cached_pages cp WHERE cp.user_id = $1 AND cp.confluence_id = $2`,
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
    const userId = request.userId;

    const result = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM cached_pages WHERE user_id = $1 AND parent_id = $2',
      [userId, id],
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
    const bodyHtml = confluenceToHtml(page.body?.storage?.value ?? storageBody, page.id);
    const { htmlToText } = await import('../services/content-converter.js');
    const bodyText = htmlToText(bodyHtml);

    // Store in local cache
    await query(
      `INSERT INTO cached_pages
         (user_id, confluence_id, space_key, title, body_storage, body_html, body_text,
          version, parent_id, embedding_dirty, embedding_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, 'not_embedded')`,
      [userId, page.id, body.spaceKey, body.title, page.body?.storage?.value ?? storageBody,
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
    const existing = await query<{ version: number }>(
      'SELECT version FROM cached_pages WHERE user_id = $1 AND confluence_id = $2',
      [userId, id],
    );
    if (existing.rows.length > 0 && body.version !== undefined && body.version < existing.rows[0].version) {
      throw fastify.httpErrors.conflict('Page has been modified since you loaded it. Please refresh and try again.');
    }

    const storageBody = htmlToConfluence(body.bodyHtml);
    const currentVersion = existing.rows[0]?.version ?? body.version ?? 1;

    const page = await client.updatePage(id, body.title, storageBody, currentVersion);

    // Update local cache
    const bodyHtml = confluenceToHtml(page.body?.storage?.value ?? storageBody, id);
    const { htmlToText } = await import('../services/content-converter.js');
    const bodyText = htmlToText(bodyHtml);

    await query(
      `UPDATE cached_pages SET
         title = $3, body_storage = $4, body_html = $5, body_text = $6,
         version = $7, last_synced = NOW(), embedding_dirty = TRUE,
         embedding_status = 'not_embedded', embedded_at = NULL
       WHERE user_id = $1 AND confluence_id = $2`,
      [userId, id, body.title, page.body?.storage?.value ?? storageBody,
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

    // Clean up local data
    await query('DELETE FROM pinned_pages WHERE user_id = $1 AND page_id = $2', [userId, id]);
    await query('DELETE FROM page_embeddings WHERE user_id = $1 AND confluence_id = $2', [userId, id]);
    await query('DELETE FROM cached_pages WHERE user_id = $1 AND confluence_id = $2', [userId, id]);
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

    // Batch verify ownership: single query instead of N queries
    const existing = await query<{ confluence_id: string }>(
      'SELECT confluence_id FROM cached_pages WHERE user_id = $1 AND confluence_id = ANY($2)',
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

    // Batch cleanup: parallel DB deletes + attachment cleanup
    if (deletedIds.length > 0) {
      await Promise.all([
        query('DELETE FROM pinned_pages WHERE user_id = $1 AND page_id = ANY($2)', [userId, deletedIds]),
        query('DELETE FROM page_embeddings WHERE user_id = $1 AND confluence_id = ANY($2)', [userId, deletedIds]),
        query('DELETE FROM cached_pages WHERE user_id = $1 AND confluence_id = ANY($2)', [userId, deletedIds]),
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

    // Batch verify ownership: single query instead of N queries
    const existing = await query<{ confluence_id: string }>(
      'SELECT confluence_id FROM cached_pages WHERE user_id = $1 AND confluence_id = ANY($2)',
      [userId, ids],
    );
    const ownedIds = new Set(existing.rows.map((r) => r.confluence_id));
    const notFoundIds = ids.filter((id) => !ownedIds.has(id));
    const errors: string[] = notFoundIds.map((id) => `Page ${id} not found`);
    let failed = notFoundIds.length;

    // Eager-load htmlToText once (avoid repeated dynamic import)
    const { htmlToText } = await import('../services/content-converter.js');

    // Fetch latest from Confluence in parallel with concurrency control
    const bulkLimit = pLimit(5);
    const syncResults = await Promise.allSettled(
      [...ownedIds].map((id) =>
        bulkLimit(async () => {
          const page = await client.getPage(id);
          const bodyHtml = confluenceToHtml(page.body?.storage?.value ?? '', id);
          const bodyText = htmlToText(bodyHtml);

          await query(
            `UPDATE cached_pages SET
               title = $3, body_storage = $4, body_html = $5, body_text = $6,
               version = $7, last_synced = NOW(), embedding_dirty = TRUE,
               embedding_status = 'not_embedded', embedded_at = NULL
             WHERE user_id = $1 AND confluence_id = $2`,
            [userId, id, page.title, page.body?.storage?.value ?? '', bodyHtml, bodyText, page.version.number],
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
       WHERE user_id = $1 AND confluence_id = ANY($2)
       RETURNING confluence_id`,
      [userId, ids],
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

    // Batch fetch labels: single query instead of N queries
    const existing = await query<{ confluence_id: string; labels: string[] }>(
      'SELECT confluence_id, labels FROM cached_pages WHERE user_id = $1 AND confluence_id = ANY($2)',
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

          await query('UPDATE cached_pages SET labels = $3 WHERE user_id = $1 AND confluence_id = $2', [
            userId,
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

  // ======== Duplicate Detection (Issue #34) ========

  // GET /api/pages/:id/duplicates - find duplicates for a specific page
  fastify.get('/pages/:id/duplicates', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const { threshold = '0.15', limit = '10' } = request.query as Record<string, string>;

    const duplicates = await findDuplicates(userId, id, {
      distanceThreshold: parseFloat(threshold) || 0.15,
      limit: Math.min(parseInt(limit, 10) || 10, 50),
    });

    return { duplicates, pageId: id };
  });

  // GET /api/admin/duplicates - scan all pages for duplicates (admin only)
  fastify.get('/admin/duplicates', {
    preHandler: fastify.requireAdmin,
  }, async (request) => {
    const userId = request.userId;
    const { threshold = '0.15' } = request.query as Record<string, string>;

    const pairs = await scanAllDuplicates(userId, {
      distanceThreshold: parseFloat(threshold) || 0.15,
    });

    return { pairs, total: pairs.length };
  });

  // ======== Auto-Tagging (Issue #35) ========

  // POST /api/pages/:id/auto-tag - auto-tag a single page
  fastify.post('/pages/:id/auto-tag', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const { model } = AutoTagBodySchema.parse(request.body);

    try {
      const result = await autoTagPage(userId, id, model);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error ? err.cause : undefined;
      const causeName = cause instanceof Error ? cause.name : '';
      request.log.error({ err, confluenceId: id, userId, model }, 'Auto-tag failed');

      if (message.startsWith('Page not found')) {
        throw fastify.httpErrors.notFound(message);
      }
      // Connection-level failures: server is genuinely unreachable
      if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
        throw fastify.httpErrors.serviceUnavailable('LLM server is not reachable');
      }
      // Circuit breaker is open: server was recently failing (check cause
      // chain since autoTagContent wraps the original error)
      if (causeName === 'CircuitBreakerOpenError') {
        throw fastify.httpErrors.serviceUnavailable(cause instanceof Error ? cause.message : message);
      }
      // All other LLM errors: surface the actual error message so the user
      // (and logs) can see what really went wrong instead of a generic
      // "check LLM server connection" message (fixes #151).
      throw fastify.httpErrors.badGateway(`Auto-tagging failed: ${message}`);
    }
  });

  // POST /api/pages/:id/apply-tags - apply specific tags to a page
  fastify.post('/pages/:id/apply-tags', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const { tags } = ApplyTagsBodySchema.parse(request.body);

    // Validate tags against allowed list
    const allowedSet = new Set<string>(ALLOWED_TAGS);
    const validTags = tags.filter((t) => allowedSet.has(t)) as AllowedTag[];
    if (validTags.length === 0) {
      throw fastify.httpErrors.badRequest(`No valid tags. Allowed: ${ALLOWED_TAGS.join(', ')}`);
    }

    const mergedLabels = await applyTags(userId, id, validTags);

    // Invalidate cache
    await cache.invalidate(userId, 'pages');

    return { labels: mergedLabels };
  });

  // PUT /api/pages/:id/labels - add/remove labels on a single page
  fastify.put('/pages/:id/labels', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const { addLabels: labelsToAdd, removeLabels: labelsToRemove } = UpdateLabelsBodySchema.parse(request.body);

    if (labelsToAdd.length === 0 && labelsToRemove.length === 0) {
      throw fastify.httpErrors.badRequest('At least one of addLabels or removeLabels must be provided');
    }

    // Fetch existing labels
    const existing = await query<{ labels: string[] }>(
      'SELECT labels FROM cached_pages WHERE user_id = $1 AND confluence_id = $2',
      [userId, id],
    );

    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    let labels = existing.rows[0].labels || [];

    // Remove labels
    if (labelsToRemove.length > 0) {
      const removeSet = new Set(labelsToRemove);
      labels = labels.filter((l) => !removeSet.has(l));
    }

    // Add labels (deduplicating)
    if (labelsToAdd.length > 0) {
      const labelSet = new Set(labels);
      for (const label of labelsToAdd) {
        labelSet.add(label);
      }
      labels = [...labelSet];
    }

    await query(
      'UPDATE cached_pages SET labels = $3 WHERE user_id = $1 AND confluence_id = $2',
      [userId, id, labels],
    );

    // Sync to Confluence
    const client = await getClientForUser(userId);
    if (client) {
      try {
        if (labelsToAdd.length > 0) {
          await client.addLabels(id, labelsToAdd);
        }
        for (const label of labelsToRemove) {
          await client.removeLabel(id, label);
        }
      } catch (err) {
        logger.error({ err, confluenceId: id, userId }, 'Failed to sync labels to Confluence');
      }
    }

    // Invalidate cache
    await cache.invalidate(userId, 'pages');

    return { labels };
  });

  // POST /api/admin/auto-tag-all - auto-tag all pages without labels (admin)
  fastify.post('/admin/auto-tag-all', {
    preHandler: fastify.requireAdmin,
  }, async (request) => {
    const userId = request.userId;
    const { model } = AutoTagBodySchema.parse(request.body);

    // Run in background
    autoTagAllPages(userId, model).catch((err) => {
      logger.error({ err, userId }, 'Auto-tag all pages failed');
    });

    return { message: 'Auto-tagging started in background' };
  });

  // ======== Version History (Issue #42) ========

  // GET /api/pages/:id/versions - list version history
  fastify.get('/pages/:id/versions', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    const versions = await getVersionHistory(userId, id);

    // Also include the current version from cached_pages
    const currentResult = await query<{
      version: number;
      title: string;
      last_modified_at: Date | null;
    }>(
      'SELECT version, title, last_modified_at FROM cached_pages WHERE user_id = $1 AND confluence_id = $2',
      [userId, id],
    );

    const currentVersion = currentResult.rows[0]
      ? {
          versionNumber: currentResult.rows[0].version,
          title: currentResult.rows[0].title,
          syncedAt: currentResult.rows[0].last_modified_at ?? new Date(),
          isCurrent: true,
        }
      : null;

    return {
      versions: [
        ...(currentVersion ? [currentVersion] : []),
        ...versions.map((v) => ({ ...v, isCurrent: false })),
      ],
      pageId: id,
    };
  });

  // GET /api/pages/:id/versions/:version - get specific version
  fastify.get('/pages/:id/versions/:version', async (request) => {
    const { id, version: versionNum } = VersionParamSchema.parse(request.params);
    const userId = request.userId;

    // Check if requesting current version
    const currentResult = await query<{
      version: number;
      title: string;
      body_html: string;
      body_text: string;
    }>(
      'SELECT version, title, body_html, body_text FROM cached_pages WHERE user_id = $1 AND confluence_id = $2',
      [userId, id],
    );

    if (currentResult.rows.length > 0 && currentResult.rows[0].version === versionNum) {
      return {
        confluenceId: id,
        versionNumber: versionNum,
        title: currentResult.rows[0].title,
        bodyHtml: currentResult.rows[0].body_html,
        bodyText: currentResult.rows[0].body_text,
        isCurrent: true,
      };
    }

    // Get from version history
    const pageVersion = await getVersion(userId, id, versionNum);
    if (!pageVersion) {
      throw fastify.httpErrors.notFound(`Version ${versionNum} not found`);
    }

    return {
      confluenceId: pageVersion.confluenceId,
      versionNumber: pageVersion.versionNumber,
      title: pageVersion.title,
      bodyHtml: pageVersion.bodyHtml,
      bodyText: pageVersion.bodyText,
      syncedAt: pageVersion.syncedAt,
      isCurrent: false,
    };
  });

  // POST /api/pages/:id/versions/semantic-diff - AI-generated diff between two versions
  fastify.post('/pages/:id/versions/semantic-diff', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const { v1, v2, model = 'qwen3:32b' } = SemanticDiffSchema.parse(request.body);

    // For the current version, save a snapshot first so getSemanticDiff can find it
    const current = await query<{
      version: number;
      title: string;
      body_html: string;
      body_text: string;
    }>(
      'SELECT version, title, body_html, body_text FROM cached_pages WHERE user_id = $1 AND confluence_id = $2',
      [userId, id],
    );

    if (current.rows.length > 0) {
      const row = current.rows[0];
      // Ensure current version exists in page_versions for comparison
      await saveVersionSnapshot(userId, id, row.version, row.title, row.body_html, row.body_text);
    }

    const diff = await getSemanticDiff(userId, id, v1, v2, model);
    return { diff, v1, v2, pageId: id };
  });

  // ======== Knowledge Graph (Issue #164) ========

  // GET /api/pages/graph - nodes (pages) + edges (relationships) for knowledge graph
  fastify.get('/pages/graph', async (request) => {
    const userId = request.userId;

    const cacheKey = 'graph';
    const cached = await cache.get(userId, 'pages', cacheKey);
    if (cached) return cached;

    // Fetch all pages as nodes
    const nodesResult = await query<{
      confluence_id: string;
      space_key: string;
      title: string;
      labels: string[];
      embedding_status: string;
      last_modified_at: Date | null;
    }>(
      `SELECT confluence_id, space_key, title, labels, embedding_status, last_modified_at
       FROM cached_pages
       WHERE user_id = $1
       ORDER BY title ASC`,
      [userId],
    );

    // Fetch embedding counts per page for node sizing
    const embeddingCountResult = await query<{
      confluence_id: string;
      count: string;
    }>(
      `SELECT confluence_id, COUNT(*) as count
       FROM page_embeddings
       WHERE user_id = $1
       GROUP BY confluence_id`,
      [userId],
    );

    const embeddingCountMap = new Map<string, number>();
    for (const row of embeddingCountResult.rows) {
      embeddingCountMap.set(row.confluence_id, parseInt(row.count, 10));
    }

    // Fetch pre-computed relationships as edges
    const edgesResult = await query<{
      page_id_1: string;
      page_id_2: string;
      relationship_type: string;
      score: number;
    }>(
      `SELECT page_id_1, page_id_2, relationship_type, score
       FROM page_relationships
       WHERE user_id = $1
       ORDER BY score DESC`,
      [userId],
    );

    const nodes = nodesResult.rows.map((row) => ({
      id: row.confluence_id,
      spaceKey: row.space_key,
      title: row.title,
      labels: row.labels ?? [],
      embeddingStatus: row.embedding_status,
      embeddingCount: embeddingCountMap.get(row.confluence_id) ?? 0,
      lastModifiedAt: row.last_modified_at,
    }));

    const edges = edgesResult.rows.map((row) => ({
      source: row.page_id_1,
      target: row.page_id_2,
      type: row.relationship_type,
      score: row.score,
    }));

    const response = { nodes, edges };
    await cache.set(userId, 'pages', cacheKey, response);
    return response;
  });

  // POST /api/pages/graph/refresh - recompute page relationships (admin)
  fastify.post('/pages/graph/refresh', {
    preHandler: fastify.requireAdmin,
  }, async (request) => {
    const userId = request.userId;

    const edgeCount = await computePageRelationships(userId);
    await cache.invalidate(userId, 'pages');

    return { message: 'Graph relationships refreshed', edges: edgeCount };
  });

  // ======== Pinned Articles (Issue #144) ========

  const MAX_PINS = 8;

  // GET /api/pages/pinned - list pinned articles for the current user
  fastify.get('/pages/pinned', async (request) => {
    const userId = request.userId;

    const result = await query<{
      page_id: string;
      pin_order: number;
      pinned_at: Date;
      confluence_id: string;
      space_key: string;
      title: string;
      author: string | null;
      last_modified_at: Date | null;
      body_text: string | null;
    }>(
      `SELECT pp.page_id, pp.pin_order, pp.pinned_at,
              cp.confluence_id, cp.space_key, cp.title, cp.author, cp.last_modified_at, cp.body_text
       FROM pinned_pages pp
       JOIN cached_pages cp ON cp.user_id = pp.user_id AND cp.confluence_id = pp.page_id
       WHERE pp.user_id = $1
       ORDER BY pp.pinned_at DESC`,
      [userId],
    );

    return {
      items: result.rows.map((row) => ({
        id: row.confluence_id,
        spaceKey: row.space_key,
        title: row.title,
        author: row.author,
        lastModifiedAt: row.last_modified_at,
        excerpt: row.body_text ? row.body_text.slice(0, 200) : '',
        pinnedAt: row.pinned_at,
        pinOrder: row.pin_order,
      })),
      total: result.rows.length,
    };
  });

  // POST /api/pages/:id/pin - pin an article
  fastify.post('/pages/:id/pin', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    // Verify the page exists for this user
    const pageResult = await query<{ confluence_id: string }>(
      'SELECT confluence_id FROM cached_pages WHERE user_id = $1 AND confluence_id = $2',
      [userId, id],
    );
    if (pageResult.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    // If already pinned, return 200 immediately (idempotent)
    const alreadyPinned = await query<{ page_id: string }>(
      'SELECT page_id FROM pinned_pages WHERE user_id = $1 AND page_id = $2',
      [userId, id],
    );
    if (alreadyPinned.rows.length > 0) {
      return { message: 'Page pinned', pageId: id };
    }

    // Atomic insert with count check to prevent race conditions
    const insertResult = await query(
      `INSERT INTO pinned_pages (user_id, page_id, pin_order, pinned_at)
       SELECT $1, $2, COALESCE((SELECT MAX(pin_order) FROM pinned_pages WHERE user_id = $1), 0) + 1, NOW()
       WHERE (SELECT COUNT(*) FROM pinned_pages WHERE user_id = $1) < $3
       ON CONFLICT (user_id, page_id) DO NOTHING`,
      [userId, id, MAX_PINS],
    );

    if ((insertResult.rowCount ?? 0) === 0) {
      throw fastify.httpErrors.badRequest(`Maximum of ${MAX_PINS} pinned articles allowed`);
    }

    return { message: 'Page pinned', pageId: id };
  });

  // DELETE /api/pages/:id/pin - unpin an article
  fastify.delete('/pages/:id/pin', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    const result = await query(
      'DELETE FROM pinned_pages WHERE user_id = $1 AND page_id = $2',
      [userId, id],
    );

    if ((result.rowCount ?? 0) === 0) {
      throw fastify.httpErrors.notFound('Pin not found');
    }

    return { message: 'Page unpinned', pageId: id };
  });
}
