import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z, ZodError } from 'zod';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import {
  _resetWebhookEmitHookForTests,
  setWebhookEmitHook,
  type WebhookEvent,
} from '../../core/services/webhook-emit-hook.js';
import { encryptPat } from '../../core/utils/crypto.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import {
  insertConfluencePage,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';
import { pagesCrudRoutes } from './pages-crud.js';
import { localSpacesRoutes } from './local-spaces.js';

interface CreateResponse {
  id: number | string;
  title: string;
  version: number;
  source: 'standalone' | 'confluence';
  pageType?: 'page' | 'folder';
}

interface ErrorResponse {
  error: string;
}

interface PageRow {
  id: number;
  confluence_id: string | null;
  title: string;
  body_html: string;
  body_text: string;
  source: string;
  space_key: string | null;
  parent_id: string | null;
  path: string | null;
  depth: number;
  labels: string[];
  page_type: string;
  embedding_dirty: boolean;
  image_analysis_dirty: boolean;
}

interface UpstreamRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

const ConfluenceCreatePayloadSchema = z.object({
  title: z.string(),
  body: z.object({ storage: z.object({ value: z.string() }) }),
});

const available = (await isDbAvailable()) && (await isRedisAvailable());
const upstreamRequests: UpstreamRequest[] = [];
const upstreamPageIds: string[] = [];
const upstreamLabels = new Map<string, unknown>();
const webhookEvents: WebhookEvent[] = [];

let app: FastifyInstance;
let redis: RedisClientType;
let upstream: Server;
let upstreamBaseUrl = '';
let currentUserId = '';
let otherUserId = '';

async function readJson(request: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of request) raw += chunk.toString();
  return raw.length === 0 ? null : JSON.parse(raw);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function handleUpstream(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const payload = await readJson(request);
    const recorded: UpstreamRequest = {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      authorization: request.headers.authorization,
      body: payload,
    };
    upstreamRequests.push(recorded);

    if (recorded.method === 'POST' && recorded.url === '/rest/api/content') {
      const create = ConfluenceCreatePayloadSchema.parse(payload);
      const id = upstreamPageIds.shift() ?? `remote-${upstreamRequests.length}`;
      sendJson(response, 200, {
        id,
        title: create.title,
        status: 'current',
        type: 'page',
        version: { number: 1, when: '2026-09-20T00:00:00.000Z' },
        body: { storage: { value: create.body.storage.value } },
      });
      return;
    }

    if (/^\/rest\/api\/content\/[^/]+\/label$/.test(recorded.url)) {
      if (recorded.method === 'POST') upstreamLabels.set(recorded.url, payload);
      sendJson(response, 200, { results: upstreamLabels.get(recorded.url) ?? [] });
      return;
    }

    sendJson(response, 404, { message: 'Unexpected Confluence fixture request' });
  } catch (error) {
    sendJson(response, 500, { message: error instanceof Error ? error.message : String(error) });
  }
}

async function startUpstream(): Promise<void> {
  upstream = createServer((request, response) => {
    void handleUpstream(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    upstream.once('error', onError);
    upstream.listen(0, '127.0.0.1', () => {
      upstream.off('error', onError);
      resolve();
    });
  });
  const address = upstream.address();
  if (address === null || typeof address === 'string') throw new Error('Confluence fixture did not bind a TCP port');
  upstreamBaseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopUpstream(): Promise<void> {
  await new Promise<void>((resolve) => {
    upstream.close(() => resolve());
    upstream.closeAllConnections();
  });
}

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await instance.register(sensible);
  instance.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.status(400).send({ error: 'Validation failed' });
    return reply.status(error.statusCode ?? 500).send({ error: error.message });
  });
  instance.decorate('authenticate', async (request) => {
    request.userId = currentUserId;
    request.username = 'create-route-user';
    request.userRole = 'user';
  });
  instance.decorate('requireAdmin', async (request) => {
    request.userId = currentUserId;
    request.username = 'create-route-user';
    request.userRole = 'admin';
  });
  instance.decorate('redis', redis);
  await instance.register(pagesCrudRoutes, { prefix: '/api' });
  await instance.register(localSpacesRoutes, { prefix: '/api' });
  await instance.ready();
  return instance;
}

async function insertConfluenceSpace(spaceKey: string): Promise<void> {
  await query(
    `INSERT INTO spaces (space_key, space_name, source, last_synced)
     VALUES ($1, $1, 'confluence', NOW())`,
    [spaceKey],
  );
}

async function configureConfluence(userId: string, enabled = true): Promise<void> {
  await query(
    `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       confluence_url = EXCLUDED.confluence_url,
       confluence_pat = EXCLUDED.confluence_pat,
       confluence_enabled = EXCLUDED.confluence_enabled`,
    [userId, upstreamBaseUrl, encryptPat('fixture-confluence-pat'), enabled],
  );
}

