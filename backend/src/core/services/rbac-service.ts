import { query } from '../db/postgres.js';
import { getRedisClient } from './redis-cache.js';
import { logger } from '../utils/logger.js';
import { getScopedSpaces, setScopedSpaces } from './rbac-request-scope.js';

const RBAC_CACHE_TTL = 60; // 60 seconds

// ── Cache helpers ───────────────────────────────────────────────────────────

function permsCacheKey(userId: string, spaceKey: string): string {
  return `rbac:perms:${userId}:${spaceKey}`;
}

function spacesAccessCacheKey(userId: string): string {
  return `rbac:spaces:${userId}`;
}

function adminCacheKey(userId: string): string {
  return `rbac:admin:${userId}`;
}

function globalPermsCacheKey(userId: string): string {
  return `rbac:global:${userId}`;
}

async function getCached<T>(key: string): Promise<T | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const data = await redis.get(key);
    if (!data) return null;
    return JSON.parse(data) as T;
  } catch (err) {
    logger.error({ err, key }, 'RBAC cache get error');
    return null;
  }
}

async function setCache(key: string, data: unknown, ttl = RBAC_CACHE_TTL): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.setEx(key, ttl, JSON.stringify(data));
  } catch (err) {
    logger.error({ err, key }, 'RBAC cache set error');
  }
}

/**
 * Invalidate all RBAC cache entries for a user.
 * Called when any role/group/ACE write occurs.
 */
export async function invalidateRbacCache(userId?: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    const pattern = userId ? `rbac:*:${userId}*` : 'rbac:*';
    let cursor = '0';
    do {
      const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = String(result.cursor);
      if (result.keys.length > 0) {
        await redis.del(result.keys);
      }
    } while (cursor !== '0');
    logger.debug({ userId, pattern }, 'RBAC cache invalidated');
  } catch (err) {
    logger.error({ err, userId }, 'RBAC cache invalidation error');
  }
}

// ── Admin check ─────────────────────────────────────────────────────────────

/**
 * Check if a user has system admin role.
 * Cached in Redis for RBAC_CACHE_TTL.
 */
export async function isSystemAdmin(userId: string): Promise<boolean> {
  const cacheKey = adminCacheKey(userId);
  const cached = await getCached<boolean>(cacheKey);
  if (cached !== null) return cached;

  const adminCheck = await query(
    `SELECT 1 FROM users u WHERE u.id = $1 AND u.role = 'admin'`,
    [userId],
  );
  const isAdmin = adminCheck.rows.length > 0;
  await setCache(cacheKey, isAdmin);
  return isAdmin;
}

// ── Permission check ────────────────────────────────────────────────────────

/**
 * Check whether a user has a specific permission, optionally scoped to a space.
 *
 * Resolution order:
 *  1. System admin bypass (users.role = 'admin') -- always grants all permissions.
 *  2. Page-level ACE (if page has inherit_perms = false).
 *  3. Direct user assignment in space_role_assignments.
 *  4. Group-based assignment via group_memberships + space_role_assignments.
 *
 * Results are cached in Redis with TTL of 60s.
 */
export async function userHasPermission(
  userId: string,
  permission: string,
  spaceKey?: string,
  pageId?: number,
): Promise<boolean> {
  // System admin bypass
  if (await isSystemAdmin(userId)) return true;

  if (!spaceKey) return false;

  // Check page-level ACE override if pageId is provided
  if (pageId) {
    const pageCheck = await query<{ inherit_perms: boolean }>(
      'SELECT inherit_perms FROM pages WHERE id = $1',
      [pageId],
    );
    if (pageCheck.rows.length > 0 && !pageCheck.rows[0]!.inherit_perms) {
      // Page has custom ACEs -- check them. `group_memberships.user_id` is
      // UUID, so cast $2 inline; principal_id is TEXT and compared raw.
      const aceCheck = await query<{ permission: string }>(
        `SELECT ace.permission FROM access_control_entries ace
         WHERE ace.resource_type = 'page' AND ace.resource_id = $1
           AND (
             (ace.principal_type = 'user' AND ace.principal_id = $2)
             OR (ace.principal_type = 'group' AND ace.principal_id ~ '^\\d+$'
                 AND ace.principal_id::INTEGER IN (
               SELECT group_id FROM group_memberships WHERE user_id = $2::uuid
             ))
           )`,
        [pageId, userId],
      );
      for (const row of aceCheck.rows) {
        if (row.permission === permission) return true;
      }
      return false; // Page has custom ACEs but user doesn't have the requested permission
    }
  }

  // Check cached space-level permissions
  const cacheKey = permsCacheKey(userId, spaceKey);
  const cached = await getCached<string[]>(cacheKey);
  if (cached !== null) {
    return cached.includes(permission);
  }

  // Build the full permissions set for this user in this space
  const permissions = new Set<string>();

  // Check direct user assignment
  const directCheck = await query<{ permissions: string[] }>(
    `SELECT r.permissions FROM space_role_assignments sra
     JOIN roles r ON r.id = sra.role_id
     WHERE sra.space_key = $1 AND sra.principal_type = 'user' AND sra.principal_id = $2`,
    [spaceKey, userId],
  );

  for (const row of directCheck.rows) {
    for (const p of row.permissions) permissions.add(p);
  }

  // Check group-based assignments
  const groupCheck = await query<{ permissions: string[] }>(
    `SELECT r.permissions FROM space_role_assignments sra
     JOIN roles r ON r.id = sra.role_id
     JOIN group_memberships gm ON (sra.principal_id ~ '^\\d+$' AND gm.group_id = sra.principal_id::INTEGER)
     WHERE sra.space_key = $1 AND sra.principal_type = 'group'
       AND gm.user_id = $2`,
    [spaceKey, userId],
  );

  for (const row of groupCheck.rows) {
    for (const p of row.permissions) permissions.add(p);
  }

  // Cache the full permission set
  const permsArray = Array.from(permissions);
  await setCache(cacheKey, permsArray);

  return permissions.has(permission);
}

