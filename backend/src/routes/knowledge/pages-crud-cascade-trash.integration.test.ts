/**
 * #1636 — trashing a standalone article cascades to its whole subtree.
 *
 * Before this, `DELETE /api/pages/:id` soft-deleted exactly one row. Its live
 * descendants kept `parent_id` pointing at the trashed row, so `GET
 * /api/pages/tree`'s `LEFT JOIN pages parent_page ON (…) AND
 * parent_page.deleted_at IS NULL` answered `parentId: null` for them and
 * `SidebarTreeView` rendered them as roots. `GET /api/pages/:id` could not see
 * the children at all (`has_children` matched `parent_id = confluence_id` only,
 * and standalone rows have no `confluence_id`), so no dialog could warn.
 *
 * These tests drive the real routes against real PostgreSQL and Redis,
 * including authoritative RBAC and persisted audit rows.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import type { FastifyInstance } from 'fastify';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { getPool, query } from '../../core/db/postgres.js';
import {
  ATTACHMENT_SNAPSHOT_LOCK_ID,
  PAGE_HIERARCHY_LOCK_ID,
} from '../../core/db/advisory-locks.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { invalidateRbacCache } from '../../core/services/rbac-service.js';
import { encryptPat } from '../../core/utils/crypto.js';
import { pagesCrudRoutes } from './pages-crud.js';
import {
  insertUser,
  insertLocalSpace,
  insertStandalonePage,
  insertConfluencePage,
  buildKnowledgeTestApp,
} from './pages.test-helpers.js';

const available = await isDbAvailable() && await isRedisAvailable();

async function setAccessibleSpaces(userId: string, spaceKeys: readonly string[]): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, is_system, permissions)
     VALUES ('cascade-reader', 'Cascade reader', FALSE, ARRAY['read','comment','edit','delete','manage'])
     ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
     RETURNING id`,
  );
  await query(
    `DELETE FROM space_role_assignments
      WHERE principal_type = 'user' AND principal_id = $1`,
    [userId],
  );
  for (const spaceKey of spaceKeys) {
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $3)`,
      [spaceKey, userId, role.rows[0]!.id],
    );
  }
  await invalidateRbacCache(userId);
}

async function seedPageCache(redis: RedisClientType, userIds: readonly string[]): Promise<void> {
  await Promise.all(userIds.map((userId) => redis.set(`kb:${userId}:pages:sentinel`, userId)));
}

async function cachedPageUsers(redis: RedisClientType, userIds: readonly string[]): Promise<string[]> {
  const values = await Promise.all(
    userIds.map(async (userId) => [userId, await redis.get(`kb:${userId}:pages:sentinel`)] as const),
  );
  return values.filter(([, value]) => value !== null).map(([userId]) => userId);
}

/**
 * A PK parked out of any sequence's reach, for the cases that need a page's id
 * to equal another page's `confluence_id`.
 *
 * It cannot be a small literal. `truncateAllTables`
 * (`backend/src/test-db-helper.ts`) truncates WITHOUT `RESTART IDENTITY`, so
 * `pages_id_seq` climbs monotonically across every suite sharing a worker
 * database: a hardcoded `1000` is unused only until that worker has inserted a
 * thousand pages, after which the fixture's `UPDATE pages SET id = 1000`
 * collides with a live row and the case fails for a reason that has nothing to
 * do with what it pins.
 *
 * It also cannot be pushed past 2^31 the way a Confluence content id can
 * (#1167): `pages.id` is int4 (`SERIAL`, migration 005), so this is the far
 * end of the representable range instead — two billion pages short of what a
 * test run inserts, and adjacent to the boundary the id arm is compared as
 * TEXT to survive.
 */
const PARKED_PK = 2000000000;

/** The trios every case builds: fixture order is root → child → grandchild. */
interface Tree {
  root: number;
  child: number;
  grandchild: number;
}

async function seedStandaloneTree(owner: string, visibility: 'private' | 'shared' = 'private'): Promise<Tree> {
  const root = await insertStandalonePage('Root', visibility, owner, 'NOTES');
  const child = await insertStandalonePage('Child', visibility, owner, 'NOTES', { parentId: String(root) });
  const grandchild = await insertStandalonePage('Grandchild', visibility, owner, 'NOTES', {
    parentId: String(child),
  });
  return { root, child, grandchild };
}

async function freezePage(pageId: number, actorId: string, secretTitle = 'FROZEN PRIVATE TITLE'): Promise<void> {
  await query(
    `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity)
     VALUES ('cascade-freeze-fixture', '{"kind":"test"}'::jsonb)
     ON CONFLICT (runtime_id) DO NOTHING`,
  );
  const fixture = await query<{ intent_id: string; baseline_id: string }>(
    `WITH ids AS (
       SELECT gen_random_uuid() AS intent_id, gen_random_uuid() AS baseline_id
     ), inserted AS (
       INSERT INTO page_write_intents (
         id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode,
         effect, status, settled_at, settlement_reason, settlement_proof
       )
       SELECT ids.intent_id, 'cascade-freeze-fixture', 'baseline.prepare', $2,
              ARRAY[p.id], jsonb_build_object(
                p.id::text,
                jsonb_build_object(
                  'contentRevision', p.content_revision::text,
                  'lifecycleRevision', p.lifecycle_revision::text
                )
              ),
              'local_verified',
              jsonb_build_object('effectClass', 'local', 'baselineId', ids.baseline_id::text),
              'completed', NOW(), 'effect_committed', '{}'::jsonb
         FROM ids
         JOIN pages p ON p.id = $1
       RETURNING id, (effect->>'baselineId')::uuid AS baseline_id
     )
     SELECT id::text AS intent_id, baseline_id::text FROM inserted`,
    [pageId, actorId],
  );
  const page = await query<{
    version: number;
    content_revision: string;
    lifecycle_revision: string;
    body_html: string | null;
  }>(
    `SELECT version, content_revision::text, lifecycle_revision::text, body_html
       FROM pages WHERE id = $1`,
    [pageId],
  );
  const baseline = fixture.rows[0]!;
  const state = page.rows[0]!;
  await query(
    `INSERT INTO page_baselines (
       id, page_id, original_page_id, page_identity, version,
       content_revision, lifecycle_revision, manifest_digest, manifest,
       manifest_bytes, title, body_html, total_bytes, reserved_bytes,
       status, prepared_by_user_id, prepared_by_name, preparation_intent_id,
       published_by_user_id, published_by_name, published_at, provenance, freeze_reason
     ) VALUES (
       $2, $1, $1, '[]'::jsonb, $3,
       $4::bigint, $5::bigint, $6, '[]'::jsonb,
       convert_to('[]', 'UTF8'), $7, $8, 0, 0,
       'published', $9, 'Cascade fixture', $10,
       $9, 'Cascade fixture', NOW(), 'manual_assertion', 'Regression freeze'
     )`,
    [
      pageId,
      baseline.baseline_id,
      state.version,
      state.content_revision,
      state.lifecycle_revision,
      '7'.repeat(64),
      secretTitle,
      state.body_html,
      actorId,
      baseline.intent_id,
    ],
  );
  await query(
    `UPDATE pages SET baseline_id = $2, frozen_version = version, frozen_at = NOW(),
       frozen_by_user_id = $3, frozen_by_name = 'Cascade fixture',
       freeze_reason = 'Regression freeze', freeze_provenance = 'manual_assertion',
       freeze_reported_signatories = '[]'::jsonb
     WHERE id = $1`,
    [pageId, baseline.baseline_id, actorId],
  );
}