async function grantSpace(userId: string, spaceKey: string): Promise<void> {
  const roleResult = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, is_system, permissions)
     VALUES ('create_route_writer', 'Create route writer', FALSE, ARRAY['read', 'write'])
     ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
     RETURNING id`,
  );
  const role = roleResult.rows[0];
  if (!role) throw new Error('RBAC role fixture was not created');
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)`,
    [spaceKey, userId, role.id],
  );
}

async function seedParent(title: string, spaceKey: string): Promise<number> {
  const id = await insertStandalonePage(title, 'shared', currentUserId, spaceKey);
  await query('UPDATE pages SET path = $1, depth = 0 WHERE id = $2', [`/${id}`, id]);
  return id;
}

async function rowsByTitle(title: string): Promise<PageRow[]> {
  const result = await query<PageRow>(
    `SELECT id, confluence_id, title, body_html, body_text, source, space_key,
            parent_id, path, depth, labels, page_type, embedding_dirty, image_analysis_dirty
       FROM pages WHERE title = $1 ORDER BY id`,
    [title],
  );
  return result.rows;
}

async function oneRowByTitle(title: string): Promise<PageRow> {
  const rows = await rowsByTitle(title);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error(`Page fixture ${title} was not persisted`);
  return row;
}

function createRequests(): UpstreamRequest[] {
  return upstreamRequests.filter((request) => request.url === '/rest/api/content');
}

interface HierarchyItem {
  id: string | number;
  parentId: string | null;
}

interface CreateSnapshot {
  pages: unknown[];
  audits: unknown[];
  intents: unknown[];
  cache: (string | null)[];
  webhooks: WebhookEvent[];
  upstream: UpstreamRequest[];
}

function parentCacheKeys(): string[] {
  return [currentUserId, otherUserId].map((id) => `kb:${id}:pages:canonical-parent`);
}

async function createSnapshot(): Promise<CreateSnapshot> {
  const pages = await query<{ page: unknown }>('SELECT to_jsonb(p) AS page FROM pages p ORDER BY id');
  const audits = await query<{ audit: unknown }>(
    "SELECT to_jsonb(a) AS audit FROM audit_log a WHERE action = 'PAGE_CREATED' ORDER BY id",
  );
  const intents = await query<{ intent: unknown }>(
    'SELECT to_jsonb(i) AS intent FROM page_write_intents i ORDER BY id',
  );
  return {
    pages: pages.rows.map((row) => row.page),
    audits: audits.rows.map((row) => row.audit),
    intents: intents.rows.map((row) => row.intent),
    cache: await redis.mGet(parentCacheKeys()),
    webhooks: [...webhookEvents],
    upstream: [...upstreamRequests],
  };
}

async function expectUnavailableParent(
  title: string,
  parentId: string | number | null,
  error = 'Parent page not found',
): Promise<void> {
  await redis.mSet(Object.fromEntries(parentCacheKeys().map((key) => [key, 'unchanged'])));
  const before = await createSnapshot();
  const response = await app.inject({
    method: 'POST',
    url: '/api/pages',
    payload: { title, bodyHtml: '<p>child</p>', source: 'standalone', parentId },
  });

  expect.soft(response.statusCode).toBe(400);
  expect.soft(response.json()).toEqual({ error });
  expect.soft(await rowsByTitle(title)).toEqual([]);
  expect.soft(await createSnapshot()).toEqual(before);
}

async function seedConfluenceParent(contentId: string, title: string): Promise<number> {
  const id = await insertConfluencePage(contentId, title, 'CONF');
  await query('UPDATE pages SET path = $1, depth = 0 WHERE id = $2', [`/${id}`, id]);
  return id;
}

async function expectParentProjection(
  child: PageRow,
  parentId: number,
  parentTitle: string,
  parentKey: string,
): Promise<void> {
  const detail = await app.inject({ method: 'GET', url: `/api/pages/${child.id}` });
  const tree = await app.inject({ method: 'GET', url: '/api/pages/tree' });
  const breadcrumb = await app.inject({ method: 'GET', url: `/api/pages/${child.id}/breadcrumb` });
  expect(detail.statusCode).toBe(200);
  expect(tree.statusCode).toBe(200);
  expect(breadcrumb.statusCode).toBe(200);
  expect.soft(detail.json<{ parentId: string | null }>().parentId).toBe(parentKey);
  expect.soft(tree.json<{ items: HierarchyItem[] }>().items.find((item) => String(item.id) === String(child.id))?.parentId)
    .toBe(String(parentId));
  expect.soft(breadcrumb.json<{ ancestors: Array<{ id: number; title: string }> }>().ancestors)
    .toEqual([{ id: parentId, title: parentTitle }]);
}

