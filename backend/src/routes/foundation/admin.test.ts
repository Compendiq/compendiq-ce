import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { adminRoutes } from './admin.js';

// Mock external dependencies
vi.mock('../../core/utils/crypto.js', () => ({
  reEncryptPat: vi.fn().mockReturnValue(null),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  getAuditLog: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 50 }),
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock error tracker
vi.mock('../../core/services/error-tracker.js', () => ({
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
vi.mock('../../core/db/postgres.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// LLM provider + per-use-case assignment routes have moved to
// `/admin/llm-providers` + `/admin/llm-usecases` — see the dedicated tests in
// `backend/src/routes/llm/llm-providers.test.ts` and `.../llm-usecases.test.ts`.
// Here we only need to stub `getEmbeddingDimensions` which is read by
// `GET /admin/settings` for the `embeddingDimensions` response field.
vi.mock('../../core/services/admin-settings-service.js', () => ({
  getEmbeddingDimensions: vi.fn().mockResolvedValue(1024),
  getAdminAccessDeniedRetentionDays: vi.fn().mockResolvedValue(90),
}));

import { listErrors, resolveError, getErrorSummary } from '../../core/services/error-tracker.js';
import { query as mockQuery } from '../../core/db/postgres.js';
import { _resetStreamCapCache } from '../../core/services/sse-stream-limiter.js';
import { _resetCache as _resetRateLimitsCache } from '../../core/services/rate-limit-service.js';
import { getAdminAccessDeniedRetentionDays as mockGetAdminAccessDeniedRetentionDays } from '../../core/services/admin-settings-service.js';

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
    // Reset in-module caches that read from admin_settings so each test sees
    // a fresh mocked `query()` result.
    _resetStreamCapCache();
    _resetRateLimitsCache();
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

  // ========================
  // Admin settings routes (draw.io URL)
  // ========================

  describe('GET /api/admin/settings - drawioEmbedUrl', () => {
    it('returns drawioEmbedUrl as null when not configured', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [
          { setting_key: 'embedding_chunk_size', setting_value: '500' },
          { setting_key: 'embedding_chunk_overlap', setting_value: '50' },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.drawioEmbedUrl).toBeNull();
      expect(body.embeddingChunkSize).toBe(500);
      expect(body.embeddingChunkOverlap).toBe(50);
    });

    it('returns drawioEmbedUrl when configured', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [
          { setting_key: 'embedding_chunk_size', setting_value: '500' },
          { setting_key: 'embedding_chunk_overlap', setting_value: '50' },
          { setting_key: 'drawio_embed_url', setting_value: 'https://my-drawio.internal' },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.drawioEmbedUrl).toBe('https://my-drawio.internal');
    });
  });

  // LLM provider + per-use-case-assignment routes moved to
  // /admin/llm-providers and /admin/llm-usecases — tested in dedicated files.

  describe('GET /api/admin/settings - llmMaxConcurrentStreamsPerUser (#268)', () => {
    it('returns the configured cap when the admin_settings row is present', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockImplementation(
        async (sql: string, params?: unknown[]) => {
          if (
            typeof sql === 'string'
            && sql.includes('SELECT setting_value FROM admin_settings')
            && params?.[0] === 'llm_max_concurrent_streams_per_user'
          ) {
            return { rows: [{ setting_value: '7' }] };
          }
          // Default response for the multi-key admin-settings SELECT.
          return { rows: [] };
        },
      );

      const response = await app.inject({ method: 'GET', url: '/api/admin/settings' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.llmMaxConcurrentStreamsPerUser).toBe(7);
    });

    it('returns the hard default (3) when the admin_settings row is absent', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      const response = await app.inject({ method: 'GET', url: '/api/admin/settings' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.llmMaxConcurrentStreamsPerUser).toBe(3);
    });
  });

  describe('PUT /api/admin/settings - llmMaxConcurrentStreamsPerUser (#268)', () => {
    it('upserts the cap via admin_settings and invalidates the cache', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { llmMaxConcurrentStreamsPerUser: 5 },
      });

      expect(response.statusCode).toBe(200);

      // Verify the key+value were written as an INSERT … ON CONFLICT upsert.
      const calls = (mockQuery as ReturnType<typeof vi.fn>).mock.calls as Array<[string, ...unknown[]]>;
      const upsert = calls.find(([sql, params]) =>
        typeof sql === 'string'
        && sql.includes('INSERT INTO admin_settings')
        && Array.isArray(params)
        && (params as unknown[])[0] === 'llm_max_concurrent_streams_per_user'
        && (params as unknown[])[1] === '5',
      );
      expect(upsert).toBeDefined();
    });

    it('rejects values outside [1, 20]', async () => {
      const low = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { llmMaxConcurrentStreamsPerUser: 0 },
      });
      expect(low.statusCode).toBe(400);

      const high = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { llmMaxConcurrentStreamsPerUser: 21 },
      });
      expect(high.statusCode).toBe(400);
    });

    it('rejects non-integer values', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { llmMaxConcurrentStreamsPerUser: 3.5 },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('PUT /api/admin/settings - drawioEmbedUrl only (no re-embedding)', () => {
    it('saves drawioEmbedUrl and does NOT trigger embedding_dirty update', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { drawioEmbedUrl: 'https://my-drawio.internal' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Admin settings updated');

      // Verify that no UPDATE pages SET embedding_dirty query was made
      const calls = (mockQuery as ReturnType<typeof vi.fn>).mock.calls as Array<[string, ...unknown[]]>;
      const embeddingDirtyCall = calls.find(([sql]) =>
        typeof sql === 'string' && sql.includes('embedding_dirty'),
      );
      expect(embeddingDirtyCall).toBeUndefined();
    });

    it('rejects invalid URL for drawioEmbedUrl', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { drawioEmbedUrl: 'not-a-valid-url' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects empty string for drawioEmbedUrl (use null to clear)', async () => {
      // Prior contract silently accepted '' and treated it as clear; the new
      // tri-state contract requires callers to send explicit null instead.
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { drawioEmbedUrl: '' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('clears drawioEmbedUrl when explicit null is sent', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { drawioEmbedUrl: null },
      });

      expect(response.statusCode).toBe(200);

      // The handler must issue a DELETE against admin_settings for drawio_embed_url.
      const calls = (mockQuery as ReturnType<typeof vi.fn>).mock.calls as Array<[string, ...unknown[]]>;
      const deleteCall = calls.find(([sql]) =>
        typeof sql === 'string'
        && sql.includes('DELETE FROM admin_settings')
        && sql.includes('drawio_embed_url'),
      );
      expect(deleteCall).toBeDefined();

      // And must NOT queue an upsert for the same key — the if/else branch is
      // mutually exclusive, so both paths executing would indicate a regression.
      const upsertCall = calls.find(([sql, ...params]) =>
        typeof sql === 'string'
        && sql.includes('INSERT INTO admin_settings')
        && params.some((p) => p === 'drawio_embed_url'),
      );
      expect(upsertCall).toBeUndefined();
    });
  });

  describe('PUT /api/admin/settings - embeddingChunkSize + drawioEmbedUrl (re-embedding triggered)', () => {
    it('triggers embedding_dirty update when chunk settings change alongside drawioEmbedUrl', async () => {
      // Mock responses: first for the current chunk values fetch, then for the upserts, then for the dirty update
      (mockQuery as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // upsert chunk size
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // upsert drawio url
        .mockResolvedValueOnce({ rows: [], rowCount: 100 }); // UPDATE pages SET embedding_dirty = TRUE

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { embeddingChunkSize: 512, drawioEmbedUrl: 'https://my-drawio.internal' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      // When chunk settings change, the re-embedding message should be returned
      expect(body.message).toBe('Admin settings updated, all pages queued for re-embedding');

      // Verify that UPDATE pages SET embedding_dirty WAS called
      const calls = (mockQuery as ReturnType<typeof vi.fn>).mock.calls as Array<[string, ...unknown[]]>;
      const embeddingDirtyCall = calls.find(([sql]) =>
        typeof sql === 'string' && sql.includes('embedding_dirty'),
      );
      expect(embeddingDirtyCall).toBeDefined();
    });
  });

  // ─── Plan §2.7 / §4.5 RED #11 — reembedHistoryRetention wiring ──────────
  describe('reembedHistoryRetention (issue #257)', () => {
    it('GET /api/admin/settings returns 150 when no row is stored (default)', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [
          { setting_key: 'embedding_chunk_size', setting_value: '500' },
          { setting_key: 'embedding_chunk_overlap', setting_value: '50' },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.reembedHistoryRetention).toBe(150);
    });

    it('GET /api/admin/settings reflects the persisted admin_settings row', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [
          { setting_key: 'embedding_chunk_size', setting_value: '500' },
          { setting_key: 'embedding_chunk_overlap', setting_value: '50' },
          { setting_key: 'reembed_history_retention', setting_value: '500' },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/settings',
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).reembedHistoryRetention).toBe(500);
    });

    it('PUT /api/admin/settings persists reembedHistoryRetention via UPSERT', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { reembedHistoryRetention: 500 },
      });

      expect(response.statusCode).toBe(200);
      const calls = (mockQuery as ReturnType<typeof vi.fn>).mock.calls as Array<[string, ...unknown[]]>;
      const upsert = calls.find(([sql, args]) =>
        typeof sql === 'string' &&
        sql.includes('INSERT INTO admin_settings') &&
        Array.isArray(args) &&
        args[0] === 'reembed_history_retention',
      );
      expect(upsert).toBeTruthy();
      // Persisted as text — the value is stringified.
      expect((upsert![1] as unknown[])[1]).toBe('500');
    });

    it('PUT rejects values below 10 with 400 (validated by Zod)', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { reembedHistoryRetention: 5 },
      });
      expect(response.statusCode).toBe(400);
    });

    it('PUT rejects values above 10000 with 400', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { reembedHistoryRetention: 10_001 },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // ─── #264 — adminAccessDeniedRetentionDays wiring ───────────────────────
  describe('adminAccessDeniedRetentionDays (issue #264)', () => {
    it('GET /api/admin/settings returns the value produced by the getter (90 default)', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
      (mockGetAdminAccessDeniedRetentionDays as ReturnType<typeof vi.fn>).mockResolvedValueOnce(90);

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/settings',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).adminAccessDeniedRetentionDays).toBe(90);
    });

    it('GET /api/admin/settings reflects a custom getter value (e.g. 30 after admin-PUT)', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
      (mockGetAdminAccessDeniedRetentionDays as ReturnType<typeof vi.fn>).mockResolvedValueOnce(30);

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/settings',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).adminAccessDeniedRetentionDays).toBe(30);
    });

    it('PUT /api/admin/settings persists adminAccessDeniedRetentionDays via UPSERT', async () => {
      (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [], rowCount: 0 });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { adminAccessDeniedRetentionDays: 30 },
      });

      expect(response.statusCode).toBe(200);
      const calls = (mockQuery as ReturnType<typeof vi.fn>).mock.calls as Array<[string, ...unknown[]]>;
      const upsert = calls.find(([sql, args]) =>
        typeof sql === 'string' &&
        sql.includes('INSERT INTO admin_settings') &&
        Array.isArray(args) &&
        args[0] === 'admin_access_denied_retention_days',
      );
      expect(upsert).toBeTruthy();
      // Persisted as text — the value is stringified.
      expect((upsert![1] as unknown[])[1]).toBe('30');
    });

    it('PUT rejects values below 7 with 400 (validated by Zod)', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { adminAccessDeniedRetentionDays: 6 },
      });
      expect(response.statusCode).toBe(400);
    });

    it('PUT rejects values above 3650 with 400', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { adminAccessDeniedRetentionDays: 3651 },
      });
      expect(response.statusCode).toBe(400);
    });

    it('PUT rejects non-integer values with 400', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { adminAccessDeniedRetentionDays: 30.5 },
      });
      expect(response.statusCode).toBe(400);
    });
  });
});

