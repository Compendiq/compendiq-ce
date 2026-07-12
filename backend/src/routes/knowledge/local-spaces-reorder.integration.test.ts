/**
 * Integration tests for `PUT /api/pages/:id/reorder` against a REAL PostgreSQL
 * (#959 review follow-up).
 *
 * The unit tests in `local-spaces.test.ts` mock the DB, so the sibling
 * renumbering — the whole point of the fix — never executes there. These tests
 * seed real sibling groups whose rows all share `sort_order = 0` (so they order
 * alphabetically by title, exactly like freshly created / Confluence-synced
 * pages) and drive the real route, then read the persisted `sort_order` back.
 *
 * Before the fix the handler wrote `sort_order` only for the dragged page, so a
 * page dropped at the top still sorted after its siblings (all still 0). These
 * tests assert the WHOLE sibling group is renumbered to a dense sequence that
 * honours the drop index exactly.
 *
 * Only infrastructure side-channels are stubbed (Redis cache wrapper, audit
 * log). RBAC is real: the test user is an admin, so `userCanAccessPage` passes
 * via the system-admin bypass without extra fixtures.
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

vi.mock('../../core/services/redis-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/services/redis-cache.js')>()),
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

const dbAvailable = await isDbAvailable();

let userId: string;

async function createPage(opts: {
  title: string;
  parentRef?: string | null;
  spaceKey?: string;
}): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text,
                        body_storage, body_html, inherit_perms, parent_id, sort_order)
     VALUES ($1, 'standalone', $2, $3, 'text', '', '', TRUE, $4, 0)
     RETURNING id`,
    [null, opts.spaceKey ?? 'PROJ', opts.title, opts.parentRef ?? null],
  );
  return res.rows[0]!.id;
}

/** Return the sibling titles ordered exactly as the tree renders them. */
async function orderedTitlesUnder(parentId: number): Promise<string[]> {
  const res = await query<{ title: string }>(
    `SELECT title FROM pages
     WHERE parent_id = $1 AND deleted_at IS NULL
     ORDER BY sort_order ASC, title ASC`,
    [String(parentId)],
  );
  return res.rows.map((r) => r.title);
}

async function sortOrderOf(id: number): Promise<number> {
  const res = await query<{ sort_order: number }>(
    'SELECT sort_order FROM pages WHERE id = $1',
    [id],
  );
  return res.rows[0]!.sort_order;
}

describe.skipIf(!dbAvailable)('PUT /api/pages/:id/reorder — sibling renumber against real Postgres (#959)', () => {
  let app: ReturnType<typeof Fastify>;

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
      request.userId = userId;
    });
    app.decorate('requireAdmin', async (request: { userId: string }) => {
      request.userId = userId;
    });
    app.decorate('redis', {});
    const { localSpacesRoutes } = await import('./local-spaces.js');
    await app.register(localSpacesRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
    const res = await query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('reorder_admin', 'reorder@test', 'x', 'admin') RETURNING id",
    );
    userId = res.rows[0]!.id;
  });

  async function reorder(id: number, sortOrder: number) {
    return app.inject({
      method: 'PUT',
      url: `/api/pages/${id}/reorder`,
      payload: { sortOrder },
    });
  }

  /** Seed a parent with three children A, B, C, all sort_order 0. */
  async function seedTrio(): Promise<{ parent: number; a: number; b: number; c: number }> {
    const parent = await createPage({ title: 'Parent' });
    const a = await createPage({ title: 'A', parentRef: String(parent) });
    const b = await createPage({ title: 'B', parentRef: String(parent) });
    const c = await createPage({ title: 'C', parentRef: String(parent) });
    // All three tie on sort_order 0, so they currently order alphabetically.
    expect(await orderedTitlesUnder(parent)).toEqual(['A', 'B', 'C']);
    return { parent, a, b, c };
  }

  it('drops the last sibling at the top and renumbers the whole group (C, A, B)', async () => {
    const { parent, c } = await seedTrio();

    // Drag C (currently last, index 2) to the very top (drop index 0).
    const res = await reorder(c, 0);
    expect(res.statusCode).toBe(200);

    // The dragged page and every untouched sibling get a dense 0..N-1 order
    // reflecting the new placement — not just C's own row.
    expect(await orderedTitlesUnder(parent)).toEqual(['C', 'A', 'B']);
    expect(await sortOrderOf(c)).toBe(0);
  });

  it('drops a sibling at a middle index and honours the exact position (B, A, C)', async () => {
    const { parent, a } = await seedTrio();

    // Drag A (currently first, index 0) to the middle (drop index 1).
    const res = await reorder(a, 1);
    expect(res.statusCode).toBe(200);

    expect(await orderedTitlesUnder(parent)).toEqual(['B', 'A', 'C']);
    expect(await sortOrderOf(a)).toBe(1);
  });

  it('persists a dense 0..N-1 sequence across the whole group', async () => {
    const { parent, c } = await seedTrio();

    await reorder(c, 0);

    const rows = await query<{ sort_order: number }>(
      `SELECT sort_order FROM pages WHERE parent_id = $1 AND deleted_at IS NULL
       ORDER BY sort_order ASC`,
      [String(parent)],
    );
    expect(rows.rows.map((r) => r.sort_order)).toEqual([0, 1, 2]);
  });
});
