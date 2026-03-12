import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { adminRoutes } from './admin.js';

// Mock external dependencies
vi.mock('../core/utils/crypto.js', () => ({
  reEncryptPat: vi.fn().mockReturnValue(null),
}));

vi.mock('../core/services/audit-service.js', () => ({
  getAuditLog: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 50 }),
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock error tracker
vi.mock('../core/services/error-tracker.js', () => ({
  listErrors: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 50 }),
  resolveError: vi.fn().mockResolvedValue(true),
  getErrorSummary: vi.fn().mockResolvedValue({
    last24h: [{ errorType: 'Error', count: 5, lastOccurrence: new Date().toISOString() }],
    last7d: [],
    last30d: [],
    unresolvedCount: 3,
  }),
  trackError: vi.fn().mockResolvedValue(undefined),
}));

// Mock the database
vi.mock('../core/db/postgres.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { listErrors, resolveError, getErrorSummary } from '../core/services/error-tracker.js';
import { query as mockQuery } from '../core/db/postgres.js';

describe('Admin routes', () => {
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

    // Decorate with mock auth
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

    await app.register(adminRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ========================
  // Error monitoring routes
  // ========================

  describe('GET /api/admin/errors', () => {
    it('should return paginated errors', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/errors?page=1&limit=10',
      });

      expect(response.statusCode).toBe(200);
      expect(listErrors).toHaveBeenCalledWith({
        page: 1,
        limit: 10,
        errorType: undefined,
        resolved: undefined,
      });
    });

    it('should filter by error type', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/errors?errorType=TypeError',
      });

      expect(response.statusCode).toBe(200);
      expect(listErrors).toHaveBeenCalledWith(
        expect.objectContaining({ errorType: 'TypeError' }),
      );
    });

    it('should filter by resolved status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/errors?resolved=false',
      });

      expect(response.statusCode).toBe(200);
      expect(listErrors).toHaveBeenCalledWith(
        expect.objectContaining({ resolved: false }),
      );
    });
  });

  describe('PUT /api/admin/errors/:id/resolve', () => {
    it('should resolve an error', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/errors/some-uuid/resolve',
      });

      expect(response.statusCode).toBe(200);
      expect(resolveError).toHaveBeenCalledWith('some-uuid');
      expect(JSON.parse(response.body).message).toBe('Error marked as resolved');
    });

    it('should return 404 for non-existent error', async () => {
      (resolveError as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/errors/nonexistent-id/resolve',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /api/admin/errors/summary', () => {
    it('should return error summary', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/errors/summary',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('last24h');
      expect(body).toHaveProperty('last7d');
      expect(body).toHaveProperty('last30d');
      expect(body).toHaveProperty('unresolvedCount');
      expect(body.unresolvedCount).toBe(3);
      expect(getErrorSummary).toHaveBeenCalled();
    });
  });

  // ========================
  // Label management routes
  // ========================

  describe('GET /api/admin/labels', () => {
    it('should return all labels with counts', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [
          { label: 'architecture', page_count: 5 },
          { label: 'howto', page_count: 12 },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/labels',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toEqual([
        { name: 'architecture', pageCount: 5 },
        { name: 'howto', pageCount: 12 },
      ]);
    });

    it('should return empty array when no labels exist', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/labels',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual([]);
    });
  });

  describe('PUT /api/admin/labels/rename', () => {
    it('should rename a label across all pages', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 5 });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/labels/rename',
        payload: { oldName: 'old-label', newName: 'new-label' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toContain('renamed');
      expect(body.affectedPages).toBe(5);
    });

    it('should reject when oldName equals newName', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/labels/rename',
        payload: { oldName: 'same', newName: 'same' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject when names are missing', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/labels/rename',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/admin/labels/:name', () => {
    it('should remove a label from all pages', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 3 });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/admin/labels/obsolete-label',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toContain('removed');
      expect(body.affectedPages).toBe(3);
    });
  });
});
