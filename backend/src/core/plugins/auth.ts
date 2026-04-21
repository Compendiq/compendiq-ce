import fp from 'fastify-plugin';
import { FastifyInstance, FastifyRequest } from 'fastify';
import * as jose from 'jose';
import { randomUUID } from 'crypto';
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { userHasPermission, userHasGlobalPermission } from '../services/rbac-service.js';
import { enterRbacScope } from '../services/rbac-request-scope.js';
import { logAuditEvent } from '../services/audit-service.js';

const JWT_ISSUER = 'compendiq';
const ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY ?? '1h';
// Validate expiry format at startup — jose accepts: Ns, Nm, Nh, Nd
if (!/^\d+[smhd]$/.test(ACCESS_TOKEN_EXPIRY)) {
  throw new Error(
    `Invalid ACCESS_TOKEN_EXPIRY format: "${ACCESS_TOKEN_EXPIRY}". Expected format: <number><s|m|h|d> (e.g., "1h", "30m", "7d")`,
  );
}
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

interface JwtPayload {
  sub: string;
  username: string;
  role: 'user' | 'admin';
}

interface RefreshTokenPayload extends JwtPayload {
  jti: string;
  family: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    username: string;
    userRole: 'user' | 'admin';
    userCan: (permission: string, resourceType?: 'space' | 'page' | 'global', resourceId?: string | number) => Promise<boolean>;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
    requireAdmin: (request: FastifyRequest) => Promise<void>;
  }
}

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  return new TextEncoder().encode(secret);
}

