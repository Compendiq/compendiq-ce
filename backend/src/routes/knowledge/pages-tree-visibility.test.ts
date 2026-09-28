/**
 * GET /api/pages/tree — visibility predicate against real PostgreSQL, Redis,
 * and RBAC state.
 *
 * Regression: the tree route filtered only by space + `deleted_at IS NULL`,
 * so another user's private standalone article appeared in the sidebar tree
 * while the detail route refused to serve it. The tree must apply the same
 * visibility predicate as the list route.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { invalidateRbacCache } from '../../core/services/rbac-service.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { pagesCrudRoutes } from './pages-crud.js';
import {
  buildKnowledgeTestApp,
  insertConfluencePage,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';

const available = await isDbAvailable() && await isRedisAvailable();

async function assignReadableSpace(userId: string, spaceKey: string): Promise<void> {
  await query(
    `WITH reader_role AS (
       INSERT INTO roles (name, display_name, permissions)
       VALUES ($1, 'Tree visibility reader', ARRAY['read'])
       RETURNING id
     )
     INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     SELECT $2, 'user', $3, id FROM reader_role`,
    [`tree-reader-${randomUUID()}`, spaceKey, userId],
  );
}

async function deleteKeys(redis: RedisClientType, pattern: string): Promise<void> {
  let cursor = '0';
  do {
    const scanned = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
    cursor = String(scanned.cursor);
    if (scanned.keys.length > 0) await redis.del(scanned.keys);
  } while (cursor !== '0');
}

describe.skipIf(!available)('GET /api/pages/tree — real visibility boundaries', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let userA: string;
  let userB: string;
  let currentUserId: string;
  const ownedUserIds = new Set<string>();

  async function treeTitles(asUser: string, url = '/api/pages/tree'): Promise<string[]> {
    currentUserId = asUser;
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ items: Array<{ title: string }> }>();
    return body.items.map((item) => item.title).sort();
  }

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    });
    redis.on('error', () => undefined);
    await redis.connect();
    setRedisClient(redis);

    app = await buildKnowledgeTestApp(() => currentUserId, async (instance) => {
      instance.redis = redis;
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    for (const userId of ownedUserIds) {
      await deleteKeys(redis, `kb:${userId}:*`);
      await redis.del([
        `kb-cache-generation:pages:user:${userId}`,
        `kb-cache-generation:search:user:${userId}`,
        `rbac:admin:${userId}`,
        `rbac:spaces:${userId}`,
      ]);
    }
    setRedisClient(null);
    if (redis.isOpen) await redis.quit();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    userA = await insertUser(`tree-vis-a-${randomUUID()}`);
    userB = await insertUser(`tree-vis-b-${randomUUID()}`);
    ownedUserIds.add(userA);
    ownedUserIds.add(userB);
    currentUserId = userA;

    await insertLocalSpace('NOTES', userA);
    await query(
      `INSERT INTO spaces (space_key, space_name, source, last_synced)
       VALUES ('DEV', 'Development', 'confluence', NOW()),
              ('SECRET', 'Secret', 'confluence', NOW())`,
    );
  });

  it("hides another user's private standalone article while retaining shared content", async () => {
    await insertStandalonePage('Private note', 'private', userA, 'NOTES');
    await insertStandalonePage('Shared note', 'shared', userA, 'NOTES');

    expect(await treeTitles(userB)).toEqual(['Shared note']);
  });

  it('shows the owner both their private and shared standalone articles', async () => {
    await insertStandalonePage('Private note', 'private', userA, 'NOTES');
    await insertStandalonePage('Shared note', 'shared', userA, 'NOTES');

    expect(await treeTitles(userA)).toEqual(['Private note', 'Shared note']);
  });

  it('cuts every hierarchy projection at an inaccessible parent boundary', async () => {
    const privateParent = await insertStandalonePage(
      'Private parent',
      'private',
      userA,
      'NOTES',
    );
    const sharedChild = await insertStandalonePage(
      'Shared child',
      'shared',
      userA,
      'NOTES',
      { parentId: String(privateParent) },
    );
    const sharedRoot = await insertStandalonePage('Shared root', 'shared', userA, 'NOTES');
    const privateMiddle = await insertStandalonePage(
      'Private middle',
      'private',
      userA,
      'NOTES',
      { parentId: String(sharedRoot) },
    );
    await insertStandalonePage('Shared grandchild', 'shared', userA, 'NOTES', {
      parentId: String(privateMiddle),
    });
    await insertConfluencePage(String(privateParent), 'Numeric parent-id collision', 'DEV');
    await assignReadableSpace(userB, 'DEV');

    currentUserId = userB;
    const tree = await app.inject({ method: 'GET', url: '/api/pages/tree' });
    expect(tree.statusCode, tree.body).toBe(200);
    const treeItems = tree.json().items;
    expect(treeItems).toHaveLength(4);
    expect(treeItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Numeric parent-id collision', parentId: null }),
      expect.objectContaining({ id: String(sharedChild), parentId: null }),
      expect.objectContaining({ title: 'Shared grandchild', parentId: null }),
      expect.objectContaining({ id: String(sharedRoot), parentId: null }),
    ]));
    expect(tree.body).not.toContain(`"parentId":"${privateParent}"`);
    expect(tree.body).not.toContain(`"parentId":"${privateMiddle}"`);

    const list = await app.inject({ method: 'GET', url: '/api/pages?spaceKey=NOTES' });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toEqual([
      expect.objectContaining({ id: String(sharedChild), parentId: null }),
      expect.objectContaining({ title: 'Shared grandchild', parentId: null }),
      expect.objectContaining({ id: String(sharedRoot), parentId: null }),
    ]);

    const detail = await app.inject({ method: 'GET', url: `/api/pages/${sharedChild}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ id: String(sharedChild), parentId: null });

    const children = await app.inject({
      method: 'GET',
      url: `/api/pages/${sharedRoot}/children?depth=3`,
    });

    expect(children.statusCode, children.body).toBe(200);
    expect(children.json()).toEqual({ children: [] });
    expect(children.body).not.toContain('Private middle');
    expect(children.body).not.toContain('Shared grandchild');
  });
  it('fails closed like detail when a readable numeric page id collides with a hidden parent key', async () => {
    const readableRoot = await insertStandalonePage(
      'Readable collision root',
      'shared',
      userA,
      'NOTES',
    );
    await insertStandalonePage('Readable child', 'shared', userA, 'NOTES', {
      parentId: String(readableRoot),
    });
    await insertConfluencePage(String(readableRoot), 'Hidden colliding parent', 'SECRET');
    await insertConfluencePage('hidden-child', 'Hidden child', 'SECRET', {
      parentId: String(readableRoot),
    });

    currentUserId = userB;
    const detail = await app.inject({ method: 'GET', url: `/api/pages/${readableRoot}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ hasChildren: false });

    // No distinct status: a hidden collision must not be distinguishable from
    // the detail route's fail-closed answer.
    const children = await app.inject({
      method: 'GET',
      url: `/api/pages/${readableRoot}/children`,
    });
    expect(children.statusCode, children.body).toBe(200);
    expect(children.json()).toEqual({ children: [] });
    const legacy = await app.inject({
      method: 'GET',
      url: `/api/pages/${readableRoot}/has-children`,
    });
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect(legacy.json()).toEqual({ hasChildren: false });
  });

  it('still reports 409 when every colliding candidate is readable', async () => {
    const readableRoot = await insertStandalonePage(
      'Readable collision root',
      'shared',
      userA,
      'NOTES',
    );
    await insertStandalonePage('Readable child', 'shared', userA, 'NOTES', {
      parentId: String(readableRoot),
    });
    await insertConfluencePage(String(readableRoot), 'Readable colliding parent', 'DEV');
    await assignReadableSpace(userB, 'DEV');

    currentUserId = userB;
    for (const suffix of ['children', 'has-children']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/pages/${readableRoot}/${suffix}`,
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ error: 'Page identifier is ambiguous' });
    }
  });

  it('rejects a canonical Confluence root key that collides before children traversal', async () => {
    const numericCandidate = await insertStandalonePage(
      'Numeric collision candidate',
      'shared',
      userA,
      'NOTES',
    );
    const confluenceParent = await insertConfluencePage(
      String(numericCandidate),
      'Confluence parent',
      'DEV',
    );
    await insertConfluencePage('canonical-child', 'Canonical child', 'DEV', {
      parentId: String(numericCandidate),
    });
    await assignReadableSpace(userB, 'DEV');

    // Requested by its PK, the Confluence parent is the only row the resolver
    // matches (rows.length === 1); only its canonical key collides with the
    // readable standalone row, so this 409 comes from the canonical-key check.
    currentUserId = userB;
    const response = await app.inject({
      method: 'GET',
      url: `/api/pages/${confluenceParent}/children`,
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: 'Page identifier is ambiguous' });
    expect(response.body).not.toContain('Canonical child');

    const legacy = await app.inject({
      method: 'GET',
      url: `/api/pages/${confluenceParent}/has-children`,
    });
    expect(legacy.statusCode, legacy.body).toBe(409);
    expect(legacy.json()).toMatchObject({ error: 'Page identifier is ambiguous' });
  });

  it('invalidates cached hierarchy rows on space-role changes without widening admins', async () => {
    await insertConfluencePage('dev-page', 'Dev page', 'DEV');
    const privateForeignPage = await insertStandalonePage(
      'Private foreign note',
      'private',
      userA,
      'NOTES',
    );
    await insertStandalonePage('Private child', 'private', userA, 'NOTES', {
      parentId: String(privateForeignPage),
    });
    await insertStandalonePage('Shared note', 'shared', userA, 'NOTES');
    await assignReadableSpace(userB, 'DEV');

    expect(await treeTitles(userB)).toEqual(['Dev page', 'Shared note']);

    await query(
      `DELETE FROM space_role_assignments
       WHERE space_key = 'DEV' AND principal_type = 'user' AND principal_id = $1`,
      [userB],
    );
    await invalidateRbacCache(userB);
    expect(await treeTitles(userB)).toEqual(['Shared note']);

    await query("UPDATE users SET role = 'admin' WHERE id = $1", [userB]);
    await invalidateRbacCache(userB);
    expect(await treeTitles(userB)).toEqual(['Dev page', 'Shared note']);
    const adminList = await app.inject({
      method: 'GET',
      url: '/api/pages?spaceKey=NOTES',
    });
    expect(adminList.statusCode, adminList.body).toBe(200);
    expect(adminList.json().items.map((item: { title: string }) => item.title)).toEqual([
      'Shared note',
    ]);

    const adminTree = await app.inject({
      method: 'GET',
      url: '/api/pages/tree?spaceKey=NOTES',
    });
    expect(adminTree.statusCode, adminTree.body).toBe(200);
    expect(adminTree.json().items.map((item: { title: string }) => item.title)).toEqual([
      'Shared note',
    ]);

    for (const suffix of ['', '/children', '/has-children']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/pages/${privateForeignPage}${suffix}`,
      });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.body).not.toContain('Private child');
    }
  });

  it('does not widen Confluence hierarchy reads through page ACEs', async () => {
    await insertConfluencePage('conf-dev', 'Dev page', 'DEV');
    const secretPage = await insertConfluencePage('conf-secret', 'Secret page', 'SECRET');
    await query('UPDATE pages SET inherit_perms = FALSE WHERE id = $1', [secretPage]);
    await query(
      `INSERT INTO access_control_entries
         (resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ('page', $1, 'user', $2, 'read')`,
      [secretPage, userB],
    );
    await assignReadableSpace(userB, 'DEV');

    expect(await treeTitles(userB)).toEqual(['Dev page']);
    for (const suffix of ['', '/children', '/has-children']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/pages/${secretPage}${suffix}`,
      });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.body).not.toContain('Secret page');
    }
  });

  it('does not treat a local container as authority for a moved Confluence page', async () => {
    await insertConfluencePage('moved-conf', 'Moved Confluence page', 'NOTES');
    await assignReadableSpace(userA, 'NOTES');

    expect(await treeTitles(userA, '/api/pages/tree?spaceKey=NOTES')).toEqual([
      'Moved Confluence page',
    ]);
    expect(await treeTitles(userB)).toEqual([]);
    expect(await treeTitles(userB, '/api/pages/tree?spaceKey=NOTES')).toEqual([]);
  });

  it('keeps the space filter on top of the visibility and RBAC predicates', async () => {
    await insertConfluencePage('conf-dev', 'Dev page', 'DEV');
    await insertConfluencePage('conf-secret', 'Secret page', 'SECRET');
    await insertStandalonePage('Private note', 'private', userA, 'NOTES');
    await insertStandalonePage('Shared note', 'shared', userA, 'NOTES');
    await assignReadableSpace(userB, 'DEV');

    expect(await treeTitles(userB, '/api/pages/tree?spaceKey=DEV')).toEqual(['Dev page']);
    expect(await treeTitles(userB, '/api/pages/tree?spaceKey=SECRET')).toEqual([]);
    expect(await treeTitles(userB, '/api/pages/tree?spaceKey=NOTES')).toEqual(['Shared note']);
  });
});
