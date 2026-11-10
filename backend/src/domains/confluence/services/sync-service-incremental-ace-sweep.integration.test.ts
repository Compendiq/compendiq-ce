/**
 * #1771 — the end-of-run stale-ACE sweep may only age out Confluence access
 * entries of pages whose restrictions the run re-read.
 *
 * Drives real `syncUser` runs through a real `ConfluenceClient` against the
 * in-process HTTP fixture below (pattern: sync-service-webhooks.test.ts), real
 * PostgreSQL and Redis, then reads the page back through the real
 * `GET /api/pages/:id` route and the RAG post-filter `filterAccessiblePages`.
 * Only `isFeatureEnabled` is replaced, to turn `rag_permission_enforcement` on.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { isRedisAvailable } from '../../../test-redis-helper.js';
import { query } from '../../../core/db/postgres.js';
import { setRedisClient } from '../../../core/services/redis-cache.js';
import { filterAccessiblePages } from '../../../core/services/rbac-service.js';
import { encryptPat } from '../../../core/utils/crypto.js';
import type * as EnterpriseFeatures from '../../../core/enterprise/features.js';
import type * as EnterpriseLoader from '../../../core/enterprise/loader.js';
import { buildKnowledgeTestApp } from '../../../routes/knowledge/pages.test-helpers.js';
import { pagesCrudRoutes } from '../../../routes/knowledge/pages-crud.js';
import type { ConfluencePage, ConfluenceRestriction } from './confluence-client.js';
import { resetRateLimiter } from './confluence-rate-limiter.js';
import { __internal, getSyncStatus, syncUser } from './sync-service.js';

// vitest hoists vi.mock above the imports, so sync-service binds this loader.
vi.mock('../../../core/enterprise/loader.js', async () => {
  const actual = await vi.importActual<typeof EnterpriseLoader>('../../../core/enterprise/loader.js');
  const { ENTERPRISE_FEATURES } = await vi.importActual<typeof EnterpriseFeatures>(
    '../../../core/enterprise/features.js',
  );
  return {
    ...actual,
    isFeatureEnabled: (feature: string) => feature === ENTERPRISE_FEATURES.RAG_PERMISSION_ENFORCEMENT,
  };
});

const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);

// ── Fake Confluence ─────────────────────────────────────────────────────────
interface RemotePage {
  id: string;
  title: string;
  status: 'current';
  type: 'page';
  version: { number: number; when: string; by: { displayName: string } };
  body: { storage: { value: string } };
  ancestors: Array<{ id: string; title: string }>;
  metadata: { labels: { results: Array<{ name: string }> } };
}

const SPACES = ['DOCS', 'TEAM'];
const remotePages = new Map<string, RemotePage>();
/** Confluence page id → space key. */
const spaceOf = new Map<string, string>();
/** Confluence page id → usernames on its own read restriction (absent = unrestricted). */
const readers = new Map<string, string[]>();
/** Ids the CQL `lastmodified >=` search returns (the incremental listing). */
const modifiedIds = new Set<string>();
/** PAT → page ids that principal cannot see (absent from listings, 403 on fetch). */
const hiddenFrom = new Map<string, Set<string>>();
/** Page ids whose BODY was fetched (`getPage`), i.e. the pages a run visited. */
const bodyFetches: string[] = [];
/**
 * When on, a run lists one space; every other space's listing answers 500
 * (not retried), so the walk fails after its first space whatever the order.
 */
let failListingsAfterFirstSpace = false;
const listedSpaces = new Set<string>();

const TEN_DAYS_AGO = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

