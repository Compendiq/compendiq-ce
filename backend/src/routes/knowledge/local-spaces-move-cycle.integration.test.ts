/**
 * Integration tests for the `PUT /api/pages/:id/move` cycle guard (#891)
 * against a REAL PostgreSQL.
 *
 * The unit tests in `local-spaces.test.ts` mock the DB entirely, so the
 * recursive-CTE ancestor walk — the entire #891 fix — never executes there.
 * These tests build actual page chains (both standalone pages whose
 * `parent_id` holds the parent's numeric id as text, and Confluence-synced
 * pages whose `parent_id` holds the parent's `confluence_id` and whose
 * materialized `path` is NULL) and drive the real route, so a SQL defect in
 * the CTE (wrong cast, inverted logic, join mismatch) fails here.
 *
 * Only infrastructure side-channels are stubbed (Redis cache wrapper, audit
 * log). RBAC is real: the test user is an admin, so `userCanAccessPage`
 * passes via the system-admin bypass without extra fixtures.
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
import { query, getPool } from '../../core/db/postgres.js';
import { PAGE_MOVE_ADVISORY_LOCK_ID } from './local-spaces.js';

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

// --- Fixtures ---

let userId: string;

async function createPage(opts: {
  title: string;
  source?: 'standalone' | 'confluence';
  confluenceId?: string | null;
  /** Raw parent_id text: the parent's numeric id as text, or its confluence_id. */
  parentRef?: string | null;
  spaceKey?: string;
}): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text,
                        body_storage, body_html, inherit_perms, parent_id)
     VALUES ($1, $2, $3, $4, 'text', '', '', TRUE, $5)
     RETURNING id`,
    [
      opts.confluenceId ?? null,
      opts.source ?? 'standalone',
      opts.spaceKey ?? 'PROJ',
      opts.title,
      opts.parentRef ?? null,
    ],
  );
  return res.rows[0]!.id;
}

async function setPath(id: number, path: string | null, depth: number): Promise<void> {
  await query('UPDATE pages SET path = $1, depth = $2 WHERE id = $3', [path, depth, id]);
}

async function getPageRow(id: number): Promise<{
  parent_id: string | null;
  path: string | null;
  depth: number;
  space_key: string | null;
}> {
  const res = await query<{
    parent_id: string | null;
    path: string | null;
    depth: number;
    space_key: string | null;
  }>('SELECT parent_id, path, depth, space_key FROM pages WHERE id = $1', [id]);
  return res.rows[0]!;
}

/**
 * Standalone chain root → … → leaf: `parent_id` holds the parent's NUMERIC id
 * as text and every page has a correct materialized path. Returns ids
 * root-first.
 */
async function createStandaloneChain(length: number, prefix = 'chain'): Promise<number[]> {
  const ids: number[] = [];
  let parentPath: string | null = null;
  for (let i = 0; i < length; i++) {
    const id = await createPage({
      title: `${prefix}-${i}`,
      parentRef: ids.length > 0 ? String(ids[ids.length - 1]) : null,
    });
    const path = parentPath ? `${parentPath}/${id}` : `/${id}`;
    await setPath(id, path, i);
    parentPath = path;
    ids.push(id);
  }
  return ids;
}

/**
 * Confluence-style chain: `parent_id` holds the parent's CONFLUENCE id and the
 * materialized `path` stays NULL — exactly the shape synced pages have, where
 * the old path-substring cycle guard was a silent no-op. Returns numeric ids
 * root-first.
 */
async function createConfluenceChain(confluenceIds: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < confluenceIds.length; i++) {
    const id = await createPage({
      title: `conf-${confluenceIds[i]}`,
      source: 'confluence',
      confluenceId: confluenceIds[i],
      parentRef: i > 0 ? confluenceIds[i - 1] : null,
    });
    ids.push(id);
  }
  return ids;
}

/**
 * Walk the parent chain from a page in JS, resolving `parent_id` against both
 * confluence_id and numeric id (like the tree queries do). Returns the visited
 * numeric ids; throws if the walk revisits a page (a real cycle) or exceeds
 * `maxHops`.
 */
async function walkParents(startId: number, maxHops = 10): Promise<number[]> {
  const visited: number[] = [];
  let current: number | null = startId;
  while (current !== null) {
    if (visited.includes(current)) {
      throw new Error(`parent_id cycle detected: ${[...visited, current].join(' -> ')}`);
    }
    visited.push(current);
    if (visited.length > maxHops) {
      throw new Error(`parent walk exceeded ${maxHops} hops: ${visited.join(' -> ')}`);
    }
    const res = await query<{ id: number }>(
      `SELECT p.id FROM pages p
       JOIN pages child ON (p.confluence_id = child.parent_id OR CAST(p.id AS TEXT) = child.parent_id)
       WHERE child.id = $1 AND p.deleted_at IS NULL`,
      [current],
    );
    current = res.rows[0]?.id ?? null;
  }
  return visited;
}

// --- Tests ---

describe.skipIf(!dbAvailable)('PUT /api/pages/:id/move — cycle guard against real Postgres (#891)', () => {
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
    // Admin user: userCanAccessPage passes via the system-admin bypass, so the
    // move route's RBAC checks run for real without per-space fixtures.
    const res = await query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('move_admin', 'move@test', 'x', 'admin') RETURNING id",
    );
    userId = res.rows[0]!.id;
  });

  async function movePage(id: number, parentId: number | string | null) {
    return app.inject({
      method: 'PUT',
      url: `/api/pages/${id}/move`,
      payload: { parentId },
    });
  }

  // ── (a) self-parent ───────────────────────────────────────────────────────

  it('rejects making a page its own parent (400) and leaves the row untouched', async () => {
    const [a] = await createStandaloneChain(1, 'self');

    const response = await movePage(a!, a!);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('itself or its own descendant');
    const row = await getPageRow(a!);
    expect(row.parent_id).toBeNull();
    expect(row.path).toBe(`/${a}`);
  });

  // ── (b) move under own descendant (materialized-path chain) ───────────────

  it('rejects moving a page under its own descendant across a real A→B→C chain', async () => {
    const [a, b, c] = await createStandaloneChain(3, 'abc');

    // Move A under its grandchild C — the CTE must walk C → B → A and find A.
    const underGrandchild = await movePage(a!, c!);
    expect(underGrandchild.statusCode).toBe(400);
    expect(underGrandchild.json().error).toContain('itself or its own descendant');

    // Move A under its direct child B — one recursion step.
    const underChild = await movePage(a!, b!);
    expect(underChild.statusCode).toBe(400);

    // Nothing moved, no path corrupted.
    expect((await getPageRow(a!)).parent_id).toBeNull();
    expect((await getPageRow(b!)).path).toBe(`/${a}/${b}`);
    expect((await getPageRow(c!)).path).toBe(`/${a}/${b}/${c}`);
  });

  // ── (c) Confluence-style chain: parent_id = confluence_id, path NULL ──────

  it('rejects the NULL-path Confluence chain cycle the old substring check missed', async () => {
    const [root, , leaf] = await createConfluenceChain(['c-root', 'c-mid', 'c-leaf']);

    // Pre-#891 this passed silently: root.path is NULL, so the old
    // `parentPath.includes('/id/')` guard never fired. The CTE must resolve
    // leaf → c-mid → c-root through the confluence_id branch of the join.
    const response = await movePage(root!, leaf!);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('itself or its own descendant');
    expect((await getPageRow(root!)).parent_id).toBeNull();
    // The chain still terminates when walked from the leaf.
    await expect(walkParents(leaf!)).resolves.toHaveLength(3);
  });

  it('allows a legal reparent within a NULL-path Confluence chain', async () => {
    const [root, , leaf] = await createConfluenceChain(['c2-root', 'c2-mid', 'c2-leaf']);

    // Moving the leaf directly under the root is legal (root has no ancestors).
    const response = await movePage(leaf!, root!);

    expect(response.statusCode).toBe(200);
    // parent_id is rewritten to the numeric-id-as-text form.
    expect((await getPageRow(leaf!)).parent_id).toBe(String(root));
    await expect(walkParents(leaf!)).resolves.toEqual([leaf, root]);
  });

  // ── (d) legal move updates parent_id, path, depth — including descendants ─

  it('performs a legal move: parent_id, path and depth update for the page and its subtree', async () => {
    const [r1, c1] = await createStandaloneChain(2, 'src'); // r1 → c1
    const [r2] = await createStandaloneChain(1, 'dst');

    const response = await movePage(r1!, r2!);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.parentId).toBe(r2);
    expect(body.path).toBe(`/${r2}/${r1}`);
    expect(body.depth).toBe(1);

    const movedRoot = await getPageRow(r1!);
    expect(movedRoot.parent_id).toBe(String(r2));
    expect(movedRoot.path).toBe(`/${r2}/${r1}`);
    expect(movedRoot.depth).toBe(1);

    // The descendant's materialized path was rewritten in the same request.
    const child = await getPageRow(c1!);
    expect(child.path).toBe(`/${r2}/${r1}/${c1}`);
    expect(child.depth).toBe(2);

    await expect(walkParents(c1!)).resolves.toEqual([c1, r1, r2]);
  });

  // ── concurrency: moves are serialized on the advisory lock (#891 review) ──

  it('queues a move behind the page-move advisory lock and completes once it is released', async () => {
    const [a] = await createStandaloneChain(1, 'lockA');
    const [b] = await createStandaloneChain(1, 'lockB');

    // Hold the lock on a separate session, exactly like a concurrent move would.
    const holder = await getPool().connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1)', [PAGE_MOVE_ADVISORY_LOCK_ID]);

      const pending = movePage(a!, b!);
      const raced = await Promise.race([
        pending.then(() => 'completed' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 300)),
      ]);
      // The handler must be waiting on the lock — nothing committed yet.
      expect(raced).toBe('blocked');
      expect((await getPageRow(a!)).parent_id).toBeNull();

      await holder.query('COMMIT'); // xact-scoped lock released here

      const response = await pending;
      expect(response.statusCode).toBe(200);
      expect((await getPageRow(a!)).parent_id).toBe(String(b));
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('concurrent mutual moves (A under B, B under A) cannot commit a parent_id cycle', async () => {
    const [a] = await createStandaloneChain(1, 'raceA');
    const [b] = await createStandaloneChain(1, 'raceB');

    const [r1, r2] = await Promise.all([movePage(a!, b!), movePage(b!, a!)]);

    // Serialized on the advisory lock: whichever move wins commits, and the
    // loser re-runs its cycle check against the winner's committed state and
    // is rejected. Exactly one 200 and one 400 — never two 200s.
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 400]);

    // No mutual cycle was persisted.
    const rowA = await getPageRow(a!);
    const rowB = await getPageRow(b!);
    expect(rowA.parent_id === String(b) && rowB.parent_id === String(a)).toBe(false);

    // Walking parents from either page terminates (throws on a revisit).
    await expect(walkParents(a!)).resolves.toBeDefined();
    await expect(walkParents(b!)).resolves.toBeDefined();
  });
});
