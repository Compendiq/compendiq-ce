import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// --- Mock: llm-cache ---
const mockClearAll = vi.fn();
vi.mock('../../domains/llm/services/llm-cache.js', () => {
  class MockLlmCache {
    clearAll = (...args: unknown[]) => mockClearAll(...args);
  }
  return { LlmCache: MockLlmCache };
});

import { llmAdminRoutes } from './llm-admin.js';

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
