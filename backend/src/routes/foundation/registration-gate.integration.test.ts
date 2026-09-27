import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import { ZodError } from 'zod';

// Token and audit side effects are outside this regression. PostgreSQL is NOT
// mocked: both public routes run their real shared bootstrap transaction
// against the fully migrated schema, including migration 032's sentinel shape.
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
import { setupRoutes } from './setup.js';
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

describe.skipIf(!dbAvailable)('first-administrator bootstrap — real DB round-trip (#1661)', () => {
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
    await app.register(setupRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    // Reproduce the row migration 032 seeds in every normally migrated DB.
    await insertSentinel();
  });

  it('turns the first real registration into an administrator on the sentinel-seeded database', async () => {
    const policy = await app.inject({ method: 'GET', url: '/api/auth/registration-policy' });
    expect(policy.statusCode).toBe(200);
    expect(JSON.parse(policy.body)).toEqual({ allowRegistration: true });

    const registration = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'firstuser', password: 'securepassword' },
    });
    expect(registration.statusCode).toBe(201);
    expect(JSON.parse(registration.body).user.role).toBe('admin');

    const setup = await app.inject({ method: 'GET', url: '/api/health/setup-status' });
    expect(setup.statusCode).toBe(200);
    expect(JSON.parse(setup.body).steps.admin).toBe(true);
    expect(await countRealAdmins()).toBe(1);
  });

  it('rejects registration without writing when a real admin exists and mode is closed', async () => {
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

  it("creates later registrations as regular users when mode is 'open'", async () => {
    await setMode('open');

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'first_admin', password: 'securepassword' },
    });
    const later = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'joiner', password: 'securepassword' },
    });

    expect(first.statusCode).toBe(201);
    expect(JSON.parse(first.body).user.role).toBe('admin');
    expect(later.statusCode).toBe(201);
    expect(JSON.parse(later.body).user.role).toBe('user');
    expect(await countRealAdmins()).toBe(1);
  });

  it('serializes concurrent open registrations so exactly one receives the admin role', async () => {
    await setMode('open');
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'concurrent_a', password: 'securepassword' } }),
      app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'concurrent_b', password: 'securepassword' } }),
    ]);

    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    const roles = [JSON.parse(a.body).user.role, JSON.parse(b.body).user.role].sort();
    expect(roles).toEqual(['admin', 'user']);
    expect(await countUsers()).toBe(2);
    expect(await countRealAdmins()).toBe(1);
  });

  it('serializes /auth/register against /setup/admin across the bootstrap boundary', async () => {
    const [registration, setup] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'route_register', password: 'securepassword' } }),
      app.inject({ method: 'POST', url: '/api/setup/admin', payload: { username: 'route_setup', password: 'securepassword' } }),
    ]);

    const statusPair = [registration.statusCode, setup.statusCode];
    expect([[201, 409], [403, 201]]).toContainEqual(statusPair);
    expect(await countUsers()).toBe(1);
    expect(await countRealAdmins()).toBe(1);
  });

  it('reports the effective public registration policy without exposing its inputs', async () => {
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
