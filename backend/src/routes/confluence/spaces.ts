import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import { getUserAccessibleSpaces } from '../../core/services/rbac-service.js';

export async function spacesRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  const cache = new RedisCache(fastify.redis);

  // GET /api/spaces - list the user's accessible spaces (via RBAC)
  fastify.get('/spaces', async (request) => {
    const userId = request.userId;

    // Try Redis cache first
    const cached = await cache.get<unknown[]>(userId, 'spaces', 'list');
    if (cached) return cached;

    // Fetch spaces the user has access to via RBAC from shared spaces
    const userSpaces = await getUserAccessibleSpaces(userId);
    const result = await query<{
      space_key: string;
      space_name: string;
      homepage_id: string | null;
      homepage_numeric_id: number | null;
      last_synced: Date;
    }>(
      `SELECT cs.space_key, cs.space_name, cs.homepage_id,
              hp.id as homepage_numeric_id, cs.last_synced
       FROM spaces cs
       LEFT JOIN pages hp ON hp.confluence_id = cs.homepage_id AND hp.deleted_at IS NULL
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

    const spaces = result.rows.map((row) => ({
      key: row.space_key,
      name: row.space_name,
      homepageId: row.homepage_numeric_id ? String(row.homepage_numeric_id) : null,
      lastSynced: row.last_synced,
      pageCount: counts.get(row.space_key) ?? 0,
    }));

    await cache.set(userId, 'spaces', 'list', spaces);
    return spaces;
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
