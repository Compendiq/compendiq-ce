/**
 * Admin CRUD routes for the Settings → Users admin page (#304).
 *
 * These routes are separate from rbac.ts (role assignment) and admin.ts
 * (general admin settings). They cover the user *lifecycle*:
 *   POST   /api/admin/users                create
 *   PUT    /api/admin/users/:id            update fields (role/email/name)
 *   POST   /api/admin/users/:id/deactivate soft-deactivate
 *   POST   /api/admin/users/:id/reactivate undo deactivation
 *   DELETE /api/admin/users/:id            hard delete
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AdminUserCreateSchema,
  AdminUserUpdateSchema,
  AdminUserDeactivateSchema,
} from '@compendiq/contracts';
import {
  createUser,
  updateUser,
  deactivateUser,
  reactivateUser,
  deleteUser,
  listUsers,
  getUser,
  AdminUserServiceError,
} from '../../core/services/admin-user-service.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { accountInvitation } from '../../core/services/email-templates.js';
import { sendEmail } from '../../core/services/email-service.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';
import { logger } from '../../core/utils/logger.js';

const ADMIN_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: async () => (await getRateLimits()).admin.max,
      timeWindow: '1 minute',
    },
  },
};

const IdParamSchema = z.object({ id: z.string().uuid() });

function mapServiceError(
  fastify: FastifyInstance,
  err: unknown,
): never {
  if (err instanceof AdminUserServiceError) {
    switch (err.code) {
      case 'NOT_FOUND':
        throw fastify.httpErrors.notFound(err.message);
      case 'USERNAME_TAKEN':
      case 'EMAIL_TAKEN':
        throw fastify.httpErrors.conflict(err.message);
      case 'SELF_FORBIDDEN':
        throw fastify.httpErrors.badRequest(err.message);
      case 'LAST_ADMIN':
        throw fastify.httpErrors.conflict(err.message);
    }
  }
  throw err;
}

export async function adminUsersRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/admin/users — richer view than rbac.ts:/api/users
  fastify.get(
    '/admin/users',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async () => {
      const users = await listUsers();
      return { users };
    },
  );

  // POST /api/admin/users — create
  fastify.post(
    '/admin/users',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const body = AdminUserCreateSchema.parse(request.body);
      try {
        const { user, temporaryPassword } = await createUser({
          username: body.username,
          email: body.email ?? null,
          displayName: body.displayName ?? null,
          role: body.role,
          password: body.password,
          generateRandomPassword: body.sendInvitation === true && !body.password,
        });

        await logAuditEvent(
          request.userId,
          'ADMIN_ACTION',
          'user',
          user.id,
          {
            event: 'user_created',
            subjectUserId: user.id,
            username: user.username,
            role: user.role,
            invited: body.sendInvitation === true,
          },
          request,
        );

        // Fire-and-forget invitation email. Failing to send does NOT fail
        // the request — the admin can still see the temp password in the
        // response when sendInvitation is set and no SMTP is configured.
        if (body.sendInvitation && user.email && temporaryPassword) {
          const frontendUrl = (process.env.FRONTEND_URL ?? '').split(',')[0]?.trim();
          const tpl = accountInvitation({
            recipientName: user.displayName ?? user.username,
            username: user.username,
            temporaryPassword,
            invitedByName: request.username,
            loginUrl: frontendUrl ? `${frontendUrl}/login` : undefined,
          });
          sendEmail(user.email, tpl.subject, tpl.html).catch((err) => {
            logger.warn({ err, userId: user.id }, 'admin-users: invitation email failed');
          });
        }

        reply.code(201);
        return {
          user,
          // Only return the temp password when we generated one AND there's
          // no email destination to send it to (falls back to manual copy).
          temporaryPassword:
            temporaryPassword && (!user.email || !body.sendInvitation)
              ? temporaryPassword
              : undefined,
        };
      } catch (err) {
        mapServiceError(fastify, err);
      }
    },
  );

  // PUT /api/admin/users/:id — update email / displayName / role
  fastify.put(
    '/admin/users/:id',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request) => {
      const { id } = IdParamSchema.parse(request.params);
      const patch = AdminUserUpdateSchema.parse(request.body);
      try {
        const user = await updateUser(id, {
          email: patch.email ?? undefined,
          displayName: patch.displayName ?? undefined,
          role: patch.role,
        });
        await logAuditEvent(
          request.userId,
          'ADMIN_ACTION',
          'user',
          id,
          {
            event: 'user_updated',
            subjectUserId: id,
            fields: Object.keys(patch),
          },
          request,
        );
        return user;
      } catch (err) {
        mapServiceError(fastify, err);
      }
    },
  );

  // POST /api/admin/users/:id/deactivate
  fastify.post(
    '/admin/users/:id/deactivate',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request) => {
      const { id } = IdParamSchema.parse(request.params);
      const body = AdminUserDeactivateSchema.parse(request.body ?? {});
      try {
        const user = await deactivateUser(id, {
          actorUserId: request.userId,
          reason: body.reason,
        });
        await logAuditEvent(
          request.userId,
          'ADMIN_ACTION',
          'user',
          id,
          {
            event: 'user_deactivated',
            subjectUserId: id,
            reason: body.reason ?? null,
          },
          request,
        );
        return user;
      } catch (err) {
        mapServiceError(fastify, err);
      }
    },
  );

  // POST /api/admin/users/:id/reactivate
  fastify.post(
    '/admin/users/:id/reactivate',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request) => {
      const { id } = IdParamSchema.parse(request.params);
      try {
        const user = await reactivateUser(id);
        await logAuditEvent(
          request.userId,
          'ADMIN_ACTION',
          'user',
          id,
          {
            event: 'user_reactivated',
            subjectUserId: id,
          },
          request,
        );
        return user;
      } catch (err) {
        mapServiceError(fastify, err);
      }
    },
  );

  // DELETE /api/admin/users/:id — hard delete
  fastify.delete(
    '/admin/users/:id',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const { id } = IdParamSchema.parse(request.params);
      // Load before delete so audit metadata has the original username.
      const existing = await getUser(id);
      try {
        await deleteUser(id, { actorUserId: request.userId });
      } catch (err) {
        mapServiceError(fastify, err);
      }
      await logAuditEvent(
        request.userId,
        'ADMIN_ACTION',
        'user',
        id,
        {
          event: 'user_deleted',
          subjectUserId: id,
          username: existing?.username ?? null,
        },
        request,
      );
      reply.code(204);
      return null;
    },
  );
}
