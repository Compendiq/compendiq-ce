import { FastifyInstance } from 'fastify';
import { query } from '../db/postgres.js';
import { RedisCache } from '../services/redis-cache.js';
import { getClientForUser } from '../services/sync-service.js';

export async function spacesRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  const cache = new RedisCache(fastify.redis);

  // GET /api/spaces - list user's configured spaces
  fastify.get('/spaces', async (request) => {
    const userId = request.userId;

    // Try Redis cache first
    const cached = await cache.get<unknown[]>(userId, 'spaces', 'list');
    if (cached) return cached;

    // Fall back to PostgreSQL
    const result = await query<{
      space_key: string;
      space_name: string;
      last_synced: Date;
    }>(
      'SELECT space_key, space_name, last_synced FROM cached_spaces WHERE user_id = $1 ORDER BY space_name',
      [userId],
    );

    // Get page counts per space
    const countsResult = await query<{ space_key: string; count: string }>(
      'SELECT space_key, COUNT(*) as count FROM cached_pages WHERE user_id = $1 GROUP BY space_key',
      [userId],
    );
    const counts = new Map(countsResult.rows.map((r) => [r.space_key, parseInt(r.count, 10)]));

    const spaces = result.rows.map((row) => ({
      key: row.space_key,
      name: row.space_name,
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
