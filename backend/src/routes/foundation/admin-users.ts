/**
 * Admin CRUD routes for the Users sub-tab of Settings → Access Control (#304).
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
import { vitestIntOr } from '../../core/utils/safe-int.js';

/**
 * Upper bound on the in-request invitation send (#1737). nodemailer's own
 * defaults (120 s connect, 30 s greeting, 600 s socket) exceed what front
 * proxies and load balancers allow: they commonly time out at 30 s or less
 * (30 s and 20 s defaults exist), and a cut-off request leaves the user
 * created with the generated password lost. 15 s stays clearly below that and
 * far above a healthy SMTP exchange. Expiry means "delivery not confirmed":
 * the password is returned. Fixed in production; Vitest may shorten it.
 */
export const INVITATION_SEND_TIMEOUT_MS = vitestIntOr('INVITATION_SEND_TIMEOUT_MS', 15_000);

const INVITATION_TIMED_OUT = Symbol('invitation-send-timed-out');

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
      case 'SYSTEM_USER_PROTECTED':
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

        // Invitation email, awaited (bounded) so a failed or unconfirmed
        // delivery is known before responding: only then does the admin get
        // the generated password back to hand over manually. Neither a
        // rejection nor the bound expiring fails the request.
        let invitationSent = false;
        if (body.sendInvitation && user.email && temporaryPassword) {
          const frontendUrl = (process.env.FRONTEND_URL ?? '').split(',')[0]?.trim();
          const tpl = accountInvitation({
            recipientName: user.displayName ?? user.username,
            username: user.username,
            temporaryPassword,
            invitedByName: request.username,
            loginUrl: frontendUrl ? `${frontendUrl}/login` : undefined,
          });
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const outcome = await Promise.race([
              sendEmail(user.email, tpl.subject, tpl.html),
              new Promise<typeof INVITATION_TIMED_OUT>((resolve) => {
                timer = setTimeout(() => resolve(INVITATION_TIMED_OUT), INVITATION_SEND_TIMEOUT_MS);
              }),
            ]);
            if (outcome === INVITATION_TIMED_OUT) {
              logger.warn({ userId: user.id }, 'admin-users: invitation email not confirmed in time');
            } else {
              invitationSent = outcome === true;
            }
          } catch (err) {
            logger.warn({ err, userId: user.id }, 'admin-users: invitation email failed');
          } finally {
            clearTimeout(timer);
          }
        }

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
            invitationSent,
          },
          request,
        );

        reply.code(201);
        return {
          user,
          // The generated password is returned exactly when the invitation
          // was not delivered (no email, SMTP off, send failed or timed out).
          temporaryPassword: temporaryPassword && !invitationSent ? temporaryPassword : undefined,
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