function putPage(spaceKey: string, id: string, title: string, version = 1, when = TEN_DAYS_AGO): void {
  spaceOf.set(id, spaceKey);
  remotePages.set(id, {
    id,
    title,
    status: 'current',
    type: 'page',
    version: { number: version, when, by: { displayName: 'Fixture Author' } },
    body: { storage: { value: `<p>${title} body v${version}</p>` } },
    ancestors: [],
    metadata: { labels: { results: [] } },
  });
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

function paged(results: unknown[]) {
  return { results, start: 0, limit: Math.max(results.length, 1), size: results.length, _links: {} };
}

const fixture: Server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://fixture.test');
  const pat = (request.headers.authorization ?? '').replace(/^Bearer /, '');
  const hidden = hiddenFrom.get(pat) ?? new Set<string>();
  const visibleIn = (spaceKey: string | null) =>
    [...remotePages.values()].filter((p) => !hidden.has(p.id) && spaceOf.get(p.id) === spaceKey);
  const listingRefused = (spaceKey: string | null): boolean => {
    if (!failListingsAfterFirstSpace || spaceKey === null) return false;
    if (listedSpaces.size > 0 && !listedSpaces.has(spaceKey)) return true;
    listedSpaces.add(spaceKey);
    return false;
  };

  if (request.method !== 'GET') return json(response, 405, { message: 'Method not allowed' });
  if (url.pathname === '/rest/api/space') {
    return json(response, 200, paged(SPACES.map((key) => ({ key, name: key, type: 'global', status: 'current' }))));
  }
  if (url.pathname === '/rest/api/content') {
    const spaceKey = url.searchParams.get('spaceKey');
    if (listingRefused(spaceKey)) return json(response, 500, { message: 'listing failed' });
    return json(response, 200, paged(visibleIn(spaceKey)));
  }
  if (url.pathname === '/rest/api/content/search') {
    const spaceKey = /space="([^"]+)"/.exec(url.searchParams.get('cql') ?? '')?.[1] ?? null;
    if (listingRefused(spaceKey)) return json(response, 500, { message: 'listing failed' });
    return json(response, 200, paged(visibleIn(spaceKey).filter((p) => modifiedIds.has(p.id))));
  }
  const match = /^\/rest\/api\/content\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (match) {
    const id = decodeURIComponent(match[1]!);
    const sub = match[2] ?? '';
    const remote = remotePages.get(id);
    if (!remote) return json(response, 404, { message: 'Page not found' });
    if (hidden.has(id)) return json(response, 403, { message: 'Forbidden' });
    if (sub === '/child/attachment') return json(response, 200, paged([]));
    if (sub === '/restriction') {
      const users = readers.get(id);
      if (!users) return json(response, 404, { message: 'No restrictions' });
      return json(response, 200, paged([{
        operation: 'read',
        restrictions: {
          user: { results: users.map((username) => ({ userKey: `key-${username}`, username })) },
          group: { results: [] },
        },
      }]));
    }
    if (sub === '') {
      if ((url.searchParams.get('expand') ?? '').includes('body.storage')) bodyFetches.push(id);
      return json(response, 200, remote);
    }
  }
  // The audit log (/rest/api/audit/*) is absent → the restriction change-set is 'full'.
  return json(response, 404, { message: 'Fixture route not found' });
});

// ── Local state helpers ─────────────────────────────────────────────────────
let fixtureBaseUrl = '';
let attachmentRoot = '';
let originalAttachmentRoot: string | undefined;
let originalPatEncryptionKey: string | undefined;
let redis: RedisClientType;
let app: FastifyInstance;
let currentUserId = '';
let editorRoleId = 0;

async function seedUser(username: string, opts: { pat?: string; spaces?: string[] } = {}): Promise<string> {
  const user = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $1 || '@test', 'x', 'user') RETURNING id`,
    [username],
  );
  const userId = user.rows[0]!.id;
  if (opts.pat) {
    await query(
      `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
       VALUES ($1, $2, $3, TRUE)`,
      [userId, fixtureBaseUrl, encryptPat(opts.pat)],
    );
  }
  for (const spaceKey of opts.spaces ?? ['DOCS']) {
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $3)`,
      [spaceKey, userId, editorRoleId],
    );
  }
  return userId;
}