describe('Admin routes - non-admin access guard', () => {
  let nonAdminApp: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    nonAdminApp = Fastify({ logger: false });
    await nonAdminApp.register(sensible);

    nonAdminApp.setErrorHandler((error, _request, reply) => {
      reply.status(error.statusCode ?? 500).send({ error: error.message, statusCode: error.statusCode ?? 500 });
    });

    // Simulate a non-admin user: authenticate populates the request, requireAdmin rejects
    nonAdminApp.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'regular-user-id';
      request.username = 'regular';
      request.userRole = 'user';
    });
    nonAdminApp.decorate('requireAdmin', async (request: { userId: string; username: string; userRole: string }, reply: { code: (n: number) => { send: (body: unknown) => void } }) => {
      request.userId = 'regular-user-id';
      request.username = 'regular';
      request.userRole = 'user';
      reply.code(403).send({ error: 'Admin access required', statusCode: 403 });
    });

    await nonAdminApp.register(adminRoutes, { prefix: '/api' });
    await nonAdminApp.ready();
  });

  afterAll(async () => {
    await nonAdminApp.close();
  });

  it('should reject non-admin users on GET /api/admin/settings with 403', async () => {
    const response = await nonAdminApp.inject({
      method: 'GET',
      url: '/api/admin/settings',
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Admin access required');
  });

  it('should reject non-admin users on PUT /api/admin/settings with 403', async () => {
    const response = await nonAdminApp.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { llmProvider: 'openai' },
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Admin access required');
  });
});
