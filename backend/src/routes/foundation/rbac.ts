import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { userHasPermission, getUserAccessibleSpaces, invalidatePermissionCache } from '../../core/services/rbac-service.js';

// ---- Zod schemas ----

const GroupBodySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

const GroupPatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
}).refine((d) => d.name !== undefined || d.description !== undefined, {
  message: 'At least one field must be provided',
});

const GroupIdParamSchema = z.object({ id: z.coerce.number().int().positive() });

const MemberBodySchema = z.object({
  userId: z.string().uuid(),
});

const MemberRemoveParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  userId: z.string().uuid(),
});

const SpaceKeyParamSchema = z.object({ key: z.string().min(1) });

const SpaceRoleBodySchema = z.object({
  principalType: z.enum(['user', 'group']),
  principalId: z.string().min(1),
  roleId: z.coerce.number().int().positive(),
});

const SpaceRoleDeleteParamSchema = z.object({
  key: z.string().min(1),
  assignmentId: z.coerce.number().int().positive(),
});

const PermissionCheckSchema = z.object({
  permission: z.string().min(1),
  spaceKey: z.string().min(1).optional(),
});

// Rate limit config for RBAC endpoints
const RBAC_RATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

export async function rbacRoutes(fastify: FastifyInstance) {
  // ========================
  // User-accessible routes (authenticated, NOT admin-only)
  // These are registered directly so they only require fastify.authenticate,
  // NOT fastify.requireAdmin.
  // ========================

  // POST /api/permissions/check — check if the current user has a specific permission
  // Available to ALL authenticated users (used by frontend usePermission hook)
  fastify.post('/permissions/check', {
    onRequest: fastify.authenticate,
    ...RBAC_RATE_LIMIT,
  }, async (request) => {
    const { permission, spaceKey } = PermissionCheckSchema.parse(request.body);
    const granted = await userHasPermission(request.userId, permission, spaceKey);
    return { granted };
  });

  // GET /api/permissions/spaces — list spaces the current user can access via RBAC
  // Available to ALL authenticated users
  fastify.get('/permissions/spaces', {
    onRequest: fastify.authenticate,
    ...RBAC_RATE_LIMIT,
  }, async (request) => {
    // System admins can access all spaces — return empty array to signal "no restriction"
    if (request.userRole === 'admin') {
      return { spaces: [], unrestricted: true };
    }
    const spaces = await getUserAccessibleSpaces(request.userId);
    return { spaces, unrestricted: false };
  });

  // ========================
  // Admin-only routes — encapsulated via fastify.register so the onRequest
  // hook only applies to routes inside this closure, not the permission
  // check routes above.
  // ========================

  await fastify.register(async function adminRoutes(adminFastify) {
    adminFastify.addHook('onRequest', adminFastify.requireAdmin);

    // ========================
    // Roles
    // ========================

    // GET /api/roles — list all roles
    adminFastify.get('/roles', RBAC_RATE_LIMIT, async () => {
      const result = await query<{
        id: number;
        name: string;
        display_name: string;
        is_system: boolean;
        permissions: string[];
        created_at: string;
      }>('SELECT id, name, display_name, is_system, permissions, created_at FROM roles ORDER BY id');

      return result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        displayName: r.display_name,
        isSystem: r.is_system,
        permissions: r.permissions,
        createdAt: r.created_at,
      }));
    });

    // ========================
    // Groups
    // ========================

    // GET /api/groups — list groups with member count
    adminFastify.get('/groups', RBAC_RATE_LIMIT, async () => {
      const result = await query<{
        id: number;
        name: string;
        description: string | null;
        source: string;
        member_count: string;
        created_at: string;
      }>(
        `SELECT g.id, g.name, g.description, g.source, COUNT(gm.user_id)::TEXT AS member_count, g.created_at
         FROM groups g
         LEFT JOIN group_memberships gm ON gm.group_id = g.id
         GROUP BY g.id
         ORDER BY g.name`,
      );

      return result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        source: r.source,
        memberCount: Number(r.member_count),
        createdAt: r.created_at,
      }));
    });

    // POST /api/groups — create group
    adminFastify.post('/groups', RBAC_RATE_LIMIT, async (request, reply) => {
      const { name, description } = GroupBodySchema.parse(request.body);

      const result = await query<{ id: number; name: string; description: string | null; source: string; created_at: string }>(
        `INSERT INTO groups (name, description) VALUES ($1, $2)
         RETURNING id, name, description, source, created_at`,
        [name, description ?? null],
      );

      const row = result.rows[0];
      reply.status(201);
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        source: row.source,
        memberCount: 0,
        createdAt: row.created_at,
      };
    });

    // PATCH /api/groups/:id — update group
    adminFastify.patch('/groups/:id', RBAC_RATE_LIMIT, async (request) => {
      const { id } = GroupIdParamSchema.parse(request.params);
      const body = GroupPatchSchema.parse(request.body);

      const setClauses: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      if (body.name !== undefined) {
        setClauses.push(`name = $${idx++}`);
        values.push(body.name);
      }
      if (body.description !== undefined) {
        setClauses.push(`description = $${idx++}`);
        values.push(body.description);
      }

      values.push(id);

      const result = await query<{ id: number; name: string; description: string | null; source: string; created_at: string }>(
        `UPDATE groups SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING id, name, description, source, created_at`,
        values,
      );

      if (result.rows.length === 0) {
        throw adminFastify.httpErrors.notFound('Group not found');
      }

      const row = result.rows[0];
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        source: row.source,
        createdAt: row.created_at,
      };
    });

    // DELETE /api/groups/:id — delete group
    adminFastify.delete('/groups/:id', RBAC_RATE_LIMIT, async (request) => {
      const { id } = GroupIdParamSchema.parse(request.params);

      const result = await query('DELETE FROM groups WHERE id = $1 RETURNING id', [id]);

      if (result.rows.length === 0) {
        throw adminFastify.httpErrors.notFound('Group not found');
      }

      return { message: 'Group deleted' };
    });

    // ========================
    // Group members
    // ========================

    // GET /api/groups/:id/members — list members of a group
    adminFastify.get('/groups/:id/members', RBAC_RATE_LIMIT, async (request) => {
      const { id } = GroupIdParamSchema.parse(request.params);

      // Verify group exists
      const groupCheck = await query('SELECT 1 FROM groups WHERE id = $1', [id]);
      if (groupCheck.rows.length === 0) {
        throw adminFastify.httpErrors.notFound('Group not found');
      }

      const result = await query<{
        user_id: string;
        username: string;
        source: string;
        created_at: string;
      }>(
        `SELECT gm.user_id, u.username, gm.source, gm.created_at
         FROM group_memberships gm
         JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = $1
         ORDER BY u.username`,
        [id],
      );

      return result.rows.map((r) => ({
        userId: r.user_id,
        username: r.username,
        source: r.source,
        joinedAt: r.created_at,
      }));
    });

    // POST /api/groups/:id/members — add user to group
    adminFastify.post('/groups/:id/members', RBAC_RATE_LIMIT, async (request, reply) => {
      const { id } = GroupIdParamSchema.parse(request.params);
      const { userId } = MemberBodySchema.parse(request.body);

      // Verify group exists
      const groupCheck = await query('SELECT 1 FROM groups WHERE id = $1', [id]);
      if (groupCheck.rows.length === 0) {
        throw adminFastify.httpErrors.notFound('Group not found');
      }

      // Verify user exists
      const userCheck = await query('SELECT 1 FROM users WHERE id = $1', [userId]);
      if (userCheck.rows.length === 0) {
        throw adminFastify.httpErrors.notFound('User not found');
      }

      try {
        await query(
          'INSERT INTO group_memberships (group_id, user_id) VALUES ($1, $2)',
          [id, userId],
        );
      } catch (err: unknown) {
        // Unique constraint violation = already a member
        if ((err as { code?: string }).code === '23505') {
          throw adminFastify.httpErrors.conflict('User is already a member of this group');
        }
        throw err;
      }

      // Group membership changed — invalidate cached permission checks for this user
      await invalidatePermissionCache(userId);

      reply.status(201);
      return { message: 'User added to group' };
    });

    // DELETE /api/groups/:id/members/:userId — remove user from group
    adminFastify.delete('/groups/:id/members/:userId', RBAC_RATE_LIMIT, async (request) => {
      const { id, userId } = MemberRemoveParamSchema.parse(request.params);

      const result = await query(
        'DELETE FROM group_memberships WHERE group_id = $1 AND user_id = $2 RETURNING group_id',
        [id, userId],
      );

      if (result.rows.length === 0) {
        throw adminFastify.httpErrors.notFound('Membership not found');
      }

      // Group membership changed — invalidate cached permission checks for this user
      await invalidatePermissionCache(userId);

      return { message: 'User removed from group' };
    });

    // ========================
    // Space role assignments
    // ========================

    // GET /api/spaces/:key/roles — list role assignments for a space
    adminFastify.get('/spaces/:key/roles', RBAC_RATE_LIMIT, async (request) => {
      const { key } = SpaceKeyParamSchema.parse(request.params);

      const result = await query<{
        id: number;
        space_key: string;
        principal_type: string;
        principal_id: string;
        role_id: number;
        role_name: string;
        role_display_name: string;
        created_at: string;
      }>(
        `SELECT sra.id, sra.space_key, sra.principal_type, sra.principal_id,
                sra.role_id, r.name AS role_name, r.display_name AS role_display_name,
                sra.created_at
         FROM space_role_assignments sra
         JOIN roles r ON r.id = sra.role_id
         WHERE sra.space_key = $1
         ORDER BY sra.principal_type, sra.principal_id`,
        [key],
      );

      return result.rows.map((r) => ({
        id: r.id,
        spaceKey: r.space_key,
        principalType: r.principal_type,
        principalId: r.principal_id,
        roleId: r.role_id,
        roleName: r.role_name,
        roleDisplayName: r.role_display_name,
        createdAt: r.created_at,
      }));
    });

    // POST /api/spaces/:key/roles — assign role in space
    adminFastify.post('/spaces/:key/roles', RBAC_RATE_LIMIT, async (request, reply) => {
      const { key } = SpaceKeyParamSchema.parse(request.params);
      const { principalType, principalId, roleId } = SpaceRoleBodySchema.parse(request.body);

      // Verify role exists
      const roleCheck = await query('SELECT 1 FROM roles WHERE id = $1', [roleId]);
      if (roleCheck.rows.length === 0) {
        throw adminFastify.httpErrors.notFound('Role not found');
      }

      try {
        const result = await query<{ id: number; created_at: string }>(
          `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id, created_at`,
          [key, principalType, principalId, roleId],
        );

        // Invalidate permission cache for the affected principal
        if (principalType === 'user') {
          await invalidatePermissionCache(principalId);
        }
        // For group assignments, invalidate all members' caches
        if (principalType === 'group') {
          const members = await query<{ user_id: string }>(
            'SELECT user_id FROM group_memberships WHERE group_id = $1',
            [principalId],
          );
          for (const member of members.rows) {
            await invalidatePermissionCache(member.user_id);
          }
        }

        reply.status(201);
        return {
          id: result.rows[0].id,
          spaceKey: key,
          principalType,
          principalId,
          roleId,
          createdAt: result.rows[0].created_at,
        };
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') {
          throw adminFastify.httpErrors.conflict(
            'A role assignment already exists for this principal in this space',
          );
        }
        throw err;
      }
    });

    // DELETE /api/spaces/:key/roles/:assignmentId — remove role assignment
    adminFastify.delete('/spaces/:key/roles/:assignmentId', RBAC_RATE_LIMIT, async (request) => {
      const { key, assignmentId } = SpaceRoleDeleteParamSchema.parse(request.params);

      // Fetch the assignment before deleting so we can invalidate the right caches
      const assignment = await query<{ principal_type: string; principal_id: string }>(
        'SELECT principal_type, principal_id FROM space_role_assignments WHERE id = $1 AND space_key = $2',
        [assignmentId, key],
      );

      const result = await query(
        'DELETE FROM space_role_assignments WHERE id = $1 AND space_key = $2 RETURNING id',
        [assignmentId, key],
      );

      if (result.rows.length === 0) {
        throw adminFastify.httpErrors.notFound('Role assignment not found');
      }

      // Invalidate permission cache for the affected principal
      if (assignment.rows.length > 0) {
        const { principal_type, principal_id } = assignment.rows[0];
        if (principal_type === 'user') {
          await invalidatePermissionCache(principal_id);
        }
        if (principal_type === 'group') {
          const members = await query<{ user_id: string }>(
            'SELECT user_id FROM group_memberships WHERE group_id = $1',
            [principal_id],
          );
          for (const member of members.rows) {
            await invalidatePermissionCache(member.user_id);
          }
        }
      }

      return { message: 'Role assignment removed' };
    });
  });
}
