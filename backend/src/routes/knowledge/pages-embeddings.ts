import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { computePageRelationships } from '../../domains/llm/services/embedding-service.js';
import { ensureDeterministicRelationships } from '../../domains/llm/services/deterministic-relationships.js';
import { getUserAccessibleSpaces } from '../../core/services/rbac-service.js';
import { visiblePagesPredicate } from '../../core/services/page-visibility.js';
import { toPageIdText } from '../../core/utils/page-id-text.js';

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
  // #361 Phase 3: per-hop neighbor cap on the recursive BFS so a 3-hop
  // expansion can't pull most of a 2000-page corpus. Defaults to 50 which
  // is comfortable for a 1-2-hop ego graph; admins/power users can raise it
  // when targeted exploration is needed.
  perHopLimit: z.coerce.number().int().min(1).max(500).default(50),
});

const IdParamSchema = z.object({ id: z.string().min(1) });

// #361 Phase 3: read-time similarity-score floor tiered by corpus size.
// The producer-side threshold stays low (0.4) so we don't lose data; the
// read filter trims the rendered set to keep the graph readable on big
// corpora. Source-of-truth comment in `embedding-service.ts:842`.
function tieredMinScoreForCorpus(pagesTotal: number): number {
  if (pagesTotal < 500) return 0.4;
  if (pagesTotal < 2000) return 0.6;
  return 0.7;
}
export const __testHelpers = { tieredMinScoreForCorpus };

