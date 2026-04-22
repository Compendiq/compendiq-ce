import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { invalidateRbacCache, userHasPermission, getUserAccessibleSpaces } from '../../core/services/rbac-service.js';
import { logAuditEvent } from '../../core/services/audit-service.js';

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

const PermissionCheckQuerySchema = z.object({
  permission: z.string().min(1),
  resourceType: z.enum(['space', 'page']).optional(),
  resourceId: z.string().min(1).optional(),
});

const AceBodySchema = z.object({
  resourceType: z.enum(['space', 'page']),
  resourceId: z.coerce.number().int().positive(),
  principalType: z.enum(['user', 'group']),
  principalId: z.string().min(1),
  permission: z.enum(['read', 'comment', 'edit', 'delete', 'manage']),
});

const AceDeleteParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const AceQueryParamSchema = z.object({
  resourceType: z.enum(['space', 'page']),
  resourceId: z.coerce.number().int().positive(),
});

const PageInheritPermsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const PageInheritPermsBodySchema = z.object({
  inheritPerms: z.boolean(),
});

import { getRateLimits } from '../../core/services/rate-limit-service.js';
// Rate limit config for RBAC admin endpoints (uses admin category)
const RBAC_RATE_LIMIT = { config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } } };

export async function rbacRoutes(fastify: FastifyInstance) {
  // ========================
  // User-accessible routes (authenticated, NOT admin-only)
  // These are registered directly so they only require fastify.authenticate,
  // NOT fastify.requireAdmin.
  // ========================

  // GET /api/permissions/check -- check if current user has a permission
  // Available to ALL authenticated users (used by frontend usePermission hook)
  fastify.get('/permissions/check', {
    onRequest: fastify.authenticate,
    ...RBAC_RATE_LIMIT,
  }, async (request) => {
    const { permission, resourceType, resourceId } = PermissionCheckQuerySchema.parse(request.query);

    // System admin always has all permissions
    if (request.userRole === 'admin') {
      return { allowed: true };
    }

    if (resourceType === 'page' && resourceId) {
      const pageId = parseInt(resourceId, 10);
      const pageRow = await query<{ space_key: string | null }>(
        'SELECT space_key FROM pages WHERE id = $1 AND deleted_at IS NULL',
        [pageId],
      );
      const spaceKey = pageRow.rows[0]?.space_key ?? undefined;
      const allowed = await userHasPermission(request.userId, permission, spaceKey, pageId);
      return { allowed };
    }

    if (resourceType === 'space' && resourceId) {
      const allowed = await userHasPermission(request.userId, permission, resourceId);
      return { allowed };
    }

    return { allowed: false };
  });

  // GET /api/permissions/spaces -- list spaces the current user can access via RBAC
  // Available to ALL authenticated users
  fastify.get('/permissions/spaces', {
    onRequest: fastify.authenticate,
    ...RBAC_RATE_LIMIT,
  }, async (request) => {
    // System admins can access all spaces -- return empty array to signal "no restriction"
    if (request.userRole === 'admin') {
      return { spaces: [], unrestricted: true };
    }
    const spaces = await getUserAccessibleSpaces(request.userId);
    return { spaces, unrestricted: false };
  });

  // ========================
  // Admin-only routes -- encapsulated via fastify.register so the onRequest
  // hook only applies to routes inside this closure, not the permission
  // check routes above.
  // ========================

  await fastify.register(async function adminRoutes(admin) {
    admin.addHook('onRequest', admin.requireAdmin);

    // ========================
    // Roles
    // ========================

    // GET /api/roles -- list all roles
    admin.get('/roles', RBAC_RATE_LIMIT, async () => {
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

    // GET /api/groups -- list groups with member count
    admin.get('/groups', RBAC_RATE_LIMIT, async () => {
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

    // POST /api/groups -- create group
    admin.post('/groups', RBAC_RATE_LIMIT, async (request, reply) => {
      const { name, description } = GroupBodySchema.parse(request.body);

      const result = await query<{ id: number; name: string; description: string | null; source: string; created_at: string }>(
        `INSERT INTO groups (name, description) VALUES ($1, $2)
         RETURNING id, name, description, source, created_at`,
        [name, description ?? null],
      );

      await invalidateRbacCache();
      const row = result.rows[0]!;
      await logAuditEvent(
        request.userId,
        'GROUP_CREATED',
        'group',
        String(row.id),
        { name: row.name },
        request,
      );
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

    // PATCH /api/groups/:id -- update group
    admin.patch('/groups/:id', RBAC_RATE_LIMIT, async (request) => {
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
        throw admin.httpErrors.notFound('Group not found');
      }

      await invalidateRbacCache();
      const row = result.rows[0]!;
      await logAuditEvent(
        request.userId,
        'GROUP_UPDATED',
        'group',
        String(row.id),
        { fields: Object.keys(body) },
        request,
      );
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        source: row.source,
        createdAt: row.created_at,
      };
    });

    // DELETE /api/groups/:id -- delete group
    admin.delete('/groups/:id', RBAC_RATE_LIMIT, async (request) => {
      const { id } = GroupIdParamSchema.parse(request.params);

      const result = await query('DELETE FROM groups WHERE id = $1 RETURNING id', [id]);

      if (result.rows.length === 0) {
        throw admin.httpErrors.notFound('Group not found');
      }

      await invalidateRbacCache();
      await logAuditEvent(
        request.userId,
        'GROUP_DELETED',
        'group',
        String(id),
        {},
        request,
      );
      return { message: 'Group deleted' };
    });

    // ========================
    // Group members
    // ========================

    // GET /api/groups/:id/members -- list members of a group
    admin.get('/groups/:id/members', RBAC_RATE_LIMIT, async (request) => {
      const { id } = GroupIdParamSchema.parse(request.params);

      // Verify group exists
      const groupCheck = await query('SELECT 1 FROM groups WHERE id = $1', [id]);
      if (groupCheck.rows.length === 0) {
        throw admin.httpErrors.notFound('Group not found');
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

    // POST /api/groups/:id/members -- add user to group
    admin.post('/groups/:id/members', RBAC_RATE_LIMIT, async (request, reply) => {
      const { id } = GroupIdParamSchema.parse(request.params);
      const { userId } = MemberBodySchema.parse(request.body);

      // Verify group exists
      const groupCheck = await query('SELECT 1 FROM groups WHERE id = $1', [id]);
      if (groupCheck.rows.length === 0) {
        throw admin.httpErrors.notFound('Group not found');
      }

      // Verify user exists
      const userCheck = await query('SELECT 1 FROM users WHERE id = $1', [userId]);
      if (userCheck.rows.length === 0) {
        throw admin.httpErrors.notFound('User not found');
      }

      try {
        await query(
          'INSERT INTO group_memberships (group_id, user_id) VALUES ($1, $2)',
          [id, userId],
        );
      } catch (err: unknown) {
        // Unique constraint violation = already a member
        if ((err as { code?: string }).code === '23505') {
          throw admin.httpErrors.conflict('User is already a member of this group');
        }
        throw err;
      }

      await invalidateRbacCache(userId);
      // Audit event (#307 P0c): group membership added.
      await logAuditEvent(
        request.userId,
        'GROUP_MEMBER_ADDED',
        'group',
        String(id),
        { subjectUserId: userId, groupId: id },
        request,
      );
      reply.status(201);
      return { message: 'User added to group' };
    });

    // DELETE /api/groups/:id/members/:userId -- remove user from group
    admin.delete('/groups/:id/members/:userId', RBAC_RATE_LIMIT, async (request) => {
      const { id, userId } = MemberRemoveParamSchema.parse(request.params);

      const result = await query(
        'DELETE FROM group_memberships WHERE group_id = $1 AND user_id = $2 RETURNING group_id',
        [id, userId],
      );

      if (result.rows.length === 0) {
        throw admin.httpErrors.notFound('Membership not found');
      }

      await invalidateRbacCache(userId);
      await logAuditEvent(
        request.userId,
        'GROUP_MEMBER_REMOVED',
        'group',
        String(id),
        { subjectUserId: userId, groupId: id },
        request,
      );
      return { message: 'User removed from group' };
    });

    // ========================
    // Space role assignments
    // ========================

    // GET /api/spaces/:key/roles -- list role assignments for a space
    admin.get('/spaces/:key/roles', RBAC_RATE_LIMIT, async (request) => {
      const { key } = SpaceKeyParamSchema.parse(request.params);

      const result = await query<{
        id: number;
        space_key: string;
        principal_type: string;
        principal_id: string;
        role_id: number;
        role_name: string;
        role_display_name: string;
        principal_name: string | null;
        created_at: string;
      }>(
        `SELECT sra.id, sra.space_key, sra.principal_type, sra.principal_id,
                sra.role_id, r.name AS role_name, r.display_name AS role_display_name,
                CASE
                  WHEN sra.principal_type = 'user' THEN (SELECT u.username FROM users u WHERE u.id = sra.principal_id::uuid)
                  WHEN sra.principal_type = 'group' THEN (SELECT g.name FROM groups g WHERE g.id = sra.principal_id::integer)
                END AS principal_name,
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
        principalName: r.principal_name,
        roleId: r.role_id,
        roleName: r.role_name,
        roleDisplayName: r.role_display_name,
        createdAt: r.created_at,
      }));
    });

    // POST /api/spaces/:key/roles -- assign role in space
    admin.post('/spaces/:key/roles', RBAC_RATE_LIMIT, async (request, reply) => {
      const { key } = SpaceKeyParamSchema.parse(request.params);
      const { principalType, principalId, roleId } = SpaceRoleBodySchema.parse(request.body);

      // Verify role exists
      const roleCheck = await query('SELECT 1 FROM roles WHERE id = $1', [roleId]);
      if (roleCheck.rows.length === 0) {
        throw admin.httpErrors.notFound('Role not found');
      }

      try {
        const result = await query<{ id: number; created_at: string }>(
          `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id, created_at`,
          [key, principalType, principalId, roleId],
        );

        await invalidateRbacCache();
        // Audit event (#307 P0c): space-scoped role assigned.
        await logAuditEvent(
          request.userId,
          'SPACE_ACCESS_GRANTED',
          'space',
          key,
          {
            spaceKey: key,
            principalType,
            principalId,
            roleId,
            assignmentId: result.rows[0]!.id,
          },
          request,
        );
        reply.status(201);
        return {
          id: result.rows[0]!.id,
          spaceKey: key,
          principalType,
          principalId,
          roleId,
          createdAt: result.rows[0]!.created_at,
        };
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') {
          throw admin.httpErrors.conflict(
            'A role assignment already exists for this principal in this space',
          );
        }
        throw err;
      }
    });

    // DELETE /api/spaces/:key/roles/:assignmentId -- remove role assignment
    admin.delete('/spaces/:key/roles/:assignmentId', RBAC_RATE_LIMIT, async (request) => {
      const { key, assignmentId } = SpaceRoleDeleteParamSchema.parse(request.params);

      const result = await query(
        'DELETE FROM space_role_assignments WHERE id = $1 AND space_key = $2 RETURNING id',
        [assignmentId, key],
      );

      if (result.rows.length === 0) {
        throw admin.httpErrors.notFound('Role assignment not found');
      }

      await logAuditEvent(
        request.userId,
        'SPACE_ACCESS_REVOKED',
        'space',
        key,
        { spaceKey: key, assignmentId },
        request,
      );

      await invalidateRbacCache();
      return { message: 'Role assignment removed' };
    });

    // ========================
    // Access Control Entries (ACEs)
    // ========================

    // GET /api/access-control -- list ACEs for a resource
    admin.get('/access-control', RBAC_RATE_LIMIT, async (request) => {
      const { resourceType, resourceId } = AceQueryParamSchema.parse(request.query);

      const result = await query<{
        id: number;
        resource_type: string;
        resource_id: number;
        principal_type: string;
        principal_id: string;
        permission: string;
        principal_name: string | null;
        created_at: string;
      }>(
        `SELECT ace.id, ace.resource_type, ace.resource_id, ace.principal_type, ace.principal_id,
                ace.permission,
                CASE
                  WHEN ace.principal_type = 'user' THEN (SELECT u.username FROM users u WHERE u.id = ace.principal_id::uuid)
                  WHEN ace.principal_type = 'group' THEN (SELECT g.name FROM groups g WHERE g.id = ace.principal_id::integer)
                END AS principal_name,
                ace.created_at
         FROM access_control_entries ace
         WHERE ace.resource_type = $1 AND ace.resource_id = $2
         ORDER BY ace.principal_type, ace.principal_id, ace.permission`,
        [resourceType, resourceId],
      );

      return result.rows.map((r) => ({
        id: r.id,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        principalType: r.principal_type,
        principalId: r.principal_id,
        principalName: r.principal_name,
        permission: r.permission,
        createdAt: r.created_at,
      }));
    });

    // POST /api/access-control -- create ACE
    admin.post('/access-control', RBAC_RATE_LIMIT, async (request, reply) => {
      const { resourceType, resourceId, principalType, principalId, permission } = AceBodySchema.parse(request.body);

      try {
        const result = await query<{ id: number; created_at: string }>(
          `INSERT INTO access_control_entries (resource_type, resource_id, principal_type, principal_id, permission)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, created_at`,
          [resourceType, resourceId, principalType, principalId, permission],
        );

        await invalidateRbacCache();
        await logAuditEvent(
          request.userId,
          'ACE_GRANTED',
          resourceType,
          String(resourceId),
          { principalType, principalId, permission, aceId: result.rows[0]!.id },
          request,
        );
        reply.status(201);
        return {
          id: result.rows[0]!.id,
          resourceType,
          resourceId,
          principalType,
          principalId,
          permission,
          createdAt: result.rows[0]!.created_at,
        };
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') {
          throw admin.httpErrors.conflict('This access control entry already exists');
        }
        throw err;
      }
    });

    // DELETE /api/access-control/:id -- delete ACE
    admin.delete('/access-control/:id', RBAC_RATE_LIMIT, async (request) => {
      const { id } = AceDeleteParamSchema.parse(request.params);

      const result = await query(
        'DELETE FROM access_control_entries WHERE id = $1 RETURNING id',
        [id],
      );

      if (result.rows.length === 0) {
        throw admin.httpErrors.notFound('Access control entry not found');
      }

      await invalidateRbacCache();
      await logAuditEvent(
        request.userId,
        'ACE_REVOKED',
        'ace',
        String(id),
        {},
        request,
      );
      return { message: 'Access control entry removed' };
    });

    // ========================
    // Page inherit_perms toggle
    // ========================

    // PUT /api/pages/:id/inherit-perms -- toggle page permission inheritance
    admin.put('/pages/:id/inherit-perms', RBAC_RATE_LIMIT, async (request) => {
      const { id } = PageInheritPermsSchema.parse(request.params);
      const { inheritPerms } = PageInheritPermsBodySchema.parse(request.body);

      const result = await query(
        'UPDATE pages SET inherit_perms = $1 WHERE id = $2 RETURNING id',
        [inheritPerms, id],
      );

      if (result.rows.length === 0) {
        throw admin.httpErrors.notFound('Page not found');
      }

      await invalidateRbacCache();
      return { message: inheritPerms ? 'Page now inherits space permissions' : 'Page now uses custom permissions' };
    });

    // ========================
    // Users list (for assigning to groups/spaces)
    // ========================

    // GET /api/users -- list all users (for admin assignment UIs)
    admin.get('/users', RBAC_RATE_LIMIT, async () => {
      const result = await query<{
        id: string;
        username: string;
        role: string;
        created_at: string;
      }>(
        'SELECT id, username, role, created_at FROM users ORDER BY username',
      );

      return result.rows.map((r) => ({
        id: r.id,
        username: r.username,
        role: r.role,
        createdAt: r.created_at,
      }));
    });
  }); // end admin routes register block
}
