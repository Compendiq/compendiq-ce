/**
 * GET /api/pages/trash contract + standalone auto-purge — REAL PostgreSQL.
 *
 * Regression (UX review, trash contract repair): the Trash UI renders
 * `deletedBy` and `autoPurgeAt` per item and promises "purged after 30 days",
 * but the backend returned neither field and nothing ever purged soft-deleted
 * standalone pages (the only purge was Confluence-sync-scoped). Contract:
 *   - each trash item carries `deletedBy` (owner's username — owner == deleter
 *     for standalone articles) and `autoPurgeAt` (= deleted_at + 30 days, ISO);
 *   - `purgeExpiredStandalonePages()` hard-deletes standalone pages
 *     soft-deleted more than 30 days ago, leaves newer trash and Confluence
 *     pages alone, and returns the purged count.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { TrashListResponseSchema } from '@compendiq/contracts';
import {
  insertUser,
  insertLocalSpace,
  insertStandalonePage,
  insertConfluencePage,
  buildKnowledgeTestApp,
} from './pages.test-helpers.js';

// --- Boundary mocks (everything else is real) ---

// No Redis in tests — no-op cache so every request hits the real DB.
vi.mock('../../core/services/redis-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/services/redis-cache.js')>()),
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
    // Shared/Confluence deletes clear every user's cache (#893).
    invalidateAcrossUsers = vi.fn().mockResolvedValue(undefined);
  },
}));

const mockGetUserAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

const dbAvailable = await isDbAvailable();

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS);

// --- Tests ---

describe.skipIf(!dbAvailable)('GET /api/pages/trash + standalone auto-purge (DB)', () => {
  let app: FastifyInstance;
  let userA: string;
  let currentUserId: string;

  beforeAll(async () => {
    await setupTestDb();
    app = await buildKnowledgeTestApp(
      () => currentUserId,
      async (a) => {
        const { pagesCrudRoutes } = await import('./pages-crud.js');
        await a.register(pagesCrudRoutes, { prefix: '/api' });
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
    userA = await insertUser('trash_owner_a');
    await insertLocalSpace('NOTES', userA);
    mockGetUserAccessibleSpaces.mockResolvedValue([]);
  });

  it('returns deletedBy (owner username) and autoPurgeAt (= deletedAt + 30 days, ISO) per item', async () => {
    const oldDeletedAt = daysAgo(31);
    const newDeletedAt = new Date();
    await insertStandalonePage('Old trashed note', 'private', userA, 'NOTES', { deletedAt: oldDeletedAt });
    await insertStandalonePage('Fresh trashed note', 'private', userA, 'NOTES', { deletedAt: newDeletedAt });

    currentUserId = userA;
    const response = await app.inject({ method: 'GET', url: '/api/pages/trash' });
    expect(response.statusCode).toBe(200);

    // Wire contract: the body must satisfy the shared schema exactly
    // (string id, ISO-string dates, enum source/visibility).
    const body = TrashListResponseSchema.parse(response.json());
    expect(body.total).toBe(2);

    // Ordered by deleted_at DESC → freshest first
    expect(body.items.map((i) => i.title)).toEqual(['Fresh trashed note', 'Old trashed note']);

    for (const [item, deletedAt] of [
      [body.items[0]!, newDeletedAt],
      [body.items[1]!, oldDeletedAt],
    ] as const) {
      expect(item.deletedBy).toBe('trash_owner_a');
      expect(item.deletedAt).toBe(deletedAt.toISOString());
      expect(item.autoPurgeAt).toBe(new Date(deletedAt.getTime() + 30 * DAY_MS).toISOString());
      // Existing fields stay on the wire
      expect(item.source).toBe('standalone');
      expect(item.visibility).toBe('private');
    }
  });

  it('purges standalone pages trashed >30 days ago, keeps fresh trash, returns the count', async () => {
    const expiredId = await insertStandalonePage('Expired trash', 'private', userA, 'NOTES', {
      deletedAt: daysAgo(31),
    });
    const freshId = await insertStandalonePage('Fresh trash', 'private', userA, 'NOTES', {
      deletedAt: new Date(),
    });
    const liveId = await insertStandalonePage('Live note', 'private', userA, 'NOTES');
    // Soft-deleted Confluence page older than the window — must NOT be touched
    // (its purge is Confluence-sync-scoped with upstream re-confirmation).
    const confluenceId = await insertConfluencePage('conf-trashed', 'Conf trashed', 'DEV', {
      deletedAt: daysAgo(45),
    });
    // FK-cascade check: a pin on the expired page must not block the purge.
    await query('INSERT INTO pinned_pages (user_id, page_id) VALUES ($1, $2)', [userA, expiredId]);

    const { purgeExpiredStandalonePages } = await import(
      '../../core/services/data-retention-service.js'
    );
    const purged = await purgeExpiredStandalonePages();
    expect(purged).toBe(1);

    const remaining = await query<{ id: number }>('SELECT id FROM pages ORDER BY id');
    expect(remaining.rows.map((r) => r.id)).toEqual(
      [freshId, liveId, confluenceId].sort((a, b) => a - b),
    );

    const pins = await query('SELECT page_id FROM pinned_pages');
    expect(pins.rows).toEqual([]);

    // Second run finds nothing — count is per-run, not cumulative.
    expect(await purgeExpiredStandalonePages()).toBe(0);
  });

  // Nested here to reuse the real-DB app bootstrap + seeders (this file is
  // the pagesCrudRoutes-against-real-Postgres harness).
  describe('GET /api/pages/:id — createdByUserId exposure', () => {
    it('exposes createdByUserId for a standalone page so the UI can detect own pages', async () => {
      const pageId = await insertStandalonePage('My own note', 'private', userA, 'NOTES');

      currentUserId = userA;
      const response = await app.inject({ method: 'GET', url: `/api/pages/${pageId}` });
      expect(response.statusCode).toBe(200);

      const body = response.json() as { source: string; createdByUserId: string | null };
      expect(body.source).toBe('standalone');
      expect(body.createdByUserId).toBe(userA);
    });

    it('returns null createdByUserId for a synced Confluence page', async () => {
      const pageId = await insertConfluencePage('conf-own-1', 'Conf page', 'DEV');
      mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

      currentUserId = userA;
      const response = await app.inject({ method: 'GET', url: `/api/pages/${pageId}` });
      expect(response.statusCode).toBe(200);

      const body = response.json() as { source: string; createdByUserId: string | null };
      expect(body.source).toBe('confluence');
      expect(body.createdByUserId).toBeNull();
    });
  });
});
