import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken, generateRefreshToken } from './auth.js';
import { _resetForTests } from '../services/user-security-cache.js';

/**
 * Regression tests for issue #737 — deactivated/demoted users must NOT
 * retain API access until their access token expires.
 *
 * `authenticate` historically validated the JWT statelessly: `deactivated_at`
 * and `role` were only re-checked at /login and /refresh, so an admin
 * deactivating or demoting a user had no effect on already-issued access
 * tokens (up to ACCESS_TOKEN_EXPIRY, env-configurable). These tests drive
 * the full route → service → cache-invalidation path and assert the victim's
 * previously-working token is rejected on the very next request.
 *
 * Routes used:
 *   - GET  /api/notifications          — plain authenticated route
 *   - GET  /api/admin/audit-log        — requireAdmin route
 *   - POST /api/admin/users/:id/deactivate|reactivate, PUT/DELETE …/users/:id
 */

async function createUser(username: string, role: 'admin' | 'user'): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'fakehash', $2) RETURNING id`,
    [username, role],
  );
  return result.rows[0]!.id;
}

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

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe.skipIf(!dbAvailable)('access-token revocation on deactivation/role change (#737)', () => {
  it('baseline: an active user with a valid token gets 200', async () => {
    const userId = await createUser('rev_baseline', 'user');
    const token = await generateAccessToken({ sub: userId, username: 'rev_baseline', role: 'user' });

    const res = await app.inject({ method: 'GET', url: '/api/notifications', headers: authed(token) });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an already-issued access token immediately after deactivation', async () => {
    const adminId = await createUser('rev_admin1', 'admin');
    const adminToken = await generateAccessToken({ sub: adminId, username: 'rev_admin1', role: 'admin' });
    const victimId = await createUser('rev_victim1', 'user');
    const victimToken = await generateAccessToken({ sub: victimId, username: 'rev_victim1', role: 'user' });

    // Victim makes a successful request first so the security state is cached
    // — proves the deactivation path actively invalidates the cache rather
    // than relying on a cold lookup.
    const before = await app.inject({ method: 'GET', url: '/api/notifications', headers: authed(victimToken) });
    expect(before.statusCode).toBe(200);

    const deact = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${victimId}/deactivate`,
      headers: authed(adminToken),
      payload: { reason: 'offboarded' },
    });
    expect(deact.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/notifications', headers: authed(victimToken) });
    expect(after.statusCode).toBe(401);
  });

  it('rejects a demoted admin\'s already-issued admin token immediately', async () => {
    const actorId = await createUser('rev_actor2', 'admin');
    const actorToken = await generateAccessToken({ sub: actorId, username: 'rev_actor2', role: 'admin' });
    const victimId = await createUser('rev_demoted2', 'admin');
    const victimToken = await generateAccessToken({ sub: victimId, username: 'rev_demoted2', role: 'admin' });

    const before = await app.inject({ method: 'GET', url: '/api/admin/audit-log', headers: authed(victimToken) });
    expect(before.statusCode).toBe(200);

    const demote = await app.inject({
      method: 'PUT',
      url: `/api/admin/users/${victimId}`,
      headers: authed(actorToken),
      payload: { role: 'user' },
    });
    expect(demote.statusCode).toBe(200);

    // The stale admin token must be rejected on BOTH admin and plain routes
    // — its role claim no longer matches the DB, so the client is forced to
    // re-authenticate (refresh tokens were revoked by the demotion).
    const adminAfter = await app.inject({ method: 'GET', url: '/api/admin/audit-log', headers: authed(victimToken) });
    expect(adminAfter.statusCode).toBe(401);

    const plainAfter = await app.inject({ method: 'GET', url: '/api/notifications', headers: authed(victimToken) });
    expect(plainAfter.statusCode).toBe(401);
  });

  it('revokes the victim\'s refresh tokens on role change', async () => {
    const actorId = await createUser('rev_actor3', 'admin');
    const actorToken = await generateAccessToken({ sub: actorId, username: 'rev_actor3', role: 'admin' });
    const victimId = await createUser('rev_demoted3', 'admin');
    await generateRefreshToken({ sub: victimId, username: 'rev_demoted3', role: 'admin' });

    const tokensBefore = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM refresh_tokens WHERE user_id = $1`,
      [victimId],
    );
    expect(tokensBefore.rows[0]!.c).toBe('1');

    const demote = await app.inject({
      method: 'PUT',
      url: `/api/admin/users/${victimId}`,
      headers: authed(actorToken),
      payload: { role: 'user' },
    });
    expect(demote.statusCode).toBe(200);

    const tokensAfter = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM refresh_tokens WHERE user_id = $1`,
      [victimId],
    );
    expect(tokensAfter.rows[0]!.c).toBe('0');
  });

  it('rejects a stale user token after promotion (role claim no longer matches)', async () => {
    const actorId = await createUser('rev_actor4', 'admin');
    const actorToken = await generateAccessToken({ sub: actorId, username: 'rev_actor4', role: 'admin' });
    const victimId = await createUser('rev_promoted4', 'user');
    const victimToken = await generateAccessToken({ sub: victimId, username: 'rev_promoted4', role: 'user' });

    const before = await app.inject({ method: 'GET', url: '/api/notifications', headers: authed(victimToken) });
    expect(before.statusCode).toBe(200);

    const promote = await app.inject({
      method: 'PUT',
      url: `/api/admin/users/${victimId}`,
      headers: authed(actorToken),
      payload: { role: 'admin' },
    });
    expect(promote.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/notifications', headers: authed(victimToken) });
    expect(after.statusCode).toBe(401);
  });

  it('an update that does not change the role leaves the session working', async () => {
    const actorId = await createUser('rev_actor5', 'admin');
    const actorToken = await generateAccessToken({ sub: actorId, username: 'rev_actor5', role: 'admin' });
    const victimId = await createUser('rev_renamed5', 'user');
    const victimToken = await generateAccessToken({ sub: victimId, username: 'rev_renamed5', role: 'user' });

    const update = await app.inject({
      method: 'PUT',
      url: `/api/admin/users/${victimId}`,
      headers: authed(actorToken),
      payload: { displayName: 'Renamed User' },
    });
    expect(update.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/notifications', headers: authed(victimToken) });
    expect(after.statusCode).toBe(200);
  });

  it('restores access after reactivation without requiring a new token', async () => {
    const adminId = await createUser('rev_admin6', 'admin');
    const adminToken = await generateAccessToken({ sub: adminId, username: 'rev_admin6', role: 'admin' });
    const victimId = await createUser('rev_victim6', 'user');
    const victimToken = await generateAccessToken({ sub: victimId, username: 'rev_victim6', role: 'user' });

    await app.inject({
      method: 'POST',
      url: `/api/admin/users/${victimId}/deactivate`,
      headers: authed(adminToken),
      payload: {},
    });
    const whileDeactivated = await app.inject({ method: 'GET', url: '/api/notifications', headers: authed(victimToken) });
    expect(whileDeactivated.statusCode).toBe(401);

    const react = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${victimId}/reactivate`,
      headers: authed(adminToken),
    });
    expect(react.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/notifications', headers: authed(victimToken) });
    expect(after.statusCode).toBe(200);
  });

  it('rejects the token of a hard-deleted user immediately', async () => {
    const adminId = await createUser('rev_admin7', 'admin');
    const adminToken = await generateAccessToken({ sub: adminId, username: 'rev_admin7', role: 'admin' });
    const victimId = await createUser('rev_deleted7', 'user');
    const victimToken = await generateAccessToken({ sub: victimId, username: 'rev_deleted7', role: 'user' });

    const before = await app.inject({ method: 'GET', url: '/api/notifications', headers: authed(victimToken) });
    expect(before.statusCode).toBe(200);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${victimId}`,
      headers: authed(adminToken),
    });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/api/notifications', headers: authed(victimToken) });
    expect(after.statusCode).toBe(401);
  });
});
