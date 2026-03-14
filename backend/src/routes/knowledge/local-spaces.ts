import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { z } from 'zod';

const CreateLocalSpaceSchema = z.object({
  key: z.string().min(1).max(50).regex(/^[A-Z0-9_]+$/, 'Space key must be uppercase alphanumeric with underscores'),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  icon: z.string().max(100).optional(),
});

const UpdateLocalSpaceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  icon: z.string().max(100).optional(),
});

const KeyParamSchema = z.object({ key: z.string().min(1) });
const IdParamSchema = z.object({ id: z.string().min(1) });

const MovePageSchema = z.object({
  parentId: z.union([z.string(), z.number()]).nullable(),
  spaceKey: z.string().min(1).optional(),
});

const ReorderPageSchema = z.object({
  sortOrder: z.number().int().min(0),
});

/**
 * Compute the materialized path for a page given its parent's path and its own id.
 */
function computePath(parentPath: string | null, pageId: number): string {
  if (!parentPath) return `/${pageId}`;
  return `${parentPath}/${pageId}`;
}

/**
 * Compute depth from a path string.
 */
function computeDepth(path: string): number {
  // Path format: /1/2/3 => depth = count of segments - 1 (root = 0)
  return path.split('/').filter(Boolean).length - 1;
}

export async function localSpacesRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  const cache = new RedisCache(fastify.redis);

  // GET /api/spaces/local - list local spaces
  fastify.get('/spaces/local', async (request) => {
    const userId = request.userId;

    const cacheKey = 'local-spaces:list';
    const cached = await cache.get<unknown[]>(userId, 'spaces', cacheKey);
    if (cached) return cached;

    const result = await query<{
      space_key: string;
      space_name: string;
      description: string | null;
      icon: string | null;
      created_by: string | null;
      created_at: Date | null;
    }>(
      `SELECT cs.space_key, cs.space_name, cs.description, cs.icon, cs.created_by,
              cs.last_synced AS created_at
       FROM cached_spaces cs
       WHERE cs.source = 'local'
       ORDER BY cs.space_name`,
    );

    // Get page counts per local space
    const countsResult = await query<{ space_key: string; count: string }>(
      `SELECT space_key, COUNT(*) as count
       FROM pages
       WHERE space_key IN (SELECT space_key FROM cached_spaces WHERE source = 'local')
         AND deleted_at IS NULL
       GROUP BY space_key`,
    );
    const counts = new Map(countsResult.rows.map((r) => [r.space_key, parseInt(r.count, 10)]));

    const spaces = result.rows.map((row) => ({
      key: row.space_key,
      name: row.space_name,
      description: row.description,
      icon: row.icon,
      createdBy: row.created_by,
      createdAt: row.created_at,
      pageCount: counts.get(row.space_key) ?? 0,
      source: 'local' as const,
    }));

    await cache.set(userId, 'spaces', cacheKey, spaces);
    return spaces;
  });

  // POST /api/spaces/local - create a local space
  fastify.post('/spaces/local', async (request) => {
    const userId = request.userId;
    const body = CreateLocalSpaceSchema.parse(request.body);

    // Check for duplicate key
    const existing = await query(
      'SELECT 1 FROM cached_spaces WHERE space_key = $1',
      [body.key],
    );
    if (existing.rows.length > 0) {
      throw fastify.httpErrors.conflict('A space with this key already exists');
    }

    await query(
      `INSERT INTO cached_spaces (space_key, space_name, description, icon, source, created_by, last_synced)
       VALUES ($1, $2, $3, $4, 'local', $5, NOW())`,
      [body.key, body.name, body.description ?? null, body.icon ?? null, userId],
    );

    await cache.invalidate(userId, 'spaces');
    await logAuditEvent(userId, 'LOCAL_SPACE_CREATED', 'space', body.key,
      { name: body.name }, request);

    return { key: body.key, name: body.name, source: 'local' };
  });

  // PUT /api/spaces/local/:key - update local space metadata
  fastify.put('/spaces/local/:key', async (request) => {
    const userId = request.userId;
    const { key } = KeyParamSchema.parse(request.params);
    const body = UpdateLocalSpaceSchema.parse(request.body);

    // Verify it's a local space
    const existing = await query<{ source: string; created_by: string | null }>(
      'SELECT source, created_by FROM cached_spaces WHERE space_key = $1',
      [key],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Space not found');
    }
    if (existing.rows[0].source !== 'local') {
      throw fastify.httpErrors.badRequest('Cannot modify a Confluence-synced space');
    }

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (body.name !== undefined) {
      setClauses.push(`space_name = $${paramIdx++}`);
      values.push(body.name);
    }
    if (body.description !== undefined) {
      setClauses.push(`description = $${paramIdx++}`);
      values.push(body.description);
    }
    if (body.icon !== undefined) {
      setClauses.push(`icon = $${paramIdx++}`);
      values.push(body.icon);
    }

    if (setClauses.length === 0) {
      throw fastify.httpErrors.badRequest('No fields to update');
    }

    values.push(key);
    await query(
      `UPDATE cached_spaces SET ${setClauses.join(', ')} WHERE space_key = $${paramIdx}`,
      values,
    );

    await cache.invalidate(userId, 'spaces');
    await logAuditEvent(userId, 'LOCAL_SPACE_UPDATED', 'space', key, body, request);

    return { key, updated: true };
  });

  // DELETE /api/spaces/local/:key - delete a local space
  fastify.delete('/spaces/local/:key', async (request) => {
    const userId = request.userId;
    const { key } = KeyParamSchema.parse(request.params);

    const existing = await query<{ source: string }>(
      'SELECT source FROM cached_spaces WHERE space_key = $1',
      [key],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Space not found');
    }
    if (existing.rows[0].source !== 'local') {
      throw fastify.httpErrors.badRequest('Cannot delete a Confluence-synced space');
    }

    // Check if space has pages — require cascade or empty
    const pageCount = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM pages WHERE space_key = $1 AND deleted_at IS NULL',
      [key],
    );
    if (parseInt(pageCount.rows[0].count, 10) > 0) {
      throw fastify.httpErrors.conflict(
        'Space still has pages. Delete or move all pages first.',
      );
    }

    await query('DELETE FROM cached_spaces WHERE space_key = $1', [key]);

    await cache.invalidate(userId, 'spaces');
    await logAuditEvent(userId, 'LOCAL_SPACE_DELETED', 'space', key, {}, request);

    return { key, deleted: true };
  });

  // GET /api/spaces/:key/tree - get full page tree for a space
  fastify.get('/spaces/:key/tree', async (request) => {
    const userId = request.userId;
    const { key } = KeyParamSchema.parse(request.params);

    const cacheKey = `space-tree:${key}`;
    const cached = await cache.get(userId, 'spaces', cacheKey);
    if (cached) return cached;

    // Verify space exists
    const spaceCheck = await query(
      'SELECT 1 FROM cached_spaces WHERE space_key = $1',
      [key],
    );
    if (spaceCheck.rows.length === 0) {
      throw fastify.httpErrors.notFound('Space not found');
    }

    const result = await query<{
      id: number;
      title: string;
      parent_id: string | null;
      depth: number;
      sort_order: number;
      source: string;
      confluence_id: string | null;
    }>(
      `SELECT id, title, parent_id, depth, sort_order, source, confluence_id
       FROM pages
       WHERE space_key = $1 AND deleted_at IS NULL
       ORDER BY sort_order, title`,
      [key],
    );

    const items = result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      parentId: row.parent_id,
      depth: row.depth,
      sortOrder: row.sort_order,
      source: row.source,
      confluenceId: row.confluence_id,
    }));

    const response = { spaceKey: key, items, total: items.length };
    await cache.set(userId, 'spaces', cacheKey, response, 300);
    return response;
  });

  // PUT /api/pages/:id/move - move page to different parent/space
  fastify.put('/pages/:id/move', async (request) => {
    const userId = request.userId;
    const { id } = IdParamSchema.parse(request.params);
    const body = MovePageSchema.parse(request.body);

    // Look up the page
    const existing = await query<{
      id: number;
      parent_id: string | null;
      space_key: string | null;
      source: string;
      path: string | null;
    }>(
      'SELECT id, parent_id, space_key, source, path FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const page = existing.rows[0];
    const newParentId = body.parentId !== undefined ? body.parentId : page.parent_id;
    const newSpaceKey = body.spaceKey ?? page.space_key;

    // If new parent is specified, verify it exists
    if (newParentId !== null) {
      const parentCheck = await query(
        'SELECT id, path FROM pages WHERE id = $1 AND deleted_at IS NULL',
        [newParentId],
      );
      if (parentCheck.rows.length === 0) {
        throw fastify.httpErrors.badRequest('Parent page not found');
      }

      // Prevent circular reference: cannot move a page under its own descendant
      const parentPath = parentCheck.rows[0].path as string | null;
      if (parentPath && parentPath.includes(`/${page.id}/`)) {
        throw fastify.httpErrors.badRequest('Cannot move a page under its own descendant');
      }
    }

    // Compute new path for this page
    let parentPath: string | null = null;
    if (newParentId !== null) {
      const parentResult = await query<{ path: string | null }>(
        'SELECT path FROM pages WHERE id = $1',
        [newParentId],
      );
      parentPath = parentResult.rows[0]?.path ?? null;
    }

    const newPath = computePath(parentPath, page.id);
    const newDepth = computeDepth(newPath);
    const oldPath = page.path;

    // Update the page itself
    await query(
      `UPDATE pages SET parent_id = $1, space_key = $2, path = $3, depth = $4
       WHERE id = $5`,
      [newParentId !== null ? String(newParentId) : null, newSpaceKey, newPath, newDepth, page.id],
    );

    // Update all descendants: replace old path prefix with new path prefix
    if (oldPath) {
      await query(
        `UPDATE pages
         SET path = $1 || substring(path FROM $2),
             depth = depth + $3,
             space_key = COALESCE($4, space_key)
         WHERE path LIKE $5 AND id != $6 AND deleted_at IS NULL`,
        [
          newPath,
          oldPath.length + 1, // skip old prefix
          newDepth - computeDepth(oldPath), // depth adjustment
          newSpaceKey !== page.space_key ? newSpaceKey : null,
          `${oldPath}/%`,
          page.id,
        ],
      );
    }

    await cache.invalidate(userId, 'pages');
    await cache.invalidate(userId, 'spaces');
    await logAuditEvent(userId, 'PAGE_MOVED', 'page', String(id),
      { parentId: newParentId, spaceKey: newSpaceKey }, request);

    return { id: page.id, parentId: newParentId, spaceKey: newSpaceKey, path: newPath, depth: newDepth };
  });

  // PUT /api/pages/:id/reorder - reorder page within siblings
  fastify.put('/pages/:id/reorder', async (request) => {
    const userId = request.userId;
    const { id } = IdParamSchema.parse(request.params);
    const body = ReorderPageSchema.parse(request.body);

    const existing = await query<{ id: number }>(
      'SELECT id FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    await query(
      'UPDATE pages SET sort_order = $1 WHERE id = $2',
      [body.sortOrder, id],
    );

    await cache.invalidate(userId, 'pages');
    await logAuditEvent(userId, 'PAGE_REORDERED', 'page', String(id),
      { sortOrder: body.sortOrder }, request);

    return { id: parseInt(String(id), 10), sortOrder: body.sortOrder };
  });
}
