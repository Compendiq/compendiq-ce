import { query, getPool } from '../../../core/db/postgres.js';
import { getUserAccessibleSpaces } from '../../../core/services/rbac-service.js';
import { visiblePagesPredicate } from '../../../core/services/page-visibility.js';
import { logger } from '../../../core/utils/logger.js';

const RAG_EF_SEARCH = parseInt(process.env.RAG_EF_SEARCH ?? '100', 10);

interface DuplicateCandidate {
  // Stable page PK — always present, used as the dedup key and as a non-null
  // navigation target for standalone pages (confluenceId IS NULL).
  id: number;
  confluenceId: string | null;
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
 *
 * RBAC (#733): both the source page and the candidate set are restricted to
 * what `userId` can read — Confluence pages in accessible spaces plus shared
 * or own-private standalone articles. An inaccessible source returns [].
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

  // #733: resolve the caller's readable space set once — it gates both the
  // source page and the kNN candidates (mirrors scanAllDuplicates and the
  // rag-service retrieval filters).
  const accessibleSpaces = await getUserAccessibleSpaces(userId);

  // Get the source page id and title for title similarity comparison
  const sourcePageResult = await query<{ id: number; title: string; space_key: string | null }>(
    'SELECT id, title, space_key FROM pages WHERE confluence_id = $1 AND deleted_at IS NULL',
    [confluenceId],
  );
  if (sourcePageResult.rows.length === 0) {
    return [];
  }
  const sourcePage = sourcePageResult.rows[0]!;
  // #733: a source page outside the caller's accessible spaces behaves
  // exactly like a nonexistent one — no existence oracle, no neighbor leak.
  if (!sourcePage.space_key || !accessibleSpaces.includes(sourcePage.space_key)) {
    return [];
  }
  const sourceTitle = sourcePage.title;
  const sourcePageId = sourcePage.id;

  // Use a dedicated client for SET LOCAL
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL hnsw.ef_search = ${RAG_EF_SEARCH}`);

    // Find nearest neighbors using pgvector kNN on the average embedding
    const result = await client.query<{
      id: number;
      confluence_id: string | null;
      title: string;
      space_key: string;
      distance: number;
    }>(
      // Dedup on the page PK, not confluence_id: standalone pages have
      // confluence_id IS NULL and Postgres DISTINCT ON treats NULLs as equal,
      // so keying on confluence_id collapses every standalone candidate into a
      // single row. cp2.id is always non-null and unique per page.
      // The inner DISTINCT ON picks each candidate page's single nearest chunk,
      // which forces its ORDER BY to lead with cp2.id. We must therefore re-sort
      // the deduped rows by distance in an OUTER query before applying LIMIT —
      // otherwise LIMIT keeps the lowest-id pages instead of the nearest ones,
      // and a near-duplicate whose id sorts past the cap is silently dropped
      // before the distance-threshold filter runs (#866).
      `WITH source_avg AS (
         SELECT AVG(embedding) AS avg_embedding
         FROM page_embeddings
         WHERE page_id = $1
       )
       SELECT id, confluence_id, title, space_key, distance
       FROM (
         SELECT DISTINCT ON (cp2.id)
           cp2.id,
           cp2.confluence_id,
           cp2.title,
           cp2.space_key,
           pe2.embedding <=> source_avg.avg_embedding AS distance
         FROM page_embeddings pe2
         JOIN pages cp2 ON pe2.page_id = cp2.id,
         source_avg
         WHERE pe2.page_id != $1
           AND source_avg.avg_embedding IS NOT NULL
           AND cp2.deleted_at IS NULL
           AND ${visiblePagesPredicate(3, 4, 'cp2')}
         ORDER BY cp2.id, pe2.embedding <=> source_avg.avg_embedding
       ) candidates
       ORDER BY distance
       LIMIT $2`,
      // #733: over-fetch to filter later; candidates restricted to the same
      // retrieval scope as rag-service (accessible Confluence spaces +
      // shared / own-private standalone articles).
      [sourcePageId, limit * 3, accessibleSpaces, userId],
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
        id: row.id,
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
  const pages = await query<{ id: number; confluence_id: string; title: string }>(
    `SELECT DISTINCT cp.id, cp.confluence_id, cp.title
     FROM pages cp
     JOIN page_embeddings pe ON pe.page_id = cp.id
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
        // Avoid reporting A->B and B->A. Key on the stable page PKs — standalone
        // pages have a NULL confluenceId, which would otherwise collide.
        const pairKey = [page.id, dup.id].sort((a, b) => a - b).join(':');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        allPairs.push({
          page1: {
            sourceId: page.confluence_id,
            id: page.id,
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
