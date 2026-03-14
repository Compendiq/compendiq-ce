import { query } from '../db/postgres.js';

/**
 * Check whether a user has a specific permission, optionally scoped to a space.
 *
 * Resolution order:
 *  1. System admin bypass (users.role = 'admin') — always grants all permissions.
 *  2. Direct user assignment in space_role_assignments.
 *  3. Group-based assignment via group_memberships + space_role_assignments.
 */
export async function userHasPermission(
  userId: string,
  permission: string,
  spaceKey?: string,
): Promise<boolean> {
  // System admin bypass — the existing users.role column is authoritative
  const adminCheck = await query(
    `SELECT 1 FROM users u WHERE u.id = $1 AND u.role = 'admin'`,
    [userId],
  );
  if (adminCheck.rows.length > 0) return true;

  if (!spaceKey) return false;

  // Check direct user assignment
  const directCheck = await query<{ permissions: string[] }>(
    `SELECT r.permissions FROM space_role_assignments sra
     JOIN roles r ON r.id = sra.role_id
     WHERE sra.space_key = $1 AND sra.principal_type = 'user' AND sra.principal_id = $2`,
    [spaceKey, userId],
  );

  for (const row of directCheck.rows) {
    if (row.permissions.includes(permission)) return true;
  }

  // Check group-based assignments
  const groupCheck = await query<{ permissions: string[] }>(
    `SELECT r.permissions FROM space_role_assignments sra
     JOIN roles r ON r.id = sra.role_id
     JOIN group_memberships gm ON gm.group_id = sra.principal_id::INTEGER AND sra.principal_type = 'group'
     WHERE sra.space_key = $1 AND gm.user_id = $2`,
    [spaceKey, userId],
  );

  for (const row of groupCheck.rows) {
    if (row.permissions.includes(permission)) return true;
  }

  return false;
}

/**
 * Returns the highest-privilege role name the user holds in a given space,
 * determined by the role with the most permissions.
 * Returns null if the user has no role in the space.
 */
export async function getUserSpaceRole(
  userId: string,
  spaceKey: string,
): Promise<string | null> {
  const result = await query<{ name: string }>(
    `SELECT r.name FROM space_role_assignments sra
     JOIN roles r ON r.id = sra.role_id
     WHERE sra.space_key = $1 AND (
       (sra.principal_type = 'user' AND sra.principal_id = $2)
       OR (sra.principal_type = 'group' AND sra.principal_id::INTEGER IN (
         SELECT group_id FROM group_memberships WHERE user_id = $2
       ))
     )
     ORDER BY array_length(r.permissions, 1) DESC
     LIMIT 1`,
    [spaceKey, userId],
  );
  return result.rows[0]?.name ?? null;
}
