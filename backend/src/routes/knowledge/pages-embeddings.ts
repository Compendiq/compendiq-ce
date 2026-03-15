import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { computePageRelationships } from '../../domains/llm/services/embedding-service.js';
import { getUserAccessibleSpaces } from '../../core/services/rbac-service.js';

export async function pagesEmbeddingRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  const cache = new RedisCache(fastify.redis);

  // GET /api/pages/graph - nodes (pages) + edges (relationships) for knowledge graph
  fastify.get('/pages/graph', async (request) => {
    const userId = request.userId;

    const cacheKey = 'graph';
    const cached = await cache.get(userId, 'pages', cacheKey);
    if (cached) return cached;

    // Fetch all pages as nodes (RBAC access control)
    const graphSpaces = await getUserAccessibleSpaces(userId);
    const nodesResult = await query<{
      confluence_id: string;
      space_key: string;
      title: string;
      labels: string[];
      embedding_status: string;
      last_modified_at: Date | null;
    }>(
      `SELECT cp.confluence_id, cp.space_key, cp.title, cp.labels, cp.embedding_status, cp.last_modified_at
       FROM pages cp
       WHERE cp.space_key = ANY($1::text[])
       ORDER BY cp.title ASC`,
      [graphSpaces],
    );

    // Fetch embedding counts per page for node sizing
    const embeddingCountResult = await query<{
      confluence_id: string;
      count: string;
    }>(
      `SELECT pe.confluence_id, COUNT(*) as count
       FROM page_embeddings pe
       JOIN pages cp ON pe.confluence_id = cp.confluence_id
       WHERE cp.space_key = ANY($1::text[])
       GROUP BY pe.confluence_id`,
      [graphSpaces],
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
       ORDER BY score DESC`,
      [],
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

    const edgeCount = await computePageRelationships();
    await cache.invalidate(userId, 'pages');

    return { message: 'Graph relationships refreshed', edges: edgeCount };
  });
}