async function waitForAdvisoryWaiter(lockId: number, description: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const waiting = await query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory'
            AND objid = $1
            AND NOT granted
       ) AS waiting`,
      [lockId],
    );
    if (waiting.rows[0]?.waiting) return;
  }
  throw new Error(`request did not wait for ${description}`);
}

/**
 * The batch key is `deleted_at` EQUALITY, so assert it in SQL:
 * `COUNT(DISTINCT deleted_at)` is exact at microsecond precision, which a JS
 * `Date` (millisecond) round-trip is not.
 */
async function distinctDeleteStamps(ids: number[]): Promise<number> {
  const res = await query<{ n: string }>(
    'SELECT COUNT(DISTINCT deleted_at)::text AS n FROM pages WHERE id = ANY($1::int[])',
    [ids],
  );
  return parseInt(res.rows[0]!.n, 10);
}

async function liveIds(ids: number[]): Promise<number[]> {
  const res = await query<{ id: number }>(
    'SELECT id FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL',
    [ids],
  );
  return res.rows.map((row) => row.id);
}

async function existingIds(ids: number[]): Promise<number[]> {
  const res = await query<{ id: number }>(
    'SELECT id FROM pages WHERE id = ANY($1::int[]) ORDER BY id',
    [ids],
  );
  return res.rows.map((row) => row.id);
}

async function treeItems(): Promise<Array<{ id: string; parentId: string | null }>> {
  const res = await app.inject({ method: 'GET', url: '/api/pages/tree' });
  expect(res.statusCode).toBe(200);
  return res.json().items as Array<{ id: string; parentId: string | null }>;
}

interface PersistedAudit {
  resource_id: string | null;
  metadata: Record<string, unknown>;
}

async function auditRows(action: string): Promise<PersistedAudit[]> {
  const result = await query<PersistedAudit>(
    'SELECT resource_id, metadata FROM audit_log WHERE action = $1 ORDER BY created_at, id',
    [action],
  );
  return result.rows;
}

let app: FastifyInstance;
let userA: string;
let userB: string;
let currentUserId: string;
let redis: RedisClientType;
let confluenceServer: Server;
let confluenceBaseUrl: string;
let confluenceCreateBodies: Array<Record<string, unknown>> = [];

describe.skipIf(!available)('cascading standalone trash (#1636) — real PostgreSQL', () => {
  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    }) as RedisClientType;
    await redis.connect();
    setRedisClient(redis);
    confluenceServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (request.method === 'POST' && request.url === '/rest/api/content') {
        confluenceCreateBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: '987654321',
        title: 'Synced child',
        version: { number: 1 },
        body: { storage: { value: '<p>x</p>' } },
      }));
    });
    await new Promise<void>((resolve) => confluenceServer.listen(0, '127.0.0.1', resolve));
    const address = confluenceServer.address() as AddressInfo;
    confluenceBaseUrl = `http://127.0.0.1:${address.port}`;
    app = await buildKnowledgeTestApp(() => currentUserId, async (instance) => {
      instance.redis = redis;
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => {
      confluenceServer.close((error) => error ? reject(error) : resolve());
    });
    if (redis.isOpen) await redis.quit();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await redis.flushDb();
    confluenceCreateBodies = [];
    userA = await insertUser('cascade_a');
    userB = await insertUser('cascade_b');
    currentUserId = userA;
    await insertLocalSpace('NOTES', userA);
    await insertLocalSpace('OTHER', userA);
    await setAccessibleSpaces(userA, ['NOTES']);
    await setAccessibleSpaces(userB, ['NOTES']);
  });

  // ── GET /api/pages/:id — hasChildren + descendantCount ────────────────────

  describe('GET /api/pages/:id', () => {
    it('reports hasChildren and descendantCount for a standalone parent with live sub-articles', async () => {
      const tree = await seedStandaloneTree(userA);

      const response = await app.inject({ method: 'GET', url: `/api/pages/${tree.root}` });
      expect(response.statusCode).toBe(200);

      const body = response.json() as { hasChildren: boolean; descendantCount: number };
      expect(body.hasChildren).toBe(true);
      expect(body.descendantCount).toBe(2);
    });

    it('counts only live descendants and agrees with hasChildren after a child is trashed on its own', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      await insertStandalonePage('Live child', 'private', userA, 'NOTES', { parentId: String(root) });
      await insertStandalonePage('Trashed child', 'private', userA, 'NOTES', {
        parentId: String(root),
        deletedAt: new Date(),
      });

      const response = await app.inject({ method: 'GET', url: `/api/pages/${root}` });
      const body = response.json() as { hasChildren: boolean; descendantCount: number };
      expect(body.hasChildren).toBe(true);
      expect(body.descendantCount).toBe(1);
    });

    it('reports hasChildren false and descendantCount 0 when every child is trashed', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      await insertStandalonePage('Trashed child', 'private', userA, 'NOTES', {
        parentId: String(root),
        deletedAt: new Date(),
      });

      const response = await app.inject({ method: 'GET', url: `/api/pages/${root}` });
      const body = response.json() as { hasChildren: boolean; descendantCount: number };
      expect(body.hasChildren).toBe(false);
      expect(body.descendantCount).toBe(0);
    });

    /**
     * The predicate must be the tree's dual-identifier join: a synced child's
     * `parent_id` holds its parent's `confluence_id`, not the parent's PK.
     */
    it('reports hasChildren for a synced child linked by confluence_id', async () => {
      const parent = await insertConfluencePage('conf-parent', 'Synced parent', 'NOTES');
      await insertConfluencePage('conf-child', 'Synced child', 'NOTES', { parentId: 'conf-parent' });

      const response = await app.inject({ method: 'GET', url: `/api/pages/${parent}` });
      const body = response.json() as { hasChildren: boolean; descendantCount: number };
      expect(body.hasChildren).toBe(true);
      // …but a Confluence subtree is Confluence's lifecycle, and the trash
      // takes none of it: `hasChildren` is the tree's question, the count is
      // the cascade's, and the cascade moves `source = 'standalone'` rows only.
      expect(body.descendantCount).toBe(0);
    });

    /**
     * `hasChildren` and `descendantCount` answer two DIFFERENT questions about
     * another user's sub-article, and #1636's review found both of them wrong
     * for the same fixture.
     *
     * `hasChildren` is the TREE's question — is there a twisty to open here? —
     * so it must count what the tree renders: another user's SHARED page is
     * visible to everyone (#893) and counts, their PRIVATE one is not and must
     * not. Without the route's `NOT (c2.source = 'standalone' AND
     * c2.visibility = 'private' AND c2.created_by_user_id IS DISTINCT FROM
     * $N)` guard the twisty opened onto nothing, and its mere presence
     * disclosed that someone keeps a private sub-article under this page.
     *
     * `descendantCount` is the CASCADE's question, and the cascade is
     * owner-scoped: it counts NEITHER of them, because it will move neither.
     * A count that named someone else's row would over-promise the delete the
     * confirm dialog is quoting.
     */
    it('counts another user’s shared sub-article in hasChildren but never in descendantCount', async () => {
      const root = await insertStandalonePage('Root', 'shared', userA, 'NOTES');
      const theirs = await insertStandalonePage('Bob private', 'private', userB, 'NOTES', {
        parentId: String(root),
      });

      const hidden = await app.inject({ method: 'GET', url: `/api/pages/${root}` });
      const hiddenBody = hidden.json() as { hasChildren: boolean; descendantCount: number };
      expect(hiddenBody.hasChildren).toBe(false);
      expect(hiddenBody.descendantCount).toBe(0);
      // The deprecated route asks the same question and must give the same
      // answer — its caller id sits in a different placeholder ($3 for a
      // numeric id), which is the kind of drift only a live call catches.
      const hiddenLegacy = await app.inject({
        method: 'GET',
        url: `/api/pages/${root}/has-children`,
      });
      expect(hiddenLegacy.json()).toEqual({ hasChildren: false });

      await query(`UPDATE pages SET visibility = 'shared' WHERE id = $1`, [theirs]);

      const shown = await app.inject({ method: 'GET', url: `/api/pages/${root}` });
      const shownBody = shown.json() as { hasChildren: boolean; descendantCount: number };
      expect(shownBody.hasChildren).toBe(true);
      expect(shownBody.descendantCount).toBe(0);
      const shownLegacy = await app.inject({
        method: 'GET',
        url: `/api/pages/${root}/has-children`,
      });
      expect(shownLegacy.json()).toEqual({ hasChildren: true });

      // …while the caller's OWN live sub-article is counted by both, so this
      // case cannot pass by answering zero to everything.
      await insertStandalonePage('Alice child', 'private', userA, 'NOTES', {
        parentId: String(root),
      });
      const mine = await app.inject({ method: 'GET', url: `/api/pages/${root}` });
      expect((mine.json() as { descendantCount: number }).descendantCount).toBe(1);
    });

    /**
     * The count and the cascade are the same set, so a Confluence-sourced row
     * inside a standalone subtree must not be counted: the DELETE leaves it
     * live (its own guard — see the mixed-source delete case below). This shape
     * is reachable: `PUT /pages/:id/move` re-parents a synced page under a
     * standalone parent without touching its `source`, and `POST /pages` stores
     * one the same way, so the subtree is not source-pure in practice.
     */
    it('counts only the standalone descendants the cascade will actually trash', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      await insertConfluencePage('conf-in-tree', 'Synced child', 'NOTES', { parentId: String(root) });
      await insertStandalonePage('Local grandchild', 'private', userA, 'NOTES', {
        parentId: 'conf-in-tree',
      });

      const response = await app.inject({ method: 'GET', url: `/api/pages/${root}` });
      const body = response.json() as { hasChildren: boolean; descendantCount: number };
      expect(body.hasChildren).toBe(true);
      expect(body.descendantCount).toBe(1);
    });

    /**
     * The set `descendantCount` counts and the cascade trashes must be the set
     * the Children macro renders — two separate CTEs, one tree.
     *
     * Both sides are stated independently: the rendered ids against the
     * fixture, the SIZE against what `GET /api/pages/:id` promised. Asking the
     * walk itself what it walked would only prove the walk equals itself.
     */
    it('walks the same subtree GET /pages/:id/children renders', async () => {
      const tree = await seedStandaloneTree(userA);
      await insertStandalonePage('Trashed child', 'private', userA, 'NOTES', {
        parentId: String(tree.root),
        deletedAt: new Date(),
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/pages/${tree.root}/children?depth=3`,
      });
      expect(response.statusCode).toBe(200);

      const rendered: number[] = [];
      const collect = (nodes: Array<{ id: number; children?: unknown[] }>): void => {
        for (const node of nodes) {
          rendered.push(node.id);
          collect((node.children ?? []) as Array<{ id: number; children?: unknown[] }>);
        }
      };
      collect(response.json().children as Array<{ id: number; children?: unknown[] }>);

      const detail = await app.inject({ method: 'GET', url: `/api/pages/${tree.root}` });
      const promised = (detail.json() as { descendantCount: number }).descendantCount;

      // The two live sub-articles, and not the child trashed on its own.
      expect(rendered.sort()).toEqual([tree.child, tree.grandchild].sort());
      expect(rendered).toHaveLength(promised);
    });

    it('keeps the deprecated has-children route in agreement with the field', async () => {
      const tree = await seedStandaloneTree(userA);

      const response = await app.inject({ method: 'GET', url: `/api/pages/${tree.root}/has-children` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ hasChildren: true });

      // Same numeric normalisation as its sibling routes: a zero-padded id
      // resolves the page it denotes, it does not compare literally.
      const padded = await app.inject({
        method: 'GET',
        url: `/api/pages/00${tree.root}/has-children`,
      });
      expect(padded.statusCode).toBe(200);
      expect(padded.json()).toEqual({ hasChildren: true });
    });

    /**
     * The deprecated route resolves a page row, so it answers an existence
     * question — and must refuse the same callers its siblings refuse. Before
     * #1636 the handler could never 404 (`SELECT COUNT(*)` always returned a
     * row), so a 404 here is a NEW discriminator: without the access check it
     * becomes an existence oracle for a page `GET /api/pages/:id` will not
     * show, and it leaks `hasChildren` alongside it.
     */
    it('refuses a page the caller cannot read, exactly as its sibling routes do', async () => {
      const priv = await insertStandalonePage('Private', 'private', userA, 'NOTES');
      await insertStandalonePage('Child', 'private', userA, 'NOTES', { parentId: String(priv) });

      currentUserId = userB;
      for (const url of [
        `/api/pages/${priv}`,
        `/api/pages/${priv}/children`,
        `/api/pages/${priv}/has-children`,
      ]) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(404);
      }

      // …and a page the caller CAN read still answers, agreeing with the field.
      const shared = await insertStandalonePage('Shared', 'shared', userA, 'NOTES');
      await insertStandalonePage('Shared child', 'shared', userA, 'NOTES', { parentId: String(shared) });

      const answer = await app.inject({ method: 'GET', url: `/api/pages/${shared}/has-children` });
      expect(answer.statusCode).toBe(200);
      expect(answer.json()).toEqual({ hasChildren: true });

      const detail = await app.inject({ method: 'GET', url: `/api/pages/${shared}` });
      expect((detail.json() as { hasChildren: boolean }).hasChildren).toBe(true);
    });

    /**
     * The other source, and the same rule: a Confluence page is scoped by the
     * caller's space access, and a row with no `space_key` fails CLOSED — there
     * is nothing to check membership against.
     */
    it('scopes a Confluence page by the caller’s space access', async () => {
      const synced = await insertConfluencePage('conf-scoped', 'Synced', 'NOTES');
      await insertConfluencePage('conf-scoped-child', 'Synced child', 'NOTES', {
        parentId: 'conf-scoped',
      });
      const spaceless = await insertConfluencePage('conf-spaceless', 'No space', 'NOTES');
      await query('UPDATE pages SET space_key = NULL WHERE id = $1', [spaceless]);

      currentUserId = userB;
      await setAccessibleSpaces(userB, ['OTHER']);
      expect(
        (await app.inject({ method: 'GET', url: `/api/pages/${synced}/has-children` })).statusCode,
      ).toBe(404);

      await setAccessibleSpaces(userB, ['NOTES']);
      expect(
        (await app.inject({ method: 'GET', url: `/api/pages/${spaceless}/has-children` })).statusCode,
      ).toBe(404);

      const allowed = await app.inject({ method: 'GET', url: `/api/pages/${synced}/has-children` });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toEqual({ hasChildren: true });
    });

    /**
     * The route decides from ONE row, and the numeric id arm is a
     * dual-identifier lookup: a page whose PK equals another page's
     * `confluence_id` matches both. The Confluence decoy is inserted FIRST, so
     * it is the physical-first match — which is the row the route used to read.
     * Resolving it ran the space check against a space this caller cannot read
     * and 404'd an id `GET /api/pages/:id` serves 200, making the deprecated
     * route stricter than the detail route for a legitimate caller.
     *
     * The row choice must be PK-first — the resolution the detail route applies
     * to a numeric id (`cp.id = $1`) — so the two cannot disagree.
     */
    it('resolves the PK row when the identifier also matches another page’s confluence_id', async () => {
      await insertConfluencePage(String(PARKED_PK), 'Decoy', 'OTHER');
      const target = await insertStandalonePage('Target', 'private', userA, 'NOTES');
      // Park the standalone row on the decoy's identifier: it is now the second
      // row of the two the lookup matches, matching the reviewer's fixture.
      await query('UPDATE pages SET id = $1 WHERE id = $2', [PARKED_PK, target]);
      await insertStandalonePage('Target child', 'private', userA, 'NOTES', {
        parentId: String(PARKED_PK),
      });

      // Precondition of the shape, asserted so this case cannot quietly become
      // vacuous: the unordered lookup really does return the decoy first.
      const unordered = await query<{ source: string }>(
        `SELECT cp.source FROM pages cp
          WHERE (cp.confluence_id = $1 OR cp.id::text = $1)
            AND cp.deleted_at IS NULL`,
        [String(PARKED_PK)],
      );
      expect(unordered.rows[0]!.source).toBe('confluence');
      expect(unordered.rows).toHaveLength(2);

      const detail = await app.inject({ method: 'GET', url: `/api/pages/${PARKED_PK}` });
      expect(detail.statusCode).toBe(200);
      const detailBody = detail.json() as { hasChildren: boolean };
      expect(detailBody.hasChildren).toBe(true);

      const response = await app.inject({
        method: 'GET',
        url: `/api/pages/${PARKED_PK}/has-children`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ hasChildren: true });
    });

    /**
     * The other half of PK-first: it only breaks a tie. A numeric
     * `confluence_id` that matches no page PK still resolves through the
     * `confluence_id` arm, and is still scoped by that row's space.
     */
    it('still resolves a numeric confluence_id that matches no page PK', async () => {
      currentUserId = userB;
      await insertConfluencePage('2200000000', 'Synced', 'NOTES');
      await insertConfluencePage('2200000000-child', 'Synced child', 'NOTES', { parentId: '2200000000' });

      const response = await app.inject({ method: 'GET', url: '/api/pages/2200000000/has-children' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ hasChildren: true });

      await setAccessibleSpaces(userB, ['OTHER']);
      const denied = await app.inject({ method: 'GET', url: '/api/pages/2200000000/has-children' });
      expect(denied.statusCode).toBe(404);
    });
  });

  // ── soft delete ───────────────────────────────────────────────────────────

  describe('DELETE /api/pages/:id (soft)', () => {
    it('trashes the whole standalone subtree under one delete stamp and hides it from the tree', async () => {
      const tree = await seedStandaloneTree(userA);
      const unrelatedParent = await insertConfluencePage('conf-other', 'Unrelated', 'NOTES');
      const unrelatedChild = await insertConfluencePage('conf-other-child', 'Unrelated child', 'NOTES', {
        parentId: 'conf-other',
      });

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });
      expect(response.statusCode).toBe(200);

      const ids = [tree.root, tree.child, tree.grandchild];
      expect(await liveIds(ids)).toEqual([]);
      // ONE UPDATE → every row shares one `deleted_at`, which is the restore
      // batch key. Two statements would produce two stamps and break it.
      expect(await distinctDeleteStamps(ids)).toBe(1);

      const items = await treeItems();
      const treeIds = items.map((item) => item.id);
      expect(treeIds).not.toContain(String(tree.root));
      expect(treeIds).not.toContain(String(tree.child));
      expect(treeIds).not.toContain(String(tree.grandchild));

      // …and the Library, which is a different query with the same rule.
      const library = await app.inject({ method: 'GET', url: '/api/pages' });
      expect(library.statusCode).toBe(200);
      const libraryIds = (library.json().items as Array<{ id: string }>).map((item) => item.id);
      expect(libraryIds).not.toContain(String(tree.root));
      expect(libraryIds).not.toContain(String(tree.grandchild));

      // A Confluence subtree that shares the space is untouched, and its child
      // still resolves its parent — the cascade walks only the roots' subtree.
      expect(treeIds).toContain(String(unrelatedParent));
      expect(items.find((item) => item.id === String(unrelatedChild))?.parentId).toBe(
        String(unrelatedParent),
      );
    });

    it('trashes live grandchildren that sit under an already-trashed intermediate', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      const child = await insertStandalonePage('Child', 'private', userA, 'NOTES', {
        parentId: String(root),
        deletedAt: new Date('2020-01-01T00:00:00Z'),
      });
      const grandchild = await insertStandalonePage('Grandchild', 'private', userA, 'NOTES', {
        parentId: String(child),
      });

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${root}` });
      expect(response.statusCode).toBe(200);

      // The grandchild is exactly the orphan the stale walk would leave behind…
      expect(await liveIds([grandchild])).toEqual([]);
      // …and the already-trashed intermediate keeps ITS stamp, so the two rows
      // remain two batches (restore must not resurrect the child with the root).
      const stamps = await query<{ id: number; deleted_at: Date }>(
        'SELECT id, deleted_at FROM pages WHERE id = ANY($1::int[])',
        [[root, child]],
      );
      const byId = new Map(stamps.rows.map((row) => [row.id, row.deleted_at.getTime()]));
      expect(byId.get(child)).toBe(new Date('2020-01-01T00:00:00Z').getTime());
      expect(byId.get(root)).not.toBe(byId.get(child));
    });

    it('terminates when parent_id holds a cycle instead of hanging the request', async () => {
      const a = await insertStandalonePage('Cycle A', 'private', userA, 'NOTES');
      const b = await insertStandalonePage('Cycle B', 'private', userA, 'NOTES', { parentId: String(a) });
      await query('UPDATE pages SET parent_id = $1 WHERE id = $2', [String(b), a]);

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${a}` });

      expect(response.statusCode).toBe(200);
      expect(await liveIds([a, b])).toEqual([]);
    });

    it('persists one bounded audit row for the whole cascade', async () => {
      const tree = await seedStandaloneTree(userA);

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });

      expect(response.statusCode).toBe(200);
      expect(await liveIds([tree.root, tree.child, tree.grandchild])).toEqual([]);
      const audits = await auditRows('PAGE_DELETED');
      expect(audits).toHaveLength(1);
      expect(audits[0]!.resource_id).toBe(String(tree.root));
      expect(audits[0]!.metadata).toMatchObject({
        source: 'standalone',
        permanent: false,
        cascadedCount: 2,
      });
      expect(audits[0]!.metadata).not.toHaveProperty('pageIds');
    });


    it('invalidates shared pages across users but private pages only for the owner', async () => {
      const shared = await seedStandaloneTree(userA, 'shared');
      await seedPageCache(redis, [userA, userB]);
      await app.inject({ method: 'DELETE', url: `/api/pages/${shared.root}` });
      expect(await cachedPageUsers(redis, [userA, userB])).toEqual([]);

      const priv = await seedStandaloneTree(userA);
      await seedPageCache(redis, [userA, userB]);
      await app.inject({ method: 'DELETE', url: `/api/pages/${priv.root}` });
      expect(await cachedPageUsers(redis, [userA, userB])).toEqual([userB]);
    });

    /**
     * The scope is read off the AFFECTED ROWS' visibility
     * (`cascaded.rows.some(row => row.visibility === 'shared')`), never off the
     * target's. Visibility is per page, so a PRIVATE parent can hold a SHARED
     * sub-article: keyed on the target alone, this request cleared only the
     * deleter's cache and left every other user with a tree that still showed
     * the shared row. Same mechanism as the case above — the two differ only in
     * WHERE the shared row sits.
     */
    it('invalidates across users when a private parent holds a shared sub-article', async () => {
      const root = await insertStandalonePage('Private root', 'private', userA, 'NOTES');
      const shared = await insertStandalonePage('Shared sub-article', 'shared', userA, 'NOTES', {
        parentId: String(root),
      });
      await seedPageCache(redis, [userA, userB]);

      await app.inject({ method: 'DELETE', url: `/api/pages/${root}` });

      expect(await liveIds([root, shared])).toEqual([]);
      expect(await cachedPageUsers(redis, [userA, userB])).toEqual([]);
    });

    it('clears the deleter’s pins across the cascade and leaves another user’s pin alone', async () => {
      const tree = await seedStandaloneTree(userA);
      await query('INSERT INTO pinned_pages (user_id, page_id) VALUES ($1, $2), ($1, $3)', [
        userA,
        tree.child,
        tree.grandchild,
      ]);
      await query('INSERT INTO pinned_pages (user_id, page_id) VALUES ($1, $2)', [userB, tree.child]);

      await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });

      const mine = await query('SELECT page_id FROM pinned_pages WHERE user_id = $1', [userA]);
      expect(mine.rows).toEqual([]);
      const theirs = await query('SELECT page_id FROM pinned_pages WHERE user_id = $1', [userB]);
      expect(theirs.rows).toEqual([{ page_id: tree.child }]);
    });

    it('reports the same descendant count the cascade actually trashes', async () => {
      const tree = await seedStandaloneTree(userA);

      const detail = await app.inject({ method: 'GET', url: `/api/pages/${tree.root}` });
      const promised = (detail.json() as { descendantCount: number }).descendantCount;

      await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });

      const trashed = await query<{ id: number }>(
        'SELECT id FROM pages WHERE deleted_at IS NOT NULL AND id <> $1',
        [tree.root],
      );
      expect(trashed.rows.map((row) => row.id)).toHaveLength(promised);
    });

    /**
     * `source = 'standalone'` on the cascade's UPDATE is not decoration, and
     * the subtree it protects is not source-pure: a Confluence-sourced page can
     * sit inside a standalone one (`PUT /pages/:id/move` re-parents a synced
     * page under a standalone parent and keeps its source; `POST /pages`
     * deliberately permits the same source-aware local hierarchy). Confluence
     * owns that row's lifecycle, and its sync upsert would resurrect it, so the
     * cascade walks THROUGH it —
     * the standalone grandchild below it must still be trashed — while leaving
     * the row itself alone.
     */
    it('walks through a Confluence-sourced row but leaves it live (the source guard)', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      const synced = await insertConfluencePage('conf-in-tree', 'Synced child', 'NOTES', {
        parentId: String(root),
      });
      const local = await insertStandalonePage('Local grandchild', 'private', userA, 'NOTES', {
        parentId: 'conf-in-tree',
      });
      await freezePage(synced, userA, 'SYNCED FROZEN SECRET');

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${root}` });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('SYNCED FROZEN SECRET');

      // The standalone row below the synced one went with the cascade…
      expect(await liveIds([root, local])).toEqual([]);
      // …and the Confluence-sourced row did not: the walk visited it, the
      // UPDATE's guard skipped it.
      expect(await liveIds([synced])).toEqual([synced]);
    });

    /**
     * The same shape created the way a person reaches it: `POST /api/pages`
     * with a Confluence-sourced body under a standalone parent preserves that
     * local hierarchy without sending the unrelated local PK to Confluence,
     * and stores `parent_id = <parent PK>` with `source = 'confluence'`
     * (`PUT /pages/:id/move` re-parents identically).
     *
     * Two consequences, both STATED LIMITATIONS of this PR rather than bugs to
     * fix here — a bigger blast radius than #1636 (a synced subtree belongs to
     * Confluence, and its sync upsert resurrects anything trashed locally):
     *
     *   1. the guarded row survives the cascade with a `parent_id` pointing at
     *      a trashed parent, so `GET /api/pages/tree` renders it at the ROOT —
     *      the issue's orphan symptom, for mixed-source subtrees only;
     *   2. the confirm dialog warns about none of it, because
     *      `descendantCount` counts only the rows the cascade will take.
     *
     * Pinned so the documented limitation cannot drift from the wire behaviour.
     */
    it('leaves a Confluence-sourced child created under a standalone parent behind (stated limitation)', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      await query(
        `INSERT INTO user_settings (user_id, confluence_url, confluence_pat)
         VALUES ($1, $2, $3)`,
        [userA, confluenceBaseUrl, encryptPat('cascade-test-pat')],
      );

      const created = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'Synced child',
          bodyHtml: '<p>x</p>',
          spaceKey: 'NOTES',
          source: 'confluence',
          parentId: String(root),
        },
      });
      expect(created.statusCode).toBe(200);
      expect(confluenceCreateBodies).toHaveLength(1);
      expect(confluenceCreateBodies[0]).not.toHaveProperty('ancestors');

      const syncedRows = await query<{ id: number; source: string; parent_id: string | null }>(
        'SELECT id, source, parent_id FROM pages WHERE confluence_id = $1',
        ['987654321'],
      );
      const synced = syncedRows.rows[0]!;
      expect(synced).toMatchObject({ source: 'confluence', parent_id: String(root) });

      // The detail route sees the child (the tree join is dual-identifier) and
      // still reports nothing for the trash to take.
      const detail = await app.inject({ method: 'GET', url: `/api/pages/${root}` });
      const detailBody = detail.json() as { hasChildren: boolean; descendantCount: number };
      expect(detailBody.hasChildren).toBe(true);
      expect(detailBody.descendantCount).toBe(0);

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${root}` });
      expect(response.statusCode).toBe(200);
      expect(await liveIds([synced.id])).toEqual([synced.id]);
      const items = await treeItems();
      expect(items.find((item) => item.id === String(synced.id))?.parentId).toBeNull();
    });

    it('refuses to trash a page the caller does not own', async () => {
      const root = await insertStandalonePage('Root', 'private', userB, 'NOTES');
      currentUserId = userA;

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${root}` });

      expect(response.statusCode).toBe(403);
      expect(await liveIds([root])).toEqual([root]);
    });

    /**
     * CRITICAL 1 — the soft cascade's `created_by_user_id = $2` guard. It pins
     * the `AND created_by_user_id = $2` line inside `UPDATE pages SET
     * deleted_at = NOW() … WHERE id IN (SELECT id FROM d WHERE deleted_at IS
     * NULL AND source = 'standalone' AND created_by_user_id = $2)`; drop that
     * clause and this case goes red.
     *
     * The child is created through the REAL `POST /api/pages` as B, because
     * that is how the shape is reachable: the route validates `parentId` for
     * existence and space but never for ownership, so another user's article
     * legitimately sits inside this subtree. Trashing it would put a row into a
     * trash B cannot restore from — the parent B would have to restore first is
     * not B's — where the 30-day purge eventually destroys it. That is acting
     * far outside what A asked for, irreversibly.
     *
     * The residual is asserted too, so the trade cannot drift silently: B's row
     * stays LIVE under a trashed parent, which the tree renders at the root.
     * That is #1636's own orphan symptom, deliberately preferred over acting on
     * a row this caller has no authority over.
     */
    it('leaves another user’s sub-article live, and out of the deleter’s trash', async () => {
      const root = await insertStandalonePage('Alice root', 'shared', userA, 'NOTES');
      const mine = await insertStandalonePage('Alice child', 'private', userA, 'NOTES', {
        parentId: String(root),
      });

      currentUserId = userB;
      const created = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'Bob sub-article',
          bodyHtml: '<p>x</p>',
          spaceKey: 'NOTES',
          source: 'standalone',
          visibility: 'private',
          parentId: String(root),
        },
      });
      expect(created.statusCode).toBe(200);
      const theirs = (created.json() as { id: number }).id;

      currentUserId = userA;
      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${root}` });
      expect(response.statusCode).toBe(200);

      // A's own subtree went…
      expect(await liveIds([root, mine])).toEqual([]);
      // …and B's row did not.
      expect(await liveIds([theirs])).toEqual([theirs]);
      // The audit row's count follows the same set, so the trail does not claim
      // a row the request left alone.
      const audits = await auditRows('PAGE_DELETED');
      expect(audits[0]!.metadata).toMatchObject({ cascadedCount: 1 });

      // A's Trash lists only what A's request actually trashed. A row A cannot
      // restore must not be offered there either.
      const trash = await app.inject({ method: 'GET', url: '/api/pages/trash' });
      expect(trash.statusCode).toBe(200);
      const trashIds = (trash.json().items as Array<{ id: string }>).map((item) => item.id);
      expect(trashIds).toContain(String(mine));
      expect(trashIds).not.toContain(String(theirs));

      // The accepted residual, from B's side: live, and re-homed at the root
      // because its parent is hidden.
      currentUserId = userB;
      const items = await treeItems();
      expect(items.find((item) => item.id === String(theirs))?.parentId).toBeNull();
    });

    it('returns 423 for a frozen root and leaves the subtree unchanged', async () => {
      const tree = await seedStandaloneTree(userA);
      await freezePage(tree.root, userA);

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });

      expect(response.statusCode).toBe(423);
      expect(response.json()).toMatchObject({ reason: 'page_is_frozen' });
      expect((await liveIds([tree.root, tree.child, tree.grandchild])).sort()).toEqual(
        [tree.root, tree.child, tree.grandchild].sort(),
      );
    });

    it('refuses an authorized frozen descendant without leaking its identity or title', async () => {
      const tree = await seedStandaloneTree(userA);
      const privateTitle = 'AUTHORIZED FROZEN PAYROLL';
      await freezePage(tree.grandchild, userA, privateTitle);

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });

      expect(response.statusCode).toBe(409);
      const body = response.json() as { reason: string; message: string; blockedCount: number };
      expect(body.reason).toBe('subtree_contains_frozen_page');
      expect(body.blockedCount).toBe(1);
      expect(body.message).toBe(
        'This subtree contains frozen pages that are part of the authorized operation.',
      );
      expect(response.body).not.toContain(String(tree.grandchild));
      expect(response.body).not.toContain(privateTitle);
      expect((await liveIds([tree.root, tree.child, tree.grandchild])).sort()).toEqual(
        [tree.root, tree.child, tree.grandchild].sort(),
      );
    });

    it('walks through a deleted intermediate when checking frozen descendants', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      const deletedMiddle = await insertStandalonePage('Deleted middle', 'private', userA, 'NOTES', {
        parentId: String(root),
        deletedAt: new Date(),
      });
      const frozenLeaf = await insertStandalonePage('Frozen leaf', 'private', userA, 'NOTES', {
        parentId: String(deletedMiddle),
      });
      await freezePage(frozenLeaf, userA);

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${root}` });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ reason: 'subtree_contains_frozen_page' });
      expect((await liveIds([root, frozenLeaf])).sort()).toEqual([root, frozenLeaf].sort());
    });

    it('does not let a frozen foreign-owned descendant block or leak into the caller’s cascade', async () => {
      const root = await insertStandalonePage('Alice root', 'shared', userA, 'NOTES');
      const foreign = await insertStandalonePage('BOB PRIVATE FROZEN LEDGER', 'private', userB, 'NOTES', {
        parentId: String(root),
      });
      await freezePage(foreign, userB, 'BOB PRIVATE FROZEN LEDGER');

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${root}` });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(String(foreign));
      expect(response.body).not.toContain('BOB PRIVATE FROZEN LEDGER');
      expect(await liveIds([root])).toEqual([]);
      expect(await liveIds([foreign])).toEqual([foreign]);
    });

    it('re-expands after a concurrent reparent holding hierarchy SHARE commits', async () => {
      const root = await insertStandalonePage('Delete root', 'private', userA, 'NOTES');
      const destination = await insertStandalonePage('Destination', 'private', userA, 'NOTES');
      const child = await insertStandalonePage('Moving child', 'private', userA, 'NOTES', {
        parentId: String(root),
      });
      const holder = await getPool().connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock_shared($1)', [PAGE_HIERARCHY_LOCK_ID]);
        const pendingDelete = app.inject({ method: 'DELETE', url: `/api/pages/${root}` });
        await waitForAdvisoryWaiter(PAGE_HIERARCHY_LOCK_ID, 'the hierarchy fence');
        await holder.query('UPDATE pages SET parent_id = $1 WHERE id = $2', [
          String(destination),
          child,
        ]);
        await holder.query('COMMIT');

        const response = await pendingDelete;
        expect(response.statusCode).toBe(200);
        expect(await liveIds([root])).toEqual([]);
        expect((await liveIds([destination, child])).sort()).toEqual([destination, child].sort());
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });

    /**
     * CRITICAL 3 — the ambiguity refusal. It pins the `const ambiguity = await
     * findSubtreeKeyAmbiguity(existingPage.id)` pre-flight and its 409 in the
     * standalone branch; remove them and this case goes red, having trashed a
     * row in a tree nobody named.
     *
     * The collision is not contrived: `pages.id` is a serial growing into the
     * numeric space Confluence content ids occupy (#1167), and `parent_id` is
     * matched against EITHER `confluence_id` OR `id::text`. So a child parked
     * on the shared key belongs to both candidate parents as far as every
     * reader is concerned, and a cascade that walked it would cross into the
     * decoy's tree — on the permanent branch, destroying rows there.
     */
    it('refuses to cascade when a key in the subtree names two pages', async () => {
      const parent = await insertStandalonePage('Ambiguous parent', 'private', userA, 'NOTES');
      await query('UPDATE pages SET id = $1 WHERE id = $2', [PARKED_PK, parent]);
      const decoy = await insertConfluencePage(String(PARKED_PK), 'DECOY LEDGER', 'NOTES');
      const child = await insertStandalonePage(
        'Child on the shared key',
        'private',
        userA,
        'NOTES',
        { parentId: String(PARKED_PK) },
      );
      await seedPageCache(redis, [userA, userB]);

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${PARKED_PK}` });

      expect(response.statusCode).toBe(409);
      const body = response.json() as { reason?: string; message?: string };
      expect(body.reason).toBe('subtree_identifier_ambiguous');
      // No identifier or title is echoed: the ambiguous member itself may be
      // an inaccessible traversal node.
      expect(response.body).not.toContain(String(PARKED_PK));
      expect(response.body).not.toContain('DECOY LEDGER');
      // Nothing was trashed anywhere — a refusal, not a partial cascade, and
      // in particular nothing in the decoy's tree, which is what a cascade
      // that followed the shared key would have reached.
      expect((await liveIds([PARKED_PK, child, decoy])).sort()).toEqual(
        [PARKED_PK, child, decoy].sort(),
      );
      expect(await auditRows('PAGE_DELETED')).toHaveLength(0);
      expect(await cachedPageUsers(redis, [userA, userB])).toEqual([userA, userB]);
    });

    /**
     * The other side of that guard, and the reason it is two conditions rather
     * than one: a collision NO CHILD STORES is not a hazard. The walk's join
     * finds nothing through such a key, so nothing can be pulled in from the
     * other candidate's tree — and refusing there would stop a page from
     * deleting ITSELF over a collision no reader can ever follow, with no way
     * out short of relocating a row the caller may not even be able to see.
     *
     * Pins the `WHERE EXISTS (SELECT 1 FROM pages child WHERE child.parent_id =
     * <key>)` clause in `findSubtreeKeyAmbiguity`: drop it and this delete 409s
     * for good.
     */
    it('still trashes a page whose colliding key no child stores', async () => {
      const parent = await insertStandalonePage('Childless collision', 'private', userA, 'NOTES');
      await query('UPDATE pages SET id = $1 WHERE id = $2', [PARKED_PK, parent]);
      const decoy = await insertConfluencePage(String(PARKED_PK), 'DECOY LEDGER', 'NOTES');

      const response = await app.inject({ method: 'DELETE', url: `/api/pages/${PARKED_PK}` });

      expect(response.statusCode).toBe(200);
      expect(await liveIds([PARKED_PK])).toEqual([]);
      // The decoy is a Confluence row and not in this cascade's scope anyway —
      // asserted so "deleted everything" cannot pass for "deleted the target".
      expect(await liveIds([decoy])).toEqual([decoy]);
    });
  });

  // ── bulk delete ───────────────────────────────────────────────────────────

  /**
   * #1636 shares the same walk with the bulk path — leaving the orphan bug
   * installed in the second delete path is exactly what the issue's review
   * would have found. The RESPONSE CONTRACT is unchanged: `succeeded` counts
   * the SELECTION (that is what the `expectedCount` drift check is about),
   * while the EFFECT covers each selected page's live descendants.
   */
  describe('POST /api/pages/bulk/delete', () => {
    it('trashes the selection’s live descendants and still counts the selection', async () => {
      const tree = await seedStandaloneTree(userA);
      const solo = await insertStandalonePage('Solo', 'private', userA, 'NOTES');

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [String(tree.root), String(solo)] },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { succeeded: number; failed: number };
      expect(body.succeeded).toBe(2);
      expect(body.failed).toBe(0);

      expect(await liveIds([tree.root, tree.child, tree.grandchild, solo])).toEqual([]);
      // One statement → one batch stamp for the whole cascade.
      expect(await distinctDeleteStamps([tree.root, tree.child, tree.grandchild])).toBe(1);
    });

    /**
     * The bulk cascade carries the same `created_by_user_id = $2` guard, which
     * this route needs for a second reason of its own: a non-owned SELECTED row
     * is already reported as `Page <id>: not the owner` (#861), so cascading
     * into one would have trashed a row this very response calls a failure.
     * Here the non-owned row is a DESCENDANT of an owned selection, which the
     * per-id ownership loop never sees at all.
     */
    it('leaves another user’s sub-article live under a bulk-deleted parent', async () => {
      const root = await insertStandalonePage('Alice root', 'shared', userA, 'NOTES');
      const theirs = await insertStandalonePage('Bob sub-article', 'private', userB, 'NOTES', {
        parentId: String(root),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [String(root)] },
      });

      expect(response.statusCode).toBe(200);
      expect(await liveIds([root])).toEqual([]);
      expect(await liveIds([theirs])).toEqual([theirs]);
    });

    it('coalesces overlapping selections, refuses their frozen component, and applies a safe component', async () => {
      const root = await insertStandalonePage('Blocked root', 'private', userA, 'NOTES');
      const selectedChild = await insertStandalonePage('Selected child', 'private', userA, 'NOTES', {
        parentId: String(root),
      });
      const frozenLeaf = await insertStandalonePage(
        'SECRET OVERLAP FROZEN LEAF',
        'private',
        userA,
        'NOTES',
        { parentId: String(selectedChild) },
      );
      const safe = await insertStandalonePage('Safe disjoint root', 'private', userA, 'NOTES');
      await freezePage(frozenLeaf, userA, 'SECRET OVERLAP FROZEN LEAF');

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [String(root), String(selectedChild), String(safe)] },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { succeeded: number; failed: number; errors: string[] };
      expect(body).toMatchObject({ succeeded: 1, failed: 2 });
      expect(body.errors).toEqual([
        expect.stringContaining('2 selected page(s):'),
      ]);
      expect(body.errors[0]).toContain('Frozen page count: 1');
      expect(body.errors.join(' ')).not.toContain(String(frozenLeaf));
      expect(body.errors.join(' ')).not.toContain('SECRET OVERLAP FROZEN LEAF');
      expect((await liveIds([root, selectedChild, frozenLeaf])).sort()).toEqual(
        [root, selectedChild, frozenLeaf].sort(),
      );
      expect(await liveIds([safe])).toEqual([]);
    });

    /**
     * An ambiguity blocks only its coalesced component. It is a descendant,
     * not a selected id: `resolveBulkSelection` therefore cannot see it.
     */
    it('refuses an ambiguous descendant’s component without leaking its identity', async () => {
      const root = await insertStandalonePage('Clean root', 'private', userA, 'NOTES');
      const middle = await insertStandalonePage('Middle', 'private', userA, 'NOTES', {
        parentId: String(root),
      });
      await query('UPDATE pages SET id = $1 WHERE id = $2', [PARKED_PK, middle]);
      await insertConfluencePage(String(PARKED_PK), 'DECOY LEDGER', 'NOTES');
      const leaf = await insertStandalonePage('Leaf on the shared key', 'private', userA, 'NOTES', {
        parentId: String(PARKED_PK),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [String(root)] },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { succeeded: number; failed: number; errors: string[] };
      expect(body).toMatchObject({ succeeded: 0, failed: 1 });
      expect(body.errors.join(' ')).not.toContain(String(PARKED_PK));
      expect(body.errors.join(' ')).not.toContain('DECOY LEDGER');
      // The refused component is atomic.
      expect((await liveIds([root, PARKED_PK, leaf])).sort()).toEqual(
        [root, PARKED_PK, leaf].sort(),
      );
    });
  });

  // ── hard delete ───────────────────────────────────────────────────────────

  describe('DELETE /api/pages/:id?permanent=true', () => {
    it('removes the whole subtree and persists one bounded audit row', async () => {
      const tree = await seedStandaloneTree(userA);
      const unrelated = await insertStandalonePage('Unrelated', 'private', userA, 'NOTES');

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/pages/${tree.root}?permanent=true`,
      });
      expect(response.statusCode).toBe(200);

      expect(await existingIds([tree.root, tree.child, tree.grandchild])).toEqual([]);
      expect(await existingIds([unrelated])).toEqual([unrelated]);
      const audits = await auditRows('PAGE_DELETED');
      expect(audits).toHaveLength(1);
      expect(audits[0]!.resource_id).toBe(String(tree.root));
      expect(audits[0]!.metadata).toMatchObject({
        source: 'standalone',
        permanent: true,
        cascadedCount: 2,
      });
    });

    it('refuses permanent destruction when an authorized descendant is frozen', async () => {
      const tree = await seedStandaloneTree(userA);
      await freezePage(tree.child, userA, 'PERMANENT SECRET FROZEN CHILD');

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/pages/${tree.root}?permanent=true`,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        reason: 'subtree_contains_frozen_page',
        blockedCount: 1,
      });
      expect(response.body).not.toContain(String(tree.child));
      expect(response.body).not.toContain('PERMANENT SECRET FROZEN CHILD');
      expect((await existingIds([tree.root, tree.child, tree.grandchild])).sort()).toEqual(
        [tree.root, tree.child, tree.grandchild].sort(),
      );
    });

    it('acquires lifecycle and hierarchy before waiting on the attachment barrier', async () => {
      const page = await insertStandalonePage('Permanent lock order', 'private', userA, 'NOTES');
      const attachmentBlocker = await getPool().connect();
      const hierarchyProbe = await getPool().connect();
      let pendingDelete: Promise<{ statusCode: number }> | undefined;
      try {
        await attachmentBlocker.query('SELECT pg_advisory_lock($1)', [
          ATTACHMENT_SNAPSHOT_LOCK_ID,
        ]);
        pendingDelete = app.inject({
          method: 'DELETE',
          url: `/api/pages/${page}?permanent=true`,
        });
        await waitForAdvisoryWaiter(ATTACHMENT_SNAPSHOT_LOCK_ID, 'the attachment barrier');

        const probe = await hierarchyProbe.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS acquired',
          [PAGE_HIERARCHY_LOCK_ID],
        );
        if (probe.rows[0]?.acquired) {
          await hierarchyProbe.query('SELECT pg_advisory_unlock($1)', [
            PAGE_HIERARCHY_LOCK_ID,
          ]);
        }
        expect(probe.rows[0]?.acquired).toBe(false);
      } finally {
        await attachmentBlocker.query('SELECT pg_advisory_unlock($1)', [
          ATTACHMENT_SNAPSHOT_LOCK_ID,
        ]);
        attachmentBlocker.release();
        hierarchyProbe.release();
      }

      const response = await pendingDelete!;
      expect(response.statusCode).toBe(200);
      expect(await existingIds([page])).toEqual([]);
    });

    it('sees a trashed subtree too — the row and its descendants are gone for good', async () => {
      const tree = await seedStandaloneTree(userA);
      await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/pages/${tree.root}?permanent=true`,
      });

      expect(response.statusCode).toBe(200);
      expect(await existingIds([tree.root, tree.child, tree.grandchild])).toEqual([]);
    });

    /**
     * The permanent path's guard is the second half of the same rule as the
     * soft cascade's: a Confluence-sourced row inside a standalone subtree is
     * destroyed by neither. Its standalone descendants still go with the
     * subtree — the walk visits the synced row, the DELETE's `source` guard
     * skips it.
     */
    it('destroys the standalone rows below a Confluence-sourced one, and only those', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      const synced = await insertConfluencePage('conf-in-tree', 'Synced child', 'NOTES', {
        parentId: String(root),
      });
      const local = await insertStandalonePage('Local grandchild', 'private', userA, 'NOTES', {
        parentId: 'conf-in-tree',
      });

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/pages/${root}?permanent=true`,
      });
      expect(response.statusCode).toBe(200);

      expect(await existingIds([root, local])).toEqual([]);
      expect(await existingIds([synced])).toEqual([synced]);
    });

    /**
     * The pin sweep is scoped to what the DELETE actually removed, never to the
     * walked subtree: the walk visits the Confluence-sourced row the `source`
     * guard skips, and sweeping the walked set would destroy the deleter's own
     * pin on a page that is still live. A pin is visible in the UI
     * (`pinned-pages.ts` filters `deleted_at IS NULL`) and never comes back, so
     * that is unrelated user data — and the soft path, which keys off the
     * UPDATE's `RETURNING`, keeps it. The two delete paths must not disagree.
     */
    it('keeps the deleter’s pin on a Confluence-sourced descendant the hard delete leaves live', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      const synced = await insertConfluencePage('conf-in-tree', 'Synced child', 'NOTES', {
        parentId: String(root),
      });
      const local = await insertStandalonePage('Local grandchild', 'private', userA, 'NOTES', {
        parentId: 'conf-in-tree',
      });
      await query('INSERT INTO pinned_pages (user_id, page_id) VALUES ($1, $2), ($1, $3)', [
        userA,
        synced,
        local,
      ]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/pages/${root}?permanent=true`,
      });
      expect(response.statusCode).toBe(200);

      // The synced row survived the delete, so its pin must survive it too —
      // the pin rows of the destroyed pages go with them.
      expect(await existingIds([synced])).toEqual([synced]);
      const mine = await query<{ page_id: number }>(
        'SELECT page_id FROM pinned_pages WHERE user_id = $1 ORDER BY page_id',
        [userA],
      );
      expect(mine.rows).toEqual([{ page_id: synced }]);
      expect(await existingIds([root, local])).toEqual([]);
    });

    /**
     * CRITICAL 2 — the permanent cascade's `created_by_user_id = $2` guard. It
     * pins that clause inside `WITH RECURSIVE d AS (…) DELETE FROM pages WHERE
     * id IN (SELECT id FROM d WHERE source = 'standalone' AND
     * created_by_user_id = $2) RETURNING id, visibility`; drop it and this case
     * goes red, with another user's article physically gone and no way back.
     *
     * The same fixture as the soft case, and the same reachability: the child is
     * created through the real `POST /api/pages` as B, which validates
     * `parentId` for existence and space but never for ownership. This is the
     * branch where acting without authority is IRREVERSIBLE — there is no trash
     * to restore from — which is why it is pinned separately rather than
     * assumed to follow from the soft branch.
     */
    it('leaves another user’s sub-article in place while destroying the deleter’s own', async () => {
      const root = await insertStandalonePage('Alice root', 'shared', userA, 'NOTES');
      const mine = await insertStandalonePage('Alice child', 'private', userA, 'NOTES', {
        parentId: String(root),
      });

      currentUserId = userB;
      const created = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'Bob sub-article',
          bodyHtml: '<p>x</p>',
          spaceKey: 'NOTES',
          source: 'standalone',
          visibility: 'private',
          parentId: String(root),
        },
      });
      expect(created.statusCode).toBe(200);
      const theirs = (created.json() as { id: number }).id;

      currentUserId = userA;
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/pages/${root}?permanent=true`,
      });
      expect(response.statusCode).toBe(200);

      // A's own rows are gone for good…
      expect(await existingIds([root, mine])).toEqual([]);
      // …and B's row still EXISTS, not merely still live: the whole point of
      // this branch is that the row cannot be brought back.
      expect(await existingIds([theirs])).toEqual([theirs]);
    });

    /**
     * CRITICAL 3, permanent half. The pre-flight refusal is asserted here for
     * the branch where guessing is unrecoverable: a cascade that followed the
     * shared key would have DESTROYED rows in the decoy's tree.
     *
     * (The route re-checks the same ambiguity under the attachment lock and
     * rolls back, which no test can reach without committing a relocate mid
     * transaction — the pre-flight is the half that is observable from the
     * wire, and it is the half that keeps the lock from being taken at all.)
     */
    it('refuses the permanent cascade on an ambiguous key, destroying nothing', async () => {
      const parent = await insertStandalonePage('Ambiguous parent', 'private', userA, 'NOTES');
      await query('UPDATE pages SET id = $1 WHERE id = $2', [PARKED_PK, parent]);
      const decoy = await insertConfluencePage(String(PARKED_PK), 'DECOY LEDGER', 'NOTES');
      const child = await insertStandalonePage('Child on the shared key', 'private', userA, 'NOTES', {
        parentId: String(PARKED_PK),
      });

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/pages/${PARKED_PK}?permanent=true`,
      });

      expect(response.statusCode).toBe(409);
      expect((response.json() as { reason?: string }).reason).toBe('subtree_identifier_ambiguous');
      expect((await existingIds([PARKED_PK, child, decoy])).sort()).toEqual(
        [PARKED_PK, child, decoy].sort(),
      );
    });
  });

  // ── restore ───────────────────────────────────────────────────────────────

  describe('POST /api/pages/:id/restore', () => {
    it('restores the page and every descendant trashed with it', async () => {
      const tree = await seedStandaloneTree(userA);
      await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });

      const response = await app.inject({ method: 'POST', url: `/api/pages/${tree.root}/restore` });
      expect(response.statusCode).toBe(200);

      expect((await liveIds([tree.root, tree.child, tree.grandchild])).sort()).toEqual(
        [tree.root, tree.child, tree.grandchild].sort(),
      );
      const items = await treeItems();
      // The subtree is back UNDER its parent, not flattened to the root.
      expect(items.find((item) => item.id === String(tree.grandchild))?.parentId).toBe(String(tree.child));

      const audits = await auditRows('PAGE_RESTORED');
      expect(audits).toHaveLength(1);
      expect(audits[0]!.resource_id).toBe(String(tree.root));
      expect(audits[0]!.metadata).toMatchObject({ source: 'standalone', restoredCount: 3 });
    });

    it('returns 423 rather than restoring a frozen page', async () => {
      const page = await insertStandalonePage('Frozen trashed page', 'private', userA, 'NOTES', {
        deletedAt: new Date(),
      });
      await freezePage(page, userA);

      const response = await app.inject({ method: 'POST', url: `/api/pages/${page}/restore` });

      expect(response.statusCode).toBe(423);
      expect(response.json()).toMatchObject({ reason: 'page_is_frozen' });
      expect(await liveIds([page])).toEqual([]);
      expect(await auditRows('PAGE_RESTORED')).toHaveLength(0);
    });

    it('leaves a descendant that was trashed separately in the trash', async () => {
      const root = await insertStandalonePage('Root', 'private', userA, 'NOTES');
      const frozen = await insertStandalonePage('Trashed long ago', 'private', userA, 'NOTES', {
        parentId: String(root),
        deletedAt: new Date('2020-01-01T00:00:00Z'),
      });
      const child = await insertStandalonePage('Child', 'private', userA, 'NOTES', {
        parentId: String(root),
      });

      await app.inject({ method: 'DELETE', url: `/api/pages/${root}` });
      const response = await app.inject({ method: 'POST', url: `/api/pages/${root}/restore` });

      expect(response.statusCode).toBe(200);
      expect((await liveIds([root, child])).sort()).toEqual([root, child].sort());
      // Different stamp → different batch. A person who trashed it earlier did
      // not ask for it back.
      expect(await liveIds([frozen])).toEqual([]);
    });

    /**
     * The refusal, in the one shape that still carries it: the DIRECT parent is
     * trashed, standalone, and the CALLER'S OWN — so "restore that first" is
     * advice the caller can actually act on, and the title is safe to echo
     * because they own the row it names.
     */
    it('answers 409 naming the trashed parent the caller can restore first', async () => {
      const parent = await insertStandalonePage('Parent article', 'private', userA, 'NOTES');
      const child = await insertStandalonePage('Child article', 'private', userA, 'NOTES', {
        parentId: String(parent),
      });

      // The child is trashed on its own, then the parent is trashed — two
      // batches. Restoring the child alone would put it back at the root.
      await app.inject({ method: 'DELETE', url: `/api/pages/${child}` });
      await app.inject({ method: 'DELETE', url: `/api/pages/${parent}` });

      const response = await app.inject({ method: 'POST', url: `/api/pages/${child}/restore` });

      expect(response.statusCode).toBe(409);
      const body = response.json() as { error?: string; message?: string; reason?: string };
      expect(`${body.message ?? ''}${body.error ?? ''}`).toContain('Parent article');
      // The client branches on the reason, not on the prose: 409 is also the
      // answer to a permanent refusal (a live import of the same page).
      expect(body.reason).toBe('restore_ancestor_trashed');
      expect(await liveIds([child])).toEqual([]);

      // …and the advice works: clearing the named blocker clears the refusal.
      const parentRestored = await app.inject({
        method: 'POST',
        url: `/api/pages/${parent}/restore`,
      });
      expect(parentRestored.statusCode).toBe(200);
      const retried = await app.inject({ method: 'POST', url: `/api/pages/${child}/restore` });
      expect(retried.statusCode).toBe(200);
      expect(await liveIds([child])).toEqual([child]);
    });

    /**
     * A trashed CONFLUENCE-sourced parent no longer blocks the restore, and
     * that is the whole point of narrowing the guard.
     *
     * Nothing in this route can clear such a blocker: `POST /pages/:id/restore`
     * refuses a non-standalone page outright, and Confluence owns that row's
     * lifecycle. So the refusal that used to fire here was unrecoverable — the
     * caller's own article sat in the trash with no accepted action that could
     * bring it back, until the 30-day purge destroyed it. A visible orphan is
     * the cheaper failure: the page comes back, and because its parent is
     * hidden the tree renders it at the root, where the caller can move it.
     */
    it('restores under a trashed Confluence-sourced parent instead of blocking until the purge', async () => {
      const synced = await insertConfluencePage('conf-ancestor', 'Synced ancestor', 'NOTES', {
        deletedAt: new Date(),
      });
      const child = await insertStandalonePage('Child article', 'private', userA, 'NOTES', {
        parentId: 'conf-ancestor',
        deletedAt: new Date(),
      });

      const response = await app.inject({ method: 'POST', url: `/api/pages/${child}/restore` });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ restored: true });
      expect(await liveIds([child])).toEqual([child]);
      // The parent stays where it was — this route restores the caller's batch,
      // never someone else's lifecycle.
      expect(await liveIds([synced])).toEqual([]);
      // The accepted residual: rendered at the root, because its parent is
      // hidden.
      const items = await treeItems();
      expect(items.find((item) => item.id === String(child))?.parentId).toBeNull();
    });

    /**
     * The same narrowing, for the other parent a caller cannot clear: ANOTHER
     * USER'S trashed standalone page. `POST /pages` hangs a page under someone
     * else's happily, so this is reachable, and the restore route refuses a
     * page the caller does not own — so "restore the parent first" named an
     * action only a different person could take.
     *
     * Note how the fixture has to trash Bob's page: Alice's cascade no longer
     * touches it (see the owner-scope case on the delete path), so Bob trashing
     * his own article is now the only way into this state.
     */
    it('restores under another user’s trashed parent', async () => {
      const aliceRoot = await insertStandalonePage('ALICE SECRET LEDGER', 'private', userA, 'NOTES');
      const bobChild = await insertStandalonePage('Bob draft', 'private', userB, 'NOTES', {
        parentId: String(aliceRoot),
      });

      currentUserId = userB;
      await app.inject({ method: 'DELETE', url: `/api/pages/${bobChild}` });
      currentUserId = userA;
      await app.inject({ method: 'DELETE', url: `/api/pages/${aliceRoot}` });

      currentUserId = userB;
      const response = await app.inject({ method: 'POST', url: `/api/pages/${bobChild}/restore` });

      expect(response.statusCode).toBe(200);
      expect(await liveIds([bobChild])).toEqual([bobChild]);
      // Alice's page is untouched, and Bob was never told its title: the
      // refusal that used to leak it does not happen at all any more.
      expect(await liveIds([aliceRoot])).toEqual([]);
      expect(response.payload).not.toContain('ALICE SECRET LEDGER');
      const items = await treeItems();
      expect(items.find((item) => item.id === String(bobChild))?.parentId).toBeNull();
    });

    /**
     * One level, not a chain. The invariant is a statement about `parent_id`
     * alone: a LIVE direct parent means the restored page reappears beneath it
     * and orphans nothing, whatever is happening further up. The guard this
     * replaced walked to the nearest trashed ancestor at any depth and refused
     * here — a refusal with no orphan behind it.
     */
    it('restores a page whose direct parent is live even while a grandparent is trashed', async () => {
      // Seeded trashed rather than deleted through the route: a DELETE of the
      // grandparent would cascade to the parent, and then the parent really
      // would be a hidden blocker.
      const grandparent = await insertStandalonePage('Grandparent', 'private', userA, 'NOTES', {
        deletedAt: new Date('2020-01-01T00:00:00Z'),
      });
      const parent = await insertStandalonePage('Parent', 'private', userA, 'NOTES', {
        parentId: String(grandparent),
      });
      const child = await insertStandalonePage('Child', 'private', userA, 'NOTES', {
        parentId: String(parent),
      });
      await app.inject({ method: 'DELETE', url: `/api/pages/${child}` });

      const response = await app.inject({ method: 'POST', url: `/api/pages/${child}/restore` });

      expect(response.statusCode).toBe(200);
      expect(await liveIds([child])).toEqual([child]);
      // Reattached UNDER the live parent, which is what makes the restore safe.
      const items = await treeItems();
      expect(items.find((item) => item.id === String(child))?.parentId).toBe(String(parent));
      expect(await liveIds([grandparent])).toEqual([]);
    });

    /**
     * CRITICAL 4 — the guard must not FAIL OPEN on an identifier collision. It
     * pins `if (parentResolution.kind === 'ambiguous')` and its 409 in
     * `POST /pages/:id/restore`; delete that branch and `kind === 'resolved'`
     * is false for the same row, so the handler falls through and restores the
     * page as if it had no parent at all — silently re-creating the orphan the
     * guard exists to prevent. That is the shape `resolveParentOf` was written
     * for: the chain walk it replaced keyed candidate parents into a `Map` by
     * ONE identifier, so a key that missed the map read as "no parent".
     *
     * `parent_id` here names two rows at once: the caller's trashed real parent
     * and a LIVE Confluence decoy answering to the same string. Picking either
     * would make the route act on a page the caller never named.
     */
    it('refuses instead of failing open when parent_id names two pages', async () => {
      const realParent = await insertStandalonePage('Real parent', 'private', userA, 'NOTES', {
        deletedAt: new Date(),
      });
      await query('UPDATE pages SET id = $1 WHERE id = $2', [PARKED_PK, realParent]);
      const decoy = await insertConfluencePage(String(PARKED_PK), 'DECOY LEDGER', 'NOTES');
      const child = await insertStandalonePage('Child article', 'private', userA, 'NOTES', {
        parentId: String(PARKED_PK),
        deletedAt: new Date(),
      });

      // The collision is real: both rows answer to the same key.
      const candidates = await query<{ id: number }>(
        'SELECT id FROM pages WHERE confluence_id = $1 OR id::text = $1 ORDER BY id',
        [String(PARKED_PK)],
      );
      expect(candidates.rows.map((row) => row.id)).toEqual([decoy, PARKED_PK].sort((a, b) => a - b));
      await seedPageCache(redis, [userA, userB]);

      const response = await app.inject({ method: 'POST', url: `/api/pages/${child}/restore` });
      expect(response.statusCode).toBe(409);
      const body = response.json() as { message?: string; reason?: string };
      expect(body.reason).toBe('restore_parent_ambiguous');
      // Stored keys and candidate identities remain operator-log detail.
      expect(body.message).not.toContain(String(PARKED_PK));
      expect(body.message).not.toContain('DECOY LEDGER');
      // Still trashed: the refusal is the whole point, a silent 200 was the bug.
      expect(await liveIds([child])).toEqual([]);
      expect(await auditRows('PAGE_RESTORED')).toHaveLength(0);
      expect(await cachedPageUsers(redis, [userA, userB])).toEqual([userA, userB]);
    });

    /**
     * The restore's cache scope is read off the ROWS the `UPDATE … RETURNING
     * visibility` put back, not off the target: a private page's batch can
     * contain a shared descendant, and a restored shared page reappears in
     * every user's lists and trees (#893).
     */
    it('invalidates across users when the restored batch contains a shared sub-article', async () => {
      const root = await insertStandalonePage('Private root', 'private', userA, 'NOTES');
      const shared = await insertStandalonePage('Shared sub-article', 'shared', userA, 'NOTES', {
        parentId: String(root),
      });
      await app.inject({ method: 'DELETE', url: `/api/pages/${root}` });
      await seedPageCache(redis, [userA, userB]);

      const response = await app.inject({ method: 'POST', url: `/api/pages/${root}/restore` });

      expect(response.statusCode).toBe(200);
      expect((await liveIds([root, shared])).sort()).toEqual([root, shared].sort());
      expect(await cachedPageUsers(redis, [userA, userB])).toEqual([]);
    });

    it('is idempotent for a page the caller already restored', async () => {
      const tree = await seedStandaloneTree(userA);
      await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });
      await app.inject({ method: 'POST', url: `/api/pages/${tree.root}/restore` });

      // A bulk restore fires one request per selected row and the first one
      // restores the whole batch — the sibling request must not report failure.
      const again = await app.inject({ method: 'POST', url: `/api/pages/${tree.child}/restore` });

      expect(again.statusCode).toBe(200);
      expect(await liveIds([tree.root, tree.child, tree.grandchild])).toHaveLength(3);
    });

    it('still refuses a page the caller does not own', async () => {
      const root = await insertStandalonePage('Root', 'private', userB, 'NOTES', {
        deletedAt: new Date(),
      });
      currentUserId = userA;

      const response = await app.inject({ method: 'POST', url: `/api/pages/${root}/restore` });

      expect(response.statusCode).toBe(403);
      expect(await liveIds([root])).toEqual([]);
    });
  });
});
