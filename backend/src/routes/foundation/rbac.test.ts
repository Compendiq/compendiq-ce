import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { rbacRoutes } from './rbac.js';

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

import { query as mockQuery } from '../../core/db/postgres.js';

// Valid UUID that passes Zod's UUID validation (variant nibble = 8-b)
const VALID_UUID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

/** Create a proper Error with a PG-style code for unique violation testing. */
function pgUniqueViolation(): Error {
  const err = new Error('duplicate key value violates unique constraint');
  (err as Error & { code: string }).code = '23505';
  return err;
}

describe('RBAC routes', () => {
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
      reply.status(error.statusCode ?? 500).send({ error: error.message, statusCode: error.statusCode ?? 500 });
    });

    // Decorate with mock auth (admin by default)
    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'admin-user-id';
      request.username = 'admin';
      request.userRole = 'admin';
    });
    app.decorate('requireAdmin', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'admin-user-id';
      request.username = 'admin';
      request.userRole = 'admin';
    });

    await app.register(rbacRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default to empty rows so no bleed between tests
    (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [], rowCount: 0 });
  });

  // ========================
  // Roles
  // ========================

  describe('GET /api/roles', () => {
    it('should return all roles', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          { id: 1, name: 'system_admin', display_name: 'System Administrator', is_system: true, permissions: ['read', 'admin'], created_at: '2026-01-01T00:00:00Z' },
          { id: 2, name: 'viewer', display_name: 'Viewer', is_system: true, permissions: ['read'], created_at: '2026-01-01T00:00:00Z' },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/roles',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(2);
      expect(body[0]).toEqual({
        id: 1,
        name: 'system_admin',
        displayName: 'System Administrator',
        isSystem: true,
        permissions: ['read', 'admin'],
        createdAt: '2026-01-01T00:00:00Z',
      });
    });
  });

  // ========================
  // Groups
  // ========================

  describe('GET /api/groups', () => {
    it('should return groups with member counts', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          { id: 1, name: 'Engineering', description: 'Eng team', source: 'local', member_count: '5', created_at: '2026-01-01T00:00:00Z' },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/groups',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe('Engineering');
      expect(body[0].memberCount).toBe(5);
    });
  });

  describe('POST /api/groups', () => {
    it('should create a group', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ id: 1, name: 'New Group', description: 'A test group', source: 'local', created_at: '2026-01-01T00:00:00Z' }],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/groups',
        payload: { name: 'New Group', description: 'A test group' },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.name).toBe('New Group');
      expect(body.memberCount).toBe(0);
    });

    it('should reject empty name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/groups',
        payload: { name: '' },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('PATCH /api/groups/:id', () => {
    it('should update a group', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ id: 1, name: 'Updated', description: null, source: 'local', created_at: '2026-01-01T00:00:00Z' }],
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/groups/1',
        payload: { name: 'Updated' },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).name).toBe('Updated');
    });

    it('should return 404 for non-existent group', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/groups/999',
        payload: { name: 'Updated' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/groups/:id', () => {
    it('should delete a group', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ id: 1 }] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/groups/1',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).message).toBe('Group deleted');
    });

    it('should return 404 for non-existent group', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/groups/999',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ========================
  // Group members
  // ========================

  describe('GET /api/groups/:id/members', () => {
    it('should list group members', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // group exists
      queryMock.mockResolvedValueOnce({
        rows: [
          { user_id: VALID_UUID, username: 'alice', source: 'manual', created_at: '2026-01-01T00:00:00Z' },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/groups/1/members',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(1);
      expect(body[0].username).toBe('alice');
    });

    it('should return 404 when group does not exist', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/groups/999/members',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /api/groups/:id/members', () => {
    it('should add a user to a group', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // group exists
      queryMock.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // user exists
      queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // insert membership

      const response = await app.inject({
        method: 'POST',
        url: '/api/groups/1/members',
        payload: { userId: VALID_UUID },
      });

      expect(response.statusCode).toBe(201);
      expect(JSON.parse(response.body).message).toBe('User added to group');
    });

    it('should return 409 on duplicate membership', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // group exists
      queryMock.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // user exists
      queryMock.mockRejectedValueOnce(pgUniqueViolation()); // unique violation

      const response = await app.inject({
        method: 'POST',
        url: '/api/groups/1/members',
        payload: { userId: VALID_UUID },
      });

      expect(response.statusCode).toBe(409);
    });
  });

  // ========================
  // Space role assignments
  // ========================

  describe('GET /api/spaces/:key/roles', () => {
    it('should list role assignments for a space', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          {
            id: 1, space_key: 'ENG', principal_type: 'user', principal_id: 'user-1',
            role_id: 3, role_name: 'editor', role_display_name: 'Editor', created_at: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/spaces/ENG/roles',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(1);
      expect(body[0].roleName).toBe('editor');
      expect(body[0].principalType).toBe('user');
    });
  });

  describe('POST /api/spaces/:key/roles', () => {
    it('should assign a role in a space', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [{ id: 3 }] }); // role exists
      queryMock.mockResolvedValueOnce({
        rows: [{ id: 1, created_at: '2026-01-01T00:00:00Z' }],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/spaces/ENG/roles',
        payload: { principalType: 'user', principalId: 'user-1', roleId: 3 },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.spaceKey).toBe('ENG');
      expect(body.roleId).toBe(3);
    });

    it('should return 404 if role does not exist', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/spaces/ENG/roles',
        payload: { principalType: 'user', principalId: 'user-1', roleId: 999 },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 409 on duplicate assignment', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [{ id: 3 }] }); // role exists
      queryMock.mockRejectedValueOnce(pgUniqueViolation()); // unique violation

      const response = await app.inject({
        method: 'POST',
        url: '/api/spaces/ENG/roles',
        payload: { principalType: 'user', principalId: 'user-1', roleId: 3 },
      });

      expect(response.statusCode).toBe(409);
    });
  });

  describe('DELETE /api/spaces/:key/roles/:assignmentId', () => {
    it('should remove a role assignment', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ id: 1 }] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/spaces/ENG/roles/1',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).message).toBe('Role assignment removed');
    });

    it('should return 404 for non-existent assignment', async () => {
      // Default mock returns { rows: [], rowCount: 0 } which should trigger 404
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/spaces/ENG/roles/999',
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
