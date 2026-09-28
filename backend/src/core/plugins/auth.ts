import fp from 'fastify-plugin';
import { FastifyInstance, FastifyRequest } from 'fastify';
import * as jose from 'jose';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { getPool, query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { userHasPermission, userHasGlobalPermission } from '../services/rbac-service.js';
import { enterRbacScope } from '../services/rbac-request-scope.js';
import { logAuditEvent } from '../services/audit-service.js';
import { getUserSecurityState } from '../services/user-security-cache.js';

const JWT_ISSUER = 'compendiq';
const CONFIGURED_ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY ?? '1h';
// Validate expiry format at startup — jose accepts: Ns, Nm, Nh, Nd
const ACCESS_TOKEN_EXPIRY_MATCH = /^(\d+)([smhd])$/.exec(CONFIGURED_ACCESS_TOKEN_EXPIRY);
if (!ACCESS_TOKEN_EXPIRY_MATCH) {
  throw new Error(
    `Invalid ACCESS_TOKEN_EXPIRY format: "${CONFIGURED_ACCESS_TOKEN_EXPIRY}". Expected format: <number><s|m|h|d> (e.g., "1h", "30m", "7d")`,
  );
}
// #737: cap the access-token lifetime at 24h. The lifetime is the worst-case
// window a deactivated/demoted account keeps API access if every faster
// invalidation layer (user-security cache + cache-bus) failed, so it must
// not be effectively unbounded (the old regex admitted e.g. '999d').
// Over-cap values are CLAMPED with a loud warning rather than failing boot
// (#756 review) — '48h' or '7d' were valid configs before the cap, and an
// unattended upgrade must not take an existing deployment down. An invalid
// FORMAT still fails fast above.
const EXPIRY_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400 };
const MAX_ACCESS_TOKEN_EXPIRY_SECONDS = 24 * 3_600;
const ACCESS_TOKEN_EXPIRY =
  Number(ACCESS_TOKEN_EXPIRY_MATCH[1]) * EXPIRY_UNIT_SECONDS[ACCESS_TOKEN_EXPIRY_MATCH[2]!]! >
  MAX_ACCESS_TOKEN_EXPIRY_SECONDS
    ? '24h'
    : CONFIGURED_ACCESS_TOKEN_EXPIRY;
