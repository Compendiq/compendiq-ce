import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import * as jose from 'jose';

import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken, generateRefreshToken, revokeToken, verifyToken } from './auth.js';
import { _resetForTests } from '../services/user-security-cache.js';

/**
 * Access and refresh JWTs share one HS256 secret and issuer, so only an
 * explicit purpose marker keeps them apart. Without it a refresh JWT — even
 * one logout had revoked — authenticated as `Authorization: Bearer` on every
 * protected route for its full 7-day lifetime, because the bearer path never
 * consults `refresh_tokens`. These tests drive the real routes against real
 * Postgres; nothing about authorization is mocked.
 */

const dbAvailable = await isDbAvailable();

let app: FastifyInstance;

beforeAll(async () => {
  if (!dbAvailable) return;
  await setupTestDb();
  app = await buildApp();
  await app.ready();
}, 30_000);

afterAll(async () => {
  if (!dbAvailable) return;
  await app?.close();
  await teardownTestDb();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await truncateAllTables();
  _resetForTests();
});

interface TestUser {
  id: string;
  username: string;
  role: 'user';
}

async function createUser(username: string): Promise<TestUser> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'fakehash', 'user') RETURNING id`,
    [username],
  );
  const id = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [id]);
  return { id, username, role: 'user' };
}

const claimsOf = (user: TestUser) => ({ sub: user.id, username: user.username, role: user.role });

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET);

/** Refresh-shaped claims (`jti`/`family`) under a caller-chosen header. */
async function signRefreshShaped(
  user: TestUser,
  header: jose.JWTHeaderParameters,
  jti: string,
  family: string,
): Promise<string> {
  return new jose.SignJWT({ username: user.username, role: user.role, jti, family })
    .setProtectedHeader(header)
    .setSubject(user.id)
    .setIssuer('compendiq')
    .setExpirationTime('7d')
    .sign(secret());
}

/** A refresh token as minted before purpose markers existed: no `typ` header. */
async function mintLegacyRefreshToken(user: TestUser): Promise<{ token: string; jti: string; family: string }> {
  const jti = randomUUID();
  const family = randomUUID();
  const token = await signRefreshShaped(user, { alg: 'HS256' }, jti, family);
  await query(
    `INSERT INTO refresh_tokens (user_id, jti, family, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')`,
    [user.id, jti, family],
  );
  return { token, jti, family };
}

/** Access-shaped claims (no `jti`/`family`) under a caller-chosen header. */
async function signAccessShaped(user: TestUser, header: jose.JWTHeaderParameters): Promise<string> {
  return new jose.SignJWT({ username: user.username, role: user.role })
    .setProtectedHeader(header)
    .setSubject(user.id)
    .setIssuer('compendiq')
    .setExpirationTime('1h')
    .sign(secret());
}

function refreshCookieOf(headers: Record<string, unknown>): string | null {
  const header = headers['set-cookie'];
  const values = Array.isArray(header) ? header : header === undefined ? [] : [String(header)];
  for (const value of values) {
    const match = /^kb_refresh=([^;]*)/.exec(String(value));
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

const getSettings = (token: string) =>
  app.inject({ method: 'GET', url: '/api/settings', headers: { authorization: `Bearer ${token}` } });

const refreshWith = (token: string) =>
  app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { kb_refresh: token } });

async function isRevoked(jti: string): Promise<boolean> {
  const result = await query<{ revoked: boolean }>('SELECT revoked FROM refresh_tokens WHERE jti = $1', [jti]);
  return result.rows[0]!.revoked;
}

async function revokedInFamily(family: string): Promise<number> {
  const result = await query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM refresh_tokens WHERE family = $1 AND revoked',
    [family],
  );
  return Number(result.rows[0]!.count);
}

const typOf = (token: string) => jose.decodeProtectedHeader(token).typ;

