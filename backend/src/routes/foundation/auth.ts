import { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import { RegisterSchema, LoginSchema } from '@compendiq/contracts';
import { query } from '../../core/db/postgres.js';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  revokeToken,
  revokeAllUserTokens,
  cleanupExpiredTokens,
} from '../../core/plugins/auth.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';

const SALT_ROUNDS = 12;
const REFRESH_COOKIE = 'kb_refresh';
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

import { getRateLimits } from '../../core/services/rate-limit-service.js';

// Rate limit config for auth endpoints (dynamic via admin settings, default 5/min)
const AUTH_RATE_LIMIT = { config: { rateLimit: { max: async () => (await getRateLimits()).auth.max, timeWindow: '1 minute' } } };

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/register', AUTH_RATE_LIMIT, async (request, reply) => {
    const body = RegisterSchema.parse(request.body);
    const email = body.email?.trim().toLowerCase() ?? null;
    const displayName = body.displayName?.trim() ?? null;

    const passwordHash = await bcrypt.hash(body.password, SALT_ROUNDS);

    try {
      // Atomic first-user-is-admin: the role is determined in the same INSERT
      // to avoid a TOCTOU race between SELECT COUNT and INSERT
      const result = await query<{ id: string; username: string; role: string; email: string | null; display_name: string | null }>(
        `INSERT INTO users (username, password_hash, role, email, display_name)
         VALUES ($1, $2, CASE WHEN (SELECT COUNT(*) FROM users) = 0 THEN 'admin' ELSE 'user' END, $3, $4)
         RETURNING id, username, role, email, display_name`,
        [body.username, passwordHash, email, displayName],
      );
      const user = result.rows[0]!;

      // Create default user_settings row
      await query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.id]);

      const accessToken = await generateAccessToken({
        sub: user.id,
        username: user.username,
        role: user.role as 'user' | 'admin',
      });
      const { token: refreshToken } = await generateRefreshToken({
        sub: user.id,
        username: user.username,
        role: user.role as 'user' | 'admin',
      });

      await logAuditEvent(user.id, 'REGISTER', 'user', user.id, { username: user.username }, request);

      reply
        .setCookie(REFRESH_COOKIE, refreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          path: '/api/auth',
          maxAge: REFRESH_MAX_AGE,
        })
        .status(201)
        .send({
          accessToken,
          user: {
            id: user.id,
            username: user.username,
            role: user.role,
            email: user.email,
            displayName: user.display_name,
          },
        });
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
        const detail = (err as { detail?: string }).detail ?? '';
        if (detail.includes('email')) {
          throw fastify.httpErrors.conflict('Email already in use');
        }
        throw fastify.httpErrors.conflict('Username already taken');
      }
      throw err;
    }
  });

  fastify.post('/login', AUTH_RATE_LIMIT, async (request, reply) => {
    const body = LoginSchema.parse(request.body);

    const result = await query<{
      id: string;
      username: string;
      password_hash: string;
      role: string;
      email: string | null;
      display_name: string | null;
      deactivated_at: Date | null;
    }>(
      'SELECT id, username, password_hash, role, email, display_name, deactivated_at FROM users WHERE username = $1',
      [body.username],
    );

    if (result.rows.length === 0) {
      await logAuditEvent(null, 'LOGIN_FAILED', 'user', undefined, { username: body.username, reason: 'user_not_found' }, request);
      throw fastify.httpErrors.unauthorized('Invalid username or password');
    }

    const user = result.rows[0]!;
    const valid = await bcrypt.compare(body.password, user.password_hash);
    if (!valid) {
      await logAuditEvent(user.id, 'LOGIN_FAILED', 'user', user.id, { reason: 'invalid_password' }, request);
      throw fastify.httpErrors.unauthorized('Invalid username or password');
    }

    // Deactivated users are rejected (#304). The response message stays
    // generic to avoid account-enumeration via the error string.
    if (user.deactivated_at) {
      await logAuditEvent(
        user.id,
        'LOGIN_FAILED',
        'user',
        user.id,
        { reason: 'deactivated' },
        request,
      );
      throw fastify.httpErrors.unauthorized('Account is deactivated — contact an administrator');
    }

    const accessToken = await generateAccessToken({
      sub: user.id,
      username: user.username,
      role: user.role as 'user' | 'admin',
    });
    const { token: refreshToken } = await generateRefreshToken({
      sub: user.id,
      username: user.username,
      role: user.role as 'user' | 'admin',
    });

    // Stamp last_login_at (#307 P0a). Fire-and-forget — audit emission
    // + session creation must not be blocked on this write. Wrapped in an
    // IIFE + try/catch so unit-test mocks that return undefined here don't
    // surface `Cannot read properties of undefined (reading 'catch')`.
    (async () => {
      try {
        await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
      } catch (err) {
        logger.warn({ err, userId: user.id }, 'Failed to update users.last_login_at');
      }
    })();

    await logAuditEvent(
      user.id,
      'LOGIN',
      'user',
      user.id,
      { auth_method: 'local' },
      request,
    );
    await logAuditEvent(
      user.id,
      'SESSION_CREATED',
      'user',
      user.id,
      { auth_method: 'local' },
      request,
    );

    reply
      .setCookie(REFRESH_COOKIE, refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/api/auth',
        maxAge: REFRESH_MAX_AGE,
      })
      .send({
        accessToken,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          email: user.email,
          displayName: user.display_name,
        },
      });
  });

  fastify.post('/refresh', async (request, reply) => {
    const refreshTokenCookie = request.cookies[REFRESH_COOKIE];
    if (!refreshTokenCookie) {
      throw fastify.httpErrors.unauthorized('No refresh token');
    }

    try {
      // Verify token and check JTI in database (handles reuse detection)
      const payload = await verifyRefreshToken(refreshTokenCookie);

      // Verify user still exists AND is active. The deactivation flow already
      // DELETEs refresh_tokens rows so the JTI check above would normally
      // fail first, but re-reading `deactivated_at` here is defence in depth
      // for any future path that surfaces a valid JTI (race with token
      // issue, EE SSO re-issue, bug in the revocation flow). See PR #311
      // Finding #3.
      const result = await query<{
        id: string;
        username: string;
        role: string;
        email: string | null;
        display_name: string | null;
        deactivated_at: Date | null;
      }>(
        'SELECT id, username, role, email, display_name, deactivated_at FROM users WHERE id = $1',
        [payload.sub],
      );
      if (result.rows.length === 0) {
        throw fastify.httpErrors.unauthorized('User not found');
      }

      const user = result.rows[0]!;
      if (user.deactivated_at) {
        // Revoke the JTI we just verified so a subsequent reactivation
        // can't silently reuse the same refresh token.
        await revokeToken(payload.jti).catch(() => {});
        throw fastify.httpErrors.unauthorized('Account is deactivated');
      }

      // Token rotation: revoke old JTI
      await revokeToken(payload.jti);

      // Issue new tokens (same family)
      const accessToken = await generateAccessToken({
        sub: user.id,
        username: user.username,
        role: user.role as 'user' | 'admin',
      });
      const { token: newRefreshToken } = await generateRefreshToken(
        {
          sub: user.id,
          username: user.username,
          role: user.role as 'user' | 'admin',
        },
        payload.family, // Same family for rotation tracking
      );

      await logAuditEvent(user.id, 'TOKEN_REFRESH', 'user', user.id, {}, request);

      reply
        .setCookie(REFRESH_COOKIE, newRefreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          path: '/api/auth',
          maxAge: REFRESH_MAX_AGE,
        })
        .send({
          accessToken,
          user: {
            id: user.id,
            username: user.username,
            role: user.role,
            email: user.email,
            displayName: user.display_name,
          },
        });
    } catch (err) {
      logger.debug({ err }, 'Refresh token verification failed');
      throw fastify.httpErrors.unauthorized('Invalid refresh token');
    }
  });

  fastify.post('/logout', async (request, reply) => {
    let userId: string | null = null;

    // Try to extract user ID from Bearer token first
    try {
      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const { verifyToken } = await import('../../core/plugins/auth.js');
        const payload = await verifyToken(authHeader.slice(7));
        userId = payload.sub;
      }
    } catch {
      // Access token expired or invalid — fall through to refresh cookie
    }

    // Fallback: extract user ID from the refresh token cookie (handles expired access tokens)
    if (!userId) {
      try {
        const refreshTokenCookie = request.cookies[REFRESH_COOKIE];
        if (refreshTokenCookie) {
          const payload = await verifyRefreshToken(refreshTokenCookie);
          userId = payload.sub;
          // Also revoke this specific JTI since we verified it
          await revokeToken(payload.jti);
        }
      } catch {
        // Refresh token also invalid — nothing to revoke
      }
    }

    // Revoke all tokens for the identified user
    if (userId) {
      try {
        await revokeAllUserTokens(userId);
        await logAuditEvent(userId, 'LOGOUT', 'user', userId, {}, request);
        await logAuditEvent(
          userId,
          'SESSION_REVOKED',
          'user',
          userId,
          { reason: 'logout' },
          request,
        );
      } catch {
        // Best effort
      }
    }

    reply
      .clearCookie(REFRESH_COOKIE, { path: '/api/auth' })
      .send({ message: 'Logged out' });
  });

  // Cleanup job endpoint for expired tokens (admin only)
  fastify.post('/cleanup-tokens', {
    preHandler: fastify.requireAdmin,
  }, async () => {
    const deleted = await cleanupExpiredTokens();
    return { message: `Cleaned up ${deleted} expired tokens` };
  });
}
