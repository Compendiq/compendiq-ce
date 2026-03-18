import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';

const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockGetUserAccessibleSpaces = vi.fn().mockResolvedValue([]);

vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
}));

vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: vi.fn(),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { spacesRoutes } from './spaces.js';

describe('Spaces routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });

    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = 'test-user-id';
    });

    app.decorate('redis', {
      get: vi.fn().mockResolvedValue(null),
      setEx: vi.fn().mockResolvedValue('OK'),
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
          last_synced: '2026-03-18T10:00:00.000Z',
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
        lastSynced: '2026-03-18T10:00:00.000Z',
        pageCount: 7,
      },
      {
        key: 'NEWSPACE',
        name: 'NEWSPACE',
        homepageId: null,
        lastSynced: null,
        pageCount: 0,
      },
    ]);
  });
});
