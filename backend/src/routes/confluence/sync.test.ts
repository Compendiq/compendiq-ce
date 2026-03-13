import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// Mock sync service
const mockSyncUser = vi.fn().mockResolvedValue(undefined);
const mockGetSyncStatus = vi.fn();
const mockSetSyncStatus = vi.fn();

vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  syncUser: (...args: unknown[]) => mockSyncUser(...args),
  getSyncStatus: (...args: unknown[]) => mockGetSyncStatus(...args),
  setSyncStatus: (...args: unknown[]) => mockSetSyncStatus(...args),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { syncRoutes } from './sync.js';

describe('Sync routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'test-user-id';
      request.username = 'testuser';
      request.userRole = 'user';
    });

    await app.register(syncRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/sync', () => {
    it('should set status to syncing before dispatching background work', async () => {
      mockGetSyncStatus.mockReturnValue({ userId: 'test-user-id', status: 'idle' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/sync',
      });

      expect(response.statusCode).toBe(200);

      // setSyncStatus should be called with 'syncing' before syncUser is dispatched
      expect(mockSetSyncStatus).toHaveBeenCalledWith('test-user-id', {
        userId: 'test-user-id',
        status: 'syncing',
      });

      // syncUser should be called in the background
      expect(mockSyncUser).toHaveBeenCalledWith('test-user-id');
    });

    it('should return 409 if sync is already in progress', async () => {
      mockGetSyncStatus.mockReturnValue({ userId: 'test-user-id', status: 'syncing' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/sync',
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Sync already in progress');

      // Should NOT call setSyncStatus or syncUser
      expect(mockSetSyncStatus).not.toHaveBeenCalled();
      expect(mockSyncUser).not.toHaveBeenCalled();
    });

    it('should return syncing status in response', async () => {
      mockGetSyncStatus
        .mockReturnValueOnce({ userId: 'test-user-id', status: 'idle' }) // First call: check if syncing
        .mockReturnValueOnce({ userId: 'test-user-id', status: 'syncing' }); // Second call: return in response

      const response = await app.inject({
        method: 'POST',
        url: '/api/sync',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Sync started');
      expect(body.status.status).toBe('syncing');
    });
  });

  describe('GET /api/sync/status', () => {
    it('should return current sync status', async () => {
      mockGetSyncStatus.mockReturnValue({
        userId: 'test-user-id',
        status: 'syncing',
        progress: { current: 5, total: 10, space: 'DEV' },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/sync/status',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('syncing');
      expect(body.progress).toEqual({ current: 5, total: 10, space: 'DEV' });
    });
  });
});