async function expectTextParent(contentId: string, caseId: string): Promise<void> {
  const parentTitle = `${caseId} Confluence parent`;
  const parentId = await seedConfluenceParent(contentId, parentTitle);
  await grantSpace(currentUserId, 'CONF');
  const title = `${caseId} standalone child`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/pages',
    payload: { title, bodyHtml: '<p>child</p>', source: 'standalone', parentId: contentId },
  });
  expect(response.statusCode).toBe(200);
  const child = await oneRowByTitle(title);
  expect(child.parent_id).toBe(contentId);
  expect(child.path).toBe(`/${parentId}/${child.id}`);
  expect(child.depth).toBe(1);
  await expectParentProjection(child, parentId, parentTitle, contentId);
  expect(upstreamRequests).toEqual([]);
  expect(webhookEvents).toEqual([{
    eventType: 'page.created',
    payload: expect.objectContaining({ pageId: child.id, isLocal: true }),
  }]);
}

describe.skipIf(!available)('POST /api/pages with real admission boundaries', () => {
  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { connectTimeout: 1_000, reconnectStrategy: false },
    });
    redis.on('error', () => undefined);
    await redis.connect();
    setRedisClient(redis);
    await startUpstream();
    app = await buildApp();
    setWebhookEmitHook((event) => {
      webhookEvents.push(event);
      return Promise.resolve();
    });
  }, 30_000);

  afterAll(async () => {
    await app.close();
    _resetWebhookEmitHookForTests();
    await truncateAllTables();
    await redis.flushDb();
    await stopUpstream();
    setRedisClient(null);
    if (redis.isOpen) await redis.quit();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await redis.flushDb();
    upstreamRequests.length = 0;
    upstreamPageIds.length = 0;
    upstreamLabels.clear();
    webhookEvents.length = 0;
    currentUserId = await insertUser('create_route_user');
    otherUserId = await insertUser('create_route_other');
    await insertLocalSpace('LOCAL_A', currentUserId);
    await insertLocalSpace('LOCAL_B', currentUserId);
    await insertConfluenceSpace('CONF');
  });

  it('persists a standalone page with its converted text, root path, and default fields', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: { title: 'Root note', bodyHtml: '<p>Hello <strong>world</strong></p>', source: 'standalone' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<CreateResponse>();
    const row = await oneRowByTitle('Root note');
    expect(body).toMatchObject({ id: row.id, source: 'standalone', version: 1, pageType: 'page' });
    expect(row).toMatchObject({
      body_html: '<p>Hello <strong>world</strong></p>',
      body_text: 'Hello world',
      source: 'standalone',
      space_key: null,
      parent_id: null,
      path: `/${row.id}`,
      depth: 0,
      labels: ['all-ai'],
    });
    expect(createRequests()).toEqual([]);
  });

  it('rejects a missing parent without inserting a page', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Missing-parent child',
        bodyHtml: '<p>child</p>',
        source: 'standalone',
        spaceKey: 'LOCAL_A',
        parentId: '999999',
      },
    });
    const error = response.json<ErrorResponse>();
    const persisted = await rowsByTitle('Missing-parent child');

    expect(response.statusCode).toBe(400);
    expect(error.error).toContain('Parent page not found');
    expect(persisted).toEqual([]);
  });

  it('rejects a parent from another local space', async () => {
    const parentId = await seedParent('Other-space parent', 'LOCAL_B');
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Cross-space child',
        bodyHtml: '<p>child</p>',
        source: 'standalone',
        spaceKey: 'LOCAL_A',
        parentId: String(parentId),
      },
    });
    const error = response.json<ErrorResponse>();
    const persisted = await rowsByTitle('Cross-space child');

    expect(response.statusCode).toBe(400);
    expect(error.error).toContain('same space');
    expect(persisted).toEqual([]);
  });

  it('persists a child under a valid parent in the same local space', async () => {
    const parentId = await seedParent('Same-space parent', 'LOCAL_A');
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Nested child',
        bodyHtml: '<p>child</p>',
        source: 'standalone',
        spaceKey: 'LOCAL_A',
        parentId: String(parentId),
      },
    });

    expect(response.statusCode).toBe(200);
    const row = await oneRowByTitle('Nested child');
    expect(row).toMatchObject({
      space_key: 'LOCAL_A',
      parent_id: String(parentId),
      path: `/${parentId}/${row.id}`,
      depth: 1,
    });
  });

  it('allows a valid parent when the new page is not assigned to a space', async () => {
    const parentId = await seedParent('Parent with a space', 'LOCAL_A');
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Spaceless child',
        bodyHtml: '<p>child</p>',
        source: 'standalone',
        parentId: String(parentId),
      },
    });

    expect(response.statusCode).toBe(200);
    const row = await oneRowByTitle('Spaceless child');
    expect(row.space_key).toBeNull();
    expect(row.parent_id).toBe(String(parentId));
    expect(row.path).toBe(`/${parentId}/${row.id}`);
  });

  describe('canonical standalone parent keys (#1743)', () => {
    it('R01 persists the resolved canonical PK for a padded standalone parent', async () => {
      const parentId = await seedParent('R01 parent', 'LOCAL_A');
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'R01 child', bodyHtml: '<p>child</p>', source: 'standalone',
          spaceKey: 'LOCAL_A', parentId: `00${parentId}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const child = await oneRowByTitle('R01 child');
      expect(child.parent_id).toBe(String(parentId));
      expect(child.path).toBe(`/${parentId}/${child.id}`);
      expect(child.depth).toBe(1);
    });

    it('R02 exposes a padded child parent and counts it in the parent detail', async () => {
      const parentId = await seedParent('R02 parent', 'LOCAL_A');
      const created = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'R02 child', bodyHtml: '<p>child</p>', source: 'standalone',
          spaceKey: 'LOCAL_A', parentId: `00${parentId}`,
        },
      });
      expect(created.statusCode).toBe(200);
      const child = await oneRowByTitle('R02 child');
      const childDetail = await app.inject({ method: 'GET', url: `/api/pages/${child.id}` });
      const parentDetail = await app.inject({ method: 'GET', url: `/api/pages/${parentId}` });

      expect(childDetail.statusCode).toBe(200);
      expect(parentDetail.statusCode).toBe(200);
      expect.soft(childDetail.json<{ parentId: string | null }>().parentId).toBe(String(parentId));
      expect.soft(parentDetail.json<{ hasChildren: boolean }>().hasChildren).toBe(true);
      expect.soft(parentDetail.json<{ descendantCount: number }>().descendantCount).toBe(1);
    });

    it('R03 retains the padded child parent in both trees and breadcrumbs', async () => {
      const parentTitle = 'R03 parent';
      const parentId = await seedParent(parentTitle, 'LOCAL_A');
      const created = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'R03 child', bodyHtml: '<p>child</p>', source: 'standalone',
          spaceKey: 'LOCAL_A', parentId: `00${parentId}`,
        },
      });
      expect(created.statusCode).toBe(200);
      const child = await oneRowByTitle('R03 child');
      await expectParentProjection(child, parentId, parentTitle, String(parentId));
      const localTree = await app.inject({ method: 'GET', url: '/api/spaces/LOCAL_A/tree' });
      expect(localTree.statusCode).toBe(200);
      expect.soft(localTree.json<{ items: HierarchyItem[] }>().items.find((item) => Number(item.id) === child.id)?.parentId)
        .toBe(String(parentId));
    });

    it('R07 stores the Confluence key when a standalone child addresses the parent by PK', async () => {
      const contentId = '3000000000';
      const parentTitle = 'R07 Confluence parent';
      const parentId = await seedConfluenceParent(contentId, parentTitle);
      await grantSpace(currentUserId, 'CONF');
      const created = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'R07 child', bodyHtml: '<p>child</p>', source: 'standalone',
          parentId: String(parentId),
        },
      });

      expect(created.statusCode).toBe(200);
      const child = await oneRowByTitle('R07 child');
      expect.soft(child.parent_id).toBe(contentId);
      await expectParentProjection(child, parentId, parentTitle, contentId);
      expect(upstreamRequests).toEqual([]);
    });

    it('R08 counts a standalone child through its Confluence parent canonical key', async () => {
      const parentId = await seedConfluenceParent('3000000000', 'R08 parent');
      await grantSpace(currentUserId, 'CONF');
      const created = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'R08 child', bodyHtml: '<p>child</p>', source: 'standalone',
          parentId: String(parentId),
        },
      });
      expect(created.statusCode).toBe(200);
      const detail = await app.inject({ method: 'GET', url: `/api/pages/${parentId}` });
      expect(detail.statusCode).toBe(200);
      expect.soft(detail.json<{ hasChildren: boolean }>().hasChildren).toBe(true);
      expect.soft(detail.json<{ descendantCount: number }>().descendantCount).toBe(1);
    });

    it('R09 resolves an existing oversized Confluence parent as text', async () => {
      await expectTextParent('3000000000', 'R09');
    });

    it('R10 preserves an existing Confluence parent beyond Number precision', async () => {
      await expectTextParent('9007199254740993', 'R10');
    });

    it('R11 resolves an existing opaque Confluence parent as text', async () => {
      await expectTextParent('conf-parent-alpha', 'R11');
    });

    it('R12 preserves the opaque padded Confluence arm instead of selecting its unpadded decoy', async () => {
      await seedConfluenceParent('3000000000', 'R12 unpadded decoy');
      await expectTextParent('0003000000000', 'R12');
    });

    it('R13 refuses a missing nonnumeric parent without effects', async () => {
      await expectUnavailableParent('R13 child', 'abc');
    });

    it('R14 refuses a missing parent just beyond int4 without effects', async () => {
      await expectUnavailableParent('R14 child', '2147483648');
    });

    it('R15 refuses a missing parent beyond Number precision without effects', async () => {
      await expectUnavailableParent('R15 child', '9007199254740993');
    });

    it('R16 refuses requested parent ambiguity without exposing a hidden decoy', async () => {
      const parentId = await seedParent('R16 parent', 'LOCAL_A');
      await seedConfluenceParent(String(parentId), 'R16 SECRET CONFLUENCE DECOY');
      await expectUnavailableParent('R16 child', String(parentId));
    });

    it('R17 refuses a unique requested PK whose canonical Confluence key names another live page', async () => {
      const decoyId = await insertStandalonePage('R17 SECRET PRIVATE DECOY', 'private', otherUserId, 'LOCAL_A');
      const parentId = await seedConfluenceParent(String(decoyId), 'R17 parent');
      await expectUnavailableParent('R17 child', String(parentId));
    });

    it('R18 refuses a canonical parent key collision with a trashed row without changing its stamp', async () => {
      const decoyId = await insertStandalonePage('R18 SECRET TRASHED DECOY', 'private', otherUserId, 'LOCAL_A', {
        deletedAt: new Date('2000-01-01T00:00:00Z'),
      });
      const parentId = await seedConfluenceParent(String(decoyId), 'R18 parent');
      await expectUnavailableParent('R18 child', String(parentId));
    });

    it('R19 uses the standalone PK rather than historical Confluence metadata for a padded parent', async () => {
      const parentId = await seedParent('R19 parent', 'LOCAL_A');
      await query('UPDATE pages SET confluence_id = $1 WHERE id = $2', ['historical-parent', parentId]);
      const created = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'R19 child', bodyHtml: '<p>child</p>', source: 'standalone',
          spaceKey: 'LOCAL_A', parentId: `00${parentId}`,
        },
      });
      expect(created.statusCode).toBe(200);
      expect.soft((await oneRowByTitle('R19 child')).parent_id).toBe(String(parentId));
      expect((await oneRowByTitle('R19 parent')).confluence_id).toBe('historical-parent');
    });

    it('R20 rejects an explicit empty parent even when no empty identity exists', async () => {
      await expectUnavailableParent('R20 child', '');
    });

    it('R21 rejects an explicit empty parent before an existing empty Confluence identity can resolve', async () => {
      const decoyId = await seedConfluenceParent('', 'R21 empty identity decoy');
      expect((await oneRowByTitle('R21 empty identity decoy'))).toMatchObject({ id: decoyId, confluence_id: '' });
      await expectUnavailableParent('R21 child', '');
    });

    it('P02 preserves numeric JSON parent IDs as canonical standalone PK text', async () => {
      const parentId = await seedParent('P02 parent', 'LOCAL_A');
      const created = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'P02 child', bodyHtml: '<p>child</p>', source: 'standalone',
          spaceKey: 'LOCAL_A', parentId,
        },
      });
      expect(created.statusCode).toBe(200);
      const child = await oneRowByTitle('P02 child');
      expect(child).toMatchObject({ parent_id: String(parentId), path: `/${parentId}/${child.id}`, depth: 1 });
      expect(webhookEvents).toEqual([{
        eventType: 'page.created',
        payload: expect.objectContaining({ pageId: child.id, isLocal: true }),
      }]);
    });

    it('P03 permits another owner private parent without granting access or cascade authority', async () => {
      const ownerId = currentUserId;
      const parentTitle = 'P03 SECRET PRIVATE PARENT';
      const parentId = await insertStandalonePage(parentTitle, 'private', ownerId, 'LOCAL_A');
      await query('UPDATE pages SET path = $1, depth = 0 WHERE id = $2', [`/${parentId}`, parentId]);
      currentUserId = otherUserId;
      const created = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'P03 child', bodyHtml: '<p>child</p>', source: 'standalone',
          visibility: 'private', spaceKey: 'LOCAL_A', parentId: String(parentId),
        },
      });
      expect(created.statusCode).toBe(200);
      const child = await oneRowByTitle('P03 child');
      const detail = await app.inject({ method: 'GET', url: `/api/pages/${child.id}` });
      const breadcrumb = await app.inject({ method: 'GET', url: `/api/pages/${child.id}/breadcrumb` });
      const tree = await app.inject({ method: 'GET', url: '/api/pages/tree' });
      expect(detail.statusCode).toBe(200);
      expect(breadcrumb.statusCode).toBe(200);
      expect(tree.statusCode).toBe(200);
      expect(detail.json<{ parentId: string | null }>().parentId).toBeNull();
      expect(breadcrumb.json<{ ancestors: unknown[] }>().ancestors).toEqual([]);
      expect(tree.json<{ items: HierarchyItem[] }>().items.find((item) => Number(item.id) === child.id)?.parentId).toBeNull();
      for (const response of [detail, breadcrumb, tree]) expect(response.body).not.toContain(parentTitle);

      currentUserId = ownerId;
      const parentDetail = await app.inject({ method: 'GET', url: `/api/pages/${parentId}` });
      expect(parentDetail.statusCode).toBe(200);
      expect(parentDetail.json()).toMatchObject({ hasChildren: false, descendantCount: 0 });
      const deleted = await app.inject({ method: 'DELETE', url: `/api/pages/${parentId}` });
      expect(deleted.statusCode).toBe(200);
      const trash = await app.inject({ method: 'GET', url: '/api/pages/trash' });
      expect(trash.statusCode).toBe(200);
      expect(trash.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id)).not.toContain(String(child.id));

      currentUserId = otherUserId;
      const stillLive = await app.inject({ method: 'GET', url: `/api/pages/${child.id}` });
      expect(stillLive.statusCode).toBe(200);
      expect(stillLive.json<{ parentId: string | null }>().parentId).toBeNull();
    });

    it('P04 keeps canonical standalone metadata and unrelated legacy padded parent rows unchanged', async () => {
      const parentId = await seedParent('P04 parent', 'LOCAL_A');
      await query('UPDATE pages SET confluence_id = $1 WHERE id = $2', ['P04 historical identity', parentId]);
      const legacyId = await insertStandalonePage('P04 legacy orphan', 'private', currentUserId, 'LOCAL_A', {
        parentId: `00${parentId}`,
      });
      const created = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: {
          title: 'P04 child', bodyHtml: '<p>child</p>', source: 'standalone',
          spaceKey: 'LOCAL_A', parentId: String(parentId),
        },
      });
      expect(created.statusCode).toBe(200);
      expect((await oneRowByTitle('P04 child')).parent_id).toBe(String(parentId));
      expect((await oneRowByTitle('P04 parent')).confluence_id).toBe('P04 historical identity');
      expect((await oneRowByTitle('P04 legacy orphan'))).toMatchObject({
        id: legacyId, parent_id: `00${parentId}`,
      });
    });

    it('P05 keeps an already trashed parent unavailable without restamping it', async () => {
      const parentId = await seedParent('P05 parent', 'LOCAL_A');
      await query('UPDATE pages SET deleted_at = $1 WHERE id = $2', ['2000-01-01T00:00:00Z', parentId]);
      await expectUnavailableParent('P05 child', String(parentId));
    });

    it('P09 preserves omitted-parent NULL roots and explicit-null refusal beside an empty identity', async () => {
      const decoyId = await seedConfluenceParent('', 'P09 empty identity decoy');
      const beforeDecoy = await oneRowByTitle('P09 empty identity decoy');
      const created = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: { title: 'P09 root', bodyHtml: '<p>root</p>', source: 'standalone' },
      });
      expect(created.statusCode).toBe(200);
      const root = await oneRowByTitle('P09 root');
      expect(root).toMatchObject({ parent_id: null, path: `/${root.id}`, depth: 0 });
      expect(root.id).not.toBe(decoyId);
      await expectUnavailableParent('P09 null child', null, 'Validation failed');
      expect(await oneRowByTitle('P09 empty identity decoy')).toEqual(beforeDecoy);
    });
  });

  it('auto-selects standalone storage for local, unknown, sentinel, and absent spaces', async () => {
    const fixtures = [
      { title: 'Detected local', spaceKey: 'LOCAL_A', expectedSpace: 'LOCAL_A' },
      { title: 'Unknown space', spaceKey: 'UNKNOWN', expectedSpace: null },
      { title: 'Local sentinel', spaceKey: '__local__', expectedSpace: null },
      { title: 'No space', expectedSpace: null },
    ];

    for (const fixture of fixtures) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pages',
        payload: { title: fixture.title, bodyHtml: '<p>local</p>', spaceKey: fixture.spaceKey },
      });
      expect(response.statusCode).toBe(200);
      const row = await oneRowByTitle(fixture.title);
      expect(row.source).toBe('standalone');
      expect(row.space_key).toBe(fixture.expectedSpace);
    }
    expect(createRequests()).toEqual([]);
  });

  it('honours explicit standalone source even when the selected space is Confluence-backed', async () => {
    await configureConfluence(currentUserId);
    await grantSpace(currentUserId, 'CONF');
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: { title: 'Local override', bodyHtml: '<p>local</p>', source: 'standalone', spaceKey: 'CONF' },
    });

    expect(response.statusCode).toBe(200);
    const row = await oneRowByTitle('Local override');
    expect(row.source).toBe('standalone');
    expect(row.space_key).toBeNull();
    expect(createRequests()).toEqual([]);
  });

  it('auto-selects Confluence for a Confluence space and honours an explicit Confluence override', async () => {
    await configureConfluence(currentUserId);
    await grantSpace(currentUserId, 'CONF');
    await grantSpace(currentUserId, 'LOCAL_A');
    upstreamPageIds.push('auto-remote', 'explicit-remote');

    const automatic = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: { title: 'Automatic remote', bodyHtml: '<p>auto</p>', spaceKey: 'CONF' },
    });
    const explicit = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Explicit remote',
        bodyHtml: '<p>explicit</p>',
        source: 'confluence',
        spaceKey: 'LOCAL_A',
      },
    });
    const automaticBody = automatic.json<CreateResponse>();
    const explicitBody = explicit.json<CreateResponse>();
    const automaticRow = await oneRowByTitle('Automatic remote');
    const explicitRow = await oneRowByTitle('Explicit remote');

    expect(automatic.statusCode).toBe(200);
    expect(explicit.statusCode).toBe(200);
    expect(automaticBody.source).toBe('confluence');
    expect(explicitBody.source).toBe('confluence');
    expect(automaticRow.confluence_id).toBe('auto-remote');
    expect(explicitRow.confluence_id).toBe('explicit-remote');
    const requests = createRequests();
    expect(requests).toHaveLength(2);
    const automaticRequest = requests[0];
    const explicitRequest = requests[1];
    if (!automaticRequest || !explicitRequest) throw new Error('Expected two Confluence create requests');
    expect(automaticRequest).toMatchObject({ authorization: 'Bearer fixture-confluence-pat' });
    expect(automaticRequest.body).toMatchObject({
      title: 'Automatic remote',
      space: { key: 'CONF' },
      body: { storage: { value: '<p>auto</p>', representation: 'storage' } },
    });
    expect(explicitRequest.body).toMatchObject({
      title: 'Explicit remote',
      space: { key: 'LOCAL_A' },
      body: { storage: { value: '<p>explicit</p>', representation: 'storage' } },
    });
  });

  it('treats missing integration settings as enabled but unconfigured', async () => {
    await grantSpace(currentUserId, 'CONF');
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: { title: 'No credentials', bodyHtml: '<p>x</p>', spaceKey: 'CONF' },
    });
    const error = response.json<ErrorResponse>();
    const persisted = await rowsByTitle('No credentials');

    expect(response.statusCode).toBe(400);
    expect(error.error).toBe('Confluence not configured');
    expect(upstreamRequests).toEqual([]);
    expect(persisted).toEqual([]);
  });

  it('refuses Confluence creation while integration is off without making an external request', async () => {
    await configureConfluence(currentUserId, false);
    await grantSpace(currentUserId, 'CONF');
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: { title: 'Integration off', bodyHtml: '<p>x</p>', spaceKey: 'CONF' },
    });
    const error = response.json<ErrorResponse>();
    const persisted = await rowsByTitle('Integration off');

    expect(response.statusCode).toBe(400);
    expect(error.error).toBe('Confluence integration is disabled');
    expect(upstreamRequests).toEqual([]);
    expect(persisted).toEqual([]);
  });

  it('persists supplied standalone labels, defaults omitted labels, and rejects the contract overflow', async () => {
    const labelled = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Labelled local',
        bodyHtml: '<p>x</p>',
        source: 'standalone',
        spaceKey: 'LOCAL_A',
        labels: ['api', 'guide'],
      },
    });
    const plain = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: { title: 'Plain local', bodyHtml: '<p>x</p>', source: 'standalone' },
    });
    const overflow = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Too many labels',
        bodyHtml: '<p>x</p>',
        source: 'standalone',
        labels: Array.from({ length: 51 }, (_, index) => `label-${index}`),
      },
    });

    expect(labelled.statusCode).toBe(200);
    expect(plain.statusCode).toBe(200);
    expect(overflow.statusCode).toBe(400);
    expect((await oneRowByTitle('Labelled local')).labels).toEqual(['api', 'guide', 'all-ai']);
    expect((await oneRowByTitle('Plain local')).labels).toEqual(['all-ai']);
    expect(await rowsByTitle('Too many labels')).toEqual([]);
  });

  it('resolves a Confluence parent from its database id and stores the upstream parent identity', async () => {
    await configureConfluence(currentUserId);
    await grantSpace(currentUserId, 'CONF');
    const parentResult = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html)
       VALUES ('3000000000', 'confluence', 'CONF', 'Remote parent', 'x', '<p>x</p>', '<p>x</p>')
       RETURNING id`,
    );
    const parent = parentResult.rows[0];
    if (!parent) throw new Error('Confluence parent fixture was not created');
    upstreamPageIds.push('remote-child');

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Remote child',
        bodyHtml: '<p>child</p>',
        source: 'confluence',
        spaceKey: 'CONF',
        parentId: String(parent.id),
      },
    });

    expect(response.statusCode).toBe(200);
    const request = createRequests()[0];
    expect(request?.body).toMatchObject({ ancestors: [{ id: '3000000000' }] });
    expect((await oneRowByTitle('Remote child')).parent_id).toBe('3000000000');
  });

  it('applies Confluence labels to the created row when its numeric content id collides with another row id', async () => {
    await configureConfluence(currentUserId);
    await grantSpace(currentUserId, 'CONF');
    const localId = await insertStandalonePage('Collision target', 'shared', currentUserId, 'LOCAL_A');
    upstreamPageIds.push(String(localId));

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Collision-safe remote',
        bodyHtml: '<p>remote</p>',
        source: 'confluence',
        spaceKey: 'CONF',
        labels: ['remote-label'],
      },
    });

    expect(response.statusCode).toBe(200);
    const localResult = await query<{ labels: string[] }>('SELECT labels FROM pages WHERE id = $1', [localId]);
    const remoteResult = await query<{ labels: string[] }>('SELECT labels FROM pages WHERE confluence_id = $1', [String(localId)]);
    expect(localResult.rows[0]?.labels).toEqual([]);
    expect(remoteResult.rows[0]?.labels).toEqual(['remote-label', 'all-ai']);
    expect(response.json().synchronization).toEqual({ status: 'complete', pendingIntentIds: [] });
    const labelRequest = upstreamRequests.find((request) => request.method === 'POST' && request.url.endsWith('/label'));
    expect(labelRequest?.body).toEqual([
      { prefix: 'global', name: 'remote-label' }, { prefix: 'global', name: 'all-ai' },
    ]);
  });

  it('queues embedding and image analysis for standalone pages but not folders', async () => {
    const pageResponse = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: { title: 'Indexed page', bodyHtml: '<p>x</p>', source: 'standalone' },
    });
    const folderResponse = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: { title: 'Folder', bodyHtml: '<p>discarded</p>', source: 'standalone', pageType: 'folder' },
    });

    expect(pageResponse.statusCode).toBe(200);
    expect(folderResponse.statusCode).toBe(200);
    const page = await oneRowByTitle('Indexed page');
    const folder = await oneRowByTitle('Folder');
    expect(page).toMatchObject({ embedding_dirty: true, image_analysis_dirty: true, page_type: 'page' });
    expect(folder).toMatchObject({
      body_html: '',
      body_text: '',
      embedding_dirty: false,
      image_analysis_dirty: false,
      page_type: 'folder',
    });
  });

  it('refuses a colliding Confluence create without changing the existing article or its image work', async () => {
    await configureConfluence(currentUserId);
    await grantSpace(currentUserId, 'CONF');
    upstreamPageIds.push('stable-content-id', 'stable-content-id');

    const first = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: { title: 'First remote title', bodyHtml: '<p>one</p>', spaceKey: 'CONF' },
    });
    expect(first.statusCode).toBe(200);
    await query("UPDATE pages SET image_analysis_dirty = FALSE WHERE confluence_id = 'stable-content-id'");

    const second = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: { title: 'Second remote title', bodyHtml: '<p>two</p>', spaceKey: 'CONF' },
    });

    expect(second.statusCode).toBe(409);
    const result = await query<{ title: string; body_html: string; image_analysis_dirty: boolean }>(
      "SELECT title, body_html, image_analysis_dirty FROM pages WHERE confluence_id = 'stable-content-id'",
    );
    expect(result.rows).toEqual([{
      title: 'First remote title',
      body_html: '<p>one</p>',
      image_analysis_dirty: false,
    }]);
  });

  it('invalidates every user page cache for shared creates and only the creator cache for private creates', async () => {
    const creatorKey = `kb:${currentUserId}:pages:list`;
    const otherKey = `kb:${otherUserId}:pages:tree`;
    await redis.mSet({ [creatorKey]: 'creator-stale', [otherKey]: 'other-stale' });

    const shared = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: { title: 'Shared cache change', bodyHtml: '<p>x</p>', source: 'standalone' },
    });
    expect(shared.statusCode).toBe(200);
    expect(await redis.mGet([creatorKey, otherKey])).toEqual([null, null]);

    await redis.mSet({ [creatorKey]: 'creator-stale', [otherKey]: 'other-stale' });
    const privateResponse = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Private cache change',
        bodyHtml: '<p>x</p>',
        source: 'standalone',
        visibility: 'private',
      },
    });
    expect(privateResponse.statusCode).toBe(200);
    expect(await redis.mGet([creatorKey, otherKey])).toEqual([null, 'other-stale']);
  });

  it('invalidates page and space caches across users after a Confluence create', async () => {
    await configureConfluence(currentUserId);
    await grantSpace(currentUserId, 'CONF');
    upstreamPageIds.push('cache-remote');
    const creatorPagesKey = `kb:${currentUserId}:pages:list`;
    const otherPagesKey = `kb:${otherUserId}:pages:tree`;
    const creatorSpacesKey = `kb:${currentUserId}:spaces:list`;
    const otherSpacesKey = `kb:${otherUserId}:spaces:available`;
    const keys = [creatorPagesKey, otherPagesKey, creatorSpacesKey, otherSpacesKey];
    await redis.mSet({
      [creatorPagesKey]: 'creator-pages',
      [otherPagesKey]: 'other-pages',
      [creatorSpacesKey]: 'creator-spaces',
      [otherSpacesKey]: 'other-spaces',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: { title: 'Remote cache change', bodyHtml: '<p>x</p>', spaceKey: 'CONF' },
    });

    expect(response.statusCode).toBe(200);
    expect(await redis.mGet(keys)).toEqual([null, null, null, null]);
  });
});
