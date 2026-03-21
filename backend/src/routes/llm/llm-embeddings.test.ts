import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// --- Mock: embedding-service ---
const mockGetEmbeddingStatus = vi.fn();
const mockIsProcessingUser = vi.fn();
const mockProcessDirtyPages = vi.fn();
const mockReEmbedAll = vi.fn();
const mockResetFailedEmbeddings = vi.fn();
const mockEmbedPage = vi.fn();
vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  getEmbeddingStatus: (...args: unknown[]) => mockGetEmbeddingStatus(...args),
  processDirtyPages: (...args: unknown[]) => mockProcessDirtyPages(...args),
  reEmbedAll: (...args: unknown[]) => mockReEmbedAll(...args),
  isProcessingUser: (...args: unknown[]) => mockIsProcessingUser(...args),
  resetFailedEmbeddings: (...args: unknown[]) => mockResetFailedEmbeddings(...args),
  embedPage: (...args: unknown[]) => mockEmbedPage(...args),
}));

// --- Mock: postgres query ---
const mockQueryFn = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// --- Mock: content-converter ---
vi.mock('../../core/services/content-converter.js', () => ({
  confluenceToHtml: vi.fn().mockReturnValue('<p>content</p>'),
}));

// --- Mock: sync-service ---
vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: vi.fn().mockResolvedValue(null),
}));

// --- Mock: logger ---
vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { llmEmbeddingRoutes } from './llm-embeddings.js';

// =============================================================================
// Test Suite 1: Auth required
// =============================================================================

describe('llm-embeddings routes - auth required', () => {
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

    await app.register(llmEmbeddingRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 401 for GET /api/embeddings/status without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/embeddings/status',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for POST /api/embeddings/process without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/embeddings/process',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 401 for POST /api/admin/re-embed without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/re-embed',
    });

    expect(response.statusCode).toBe(401);
  });
});

// =============================================================================
// Test Suite 2: GET /api/embeddings/status
// =============================================================================

describe('GET /api/embeddings/status', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = 'test-user-123';
    });
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');

    await app.register(llmEmbeddingRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return embedding status for the authenticated user', async () => {
    const statusData = {
      total: 100,
      embedded: 80,
      pending: 15,
      failed: 5,
      processing: false,
    };
    mockGetEmbeddingStatus.mockResolvedValue(statusData);

    const response = await app.inject({
      method: 'GET',
      url: '/api/embeddings/status',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(100);
    expect(body.embedded).toBe(80);
    expect(body.failed).toBe(5);
    expect(mockGetEmbeddingStatus).toHaveBeenCalledWith('test-user-123');
  });
});

// =============================================================================
// Test Suite 3: POST /api/embeddings/process - SSE conflict check
// =============================================================================

describe('POST /api/embeddings/process - conflict', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = 'test-user-123';
    });
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');

    await app.register(llmEmbeddingRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 409 when embedding is already in progress', async () => {
    mockIsProcessingUser.mockResolvedValue(true);

    const response = await app.inject({
      method: 'POST',
      url: '/api/embeddings/process',
    });

    expect(response.statusCode).toBe(409);
  });
});

// =============================================================================
// Test Suite 4: POST /api/admin/re-embed - admin only
// =============================================================================

describe('POST /api/admin/re-embed - admin access', () => {
  it('should return 403 when non-admin calls re-embed', async () => {
    const app = Fastify({ logger: false });
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

    await app.register(llmEmbeddingRoutes, { prefix: '/api' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/re-embed',
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('should start re-embedding when called by admin', async () => {
    const app = Fastify({ logger: false });
    await app.register(sensible);

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

    await app.register(llmEmbeddingRoutes, { prefix: '/api' });
    await app.ready();

    mockReEmbedAll.mockResolvedValue(undefined);

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/re-embed',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.message).toContain('Re-embedding started');
    await app.close();
  });
});