describe.skipIf(!dbAvailable)('token purpose separation (GHSA-527x-q8px-qhhg)', () => {
  it('a valid access token still authenticates a protected route', async () => {
    const user = await createUser('purpose_baseline');
    const access = await generateAccessToken(claimsOf(user));
    expect(typOf(access)).toBe('at+jwt');
    const res = await getSettings(access);
    expect(res.statusCode).toBe(200);
  });

  it('rejects a live refresh token as a bearer access token', async () => {
    const user = await createUser('purpose_live_refresh');
    const refresh = await generateRefreshToken(claimsOf(user));
    expect(typOf(refresh.token)).toBe('rt+jwt');
    expect(await isRevoked(refresh.jti)).toBe(false);

    const res = await getSettings(refresh.token);
    expect(res.statusCode).toBe(401);
    await expect(verifyToken(refresh.token)).rejects.toThrow();
  });

  it('rejects a refresh token revoked by logout, as bearer and at /auth/refresh', async () => {
    const user = await createUser('purpose_revoked_refresh');
    const refresh = await generateRefreshToken(claimsOf(user));

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { kb_refresh: refresh.token },
    });
    expect(logout.statusCode).toBe(200);
    expect(await isRevoked(refresh.jti)).toBe(true);

    expect((await getSettings(refresh.token)).statusCode).toBe(401);
    expect((await refreshWith(refresh.token)).statusCode).toBe(401);
  });

  it('does not let a revoked refresh token, sent as bearer, log out the other sessions', async () => {
    const user = await createUser('purpose_logout_bearer');
    const stolen = await generateRefreshToken(claimsOf(user));
    const other = await generateRefreshToken(claimsOf(user));
    await revokeToken(stolen.jti);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${stolen.token}` },
    });
    expect(logout.statusCode).toBe(200);
    expect(await isRevoked(other.jti)).toBe(false);
  });

  it('rejects a legacy (unmarked) refresh token as a bearer access token', async () => {
    const user = await createUser('purpose_legacy_refresh_bearer');
    const legacy = await mintLegacyRefreshToken(user);

    expect((await getSettings(legacy.token)).statusCode).toBe(401);
    await expect(verifyToken(legacy.token)).rejects.toThrow();
  });

  it('rejects a legacy (unmarked) access token, so the client refreshes once', async () => {
    const user = await createUser('purpose_legacy_access');
    const legacy = await signAccessShaped(user, { alg: 'HS256' });

    await expect(verifyToken(legacy)).rejects.toThrow();
    expect((await getSettings(legacy)).statusCode).toBe(401);
  });

  it('rejects a token of any other declared type signed with the shared secret', async () => {
    const user = await createUser('purpose_other_typ');
    const other = await signAccessShaped(user, { alg: 'HS256', typ: 'JWT' });

    await expect(verifyToken(other)).rejects.toThrow();
    expect((await getSettings(other)).statusCode).toBe(401);
  });

  it('rejects an access token at /auth/refresh without touching stored sessions', async () => {
    const user = await createUser('purpose_access_at_refresh');
    const session = await generateRefreshToken(claimsOf(user));
    const access = await generateAccessToken(claimsOf(user));

    const res = await refreshWith(access);
    expect(res.statusCode).toBe(401);
    expect(refreshCookieOf(res.headers)).toBeNull();
    expect(await isRevoked(session.jti)).toBe(false);
  });

  it('rejects an access-typed token carrying refresh claims without touching its family', async () => {
    const user = await createUser('purpose_access_typ_refresh_claims');
    const session = await generateRefreshToken(claimsOf(user));
    // Everything a refresh token needs except the marker: the JTI row exists
    // and is live, so only the `typ` check can turn it away.
    const forged = await signRefreshShaped(user, { alg: 'HS256', typ: 'at+jwt' }, session.jti, session.family);

    const res = await refreshWith(forged);
    expect(res.statusCode).toBe(401);
    expect(refreshCookieOf(res.headers)).toBeNull();
    expect(await isRevoked(session.jti)).toBe(false);
    expect(await revokedInFamily(session.family)).toBe(0);
  });

  it('refuses a legacy (unmarked) refresh token at /auth/refresh without touching its family (#1683)', async () => {
    const user = await createUser('purpose_legacy_refresh');
    const legacy = await mintLegacyRefreshToken(user);

    // Its JTI row exists and is live, so only the `typ` check can turn it away.
    const res = await refreshWith(legacy.token);
    expect(res.statusCode).toBe(401);
    expect(refreshCookieOf(res.headers)).toBeNull();
    expect(await isRevoked(legacy.jti)).toBe(false);
    expect(await revokedInFamily(legacy.family)).toBe(0);
  });

  it('rotates a marked refresh token into purpose-marked successors', async () => {
    const user = await createUser('purpose_marked_rotation');
    const session = await generateRefreshToken(claimsOf(user));

    const res = await refreshWith(session.token);
    expect(res.statusCode).toBe(200);
    expect(await isRevoked(session.jti)).toBe(true);

    const { accessToken } = res.json<{ accessToken: string }>();
    const successor = refreshCookieOf(res.headers);
    expect(successor).not.toBeNull();
    expect(typOf(accessToken)).toBe('at+jwt');
    expect(typOf(successor!)).toBe('rt+jwt');
    expect((await getSettings(accessToken)).statusCode).toBe(200);
    expect((await getSettings(successor!)).statusCode).toBe(401);

    const next = await refreshWith(successor!);
    expect(next.statusCode).toBe(200);
    expect(typOf(next.json<{ accessToken: string }>().accessToken)).toBe('at+jwt');
    expect(typOf(refreshCookieOf(next.headers)!)).toBe('rt+jwt');
  });
});
