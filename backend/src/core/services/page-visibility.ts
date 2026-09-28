/**
 * Caller-bound SQL fragments that decide which `pages` rows a user may read.
 * Call sites bind accessible-space keys and the user id at the given parameter
 * indexes. `deleted_at` filtering stays at the call site (trash views differ).
 * Parameter indexes are numbers and the alias is a compile-time constant, so
 * no caller data is interpolated.
 */

/**
 * The space-level list definition: Confluence pages in the caller's accessible
 * spaces, shared standalone pages, and the caller's own private standalone
 * pages. It deliberately ignores page restrictions.
 */
function spaceLevelVisibility(spacesParamIdx: number, userParamIdx: number, alias: string, confluenceArm: string): string {
  return `(
        (${alias}.source = 'confluence' AND ${alias}.space_key = ANY($${spacesParamIdx}::text[])${confluenceArm})
        OR (${alias}.source = 'standalone' AND ${alias}.visibility = 'shared')
        OR (${alias}.source = 'standalone' AND ${alias}.visibility = 'private' AND ${alias}.created_by_user_id = $${userParamIdx})
      )`;
}

/**
 * Pages a user may read on every NON-RAG surface (lists, trees, hierarchy,
 * search, graphs, counts, pins, LLM page context, …).
 *
 * The space-level list definition plus the page-restriction arm
 * `userCanAccessPage` applies: a Confluence page with `inherit_perms = FALSE`
 * additionally requires a page ACE naming the caller directly or through a
 * group. System administrators are exempt from that arm only, so their
 * listings keep restricted pages but still exclude other users' private
 * standalone pages. Standalone pages ignore `inherit_perms`, exactly as
 * `userCanAccessPage` does.
 *
 * The user parameter is typed `uuid` (the `created_by_user_id` column type)
 * and compared to the TEXT `principal_id` through an explicit cast. A group
 * principal is cast to INTEGER only inside a CASE, so a non-numeric
 * principal can never reach the cast regardless of qual ordering.
 */
export function visiblePagesPredicate(spacesParamIdx: number, userParamIdx: number, alias = 'cp'): string {
  const user = `$${userParamIdx}::uuid`;
  const restrictionArm = `
          AND (${alias}.inherit_perms
            OR EXISTS (
              SELECT 1 FROM users restriction_admin
               WHERE restriction_admin.id = ${user} AND restriction_admin.role = 'admin'
            )
            OR EXISTS (
              SELECT 1 FROM access_control_entries restriction_ace
               WHERE restriction_ace.resource_type = 'page'
                 AND restriction_ace.resource_id = ${alias}.id
                 AND (
                   (restriction_ace.principal_type = 'user'
                     AND restriction_ace.principal_id = (${user})::text)
                   OR (restriction_ace.principal_type = 'group'
                     AND (CASE WHEN restriction_ace.principal_id ~ '^[0-9]{1,9}$'
                               THEN restriction_ace.principal_id::integer END) IN (
                       SELECT restriction_membership.group_id
                         FROM group_memberships restriction_membership
                        WHERE restriction_membership.user_id = ${user}
                     ))
                 )
            ))`;
  return spaceLevelVisibility(spacesParamIdx, userParamIdx, alias, restrictionArm);
}

/**
 * RAG retrieval visibility: the space-level list definition WITHOUT the
 * page-restriction arm. Only RAG retrieval may use it: the vector and keyword
 * legs, lexical chunk resolution, the identifier pin (and its excerpt), and
 * the embedding-coverage denominator that describes that same corpus.
 * Shadow comparison and the production benchmark reach it through those legs.
 *
 * ADR-022/ADR-023 keep page restrictions out of retrieval SQL on purpose:
 * CE retrieval is space-level by design, and with the Enterprise
 * `rag_permission_enforcement` flag the fused candidates are post-filtered
 * through `filterAccessiblePages`. Changing this fragment changes RAG
 * behaviour in both editions; use `visiblePagesPredicate` everywhere else.
 */
export function ragRetrievalPagesPredicate(spacesParamIdx: number, userParamIdx: number, alias = 'cp'): string {
  return spaceLevelVisibility(spacesParamIdx, userParamIdx, alias, '');
}
