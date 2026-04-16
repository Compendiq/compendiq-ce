import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Build a Fastify preHandler that enforces a global (action-level) RBAC
 * permission. Admins bypass. Users without the permission receive a 403
 * with a deterministic error shape.
 *
 * Example: `requireGlobalPermission('llm:query')` gates an LLM route.
 *
 * Granular permission IDs (e.g. `llm:query`, `sync:trigger`) are plain
 * strings stored in `roles.permissions TEXT[]` — no whitelist enforced at
 * runtime. The seed list in `permission_definitions` (overlay migration
 * 063) exists for UI discovery, not for validation here.
 */
export function requireGlobalPermission(permission: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const allowed = await request.userCan(permission, 'global');
    if (!allowed) {
      reply.status(403).send({
        error: 'Forbidden',
        message: `Permission "${permission}" required`,
        statusCode: 403,
      });
    }
  };
}