if (ACCESS_TOKEN_EXPIRY !== CONFIGURED_ACCESS_TOKEN_EXPIRY) {
  logger.warn(
    { configured: CONFIGURED_ACCESS_TOKEN_EXPIRY, effective: ACCESS_TOKEN_EXPIRY },
    `SECURITY: ACCESS_TOKEN_EXPIRY "${CONFIGURED_ACCESS_TOKEN_EXPIRY}" exceeds the 24h cap — clamping to 24h. ` +
      'The access-token lifetime bounds how long a deactivated or demoted account could keep API access ' +
      'if every faster revocation layer failed (#737); use the 7-day refresh token for session longevity instead.',
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

export interface RotatedRefreshSession {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    username: string;
    role: 'user' | 'admin';
    email: string | null;
    displayName: string | null;
  };
}

/**
 * The user-row lock or a statement inside the session transaction hit its
 * deadline. The transaction rolled back, so nothing was consumed or revoked.
 */
export class RefreshSessionBusyError extends Error {
  constructor() {
    super('Refresh session is busy');
    this.name = 'RefreshSessionBusyError';
  }
}

// Session-row lock holders only run a few indexed statements plus one JWT
// signature, so these deadlines are only reached when the database is stuck.
// They keep a request from waiting indefinitely behind the new lock.
const SESSION_LOCK_TIMEOUT = '5s';
const SESSION_STATEMENT_TIMEOUT = '10s';
const LOCK_NOT_AVAILABLE = '55P03';
const QUERY_CANCELED = '57014';

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
 * Generates a refresh token for a new token family (login, registration,
 * setup, OIDC). Rotation inside an existing family goes through
 * rotateRefreshToken(), which consumes the old JTI in the same transaction.
 */
export async function generateRefreshToken(
  payload: JwtPayload,
): Promise<{ token: string; jti: string; family: string }> {
  const refresh = await signRefreshToken(payload, randomUUID());

  // Store the JTI in the database
  await query(
    `INSERT INTO refresh_tokens (user_id, jti, family, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [payload.sub, refresh.jti, refresh.family, refresh.expiresAt],
  );

  return { token: refresh.token, jti: refresh.jti, family: refresh.family };
}

async function signRefreshToken(
  payload: JwtPayload,
  family: string,
): Promise<{ token: string; jti: string; family: string; expiresAt: Date }> {
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  const token = await new jose.SignJWT({
    username: payload.username,
    role: payload.role,
    jti,
    family,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuer(JWT_ISSUER)
    .setExpirationTime('7d')
    .sign(getJwtSecret());
  return { token, jti, family, expiresAt };
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

async function decodeRefreshToken(token: string): Promise<RefreshTokenPayload> {
  const { payload } = await jose.jwtVerify(token, getJwtSecret(), {
    issuer: JWT_ISSUER,
  });

  const jti = payload.jti as string;
  const family = payload.family as string;

  if (!jti || !family) {
    throw new Error('Refresh token missing JTI or family');
  }

  return {
    sub: payload.sub as string,
    username: payload.username as string,
    role: payload.role as 'user' | 'admin',
    jti,
    family,
  };
}

async function reportRefreshTokenReuse(payload: RefreshTokenPayload): Promise<void> {
  logger.warn(
    { jti: payload.jti, family: payload.family, userId: payload.sub },
    'Refresh token reuse detected - revoking entire family',
  );
  // #307 Finding #5: emit SESSION_REVOKED so the Authentication
  // compliance report can surface session-hijack events. Use
  // `reason: 'token_reuse_detected'` (distinct from `'logout'`) so the
  // report can separate voluntary logouts from forced revocations.
  // logAuditEvent is try/catch-wrapped internally so an audit failure
  // never suppresses the caller's security-response throw.
  await logAuditEvent(
    payload.sub,
    'SESSION_REVOKED',
    'user',
    payload.sub,
    { reason: 'token_reuse_detected', family: payload.family, jti: payload.jti },
  );
}

interface SessionUserRow {
  id: string;
  username: string;
  role: 'user' | 'admin';
  email: string | null;
  display_name: string | null;
  deactivated_at: Date | null;
}

/**
 * Runs `work` in one transaction that holds the user's row lock. Every
 * refresh-token mutation that must not interleave with successor issuance
 * (rotation, reuse-driven family revocation, logout) takes this lock. Admin
 * role changes, deactivation and deletion conflict with it implicitly: they
 * UPDATE/DELETE the same users row and remove refresh_tokens in that
 * transaction. `FOR NO KEY UPDATE` still admits foreign-key inserts that
 * reference the user from unrelated tables.
 *
 * Lock waits and statements are deadline-bounded; hitting a deadline rolls
 * back and surfaces RefreshSessionBusyError.
 */
async function withUserSessionLock<T>(
  userId: string,
  work: (client: PoolClient, user: SessionUserRow | undefined) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  let releaseError: Error | undefined;
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)`,
      [SESSION_LOCK_TIMEOUT, SESSION_STATEMENT_TIMEOUT],
    );
    const locked = await client.query<SessionUserRow>(
      `SELECT id, username, role, email, display_name, deactivated_at
         FROM users
        WHERE id = $1
          FOR NO KEY UPDATE`,
      [userId],
    );
    const result = await work(client, locked.rows[0]);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // A connection that cannot roll back must not return to the pool.
      releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    const code = (error as { code?: unknown } | null)?.code;
    if (code === LOCK_NOT_AVAILABLE || code === QUERY_CANCELED) {
      throw new RefreshSessionBusyError();
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

/**
 * Verifies a refresh token and checks JTI validity against the database.
 * Returns the full payload including JTI and family. A read-only check for
 * logout; rotation must use rotateRefreshToken(), never verify + revoke +
 * generate.
 */
export async function verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
  const payload = await decodeRefreshToken(token);

  // Check if JTI exists and is not revoked
  const result = await query<{ revoked: boolean }>(
    'SELECT revoked FROM refresh_tokens WHERE jti = $1',
    [payload.jti],
  );

  if (result.rows.length === 0) {
    throw new Error('Refresh token JTI not found');
  }

  if (result.rows[0]!.revoked) {
    // Reuse detection: revoked token used again = security breach
    // Revoke the entire token family
    await revokeTokenFamily(payload.family);
    await reportRefreshTokenReuse(payload);
    throw new Error('Refresh token reuse detected - family revoked');
  }

  return payload;
}

type RotationOutcome =
  | { kind: 'rotated'; session: RotatedRefreshSession }
  | { kind: 'reuse' }
  | { kind: 'rejected'; reason: string };

/**
 * Single-use refresh-token rotation. Under the user's row lock it claims the
 * presented JTI with a conditional `UPDATE ... WHERE revoked = FALSE
 * RETURNING` and inserts the same-family successor before the same COMMIT.
 * A request that loses the claim (concurrent or sequential replay) follows
 * the reuse policy: the whole family is revoked in that transaction and the
 * call rejects. Because family revocation, logout, role changes and
 * deactivation serialize on the same row, a successor can never be inserted
 * after one of them has committed.
 */
export async function rotateRefreshToken(token: string): Promise<RotatedRefreshSession> {
  const payload = await decodeRefreshToken(token);

  const outcome = await withUserSessionLock<RotationOutcome>(payload.sub, async (client, user) => {
    if (!user) return { kind: 'rejected', reason: 'User not found' };

    if (user.deactivated_at) {
      // Revoke the presented JTI so a later reactivation cannot silently
      // reuse it (PR #311 Finding #3).
      await client.query(
        'UPDATE refresh_tokens SET revoked = TRUE WHERE jti = $1 AND user_id = $2',
        [payload.jti, payload.sub],
      );
      return { kind: 'rejected', reason: 'Account is deactivated' };
    }

    const claimed = await client.query(
      `UPDATE refresh_tokens
          SET revoked = TRUE
        WHERE jti = $1 AND user_id = $2 AND family = $3 AND revoked = FALSE
        RETURNING jti`,
      [payload.jti, payload.sub, payload.family],
    );
    if (claimed.rowCount === 0) {
      const existing = await client.query(
        'SELECT 1 FROM refresh_tokens WHERE jti = $1 AND user_id = $2 AND family = $3',
        [payload.jti, payload.sub, payload.family],
      );
      if (existing.rowCount === 0) return { kind: 'rejected', reason: 'Refresh token JTI not found' };
      await client.query(
        'UPDATE refresh_tokens SET revoked = TRUE WHERE family = $1 AND user_id = $2',
        [payload.family, payload.sub],
      );
      return { kind: 'reuse' };
    }

    const claims: JwtPayload = { sub: user.id, username: user.username, role: user.role };
    const successor = await signRefreshToken(claims, payload.family);
    await client.query(
      `INSERT INTO refresh_tokens (user_id, jti, family, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [user.id, successor.jti, successor.family, successor.expiresAt],
    );
    return {
      kind: 'rotated',
      session: {
        accessToken: await generateAccessToken(claims),
        refreshToken: successor.token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          email: user.email,
          displayName: user.display_name,
        },
      },
    };
  });

  if (outcome.kind === 'rotated') return outcome.session;
  if (outcome.kind === 'reuse') {
    await reportRefreshTokenReuse(payload);
    throw new Error('Refresh token reuse detected - family revoked');
  }
  throw new Error(outcome.reason);
}

/**
 * Marks a specific JTI as revoked (logout).
 */
export async function revokeToken(jti: string): Promise<void> {
  await query('UPDATE refresh_tokens SET revoked = TRUE WHERE jti = $1', [jti]);
}

/**
 * Runs a revocation UPDATE under the owner's row lock so a concurrent
 * rotation cannot insert a successor that the UPDATE's snapshot would miss.
 * If the lock stays unavailable past its deadline, the UPDATE still runs
 * without it: a revocation must not be skipped because the users row was
 * busy (only a successor committed later by that same lock holder could then
 * escape, as before the lock existed).
 */
async function revokeUnderUserLock(userId: string, sql: string, params: unknown[]): Promise<void> {
  try {
    await withUserSessionLock(userId, async (client) => {
      await client.query(sql, params);
    });
  } catch (error) {
    if (!(error instanceof RefreshSessionBusyError)) throw error;
    logger.warn({ userId }, 'Refresh token revocation ran without the session lock after a lock timeout');
    await query(sql, params);
  }
}

/**
 * Revokes all tokens in a family (security breach response), serialized with
 * rotation on the owner's row lock.
 */
export async function revokeTokenFamily(family: string): Promise<void> {
  const owner = await query<{ user_id: string }>(
    'SELECT user_id FROM refresh_tokens WHERE family = $1 LIMIT 1',
    [family],
  );
  const userId = owner.rows[0]?.user_id;
  if (!userId) return;
  await revokeUnderUserLock(
    userId,
    'UPDATE refresh_tokens SET revoked = TRUE WHERE family = $1 AND user_id = $2',
    [family, userId],
  );
}

/**
 * Revokes all refresh tokens for a user (logout), serialized with rotation
 * on the user's row lock.
 */
export async function revokeAllUserTokens(userId: string): Promise<void> {
  await revokeUnderUserLock(userId, 'UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [userId]);
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
      // Open the request-scoped AsyncLocalStorage frame BEFORE the first await
      // so RBAC space-resolution is memoised for the rest of this request. It
      // must be entered synchronously here: `enterWith` only propagates the
      // store to continuations descending from the current frame, so entering
      // it after an await would leave the route handler without the scope and
      // the memo dead at runtime (#899). `userId` is filled in below once auth
      // succeeds; the empty-userId window is safe (getScopedSpaces gates on a
      // matching userId). See ADR-022.
      const rbacScope = enterRbacScope();

      const token = authHeader.slice(7);
      const payload = await verifyToken(token);

      // #737: cached liveness/role check so deactivation, hard-delete and
      // role changes take effect on already-issued access tokens within
      // USER_SECURITY_CACHE_TTL_MS (30s; immediate on pods that receive the
      // cache-bus invalidation) instead of the full token lifetime. On the
      // hot path this is a Map lookup — the DB is consulted at most once
      // per user per TTL window. 'unknown' (DB lookup failed with nothing
      // cached) soft-fails to the token claims so a transient DB blip
      // cannot 401 every in-flight session.
      const security = await getUserSecurityState(payload.sub);
      if (security.kind === 'deactivated' || security.kind === 'missing') {
        throw new Error(`User account is ${security.kind === 'missing' ? 'deleted' : 'deactivated'}`);
      }
      if (security.kind === 'active' && security.role !== payload.role) {
        // Stale privilege claim (demoted or promoted since issuance) —
        // reject so the client re-authenticates and gets a token whose
        // role matches the DB. Role changes also revoke refresh tokens
        // (admin-user-service), so a demoted admin must log in again.
        throw new Error('Token role no longer matches the user record');
      }

      request.userId = payload.sub;
      request.username = payload.username;
      request.userRole = payload.role;

      // Now that authentication has succeeded, bind the user to the scope
      // opened at the top of this hook so downstream RBAC lookups memoise.
      rbacScope.userId = payload.sub;

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
