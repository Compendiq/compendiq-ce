import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import { ZodError } from 'zod';

// The register handler mints tokens + writes audit rows. None of that is under
// test here (the GATE + admin_settings + users predicate is), and the token
// helpers pull in JWT/refresh-token machinery, so stub them. Postgres is NOT
// mocked — the gate reads the REAL admin_settings + users tables.
vi.mock('../../core/plugins/auth.js', () => ({
  generateAccessToken: vi.fn().mockResolvedValue('access-token'),
  generateRefreshToken: vi.fn().mockResolvedValue({ token: 'refresh-token', jti: 'jti' }),
  verifyRefreshToken: vi.fn(),
  revokeToken: vi.fn(),
  revokeAllUserTokens: vi.fn(),
  cleanupExpiredTokens: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/services/rate-limit-service.js', () => ({
  getRateLimits: vi.fn().mockResolvedValue({ auth: { max: 1000 }, admin: { max: 1000 }, global: { max: 1000 } }),
}));

import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { SYSTEM_USER_ID } from '../../core/services/registration-policy-service.js';
import { authRoutes } from './auth.js';

const dbAvailable = await isDbAvailable();

async function insertSentinel(): Promise<void> {
  await query(
    `INSERT INTO users (id, username, password_hash, role)
     VALUES ($1, '__system__', 'nologin', 'admin')
     ON CONFLICT (id) DO NOTHING`,
    [SYSTEM_USER_ID],
  );
}

async function insertRealAdmin(username = 'seed_admin'): Promise<void> {
  await query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'fakehash', 'admin')`,
    [username],
  );
}

async function setMode(mode: string): Promise<void> {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ('registration_mode', $1, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = NOW()`,
    [mode],
  );
}

async function countUsers(): Promise<number> {
  const r = await query<{ count: string }>(`SELECT COUNT(*) AS count FROM users WHERE id != $1`, [SYSTEM_USER_ID]);
  return parseInt(r.rows[0]!.count, 10);
}

async function countRealAdmins(): Promise<number> {
  const r = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND id != $1`,
    [SYSTEM_USER_ID],
  );
  return parseInt(r.rows[0]!.count, 10);
}

describe.skipIf(!dbAvailable)('registration gate — real DB round-trip (#1051)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDb();
    app = Fastify({ logger: false });
    await app.register(sensible);
    await app.register(cookie);

    // Mirror the production error handler shape enough for Zod → 400.
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        reply.status(400).send({ error: 'ValidationError', statusCode: 400 });
        return;
      }
      reply.status(error.statusCode ?? 500).send({
        error: error.message,
        statusCode: error.statusCode ?? 500,
      });
    });

    // Stub auth decorators (register/login/refresh/logout don't use them, but
    // cleanup-tokens' preHandler references requireAdmin at registration time).
    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {});

    await app.register(authRoutes, { prefix: '/api/auth' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('(1) bootstrap: fresh DB → POST /register 201 and the first account is an admin (despite default closed)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'firstuser', password: 'securepassword' },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).user.role).toBe('admin');

    const row = await query<{ role: string }>(`SELECT role FROM users WHERE username = 'firstuser'`);
    expect(row.rows[0]!.role).toBe('admin');
  });

  it('(2) closed (unset mode) with a real admin → POST /register 403 registration_disabled, no new row', async () => {
    await insertSentinel();
    await insertRealAdmin();
    const before = await countUsers();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'blocked', password: 'securepassword' },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('registration_disabled');
    expect(await countUsers()).toBe(before);
  });

  it("(3) mode 'open' with a real admin → POST /register 201 and the new account is a regular user", async () => {
    await insertSentinel();
    await insertRealAdmin();
    await setMode('open');

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'joiner', password: 'securepassword' },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).user.role).toBe('user');
  });

  it('(4) two concurrent bootstrap registrations both succeed and create exactly two accounts', async () => {
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'concurrent_a', password: 'securepassword' } }),
      app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'concurrent_b', password: 'securepassword' } }),
    ]);

    // The bootstrap gate must let BOTH concurrent first-account requests
    // through (neither 403s) — that is the property this change guarantees.
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(await countUsers()).toBe(2);
    // At least one is an admin — first-account bootstrap succeeded. Exact-one
    // admin under true concurrency is a pre-existing property of the register
    // INSERT (unchanged here), not something this gate controls.
    expect(await countRealAdmins()).toBeGreaterThanOrEqual(1);
  });

  it('(5) GET /registration-policy reflects the effective policy', async () => {
    await insertSentinel();
    await insertRealAdmin();
    await setMode('closed');
    const closed = await app.inject({ method: 'GET', url: '/api/auth/registration-policy' });
    expect(closed.statusCode).toBe(200);
    expect(JSON.parse(closed.body)).toEqual({ allowRegistration: false });

    await setMode('open');
    const open = await app.inject({ method: 'GET', url: '/api/auth/registration-policy' });
    expect(JSON.parse(open.body)).toEqual({ allowRegistration: true });
  });
});
