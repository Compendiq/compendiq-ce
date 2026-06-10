/**
 * GET /api/pages/tree — visibility predicate against a REAL PostgreSQL.
 *
 * Regression: the tree route filtered only by space + `deleted_at IS NULL`,
 * so another user's PRIVATE standalone article appeared in the sidebar tree
 * while the detail route refused to serve it ("Article not found"). The tree
 * must apply the same predicate as the list route:
 *   - Confluence pages from RBAC-accessible spaces
 *   - shared standalone articles (visible to all)
 *   - the caller's own private standalone articles
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';

// --- Boundary mocks (everything else is real) ---

// No Redis in tests — no-op cache so every request hits the real DB.
vi.mock('../../core/services/redis-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/services/redis-cache.js')>()),
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
  },
}));

const mockGetUserAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

const dbAvailable = await isDbAvailable();

// --- Fixtures ---

let userA: string;
let userB: string;
let currentUserId: string;

async function insertUser(username: string): Promise<string> {
  const res = await query<{ id: string }>(
    "INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, 'x', 'user') RETURNING id",
    [username, `${username}@test`],
  );
  return res.rows[0]!.id;
}

async function insertLocalSpace(spaceKey: string, createdBy: string): Promise<void> {
  await query(
    `INSERT INTO spaces (space_key, space_name, source, created_by, last_synced)
     VALUES ($1, $1, 'local', $2, NOW())`,
    [spaceKey, createdBy],
  );
}

async function insertStandalonePage(
  title: string,
  visibility: 'private' | 'shared',
  createdBy: string,
  spaceKey: string,
): Promise<void> {
  await query(
    `INSERT INTO pages (space_key, title, body_html, body_text, version, source,
                        visibility, created_by_user_id, embedding_dirty, embedding_status)
     VALUES ($1, $2, '<p>x</p>', 'x', 1, 'standalone', $3, $4, FALSE, 'not_embedded')`,
    [spaceKey, title, visibility, createdBy],
  );
}

async function insertConfluencePage(confluenceId: string, title: string, spaceKey: string): Promise<void> {
  await query(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text,
                        body_storage, body_html, inherit_perms)
     VALUES ($1, 'confluence', $2, $3, 'text', '', '', TRUE)`,
    [confluenceId, spaceKey, title],
  );
}

// --- Tests ---

describe.skipIf(!dbAvailable)('GET /api/pages/tree — visibility predicate (DB)', () => {
  let app: ReturnType<typeof Fastify>;

  async function treeTitles(asUser: string, url = '/api/pages/tree'): Promise<string[]> {
    currentUserId = asUser;
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: Array<{ title: string }> };
    return body.items.map((i) => i.title).sort();
  }

  beforeAll(async () => {
    await setupTestDb();

    app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed' });
      }
      return reply.status(error.statusCode ?? 500).send({ error: error.message });
    });
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = currentUserId;
    });
    app.decorate('requireAdmin', async (request: { userId: string }) => {
      request.userId = currentUserId;
    });
    app.decorate('redis', {});
    const { pagesCrudRoutes } = await import('./pages-crud.js');
    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
    userA = await insertUser('tree_vis_a');
    userB = await insertUser('tree_vis_b');
    await insertLocalSpace('NOTES', userA);
    mockGetUserAccessibleSpaces.mockResolvedValue([]);
  });

  it("hides another user's private standalone article (user B sees only the shared one)", async () => {
    await insertStandalonePage('Private note', 'private', userA, 'NOTES');
    await insertStandalonePage('Shared note', 'shared', userA, 'NOTES');

    expect(await treeTitles(userB)).toEqual(['Shared note']);
  });

  it('shows the owner both their private and shared standalone articles', async () => {
    await insertStandalonePage('Private note', 'private', userA, 'NOTES');
    await insertStandalonePage('Shared note', 'shared', userA, 'NOTES');

    expect(await treeTitles(userA)).toEqual(['Private note', 'Shared note']);
  });

  it('limits Confluence pages to RBAC-accessible spaces', async () => {
    await insertConfluencePage('conf-dev', 'Dev page', 'DEV');
    await insertConfluencePage('conf-secret', 'Secret page', 'SECRET');
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

    expect(await treeTitles(userB)).toEqual(['Dev page']);
  });

  it('keeps the spaceKey filter working on top of the visibility predicate', async () => {
    await insertConfluencePage('conf-dev', 'Dev page', 'DEV');
    await insertStandalonePage('Private note', 'private', userA, 'NOTES');
    await insertStandalonePage('Shared note', 'shared', userA, 'NOTES');
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

    expect(await treeTitles(userB, '/api/pages/tree?spaceKey=DEV')).toEqual(['Dev page']);
    expect(await treeTitles(userB, '/api/pages/tree?spaceKey=NOTES')).toEqual(['Shared note']);
  });
});
