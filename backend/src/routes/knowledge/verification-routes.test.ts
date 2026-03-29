import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

// Hoisted mocks
const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });

vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

const mockGetUserAccessibleSpaces = vi.fn().mockResolvedValue(['TEST', 'DEV']);
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { verificationRoutes } from './verification.js';

const TEST_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VALID_OWNER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function buildApp(opts?: { rejectAuth?: boolean }) {
  const app = Fastify({ logger: false });
  app.register(sensible);

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

  if (opts?.rejectAuth) {
    app.decorate('authenticate', async (_request: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
      reply.code(401).send({ error: 'Unauthorized', statusCode: 401 });
    });
  } else {
    app.decorate('authenticate', async (request: { userId: string; userRole: string }) => {
      request.userId = TEST_USER_ID;
      request.userRole = 'admin';
    });
  }

  app.register(verificationRoutes, { prefix: '/api' });
  return app;
}

// ---------------------------------------------------------------------------
// Main test suite (authenticated)
// ---------------------------------------------------------------------------
describe('Verification routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockGetUserAccessibleSpaces.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockGetUserAccessibleSpaces.mockResolvedValue(['TEST', 'DEV']);
  });

  // -------------------------------------------------------------------------
  // POST /api/pages/:id/verify
  // -------------------------------------------------------------------------
  describe('POST /api/pages/:id/verify', () => {
    it('should return 200 and { success: true } when page exists and user has access', async () => {
      // assertPageAccess query — page found
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }] });
      // UPDATE pages ... RETURNING id
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/42/verify',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);

      // assertPageAccess should call getUserAccessibleSpaces
      expect(mockGetUserAccessibleSpaces).toHaveBeenCalledWith(TEST_USER_ID);

      // Verify the UPDATE was called with userId and pageId
      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[0]).toContain('UPDATE pages SET');
      expect(updateCall[0]).toContain('verified_by');
      expect(updateCall[1]).toEqual([TEST_USER_ID, 42]);
    });

    it('should return 404 when page is not found', async () => {
      // assertPageAccess query — no rows
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/999/verify',
      });

      expect(response.statusCode).toBe(404);
    });

    it('should accept confluence_id (non-numeric) as page identifier', async () => {
      // assertPageAccess with non-numeric id uses confluence_id column
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 7 }] });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/conf-abc-123/verify',
      });

      expect(response.statusCode).toBe(200);

      // The assertPageAccess query should use confluence_id for non-numeric ids
      const accessQuery = mockQuery.mock.calls[0][0] as string;
      expect(accessQuery).toContain('p.confluence_id = $2');
    });
  });

  // -------------------------------------------------------------------------
  // PUT /api/pages/:id/owner
  // -------------------------------------------------------------------------
  describe('PUT /api/pages/:id/owner', () => {
    it('should return 200 and { success: true } when assigning a valid owner', async () => {
      // assertPageAccess — page found
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }] });
      // Owner user exists check
      mockQuery.mockResolvedValueOnce({ rows: [{ id: VALID_OWNER_ID }] });
      // UPDATE pages SET owner_id
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/42/owner',
        payload: { ownerId: VALID_OWNER_ID },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);

      // Verify the owner update query
      const updateCall = mockQuery.mock.calls[2];
      expect(updateCall[0]).toContain('UPDATE pages SET owner_id');
      expect(updateCall[1]).toEqual([VALID_OWNER_ID, 42]);
    });

    it('should return 400 for invalid ownerId (not a UUID)', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/42/owner',
        payload: { ownerId: 'not-a-uuid' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 when owner user is not found', async () => {
      // assertPageAccess — page found
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }] });
      // Owner user check — no rows
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/42/owner',
        payload: { ownerId: VALID_OWNER_ID },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.message || body.error).toContain('Owner user not found');
    });

    it('should return 404 when page is not found', async () => {
      // assertPageAccess — no rows
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/999/owner',
        payload: { ownerId: VALID_OWNER_ID },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // PUT /api/pages/:id/review-interval
  // -------------------------------------------------------------------------
  describe('PUT /api/pages/:id/review-interval', () => {
    it('should return 200 and { success: true } with valid days', async () => {
      // assertPageAccess — page found
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }] });
      // UPDATE pages SET review_interval_days
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/42/review-interval',
        payload: { days: 30 },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);

      // Verify the update query received the correct days value
      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[0]).toContain('review_interval_days');
      expect(updateCall[1]).toEqual([30, 42]);
    });

    it('should return 400 for days = 0 (below minimum)', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/42/review-interval',
        payload: { days: 0 },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for days > 365 (above maximum)', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/42/review-interval',
        payload: { days: 366 },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for non-integer days', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/42/review-interval',
        payload: { days: 30.5 },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should accept boundary values (1 and 365)', async () => {
      // days = 1
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }] });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 });

      const response1 = await app.inject({
        method: 'PUT',
        url: '/api/pages/42/review-interval',
        payload: { days: 1 },
      });
      expect(response1.statusCode).toBe(200);

      mockQuery.mockReset();
      mockGetUserAccessibleSpaces.mockReset();
      mockGetUserAccessibleSpaces.mockResolvedValue(['TEST', 'DEV']);

      // days = 365
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }] });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 });

      const response365 = await app.inject({
        method: 'PUT',
        url: '/api/pages/42/review-interval',
        payload: { days: 365 },
      });
      expect(response365.statusCode).toBe(200);
    });

    it('should return 404 when page is not found', async () => {
      // assertPageAccess — no rows
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/pages/999/review-interval',
        payload: { days: 30 },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/analytics/verification-health
  // -------------------------------------------------------------------------
  describe('GET /api/analytics/verification-health', () => {
    it('should return health stats with correct shape', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          fresh: '10',
          aging: '5',
          overdue: '3',
          unverified: '12',
          total: '30',
        }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analytics/verification-health',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toEqual({
        fresh: 10,
        aging: 5,
        overdue: 3,
        unverified: 12,
        total: 30,
      });
    });

    it('should return all zeros when no pages exist', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          fresh: '0',
          aging: '0',
          overdue: '0',
          unverified: '0',
          total: '0',
        }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analytics/verification-health',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.fresh).toBe(0);
      expect(body.aging).toBe(0);
      expect(body.overdue).toBe(0);
      expect(body.unverified).toBe(0);
      expect(body.total).toBe(0);
    });

    it('should parse string counts from PostgreSQL into integers', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          fresh: '999',
          aging: '0',
          overdue: '1',
          unverified: '50',
          total: '1050',
        }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analytics/verification-health',
      });

      const body = JSON.parse(response.body);
      // All values should be numbers, not strings
      expect(typeof body.fresh).toBe('number');
      expect(typeof body.aging).toBe('number');
      expect(typeof body.overdue).toBe('number');
      expect(typeof body.unverified).toBe('number');
      expect(typeof body.total).toBe('number');
    });
  });
});

// ---------------------------------------------------------------------------
// Auth rejection suite (unauthenticated)
// ---------------------------------------------------------------------------
describe('Verification routes — unauthenticated', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = buildApp({ rejectAuth: true });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /api/pages/:id/verify returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/42/verify',
    });

    expect(response.statusCode).toBe(401);
  });

  it('PUT /api/pages/:id/owner returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/42/owner',
      payload: { ownerId: VALID_OWNER_ID },
    });

    expect(response.statusCode).toBe(401);
  });

  it('PUT /api/pages/:id/review-interval returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/42/review-interval',
      payload: { days: 30 },
    });

    expect(response.statusCode).toBe(401);
  });

  it('GET /api/analytics/verification-health returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/analytics/verification-health',
    });

    expect(response.statusCode).toBe(401);
  });
});