/**
 * Check whether a user has a specific permission in ANY space (global check).
 *
 * Used for action-level permissions that aren't tied to a specific resource,
 * e.g. `llm:query`, `llm:generate`, `sync:trigger`. If the user holds the
 * permission via any role assignment (direct or group-based) in any space,
 * this returns true.
 *
 * System admins always pass. Results are cached in Redis for 60s under
 * `rbac:global:<userId>`. Cache is flushed by `invalidateRbacCache(userId)`.
 *
 * NOTE: Granular permission IDs are plain strings stored in `roles.permissions
 * TEXT[]`. No whitelist — the caller picks the ID. Validity against
 * `permission_definitions` is enforced only when roles are created/updated
 * (see `overlay/.../rbac-extensions-service.validatePermissions`).
 */
export async function userHasGlobalPermission(
  userId: string,
  permission: string,
): Promise<boolean> {
  // System admin bypass
  if (await isSystemAdmin(userId)) return true;

  // Check cache — single flattened permission set across all spaces for this user
  const cacheKey = globalPermsCacheKey(userId);
  const cached = await getCached<string[]>(cacheKey);
  if (cached !== null) {
    return cached.includes(permission);
  }

  const permissions = new Set<string>();

  // Direct user assignments across all spaces
  const directCheck = await query<{ permissions: string[] }>(
    `SELECT r.permissions
     FROM space_role_assignments sra
     JOIN roles r ON r.id = sra.role_id
     WHERE sra.principal_type = 'user' AND sra.principal_id = $1`,
    [userId],
  );
  for (const row of directCheck.rows) {
    for (const p of row.permissions) permissions.add(p);
  }

  // Group-based assignments across all spaces
  const groupCheck = await query<{ permissions: string[] }>(
    `SELECT r.permissions
     FROM space_role_assignments sra
     JOIN roles r ON r.id = sra.role_id
     JOIN group_memberships gm ON (sra.principal_id ~ '^\\d+$' AND gm.group_id = sra.principal_id::INTEGER)
     WHERE sra.principal_type = 'group' AND gm.user_id = $1`,
    [userId],
  );
  for (const row of groupCheck.rows) {
    for (const p of row.permissions) permissions.add(p);
  }

  const permsArray = Array.from(permissions);
  await setCache(cacheKey, permsArray);

  return permissions.has(permission);
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
       OR (sra.principal_type = 'group' AND sra.principal_id ~ '^\\d+$'
           AND sra.principal_id::INTEGER IN (
         SELECT group_id FROM group_memberships WHERE user_id = $2
       ))
     )
     ORDER BY array_length(r.permissions, 1) DESC
     LIMIT 1`,
    [spaceKey, userId],
  );
  return result.rows[0]?.name ?? null;
}

// ── Space access ────────────────────────────────────────────────────────────

/**
 * Get all space keys a user has access to via RBAC space_role_assignments.
 * System admins get all spaces.
 * Results are cached in Redis with TTL of 60s.
 *
 * NOTE: This does NOT query user_space_selections. That table stores the
 * user's Confluence sync preferences (which spaces to sync), NOT access
 * control. RBAC space access is determined solely by space_role_assignments.
 */
export async function getUserAccessibleSpaces(userId: string): Promise<string[]> {
  const cacheKey = spacesAccessCacheKey(userId);
  const admin = await isSystemAdmin(userId);
  if (!admin) {
    const cached = await getCached<string[]>(cacheKey);
    if (cached !== null) return cached;
  }

  // Query RBAC assignments only (direct user + group-based)
  // Guard the ::int cast with a regex check to prevent crash when
  // principal_id contains a non-numeric value (e.g. UUID for user rows).
  const result = await query<{ space_key: string }>(
    `SELECT DISTINCT sra.space_key
     FROM space_role_assignments sra
     JOIN roles r ON sra.role_id = r.id
     WHERE (sra.principal_type = 'user' AND sra.principal_id = $1)
        OR (sra.principal_type = 'group' AND sra.principal_id ~ '^\\d+$'
            AND sra.principal_id::int IN (
            SELECT group_id FROM group_memberships WHERE user_id = $1::uuid
        ))`,
    [userId],
  );

  const assignedSpaces = result.rows.map((r) => r.space_key);

  if (!admin) {
    await setCache(cacheKey, assignedSpaces);
    return assignedSpaces;
  }

  // Admins can access all known synced/local spaces, but must also retain
  // explicit assignments for newly selected spaces before their first sync.
  const allSpaces = await query<{ space_key: string }>(
    'SELECT DISTINCT space_key FROM spaces WHERE space_key IS NOT NULL',
  );
  const spaceKeys = Array.from(
    new Set([
      ...assignedSpaces,
      ...allSpaces.rows.map((r) => r.space_key),
    ]),
  );

  await setCache(cacheKey, spaceKeys);
  return spaceKeys;
}

/**
 * Request-scoped wrapper around `getUserAccessibleSpaces`. Callers that run
 * inside a Fastify request (entered via `enterRbacScope` from the auth plugin)
 * pay at most one resolver hit per request, regardless of how many retrieval
 * paths consult the readable-space set. Outside a scope (workers, tests that
 * do not opt in) this falls through to the normal resolver with no change in
 * behaviour.
 *
 * Signature matches `getUserAccessibleSpaces` exactly so call sites can swap
 * the import without touching the call site.
 */
export async function getUserAccessibleSpacesMemoized(userId: string): Promise<string[]> {
  const scoped = getScopedSpaces(userId);
  if (scoped) return scoped;
  const spaces = await getUserAccessibleSpaces(userId);
  setScopedSpaces(spaces);
  return spaces;
}

/**
 * Check if a user has access to a specific page based on RBAC and page-level ACEs.
 * Handles both confluence and standalone pages.
 */
export async function userCanAccessPage(
  userId: string,
  pageId: number,
): Promise<boolean> {
  // System admin bypass
  if (await isSystemAdmin(userId)) return true;

  // Get the page's space key, source, and visibility
  const pageResult = await query<{
    space_key: string | null;
    source: string;
    visibility: string | null;
    created_by_user_id: string | null;
    inherit_perms: boolean;
  }>(
    `SELECT space_key, source, visibility, created_by_user_id, inherit_perms FROM pages WHERE id = $1 AND deleted_at IS NULL`,
    [pageId],
  );

  if (pageResult.rows.length === 0) return false;
  const page = pageResult.rows[0]!;

  // Standalone pages: check visibility rules
  if (page.source === 'standalone') {
    if (page.visibility === 'shared') return true;
    if (page.visibility === 'private' && page.created_by_user_id === userId) return true;
    return false;
  }

  // Page-level ACE override
  if (!page.inherit_perms) {
    // `group_memberships.user_id` is UUID; `access_control_entries.principal_id`
    // is TEXT (it stores either a user UUID string or a group id string). Pass
    // userId as text once and cast inline to UUID for the group-membership
    // join so PostgreSQL picks the right operator in both branches.
    const aceCheck = await query(
      `SELECT 1 FROM access_control_entries ace
       WHERE ace.resource_type = 'page' AND ace.resource_id = $1
         AND (
           (ace.principal_type = 'user' AND ace.principal_id = $2)
           OR (ace.principal_type = 'group' AND ace.principal_id ~ '^\\d+$'
               AND ace.principal_id::INTEGER IN (
             SELECT group_id FROM group_memberships WHERE user_id = $2::uuid
           ))
         )
       LIMIT 1`,
      [pageId, userId],
    );
    return aceCheck.rows.length > 0;
  }

  // Space-level access check for confluence pages
  if (!page.space_key) return false;
  const accessibleSpaces = await getUserAccessibleSpaces(userId);
  return accessibleSpaces.includes(page.space_key);
}
