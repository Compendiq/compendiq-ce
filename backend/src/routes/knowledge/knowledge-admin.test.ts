import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

// --- Mock: quality-worker ---
const mockGetQualityStatus = vi.fn();
const mockForceQualityRescan = vi.fn();
vi.mock('../../domains/knowledge/services/quality-worker.js', () => ({
  getQualityStatus: (...args: unknown[]) => mockGetQualityStatus(...args),
  forceQualityRescan: (...args: unknown[]) => mockForceQualityRescan(...args),
}));

// --- Mock: summary-worker ---
const mockGetSummaryStatus = vi.fn();
const mockRescanAllSummaries = vi.fn();
const mockRegenerateSummary = vi.fn();
const mockRunSummaryBatch = vi.fn();
vi.mock('../../domains/knowledge/services/summary-worker.js', () => ({
  getSummaryStatus: (...args: unknown[]) => mockGetSummaryStatus(...args),
  rescanAllSummaries: (...args: unknown[]) => mockRescanAllSummaries(...args),
  regenerateSummary: (...args: unknown[]) => mockRegenerateSummary(...args),
  runSummaryBatch: (...args: unknown[]) => mockRunSummaryBatch(...args),
}));

// --- Mock: audit-service ---
vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

// --- Mock: logger ---
vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// --- Mock: postgres query ---
const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

import { knowledgeAdminRoutes } from './knowledge-admin.js';

// =============================================================================
// Test Suite 1: Auth required
// =============================================================================

describe('knowledge-admin routes - auth required', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async () => {
      throw app.httpErrors.unauthorized('Missing or invalid token');
    });
    app.decorate('requireAdmin', async () => {
      throw app.httpErrors.forbidden('Admin access required');
    });
    app.decorate('redis', {});

    await app.register(knowledgeAdminRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 401 for GET /api/llm/quality-status without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/llm/quality-status',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for POST /api/llm/quality-rescan without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/quality-rescan',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for GET /api/llm/summary-status without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/llm/summary-status',
    });

    expect(response.statusCode).toBe(401);
  });
});

// =============================================================================
// Test Suite 2: Admin-only endpoints reject non-admin
// =============================================================================

describe('knowledge-admin routes - admin role required', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async (request: { userId: string; userRole: string }) => {
      request.userId = 'regular-user';
      request.userRole = 'user';
    });
    app.decorate('requireAdmin', async () => {
      throw app.httpErrors.forbidden('Admin access required');
    });
    app.decorate('redis', {});
    app.decorateRequest('userId', '');

    await app.register(knowledgeAdminRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 403 for POST /api/llm/quality-rescan without admin role', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/quality-rescan',
    });

    expect(response.statusCode).toBe(403);
  });

  it('should return 403 for POST /api/llm/summary-rescan without admin role', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/summary-rescan',
    });

    expect(response.statusCode).toBe(403);
  });
});

// =============================================================================
// Test Suite 3: Happy path (authenticated user / admin)
// =============================================================================

describe('knowledge-admin routes - happy path', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed' });
      }
      reply.status(error.statusCode ?? 500).send({ error: error.message });
    });

    app.decorate('authenticate', async (request: { userId: string; userRole: string }) => {
      request.userId = 'admin-user';
      request.userRole = 'admin';
    });
    app.decorate('requireAdmin', async (request: { userId: string; userRole: string }) => {
      request.userId = 'admin-user';
      request.userRole = 'admin';
    });
    app.decorate('redis', {});
    app.decorateRequest('userId', '');

    await app.register(knowledgeAdminRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockRunSummaryBatch.mockResolvedValue(undefined);
  });

  it('should return quality status data', async () => {
    const qualityData = {
      totalPages: 200,
      analyzed: 150,
      pending: 50,
      averageScore: 72.5,
    };
    mockGetQualityStatus.mockResolvedValue(qualityData);

    const response = await app.inject({
      method: 'GET',
      url: '/api/llm/quality-status',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.totalPages).toBe(200);
    expect(body.analyzed).toBe(150);
    expect(body.averageScore).toBe(72.5);
  });

  it('should trigger quality rescan and return reset count', async () => {
    mockForceQualityRescan.mockResolvedValue(45);

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/quality-rescan',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pagesReset).toBe(45);
    expect(body.message).toContain('45');
  });

  it('should return summary status data', async () => {
    const summaryData = {
      totalPages: 100,
      summarized: 60,
      pending: 30,
      failed: 10,
    };
    mockGetSummaryStatus.mockResolvedValue(summaryData);

    const response = await app.inject({
      method: 'GET',
      url: '/api/llm/summary-status',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.totalPages).toBe(100);
    expect(body.summarized).toBe(60);
  });

  it('should trigger summary rescan and return reset count', async () => {
    mockRescanAllSummaries.mockResolvedValue(25);

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/summary-rescan',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.resetCount).toBe(25);
    expect(body.message).toContain('25');
  });

  it('should regenerate summary for a specific page', async () => {
    mockQueryFn.mockResolvedValue({ rows: [{ confluence_id: 'page-42' }] });
    mockRegenerateSummary.mockResolvedValue(undefined);

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/summary-regenerate/page-42',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pageId).toBe('page-42');
    expect(body.message).toContain('queued');
    expect(mockRegenerateSummary).toHaveBeenCalledWith('page-42');
  });

  it('should return 404 when regenerating summary for non-existent page', async () => {
    mockQueryFn.mockResolvedValue({ rows: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/summary-regenerate/non-existent',
    });

    expect(response.statusCode).toBe(404);
  });
});
