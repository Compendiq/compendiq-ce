import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { computePageRelationships } from '../../domains/llm/services/embedding-service.js';
import { getUserAccessibleSpaces } from '../../core/services/rbac-service.js';

/** Graph cache uses a short TTL (5 min) so relationship changes surface quickly. */
const GRAPH_CACHE_TTL = 300;

// #360 multi-select: spaceKey accepts a comma-separated list. Each value is
// trimmed and empties are dropped so `?spaceKey=` and `?spaceKey=DEV,,` both
// degrade gracefully. The values themselves are NOT whitelisted at the
// schema layer — space keys are user-defined and dynamic — but every key is
// intersected with the RBAC-accessible set inside the route handler before
// it reaches SQL. That's the actual security boundary.
const SpaceKeysSchema = z
  .string()
  .optional()
  .transform((v) =>
    v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  );

const GraphQuerySchema = z.object({
  view: z.enum(['individual', 'clustered']).default('individual'),
  spaceKey: SpaceKeysSchema,
});

// #360: filter dimensions on /graph/local. Each is optional and applied at
// SELECT time so the same producer-side rows can be re-filtered cheaply
// from the UI slider/multi-select. Validated to a finite, audited set of
// relationship types so an attacker can't smuggle SQL via the param.
const VALID_EDGE_TYPES = ['embedding_similarity', 'label_overlap', 'explicit_link', 'parent_child'] as const;
const LocalGraphQuerySchema = z.object({
  hops: z.coerce.number().int().min(1).max(3).default(2),
  // Comma-separated list of relationship types; whitespace-tolerant.
  edgeTypes: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter((s) => (VALID_EDGE_TYPES as readonly string[]).includes(s))
        : undefined,
    ),
  // Cosine-similarity floor, applied to the score column. 0 = include all,
  // 1 = exact match only. Defaults to no filter (undefined).
  minScore: z.coerce.number().min(0).max(1).optional(),
  // Comma-separated label names; case-sensitive match against pages.labels.
  // Empty string and whitespace-only entries are dropped.
  labels: z
    .string()
    .optional()
    .transform((v) =>
      v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    ),
});

const IdParamSchema = z.object({ id: z.string().min(1) });

