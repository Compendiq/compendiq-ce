import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { knowledgeRequestRoutes } from './knowledge-requests.js';

const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

describe('Knowledge Requests API', () => {
  let app: ReturnType<typeof Fastify>;
  const testUserId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const otherUserId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

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

    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = testUserId;
      request.username = 'testuser';
      request.userRole = 'user';
    });
    app.decorate('requireAdmin', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = testUserId;
      request.username = 'testuser';
      request.userRole = 'admin';
    });
    app.decorate('redis', {});

    await app.register(knowledgeRequestRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/knowledge-requests', () => {
    it('should create a knowledge request with defaults', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 1, created_at: new Date('2026-01-15T10:00:00Z') }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/knowledge-requests',
        payload: { title: 'How to deploy to staging' },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.id).toBe(1);
      expect(body.title).toBe('How to deploy to staging');
      expect(body.priority).toBe('normal');
      expect(body.status).toBe('open');
      expect(body.description).toBeNull();

      // Verify the INSERT query was called with correct params
      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO knowledge_requests'),
        ['How to deploy to staging', null, testUserId, 'normal', null],
      );
    });

    it('should create a request with description and high priority', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 2, created_at: new Date('2026-01-15T10:00:00Z') }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/knowledge-requests',
        payload: {
          title: 'Kubernetes troubleshooting guide',
          description: 'Need a comprehensive guide for debugging K8s pod issues',
          priority: 'high',
          spaceKey: 'OPS',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.title).toBe('Kubernetes troubleshooting guide');
      expect(body.priority).toBe('high');
    });

    it('should reject empty title', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/knowledge-requests',
        payload: { title: '' },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/knowledge-requests', () => {
    it('should return paginated list of requests', async () => {
      // count query
      mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 });
      // list query
      mockQueryFn.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            title: 'Request 1',
            description: null,
            requested_by: testUserId,
            requester_username: 'testuser',
            assigned_to: null,
            assignee_username: null,
            space_key: null,
            status: 'open',
            fulfilled_by_page_id: null,
            priority: 'high',
            created_at: new Date('2026-01-15T10:00:00Z'),
            updated_at: new Date('2026-01-15T10:00:00Z'),
          },
          {
            id: 2,
            title: 'Request 2',
            description: 'Some description',
            requested_by: otherUserId,
            requester_username: 'otheruser',
            assigned_to: testUserId,
            assignee_username: 'testuser',
            space_key: 'DEV',
            status: 'in_progress',
            fulfilled_by_page_id: null,
            priority: 'normal',
            created_at: new Date('2026-01-14T10:00:00Z'),
            updated_at: new Date('2026-01-15T12:00:00Z'),
          },
        ],
        rowCount: 2,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/knowledge-requests',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.items).toHaveLength(2);
      expect(body.total).toBe(2);
      expect(body.page).toBe(1);
      expect(body.limit).toBe(50);
      expect(body.items[0].requestedBy.username).toBe('testuser');
      expect(body.items[1].assignedTo?.username).toBe('testuser');
    });

    it('should filter by status', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'GET',
        url: '/api/knowledge-requests?status=open',
      });

      expect(response.statusCode).toBe(200);
      // Verify the WHERE clause included status filter
      expect(mockQueryFn.mock.calls[0][0]).toContain('kr.status = $1');
      expect(mockQueryFn.mock.calls[0][1]).toEqual(['open']);
    });

    it('should filter by assignedToMe', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'GET',
        url: '/api/knowledge-requests?assignedToMe=true',
      });

      expect(response.statusCode).toBe(200);
      expect(mockQueryFn.mock.calls[0][0]).toContain('kr.assigned_to = $1');
      expect(mockQueryFn.mock.calls[0][1]).toEqual([testUserId]);
    });
  });

  describe('GET /api/knowledge-requests/:id', () => {
    it('should return a single request', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{
          id: 1,
          title: 'Deploy guide',
          description: 'Need a deploy guide',
          requested_by: testUserId,
          requester_username: 'testuser',
          assigned_to: null,
          assignee_username: null,
          space_key: 'OPS',
          status: 'open',
          fulfilled_by_page_id: null,
          priority: 'normal',
          created_at: new Date('2026-01-15T10:00:00Z'),
          updated_at: new Date('2026-01-15T10:00:00Z'),
        }],
        rowCount: 1,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/knowledge-requests/1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe(1);
      expect(body.title).toBe('Deploy guide');
      expect(body.spaceKey).toBe('OPS');
    });

    it('should return 404 for non-existent request', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'GET',
        url: '/api/knowledge-requests/999',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PATCH /api/knowledge-requests/:id', () => {
    it('should update status and assignee', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/knowledge-requests/1',
        payload: {
          status: 'in_progress',
          assignedTo: otherUserId,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.updated).toBe(true);

      // Verify the UPDATE query includes both fields
      const updateCall = mockQueryFn.mock.calls[0];
      expect(updateCall[0]).toContain('assigned_to');
      expect(updateCall[0]).toContain('status');
      expect(updateCall[0]).toContain('updated_at = NOW()');
    });

    it('should return 400 when no fields provided', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/knowledge-requests/1',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 404 for non-existent request', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/knowledge-requests/999',
        payload: { priority: 'high' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /api/knowledge-requests/:id/fulfill', () => {
    it('should fulfill a request by linking a page', async () => {
      // page existence check
      mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 });
      // update query
      mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/knowledge-requests/1/fulfill',
        payload: { pageId: 42 },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.fulfilled).toBe(true);
      expect(body.pageId).toBe(42);

      // Verify status set to completed
      const updateCall = mockQueryFn.mock.calls[1];
      expect(updateCall[0]).toContain("status = 'completed'");
      expect(updateCall[0]).toContain('fulfilled_by_page_id = $1');
    });

    it('should return 404 when page does not exist', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/knowledge-requests/1/fulfill',
        payload: { pageId: 999 },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/knowledge-requests/:id', () => {
    it('should delete a request owned by the current user', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/knowledge-requests/1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.deleted).toBe(true);

      // Verify the DELETE includes requester check
      expect(mockQueryFn.mock.calls[0][0]).toContain('requested_by = $2');
      expect(mockQueryFn.mock.calls[0][1]).toEqual([1, testUserId]);
    });

    it('should return 404 when request not found or not owned by user', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/knowledge-requests/999',
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
