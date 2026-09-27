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
import { localSpacesRoutes } from './local-spaces.js';
import {
  buildKnowledgeTestApp,
  insertConfluencePage,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';

const available = await isDbAvailable() && await isRedisAvailable();

async function assignSpace(userId: string, spaceKey: string): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, permissions)
     VALUES ($1, 'Local spaces reader', ARRAY['read', 'comment', 'edit', 'delete'])
     RETURNING id`,
    [`local-spaces-role-${randomUUID()}`],
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)`,
    [spaceKey, userId, role.rows[0]!.id],
  );
  await invalidateRbacCache(userId);
}

async function setTreePosition(
  id: number,
  path: string,
  depth: number,
  sortOrder = 0,
): Promise<void> {
  await query(
    'UPDATE pages SET path = $2, depth = $3, sort_order = $4 WHERE id = $1',
    [id, path, depth, sortOrder],
  );
}

async function pagePosition(id: number): Promise<{
  parent_id: string | null;
  space_key: string | null;
  path: string | null;
  depth: number;
  sort_order: number;
}> {
  return (
    await query<{
      parent_id: string | null;
      space_key: string | null;
      path: string | null;
      depth: number;
      sort_order: number;
    }>(
      'SELECT parent_id, space_key, path, depth, sort_order FROM pages WHERE id = $1',
      [id],
    )
  ).rows[0]!;
}

