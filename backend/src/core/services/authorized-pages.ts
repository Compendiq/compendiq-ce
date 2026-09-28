import { query } from '../db/postgres.js';
import { visiblePagesPredicate } from './page-visibility.js';
import { getUserAccessibleSpacesMemoized } from './rbac-service.js';

/**
 * Resolve the live page ids a caller may read on non-RAG surfaces.
 *
 * `visiblePagesPredicate` carries both the space-level list definition and
 * the page-restriction arm, so the returned set is exactly what lists, trees
 * and graphs show. Keeping the set explicit lets graph traversal remove
 * inaccessible vertices before per-hop ordering and limits are applied, and
 * lets single-page surfaces answer "not found" for a restricted page.
 */
export async function authorizedPageIds(
  userId: string,
  candidateIds?: readonly number[],
): Promise<Set<number>> {
  if (candidateIds && candidateIds.length === 0) return new Set();

  const spaces = await getUserAccessibleSpacesMemoized(userId);
  const values: unknown[] = [spaces, userId];
  const candidateClause = candidateIds ? 'AND cp.id = ANY($3::int[])' : '';
  if (candidateIds) values.push(candidateIds);

  const rows = await query<{ id: number }>(
    `SELECT cp.id
       FROM pages cp
      WHERE cp.deleted_at IS NULL
        AND ${visiblePagesPredicate(1, 2)}
        ${candidateClause}`,
    values,
  );

  return new Set(rows.rows.map((row) => row.id));
}
