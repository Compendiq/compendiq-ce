import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { localSpacesRoutes } from './local-spaces.js';

vi.mock('../../core/services/redis-cache.js', () => {
  return {
    RedisCache: class MockRedisCache {
      get = vi.fn().mockResolvedValue(null);
      set = vi.fn().mockResolvedValue(undefined);
      invalidate = vi.fn().mockResolvedValue(undefined);
    },
  };
});

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockQueryFn = vi.fn();
// #891: the move handler runs its cycle check + UPDATEs on a dedicated pool
// client inside a transaction under an advisory lock. Route the client's data
// queries through the same mockQueryFn (single sequential mock per test) and
// answer transaction-control / advisory-lock statements inline so they don't
// consume queued mockResolvedValueOnce entries.
const mockTxClient = {
  query: (...args: unknown[]) => {
    const sql = args[0];
    if (typeof sql === 'string') {
      const trimmed = sql.trim();
      if (
        trimmed === 'BEGIN' ||
        trimmed === 'COMMIT' ||
        trimmed === 'ROLLBACK' ||
        trimmed.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [] });
      }
    }
    return mockQueryFn(...args);
  },
  release: vi.fn(),
};
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
  getPool: vi.fn().mockReturnValue({ connect: () => Promise.resolve(mockTxClient) }),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// #733: per-page / per-space RBAC checks on move/reorder/breadcrumb
const mockUserCanAccessPage = vi.fn();
const mockGetUserAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  userCanAccessPage: (...args: unknown[]) => mockUserCanAccessPage(...args),
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
}));