describe.skipIf(!available)('local spaces routes — real PostgreSQL and Redis', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let actorId: string;
  let otherUserId: string;

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    });
    await redis.connect();
    setRedisClient(redis);
    app = await buildKnowledgeTestApp(() => actorId, async (instance) => {
      instance.redis = redis;
      await instance.register(localSpacesRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    if (redis.isOpen) await redis.quit();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await redis.flushDb();
    actorId = await insertUser(`spaces-actor-${randomUUID()}`);
    otherUserId = await insertUser(`spaces-other-${randomUUID()}`);
  });

  it('creates, lists, updates, and deletes local spaces with real cache fan-out and audit rows', async () => {
    await redis.set('kb:alice:spaces:local-spaces:list', 'stale');
    await redis.set('kb:bob:spaces:space-tree:TEAM', 'stale');

    const created = await app.inject({
      method: 'POST',
      url: '/api/spaces/local',
      payload: {
        key: 'TEAM',
        name: 'Team Docs',
        description: 'Internal docs',
        icon: 'folder',
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({ key: 'TEAM', name: 'Team Docs', source: 'local' });
    expect(await redis.exists('kb:alice:spaces:local-spaces:list')).toBe(0);
    expect(await redis.exists('kb:bob:spaces:space-tree:TEAM')).toBe(0);

    const home = await insertStandalonePage('Home', 'private', actorId, 'TEAM');
    await query('UPDATE spaces SET custom_home_page_id = $2 WHERE space_key = $1', ['TEAM', home]);
    const listed = await app.inject({ method: 'GET', url: '/api/spaces/local' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([
      expect.objectContaining({
        key: 'TEAM',
        name: 'Team Docs',
        description: 'Internal docs',
        icon: 'folder',
        pageCount: 1,
        source: 'local',
        homepageId: String(home),
        customHomePageId: home,
      }),
    ]);

    await redis.set('kb:someone:spaces:local-spaces:list', 'stale');
    const updated = await app.inject({
      method: 'PUT',
      url: '/api/spaces/local/TEAM',
      payload: { name: 'Renamed Team', icon: 'book' },
    });
    expect(updated.statusCode).toBe(200);
    expect(await redis.exists('kb:someone:spaces:local-spaces:list')).toBe(0);
    expect(
      (await query<{ space_name: string; icon: string }>(
        'SELECT space_name, icon FROM spaces WHERE space_key = $1',
        ['TEAM'],
      )).rows[0],
    ).toEqual({ space_name: 'Renamed Team', icon: 'book' });

    const nonEmpty = await app.inject({ method: 'DELETE', url: '/api/spaces/local/TEAM' });
    expect(nonEmpty.statusCode).toBe(409);
    await query('DELETE FROM pages WHERE id = $1', [home]);
    await redis.set('kb:someone:spaces:anything', 'stale');
    const deleted = await app.inject({ method: 'DELETE', url: '/api/spaces/local/TEAM' });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ key: 'TEAM', deleted: true });
    expect(await redis.exists('kb:someone:spaces:anything')).toBe(0);

    const audit = await query<{ action: string }>(
      `SELECT action FROM audit_log
        WHERE action IN ('LOCAL_SPACE_CREATED', 'LOCAL_SPACE_UPDATED', 'LOCAL_SPACE_DELETED')
        ORDER BY created_at, id`,
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      'LOCAL_SPACE_CREATED',
      'LOCAL_SPACE_UPDATED',
      'LOCAL_SPACE_DELETED',
    ]);
  });

  it('validates local-space identity and refuses mutation of Confluence spaces', async () => {
    await insertLocalSpace('DUP', actorId);
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/spaces/local',
      payload: { key: 'DUP', name: 'Duplicate' },
    });
    expect(duplicate.statusCode).toBe(409);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/spaces/local',
      payload: { key: 'not valid', name: 'Invalid' },
    });
    expect(invalid.statusCode).toBe(400);

    await query(
      `INSERT INTO spaces (space_key, space_name, source, last_synced)
       VALUES ('CONF', 'Confluence', 'confluence', NOW())`,
    );
    const update = await app.inject({
      method: 'PUT',
      url: '/api/spaces/local/CONF',
      payload: { name: 'No' },
    });
    expect(update.statusCode).toBe(400);
    expect(update.json().error).toContain('Confluence');

    const remove = await app.inject({ method: 'DELETE', url: '/api/spaces/local/CONF' });
    expect(remove.statusCode).toBe(400);
    expect(remove.json().error).toContain('Confluence');
  });

  it('returns honest empty/not-found states and rejects an update with no fields', async () => {
    const empty = await app.inject({ method: 'GET', url: '/api/spaces/local' });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);

    const missingTree = await app.inject({ method: 'GET', url: '/api/spaces/MISSING/tree' });
    const missingMove = await app.inject({
      method: 'PUT',
      url: '/api/pages/2147483647/move',
      payload: { parentId: null },
    });
    const missingReorder = await app.inject({
      method: 'PUT',
      url: '/api/pages/2147483647/reorder',
      payload: { sortOrder: 0 },
    });
    expect(missingTree.statusCode).toBe(404);
    expect(missingMove.statusCode).toBe(404);
    expect(missingReorder.statusCode).toBe(404);

    await insertLocalSpace('UNCHANGED', actorId);
    const noFields = await app.inject({
      method: 'PUT',
      url: '/api/spaces/local/UNCHANGED',
      payload: {},
    });
    expect(noFields.statusCode).toBe(400);
    expect(noFields.json().error).toContain('No fields');
  });

  it('returns a local tree with numeric parent identities and serves local spaces without RBAC assignments', async () => {
    await insertLocalSpace('TREE', actorId);
    const root = await insertStandalonePage('Root', 'private', actorId, 'TREE');
    const child = await insertStandalonePage('Child', 'private', actorId, 'TREE', {
      parentId: String(root),
    });
    await setTreePosition(root, `/${root}`, 0, 0);
    await setTreePosition(child, `/${root}/${child}`, 1, 1);

    const response = await app.inject({ method: 'GET', url: '/api/spaces/TREE/tree' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ spaceKey: 'TREE', total: 2 });
    expect(response.json().items).toEqual([
      expect.objectContaining({ id: root, title: 'Root', parentId: null }),
      expect.objectContaining({ id: child, title: 'Child', parentId: String(root) }),
    ]);
  });

  it('conceals an inaccessible Confluence tree and returns it after a real role assignment', async () => {
    await query(
      `INSERT INTO spaces (space_key, space_name, source, last_synced)
       VALUES ('SECURE', 'Secure', 'confluence', NOW())`,
    );
    const page = await insertConfluencePage('secure-root', 'Secure root', 'SECURE');
    await setTreePosition(page, `/${page}`, 0);

    const denied = await app.inject({ method: 'GET', url: '/api/spaces/SECURE/tree' });
    expect(denied.statusCode).toBe(404);

    await assignSpace(actorId, 'SECURE');
    const allowed = await app.inject({ method: 'GET', url: '/api/spaces/SECURE/tree' });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().items).toEqual([
      expect.objectContaining({ id: page, confluenceId: 'secure-root', source: 'confluence' }),
    ]);
  });

  it('moves a real subtree and rewrites every descendant path under one admitted transaction', async () => {
    await insertLocalSpace('MOVE', actorId);
    const oldRoot = await insertStandalonePage('Old root', 'private', actorId, 'MOVE');
    const child = await insertStandalonePage('Child', 'private', actorId, 'MOVE', {
      parentId: String(oldRoot),
    });
    const grandchild = await insertStandalonePage('Grandchild', 'private', actorId, 'MOVE', {
      parentId: String(child),
    });
    const target = await insertStandalonePage('Target', 'private', actorId, 'MOVE');
    await setTreePosition(oldRoot, `/${oldRoot}`, 0);
    await setTreePosition(child, `/${oldRoot}/${child}`, 1);
    await setTreePosition(grandchild, `/${oldRoot}/${child}/${grandchild}`, 2);
    await setTreePosition(target, `/${target}`, 0);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${child}/move`,
      payload: { parentId: target, spaceKey: 'MOVE' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: child,
      parentId: String(target),
      spaceKey: 'MOVE',
      path: `/${target}/${child}`,
      depth: 1,
    });
    expect(await pagePosition(child)).toMatchObject({
      parent_id: String(target),
      path: `/${target}/${child}`,
      depth: 1,
    });
    expect(await pagePosition(grandchild)).toMatchObject({
      parent_id: String(child),
      path: `/${target}/${child}/${grandchild}`,
      depth: 2,
    });
  });

  it('stores a Confluence parent key rather than its local numeric id', async () => {
    await insertLocalSpace('SOURCE', actorId);
    await query(
      `INSERT INTO spaces (space_key, space_name, source, last_synced)
       VALUES ('TARGET', 'Target', 'confluence', NOW())`,
    );
    await assignSpace(actorId, 'TARGET');
    const moving = await insertStandalonePage('Moving', 'private', actorId, 'SOURCE');
    const parent = await insertConfluencePage('upstream-parent', 'Parent', 'TARGET');
    await setTreePosition(moving, `/${moving}`, 0);
    await setTreePosition(parent, `/${parent}`, 0);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${moving}/move`,
      payload: { parentId: parent, spaceKey: 'TARGET' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().parentId).toBe('upstream-parent');
    expect(await pagePosition(moving)).toMatchObject({
      parent_id: 'upstream-parent',
      space_key: 'TARGET',
      path: `/${parent}/${moving}`,
    });
  });

  it('refuses an identifier that names one parent by PK and another by Confluence id', async () => {
    await insertLocalSpace('AMBIGUOUS', actorId);
    const moving = await insertStandalonePage('Moving', 'private', actorId, 'AMBIGUOUS');
    const numericParent = await insertStandalonePage('Numeric parent', 'private', actorId, 'AMBIGUOUS');
    const collidingParent = await insertConfluencePage(
      String(numericParent),
      'Confluence collision',
      'AMBIGUOUS',
    );
    await setTreePosition(moving, `/${moving}`, 0);
    await setTreePosition(numericParent, `/${numericParent}`, 0);
    await setTreePosition(collidingParent, `/${collidingParent}`, 0);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${moving}/move`,
      payload: { parentId: numericParent, spaceKey: 'AMBIGUOUS' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('ambiguous');
    expect(await pagePosition(moving)).toMatchObject({
      parent_id: null,
      space_key: 'AMBIGUOUS',
      path: `/${moving}`,
    });
  });

  it('rejects cycles and inaccessible target spaces without changing the source row', async () => {
    await insertLocalSpace('SOURCE', actorId);
    await query(
      `INSERT INTO spaces (space_key, space_name, source, last_synced)
       VALUES ('RESTRICTED', 'Restricted', 'confluence', NOW())`,
    );
    const root = await insertStandalonePage('Root', 'private', actorId, 'SOURCE');
    const child = await insertStandalonePage('Child', 'private', actorId, 'SOURCE', {
      parentId: String(root),
    });
    await setTreePosition(root, `/${root}`, 0);
    await setTreePosition(child, `/${root}/${child}`, 1);

    const cycle = await app.inject({
      method: 'PUT',
      url: `/api/pages/${root}/move`,
      payload: { parentId: child, spaceKey: 'SOURCE' },
    });
    expect(cycle.statusCode).toBe(400);
    expect(cycle.json().error).toContain('own descendant');

    const denied = await app.inject({
      method: 'PUT',
      url: `/api/pages/${root}/move`,
      payload: { parentId: null, spaceKey: 'RESTRICTED' },
    });
    expect(denied.statusCode).toBe(403);
    expect(await pagePosition(root)).toMatchObject({
      parent_id: null,
      space_key: 'SOURCE',
      path: `/${root}`,
    });
  });

  it('conceals source-page move, reorder, and breadcrumb operations from an unauthorized user', async () => {
    await insertLocalSpace('PRIVATE', actorId);
    const page = await insertStandalonePage('Private', 'private', actorId, 'PRIVATE');
    await setTreePosition(page, `/${page}`, 0);
    actorId = otherUserId;

    const move = await app.inject({
      method: 'PUT',
      url: `/api/pages/${page}/move`,
      payload: { parentId: null, spaceKey: 'PRIVATE' },
    });
    const reorder = await app.inject({
      method: 'PUT',
      url: `/api/pages/${page}/reorder`,
      payload: { sortOrder: 0 },
    });
    const breadcrumb = await app.inject({
      method: 'GET',
      url: `/api/pages/${page}/breadcrumb`,
    });

    expect(move.statusCode).toBe(404);
    expect(reorder.statusCode).toBe(404);
    expect(breadcrumb.statusCode).toBe(404);
    expect(await pagePosition(page)).toMatchObject({ sort_order: 0, path: `/${page}` });
  });

  it('reorders the entire sibling group into a dense persisted order', async () => {
    await insertLocalSpace('ORDER', actorId);
    const parent = await insertStandalonePage('Parent', 'private', actorId, 'ORDER');
    const alpha = await insertStandalonePage('Alpha', 'private', actorId, 'ORDER', {
      parentId: String(parent),
    });
    const beta = await insertStandalonePage('Beta', 'private', actorId, 'ORDER', {
      parentId: String(parent),
    });
    const gamma = await insertStandalonePage('Gamma', 'private', actorId, 'ORDER', {
      parentId: String(parent),
    });
    await setTreePosition(parent, `/${parent}`, 0);
    await setTreePosition(alpha, `/${parent}/${alpha}`, 1, 0);
    await setTreePosition(beta, `/${parent}/${beta}`, 1, 1);
    await setTreePosition(gamma, `/${parent}/${gamma}`, 1, 2);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${gamma}/reorder`,
      payload: { sortOrder: 0 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: gamma, sortOrder: 0 });

    const rows = await query<{ id: number; sort_order: number }>(
      'SELECT id, sort_order FROM pages WHERE parent_id = $1 ORDER BY sort_order',
      [String(parent)],
    );
    expect(rows.rows).toEqual([
      { id: gamma, sort_order: 0 },
      { id: alpha, sort_order: 1 },
      { id: beta, sort_order: 2 },
    ]);
  });

  it('returns breadcrumb ancestors in materialized-path order with local-space provenance', async () => {
    await insertLocalSpace('CRUMBS', actorId);
    await query("UPDATE spaces SET space_name = 'Breadcrumb Space' WHERE space_key = 'CRUMBS'");
    const root = await insertStandalonePage('Root', 'private', actorId, 'CRUMBS');
    const parent = await insertStandalonePage('Parent', 'private', actorId, 'CRUMBS', {
      parentId: String(root),
    });
    const child = await insertStandalonePage('Child', 'private', actorId, 'CRUMBS', {
      parentId: String(parent),
    });
    await setTreePosition(root, `/${root}`, 0);
    await setTreePosition(parent, `/${root}/${parent}`, 1);
    await setTreePosition(child, `/${root}/${parent}/${child}`, 2);

    const response = await app.inject({
      method: 'GET',
      url: `/api/pages/${child}/breadcrumb`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      spaceKey: 'CRUMBS',
      spaceName: 'Breadcrumb Space',
      source: 'local',
      ancestors: [
        { id: root, title: 'Root' },
        { id: parent, title: 'Parent' },
      ],
      current: { id: child, title: 'Child' },
    });
  });
});
