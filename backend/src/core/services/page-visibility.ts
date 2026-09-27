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

/**
 * Set-based equivalent of `userCanAccessPage` for hierarchy and metadata reads.
 *
 * Unlike `visiblePagesPredicate`, this includes the system-admin bypass and
 * honors non-inheriting Confluence page ACEs. Callers still supply the
 * inherited-space set because resolving it once is cheaper than repeating the
 * role joins for every candidate row.
 */
export function authorizedPagesPredicate(
  spacesParamIdx: number,
  userParamIdx: number,
  alias = 'cp',
): string {
  return `(
        EXISTS (
          SELECT 1 FROM users authority_admin
          WHERE authority_admin.id = $${userParamIdx}::uuid AND authority_admin.role = 'admin'
        )
        OR (${alias}.source = 'standalone' AND ${alias}.visibility = 'shared')
        OR (${alias}.source = 'standalone' AND ${alias}.visibility = 'private'
            AND ${alias}.created_by_user_id = $${userParamIdx}::uuid)
        OR (${alias}.source = 'confluence' AND (
          (${alias}.inherit_perms IS NOT FALSE
           AND ${alias}.space_key = ANY($${spacesParamIdx}::text[]))
          OR (${alias}.inherit_perms = FALSE AND EXISTS (
            SELECT 1
            FROM access_control_entries authority_ace
            WHERE authority_ace.resource_type = 'page'
              AND authority_ace.resource_id = ${alias}.id
              AND (
                (authority_ace.principal_type = 'user'
                 AND authority_ace.principal_id = $${userParamIdx}::text)
                OR (
                  authority_ace.principal_type = 'group'
                  AND authority_ace.principal_id ~ '^\\d+$'
                  AND authority_ace.principal_id::integer IN (
                    SELECT authority_membership.group_id
                    FROM group_memberships authority_membership
                    WHERE authority_membership.user_id = $${userParamIdx}::uuid
                  )
                )
              )
          ))
        ))
      )`;
}
