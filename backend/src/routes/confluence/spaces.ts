import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import { getUserAccessibleSpaces, userHasPermission } from '../../core/services/rbac-service.js';
import { logger } from '../../core/utils/logger.js';

export async function spacesRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  const cache = new RedisCache(fastify.redis);

  // GET /api/spaces - list the user's accessible spaces (via RBAC)
  fastify.get('/spaces', async (request) => {
    const userId = request.userId;

    // Try Redis cache first
    const cached = await cache.get<unknown[]>(userId, 'spaces', 'list');
    if (cached) return cached;

    // Fetch spaces the user has access to via RBAC from shared spaces.
    // #352: customHomePageId overrides the Confluence-derived homepage_id
    // when set — see migration 071. The COALESCE picks the custom page id
    // first; otherwise the existing JOIN against confluence_id / id
    // resolves the Confluence default.
    const userSpaces = await getUserAccessibleSpaces(userId);
    const result = await query<{
      space_key: string;
      space_name: string;
      homepage_id: string | null;
      homepage_numeric_id: number | null;
      custom_home_page_id: number | null;
      last_synced: Date;
      source: string;
    }>(
      `SELECT cs.space_key, cs.space_name, cs.homepage_id,
              hp.id as homepage_numeric_id,
              cs.custom_home_page_id,
              cs.last_synced, cs.source
       FROM spaces cs
       LEFT JOIN pages hp ON (
         hp.confluence_id = cs.homepage_id
         OR CAST(hp.id AS TEXT) = cs.homepage_id
       ) AND hp.deleted_at IS NULL
       WHERE cs.space_key = ANY($1::text[])
       ORDER BY cs.space_name`,
      [userSpaces],
    );

    // Get page counts per space (scoped to user's RBAC access)
    const countsResult = await query<{ space_key: string; count: string }>(
      `SELECT cp.space_key, COUNT(*) as count
       FROM pages cp
       WHERE cp.space_key = ANY($1::text[])
       GROUP BY cp.space_key`,
      [userSpaces],
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
        row.custom_home_page_id != null
          ? String(row.custom_home_page_id)
          : row.homepage_numeric_id
            ? String(row.homepage_numeric_id)
            : null,
      customHomePageId: row.custom_home_page_id,
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

    await cache.set(userId, 'spaces', 'list', spaces);
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
}