async function localPage(confluenceId: string) {
  const res = await query<{ id: number; inherit_perms: boolean }>(
    'SELECT id, inherit_perms FROM pages WHERE confluence_id = $1',
    [confluenceId],
  );
  return res.rows[0]!;
}

async function aceRows(pageId: number) {
  const res = await query<{ principal_type: string; principal_id: string; source: string }>(
    `SELECT principal_type, principal_id, source FROM access_control_entries
      WHERE resource_type = 'page' AND resource_id = $1
      ORDER BY principal_type, principal_id`,
    [pageId],
  );
  return res.rows;
}

function userAces(...userIds: string[]) {
  return [...userIds].sort().map((principalId) => ({
    principal_type: 'user', principal_id: principalId, source: 'confluence',
  }));
}

async function pageStatus(userId: string, pageId: number): Promise<number> {
  currentUserId = userId;
  return (await app.inject({ method: 'GET', url: `/api/pages/${pageId}` })).statusCode;
}

async function runSync(userId: string): Promise<void> {
  await syncUser(userId);
  // processDirtyPages is fire-and-forget; let it settle before the next step.
  await vi.waitFor(async () => {
    expect((await getSyncStatus(userId)).status).toBe('idle');
  }, { timeout: 10_000 });
}

async function ageSpaceCursor(spaceKey: string): Promise<void> {
  // Puts the next walk of this space on the >=24h full-sync branch.
  await query("UPDATE spaces SET last_synced = NOW() - INTERVAL '25 hours' WHERE space_key = $1", [spaceKey]);
}

