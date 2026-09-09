import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { NotionImportItem } from '@compendiq/contracts';
import { resetNotionImportStatusForTests } from '../../domains/knowledge/services/notion-import-job.js';

const { mockRunImport, mockGetToken, mockInvalidate, mockInvalidateAcrossUsers } = vi.hoisted(() => ({
  mockRunImport: vi.fn(),
  mockGetToken: vi.fn(),
  mockInvalidate: vi.fn(),
  mockInvalidateAcrossUsers: vi.fn(),
}));

vi.mock('../../domains/knowledge/services/notion-token-service.js', () => ({
  getDecryptedNotionToken: (...args: unknown[]) => mockGetToken(...args),
  getNotionConnectionStatus: vi.fn(),
  connectNotionToken: vi.fn(),
  disconnectNotionToken: vi.fn(),
}));

vi.mock('../../domains/knowledge/services/notion-import-service.js', () => ({
  runNotionImport: (...args: unknown[]) => mockRunImport(...args),
  NotionImportError: class NotionImportError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
      this.name = 'NotionImportError';
    }
  },
}));

vi.mock('../../domains/knowledge/services/notion-client.js', () => ({
  NotionClient: class {
    constructor(public token: string) {}
  },
  NotionError: class NotionError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

vi.mock('../../domains/knowledge/services/notion-tree.js', () => ({
  fetchNotionWorkspaceTree: vi.fn(),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../core/services/redis-cache.js', () => ({
  getRedisClient: () => null,
  setRedisClient: vi.fn(),
  RedisCache: class {
    invalidate = mockInvalidate;
    invalidateAcrossUsers = mockInvalidateAcrossUsers;
    get = vi.fn();
    set = vi.fn();
  },
}));

import { notionRoutes } from './notion.js';

describe('POST /api/notion/import background job', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = 'test-user-id';
    });
    app.decorate('redis', {});
    await app.register(notionRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetNotionImportStatusForTests();
    mockInvalidate.mockResolvedValue(undefined);
    mockInvalidateAcrossUsers.mockResolvedValue(undefined);
  });

  it('returns 202 before Notion work finishes and serves items on GET status', async () => {
    const { promise, resolve } = Promise.withResolvers<NotionImportItem[]>();
    mockGetToken.mockResolvedValue('ntn_test');
    mockRunImport.mockReturnValue(promise);

    const post = await app.inject({
      method: 'POST',
      url: '/api/notion/import',
      payload: { pageIds: ['notes'] },
    });
    expect(post.statusCode).toBe(202);
    expect(post.json()).toEqual({ status: 'importing' });
    expect(post.json()).not.toHaveProperty('items');

    const mid = await app.inject({ method: 'GET', url: '/api/notion/import/status' });
    expect(mid.json()).toEqual({ status: 'importing' });

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/notion/import',
      payload: { pageIds: ['other'] },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ message: 'Notion import already in progress' });
    expect(mockRunImport).toHaveBeenCalledTimes(1);

    resolve([{ notionPageId: 'notes', status: 'success', localPageId: 11 }]);
    const done = await vi.waitFor(async () => {
      const res = await app.inject({ method: 'GET', url: '/api/notion/import/status' });
      expect(res.json()).toMatchObject({ status: 'complete' });
      return res.json() as { status: string; items: NotionImportItem[] };
    });
    expect(done.items).toEqual([{ notionPageId: 'notes', status: 'success', localPageId: 11 }]);
  });

  it('returns 400 when Notion is not connected without starting a job', async () => {
    mockGetToken.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/api/notion/import',
      payload: { pageIds: ['notes'] },
    });
    expect(res.statusCode).toBe(400);
    expect(mockRunImport).not.toHaveBeenCalled();
    const status = await app.inject({ method: 'GET', url: '/api/notion/import/status' });
    expect(status.json()).toEqual({ status: 'idle' });
  });

  it('records an error status when the importer throws', async () => {
    mockGetToken.mockResolvedValue('ntn_test');
    mockRunImport.mockRejectedValue(new Error('paced request failed'));

    const post = await app.inject({
      method: 'POST',
      url: '/api/notion/import',
      payload: { pageIds: ['notes'] },
    });
    expect(post.statusCode).toBe(202);

    const done = await vi.waitFor(async () => {
      const res = await app.inject({ method: 'GET', url: '/api/notion/import/status' });
      expect(res.json()).toMatchObject({ status: 'error' });
      return res.json() as { status: string; error: string };
    });
    expect(done.error).toBe('Notion import failed');
  });
});
