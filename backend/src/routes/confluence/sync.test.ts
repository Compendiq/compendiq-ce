import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// Mock sync service
const mockGetSyncStatus = vi.fn();
const mockIsConfluenceEnabled = vi.fn().mockResolvedValue(true);
// Claims the worker lock and detaches the run (#1775). What it does is covered
// against real PostgreSQL and Redis in sync-manual-lock.integration.test.ts.
const mockStartManualSync = vi.fn().mockResolvedValue(true);

vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  startManualSync: (...args: unknown[]) => mockStartManualSync(...args),
  getSyncStatus: (...args: unknown[]) => mockGetSyncStatus(...args),
}));

vi.mock('../../core/services/confluence-integration.js', () => ({
  isConfluenceEnabled: (...args: unknown[]) => mockIsConfluenceEnabled(...args),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { syncRoutes } from './sync.js';

describe('Sync routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string; userCan: (p: string, t?: string) => Promise<boolean> }) => {
      request.userId = 'test-user-id';
      request.username = 'testuser';
      request.userRole = 'user';
      // Mock userCan — grants all permissions for routes tested here.
      // Individual tests can override if they need to test denial.
      request.userCan = async () => true;
    });

    await app.register(syncRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConfluenceEnabled.mockResolvedValue(true);
  });

  describe('POST /api/sync', () => {
    it('should return 409 if sync is already in progress', async () => {
      mockGetSyncStatus.mockReturnValue({ userId: 'test-user-id', status: 'syncing' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/sync',
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Sync already in progress');

      // Refused on the caller's own status, before any lock claim.
      expect(mockStartManualSync).not.toHaveBeenCalled();
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
      expect(mockStartManualSync).toHaveBeenCalledWith(
        'test-user-id',
        expect.objectContaining({ onStarted: expect.any(Function), onCompleted: expect.any(Function) }),
      );
    });

    it('answers 409 with the snapshot status when another run holds the sync lock', async () => {
      mockGetSyncStatus.mockReturnValue({ userId: 'test-user-id', status: 'idle' });
      mockStartManualSync.mockResolvedValueOnce(false);

      const response = await app.inject({
        method: 'POST',
        url: '/api/sync',
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body)).toEqual({
        message: 'A Confluence sync is currently running. Wait for it to finish and try again.',
        status: { userId: 'test-user-id', status: 'idle' },
      });
    });

    it('reports the off state without starting a run when the integration is disabled (#1623)', async () => {
      mockGetSyncStatus.mockReturnValue({ userId: 'test-user-id', status: 'idle' });
      mockIsConfluenceEnabled.mockResolvedValue(false);

      const response = await app.inject({
        method: 'POST',
        url: '/api/sync',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Confluence integration is disabled');
      expect(body.status.status).toBe('idle');

      // No lock claim, no phantom 'syncing' status, no background work.
      expect(mockStartManualSync).not.toHaveBeenCalled();
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