describe.skipIf(!dbAvailable || !redisAvailable)('#1771 stale-ACE sweep is scoped to pages the run re-read', () => {
  beforeAll(async () => {
    originalAttachmentRoot = process.env.ATTACHMENTS_DIR;
    originalPatEncryptionKey = process.env.PAT_ENCRYPTION_KEY;
    process.env.PAT_ENCRYPTION_KEY = 'sync-ace-sweep-test-key-at-least-32-bytes';
    attachmentRoot = await mkdtemp(join(tmpdir(), 'sync-ace-sweep-'));
    process.env.ATTACHMENTS_DIR = attachmentRoot;

    await setupTestDb();
    const listening = Promise.withResolvers<void>();
    fixture.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Confluence fixture did not bind TCP');
    fixtureBaseUrl = `http://127.0.0.1:${address.port}`;

    redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false, connectTimeout: 1_000 } });
    redis.on('error', () => undefined);
    await redis.connect();
    setRedisClient(redis);

    app = await buildKnowledgeTestApp(() => currentUserId, async (instance) => {
      instance.redis = redis;
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
    });
  }, 30_000);

  beforeEach(async () => {
    remotePages.clear();
    spaceOf.clear();
    readers.clear();
    modifiedIds.clear();
    hiddenFrom.clear();
    failListingsAfterFirstSpace = false;
    listedSpaces.clear();
    bodyFetches.length = 0;
    resetRateLimiter();
    await truncateAllTables();
    await redis.flushDb();
    for (const spaceKey of SPACES) {
      await query('INSERT INTO spaces (space_key, space_name) VALUES ($1, $1)', [spaceKey]);
    }
    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, permissions)
       VALUES ('editor', 'Editor', ARRAY['read', 'edit']) RETURNING id`,
    );
    editorRoleId = role.rows[0]!.id;
  });

  afterAll(async () => {
    await app?.close();
    setRedisClient(null);
    if (redis?.isOpen) await redis.quit();
    fixture.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    fixture.close(() => closed.resolve());
    await closed.promise;
    await teardownTestDb();
    await rm(attachmentRoot, { recursive: true, force: true });
    if (originalAttachmentRoot === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = originalAttachmentRoot;
    if (originalPatEncryptionKey === undefined) delete process.env.PAT_ENCRYPTION_KEY;
    else process.env.PAT_ENCRYPTION_KEY = originalPatEncryptionKey;
  });

  it('full then incremental run with only Q modified keeps alice\'s entry on P and GET /api/pages/P at 200', async () => {
    const aliceId = await seedUser('alice');
    const carolId = await seedUser('carol');
    const syncerId = await seedUser(`syncer-${randomUUID()}`, { pat: 'syncer-pat' });
    putPage('DOCS', '7001', 'Restricted P');
    putPage('DOCS', '7002', 'Open Q');
    readers.set('7001', ['alice']);

    await runSync(syncerId); // spaces.last_synced IS NULL → full walk
    const p = await localPage('7001');
    expect(p.inherit_perms).toBe(false);
    expect(await aceRows(p.id)).toEqual(userAces(aliceId));
    expect(await pageStatus(aliceId, p.id)).toBe(200);
    expect(await pageStatus(carolId, p.id)).toBe(404);

    // Q is edited upstream; P and its restriction are untouched.
    putPage('DOCS', '7002', 'Open Q', 2, new Date().toISOString());
    modifiedIds.add('7002');
    bodyFetches.length = 0;

    await runSync(syncerId); // last_synced < 24h → incremental walk
    expect(bodyFetches).toEqual(['7002']);
    expect((await localPage('7001')).inherit_perms).toBe(false);
    expect(await aceRows(p.id)).toEqual(userAces(aliceId));
    expect([...(await filterAccessiblePages(aliceId, [p.id]))]).toEqual([p.id]);
    expect([...(await filterAccessiblePages(carolId, [p.id]))]).toEqual([]);
    expect(await pageStatus(aliceId, p.id)).toBe(200);
    expect(await pageStatus(carolId, p.id)).toBe(404);
  });

  it('an incremental run that visits P deletes a principal de-listed upstream (removal guard)', async () => {
    const aliceId = await seedUser('alice');
    const bobId = await seedUser('bob');
    const syncerId = await seedUser(`syncer-${randomUUID()}`, { pat: 'syncer-pat' });
    putPage('DOCS', '7001', 'Restricted P');
    putPage('DOCS', '7002', 'Open Q');
    readers.set('7001', ['alice', 'bob']);

    await runSync(syncerId);
    const p = await localPage('7001');
    expect(await aceRows(p.id)).toEqual(userAces(aliceId, bobId));

    putPage('DOCS', '7001', 'Restricted P', 2, new Date().toISOString());
    readers.set('7001', ['alice']);
    modifiedIds.add('7001');
    bodyFetches.length = 0;

    await runSync(syncerId);
    expect(bodyFetches).toEqual(['7001']);
    expect(await aceRows(p.id)).toEqual(userAces(aliceId));
    expect(await pageStatus(bobId, p.id)).toBe(404);
    expect(await pageStatus(aliceId, p.id)).toBe(200);
  });

  it('the next full run deletes a principal de-listed upstream from an unmodified page (removal guard)', async () => {
    const aliceId = await seedUser('alice');
    const bobId = await seedUser('bob');
    const syncerId = await seedUser(`syncer-${randomUUID()}`, { pat: 'syncer-pat' });
    putPage('DOCS', '7001', 'Restricted P');
    putPage('DOCS', '7002', 'Open Q');
    readers.set('7001', ['alice', 'bob']);

    await runSync(syncerId);
    const p = await localPage('7001');
    expect(await aceRows(p.id)).toEqual(userAces(aliceId, bobId));

    readers.set('7001', ['alice']); // restriction-only change: no new version
    await ageSpaceCursor('DOCS');
    bodyFetches.length = 0;

    await runSync(syncerId);
    expect([...bodyFetches].sort()).toEqual(['7001', '7002']);
    expect(await aceRows(p.id)).toEqual(userAces(aliceId));
    expect(await pageStatus(bobId, p.id)).toBe(404);
  });

  it('one run, DOCS on the full walk and TEAM incremental: the sweep follows each page, not the run', async () => {
    const aliceId = await seedUser('alice', { spaces: ['DOCS', 'TEAM'] });
    const bobId = await seedUser('bob', { spaces: ['DOCS', 'TEAM'] });
    const syncerId = await seedUser(`syncer-${randomUUID()}`, { pat: 'syncer-pat', spaces: ['DOCS', 'TEAM'] });
    putPage('DOCS', '7101', 'Docs restricted');
    putPage('TEAM', '7201', 'Team restricted');
    putPage('TEAM', '7202', 'Team open');
    readers.set('7101', ['alice', 'bob']);
    readers.set('7201', ['alice']);

    await runSync(syncerId); // both spaces: first walk is full
    const docsPage = await localPage('7101');
    const teamPage = await localPage('7201');
    expect(await aceRows(docsPage.id)).toEqual(userAces(aliceId, bobId));
    expect(await aceRows(teamPage.id)).toEqual(userAces(aliceId));

    readers.set('7101', ['alice']); // restriction-only change in DOCS
    putPage('TEAM', '7202', 'Team open', 2, new Date().toISOString());
    modifiedIds.add('7202');
    await ageSpaceCursor('DOCS'); // DOCS full, TEAM stays incremental
    bodyFetches.length = 0;

    await runSync(syncerId);
    expect([...bodyFetches].sort()).toEqual(['7101', '7202']);
    expect(await aceRows(docsPage.id)).toEqual(userAces(aliceId));
    expect(await aceRows(teamPage.id)).toEqual(userAces(aliceId));
  });

  it('a run that fails after re-reading P still removes the principal it saw de-listed', async () => {
    const aliceId = await seedUser('alice', { spaces: ['DOCS', 'TEAM'] });
    const bobId = await seedUser('bob', { spaces: ['DOCS', 'TEAM'] });
    const syncerId = await seedUser(`syncer-${randomUUID()}`, { pat: 'syncer-pat', spaces: ['DOCS', 'TEAM'] });
    // One restricted page per space: whichever space run 2 walks first is
    // re-read and the other space's listing fails, so the outcome does not
    // depend on the walk order.
    putPage('DOCS', '7101', 'Docs restricted');
    putPage('TEAM', '7201', 'Team restricted');
    readers.set('7101', ['alice', 'bob']);
    readers.set('7201', ['alice', 'bob']);

    await runSync(syncerId); // run 1: both spaces full
    const pages = [await localPage('7101'), await localPage('7201')];
    for (const page of pages) expect(await aceRows(page.id)).toEqual(userAces(aliceId, bobId));

    // bob is de-listed upstream on both pages (restriction-only change).
    readers.set('7101', ['alice']);
    readers.set('7201', ['alice']);
    await ageSpaceCursor('DOCS');
    await ageSpaceCursor('TEAM');
    failListingsAfterFirstSpace = true;
    // run 2: the first space is walked fully (page re-read, cursor advanced),
    // then the second space's listing fails the run.
    await expect(syncUser(syncerId)).rejects.toThrow('Confluence API error: HTTP 500');
    expect((await getSyncStatus(syncerId)).status).toBe('error');

    // run 3 succeeds; the space run 2 finished is incremental now and does not
    // re-read its page, so only run 2's own sweep can have removed bob there.
    failListingsAfterFirstSpace = false;
    await runSync(syncerId);
    for (const page of pages) {
      expect(await pageStatus(bobId, page.id)).toBe(404);
      expect(await pageStatus(aliceId, page.id)).toBe(200);
      expect(await aceRows(page.id)).toEqual(userAces(aliceId));
    }
  });

  it('a page removed upstream stays hidden from its readers; its unswept entries grant nothing', async () => {
    const aliceId = await seedUser('alice');
    const syncerId = await seedUser(`syncer-${randomUUID()}`, { pat: 'syncer-pat' });
    putPage('DOCS', '7001', 'Restricted P');
    putPage('DOCS', '7002', 'Open Q');
    readers.set('7001', ['alice']);

    await runSync(syncerId);
    const p = await localPage('7001');
    expect(await pageStatus(aliceId, p.id)).toBe(200);

    remotePages.delete('7001'); // deleted upstream: listing and GET answer 404
    await redis.del('sync:reconcile:DOCS'); // let this cycle's reconciliation run
    await runSync(syncerId);

    const row = await query<{ deleted_at: Date | null }>('SELECT deleted_at FROM pages WHERE id = $1', [p.id]);
    expect(row.rows[0]!.deleted_at).not.toBeNull();
    expect(await aceRows(p.id)).toEqual(userAces(aliceId));
    expect([...(await filterAccessiblePages(aliceId, [p.id]))]).toEqual([]);
    expect(await pageStatus(aliceId, p.id)).toBe(404);
  });

  it('a full run by a principal who cannot list P keeps the entries another run mirrored on P', async () => {
    const aliceId = await seedUser('alice', { pat: 'alice-pat' });
    const xavierId = await seedUser('xavier', { pat: 'xavier-pat' });
    putPage('DOCS', '7001', 'Restricted P');
    putPage('DOCS', '7002', 'Open Q');
    readers.set('7001', ['alice']);
    hiddenFrom.set('xavier-pat', new Set(['7001']));

    await runSync(aliceId);
    const p = await localPage('7001');
    expect(await aceRows(p.id)).toEqual(userAces(aliceId));

    await ageSpaceCursor('DOCS');
    bodyFetches.length = 0;
    await runSync(xavierId);
    expect(bodyFetches).toEqual(['7002']);
    expect(await aceRows(p.id)).toEqual(userAces(aliceId));
    expect(await pageStatus(aliceId, p.id)).toBe(200);
    expect(await pageStatus(xavierId, p.id)).toBe(404);
  });

  // ── Sweep seam (`__internal`) ─────────────────────────────────────────────
  function restrictionClient(byPage: Record<string, string[]>) {
    return {
      async getPageRestrictions(pageId: string): Promise<ConfluenceRestriction[]> {
        const users = byPage[pageId];
        return users
          ? [{ operation: 'read', restrictions: { users: users.map((u) => ({ userKey: `key-${u}`, username: u })), groups: [] } }]
          : [];
      },
      async getPageAncestors(): Promise<Array<{ id: string }>> {
        return [];
      },
    };
  }

  function seamPage(id: string): ConfluencePage {
    return {
      id,
      title: `Page ${id}`,
      status: 'current',
      type: 'page',
      version: { number: 1, when: new Date().toISOString() },
      body: { storage: { value: '' } },
      ancestors: [],
      metadata: { labels: { results: [] } },
    };
  }

  it('sweep ages out entries only on pages whose restrictions this run re-read', async () => {
    const aliceId = await seedUser('alice');
    await seedUser('bob');
    const ids: number[] = [];
    for (const confluenceId of ['c-unread', 'c-reread']) {
      const res = await query<{ id: number }>(
        `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html, inherit_perms)
         VALUES ($1, 'confluence', 'DOCS', $1, 'text', '', '', TRUE) RETURNING id`,
        [confluenceId],
      );
      ids.push(res.rows[0]!.id);
    }
    const [unread, reread] = ids as [number, number];
    const firstRun = new Date('2026-01-01T10:00:00Z');
    const secondRun = new Date('2026-01-02T10:00:00Z');

    const first = restrictionClient({ 'c-unread': ['alice'], 'c-reread': ['alice', 'bob'] });
    await __internal.syncPageRestrictions(first as never, seamPage('c-unread'), firstRun, new Map());
    await __internal.syncPageRestrictions(first as never, seamPage('c-reread'), firstRun, new Map());

    // The second run re-reads only c-reread, where bob was de-listed upstream.
    const second = restrictionClient({ 'c-reread': ['alice'] });
    await __internal.syncPageRestrictions(second as never, seamPage('c-reread'), secondRun, new Map());
    await __internal.sweepStaleConfluenceAces(secondRun, ['DOCS']);

    expect(await aceRows(unread)).toEqual(userAces(aliceId));
    expect(await aceRows(reread)).toEqual(userAces(aliceId));
  });
});
