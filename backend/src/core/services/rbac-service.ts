import { query } from '../db/postgres.js';
import { getRedisClient } from './redis-cache.js';
import { logger } from '../utils/logger.js';

/** TTL for cached permission checks (seconds). */
const PERMISSION_CACHE_TTL = 60; // 1 minute — short because role changes should take effect quickly

/**
 * Build a Redis key for a cached permission check result.
 */
function permissionCacheKey(userId: string, permission: string, spaceKey: string): string {
  return `rbac:perm:${userId}:${spaceKey}:${permission}`;
}

/**
 * Check whether a user has a specific permission, optionally scoped to a space.
 *
 * Resolution order:
 *  1. System admin bypass (users.role = 'admin') — always grants all permissions.
 *  2. Direct user assignment in space_role_assignments.
 *  3. Group-based assignment via group_memberships + space_role_assignments.
 *
 * Results are cached in Redis for PERMISSION_CACHE_TTL seconds to avoid
 * repeated DB hits on every request.
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

  // Check Redis cache first
  const redis = getRedisClient();
  const cacheKey = permissionCacheKey(userId, permission, spaceKey);
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached !== null) {
        return cached === '1';
      }
    } catch (err) {
      logger.warn({ err }, 'Redis cache read failed for permission check, falling back to DB');
    }
  }

  // Check direct user assignment
  const directCheck = await query<{ permissions: string[] }>(
    `SELECT r.permissions FROM space_role_assignments sra
     JOIN roles r ON r.id = sra.role_id
     WHERE sra.space_key = $1 AND sra.principal_type = 'user' AND sra.principal_id = $2`,
    [spaceKey, userId],
  );

  for (const row of directCheck.rows) {
    if (row.permissions.includes(permission)) {
      await cachePermissionResult(cacheKey, true);
      return true;
    }
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
    if (row.permissions.includes(permission)) {
      await cachePermissionResult(cacheKey, true);
      return true;
    }
  }

  await cachePermissionResult(cacheKey, false);
  return false;
}

/**
 * Cache a permission check result in Redis. Best-effort — failures are logged
 * but never propagated to callers.
 */
async function cachePermissionResult(cacheKey: string, granted: boolean): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.set(cacheKey, granted ? '1' : '0', { EX: PERMISSION_CACHE_TTL });
  } catch (err) {
    logger.warn({ err, cacheKey }, 'Redis cache write failed for permission check');
  }
}

/**
 * Invalidate all cached permission results for a user.
 * Call this when a user's roles or group memberships change.
 */
export async function invalidatePermissionCache(userId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    let cursor = '0';
    do {
      const result = await redis.scan(cursor, { MATCH: `rbac:perm:${userId}:*`, COUNT: 100 });
      cursor = String(result.cursor);
      if (result.keys.length > 0) {
        await redis.del(result.keys);
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to invalidate permission cache');
  }
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

/**
 * Returns all space keys the user can access via RBAC.
 *
 * Sources (UNION):
 *  1. Direct user assignments in space_role_assignments.
 *  2. Group-based assignments via group_memberships + space_role_assignments.
 *
 * NOTE: This does NOT query user_space_selections. That table stores the
 * user's Confluence sync preferences (which spaces to sync), NOT access
 * control. RBAC space access is determined solely by space_role_assignments.
 *
 * System admins (users.role = 'admin') bypass this entirely — callers should
 * check admin status separately before calling this function.
 */
export async function getUserAccessibleSpaces(userId: string): Promise<string[]> {
  const result = await query<{ space_key: string }>(
    `SELECT DISTINCT sra.space_key
     FROM space_role_assignments sra
     JOIN roles r ON sra.role_id = r.id
     WHERE (sra.principal_type = 'user' AND sra.principal_id = $1)
        OR (sra.principal_type = 'group' AND sra.principal_id::int IN (
            SELECT group_id FROM group_memberships WHERE user_id = $1::uuid
        ))`,
    [userId],
  );
  return result.rows.map((r) => r.space_key);
}