export async function pagesEmbeddingRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  const cache = new RedisCache(fastify.redis);

  // GET /api/pages/graph - nodes (pages) + edges (relationships) for knowledge graph
  fastify.get('/pages/graph', async (request) => {
    const userId = request.userId;
    const { view, spaceKey: filterSpaceKeys } = GraphQuerySchema.parse(request.query);

    // #360: cache key incorporates the sorted multi-key set so different
    // space selections don't collide in Redis.
    const cacheSpaceKey =
      filterSpaceKeys && filterSpaceKeys.length > 0
        ? [...filterSpaceKeys].sort().join(',')
        : 'all';
    const cacheKey = `graph:${view}:${cacheSpaceKey}`;
    const cached = await cache.get(userId, 'pages', cacheKey);
    if (cached) return cached;

    // Fetch accessible spaces (RBAC).
    // #360: when the user supplies one or more `spaceKey` values, intersect
    // them with the RBAC-accessible set. The intersection IS the security
    // gate — keys the user can't see are silently dropped, never reaching
    // SQL. No SQL injection vector here because every value is bound as a
    // text[] parameter.
    const graphSpaces = await getUserAccessibleSpaces(userId);
    const effectiveSpaces =
      filterSpaceKeys && filterSpaceKeys.length > 0
        ? graphSpaces.filter((s: string) => filterSpaceKeys.includes(s))
        : graphSpaces;

    if (effectiveSpaces.length === 0) {
      return { nodes: [], edges: [] };
    }

    if (view === 'clustered') {
      return await buildClusteredGraph(userId, effectiveSpaces, cache, cacheKey);
    }

    // ── Individual view ──────────────────────────────────────────────────
    // Fetch all pages as nodes (RBAC access control)
    const nodesResult = await query<{
      id: number;
      confluence_id: string | null;
      space_key: string;
      title: string;
      labels: string[];
      embedding_status: string;
      last_modified_at: Date | null;
      parent_id: string | null;
    }>(
      `SELECT cp.id, cp.confluence_id, cp.space_key, cp.title, cp.labels,
              cp.embedding_status, cp.last_modified_at, cp.parent_id
       FROM pages cp
       WHERE cp.space_key = ANY($1::text[]) AND cp.deleted_at IS NULL
       ORDER BY cp.title ASC`,
      [effectiveSpaces],
    );

    // Fetch embedding counts per page for node sizing
    const embeddingCountResult = await query<{
      page_id: number;
      count: string;
    }>(
      `SELECT pe.page_id, COUNT(*) as count
       FROM page_embeddings pe
       JOIN pages cp ON pe.page_id = cp.id
       WHERE cp.space_key = ANY($1::text[]) AND cp.deleted_at IS NULL
       GROUP BY pe.page_id`,
      [effectiveSpaces],
    );

    const embeddingCountMap = new Map<number, number>();
    for (const row of embeddingCountResult.rows) {
      embeddingCountMap.set(row.page_id, parseInt(row.count, 10));
    }

    // Build a set of accessible node IDs to filter edges
    const nodeIdSet = new Set(nodesResult.rows.map((r) => r.id));

    // Fetch pre-computed relationships as edges, filtered to accessible nodes
    const edgesResult = await query<{
      page_id_1: number;
      page_id_2: number;
      relationship_type: string;
      score: number;
    }>(
      `SELECT pr.page_id_1, pr.page_id_2, pr.relationship_type, pr.score
       FROM page_relationships pr
       WHERE pr.page_id_1 = ANY($1::int[]) AND pr.page_id_2 = ANY($1::int[])
       ORDER BY pr.score DESC`,
      [Array.from(nodeIdSet)],
    );

    const nodes = nodesResult.rows.map((row) => ({
      id: String(row.id),
      confluenceId: row.confluence_id,
      spaceKey: row.space_key,
      title: row.title,
      labels: row.labels ?? [],
      embeddingStatus: row.embedding_status,
      embeddingCount: embeddingCountMap.get(row.id) ?? 0,
      lastModifiedAt: row.last_modified_at,
      parentId: row.parent_id,
    }));

    // Only include edges where both endpoints are in the node set
    const edges = edgesResult.rows
      .filter((row) => nodeIdSet.has(row.page_id_1) && nodeIdSet.has(row.page_id_2))
      .map((row) => ({
        source: String(row.page_id_1),
        target: String(row.page_id_2),
        type: row.relationship_type,
        score: row.score,
      }));

    const response = { nodes, edges };
    await cache.set(userId, 'pages', cacheKey, response, GRAPH_CACHE_TTL);
    return response;
  });

  // GET /api/pages/:id/graph/local - local neighborhood graph centered on a page.
  // #360 query params (all optional): hops, edgeTypes, minScore, labels.
  fastify.get('/pages/:id/graph/local', async (request) => {
    const userId = request.userId;
    const { id } = IdParamSchema.parse(request.params);
    const { hops, edgeTypes, minScore, labels } = LocalGraphQuerySchema.parse(request.query);

    // Resolve to integer page ID
    const isNumericId = /^\d+$/.test(id);
    const pageResult = await query<{ id: number; space_key: string }>(
      isNumericId
        ? 'SELECT id, space_key FROM pages WHERE id = $1 AND deleted_at IS NULL'
        : 'SELECT id, space_key FROM pages WHERE confluence_id = $1 AND deleted_at IS NULL',
      [isNumericId ? parseInt(id, 10) : id],
    );

    if (pageResult.rows.length === 0) {
      return { nodes: [], edges: [], centerId: id };
    }

    const centerPageId = pageResult.rows[0]!.id;

    // RBAC check
    const graphSpaces = await getUserAccessibleSpaces(userId);
    if (!graphSpaces.includes(pageResult.rows[0]!.space_key)) {
      return { nodes: [], edges: [], centerId: String(centerPageId) };
    }

    // Find connected page IDs within N hops via recursive CTE on page_relationships.
    // #360: apply edgeTypes/minScore filters during the BFS so the local subgraph
    // matches what the user filtered to (otherwise we'd traverse hidden edges
    // and return ghost nodes that the UI then has to drop).
    const neighborResult = await query<{ page_id: number; hop: number }>(
      `WITH RECURSIVE neighbors AS (
         SELECT $1::int AS page_id, 0 AS hop
         UNION
         SELECT CASE
           WHEN pr.page_id_1 = n.page_id THEN pr.page_id_2
           ELSE pr.page_id_1
         END AS page_id,
         n.hop + 1 AS hop
         FROM neighbors n
         JOIN page_relationships pr
           ON pr.page_id_1 = n.page_id OR pr.page_id_2 = n.page_id
         WHERE n.hop < $2
           AND ($3::text[] IS NULL OR pr.relationship_type = ANY($3::text[]))
           AND ($4::real IS NULL OR pr.score >= $4::real)
       )
       SELECT DISTINCT page_id, MIN(hop) AS hop
       FROM neighbors
       GROUP BY page_id`,
      [centerPageId, hops, edgeTypes && edgeTypes.length > 0 ? edgeTypes : null, minScore ?? null],
    );

    const neighborIds = neighborResult.rows.map((r) => r.page_id);
    if (neighborIds.length === 0) {
      neighborIds.push(centerPageId);
    }

    // Fetch node data for all neighbors. #360: apply label filter here —
    // the center node is exempt so the user sees their selected article
    // even if it doesn't carry the filter labels.
    const nodesResult = await query<{
      id: number;
      confluence_id: string | null;
      space_key: string;
      title: string;
      labels: string[];
      embedding_status: string;
      last_modified_at: Date | null;
      parent_id: string | null;
    }>(
      `SELECT cp.id, cp.confluence_id, cp.space_key, cp.title, cp.labels,
              cp.embedding_status, cp.last_modified_at, cp.parent_id
       FROM pages cp
       WHERE cp.id = ANY($1::int[])
         AND cp.space_key = ANY($2::text[])
         AND cp.deleted_at IS NULL
         AND ($3::text[] IS NULL OR cp.id = $4::int OR cp.labels && $3::text[])`,
      [neighborIds, graphSpaces, labels && labels.length > 0 ? labels : null, centerPageId],
    );

    // Embedding counts
    const embeddingCountResult = await query<{ page_id: number; count: string }>(
      `SELECT pe.page_id, COUNT(*) as count
       FROM page_embeddings pe
       WHERE pe.page_id = ANY($1::int[])
       GROUP BY pe.page_id`,
      [neighborIds],
    );

    const embeddingCountMap = new Map<number, number>();
    for (const row of embeddingCountResult.rows) {
      embeddingCountMap.set(row.page_id, parseInt(row.count, 10));
    }

    const nodeIdSet = new Set(nodesResult.rows.map((r) => r.id));

    // Fetch edges between neighbor nodes — apply the same edgeTypes /
    // minScore filters here so the rendered edges match the BFS scope.
    const edgesResult = await query<{
      page_id_1: number;
      page_id_2: number;
      relationship_type: string;
      score: number;
    }>(
      `SELECT pr.page_id_1, pr.page_id_2, pr.relationship_type, pr.score
       FROM page_relationships pr
       WHERE pr.page_id_1 = ANY($1::int[]) AND pr.page_id_2 = ANY($1::int[])
         AND ($2::text[] IS NULL OR pr.relationship_type = ANY($2::text[]))
         AND ($3::real IS NULL OR pr.score >= $3::real)
       ORDER BY pr.score DESC`,
      [
        Array.from(nodeIdSet),
        edgeTypes && edgeTypes.length > 0 ? edgeTypes : null,
        minScore ?? null,
      ],
    );

    const nodes = nodesResult.rows.map((row) => ({
      id: String(row.id),
      confluenceId: row.confluence_id,
      spaceKey: row.space_key,
      title: row.title,
      labels: row.labels ?? [],
      embeddingStatus: row.embedding_status,
      embeddingCount: embeddingCountMap.get(row.id) ?? 0,
      lastModifiedAt: row.last_modified_at,
      parentId: row.parent_id,
    }));

    const edges = edgesResult.rows
      .filter((row) => nodeIdSet.has(row.page_id_1) && nodeIdSet.has(row.page_id_2))
      .map((row) => ({
        source: String(row.page_id_1),
        target: String(row.page_id_2),
        type: row.relationship_type,
        score: row.score,
      }));

    return { nodes, edges, centerId: String(centerPageId) };
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

// ── Clustered view helper ───────────────────────────────────────────────────

async function buildClusteredGraph(
  userId: string,
  effectiveSpaces: string[],
  cache: RedisCache,
  cacheKey: string,
) {
  // Group pages by their top-level ancestor (parent_id IS NULL or 3rd-level ancestor).
  // For simplicity, group by the root ancestor (the page with no parent in the same space).
  // We use a CTE to walk up the parent chain and find each page's root ancestor.
  const clustersResult = await query<{
    root_id: number;
    root_title: string;
    space_key: string;
    article_count: string;
    page_ids: number[];
  }>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id, id AS root_id, title AS root_title, space_key, 0 AS depth
       FROM pages
       WHERE parent_id IS NULL AND space_key = ANY($1::text[]) AND deleted_at IS NULL
       UNION ALL
       SELECT p.id, p.parent_id, a.root_id, a.root_title, p.space_key, a.depth + 1
       FROM pages p
       JOIN ancestors a ON p.parent_id = a.id::text
       WHERE p.deleted_at IS NULL AND a.depth < 50
     )
     SELECT root_id, root_title, space_key, COUNT(*) AS article_count,
            array_agg(id) AS page_ids
     FROM ancestors
     GROUP BY root_id, root_title, space_key
     ORDER BY COUNT(*) DESC`,
    [effectiveSpaces],
  );

  // Pages without a root ancestor (orphans) -- group them by space
  const orphanResult = await query<{
    space_key: string;
    article_count: string;
    page_ids: number[];
  }>(
    `SELECT cp.space_key, COUNT(*) as article_count, array_agg(cp.id) as page_ids
     FROM pages cp
     WHERE cp.space_key = ANY($1::text[]) AND cp.deleted_at IS NULL
       AND cp.id NOT IN (
         WITH RECURSIVE ancestors(id, depth) AS (
           SELECT id, 0 FROM pages WHERE parent_id IS NULL AND space_key = ANY($1::text[]) AND deleted_at IS NULL
           UNION ALL
           SELECT p.id, a.depth + 1 FROM pages p JOIN ancestors a ON p.parent_id = a.id::text WHERE p.deleted_at IS NULL AND a.depth < 50
         )
         SELECT id FROM ancestors
       )
     GROUP BY cp.space_key`,
    [effectiveSpaces],
  );

  // Build cluster nodes
  const clusterNodes: Array<{
    id: string;
    type: 'cluster';
    spaceKey: string;
    title: string;
    articleCount: number;
    pageIds: number[];
  }> = [];

  for (const row of clustersResult.rows) {
    clusterNodes.push({
      id: `cluster-${row.root_id}`,
      type: 'cluster',
      spaceKey: row.space_key,
      title: row.root_title,
      articleCount: parseInt(row.article_count, 10),
      pageIds: row.page_ids,
    });
  }

  // Add orphan clusters (pages that didn't belong to any root ancestor tree)
  for (const row of orphanResult.rows) {
    if (parseInt(row.article_count, 10) > 0) {
      clusterNodes.push({
        id: `cluster-orphan-${row.space_key}`,
        type: 'cluster',
        spaceKey: row.space_key,
        title: `${row.space_key} (ungrouped)`,
        articleCount: parseInt(row.article_count, 10),
        pageIds: row.page_ids,
      });
    }
  }

  // Compute inter-cluster edges based on cross-cluster relationships
  const allPageIdToCluster = new Map<number, string>();
  for (const cluster of clusterNodes) {
    for (const pageId of cluster.pageIds) {
      allPageIdToCluster.set(pageId, cluster.id);
    }
  }

  const allPageIds = Array.from(allPageIdToCluster.keys());

  let clusterEdges: Array<{ source: string; target: string; type: string; score: number }> = [];

  if (allPageIds.length > 0) {
    const crossResult = await query<{
      page_id_1: number;
      page_id_2: number;
      relationship_type: string;
      score: number;
    }>(
      `SELECT pr.page_id_1, pr.page_id_2, pr.relationship_type, pr.score
       FROM page_relationships pr
       WHERE pr.page_id_1 = ANY($1::int[]) AND pr.page_id_2 = ANY($1::int[])`,
      [allPageIds],
    );

    // Aggregate: sum scores between cluster pairs
    const edgeMap = new Map<string, { score: number; count: number }>();
    for (const row of crossResult.rows) {
      const c1 = allPageIdToCluster.get(row.page_id_1);
      const c2 = allPageIdToCluster.get(row.page_id_2);
      if (!c1 || !c2 || c1 === c2) continue;

      const edgeKey = [c1, c2].sort().join('|');
      const existing = edgeMap.get(edgeKey);
      if (existing) {
        existing.score += row.score;
        existing.count += 1;
      } else {
        edgeMap.set(edgeKey, { score: row.score, count: 1 });
      }
    }

    clusterEdges = Array.from(edgeMap.entries()).map(([key, val]) => {
      // Safe assertion: key is constructed as [c1, c2].sort().join('|') on line above
      const [source, target] = key.split('|') as [string, string];
      return {
        source,
        target,
        type: 'cluster_relationship',
        score: val.score / val.count, // average score
      };
    });
  }

  const response = { nodes: clusterNodes, edges: clusterEdges };
  await cache.set(userId, 'pages', cacheKey, response, GRAPH_CACHE_TTL);
  return response;
}
