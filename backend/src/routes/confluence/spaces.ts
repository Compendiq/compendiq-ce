import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { isConfluenceEnabled } from '../../core/services/confluence-integration.js';
import { getClientForUser, unsyncSpace } from '../../domains/confluence/services/sync-service.js';
import { getUserAccessibleSpaces, userHasPermission, isSystemAdmin, invalidateRbacCache } from '../../core/services/rbac-service.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import { visiblePagesPredicate } from '../../core/services/page-visibility.js';

export async function spacesRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  const cache = new RedisCache(fastify.redis);

  // GET /api/spaces - list the user's accessible spaces (via RBAC)
  fastify.get('/spaces', async (request) => {
    const userId = request.userId;

    // Resolve every page-derived field under the caller-bound shared
    // visibility rule. This mixed space/page projection remains uncached:
    // the two kinds of state have independent invalidation domains.
    const userSpaces = await getUserAccessibleSpaces(userId);
    const result = await query<{
      space_key: string;
      space_name: string;
      homepage_numeric_id: number | null;
      custom_home_numeric_id: number | null;
      last_synced: Date;
      source: string;
    }>(
      `SELECT cs.space_key, cs.space_name,
              homepage.id AS homepage_numeric_id,
              custom_home.id AS custom_home_numeric_id,
              cs.last_synced, cs.source
       FROM spaces cs
       LEFT JOIN LATERAL (
         SELECT hp.id
         FROM pages hp
         WHERE (hp.confluence_id = cs.homepage_id OR hp.id::text = cs.homepage_id)
           AND hp.deleted_at IS NULL
           AND ${visiblePagesPredicate(1, 2, 'hp')}
           AND NOT EXISTS (
             SELECT 1
             FROM pages collision
             WHERE collision.deleted_at IS NULL
               AND collision.id <> hp.id
               AND (collision.confluence_id = cs.homepage_id
                    OR collision.id::text = cs.homepage_id)
           )
         LIMIT 1
       ) homepage ON TRUE
       LEFT JOIN pages custom_home
         ON custom_home.id = cs.custom_home_page_id
        AND custom_home.deleted_at IS NULL
        AND ${visiblePagesPredicate(1, 2, 'custom_home')}
       WHERE cs.space_key = ANY($1::text[])
       ORDER BY cs.space_name`,
      [userSpaces, userId],
    );

    // Count only pages whose metadata this caller may read.
    const countsResult = await query<{ space_key: string; count: string }>(
      `SELECT cp.space_key, COUNT(*) as count
       FROM pages cp
       WHERE cp.space_key = ANY($1::text[])
         AND cp.deleted_at IS NULL
         AND ${visiblePagesPredicate(1, 2)}
       GROUP BY cp.space_key`,
      [userSpaces, userId],
    );
    const counts = new Map(countsResult.rows.map((r) => [r.space_key, parseInt(r.count, 10)]));

    const syncedSpaces = result.rows.map((row) => ({
      key: row.space_key,
      name: row.space_name,
      // #352: prefer the custom home page when admin/space-owner has set
      // one; otherwise fall back to the Confluence-derived homepage. The
      // wire-format `homepageId` stays a string of the integer pages.id
      // (matches the existing contract used by frontend/PagesPage.tsx).
      homepageId:
        row.custom_home_numeric_id != null
          ? String(row.custom_home_numeric_id)
          : row.homepage_numeric_id
            ? String(row.homepage_numeric_id)
            : null,
      customHomePageId: row.custom_home_numeric_id,
      lastSynced: row.last_synced,
      pageCount: counts.get(row.space_key) ?? 0,
      source: row.source as 'confluence' | 'local',
    }));

    const syncedByKey = new Map(syncedSpaces.map((space) => [space.key, space]));
    const unsyncedSelections = userSpaces
      .filter((spaceKey) => !syncedByKey.has(spaceKey))
      .sort((a, b) => a.localeCompare(b))
      .map((spaceKey) => ({
        key: spaceKey,
        name: spaceKey,
        homepageId: null,
        lastSynced: null,
        pageCount: 0,
        source: 'confluence' as const,
      }));

    const spaces = [...syncedSpaces, ...unsyncedSelections];

    return spaces;
  });

  // PUT /api/spaces/:key/home — set the custom home page for a space (#352).
  // Auth model: admin OR `manage` permission on the space (mirrors the
  // existing space-admin role from the RBAC seed). Empty body / null id
  // clears the override — the space falls back to the Confluence-derived
  // home page in the GET /api/spaces response.
  const HomeBodySchema = z.object({
    homePageId: z.number().int().positive().nullable(),
  });
  const KeyParamSchema = z.object({ key: z.string().min(1).max(255) });

  fastify.put('/spaces/:key/home', async (request, reply) => {
    const { key } = KeyParamSchema.parse(request.params);
    const { homePageId } = HomeBodySchema.parse(request.body);
    const userId = request.userId;

    // Authorisation: system admin or space-level `manage` (the space_admin
    // system role; see migration 039). userHasPermission returns true for
    // system_admin via the early-return in rbac-service.ts:112.
    if (!(await userHasPermission(userId, 'manage', key))) {
      throw fastify.httpErrors.forbidden(
        'Setting the space home requires admin or space-owner permission.',
      );
    }

    // Reject if the space doesn't exist or isn't accessible to the caller.
    const accessible = await getUserAccessibleSpaces(userId);
    if (!accessible.includes(key)) {
      throw fastify.httpErrors.notFound('Space not found');
    }

    // If a page id is provided, sanity-check that it exists, isn't deleted,
    // and lives in this space (or is a standalone page that the user can
    // read). Without this an admin could pin an inaccessible page as home,
    // which would surface as a permission error to every viewer.
    if (homePageId !== null) {
      const pageCheck = await query<{ space_key: string; source: string; visibility: string | null }>(
        `SELECT space_key, source, visibility
         FROM pages
         WHERE id = $1 AND deleted_at IS NULL`,
        [homePageId],
      );
      if (pageCheck.rows.length === 0) {
        throw fastify.httpErrors.badRequest('Home page not found');
      }
      const row = pageCheck.rows[0]!;
      const sameSpace = row.space_key === key;
      const sharedStandalone = row.source === 'standalone' && row.visibility === 'shared';
      if (!sameSpace && !sharedStandalone) {
        throw fastify.httpErrors.badRequest(
          'Home page must live in this space or be a shared standalone page.',
        );
      }
    }

    const result = await query<{ space_key: string }>(
      `UPDATE spaces SET custom_home_page_id = $1
       WHERE space_key = $2
       RETURNING space_key`,
      [homePageId, key],
    );
    if (result.rowCount === 0) {
      throw fastify.httpErrors.notFound('Space not found');
    }

    // Invalidate every user's spaces cache — the custom home page is
    // visible to all viewers of the space, so a per-user invalidation
    // would leave non-admin users staring at the old `homepageId` for
    // up to the spaces TTL (15 min). See `invalidateAcrossUsers` in
    // redis-cache.ts for the SCAN-based fan-out.
    await cache.invalidateAcrossUsers('spaces');

    logger.info({ userId, spaceKey: key, homePageId }, 'Space custom home page updated');

    reply.status(200);
    return { spaceKey: key, customHomePageId: homePageId };
  });

  // GET /api/spaces/available - fetch spaces from Confluence for selection
  fastify.get('/spaces/available', async (request) => {
    // In standalone mode there is no Confluence to browse, and the user's
    // credentials are intact — answering "not configured" would send them off
    // to re-paste a PAT they still have. Say what is actually true (#1623).
    if (!(await isConfluenceEnabled(request.userId))) {
      throw fastify.httpErrors.conflict('Confluence integration is disabled');
    }

    const client = await getClientForUser(request.userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }

    const spaces = await client.getAllSpaces();
    return spaces.map((s) => ({
      key: s.key,
      name: s.name,
      type: s.type,
    }));
  });

  // DELETE /api/spaces/:key — stop syncing a Confluence space and purge its
  // local data (#721). Admin-only. Read-only against Confluence.
  fastify.delete('/spaces/:key', async (request) => {
    const userId = request.userId;

    if (!(await isSystemAdmin(userId))) {
      throw fastify.httpErrors.forbidden('Removing a synced space requires system admin.');
    }

    const { key } = KeyParamSchema.parse(request.params);

    const existing = await query<{ source: string }>(
      'SELECT source FROM spaces WHERE space_key = $1',
      [key],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Space not found');
    }

    const { pagesDeleted } = await unsyncSpace(key);

    await invalidateRbacCache();
    await cache.invalidate(userId, 'spaces');
    await cache.invalidate(userId, 'pages');
    await logAuditEvent(userId, 'SPACE_UNSYNCED', 'space', key, { pagesDeleted }, request);

    logger.info({ userId, spaceKey: key, pagesDeleted }, 'Space unsynced and purged');

    return { key, deleted: true, pagesDeleted };
  });
}
