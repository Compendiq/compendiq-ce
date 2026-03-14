import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

// Hoisted query mock
const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });

vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { commentsRoutes } from './comments.js';

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_USER_ID = '22222222-2222-2222-2222-222222222222';

function buildApp() {
  const app = Fastify({ logger: false });
  app.register(sensible);

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

  app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
    request.userId = TEST_USER_ID;
    request.username = 'testuser';
    request.userRole = 'user';
  });

  app.register(commentsRoutes, { prefix: '/api' });
  return app;
}

describe('Comments routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  // --- GET /api/pages/:pageId/comments ---

  describe('GET /api/pages/:pageId/comments', () => {
    it('should return empty list when no comments exist', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/1/comments',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.comments).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('should return top-level comments with nested replies', async () => {
      // First query: fetch comments
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 1, page_id: 1, user_id: TEST_USER_ID, parent_id: null,
            body: 'Top comment', body_html: '<p>Top comment</p>',
            is_resolved: false, resolved_by: null, resolved_at: null,
            anchor_type: null, anchor_data: null,
            created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
            deleted_at: null, username: 'testuser',
          },
          {
            id: 2, page_id: 1, user_id: OTHER_USER_ID, parent_id: 1,
            body: 'Reply', body_html: '<p>Reply</p>',
            is_resolved: false, resolved_by: null, resolved_at: null,
            anchor_type: null, anchor_data: null,
            created_at: '2026-01-01T00:01:00Z', updated_at: '2026-01-01T00:01:00Z',
            deleted_at: null, username: 'otheruser',
          },
        ],
      });
      // Second query: reactions
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/1/comments',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.comments).toHaveLength(1);
      expect(body.comments[0].id).toBe(1);
      expect(body.comments[0].replies).toHaveLength(1);
      expect(body.comments[0].replies[0].id).toBe(2);
    });

    it('should include reactions grouped by emoji', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 10, page_id: 1, user_id: TEST_USER_ID, parent_id: null,
            body: 'Great!', body_html: '<p>Great!</p>',
            is_resolved: false, resolved_by: null, resolved_at: null,
            anchor_type: null, anchor_data: null,
            created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
            deleted_at: null, username: 'testuser',
          },
        ],
      });
      mockQuery.mockResolvedValueOnce({
        rows: [
          { comment_id: 10, emoji: '👍', user_id: TEST_USER_ID, username: 'testuser' },
          { comment_id: 10, emoji: '👍', user_id: OTHER_USER_ID, username: 'otheruser' },
          { comment_id: 10, emoji: '❤️', user_id: TEST_USER_ID, username: 'testuser' },
        ],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/pages/1/comments',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.comments[0].reactions['👍']).toEqual(['testuser', 'otheruser']);
      expect(body.comments[0].reactions['❤️']).toEqual(['testuser']);
    });
  });

  // --- POST /api/pages/:pageId/comments ---

  describe('POST /api/pages/:pageId/comments', () => {
    it('should create a top-level comment', async () => {
      // Page exists check
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      // INSERT comment
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 5, page_id: 1, user_id: TEST_USER_ID, parent_id: null,
          body: 'Hello', body_html: '<p>Hello</p>',
          is_resolved: false, resolved_by: null, resolved_at: null,
          anchor_type: null, anchor_data: null,
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
          deleted_at: null,
        }],
      });
      // Fetch username
      mockQuery.mockResolvedValueOnce({ rows: [{ username: 'testuser' }] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/1/comments',
        payload: { body: 'Hello', bodyHtml: '<p>Hello</p>' },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.id).toBe(5);
      expect(body.body).toBe('Hello');
      expect(body.username).toBe('testuser');
    });

    it('should return 404 when page does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // page check fails

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/999/comments',
        payload: { body: 'Hello', bodyHtml: '<p>Hello</p>' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should create a reply to an existing comment', async () => {
      // Page exists
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      // Parent comment exists
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 5, page_id: 1 }] });
      // INSERT reply
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 6, page_id: 1, user_id: TEST_USER_ID, parent_id: 5,
          body: 'Reply', body_html: '<p>Reply</p>',
          is_resolved: false, resolved_by: null, resolved_at: null,
          anchor_type: null, anchor_data: null,
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
          deleted_at: null,
        }],
      });
      // Fetch username
      mockQuery.mockResolvedValueOnce({ rows: [{ username: 'testuser' }] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/1/comments',
        payload: { body: 'Reply', bodyHtml: '<p>Reply</p>', parentId: 5 },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.parentId).toBe(5);
    });

    it('should extract @mentions and store them', async () => {
      // Page exists
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      // INSERT comment
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 7, page_id: 1, user_id: TEST_USER_ID, parent_id: null,
          body: 'Hey @alice and @bob check this', body_html: '<p>Hey @alice and @bob</p>',
          is_resolved: false, resolved_by: null, resolved_at: null,
          anchor_type: null, anchor_data: null,
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
          deleted_at: null,
        }],
      });
      // Lookup mentioned users
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'aaa' }, { id: 'bbb' }],
      });
      // Insert mention 1
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // Insert mention 2
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // Fetch username
      mockQuery.mockResolvedValueOnce({ rows: [{ username: 'testuser' }] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/1/comments',
        payload: { body: 'Hey @alice and @bob check this', bodyHtml: '<p>Hey @alice and @bob</p>' },
      });

      expect(response.statusCode).toBe(201);

      // Verify mention lookup was called with the extracted usernames
      const mentionLookupCall = mockQuery.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('username = ANY'),
      );
      expect(mentionLookupCall).toBeDefined();
      expect(mentionLookupCall![1]).toEqual([['alice', 'bob']]);
    });

    it('should reject missing body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/1/comments',
        payload: { bodyHtml: '<p>no body</p>' },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // --- PATCH /api/comments/:id ---

  describe('PATCH /api/comments/:id', () => {
    it('should edit own comment', async () => {
      // Ownership check
      mockQuery.mockResolvedValueOnce({ rows: [{ user_id: TEST_USER_ID }] });
      // UPDATE
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 1, page_id: 1, user_id: TEST_USER_ID, parent_id: null,
          body: 'Edited', body_html: '<p>Edited</p>',
          is_resolved: false, resolved_by: null, resolved_at: null,
          anchor_type: null, anchor_data: null,
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
          deleted_at: null,
        }],
      });
      // Delete old mentions
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // Fetch username
      mockQuery.mockResolvedValueOnce({ rows: [{ username: 'testuser' }] });

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/comments/1',
        payload: { body: 'Edited', bodyHtml: '<p>Edited</p>' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.body).toBe('Edited');
    });

    it('should reject editing other user\'s comment', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ user_id: OTHER_USER_ID }] });

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/comments/1',
        payload: { body: 'Hacked', bodyHtml: '<p>Hacked</p>' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should return 404 for non-existent comment', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/comments/999',
        payload: { body: 'Nope', bodyHtml: '<p>Nope</p>' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // --- POST /api/comments/:id/resolve ---

  describe('POST /api/comments/:id/resolve', () => {
    it('should resolve a top-level comment', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ parent_id: null }] });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/comments/1/resolve',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
    });

    it('should reject resolving a reply', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ parent_id: 5 }] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/comments/2/resolve',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 404 for non-existent comment', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/comments/999/resolve',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // --- POST /api/comments/:id/unresolve ---

  describe('POST /api/comments/:id/unresolve', () => {
    it('should unresolve a top-level comment', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ parent_id: null }] });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/comments/1/unresolve',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
    });

    it('should reject unresolving a reply', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ parent_id: 3 }] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/comments/2/unresolve',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // --- POST /api/comments/:id/reactions ---

  describe('POST /api/comments/:id/reactions', () => {
    it('should add a reaction when it does not exist', async () => {
      // Comment exists
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      // No existing reaction
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // INSERT reaction
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/comments/1/reactions',
        payload: { emoji: '👍' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.action).toBe('added');
      expect(body.emoji).toBe('👍');
    });

    it('should remove a reaction when it already exists (toggle)', async () => {
      // Comment exists
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      // Existing reaction found
      mockQuery.mockResolvedValueOnce({ rows: [{}] });
      // DELETE reaction
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'POST',
        url: '/api/comments/1/reactions',
        payload: { emoji: '👍' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.action).toBe('removed');
      expect(body.emoji).toBe('👍');
    });

    it('should return 404 for non-existent comment', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/comments/999/reactions',
        payload: { emoji: '👍' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // --- DELETE /api/comments/:id ---

  describe('DELETE /api/comments/:id', () => {
    it('should soft-delete own comment', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ user_id: TEST_USER_ID }] });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/comments/1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
    });

    it('should reject deleting other user\'s comment (non-admin)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ user_id: OTHER_USER_ID }] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/comments/1',
      });

      expect(response.statusCode).toBe(403);
    });

    it('should return 404 for already-deleted comment', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/comments/999',
      });

      expect(response.statusCode).toBe(404);
    });
  });
});

describe('Comments routes – admin delete', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

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

    // Admin user
    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = TEST_USER_ID;
      request.username = 'admin';
      request.userRole = 'admin';
    });

    await app.register(commentsRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('should allow admin to delete any comment', async () => {
    const OTHER = '33333333-3333-3333-3333-333333333333';
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: OTHER }] });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/comments/1',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });
});
