import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
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
