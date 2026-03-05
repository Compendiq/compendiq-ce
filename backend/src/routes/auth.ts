import { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import { RegisterSchema, LoginSchema } from '@kb-creator/contracts';
import { query } from '../db/postgres.js';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  revokeToken,
  revokeAllUserTokens,
  cleanupExpiredTokens,
} from '../plugins/auth.js';
import { logAuditEvent } from '../services/audit-service.js';
import { logger } from '../utils/logger.js';

const SALT_ROUNDS = 12;
const REFRESH_COOKIE = 'kb_refresh';
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

// Rate limit config for auth endpoints (5 requests per minute)
const AUTH_RATE_LIMIT = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/register', AUTH_RATE_LIMIT, async (request, reply) => {
    const body = RegisterSchema.parse(request.body);

    const passwordHash = await bcrypt.hash(body.password, SALT_ROUNDS);

    try {
      // Atomic first-user-is-admin: the role is determined in the same INSERT
      // to avoid a TOCTOU race between SELECT COUNT and INSERT
      const result = await query<{ id: string; username: string; role: string }>(
        `INSERT INTO users (username, password_hash, role)
         VALUES ($1, $2, CASE WHEN (SELECT COUNT(*) FROM users) = 0 THEN 'admin' ELSE 'user' END)
         RETURNING id, username, role`,
        [body.username, passwordHash],
      );
      const user = result.rows[0];

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
          user: { id: user.id, username: user.username, role: user.role },
        });
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
        throw fastify.httpErrors.conflict('Username already taken');
      }
      throw err;
    }
  });

  fastify.post('/login', AUTH_RATE_LIMIT, async (request, reply) => {
    const body = LoginSchema.parse(request.body);

    const result = await query<{ id: string; username: string; password_hash: string; role: string }>(
      'SELECT id, username, password_hash, role FROM users WHERE username = $1',
      [body.username],
    );

    if (result.rows.length === 0) {
      await logAuditEvent(null, 'LOGIN_FAILED', 'user', undefined, { username: body.username, reason: 'user_not_found' }, request);
      throw fastify.httpErrors.unauthorized('Invalid username or password');
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(body.password, user.password_hash);
    if (!valid) {
      await logAuditEvent(user.id, 'LOGIN_FAILED', 'user', user.id, { reason: 'invalid_password' }, request);
      throw fastify.httpErrors.unauthorized('Invalid username or password');
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

    await logAuditEvent(user.id, 'LOGIN', 'user', user.id, {}, request);

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
        user: { id: user.id, username: user.username, role: user.role },
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

      // Verify user still exists
      const result = await query<{ id: string; username: string; role: string }>(
        'SELECT id, username, role FROM users WHERE id = $1',
        [payload.sub],
      );
      if (result.rows.length === 0) {
        throw fastify.httpErrors.unauthorized('User not found');
      }

      const user = result.rows[0];

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
        .send({ accessToken, user: { id: user.id, username: user.username, role: user.role } });
    } catch (err) {
      logger.debug({ err }, 'Refresh token verification failed');
      throw fastify.httpErrors.unauthorized('Invalid refresh token');
    }
  });

  fastify.post('/logout', async (request, reply) => {
    // Try to revoke all user tokens if authenticated
    try {
      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const { verifyToken } = await import('../plugins/auth.js');
        const payload = await verifyToken(authHeader.slice(7));
        await revokeAllUserTokens(payload.sub);
        await logAuditEvent(payload.sub, 'LOGOUT', 'user', payload.sub, {}, request);
      }
    } catch {
      // Best effort: still clear cookie even if token is invalid
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
