/**
 * Route-level regression tests for `PUT /api/admin/users/:id` (#1736).
 *
 * An explicit JSON `null` for `email` or `displayName` clears the stored
 * value; a key that is left out leaves it unchanged. The real route, the real
 * `admin-user-service` and real Postgres run here; only the auth decorators and
 * the audit / rate-limit / security-cache boundaries are stubbed.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/services/rate-limit-service.js', () => ({
  getRateLimits: vi.fn().mockResolvedValue({ admin: { max: 100, timeWindow: '1 minute' } }),
}));

// admin-user-service publishes invalidations through the Redis cache-bus.
vi.mock('../../core/services/user-security-cache.js', () => ({
  invalidateUserSecurityState: vi.fn().mockResolvedValue(undefined),
}));

import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { adminUsersRoutes } from './admin-users.js';

const dbAvailable = await isDbAvailable();

interface UserRowDb {
  email: string | null;
  display_name: string | null;
  role: string;
}

describe.skipIf(!dbAvailable)('PUT /api/admin/users/:id — null vs omitted (#1736)', () => {
  let app: FastifyInstance;
  let adminId = '';
  let targetId = '';

  beforeAll(async () => {
    await setupTestDb();
    app = Fastify({ logger: false });
    await app.register(sensible);
    const stubAuth = async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = adminId;
      request.username = 'admin_1736';
      request.userRole = 'admin';
    };
    app.decorate('authenticate', stubAuth);
    app.decorate('requireAdmin', stubAuth);
    await app.register(adminUsersRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    const admin = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role, email, display_name)
       VALUES ('admin_1736', 'fakehash', 'admin', 'admin@example.com', 'Admin') RETURNING id`,
    );
    adminId = admin.rows[0]!.id;
    const target = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role, email, display_name)
       VALUES ('target_1736', 'fakehash', 'user', 'target@example.com', 'Target Person') RETURNING id`,
    );
    targetId = target.rows[0]!.id;
  });

  async function putUser(id: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'PUT',
      url: `/api/admin/users/${id}`,
      payload: body,
    });
  }

  async function readRow(id: string): Promise<UserRowDb> {
    const r = await query<UserRowDb>(
      `SELECT email, display_name, role FROM users WHERE id = $1`,
      [id],
    );
    return r.rows[0]!;
  }

  it('{ email: null } clears only the email', async () => {
    const res = await putUser(targetId, { email: null });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBeNull();
    expect(body.displayName).toBe('Target Person');

    const row = await readRow(targetId);
    expect(row).toEqual({ email: null, display_name: 'Target Person', role: 'user' });
  });

  it('{ displayName: null } clears only the display name', async () => {
    const res = await putUser(targetId, { displayName: null });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.displayName).toBeNull();
    expect(body.email).toBe('target@example.com');

    const row = await readRow(targetId);
    expect(row).toEqual({
      email: 'target@example.com',
      display_name: null,
      role: 'user',
    });
  });

  it('{ email: null, displayName: null } clears both', async () => {
    const res = await putUser(targetId, { email: null, displayName: null });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBeNull();
    expect(body.displayName).toBeNull();

    const row = await readRow(targetId);
    expect(row).toEqual({ email: null, display_name: null, role: 'user' });
  });

  it('a body with only role leaves email and display name unchanged', async () => {
    const res = await putUser(targetId, { role: 'admin' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.role).toBe('admin');
    expect(body.email).toBe('target@example.com');
    expect(body.displayName).toBe('Target Person');

    const row = await readRow(targetId);
    expect(row).toEqual({
      email: 'target@example.com',
      display_name: 'Target Person',
      role: 'admin',
    });
  });

  it('{ email: null } on a user whose email is already NULL answers 200 and changes nothing', async () => {
    await query(`UPDATE users SET email = NULL WHERE id = $1`, [targetId]);

    const res = await putUser(targetId, { email: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBeNull();

    const row = await readRow(targetId);
    expect(row).toEqual({ email: null, display_name: 'Target Person', role: 'user' });
  });

  it('after one user’s email is cleared, another user can be given that address', async () => {
    const clear = await putUser(targetId, { email: null });
    expect(clear.statusCode).toBe(200);

    const other = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role, email)
       VALUES ('other_1736', 'fakehash', 'user', NULL) RETURNING id`,
    );
    const otherId = other.rows[0]!.id;

    const res = await putUser(otherId, { email: 'target@example.com' });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe('target@example.com');

    const row = await readRow(otherId);
    expect(row.email).toBe('target@example.com');
  });
});
