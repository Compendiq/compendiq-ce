import { query, getPool } from '../../../core/db/postgres.js';
import { getUserAccessibleSpaces } from '../../../core/services/rbac-service.js';
import { logger } from '../../../core/utils/logger.js';

const RAG_EF_SEARCH = parseInt(process.env.RAG_EF_SEARCH ?? '100', 10);

export interface DuplicateCandidate {
  confluenceId: string;
  title: string;
  spaceKey: string;
  embeddingDistance: number;
  titleSimilarity: number;
  combinedScore: number;
}

/**
 * Compute Jaccard similarity between two sets of tokens.
 * Returns a value between 0 (no overlap) and 1 (identical).
 */
function tokenJaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean));

  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Find duplicate/near-duplicate pages for a given page using pgvector kNN.
 * Computes average embedding for the source page, then finds nearest neighbors.
 */
export async function findDuplicates(
  userId: string,
  confluenceId: string,
  options: {
    distanceThreshold?: number;
    limit?: number;
  } = {},
): Promise<DuplicateCandidate[]> {
  const { distanceThreshold = 0.15, limit = 10 } = options;

  // Get the source page title for title similarity comparison
  const sourcePageResult = await query<{ title: string }>(
    'SELECT title FROM pages WHERE confluence_id = $1 AND deleted_at IS NULL',
    [confluenceId],
  );
  if (sourcePageResult.rows.length === 0) {
    throw new Error(`Page not found: ${confluenceId}`);
  }
  const sourceTitle = sourcePageResult.rows[0].title;

  // Use a dedicated client for SET LOCAL
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL hnsw.ef_search = ${RAG_EF_SEARCH}`);

    // Find nearest neighbors using pgvector kNN on the average embedding
    const result = await client.query<{
      confluence_id: string;
      title: string;
      space_key: string;
      distance: number;
    }>(
      `WITH source_avg AS (
         SELECT AVG(embedding) AS avg_embedding
         FROM page_embeddings
         WHERE confluence_id = $1
       )
       SELECT DISTINCT ON (pe2.confluence_id)
         pe2.confluence_id,
         pe2.metadata->>'page_title' AS title,
         pe2.metadata->>'space_key' AS space_key,
         pe2.embedding <=> source_avg.avg_embedding AS distance
       FROM page_embeddings pe2, source_avg
       WHERE pe2.confluence_id != $1
         AND source_avg.avg_embedding IS NOT NULL
       ORDER BY pe2.confluence_id, pe2.embedding <=> source_avg.avg_embedding
       LIMIT $2`,
      [confluenceId, limit * 3], // Over-fetch to filter later
    );

    await client.query('COMMIT');

    // Filter by distance threshold and compute combined score
    const candidates: DuplicateCandidate[] = [];
    for (const row of result.rows) {
      if (row.distance > distanceThreshold) continue;

      const titleSim = tokenJaccardSimilarity(sourceTitle, row.title);
      // Combined score: 70% embedding similarity + 30% title similarity
      const embeddingSimilarity = 1 - row.distance;
      const combinedScore = embeddingSimilarity * 0.7 + titleSim * 0.3;

      candidates.push({
        confluenceId: row.confluence_id,
        title: row.title,
        spaceKey: row.space_key,
        embeddingDistance: row.distance,
        titleSimilarity: titleSim,
        combinedScore,
      });
    }

    // Sort by combined score descending and limit
    candidates.sort((a, b) => b.combinedScore - a.combinedScore);
    return candidates.slice(0, limit);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Scan all pages for a user to find duplicate clusters.
 * Returns pairs of pages that are likely duplicates.
 */
export async function scanAllDuplicates(
  userId: string,
  options: {
    distanceThreshold?: number;
    maxPairsPerPage?: number;
  } = {},
): Promise<Array<{ page1: DuplicateCandidate & { sourceId: string }; page2: DuplicateCandidate }>> {
  const { distanceThreshold = 0.15, maxPairsPerPage = 3 } = options;

  // Get all pages with embeddings (RBAC access control)
  const dupSpaces = await getUserAccessibleSpaces(userId);
  const pages = await query<{ confluence_id: string; title: string }>(
    `SELECT DISTINCT cp.confluence_id, cp.title
     FROM pages cp
     JOIN page_embeddings pe ON cp.confluence_id = pe.confluence_id
     WHERE cp.space_key = ANY($1::text[])
       AND cp.deleted_at IS NULL`,
    [dupSpaces],
  );

  const allPairs: Array<{ page1: DuplicateCandidate & { sourceId: string }; page2: DuplicateCandidate }> = [];
  const seen = new Set<string>();

  for (const page of pages.rows) {
    try {
      const duplicates = await findDuplicates(userId, page.confluence_id, {
        distanceThreshold,
        limit: maxPairsPerPage,
      });

      for (const dup of duplicates) {
        // Avoid reporting A->B and B->A
        const pairKey = [page.confluence_id, dup.confluenceId].sort().join(':');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        allPairs.push({
          page1: {
            sourceId: page.confluence_id,
            confluenceId: page.confluence_id,
            title: page.title,
            spaceKey: '', // Will be filled from the scan
            embeddingDistance: 0,
            titleSimilarity: 1,
            combinedScore: dup.combinedScore,
          },
          page2: dup,
        });
      }
    } catch (err) {
      logger.error({ err, confluenceId: page.confluence_id }, 'Failed to find duplicates for page');
    }
  }

  // Sort by combined score descending
  allPairs.sort((a, b) => b.page2.combinedScore - a.page2.combinedScore);
  return allPairs;
}

export { tokenJaccardSimilarity };
