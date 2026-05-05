import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Short-circuit DNS lookups performed by the SSRF guard during `buildApp()`
// boot. Mirrors `admin-embedding-locks.test.ts` — no integration test should
// hit external DNS.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    const err = new Error('getaddrinfo ENOTFOUND (mocked)') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  }),
}));

import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import { healthApiRoutes } from './health-api.js';

/**
 * Real-DB integration test for the /api/internal/health endpoint. The
 * mocked unit test in `health-api.test.ts` covers branching/auth, but
 * cannot catch SQL coupling regressions (e.g. a wrong table name still
 * matches a string-include router). This test exercises the actual
 * `pages` / `spaces` / `users` / `audit_log` / `admin_settings`
 * relations so a future schema rename breaks here, not in production.
 *
 * Compendiq/compendiq-ee#113 Part A.
 */

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('health-api integration — Compendiq/compendiq-ee#113 Part A', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDb();
    app = Fastify({ logger: false });
    app.decorate('license', null);
    await app.register(healthApiRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    // Re-seed the token row that migration 072 normally provides — truncate
    // wipes it, but the route reads `admin_settings.health_api_token`.
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ('health_api_token', encode(gen_random_bytes(32), 'hex'), NOW())
       ON CONFLICT (setting_key) DO NOTHING`,
    );
  });

  async function readToken(): Promise<string> {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'health_api_token'`,
    );
    return r.rows[0]!.setting_value;
  }

  it('builds a health report against the real schema', async () => {
    // Seed: 2 active users, 1 deactivated.
    await query(
      `INSERT INTO users (username, password_hash, role) VALUES
         ('alice', 'x', 'user'),
         ('bob',   'x', 'user'),
         ('eve',   'x', 'user')`,
    );
    await query(`UPDATE users SET deactivated_at = NOW() WHERE username = 'eve'`);

    // Seed: 1 page in 'not_embedded' state, 1 already 'embedded'.
    // pages.embedding_status defaults to 'not_embedded'; we set the second
    // explicitly.
    await query(
      `INSERT INTO pages (title, embedding_status) VALUES ('p1', 'not_embedded'), ('p2', 'embedded')`,
    );

    // Seed: 1 space (post-040 schema is global, not per-user) and audit rows
    // for alice. The route only reads MAX(last_synced) from `spaces`.
    const aliceId = (
      await query<{ id: string }>(`SELECT id FROM users WHERE username = 'alice'`)
    ).rows[0]!.id;
    await query(
      `INSERT INTO spaces (space_key, space_name, last_synced, source, created_by)
       VALUES ('TEST', 'Test Space', NOW(), 'local', $1)`,
      [aliceId],
    );
    await query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, created_at)
       VALUES ($1, 'LOGIN', 'auth', NULL, '{}'::jsonb, NOW()),
              ($1, 'LOGIN_FAILED', 'auth', NULL, '{}'::jsonb, NOW())`,
      [aliceId],
    );

    const token = await readToken();
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/health?token=${token}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.userCount).toBe(3);
    expect(body.activeUserCount).toBe(2);
    expect(body.dirtyPages).toBe(1);
    expect(body.lastSyncAt).toBeTypeOf('string');
    // 1 of 2 audit rows is FAILED → 0.5 (rounded to 4dp).
    expect(body.errorRate24h).toBe(0.5);
    expect(body.tier).toBe('community');
    expect(body.edition).toBeDefined();
    expect(body.version).toBeDefined();
  });

  it('returns 401 when the token is wrong against a real seeded row', async () => {
    const wrong = 'b'.repeat(64);
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/health?token=${wrong}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('error-rate counts BLOCKED-suffixed actions (regression for LIKE-filter gap)', async () => {
    // The old `LIKE '%FAILED%' OR LIKE '%DENIED%'` filter missed
    // `IP_ALLOWLIST_BLOCKED`. This test pins that the explicit
    // allowlist captures it.
    await query(
      `INSERT INTO users (username, password_hash, role) VALUES ('e1', 'h', 'user')`,
    );
    const uid = (
      await query<{ id: string }>(`SELECT id FROM users WHERE username = 'e1'`)
    ).rows[0]!.id;
    await query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, created_at)
       VALUES ($1, 'IP_ALLOWLIST_BLOCKED', 'ip', NULL, '{}'::jsonb, NOW()),
              ($1, 'LOGIN', 'auth', NULL, '{}'::jsonb, NOW()),
              ($1, 'LOGIN', 'auth', NULL, '{}'::jsonb, NOW()),
              ($1, 'LOGIN', 'auth', NULL, '{}'::jsonb, NOW())`,
      [uid],
    );

    const token = await readToken();
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/health?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    // 1 BLOCKED out of 4 total = 0.25
    expect((res.json() as Record<string, unknown>).errorRate24h).toBe(0.25);
  });

  it('error-rate ignores non-error security signals (PROMPT_INJECTION_DETECTED)', async () => {
    // `PROMPT_INJECTION_DETECTED` is a security observation, not an
    // operational error. It must NOT inflate the generic error rate
    // (kept out of ERROR_AUDIT_ACTIONS deliberately).
    await query(
      `INSERT INTO users (username, password_hash, role) VALUES ('e2', 'h', 'user')`,
    );
    const uid = (
      await query<{ id: string }>(`SELECT id FROM users WHERE username = 'e2'`)
    ).rows[0]!.id;
    await query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, created_at)
       VALUES ($1, 'PROMPT_INJECTION_DETECTED', 'llm', NULL, '{}'::jsonb, NOW()),
              ($1, 'LOGIN', 'auth', NULL, '{}'::jsonb, NOW())`,
      [uid],
    );

    const token = await readToken();
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/health?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    // PROMPT_INJECTION_DETECTED is excluded from the numerator.
    expect((res.json() as Record<string, unknown>).errorRate24h).toBe(0);
  });

  it('returns errorRate24h=0 and lastSyncAt=null on an empty DB', async () => {
    const token = await readToken();
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/health?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.userCount).toBe(0);
    expect(body.activeUserCount).toBe(0);
    expect(body.dirtyPages).toBe(0);
    expect(body.lastSyncAt).toBeNull();
    expect(body.errorRate24h).toBe(0);
  });
});

/**
 * Token-rotation route — Compendiq/compendiq-ee#113 sub-PR 1e.
 *
 * The rotation route lives in the same module as GET, but is registered
 * separately in `app.ts` because it requires `fastify.authenticate +
 * fastify.requireAdmin` while the GET path is a public bearer-token
 * endpoint. We test it against `buildApp()` (full Fastify wiring) rather
 * than the bare `Fastify({ logger: false })` instance the GET integration
 * test uses, so the auth decorators are real.
 */
const dbAvailableForRotate = await isDbAvailable();

describe.skipIf(!dbAvailableForRotate)(
  'POST /api/admin/health-api/rotate — Compendiq/compendiq-ee#113 sub-PR 1e',
  () => {
    let rotateApp: FastifyInstance;
    let adminToken: string;
    let adminUserId: string;
    let memberToken: string;

    async function createUserWithRole(
      username: string,
      role: 'admin' | 'member',
    ): Promise<{ token: string; userId: string }> {
      const r = await query<{ id: string }>(
        `INSERT INTO users (username, password_hash, role)
         VALUES ($1, 'fakehash', $2) RETURNING id`,
        [username, role],
      );
      const userId = r.rows[0]!.id;
      await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
      const token = await generateAccessToken({ sub: userId, username, role });
      return { token, userId };
    }

    async function readPersistedToken(): Promise<string | null> {
      const r = await query<{ setting_value: string }>(
        `SELECT setting_value FROM admin_settings WHERE setting_key = 'health_api_token'`,
      );
      return r.rows[0]?.setting_value ?? null;
    }

    beforeAll(async () => {
      await setupTestDb();
      rotateApp = await buildApp();
      await rotateApp.ready();
    }, 30_000);

    afterAll(async () => {
      await rotateApp?.close();
      await teardownTestDb();
    });

    beforeEach(async () => {
      await truncateAllTables();
      // Re-seed the row migration 072 normally provides — truncate wipes it.
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         VALUES ('health_api_token', encode(gen_random_bytes(32), 'hex'), NOW())
         ON CONFLICT (setting_key) DO NOTHING`,
      );
      ({ token: adminToken, userId: adminUserId } = await createUserWithRole(
        'rotate_admin',
        'admin',
      ));
      ({ token: memberToken } = await createUserWithRole('rotate_member', 'member'));
    });

    // (a) Unauthenticated → 401
    it('returns 401 when no Authorization header is supplied', async () => {
      const r = await rotateApp.inject({
        method: 'POST',
        url: '/api/admin/health-api/rotate',
      });
      expect(r.statusCode).toBe(401);
    });

    // (b) Authenticated but non-admin → 403
    it('returns 403 for a non-admin (member) caller', async () => {
      const r = await rotateApp.inject({
        method: 'POST',
        url: '/api/admin/health-api/rotate',
        headers: { authorization: `Bearer ${memberToken}` },
      });
      expect(r.statusCode).toBe(403);
    });

    // (c) Admin rotates → 200, response shape { token: 64-hex, rotatedAt: ISO }
    it('returns 200 with the new token and ISO rotatedAt on admin rotation', async () => {
      const before = await readPersistedToken();
      expect(before).toBeTruthy();

      const r = await rotateApp.inject({
        method: 'POST',
        url: '/api/admin/health-api/rotate',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as Record<string, unknown>;

      // Shape
      expect(typeof body.token).toBe('string');
      expect(body.token).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof body.rotatedAt).toBe('string');
      // ISO 8601 round-trip stable (Date.parse → toISOString)
      const parsed = new Date(body.rotatedAt as string);
      expect(Number.isNaN(parsed.getTime())).toBe(false);
      expect(parsed.toISOString()).toBe(body.rotatedAt);

      // Rotation actually persisted: response token equals DB row.
      const after = await readPersistedToken();
      expect(after).toBe(body.token);
      expect(after).not.toBe(before);
    });

    // (d) Round-trip: old token → 401, new token → 200
    it('rejects the old token and accepts the new one on subsequent GET', async () => {
      const oldToken = await readPersistedToken();
      expect(oldToken).toBeTruthy();

      const rot = await rotateApp.inject({
        method: 'POST',
        url: '/api/admin/health-api/rotate',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(rot.statusCode).toBe(200);
      const newToken = (rot.json() as { token: string }).token;
      expect(newToken).not.toBe(oldToken);

      const oldRes = await rotateApp.inject({
        method: 'GET',
        url: `/api/internal/health?token=${oldToken}`,
      });
      expect(oldRes.statusCode).toBe(401);

      const newRes = await rotateApp.inject({
        method: 'GET',
        url: `/api/internal/health?token=${newToken}`,
      });
      expect(newRes.statusCode).toBe(200);
    });

    // (e) Audit row written with HEALTH_API_TOKEN_ROTATED + actor user_id
    it('writes a HEALTH_API_TOKEN_ROTATED audit row for the rotating admin', async () => {
      const r = await rotateApp.inject({
        method: 'POST',
        url: '/api/admin/health-api/rotate',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(r.statusCode).toBe(200);
      const { rotatedAt } = r.json() as { rotatedAt: string };

      const { rows } = await query<{
        user_id: string;
        action: string;
        resource_type: string;
        resource_id: string | null;
        metadata: Record<string, unknown>;
      }>(
        `SELECT user_id, action, resource_type, resource_id, metadata::jsonb AS metadata
           FROM audit_log
          WHERE action = 'HEALTH_API_TOKEN_ROTATED'
          ORDER BY created_at DESC
          LIMIT 1`,
      );
      expect(rows).toHaveLength(1);
      const audit = rows[0]!;
      expect(audit.user_id).toBe(adminUserId);
      expect(audit.action).toBe('HEALTH_API_TOKEN_ROTATED');
      expect(audit.resource_type).toBe('health_api_token');
      expect(audit.resource_id).toBeNull();
      expect(audit.metadata).toMatchObject({ rotatedAt });
    });

    // (f) Migration row missing → 503 (mirrors GET behaviour)
    it('returns 503 when admin_settings.health_api_token row is absent', async () => {
      // Wipe the seeded row so the UPDATE affects 0 rows.
      await query(`DELETE FROM admin_settings WHERE setting_key = 'health_api_token'`);

      const r = await rotateApp.inject({
        method: 'POST',
        url: '/api/admin/health-api/rotate',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ error: 'health token not initialised' });

      // No audit row written when the rotation failed (the route returns
      // before logAuditEvent).
      const { rows } = await query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM audit_log WHERE action = 'HEALTH_API_TOKEN_ROTATED'`,
      );
      expect(rows[0]!.c).toBe('0');
    });
  },
);
