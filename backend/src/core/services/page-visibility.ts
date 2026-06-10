/**
 * SQL fragment selecting pages visible to a user: Confluence pages in their
 * accessible spaces, shared standalone pages, and their own private standalone
 * pages. Call sites bind accessible-space keys and the user id at the given
 * parameter indexes. `deleted_at` filtering stays at the call site (trash
 * views differ).
 */
export function visiblePagesPredicate(spacesParamIdx: number, userParamIdx: number, alias = 'cp'): string {
  return `(
        (${alias}.source = 'confluence' AND ${alias}.space_key = ANY($${spacesParamIdx}::text[]))
        OR (${alias}.source = 'standalone' AND ${alias}.visibility = 'shared')
        OR (${alias}.source = 'standalone' AND ${alias}.visibility = 'private' AND ${alias}.created_by_user_id = $${userParamIdx})
      )`;
}
