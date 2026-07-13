import { query, getPool } from '../../../core/db/postgres.js';
import { getUserAccessibleSpacesMemoized as getUserAccessibleSpaces } from '../../../core/services/rbac-service.js';
import { visiblePagesPredicate } from '../../../core/services/page-visibility.js';

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
 * Scan all pages a user can read to find duplicate clusters.
 * Returns pairs of pages that are likely duplicates.
 *
 * #907: this used to loop over every candidate page and call `findDuplicates`
 * one at a time — N+1 RBAC lookups plus N separate kNN transactions, each
 * comparing against every chunk of every neighbour (O(N×M)). Instead we now
 * average each readable page's chunk embeddings once (`page_avgs`) and self-join
 * those per-page averages in a single pass, so a whole scan pays one resolver
 * hit and one SQL round trip. No `SET LOCAL hnsw.ef_search` is needed here: the
 * self-join computes exact pairwise distances over the averages rather than
 * probing the HNSW index.
 *
 * RBAC (#733): the CTE restricts both sides of every pair to what `userId` can
 * read (accessible Confluence spaces + shared / own-private standalone pages),
 * mirroring `findDuplicates`, so no pair can surface a page the caller can't see.
 */
export async function scanAllDuplicates(
  userId: string,
  options: {
    distanceThreshold?: number;
    maxPairsPerPage?: number;
  } = {},
): Promise<Array<{ page1: DuplicateCandidate & { sourceId: string | null }; page2: DuplicateCandidate }>> {
  const { distanceThreshold = 0.15, maxPairsPerPage = 3 } = options;

  // #907: resolve the caller's readable space set once for the whole scan.
  const accessibleSpaces = await getUserAccessibleSpaces(userId);

  // One pass: average each readable page's chunk embeddings, then self-join the
  // averages on a.page_id < b.page_id so every unordered pair within the
  // distance threshold is returned exactly once (no A->B / B->A dedup needed).
  const result = await query<{
    page1_id: number;
    page1_confluence_id: string | null;
    page1_title: string;
    page2_id: number;
    page2_confluence_id: string | null;
    page2_title: string;
    page2_space_key: string;
    distance: number;
  }>(
    `WITH page_avgs AS (
       SELECT cp.id AS page_id, cp.confluence_id, cp.title, cp.space_key,
              AVG(pe.embedding) AS avg_embedding
       FROM page_embeddings pe
       JOIN pages cp ON pe.page_id = cp.id
       WHERE cp.deleted_at IS NULL
         AND ${visiblePagesPredicate(1, 2, 'cp')}
       GROUP BY cp.id, cp.confluence_id, cp.title, cp.space_key
     )
     SELECT a.page_id AS page1_id, a.confluence_id AS page1_confluence_id, a.title AS page1_title,
            b.page_id AS page2_id, b.confluence_id AS page2_confluence_id, b.title AS page2_title,
            b.space_key AS page2_space_key,
            (a.avg_embedding <=> b.avg_embedding) AS distance
     FROM page_avgs a
     JOIN page_avgs b ON a.page_id < b.page_id
     WHERE (a.avg_embedding <=> b.avg_embedding) <= $3
     ORDER BY distance`,
    [accessibleSpaces, userId, distanceThreshold],
  );

  // Score each pair the same way findDuplicates does: 70% embedding similarity +
  // 30% title (Jaccard) similarity. Both metrics are symmetric, so the score is
  // independent of which member is treated as the "source" page1.
  const scored = result.rows.map((row) => {
    const titleSimilarity = tokenJaccardSimilarity(row.page1_title, row.page2_title);
    const combinedScore = (1 - row.distance) * 0.7 + titleSimilarity * 0.3;
    return { row, titleSimilarity, combinedScore };
  });
  // Best pairs first, so the per-page cap keeps the strongest matches.
  scored.sort((a, b) => b.combinedScore - a.combinedScore);

  // Cap how many pairs any single page may appear in (both members counted), so
  // a large near-identical cluster can't explode into O(k²) pairs.
  const perPageCount = new Map<number, number>();
  const allPairs: Array<{ page1: DuplicateCandidate & { sourceId: string | null }; page2: DuplicateCandidate }> = [];

  for (const { row, titleSimilarity, combinedScore } of scored) {
    const count1 = perPageCount.get(row.page1_id) ?? 0;
    const count2 = perPageCount.get(row.page2_id) ?? 0;
    if (count1 >= maxPairsPerPage || count2 >= maxPairsPerPage) continue;
    perPageCount.set(row.page1_id, count1 + 1);
    perPageCount.set(row.page2_id, count2 + 1);

    allPairs.push({
      page1: {
        sourceId: row.page1_confluence_id,
        id: row.page1_id,
        confluenceId: row.page1_confluence_id,
        title: row.page1_title,
        spaceKey: '', // page1 is the source side; distance/title are relative to it
        embeddingDistance: 0,
        titleSimilarity: 1,
        combinedScore,
      },
      page2: {
        id: row.page2_id,
        confluenceId: row.page2_confluence_id,
        title: row.page2_title,
        spaceKey: row.page2_space_key,
        embeddingDistance: row.distance,
        titleSimilarity,
        combinedScore,
      },
    });
  }

  return allPairs;
}

export { tokenJaccardSimilarity };
