import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockGetUserAccessibleSpaces = vi.fn().mockResolvedValue([]);
const mockUserHasPermission = vi.fn().mockResolvedValue(false);

vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
  userHasPermission: (...args: unknown[]) => mockUserHasPermission(...args),
}));

vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: vi.fn(),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { spacesRoutes } from './spaces.js';

// Module-scoped mocks so individual tests can re-arm `scan` to assert the
// cross-user invalidation path (#352, finding 1).
const mockRedisScan = vi.fn().mockResolvedValue({ cursor: '0', keys: [] });
const mockRedisDel = vi.fn().mockResolvedValue(0);

describe('Spaces routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = 'test-user-id';
    });

    app.decorate('redis', {
      get: vi.fn().mockResolvedValue(null),
      setEx: vi.fn().mockResolvedValue('OK'),
      // RedisCache.invalidateAcrossUsers walks SCAN cursors and DELs the
      // returned keys. Tests need both to assert the cross-user fan-out
      // pattern; default mocks return an empty page so the SCAN walk
      // terminates immediately.
      scan: mockRedisScan,
      del: mockRedisDel,
    });

    await app.register(spacesRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockGetUserAccessibleSpaces.mockResolvedValue([]);
    mockUserHasPermission.mockResolvedValue(false);
    // Re-arm Redis SCAN to terminate immediately for tests that don't
    // care about cache invalidation; tests that DO care override this.
    mockRedisScan.mockReset().mockResolvedValue({ cursor: '0', keys: [] });
    mockRedisDel.mockReset().mockResolvedValue(0);
  });

  it('GET /spaces includes selected spaces that are not yet synced', async () => {
    mockGetUserAccessibleSpaces.mockResolvedValueOnce(['DEV', 'NEWSPACE']);

    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          space_key: 'DEV',
          space_name: 'Development',
          homepage_id: 'home-1',
          homepage_numeric_id: 101,
          custom_home_page_id: null,
          last_synced: '2026-03-18T10:00:00.000Z',
          source: 'confluence',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ space_key: 'DEV', count: '7' }],
      });

    const response = await app.inject({
      method: 'GET',
      url: '/api/spaces',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([
      {
        key: 'DEV',
        name: 'Development',
        homepageId: '101',
        customHomePageId: null,
        lastSynced: '2026-03-18T10:00:00.000Z',
        pageCount: 7,
        source: 'confluence',
      },
      {
        key: 'NEWSPACE',
        name: 'NEWSPACE',
        homepageId: null,
        lastSynced: null,
        pageCount: 0,
        source: 'confluence',
      },
    ]);
  });

  it('GET /spaces returns source field for local spaces (#527)', async () => {
    mockGetUserAccessibleSpaces.mockResolvedValueOnce(['DEV', 'MY_NOTES']);

    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            space_key: 'DEV',
            space_name: 'Development',
            homepage_id: null,
            homepage_numeric_id: null,
            custom_home_page_id: null,
            last_synced: '2026-03-18T10:00:00.000Z',
            source: 'confluence',
          },
          {
            space_key: 'MY_NOTES',
            space_name: 'My Notes',
            homepage_id: null,
            homepage_numeric_id: null,
            custom_home_page_id: null,
            last_synced: '2026-03-19T10:00:00.000Z',
            source: 'local',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { space_key: 'DEV', count: '3' },
          { space_key: 'MY_NOTES', count: '5' },
        ],
      });

    const response = await app.inject({
      method: 'GET',
      url: '/api/spaces',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    const devSpace = body.find((s: { key: string }) => s.key === 'DEV');
    const localSpace = body.find((s: { key: string }) => s.key === 'MY_NOTES');

    expect(devSpace.source).toBe('confluence');
    expect(localSpace.source).toBe('local');
    expect(localSpace.pageCount).toBe(5);
  });

  // ---------- #352: PUT /api/spaces/:key/home ----------

  it('GET /spaces surfaces customHomePageId when set, overriding the Confluence default (#352)', async () => {
    mockGetUserAccessibleSpaces.mockResolvedValueOnce(['DEV']);
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          space_key: 'DEV',
          space_name: 'Development',
          homepage_id: 'home-1',
          homepage_numeric_id: 101,
          custom_home_page_id: 999,
          last_synced: '2026-03-18T10:00:00.000Z',
          source: 'confluence',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await app.inject({ method: 'GET', url: '/api/spaces' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body[0].homepageId).toBe('999');
    expect(body[0].customHomePageId).toBe(999);
  });

  it('PUT /spaces/:key/home rejects callers without admin/space-owner permission (#352)', async () => {
    mockUserHasPermission.mockResolvedValueOnce(false);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/spaces/DEV/home',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ homePageId: 42 }),
    });

    expect(response.statusCode).toBe(403);
    expect(mockUserHasPermission).toHaveBeenCalledWith('test-user-id', 'manage', 'DEV');
  });

  it('PUT /spaces/:key/home accepts a valid in-space page from a permitted caller (#352)', async () => {
    mockUserHasPermission.mockResolvedValueOnce(true);
    mockGetUserAccessibleSpaces.mockResolvedValueOnce(['DEV']);
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ space_key: 'DEV', source: 'confluence', visibility: null }],
      })
      .mockResolvedValueOnce({ rows: [{ space_key: 'DEV' }], rowCount: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/spaces/DEV/home',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ homePageId: 42 }),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      spaceKey: 'DEV',
      customHomePageId: 42,
    });
  });

  it('PUT /spaces/:key/home rejects a page that lives in a different space (#352)', async () => {
    mockUserHasPermission.mockResolvedValueOnce(true);
    mockGetUserAccessibleSpaces.mockResolvedValueOnce(['DEV']);
    // Page exists but lives in OTHER and isn't a shared standalone.
    mockQuery.mockResolvedValueOnce({
      rows: [{ space_key: 'OTHER', source: 'confluence', visibility: null }],
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/spaces/DEV/home',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ homePageId: 42 }),
    });

    expect(response.statusCode).toBe(400);
  });

  it('PUT /spaces/:key/home with null clears the override (#352)', async () => {
    mockUserHasPermission.mockResolvedValueOnce(true);
    mockGetUserAccessibleSpaces.mockResolvedValueOnce(['DEV']);
    // No page-existence query is made for null; only the UPDATE.
    mockQuery.mockResolvedValueOnce({ rows: [{ space_key: 'DEV' }], rowCount: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/spaces/DEV/home',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ homePageId: null }),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      spaceKey: 'DEV',
      customHomePageId: null,
    });
  });

  it('PUT /spaces/:key/home invalidates the spaces cache across ALL users, not just the admin caller (#352)', async () => {
    // Two simulated users have a cached `kb:<uid>:spaces:list` entry. The
    // update must wipe both, otherwise non-admin viewers would keep
    // reading the old `homepageId` for up to the spaces TTL (15 min).
    mockUserHasPermission.mockResolvedValueOnce(true);
    mockGetUserAccessibleSpaces.mockResolvedValueOnce(['DEV']);
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ space_key: 'DEV', source: 'confluence', visibility: null }],
      })
      .mockResolvedValueOnce({ rows: [{ space_key: 'DEV' }], rowCount: 1 });

    mockRedisScan.mockResolvedValueOnce({
      cursor: '0',
      keys: ['kb:alice:spaces:list', 'kb:bob:spaces:list'],
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/spaces/DEV/home',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ homePageId: 42 }),
    });

    expect(response.statusCode).toBe(200);
    // SCAN walks the shared `kb:*:spaces:*` namespace, NOT the
    // per-admin `kb:test-user-id:spaces:*` namespace.
    expect(mockRedisScan).toHaveBeenCalledWith('0', {
      MATCH: 'kb:*:spaces:*',
      COUNT: 100,
    });
    expect(mockRedisDel).toHaveBeenCalledWith([
      'kb:alice:spaces:list',
      'kb:bob:spaces:list',
    ]);
  });

  it('PUT /spaces/:key/home returns 404 when the space is not in the caller\'s accessible set (#352)', async () => {
    mockUserHasPermission.mockResolvedValueOnce(true);
    mockGetUserAccessibleSpaces.mockResolvedValueOnce([]);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/spaces/DEV/home',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ homePageId: null }),
    });

    expect(response.statusCode).toBe(404);
  });
});
