/**
 * Page restrictions (`inherit_perms = FALSE` + page ACEs) on every non-RAG
 * read surface, against real PostgreSQL, Redis and RBAC state.
 *
 * R holds a role on the space and no ACE; G reads the restricted pages
 * through a group ACE; the administrator keeps today's listings (restricted
 * pages visible, other users' private standalone pages not).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { flushPageWriteInvalidations } from '../../core/services/page-write-invalidation.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { spacesRoutes } from '../confluence/spaces.js';
import { rbacRoutes } from '../foundation/rbac.js';
import { knowledgeAdminRoutes } from './knowledge-admin.js';
import { localSpacesRoutes } from './local-spaces.js';
import {
  RESTRICTED_TITLES,
  SEARCH_TERM,
  insertPageAce,
  restrictedLeaks,
  seedRestrictionFixture,
  type RestrictionFixture,
} from './page-restriction.test-helpers.js';
import { pagesCrudRoutes } from './pages-crud.js';
import { pagesEmbeddingRoutes } from './pages-embeddings.js';
import { buildKnowledgeTestApp } from './pages.test-helpers.js';
import { pinnedPagesRoutes } from './pinned-pages.js';
import { searchRoutes } from './search.js';
import { verificationRoutes } from './verification.js';

const available = await isDbAvailable() && await isRedisAvailable();

async function deleteUserKeys(redis: RedisClientType, userIds: Iterable<string>): Promise<void> {
  for (const userId of userIds) {
    let cursor = '0';
    do {
      const scanned = await redis.scan(cursor, { MATCH: `kb:${userId}:*`, COUNT: 200 });
      cursor = String(scanned.cursor);
      if (scanned.keys.length > 0) await redis.del(scanned.keys);
    } while (cursor !== '0');
    await redis.del([
      `kb-cache-generation:pages:user:${userId}`,
      `kb-cache-generation:search:user:${userId}`,
      `rbac:admin:${userId}`,
      `rbac:spaces:${userId}`,
    ]);
  }
}

describe.skipIf(!available)('page restrictions on non-RAG read surfaces', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let currentUserId = '';
  let fx: RestrictionFixture;
  const fixtureUserIds = new Set<string>();

  async function request(
    userId: string,
    url: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    payload?: unknown,
  ) {
    currentUserId = userId;
    return app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  }

  async function ok(userId: string, url: string): Promise<string> {
    const response = await request(userId, url);
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return response.body;
  }

  async function treeTitles(userId: string): Promise<string[]> {
    const body = JSON.parse(await ok(userId, '/api/pages/tree?spaceKey=DOCS')) as {
      items: Array<{ title: string }>;
    };
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
      await instance.register(pagesEmbeddingRoutes, { prefix: '/api' });
      await instance.register(searchRoutes, { prefix: '/api' });
      await instance.register(spacesRoutes, { prefix: '/api' });
      await instance.register(localSpacesRoutes, { prefix: '/api' });
      await instance.register(pinnedPagesRoutes, { prefix: '/api' });
      await instance.register(verificationRoutes, { prefix: '/api' });
      await instance.register(knowledgeAdminRoutes, { prefix: '/api' });
      await instance.register(rbacRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app?.close();
    if (redis?.isOpen) {
      await deleteUserKeys(redis, fixtureUserIds);
      await redis.quit();
    }
    setRedisClient(null);
    await truncateAllTables();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    fx = await seedRestrictionFixture();
    for (const userId of [fx.readerId, fx.groupReaderId, fx.adminId]) fixtureUserIds.add(userId);
    await query('DELETE FROM page_cache_invalidation_queue');
    for (const userId of [fx.readerId, fx.groupReaderId, fx.adminId]) {
      await query(
        `INSERT INTO pinned_pages (user_id, page_id, pin_order)
         VALUES ($1, $2, 0), ($1, $3, 1)`,
        [userId, fx.pages.hushedLeaf, fx.pages.openRoot],
      );
    }
  });

  const listingSurfaces = (): Array<[string, string]> => [
    ['pages list', '/api/pages?spaceKey=DOCS&limit=50'],
    ['pages tree', '/api/pages/tree?spaceKey=DOCS'],
    ['space tree', '/api/spaces/DOCS/tree'],
    ['filter facets', '/api/pages/filters'],
    ['keyword search, snippets and facets', `/api/search?q=${SEARCH_TERM}`],
    ['trigram title search', '/api/search?q=Hushed%20Lea'],
    ['full graph', '/api/pages/graph?spaceKey=DOCS'],
    ['local graph', `/api/pages/${fx.pages.openRoot}/graph/local`],
    ['children', `/api/pages/${fx.pages.openRoot}/children`],
    ['pinned pages', '/api/pages/pinned'],
  ];

  it('hides restricted titles, bodies and labels from R on every listing surface', async () => {
    const leaks: Record<string, string[]> = {};
    for (const [surface, url] of listingSurfaces()) {
      const found = restrictedLeaks(await ok(fx.readerId, url));
      if (found.length > 0) leaks[surface] = found;
    }
    expect(leaks).toEqual({});
  });

  it('keeps restricted pages on those surfaces for the group ACE holder and the administrator', async () => {
    const missing: string[] = [];
    for (const userId of [fx.groupReaderId, fx.adminId]) {
      for (const [surface, url] of listingSurfaces()) {
        if (surface === 'trigram title search' || surface === 'full graph') continue;
        const body = await ok(userId, url);
        const marker = surface === 'filter facets' ? 'hush-label' : 'Hushed Leaf';
        if (!body.includes(marker)) missing.push(`${surface} (${userId === fx.adminId ? 'admin' : 'G'})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps the administrator listings exactly as before: restricted pages yes, private notes no', async () => {
    expect(await treeTitles(fx.adminId)).toEqual([
      'Hushed Leaf',
      'Hushed Parent',
      'Open Root',
      'Shared Note',
      'Visible Child',
    ]);
    const search = JSON.parse(await ok(fx.adminId, `/api/search?q=${SEARCH_TERM}`)) as { total: number };
    expect(search.total).toBe(5);
  });

  it('re-roots a visible child under a hidden restricted parent', async () => {
    const tree = JSON.parse(await ok(fx.readerId, '/api/pages/tree?spaceKey=DOCS')) as {
      items: Array<{ id: string; parentId: string | null }>;
    };
    expect(tree.items.find((item) => item.id === String(fx.pages.visibleChild))?.parentId).toBeNull();

    const spaceTree = await ok(fx.readerId, '/api/spaces/DOCS/tree');
    expect(restrictedLeaks(spaceTree)).toEqual([]);
    expect(spaceTree).toContain('Visible Child');

    const breadcrumb = JSON.parse(
      await ok(fx.readerId, `/api/pages/${fx.pages.visibleChild}/breadcrumb`),
    ) as { ancestors: Array<{ title: string }> };
    expect(breadcrumb.ancestors.map((crumb) => crumb.title)).not.toContain('Hushed Parent');

    const detail = JSON.parse(await ok(fx.readerId, `/api/pages/${fx.pages.visibleChild}`)) as {
      parentId: string | null;
    };
    expect(detail.parentId).toBeNull();

    const clustered = JSON.parse(
      await ok(fx.readerId, '/api/pages/graph?view=clustered&spaceKey=DOCS'),
    ) as { nodes: Array<{ pageIds: number[] }> };
    const clusteredIds = clustered.nodes.flatMap((node) => node.pageIds);
    expect(clusteredIds).not.toContain(fx.pages.hushedLeaf);
    expect(clusteredIds).not.toContain(fx.pages.hushedParent);

    const groupTree = JSON.parse(await ok(fx.groupReaderId, '/api/pages/tree?spaceKey=DOCS')) as {
      items: Array<{ id: string; parentId: string | null }>;
    };
    expect(groupTree.items.find((item) => item.id === String(fx.pages.visibleChild))?.parentId)
      .toBe(String(fx.pages.hushedParent));
  });

  it('denies restricted page detail, children probes and verification to R only', async () => {
    expect((await request(fx.readerId, `/api/pages/${fx.pages.hushedLeaf}`)).statusCode).toBe(404);
    expect((await request(fx.groupReaderId, `/api/pages/${fx.pages.hushedLeaf}`)).statusCode).toBe(200);
    expect((await request(fx.adminId, `/api/pages/${fx.pages.hushedLeaf}`)).statusCode).toBe(200);

    const readerHasChildren = JSON.parse(
      await ok(fx.readerId, `/api/pages/${fx.pages.openRoot}/has-children`),
    ) as { hasChildren: boolean };
    expect(readerHasChildren.hasChildren).toBe(false);
    const groupHasChildren = JSON.parse(
      await ok(fx.groupReaderId, `/api/pages/${fx.pages.openRoot}/has-children`),
    ) as { hasChildren: boolean };
    expect(groupHasChildren.hasChildren).toBe(true);

    expect((await request(fx.readerId, `/api/pages/${fx.pages.hushedLeaf}/verify`, 'POST')).statusCode)
      .toBe(404);
    expect((await request(fx.groupReaderId, `/api/pages/${fx.pages.hushedLeaf}/verify`, 'POST')).statusCode)
      .toBe(200);
  });

  it('counts only authorized pages in space summaries, home ids, search totals and embedding status', async () => {
    const spacesFor = async (userId: string) => {
      const spaces = JSON.parse(await ok(userId, '/api/spaces')) as Array<{
        key: string;
        pageCount: number;
        homepageId: string | null;
      }>;
      return spaces.find((space) => space.key === 'DOCS');
    };
    expect(await spacesFor(fx.readerId)).toMatchObject({ pageCount: 4, homepageId: null });
    expect(await spacesFor(fx.groupReaderId)).toMatchObject({
      pageCount: 5,
      homepageId: String(fx.pages.hushedParent),
    });
    expect(await spacesFor(fx.adminId)).toMatchObject({
      pageCount: 5,
      homepageId: String(fx.pages.hushedParent),
    });

    const search = JSON.parse(await ok(fx.readerId, `/api/search?q=${SEARCH_TERM}`)) as {
      total: number;
      facets: { tags: Array<{ value: string }> };
    };
    expect(search.total).toBe(4);
    expect(search.facets.tags.map((tag) => tag.value)).not.toContain('hush-label');

    const status = async (userId: string) =>
      (JSON.parse(await ok(userId, '/api/llm/embedding-status')) as { totalPages: number }).totalPages;
    expect(await status(fx.readerId)).toBe(4);
    expect(await status(fx.groupReaderId)).toBe(5);
    expect(await status(fx.adminId)).toBe(5);
  });

  it('does not admit a user or group ACE holder without a space role (restrictions only narrow)', async () => {
    const aceOnlyUser = async (label: string): Promise<string> => {
      const username = `restriction-${label}-${randomUUID()}`;
      const res = await query<{ id: string }>(
        `INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, 'x', 'user') RETURNING id`,
        [username, `${username}@test`],
      );
      fixtureUserIds.add(res.rows[0]!.id);
      return res.rows[0]!.id;
    };
    const userAceOnly = await aceOnlyUser('user-ace-only');
    await insertPageAce(fx.pages.hushedLeaf, 'user', userAceOnly);
    const groupAceOnly = await aceOnlyUser('group-ace-only');
    await query('INSERT INTO group_memberships (group_id, user_id) VALUES ($1, $2)', [fx.groupId, groupAceOnly]);

    for (const userId of [userAceOnly, groupAceOnly]) {
      expect((await request(userId, `/api/pages/${fx.pages.hushedLeaf}`)).statusCode).toBe(404);
      for (const url of [
        '/api/pages?limit=50',
        '/api/pages/tree',
        `/api/search?q=${SEARCH_TERM}`,
        `/api/pages/${fx.pages.hushedLeaf}/graph/local`,
      ]) {
        expect(restrictedLeaks(await ok(userId, url)), url).toEqual([]);
      }
    }
  });

  describe('revocation and cache fencing', () => {
    it('CE admin routes: restricting, granting and revoking take effect on the next read', async () => {
      // Warm R's and G's cached trees while Open Root is unrestricted.
      expect(await treeTitles(fx.readerId)).toContain('Open Root');
      expect(await treeTitles(fx.groupReaderId)).toContain('Open Root');

      const grant = await request(fx.adminId, '/api/access-control', 'POST', {
        resourceType: 'page',
        resourceId: fx.pages.openRoot,
        principalType: 'group',
        principalId: String(fx.groupId),
        permission: 'read',
      });
      expect(grant.statusCode, grant.body).toBe(201);
      const aceId = grant.json<{ id: number }>().id;
      const restrict = await request(
        fx.adminId,
        `/api/pages/${fx.pages.openRoot}/inherit-perms`,
        'PUT',
        { inheritPerms: false },
      );
      expect(restrict.statusCode, restrict.body).toBe(200);

      expect(await treeTitles(fx.readerId)).not.toContain('Open Root');
      expect(await treeTitles(fx.groupReaderId)).toContain('Open Root');
      expect(await treeTitles(fx.adminId)).toContain('Open Root');

      const revoke = await request(fx.adminId, `/api/access-control/${aceId}`, 'DELETE');
      expect(revoke.statusCode, revoke.body).toBe(200);
      expect(await treeTitles(fx.groupReaderId)).not.toContain('Open Root');
      expect(await ok(fx.groupReaderId, `/api/search?q=${SEARCH_TERM}`)).not.toContain('Open Root');

      const regrant = await request(fx.adminId, '/api/access-control', 'POST', {
        resourceType: 'page',
        resourceId: fx.pages.openRoot,
        principalType: 'user',
        principalId: fx.groupReaderId,
        permission: 'read',
      });
      expect(regrant.statusCode, regrant.body).toBe(201);
      expect(await treeTitles(fx.groupReaderId)).toContain('Open Root');

      const unrestrict = await request(
        fx.adminId,
        `/api/pages/${fx.pages.openRoot}/inherit-perms`,
        'PUT',
        { inheritPerms: true },
      );
      expect(unrestrict.statusCode, unrestrict.body).toBe(200);
      expect(await treeTitles(fx.readerId)).toContain('Open Root');
    });

    it('a direct ACE write (EE bulk route, sync) is fenced by the durable invalidation queue', async () => {
      // G's cached tree includes the restricted pages through the group ACE.
      expect(await treeTitles(fx.groupReaderId)).toEqual(expect.arrayContaining([...RESTRICTED_TITLES]));
      const graphBefore = await ok(fx.groupReaderId, '/api/pages/graph?spaceKey=DOCS');
      expect(graphBefore).toContain('Hushed Leaf');

      // A writer outside the CE routes (no application-level invalidation).
      await query('DELETE FROM access_control_entries WHERE id = ANY($1::int[])', [fx.groupAceIds]);
      const queued = await query<{ page_id: number }>(
        'SELECT page_id FROM page_cache_invalidation_queue ORDER BY page_id',
      );
      expect(queued.rows.map((row) => row.page_id))
        .toEqual([fx.pages.hushedLeaf, fx.pages.hushedParent].sort((a, b) => a - b));

      // The outbox worker's drain is the only invalidation this writer gets.
      await flushPageWriteInvalidations();
      expect(await treeTitles(fx.groupReaderId)).toEqual(['Open Root', 'Shared Note', 'Visible Child']);
      expect(restrictedLeaks(await ok(fx.groupReaderId, '/api/pages/graph?spaceKey=DOCS'))).toEqual([]);

      // Granting through the same path makes the page reappear after the drain.
      await query(
        `INSERT INTO access_control_entries
           (resource_type, resource_id, principal_type, principal_id, permission, source, synced_at)
         VALUES ('page', $1, 'user', $2, 'read', 'confluence', NOW())`,
        [fx.pages.hushedLeaf, fx.groupReaderId],
      );
      await flushPageWriteInvalidations();
      expect(await treeTitles(fx.groupReaderId)).toContain('Hushed Leaf');
    });

    it('an ACE refresh that changes no principal does not enqueue invalidation', async () => {
      await query(
        `UPDATE access_control_entries SET synced_at = NOW(), source = 'confluence'
          WHERE id = ANY($1::int[])`,
        [fx.groupAceIds],
      );
      const queued = await query('SELECT page_id FROM page_cache_invalidation_queue');
      expect(queued.rows).toEqual([]);
    });
  });
});
