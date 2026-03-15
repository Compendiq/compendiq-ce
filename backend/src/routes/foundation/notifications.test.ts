import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// Hoisted query mock so we can reference it in tests
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: vi.fn().mockResolvedValue(['DEV', 'OPS']),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });

vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { notificationRoutes } from './notifications.js';

describe('Notification routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    // Mock auth decorator
    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'test-user-id';
      request.username = 'testuser';
      request.userRole = 'user';
    });

    await app.register(notificationRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('GET /api/notifications', () => {
    it('should return empty list when no notifications exist', async () => {
      // COUNT query
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
      // SELECT query
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/notifications',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('should return notifications with correct shape', async () => {
      const now = new Date();
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 1,
          user_id: 'test-user-id',
          type: 'comment',
          title: 'New comment on your article',
          body: 'Someone commented',
          link: '/pages/42',
          source_user_id: 'other-user-id',
          source_page_id: 42,
          is_read: false,
          created_at: now,
        }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/notifications',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].id).toBe(1);
      expect(body.items[0].type).toBe('comment');
      expect(body.items[0].title).toBe('New comment on your article');
      expect(body.items[0].isRead).toBe(false);
      expect(body.total).toBe(1);
    });

    it('should pass unread filter to query', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await app.inject({
        method: 'GET',
        url: '/api/notifications?unread=true',
      });

      // The COUNT query should include is_read = FALSE
      const countCall = mockQuery.mock.calls[0];
      expect(countCall[0]).toContain('is_read = FALSE');
    });

    it('should pass type filter to query', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await app.inject({
        method: 'GET',
        url: '/api/notifications?type=comment',
      });

      const countCall = mockQuery.mock.calls[0];
      expect(countCall[0]).toContain('type = $');
      expect(countCall[1]).toContain('comment');
    });
  });

  describe('GET /api/notifications/count', () => {
    it('should return unread count', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '5' }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/notifications/count',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.count).toBe(5);
    });

    it('should return 0 when no unread notifications', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/notifications/count',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.count).toBe(0);
    });
  });

  describe('POST /api/notifications/:id/read', () => {
    it('should mark notification as read', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/notifications/1/read',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Marked as read');

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
        [1, 'test-user-id'],
      );
    });

    it('should return 404 when notification not found', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/notifications/999/read',
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 400 for invalid ID', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/notifications/abc/read',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /api/notifications/read-all', () => {
    it('should mark all notifications as read', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 3 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/notifications/read-all',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.count).toBe(3);
    });
  });

  describe('DELETE /api/notifications/:id', () => {
    it('should dismiss notification', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/notifications/1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Notification dismissed');
    });

    it('should return 404 when notification not found', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/notifications/999',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /api/notification-preferences', () => {
    it('should return empty preferences when none set', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/notification-preferences',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.preferences).toEqual([]);
    });

    it('should return preferences with correct shape', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { type: 'comment', in_app: true, email: false },
          { type: 'mention', in_app: true, email: true },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/notification-preferences',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.preferences).toHaveLength(2);
      expect(body.preferences[0]).toEqual({ type: 'comment', inApp: true, email: false });
      expect(body.preferences[1]).toEqual({ type: 'mention', inApp: true, email: true });
    });
  });

  describe('PUT /api/notification-preferences', () => {
    it('should update a preference', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/notification-preferences',
        payload: { type: 'comment', inApp: true, email: true },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Preference updated');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO notification_preferences'),
        ['test-user-id', 'comment', true, true],
      );
    });

    it('should return 400 when type is missing', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/notification-preferences',
        payload: { inApp: true },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should default inApp to true and email to false when omitted', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await app.inject({
        method: 'PUT',
        url: '/api/notification-preferences',
        payload: { type: 'mention' },
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO notification_preferences'),
        ['test-user-id', 'mention', true, false],
      );
    });
  });

  describe('POST /api/pages/:id/watch', () => {
    it('should add user as watcher', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/42/watch',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Watching article');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO article_watchers'),
        [42, 'test-user-id'],
      );
    });

    it('should return 400 for invalid page ID', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/abc/watch',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/pages/:id/watch', () => {
    it('should remove user as watcher', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/pages/42/watch',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Unwatched article');
    });
  });

  describe('GET /api/pages/:id/watch', () => {
    it('should return watching status true', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/42/watch',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.watching).toBe(true);
    });

    it('should return watching status false', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/42/watch',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.watching).toBe(false);
    });
  });
});

describe('Notification service – createNotification', () => {
  // Import once; module is already cached with mocked dependencies
  let createNotification: typeof import('../services/notification-service.js')['createNotification'];

  beforeAll(async () => {
    const mod = await import('../services/notification-service.js');
    createNotification = mod.createNotification;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('should respect user preference and skip when in_app is false', async () => {
    // User has disabled in-app notifications for this type
    mockQuery.mockResolvedValueOnce({ rows: [{ in_app: false }] });

    await createNotification({
      userId: 'test-user-id',
      type: 'comment',
      title: 'Test notification',
    });

    // Only the preference check query should have been called, not the INSERT
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain('notification_preferences');
  });

  it('should create notification when no preference is set (default enabled)', async () => {
    // No preference row exists
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // INSERT succeeds
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await createNotification({
      userId: 'test-user-id',
      type: 'comment',
      title: 'Test notification',
      body: 'A comment was added',
      link: '/pages/42',
      sourceUserId: 'other-user',
      sourcePageId: 42,
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[0]).toContain('INSERT INTO notifications');
    expect(insertCall[1]).toEqual([
      'test-user-id',
      'comment',
      'Test notification',
      'A comment was added',
      '/pages/42',
      'other-user',
      42,
    ]);
  });

  it('should not throw when database error occurs', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));

    // Should not throw
    await expect(
      createNotification({
        userId: 'test-user-id',
        type: 'comment',
        title: 'Test',
      }),
    ).resolves.toBeUndefined();
  });
});
