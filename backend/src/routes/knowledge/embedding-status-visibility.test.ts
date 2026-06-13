/**
 * GET /api/llm/embedding-status — visibility scope against a REAL PostgreSQL.
 *
 * Regression: the dashboard KPI counts (Total Articles/Pages, Embedded Pages,
 * coverage %) only counted pages whose space_key was in the caller's RBAC
 * spaces, so standalone articles never counted — a regular user saw
 * "0 total" while their sidebar tree showed pages. The status counts must
 * apply the same visibility predicate as the pages tree/list routes:
 *   - Confluence pages from RBAC-accessible spaces
 *   - shared standalone articles (visible to all)
 *   - the caller's own private standalone articles
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import {
  insertUser,
  insertLocalSpace,
  insertStandalonePage,
  insertConfluencePage,
  insertEmbeddings,
  buildKnowledgeTestApp,
} from './pages.test-helpers.js';

// --- Boundary mocks (everything else is real) ---

const mockGetUserAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

const dbAvailable = await isDbAvailable();

// --- Tests ---

describe.skipIf(!dbAvailable)('GET /api/llm/embedding-status — visibility scope (DB)', () => {
  let app: FastifyInstance;
  let userA: string;
  let userB: string;
  let currentUserId: string;

  async function statusAs(asUser: string): Promise<{
    totalPages: number;
    embeddedPages: number;
    dirtyPages: number;
    totalEmbeddings: number;
  }> {
    currentUserId = asUser;
    const response = await app.inject({ method: 'GET', url: '/api/llm/embedding-status' });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  beforeAll(async () => {
    await setupTestDb();
    app = await buildKnowledgeTestApp(
      () => currentUserId,
      async (a) => {
        const { knowledgeAdminRoutes } = await import('./knowledge-admin.js');
        await a.register(knowledgeAdminRoutes, { prefix: '/api' });
      },
    );
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
    userA = await insertUser('embed_status_a');
    userB = await insertUser('embed_status_b');
    await insertLocalSpace('NOTES', userA);
    mockGetUserAccessibleSpaces.mockResolvedValue([]);
  });

  it("counts only B-visible pages for user B (shared note, not A's private one)", async () => {
    await insertStandalonePage('Private note', 'private', userA, 'NOTES');
    await insertStandalonePage('Shared note', 'shared', userA, 'NOTES');

    const status = await statusAs(userB);
    expect(status.totalPages).toBe(1);
  });

  it('counts both standalone pages for their owner', async () => {
    await insertStandalonePage('Private note', 'private', userA, 'NOTES');
    await insertStandalonePage('Shared note', 'shared', userA, 'NOTES');

    const status = await statusAs(userA);
    expect(status.totalPages).toBe(2);
  });

  it('limits Confluence pages to RBAC-accessible spaces', async () => {
    await insertConfluencePage('conf-dev', 'Dev page', 'DEV');
    await insertConfluencePage('conf-secret', 'Secret page', 'SECRET');
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

    const status = await statusAs(userB);
    expect(status.totalPages).toBe(1);
  });

  it('scopes dirty, embedded-page and chunk counts to visible pages', async () => {
    const privateId = await insertStandalonePage('Private note', 'private', userA, 'NOTES', { dirty: true });
    const sharedId = await insertStandalonePage('Shared note', 'shared', userA, 'NOTES');
    await insertEmbeddings(privateId, 1);
    await insertEmbeddings(sharedId, 2);

    const asB = await statusAs(userB);
    expect(asB.totalPages).toBe(1);
    expect(asB.dirtyPages).toBe(0);
    expect(asB.embeddedPages).toBe(1);
    expect(asB.totalEmbeddings).toBe(2);

    const asA = await statusAs(userA);
    expect(asA.totalPages).toBe(2);
    expect(asA.dirtyPages).toBe(1);
    expect(asA.embeddedPages).toBe(2);
    expect(asA.totalEmbeddings).toBe(3);
  });
});