describe('Local Spaces Routes', () => {
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
      reply.status(error.statusCode ?? 500).send({
        error: error.message,
        statusCode: error.statusCode ?? 500,
      });
    });

    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'test-user-id';
      request.username = 'testuser';
      request.userRole = 'user';
    });
    app.decorate('requireAdmin', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'test-user-id';
      request.username = 'testuser';
      request.userRole = 'admin';
    });
    app.decorate('redis', {});

    await app.register(localSpacesRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: page access allowed; no Confluence space assignments.
    mockUserCanAccessPage.mockResolvedValue(true);
    mockGetUserAccessibleSpaces.mockResolvedValue([]);
  });

  // ── GET /api/spaces/local ─────────────────────────────────────────────

  it('should list local spaces', async () => {
    // First query: list spaces
    mockQueryFn.mockResolvedValueOnce({
      rows: [
        {
          space_key: 'PROJ',
          space_name: 'Project Docs',
          description: 'Internal docs',
          icon: 'folder',
          created_by: 'test-user-id',
          created_at: new Date('2026-03-01'),
          custom_home_page_id: null,
        },
      ],
    });
    // Second query: page counts
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ space_key: 'PROJ', count: '5' }],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/spaces/local',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toHaveLength(1);
    expect(body[0].key).toBe('PROJ');
    expect(body[0].name).toBe('Project Docs');
    expect(body[0].source).toBe('local');
    expect(body[0].pageCount).toBe(5);
    // #352 (finding 2): homepage fields exposed for the "Show home content"
    // toggle. With no custom override set, both wire fields are null.
    expect(body[0].homepageId).toBeNull();
    expect(body[0].customHomePageId).toBeNull();
  });

  it('should surface homepageId/customHomePageId when an override is set (#352 finding 2)', async () => {
    mockQueryFn.mockResolvedValueOnce({
      rows: [
        {
          space_key: 'PROJ',
          space_name: 'Project Docs',
          description: null,
          icon: null,
          created_by: 'test-user-id',
          created_at: new Date('2026-03-01'),
          custom_home_page_id: 999,
        },
      ],
    });
    mockQueryFn.mockResolvedValueOnce({ rows: [{ space_key: 'PROJ', count: '3' }] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/spaces/local',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body[0].homepageId).toBe('999');
    expect(body[0].customHomePageId).toBe(999);
  });

  it('SELECTs cs.custom_home_page_id (regression guard for #352 finding 2)', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [] });
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    await app.inject({ method: 'GET', url: '/api/spaces/local' });

    // The SELECT must include `cs.custom_home_page_id` so the column is
    // actually returned to JS — without it the response shape silently
    // drops the field and the frontend toggle can never find a homepage.
    const listCall = mockQueryFn.mock.calls[0];
    expect(listCall[0]).toMatch(/cs\.custom_home_page_id/);
  });

  it('should return empty array when no local spaces exist', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [] });
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/spaces/local',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toHaveLength(0);
  });

  // ── POST /api/spaces/local ────────────────────────────────────────────

  it('should create a local space', async () => {
    // Check duplicate
    mockQueryFn.mockResolvedValueOnce({ rows: [] });
    // Insert
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/spaces/local',
      payload: { key: 'MYSPACE', name: 'My Space' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.key).toBe('MYSPACE');
    expect(body.name).toBe('My Space');
    expect(body.source).toBe('local');

    // Verify INSERT was called with correct source
    const insertCall = mockQueryFn.mock.calls[1];
    expect(insertCall[0]).toContain("'local'");
    expect(insertCall[1]).toContain('MYSPACE');
  });

  it('should reject duplicate space key', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/spaces/local',
      payload: { key: 'EXISTING', name: 'Duplicate' },
    });

    expect(response.statusCode).toBe(409);
  });

  it('should reject invalid space key format', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/spaces/local',
      payload: { key: 'lower-case', name: 'Bad Key' },
    });

    expect(response.statusCode).toBe(400);
  });

  // ── PUT /api/spaces/local/:key ────────────────────────────────────────

  it('should update a local space', async () => {
    // Verify it's a local space
    mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'local', created_by: 'test-user-id' }] });
    // Update
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/spaces/local/PROJ',
      payload: { name: 'Updated Name', description: 'New description' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.key).toBe('PROJ');
    expect(body.updated).toBe(true);
  });

  it('should reject update of Confluence space', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'confluence', created_by: null }] });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/spaces/local/CONFSPACE',
      payload: { name: 'Try Update' },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toContain('Confluence');
  });

  // ── DELETE /api/spaces/local/:key ─────────────────────────────────────

  it('should delete an empty local space', async () => {
    // Verify it's local
    mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'local' }] });
    // Page count = 0
    mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    // Delete
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/spaces/local/PROJ',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.deleted).toBe(true);
  });

  it('should reject deletion of non-empty space', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'local' }] });
    mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '3' }] });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/spaces/local/PROJ',
    });

    expect(response.statusCode).toBe(409);
  });

  // ── GET /api/spaces/:key/tree ─────────────────────────────────────────

  it('should return page tree for a space', async () => {
    // Space exists (local — no RBAC gate)
    mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'local' }] });
    // Pages
    mockQueryFn.mockResolvedValueOnce({
      rows: [
        { id: 1, title: 'Root', parent_numeric_id: null, depth: 0, sort_order: 0, source: 'standalone', confluence_id: null },
        { id: 2, title: 'Child A', parent_numeric_id: 1, depth: 1, sort_order: 0, source: 'standalone', confluence_id: null },
        { id: 3, title: 'Child B', parent_numeric_id: 1, depth: 1, sort_order: 1, source: 'standalone', confluence_id: null },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/spaces/PROJ/tree',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.spaceKey).toBe('PROJ');
    expect(body.items).toHaveLength(3);
    expect(body.items[0].parentId).toBeNull();
    expect(body.items[1].parentId).toBe('1');
    expect(body.total).toBe(3);
  });

  it('should return 404 for non-existent space tree', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/spaces/NOPE/tree',
    });

    expect(response.statusCode).toBe(404);
  });

  it('tree: returns 404 for a Confluence space the user cannot access (#817)', async () => {
    // Space exists and is Confluence-synced.
    mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'confluence' }] });
    // User has no assignment to this space (default mock is []).
    mockGetUserAccessibleSpaces.mockResolvedValue(['OTHER']);

    const response = await app.inject({
      method: 'GET',
      url: '/api/spaces/RESTRICTED/tree',
    });

    // 404 (not 403) so restricted spaces are indistinguishable from missing ones.
    expect(response.statusCode).toBe(404);
    expect(mockGetUserAccessibleSpaces).toHaveBeenCalledWith('test-user-id');
    // Critical: the page tree must never be queried for a denied space.
    const treeSelect = mockQueryFn.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('FROM pages p'),
    );
    expect(treeSelect).toBeUndefined();
  });

  it('tree: returns the tree for a Confluence space the user can access (#817)', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'confluence' }] });
    mockGetUserAccessibleSpaces.mockResolvedValue(['TEAMB']);
    mockQueryFn.mockResolvedValueOnce({
      rows: [
        { id: 1, title: 'Root', parent_numeric_id: null, depth: 0, sort_order: 0, source: 'confluence', confluence_id: 'c1' },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/spaces/TEAMB/tree',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.spaceKey).toBe('TEAMB');
    expect(body.items).toHaveLength(1);
  });

  it('tree: serves a local space without an RBAC assignment (#817)', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'local' }] });
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/spaces/MYLOCAL/tree',
    });

    expect(response.statusCode).toBe(200);
    // Local spaces are accessible to all authenticated users — no RBAC lookup.
    expect(mockGetUserAccessibleSpaces).not.toHaveBeenCalled();
  });

  // ── PUT /api/pages/:id/move ───────────────────────────────────────────

  it('should move a page to a new parent', async () => {
    // Existing page
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 10, parent_id: null, space_key: 'PROJ', source: 'standalone', path: '/10' }],
    });
    // #891: fresh re-read of the page under the advisory lock
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ parent_id: null, space_key: 'PROJ', path: '/10' }],
    });
    // Parent exists check (also supplies the parent path)
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 5, path: '/5' }],
    });
    // #891 cycle-check: no cycle (empty result)
    mockQueryFn.mockResolvedValueOnce({ rows: [] });
    // Update page
    mockQueryFn.mockResolvedValueOnce({ rows: [] });
    // Update descendants
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/10/move',
      payload: { parentId: '5' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.parentId).toBe('5');
    expect(body.path).toBe('/5/10');
    expect(body.depth).toBe(1);
  });

  it('move: rejects making a page its own parent (#891)', async () => {
    // Existing page
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 5, parent_id: null, space_key: 'PROJ', source: 'standalone', path: '/5' }],
    });
    // #891: fresh re-read of the page under the advisory lock
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ parent_id: null, space_key: 'PROJ', path: '/5' }],
    });
    // Parent exists check (parent is the page itself)
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 5, path: '/5' }],
    });
    // Cycle-check finds the moved page in the ancestor chain
    mockQueryFn.mockResolvedValueOnce({ rows: [{ found: 1 }] });
    // Fallback so any further (unexpected) query resolves harmlessly
    mockQueryFn.mockResolvedValue({ rows: [] });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/5/move',
      payload: { parentId: 5 },
    });

    expect(response.statusCode).toBe(400);
    // Critical: no UPDATE must run, so no descendant paths are corrupted.
    const updateCall = mockQueryFn.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE pages'),
    );
    expect(updateCall).toBeUndefined();
  });

  it('move: rejects moving a Confluence page under its own descendant when path is NULL (#891)', async () => {
    // Existing page (Confluence-synced, materialized path is NULL)
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 5, parent_id: null, space_key: 'PROJ', source: 'confluence', path: null }],
    });
    // #891: fresh re-read of the page under the advisory lock
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ parent_id: null, space_key: 'PROJ', path: null }],
    });
    // Parent exists check (a descendant of page 5, also NULL path)
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 9, path: null }],
    });
    // Cycle-check finds the moved page in the ancestor chain
    mockQueryFn.mockResolvedValueOnce({ rows: [{ found: 1 }] });
    mockQueryFn.mockResolvedValue({ rows: [] });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/5/move',
      payload: { parentId: 9 },
    });

    expect(response.statusCode).toBe(400);
    const updateCall = mockQueryFn.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE pages'),
    );
    expect(updateCall).toBeUndefined();
  });

  it('should return 404 when moving non-existent page', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/999/move',
      payload: { parentId: null },
    });

    expect(response.statusCode).toBe(404);
  });

  // ── PUT /api/pages/:id/reorder ────────────────────────────────────────

  it('should reorder a page and renumber the whole sibling group (#959)', async () => {
    // 1) existence check, 2) resolve sibling group, 3) sibling list.
    mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 10 }] });
    mockQueryFn.mockResolvedValueOnce({ rows: [{ space_key: 'PROJ', parent_num: 5 }] });
    mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 11 }, { id: 12 }, { id: 10 }] });
    // Per-row UPDATEs + any other tx query.
    mockQueryFn.mockResolvedValue({ rows: [] });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/10/reorder',
      payload: { sortOrder: 0 },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.sortOrder).toBe(0);

    // The dragged page (10) plus both untouched siblings (11, 12) are each
    // rewritten to a dense position — not just the dragged row.
    const updatedIds = mockQueryFn.mock.calls
      .filter((c) => typeof c[0] === 'string' && (c[0] as string).startsWith('UPDATE pages SET sort_order'))
      .map((c) => (c[1] as unknown[])[1]);
    expect(updatedIds).toEqual([10, 11, 12]);
  });

  it('should return 404 when reordering non-existent page', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/999/reorder',
      payload: { sortOrder: 0 },
    });

    expect(response.statusCode).toBe(404);
  });

  // ── #733 RBAC / IDOR regressions ──────────────────────────────────────

  it('move: returns 404 when the user cannot access the source page (#733)', async () => {
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 10, parent_id: null, space_key: 'SECRET', source: 'confluence', path: '/10' }],
    });
    mockUserCanAccessPage.mockResolvedValue(false);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/10/move',
      payload: { parentId: null, spaceKey: 'PROJ' },
    });

    expect(response.statusCode).toBe(404);
    expect(mockUserCanAccessPage).toHaveBeenCalledWith('test-user-id', 10);
    // Critical: the page must not be moved.
    const updateCall = mockQueryFn.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE pages'),
    );
    expect(updateCall).toBeUndefined();
  });

  it('move: returns 403 when the target space is a Confluence space the user cannot access (#733)', async () => {
    // Source page is accessible (default mock), target space is not.
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 10, parent_id: null, space_key: 'PROJ', source: 'standalone', path: '/10' }],
    });
    // Target space lookup → Confluence-synced space
    mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'confluence' }] });
    mockGetUserAccessibleSpaces.mockResolvedValue(['OTHER']);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/10/move',
      payload: { parentId: null, spaceKey: 'RESTRICTED' },
    });

    expect(response.statusCode).toBe(403);
    const updateCall = mockQueryFn.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE pages'),
    );
    expect(updateCall).toBeUndefined();
  });

  it('move: returns 400 when the target space does not exist (#733)', async () => {
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 10, parent_id: null, space_key: 'PROJ', source: 'standalone', path: '/10' }],
    });
    // Target space lookup → no such space
    mockQueryFn.mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/10/move',
      payload: { parentId: null, spaceKey: 'NOPE' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('move: allows moving into an accessible Confluence space (#733)', async () => {
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 10, parent_id: null, space_key: 'PROJ', source: 'standalone', path: '/10' }],
    });
    mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'confluence' }] });
    mockGetUserAccessibleSpaces.mockResolvedValue(['TEAMB']);
    // #891: fresh re-read of the page under the advisory lock
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ parent_id: null, space_key: 'PROJ', path: '/10' }],
    });
    // UPDATE page + descendants
    mockQueryFn.mockResolvedValue({ rows: [] });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/10/move',
      payload: { parentId: null, spaceKey: 'TEAMB' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload).spaceKey).toBe('TEAMB');
  });

  it('move: allows moving into a local space without an RBAC assignment (#733)', async () => {
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 10, parent_id: null, space_key: null, source: 'standalone', path: '/10' }],
    });
    mockQueryFn.mockResolvedValueOnce({ rows: [{ source: 'local' }] });
    // #891: fresh re-read of the page under the advisory lock
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ parent_id: null, space_key: null, path: '/10' }],
    });
    mockQueryFn.mockResolvedValue({ rows: [] });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/10/move',
      payload: { parentId: null, spaceKey: 'MYLOCAL' },
    });

    expect(response.statusCode).toBe(200);
    // Local spaces are accessible to all authenticated users — no RBAC lookup.
    expect(mockGetUserAccessibleSpaces).not.toHaveBeenCalled();
  });

  it('reorder: returns 404 when the user cannot access the page (#733)', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 10 }] });
    mockUserCanAccessPage.mockResolvedValue(false);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/pages/10/reorder',
      payload: { sortOrder: 3 },
    });

    expect(response.statusCode).toBe(404);
    const updateCall = mockQueryFn.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE pages'),
    );
    expect(updateCall).toBeUndefined();
  });

  it('breadcrumb: returns 404 when the user cannot access the page (#733)', async () => {
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 10, title: 'Restricted', parent_id: null, space_key: 'SECRET', path: '/10' }],
    });
    mockUserCanAccessPage.mockResolvedValue(false);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/10/breadcrumb',
    });

    expect(response.statusCode).toBe(404);
    expect(mockUserCanAccessPage).toHaveBeenCalledWith('test-user-id', 10);
  });

  it('breadcrumb: returns the parent chain when the user can access the page (#733)', async () => {
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 10, title: 'Child', parent_id: '5', space_key: 'PROJ', path: '/5/10' }],
    });
    // Ancestors batch fetch
    mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 5, title: 'Parent' }] });
    // Space name lookup
    mockQueryFn.mockResolvedValueOnce({ rows: [{ space_name: 'Project Docs', source: 'local' }] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/pages/10/breadcrumb',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.ancestors).toEqual([{ id: 5, title: 'Parent' }]);
    expect(body.current).toEqual({ id: 10, title: 'Child' });
  });
});