export async function pagesEmbeddingRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  const cache = new RedisCache(fastify.redis);

  // GET /api/pages/graph - nodes (pages) + edges (relationships) for knowledge graph.
  // Response shape:
  //   { nodes, edges, meta: { pagesTotal, pagesEmbedded, relationshipsTotal,
  //     relationshipsByType: { embedding_similarity, label_overlap, explicit_link?, parent_child? } } }
  // The meta block is what powers the differentiated empty states in #358:
  // - pagesTotal === 0  → "No accessible pages in selected spaces"
  // - pagesEmbedded === 0 (with pagesTotal > 0)  → "Pages not embedded yet"
  // - relationshipsTotal === 0 (with pagesEmbedded > 0)  → "Embedded but no relationships yet"
  fastify.get('/pages/graph', async (request) => {
    const userId = request.userId;
    const { view, spaceKey: filterSpaceKeys } = GraphQuerySchema.parse(request.query);

    // #360: cache key incorporates the sorted multi-key set so different
    // space selections don't collide in Redis.
    const cacheSpaceKey =
      filterSpaceKeys && filterSpaceKeys.length > 0
        ? [...filterSpaceKeys].sort().join(',')
        : 'all';
    const cacheKey = `graph:v2:${view}:${cacheSpaceKey}`;
    const cacheReceipt = await cache.getWithGeneration(userId, 'pages', cacheKey);
    if (cacheReceipt.value !== null) return cacheReceipt.value;

    // RBAC space keys are one arm of the shared page-visibility contract; they
    // must not become a prerequisite for standalone pages. Apply an optional
    // caller-selected space filter only after that full contract.
    const graphSpaces = await getUserAccessibleSpaces(userId);
    const selectedSpaces = filterSpaceKeys && filterSpaceKeys.length > 0
      ? filterSpaceKeys
      : null;
    const visiblePages = await query<{ id: number }>(
      `SELECT cp.id
       FROM pages cp
       WHERE cp.deleted_at IS NULL
         AND ${visiblePagesPredicate(1, 2)}
         AND ($3::text[] IS NULL OR cp.space_key = ANY($3::text[]))`,
      [graphSpaces, userId, selectedSpaces],
    );
    const visiblePageIds = visiblePages.rows.map((row) => row.id);
    if (visiblePageIds.length === 0) {
      return {
        nodes: [],
        edges: [],
        meta: { pagesTotal: 0, pagesEmbedded: 0, relationshipsTotal: 0, relationshipsByType: {} },
      };
    }

    if (view === 'clustered') {
      return await buildClusteredGraph(
        userId,
        visiblePageIds,
        cache,
        cacheKey,
        cacheReceipt.generation,
      );
    }

    // ── Individual view ──────────────────────────────────────────────────
    // Fetch all pages as nodes (RBAC access control)
    const nodesResult = await query<{
      id: number;
      confluence_id: string | null;
      space_key: string | null;
      title: string;
      labels: string[];
      embedding_status: string;
      last_modified_at: Date | null;
      parent_id: string | null;
    }>(
      `SELECT cp.id, cp.confluence_id, cp.space_key, cp.title, cp.labels,
              cp.embedding_status, cp.last_modified_at,
              CASE WHEN parent_page.id IS NULL THEN NULL ELSE cp.parent_id END AS parent_id
       FROM pages cp
       LEFT JOIN pages parent_page ON (
         parent_page.confluence_id = cp.parent_id
         OR parent_page.id::text = cp.parent_id
       )
         AND parent_page.deleted_at IS NULL
         AND parent_page.id = ANY($1::int[])
         AND NOT EXISTS (
           SELECT 1 FROM pages parent_collision
           WHERE parent_collision.deleted_at IS NULL
             AND parent_collision.id <> parent_page.id
             AND (parent_collision.confluence_id = cp.parent_id
                  OR parent_collision.id::text = cp.parent_id)
         )
       WHERE cp.id = ANY($1::int[])
         AND cp.deleted_at IS NULL
       ORDER BY cp.title ASC`,
      [visiblePageIds],
    );

    // Fetch embedding counts per page for node sizing
    const embeddingCountResult = await query<{
      page_id: number;
      count: string;
    }>(
      `SELECT pe.page_id, COUNT(*) as count
       FROM page_embeddings pe
       JOIN pages cp ON pe.page_id = cp.id
       WHERE cp.id = ANY($1::int[])
         AND cp.deleted_at IS NULL
       GROUP BY pe.page_id`,
      [visiblePageIds],
    );

    const embeddingCountMap = new Map<number, number>();
    for (const row of embeddingCountResult.rows) {
      embeddingCountMap.set(row.page_id, parseInt(row.count, 10));
    }

    // Build a set of accessible node IDs to filter edges
    const nodeIdSet = new Set(nodesResult.rows.map((r) => r.id));

    // Fetch pre-computed relationships as edges, filtered to accessible nodes.
    // #361 Phase 3: tier the read-time similarity-score floor by corpus size
    // so large knowledge bases stay readable. Producer-side threshold stays
    // low (0.4) so the underlying data is not lossy. Non-similarity edge
    // types (label_overlap, explicit_link, parent_child) bypass the score
    // floor since their score=1.0 is meaningful, not similarity-derived.
    const minScoreFloor = tieredMinScoreForCorpus(nodesResult.rows.length);
    const edgesResult = await query<{
      page_id_1: number;
      page_id_2: number;
      relationship_type: string;
      score: number;
    }>(
      `SELECT pr.page_id_1, pr.page_id_2, pr.relationship_type, pr.score
       FROM page_relationships pr
       WHERE pr.page_id_1 = ANY($1::int[]) AND pr.page_id_2 = ANY($1::int[])
         AND (pr.relationship_type <> 'embedding_similarity' OR pr.score >= $2)
       ORDER BY pr.score DESC`,
      [Array.from(nodeIdSet), minScoreFloor],
    );

    const nodes = nodesResult.rows.map((row) => ({
      id: String(row.id),
      confluenceId: row.confluence_id,
      spaceKey: row.space_key ?? '',
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

    // #358: meta counts so the UI can differentiate empty states without
    // a second roundtrip. pagesEmbedded counts pages that have at least
    // one row in page_embeddings; relationshipsByType breaks the edge
    // count down per relationship_type for diagnostics.
    const pagesEmbedded = embeddingCountMap.size;
    const relationshipsByType: Record<string, number> = {};
    for (const e of edges) {
      relationshipsByType[e.type] = (relationshipsByType[e.type] ?? 0) + 1;
    }

    const response = {
      nodes,
      edges,
      meta: {
        pagesTotal: nodes.length,
        pagesEmbedded,
        relationshipsTotal: edges.length,
        relationshipsByType,
      },
    };
    await cache.setIfCurrent(
      userId,
      'pages',
      cacheKey,
      cacheReceipt.generation,
      response,
      GRAPH_CACHE_TTL,
    );
    return response;
  });

  // GET /api/pages/:id/graph/local - local neighborhood graph centered on a page.
  // #360 query params (all optional): hops, edgeTypes, minScore, labels.
  fastify.get('/pages/:id/graph/local', async (request) => {
    const userId = request.userId;
    const { id } = IdParamSchema.parse(request.params);
    const { hops, edgeTypes, minScore, labels, perHopLimit } = LocalGraphQuerySchema.parse(request.query);

    const isNumericId = /^\d+$/.test(id);
    const graphSpaces = await getUserAccessibleSpaces(userId);
    const centerSpaceParam = isNumericId ? 3 : 2;
    const centerUserParam = isNumericId ? 4 : 3;
    const pageResult = await query<{ id: number }>(
      `SELECT cp.id
       FROM pages cp
       WHERE ${isNumericId ? '(cp.confluence_id = $1 OR cp.id::text = $2)' : 'cp.confluence_id = $1'}
         AND cp.deleted_at IS NULL
         AND ${visiblePagesPredicate(centerSpaceParam, centerUserParam)}`,
      isNumericId
        ? [id, toPageIdText(id), graphSpaces, userId]
        : [id, graphSpaces, userId],
    );

    // Missing, ambiguous, and inaccessible identifiers deliberately share the
    // same response, including the caller-supplied center string. Never expose
    // a canonical database id until the caller-bound query above admits it.
    if (pageResult.rows.length !== 1) {
      return { nodes: [], edges: [], centerId: id };
    }

    const centerPageId = pageResult.rows[0]!.id;
    await ensureDeterministicRelationships();

    // Resolve the complete shared-list-visible vertex set before traversal.
    // Filtering before each per-hop limit prevents a hidden vertex from
    // consuming the bound or becoming an intermediate path.
    const accessiblePages = await query<{ id: number }>(
      `SELECT cp.id
       FROM pages cp
       WHERE cp.deleted_at IS NULL
         AND ${visiblePagesPredicate(1, 2)}`,
      [graphSpaces, userId],
    );
    const accessiblePageIds = accessiblePages.rows.map((row) => row.id);
    const neighborResult = await query<{ page_id: number; hop: number }>(
      `WITH RECURSIVE neighbors AS (
         SELECT $1::int AS page_id, 0 AS hop
         UNION
         SELECT next.page_id, n.hop + 1 AS hop
         FROM neighbors n
         CROSS JOIN LATERAL (
           SELECT CASE WHEN pr.page_id_1 = n.page_id THEN pr.page_id_2 ELSE pr.page_id_1 END AS page_id
           FROM page_relationships pr
           WHERE (pr.page_id_1 = n.page_id OR pr.page_id_2 = n.page_id)
             AND ($4::text[] IS NULL OR pr.relationship_type = ANY($4::text[]))
             AND ($5::real IS NULL OR pr.score >= $5::real)
             AND (
               CASE WHEN pr.page_id_1 = n.page_id THEN pr.page_id_2 ELSE pr.page_id_1 END
             ) = ANY($6::int[])
           ORDER BY pr.score DESC,
             CASE WHEN pr.page_id_1 = n.page_id THEN pr.page_id_2 ELSE pr.page_id_1 END ASC
           LIMIT $3
         ) next
         WHERE n.hop < $2
       )
       SELECT DISTINCT page_id, MIN(hop) AS hop
       FROM neighbors
       GROUP BY page_id`,
      [
        centerPageId,
        hops,
        perHopLimit,
        edgeTypes && edgeTypes.length > 0 ? edgeTypes : null,
        minScore ?? null,
        accessiblePageIds,
      ],
    );

    const neighborIds = neighborResult.rows.map((row) => row.page_id);
    if (neighborIds.length === 0) neighborIds.push(centerPageId);

    // The label filter remains a display filter. The center is exempt so the
    // requested article is always present in its own authorized graph.
    const nodesResult = await query<{
      id: number;
      confluence_id: string | null;
      space_key: string | null;
      title: string;
      labels: string[];
      embedding_status: string;
      last_modified_at: Date | null;
      parent_id: string | null;
    }>(
      `SELECT cp.id, cp.confluence_id, cp.space_key, cp.title, cp.labels,
              cp.embedding_status, cp.last_modified_at,
              CASE WHEN parent_page.id IS NULL THEN NULL ELSE cp.parent_id END AS parent_id
       FROM pages cp
       LEFT JOIN pages parent_page ON (
         parent_page.confluence_id = cp.parent_id
         OR parent_page.id::text = cp.parent_id
       )
         AND parent_page.deleted_at IS NULL
         AND parent_page.id = ANY($2::int[])
         AND NOT EXISTS (
           SELECT 1 FROM pages parent_collision
           WHERE parent_collision.deleted_at IS NULL
             AND parent_collision.id <> parent_page.id
             AND (parent_collision.confluence_id = cp.parent_id
                  OR parent_collision.id::text = cp.parent_id)
         )
       WHERE cp.id = ANY($1::int[])
         AND cp.id = ANY($2::int[])
         AND cp.deleted_at IS NULL
         AND ($3::text[] IS NULL OR cp.id = $4::int OR cp.labels && $3::text[])`,
      [neighborIds, accessiblePageIds, labels && labels.length > 0 ? labels : null, centerPageId],
    );

    const nodeIdSet = new Set(nodesResult.rows.map((row) => row.id));
    const embeddingCountResult = await query<{ page_id: number; count: string }>(
      `SELECT pe.page_id, COUNT(*) as count
       FROM page_embeddings pe
       WHERE pe.page_id = ANY($1::int[])
       GROUP BY pe.page_id`,
      [[...nodeIdSet]],
    );

    const embeddingCountMap = new Map<number, number>();
    for (const row of embeddingCountResult.rows) {
      embeddingCountMap.set(row.page_id, parseInt(row.count, 10));
    }

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
        [...nodeIdSet],
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

    // #359: `computePageRelationships` runs every registered edge producer
    // inside its transaction — including explicit_link, registered at app
    // bootstrap via `registerKnowledgeRelationshipProducers()`. Returned
    // count is the sum across all producers.
    const edgeCount = await computePageRelationships();
    await cache.invalidate(userId, 'pages');

    return { message: 'Graph relationships refreshed', edges: edgeCount };
  });
}

// ── Clustered view helper ───────────────────────────────────────────────────

async function buildClusteredGraph(
  userId: string,
  visiblePageIds: number[],
  cache: RedisCache,
  cacheKey: string,
  cacheGeneration: string | null,
) {
  // Resolve the visible forest once. A parent is usable only when its stored
  // key identifies exactly one live page and that page is visible. Hidden,
  // missing, and ambiguous parents all re-root the visible child.
  const clustersResult = await query<{
    root_id: number | null;
    root_title: string | null;
    space_key: string | null;
    article_count: string;
    page_ids: number[];
    is_orphan: boolean;
  }>(
    `WITH RECURSIVE visible AS MATERIALIZED (
       SELECT p.id, p.confluence_id, p.source, p.parent_id, p.title, p.space_key
       FROM pages p
       WHERE p.id = ANY($1::int[])
         AND p.deleted_at IS NULL
     ),
     resolved AS MATERIALIZED (
       SELECT visible.*,
              resolved_parent.id AS parent_numeric_id
       FROM visible
       LEFT JOIN LATERAL (
         SELECT MIN(candidate.id)::integer AS id
         FROM pages candidate
         WHERE candidate.deleted_at IS NULL
           AND (candidate.confluence_id = visible.parent_id
                OR candidate.id::text = visible.parent_id)
         HAVING COUNT(*) = 1
            AND BOOL_AND(candidate.id = ANY($1::int[]))
       ) resolved_parent ON TRUE
     ),
     ancestors AS (
       SELECT resolved.id, resolved.parent_numeric_id,
              resolved.id AS root_id, resolved.title AS root_title,
              resolved.space_key AS root_space_key, 0 AS depth
       FROM resolved
       WHERE resolved.parent_numeric_id IS NULL
       UNION ALL
       SELECT child.id, child.parent_numeric_id,
              parent.root_id, parent.root_title, parent.root_space_key,
              parent.depth + 1
       FROM resolved child
       JOIN ancestors parent ON child.parent_numeric_id = parent.id
       WHERE parent.depth < 50
     )
     SELECT ancestors.root_id, ancestors.root_title,
            ancestors.root_space_key AS space_key,
            COUNT(*) AS article_count, array_agg(ancestors.id) AS page_ids,
            FALSE AS is_orphan
     FROM ancestors
     GROUP BY ancestors.root_id, ancestors.root_title, ancestors.root_space_key
     UNION ALL
     SELECT NULL::integer AS root_id, NULL::text AS root_title,
            resolved.space_key, COUNT(*) AS article_count,
            array_agg(resolved.id) AS page_ids, TRUE AS is_orphan
     FROM resolved
     WHERE NOT EXISTS (
       SELECT 1 FROM ancestors WHERE ancestors.id = resolved.id
     )
     GROUP BY resolved.space_key
     ORDER BY article_count DESC`,
    [visiblePageIds],
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
    const spaceKey = row.space_key ?? '';
    clusterNodes.push({
      id: row.is_orphan
        ? `cluster-orphan-${spaceKey || 'unassigned'}`
        : `cluster-${row.root_id!}`,
      type: 'cluster',
      spaceKey,
      title: row.is_orphan
        ? `${spaceKey || 'Unassigned'} (ungrouped)`
        : row.root_title!,
      articleCount: parseInt(row.article_count, 10),
      pageIds: row.page_ids,
    });
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
  await cache.setIfCurrent(
    userId,
    'pages',
    cacheKey,
    cacheGeneration,
    response,
    GRAPH_CACHE_TTL,
  );
  return response;
}
