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
import { PageListQuerySchema, PageTreeQuerySchema, CreatePageSchema, UpdatePageSchema } from '@kb-creator/contracts';
import { z } from 'zod';
import { logger } from '../utils/logger.js';

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

    // Try cache for simple requests (no filters active)
    const hasFilters = search || author || labels || freshness || embeddingStatus || dateFrom || dateTo;
    if (!hasFilters) {
      const cacheKey = `${spaceKey ?? 'all'}:${page}:${limit}:${sort}`;
      const cached = await cache.get(userId, 'pages', cacheKey);
      if (cached) return cached;
    }

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
             cp.embedding_dirty
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
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };

    if (!hasFilters) {
      const cacheKey = `${spaceKey ?? 'all'}:${page}:${limit}:${sort}`;
      await cache.set(userId, 'pages', cacheKey, response);
    }

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
    }>(
      `SELECT confluence_id, space_key, title, parent_id, labels, last_modified_at, embedding_dirty
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
    }>(
      `SELECT confluence_id, space_key, title, body_storage, body_html, body_text,
              version, parent_id, labels, author, last_modified_at, last_synced
       FROM cached_pages WHERE user_id = $1 AND confluence_id = $2`,
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
    };
  });

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
          version, parent_id, embedding_dirty)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)`,
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
         version = $7, last_synced = NOW(), embedding_dirty = TRUE
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
    await query('DELETE FROM page_embeddings WHERE user_id = $1 AND confluence_id = $2', [userId, id]);
    await query('DELETE FROM cached_pages WHERE user_id = $1 AND confluence_id = $2', [userId, id]);
    await cleanPageAttachments(userId, id);

    // Invalidate cache
    await cache.invalidate(userId, 'pages');
    await cache.invalidate(userId, 'spaces');

    await logAuditEvent(userId, 'PAGE_DELETED', 'page', id, {}, request);

    return { message: 'Page deleted' };
  });

  // ======== Bulk Operations (Issue #28) ========

  // POST /api/pages/bulk/delete - delete multiple pages by IDs
  fastify.post('/pages/bulk/delete', async (request) => {
    const { ids } = BulkIdsSchema.parse(request.body);
    const userId = request.userId;

    const client = await getClientForUser(userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }

    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const id of ids) {
      try {
        // Verify ownership
        const existing = await query<{ confluence_id: string }>(
          'SELECT confluence_id FROM cached_pages WHERE user_id = $1 AND confluence_id = $2',
          [userId, id],
        );
        if (existing.rows.length === 0) {
          errors.push(`Page ${id} not found`);
          failed++;
          continue;
        }

        await client.deletePage(id);
        await query('DELETE FROM page_embeddings WHERE user_id = $1 AND confluence_id = $2', [userId, id]);
        await query('DELETE FROM cached_pages WHERE user_id = $1 AND confluence_id = $2', [userId, id]);
        await cleanPageAttachments(userId, id);
        succeeded++;
      } catch (err) {
        failed++;
        errors.push(`Page ${id}: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }

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

    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const id of ids) {
      try {
        // Verify ownership
        const existing = await query<{ confluence_id: string }>(
          'SELECT confluence_id FROM cached_pages WHERE user_id = $1 AND confluence_id = $2',
          [userId, id],
        );
        if (existing.rows.length === 0) {
          errors.push(`Page ${id} not found`);
          failed++;
          continue;
        }

        // Fetch latest from Confluence
        const page = await client.getPage(id);
        const bodyHtml = confluenceToHtml(page.body?.storage?.value ?? '', id);
        const { htmlToText } = await import('../services/content-converter.js');
        const bodyText = htmlToText(bodyHtml);

        await query(
          `UPDATE cached_pages SET
             title = $3, body_storage = $4, body_html = $5, body_text = $6,
             version = $7, last_synced = NOW(), embedding_dirty = TRUE
           WHERE user_id = $1 AND confluence_id = $2`,
          [userId, id, page.title, page.body?.storage?.value ?? '', bodyHtml, bodyText, page.version.number],
        );
        succeeded++;
      } catch (err) {
        failed++;
        errors.push(`Page ${id}: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }

    await cache.invalidate(userId, 'pages');

    return { succeeded, failed, errors };
  });

  // POST /api/pages/bulk/embed - re-embed multiple pages
  fastify.post('/pages/bulk/embed', async (request) => {
    const { ids } = BulkIdsSchema.parse(request.body);
    const userId = request.userId;

    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const id of ids) {
      try {
        // Verify ownership and mark as dirty
        const result = await query(
          `UPDATE cached_pages SET embedding_dirty = TRUE
           WHERE user_id = $1 AND confluence_id = $2`,
          [userId, id],
        );
        if ((result.rowCount ?? 0) === 0) {
          errors.push(`Page ${id} not found`);
          failed++;
          continue;
        }
        succeeded++;
      } catch (err) {
        failed++;
        errors.push(`Page ${id}: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
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

    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const id of ids) {
      try {
        // Verify ownership
        const existing = await query<{ labels: string[] }>(
          'SELECT labels FROM cached_pages WHERE user_id = $1 AND confluence_id = $2',
          [userId, id],
        );
        if (existing.rows.length === 0) {
          errors.push(`Page ${id} not found`);
          failed++;
          continue;
        }

        let labels = existing.rows[0].labels || [];

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

        await query(
          'UPDATE cached_pages SET labels = $3 WHERE user_id = $1 AND confluence_id = $2',
          [userId, id, labels],
        );

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

        succeeded++;
      } catch (err) {
        failed++;
        errors.push(`Page ${id}: ${err instanceof Error ? err.message : 'Unknown error'}`);
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
      request.log.error({ err, confluenceId: id, userId, model }, 'Auto-tag failed');

      if (message.startsWith('Page not found')) {
        throw fastify.httpErrors.notFound(message);
      }
      if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
        throw fastify.httpErrors.serviceUnavailable('LLM server is not reachable');
      }
      throw fastify.httpErrors.badGateway('Auto-tagging failed — check LLM server connection');
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
}
