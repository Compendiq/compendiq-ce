import fp from 'fastify-plugin';
import { FastifyInstance, FastifyRequest } from 'fastify';
import * as jose from 'jose';
import { randomUUID } from 'crypto';
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

const JWT_ISSUER = 'kb-creator';
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
    .setExpirationTime('15m')
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

  if (result.rows[0].revoked) {
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
    } catch (err) {
      logger.debug({ err }, 'Token verification failed');
      throw fastify.httpErrors.unauthorized('Invalid or expired token');
    }
  });

  fastify.decorate('requireAdmin', async (request: FastifyRequest) => {
    await fastify.authenticate(request);
    if (request.userRole !== 'admin') {
      throw fastify.httpErrors.forbidden('Admin access required');
    }
  });
});