export async function generateAccessToken(payload: JwtPayload): Promise<string> {
  return new jose.SignJWT({ username: payload.username, role: payload.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuer(JWT_ISSUER)
    .setExpirationTime(ACCESS_TOKEN_EXPIRY)
    .sign(getJwtSecret());
}

/**
 * Generates a refresh token with JTI and token family for rotation/revocation.
 * If family is not provided, creates a new token family (e.g., on login).
 */
export async function generateRefreshToken(
  payload: JwtPayload,
  family?: string,
): Promise<{ token: string; jti: string; family: string }> {
  const jti = randomUUID();
  const tokenFamily = family ?? randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const token = await new jose.SignJWT({
    username: payload.username,
    role: payload.role,
    jti,
    family: tokenFamily,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuer(JWT_ISSUER)
    .setExpirationTime('7d')
    .sign(getJwtSecret());

  // Store the JTI in the database
  await query(
    `INSERT INTO refresh_tokens (user_id, jti, family, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [payload.sub, jti, tokenFamily, expiresAt],
  );

  return { token, jti, family: tokenFamily };
}

export async function verifyToken(token: string): Promise<JwtPayload> {
  const { payload } = await jose.jwtVerify(token, getJwtSecret(), {
    issuer: JWT_ISSUER,
  });
  return {
    sub: payload.sub as string,
    username: payload.username as string,
    role: payload.role as 'user' | 'admin',
  };
}

/**
 * Verifies a refresh token and checks JTI validity against the database.
 * Returns the full payload including JTI and family.
 */
export async function verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
  const { payload } = await jose.jwtVerify(token, getJwtSecret(), {
    issuer: JWT_ISSUER,
  });

  const jti = payload.jti as string;
  const family = payload.family as string;

  if (!jti || !family) {
    throw new Error('Refresh token missing JTI or family');
  }

  // Check if JTI exists and is not revoked
  const result = await query<{ revoked: boolean }>(
    'SELECT revoked FROM refresh_tokens WHERE jti = $1',
    [jti],
  );

  if (result.rows.length === 0) {
    throw new Error('Refresh token JTI not found');
  }

  if (result.rows[0]!.revoked) {
    // Reuse detection: revoked token used again = security breach
    // Revoke the entire token family
    logger.warn({ jti, family, userId: payload.sub }, 'Refresh token reuse detected - revoking entire family');
    await revokeTokenFamily(family);
    throw new Error('Refresh token reuse detected - family revoked');
  }

  return {
    sub: payload.sub as string,
    username: payload.username as string,
    role: payload.role as 'user' | 'admin',
    jti,
    family,
  };
}

/**
 * Marks a specific JTI as revoked (used during token rotation).
 */
export async function revokeToken(jti: string): Promise<void> {
  await query('UPDATE refresh_tokens SET revoked = TRUE WHERE jti = $1', [jti]);
}

/**
 * Revokes all tokens in a family (security breach response).
 */
export async function revokeTokenFamily(family: string): Promise<void> {
  await query('UPDATE refresh_tokens SET revoked = TRUE WHERE family = $1', [family]);
}

/**
 * Revokes all refresh tokens for a user (logout).
 */
export async function revokeAllUserTokens(userId: string): Promise<void> {
  await query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [userId]);
}

/**
 * Cleans up expired tokens from the database.
 */
export async function cleanupExpiredTokens(): Promise<number> {
  const result = await query('DELETE FROM refresh_tokens WHERE expires_at < NOW()');
  return result.rowCount ?? 0;
}

export default fp(async (fastify: FastifyInstance) => {
  fastify.decorate('authenticate', async (request: FastifyRequest) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw fastify.httpErrors.unauthorized('Missing or invalid authorization header');
    }

    try {
      const token = authHeader.slice(7);
      const payload = await verifyToken(token);
      request.userId = payload.sub;
      request.username = payload.username;
      request.userRole = payload.role;

      // Open a request-scoped AsyncLocalStorage frame so RBAC space-resolution
      // is memoised for the rest of this request. `enterWith` binds the store
      // to the current async chain without requiring a callback, so the route
      // handler and every downstream hook inherit the scope automatically.
      // See ADR-022.
      enterRbacScope(request.userId);

      // Attach RBAC permission checker to request
      request.userCan = async (
        permission: string,
        resourceType?: 'space' | 'page' | 'global',
        resourceId?: string | number,
      ): Promise<boolean> => {
        // System admin bypasses all checks
        if (request.userRole === 'admin') return true;

        if (resourceType === 'page' && resourceId !== undefined) {
          const pageId = typeof resourceId === 'string' ? parseInt(resourceId, 10) : resourceId;
          // Look up the page's space_key for the space-level check
          const pageRow = await query<{ space_key: string | null }>(
            'SELECT space_key FROM pages WHERE id = $1 AND deleted_at IS NULL',
            [pageId],
          );
          const spaceKey = pageRow.rows[0]?.space_key ?? undefined;
          return userHasPermission(request.userId, permission, spaceKey, pageId);
        }

        if (resourceType === 'space' && resourceId !== undefined) {
          return userHasPermission(request.userId, permission, String(resourceId));
        }

        if (resourceType === 'global') {
          // Action-level permission (llm:query, sync:trigger, etc.) — resolves
          // true if the user holds the permission in ANY space assignment.
          return userHasGlobalPermission(request.userId, permission);
        }

        // Legacy default: space-scoped check without a space_key returns false
        // for non-admins (preserves behaviour of callers that predate granular).
        return userHasPermission(request.userId, permission);
      };
    } catch (err) {
      logger.debug({ err }, 'Token verification failed');
      throw fastify.httpErrors.unauthorized('Invalid or expired token');
    }
  });

  fastify.decorate('requireAdmin', async (request: FastifyRequest) => {
    // Audit every denied admin-access attempt, including unauthenticated ones
    // (#264). The audit write is `await`ed intentionally so tests aren't racey,
    // but `logAuditEvent` is try/catch-wrapped internally and "never blocks the
    // main operation" — a DB failure during audit-logging does NOT suppress the
    // 401/403 to the caller.
    //
    // Path A — authentication failure (missing/invalid Bearer). Only reached
    // when `requireAdmin` is the onRequest hook itself (see admin.ts:48). Routes
    // that register `addHook('onRequest', authenticate)` + `{ preHandler:
    // requireAdmin }` short-circuit inside `authenticate` before this decorator
    // runs — that case is covered by the onRequest chain's own 401 and is out
    // of scope for this decorator.
    try {
      await fastify.authenticate(request);
    } catch (err) {
      await logAuditEvent(
        null,
        'ADMIN_ACCESS_DENIED',
        'route',
        `${request.method} ${request.routeOptions.url ?? request.url}`,
        { decision: 'denied', reason: 'unauthenticated' },
        request,
      );
      throw err;
    }

    // Path B — authenticated but lacks the admin role.
    if (request.userRole !== 'admin') {
      await logAuditEvent(
        request.userId,
        'ADMIN_ACCESS_DENIED',
        'route',
        `${request.method} ${request.routeOptions.url ?? request.url}`,
        { decision: 'denied', reason: 'not_admin' },
        request,
      );
      throw fastify.httpErrors.forbidden('Admin access required');
    }
  });
});
