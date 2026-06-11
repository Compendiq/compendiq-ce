/**
 * Route-level tests for the admin user-lifecycle endpoints (#304).
 *
 * Focus: the system sentinel user (UX-fix Task 4) — it must never appear in
 * GET /api/admin/users and every mutating route must refuse it with HTTP 400
 * (service code SYSTEM_USER_PROTECTED, mapped like SELF_FORBIDDEN).
 *
 * The real `admin-user-service` runs underneath; only the boundaries
 * (Postgres, Redis-backed security cache, SMTP, audit log) are mocked —
 * mirroring `admin.test.ts` / `rbac.test.ts` conventions.
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { adminUsersRoutes } from './admin-users.js';

// Mock the database
vi.mock('../../core/db/postgres.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/services/email-service.js', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/services/rate-limit-service.js', () => ({
  getRateLimits: vi.fn().mockResolvedValue({ admin: { max: 100, timeWindow: '1 minute' } }),
}));

// admin-user-service publishes invalidations through the Redis cache-bus —
// stub it so route tests stay Redis-free (#737).
vi.mock('../../core/services/user-security-cache.js', () => ({
  invalidateUserSecurityState: vi.fn().mockResolvedValue(undefined),
}));

import { query as mockQueryImport } from '../../core/db/postgres.js';

const mockQuery = mockQueryImport as ReturnType<typeof vi.fn>;

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

describe('admin-users routes — system account protection', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    // Match production error handler for Zod validation errors
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        reply.status(400).send({
          error: 'ValidationError',
          message: error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          statusCode: 400,
        });
        return;
      }
      reply
        .status(error.statusCode ?? 500)
        .send({ error: error.message, statusCode: error.statusCode ?? 500 });
    });

    // Decorate with mock auth (admin)
    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      request.username = 'admin';
      request.userRole = 'admin';
    });
    app.decorate('requireAdmin', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      request.username = 'admin';
      request.userRole = 'admin';
    });

    await app.register(adminUsersRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('GET /api/admin/users', () => {
    it('queries with the system user excluded and returns the rows', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
            username: 'alice',
            email: 'alice@example.com',
            display_name: 'Alice',
            role: 'user',
            auth_provider: 'local',
            deactivated_at: null,
            deactivated_by: null,
            deactivated_reason: null,
            created_at: new Date('2026-01-01T00:00:00Z'),
          },
        ],
      });

      const response = await app.inject({ method: 'GET', url: '/api/admin/users' });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.users).toHaveLength(1);
      expect(body.users[0].username).toBe('alice');

      // The SELECT must exclude the system sentinel id at the SQL level so
      // the UI never sees it (behavioral proof against the real DB lives in
      // admin-user-service.test.ts).
      const listCall = mockQuery.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('FROM users'),
      );
      expect(listCall).toBeDefined();
      expect(listCall![0]).toMatch(/id\s*<>/);
      expect(listCall![1]).toContain(SYSTEM_USER_ID);
    });
  });

  describe('PUT /api/admin/users/:id', () => {
    it('refuses to update the system user with 400', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/admin/users/${SYSTEM_USER_ID}`,
        payload: { role: 'user' },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe('The system account cannot be modified');
    });
  });

  describe('POST /api/admin/users/:id/deactivate', () => {
    it('refuses to deactivate the system user with 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/users/${SYSTEM_USER_ID}/deactivate`,
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe('The system account cannot be modified');
    });
  });

  describe('POST /api/admin/users/:id/reactivate', () => {
    it('refuses to reactivate the system user with 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/users/${SYSTEM_USER_ID}/reactivate`,
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe('The system account cannot be modified');
    });
  });

  describe('DELETE /api/admin/users/:id', () => {
    it('refuses to delete the system user with 400', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/admin/users/${SYSTEM_USER_ID}`,
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe('The system account cannot be modified');
    });
  });
});
