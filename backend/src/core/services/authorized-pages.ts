import { query } from '../db/postgres.js';
import { visiblePagesPredicate } from './page-visibility.js';
import {
  filterAccessiblePages,
  getUserAccessibleSpacesMemoized,
} from './rbac-service.js';

/**
 * Resolve page ids through both visibility layers used by read APIs.
 *
 * The SQL predicate is the CE visibility boundary. The batched filter then
 * applies page-level ACEs supplied by the shared CE/EE RBAC contract. Keeping
 * the returned set explicit lets graph traversal remove inaccessible vertices
 * before per-hop ordering and limits are applied.
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

  return filterAccessiblePages(userId, rows.rows.map((row) => row.id));
}
