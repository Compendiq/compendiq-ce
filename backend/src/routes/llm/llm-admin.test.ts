import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { isDbAvailable, setupTestDb } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';

// --- Mock: llm-cache ---
const mockClearAll = vi.fn();
vi.mock('../../domains/llm/services/llm-cache.js', () => {
  class MockLlmCache {
    clearAll = (...args: unknown[]) => mockClearAll(...args);
  }
  return { LlmCache: MockLlmCache };
});

// --- Mock: mcp-docs-client (the sidecar boundary; the SearXNG tests below assert the width it is asked for) ---
const mockSearchDocumentation = vi.fn();
vi.mock('../../core/services/mcp-docs-client.js', () => ({
  testConnection: vi.fn(),
  fetchDocumentation: vi.fn(),
  searchDocumentation: (...args: unknown[]) => mockSearchDocumentation(...args),
}));

import { llmAdminRoutes } from './llm-admin.js';

const dbAvailable = await isDbAvailable();

// =============================================================================
// Test Suite 1: Auth + admin role required
// =============================================================================

describe('llm-admin routes - auth required', () => {
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

    await app.register(llmAdminRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 401 for POST /api/admin/clear-llm-cache without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/clear-llm-cache',
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('llm-admin routes - non-admin rejected', () => {
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

    await app.register(llmAdminRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 403 for POST /api/admin/clear-llm-cache without admin role', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/clear-llm-cache',
    });

    expect(response.statusCode).toBe(403);
  });
});

// =============================================================================
// Test Suite 2: Happy path (admin user)
// =============================================================================

describe('POST /api/admin/clear-llm-cache - admin', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
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

    await app.register(llmAdminRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should clear LLM cache and return deleted count', async () => {
    mockClearAll.mockResolvedValue(15);

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/clear-llm-cache',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.message).toContain('cache cleared');
    expect(body.entriesDeleted).toBe(15);
    expect(mockClearAll).toHaveBeenCalledOnce();
  });

  it('should return 0 when cache is already empty', async () => {
    mockClearAll.mockResolvedValue(0);

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/clear-llm-cache',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.entriesDeleted).toBe(0);
  });
});

// =============================================================================
// Test Suite 3: SearXNG admin routes — shared result limit (#1768)
// =============================================================================

describe.skipIf(!dbAvailable)('SearXNG admin routes — shared result limit (#1768)', () => {
  let app: ReturnType<typeof Fastify>;

  const fakeResults = [
    { title: 'Result 1', url: 'https://example.test/1', snippet: 's1' },
    { title: 'Result 2', url: 'https://example.test/2', snippet: 's2' },
    { title: 'Result 3', url: 'https://example.test/3', snippet: 's3' },
    { title: 'Result 4', url: 'https://example.test/4', snippet: 's4' },
  ];

  async function storeMaxResults(value: string): Promise<void> {
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ('searxng_max_results', $1, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = NOW()`,
      [value],
    );
  }

  beforeAll(async () => {
    await setupTestDb();

    app = Fastify({ logger: false });
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
    // Match the production error handler for Zod validation errors (app.ts).
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

    await app.register(llmAdminRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSearchDocumentation.mockResolvedValue(fakeResults);
    await query(`DELETE FROM admin_settings WHERE setting_key LIKE 'searxng_%'`);
  });

  // The worker DB is shared with every other suite: leave no SearXNG row behind.
  // `searxng_max_results` is the only key these tests write (PUT sends maxResults alone).
  afterEach(async () => {
    await query(`DELETE FROM admin_settings WHERE setting_key = 'searxng_max_results'`);
  });

  it('PUT /api/admin/searxng rejects maxResults above the sidecar limit with 400 and persists nothing', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/admin/searxng',
      payload: { maxResults: 11 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('ValidationError');
    expect(response.json().message).toContain('maxResults');
    const stored = await query(`SELECT setting_value FROM admin_settings WHERE setting_key = 'searxng_max_results'`);
    expect(stored.rows).toHaveLength(0);
  });

  it('PUT then GET round-trips the sidecar maximum (10)', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/admin/searxng', payload: { maxResults: 10 } });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({ method: 'GET', url: '/api/admin/searxng' });
    expect(get.statusCode).toBe(200);
    expect(get.json().maxResults).toBe(10);
  });

  it('GET /api/admin/searxng reports the effective count for a stale out-of-range row', async () => {
    await storeMaxResults('15');

    const response = await app.inject({ method: 'GET', url: '/api/admin/searxng' });

    expect(response.statusCode).toBe(200);
    expect(response.json().maxResults).toBe(10);
  });

  it('POST /api/admin/searxng/test searches with the saved count', async () => {
    await storeMaxResults('7');

    const response = await app.inject({ method: 'POST', url: '/api/admin/searxng/test' });

    expect(response.statusCode).toBe(200);
    expect(mockSearchDocumentation).toHaveBeenCalledWith('test connection', 'admin-user', 7);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.resultCount).toBe(4);
    expect(body.sample).toHaveLength(3);
  });

  it('POST /api/admin/searxng/test clamps a stale stored count to the sidecar limit', async () => {
    await storeMaxResults('15');

    await app.inject({ method: 'POST', url: '/api/admin/searxng/test' });

    expect(mockSearchDocumentation).toHaveBeenCalledWith('test connection', 'admin-user', 10);
  });

  it('POST /api/admin/searxng/test uses the default width when nothing is saved', async () => {
    await app.inject({ method: 'POST', url: '/api/admin/searxng/test' });

    expect(mockSearchDocumentation).toHaveBeenCalledWith('test connection', 'admin-user', 5);
  });
});
