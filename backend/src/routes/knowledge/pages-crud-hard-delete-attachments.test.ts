/**
 * #1349 — call-site test: the standalone DELETE route reaches the attachment
 * cleanup on a HARD delete and never on a soft delete.
 *
 * Mock harness mirrors pages-crud-webhooks.test.ts; the cleanup's own
 * behaviour (both stores, the shared-keyspace guard) is covered against real
 * Postgres + a temp tree in
 * `core/services/standalone-attachment-cleanup.integration.test.ts`.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { pagesCrudRoutes } from './pages-crud.js';

vi.mock('../../core/services/redis-cache.js', () => ({
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
    invalidateAcrossUsers = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockGetClientForUser = vi.fn();
vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: (...args: unknown[]) => mockGetClientForUser(...args),
}));

vi.mock('../../core/services/content-converter.js', () => ({
  htmlToConfluence: vi.fn((html: string) => html),
  confluenceToHtml: vi.fn((html: string) => html),
  htmlToText: vi.fn((html: string) => html.replace(/<[^>]*>/g, '')),
}));

vi.mock('../../domains/confluence/services/attachment-handler.js', () => ({
  cleanPageAttachments: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  processDirtyPages: vi.fn().mockResolvedValue(undefined),
  isProcessingUser: vi.fn().mockReturnValue(false),
}));

const mockGetUserAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
}));

vi.mock('../../core/services/webhook-emit-hook.js', () => ({
  emitWebhookEvent: vi.fn(),
}));

const mockCleanupStandaloneDirs = vi.fn().mockResolvedValue(undefined);
vi.mock('../../core/services/standalone-attachment-cleanup.js', () => ({
  cleanupStandalonePageAttachmentDirs: (...args: unknown[]) => mockCleanupStandaloneDirs(...args),
}));

const mockQueryFn = vi.fn();
const mockTxQueryFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({
    connect: () =>
      Promise.resolve({
        query: (...args: unknown[]) => mockTxQueryFn(...args),
        release: vi.fn(),
      }),
  }),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

const TEST_USER = 'user-1';

describe('#1349 standalone hard delete cleans attachment directories', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: error.issues });
      }
      return reply.status(error.statusCode ?? 500).send({ error: error.message });
    });
    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = TEST_USER;
      request.username = 'testuser';
      request.userRole = 'user';
    });
    app.decorate('requireAdmin', async () => undefined);
    app.decorate('redis', {});
    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);
  });

  function stubStandalonePageLoad(): void {
    // SELECT loading the page row for DELETE /pages/:id.
    mockQueryFn.mockResolvedValueOnce({
      rows: [{
        id: 42,
        source: 'standalone',
        created_by_user_id: TEST_USER,
        confluence_id: null,
        space_key: null,
        visibility: 'private',
      }],
    });
    // Subsequent statements (pinned_pages delete, pages delete/update).
    mockQueryFn.mockResolvedValue({ rows: [], rowCount: 1 });
  }

  it('hard delete (permanent=true) removes the attachment directories', async () => {
    stubStandalonePageLoad();

    const response = await app.inject({ method: 'DELETE', url: '/api/pages/42?permanent=true' });

    expect(response.statusCode).toBe(200);
    expect(mockCleanupStandaloneDirs).toHaveBeenCalledTimes(1);
    expect(mockCleanupStandaloneDirs).toHaveBeenCalledWith(42);
  });

  it('soft delete leaves the directories alone — the page is restorable', async () => {
    stubStandalonePageLoad();

    const response = await app.inject({ method: 'DELETE', url: '/api/pages/42' });

    expect(response.statusCode).toBe(200);
    expect(mockCleanupStandaloneDirs).not.toHaveBeenCalled();
  });
});
