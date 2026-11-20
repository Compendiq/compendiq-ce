import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type * as Undici from 'undici';
import { createClient, type RedisClientType } from 'redis';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables, waitForDatabaseCondition } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { getPool, query } from '../../core/db/postgres.js';
import { ATTACHMENT_SNAPSHOT_LOCK_ID, PAGE_HIERARCHY_LOCK_ID, PAGE_MOVE_ADVISORY_LOCK_ID } from '../../core/db/advisory-locks.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { encryptPat } from '../../core/utils/crypto.js';
import { userHasGlobalPermission } from '../../core/services/rbac-service.js';
import { confluenceToHtml, htmlToText } from '../../core/services/content-converter.js';
import {
  cancelPageWriteIntentBeforeEffect,
  reconcilePageWriteIntent,
  reservePageWriteIntent,
  withAiPolicyWriteTransaction,
} from '../../core/services/page-write-admission.js';
import { ConfluenceError } from '../../domains/confluence/services/confluence-client.js';
import { registerPageRelocateReconciler } from '../../domains/knowledge/services/page-relocate-service.js';
import { runNotionImport } from '../../domains/knowledge/services/notion-import-service.js';
import { NotionClient, setNotionApiBaseUrlForTests } from '../../domains/knowledge/services/notion-client.js';
import { startFakeNotionServer, type FakeNotionServer } from '../../domains/knowledge/services/__fixtures__/fake-notion-server.js';
import { buildKnowledgeTestApp, expectNoEmbeddingLeaseLeak, holdOtherEmbeddingLease } from './pages.test-helpers.js';
import { pagesRelocateRoutes } from './pages-relocate.js';
import { pagesCrudRoutes } from './pages-crud.js';
import { notionRoutes } from './notion.js';

// Only the external Confluence transport is controlled. In particular, loopback
// Notion HTTP, PostgreSQL, Redis, RBAC and filesystem publication stay real.
const h = vi.hoisted(() => {
  process.env.CONFLUENCE_RATE_LIMIT_RPM = '100000';
  return {
    documents: new Map<string, ControlledProviderPage>(),
    gone: new Set<string>(),
    files: new Map<string, Buffer>(),
    client: {
      createPage: vi.fn(),
      deletePage: vi.fn(),
      getPage: vi.fn(),
      getPageAttachments: vi.fn(),
    },
  };
});

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof Undici>();
  return {
    ...actual,
    request: vi.fn(async (url: string | URL, options: Record<string, unknown> = {}) => {
      const parsed = new URL(String(url));
      if (parsed.hostname !== 'confluence.test') {
        return actual.request(url, options as Parameters<typeof actual.request>[1]);
      }
      const method = String(options.method ?? 'GET');
      const page = parsed.pathname.match(/^\/rest\/api\/content\/([^/]+)$/);
      const inventory = parsed.pathname.match(/^\/rest\/api\/content\/([^/]+)\/child\/attachment$/);
      try {
        let value: unknown;
        if (method === 'POST' && parsed.pathname === '/rest/api/content') {
          const body = JSON.parse(String(options.body)) as {
            title: string; space: { key: string }; body: { storage: { value: string } };
          };
          value = await h.client.createPage(body.space.key, body.title, body.body.storage.value);
        } else if (method === 'POST' && inventory) {
          const multipart = Buffer.from(options.body as Uint8Array).toString('binary');
          const filename = /filename="([^"]+)"/.exec(multipart)?.[1];
          if (!filename) throw new Error('Controlled upload has no filename');
          const candidates = [...h.files.entries()].filter(([name]) => path.basename(name) === filename);
          if (candidates.length !== 1) throw new Error('Controlled source upload must have exactly one real byte fixture');
          const bytes = candidates[0]![1];
          h.files.set(`/download/attachments/${inventory[1]!}/${filename}`, bytes);
          value = {
            id: `att-${filename}`, title: filename, mediaType: 'image/png',
            extensions: { fileSize: bytes.length }, version: { number: 1 },
          };
        } else if (method === 'DELETE' && page) {
          await h.client.deletePage(page[1]!);
          return { statusCode: 204, headers: {}, body: { text: async () => '' } };
        } else if (method === 'GET' && inventory) {
          value = await h.client.getPageAttachments(inventory[1]!);
        } else if (method === 'GET' && page) {
          value = await h.client.getPage(page[1]!);
        } else if (method === 'GET' && parsed.pathname.startsWith('/download/attachments/')) {
          const bytes = h.files.get(parsed.pathname);
          if (!bytes) throw new ConfluenceError('Missing controlled provider attachment', 404);
          return {
            statusCode: 200, headers: {},
            body: { text: async () => bytes.toString(), async *[Symbol.asyncIterator]() { yield bytes; } },
          };
        } else {
          throw new Error(`Unexpected controlled Confluence request ${method} ${parsed.pathname}`);
        }
        return { statusCode: 200, headers: {}, body: { text: async () => JSON.stringify(value) } };
      } catch (error) {
        if (!(error instanceof ConfluenceError)) throw error;
        return {
          statusCode: error.statusCode, headers: {},
          body: { text: async () => JSON.stringify({ message: error.message }) },
        };
      }
    }),
  };
});

const TOKEN = '1774-controlled-notion-token';
const LEGACY_TOKEN = 'NO-TeS';
let app: FastifyInstance;
let redis: RedisClientType;
let notion: FakeNotionServer;
let attachmentsRoot: string;
let previousAttachmentsRoot: string | undefined;
let actor: string;
let ownerA: string;
let ownerB: string;
let administrator: string;

function deferred() {
  // The configured ES2022 Promise API exposes resolvers only through an executor.
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function providerPage(id: string, title: string, storage: string) {
  return {
    id, title, status: 'current', type: 'page',
    version: { number: 1, when: '' }, body: { storage: { value: storage } },
  };
}

async function user(name: string, role = 'admin') {
  const result = await query<{ id: string }>(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
    [`${name}-${randomUUID()}`, 'test-only', role],
  );
  const id = result.rows[0]!.id;
  await query(
    `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled, notion_integration_token)
     VALUES ($1, 'https://confluence.test', $2, TRUE, $3)`,
    [id, encryptPat('1774-controlled-pat'), encryptPat(TOKEN)],
  );
  return id;
}

async function page(options: {
  source?: 'standalone' | 'confluence'; owner?: string; notion?: string | null;
  confluenceId?: string; parent?: string; deleted?: boolean; body?: string; title?: string;
} = {}) {
  const source = options.source ?? 'confluence';
  const title = options.title ?? 'Preserved article';
  const storage = '<p>provider body</p>';
  const result = await query<{ id: number }>(
    `INSERT INTO pages (title, source, confluence_id, space_key, created_by_user_id,
       notion_page_id, visibility, body_html, body_storage, body_text, version,
       parent_id, deleted_at, ai_policy, remote_version)
     VALUES ($1, $2, $3, $4, $5, $6, 'shared', $7, $8, 'provider body', 1,
       $9, CASE WHEN $10::boolean THEN '2026-10-01T12:34:56.123456Z'::timestamptz ELSE NULL END, 'none', CASE WHEN $2 = 'confluence' THEN 1 END)
     RETURNING id`,
    [title, source, options.confluenceId ?? null, source === 'confluence' ? 'CONF' : 'LOCAL',
      options.owner ?? ownerA, options.notion ?? null, options.body ?? '<p>provider body</p>',
      storage, options.parent ?? null, options.deleted ?? false],
  );
  if (options.confluenceId) {
    h.documents.set(options.confluenceId, providerPage(options.confluenceId, title, storage));
  }
  return result.rows[0]!.id;
}

async function row(id: number) {
  return (await query<{ value: Record<string, unknown> }>(
    `SELECT to_jsonb(p) - 'content_revision' - 'lifecycle_revision' - 'updated_at' AS value
       FROM pages p WHERE id = $1`, [id],
  )).rows[0]!.value;
}

async function aces(id: number) {
  return (await query(
    `SELECT principal_type, principal_id, permission FROM access_control_entries
      WHERE resource_type = 'page' AND resource_id = $1 ORDER BY principal_type, principal_id, permission`,
    [id],
  )).rows;
}

async function capacity() {
  return (await query('SELECT to_jsonb(c) AS value FROM page_baseline_capacity c ORDER BY to_jsonb(c)::text')).rows;
}

async function intent(id: number) {
  return (await query<{
    id: string; runtime_id: string; status: string; remote_effect_started_at: string | null;
    remote_effects_completed_at: string | null; remote_terminal_result: Record<string, unknown> | null;
    effect_started_at: string | null;
  }>(
    `SELECT id, runtime_id, status, effect_started_at::text, remote_effect_started_at::text,
       remote_effects_completed_at::text, remote_terminal_result
       FROM page_write_intents WHERE kind = 'page.relocate' AND page_ids @> ARRAY[$1]::integer[]
       ORDER BY created_at DESC LIMIT 1`, [id],
  )).rows[0]!;
}

async function preparation(id: string) {
  return (await query<{ value: Record<string, unknown> }>(
    'SELECT to_jsonb(prep) AS value FROM page_relocation_preparations prep WHERE intent_id = $1', [id],
  )).rows[0]?.value;
}

// Same source-compatible retired-owner fixture as the existing relocation
// integration suite. It is created only after the request/effect has finished;
// it is not operator fencing evidence. W01 separately exercises real retirement.
async function retired(id: string) {
  const runtime = `1774-retired-${randomUUID()}`;
  await query(
    `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity, enforcement_version, ai_policy_enforcement_version, fenced_at, fence_reason, fence_proof)
     VALUES ($1, '{"fixture":"finished old relocation execution"}', 1, 1, NOW(),
       'Test-owned completed execution represented as a retired writer',
       '{"kind":"verified_local_termination"}')`, [runtime],
  );
  await query('UPDATE page_write_intents SET runtime_id = $2 WHERE id = $1 AND recovery_started_at IS NULL', [id, runtime]);
}

async function recover(id: string) {
  return reconcilePageWriteIntent(id, {
    actorId: administrator, reason: 'Verify the retained relocation through the original real persistence protocol',
  });
}

function toConfluence(id: number) {
  return app.inject({
    method: 'POST', url: `/api/pages/${id}/relocate`,
    payload: { target: 'confluence', spaceKey: 'CONF', acknowledgeAccessChange: true, acknowledgeDiscardedVersions: 0 },
  }).then((response) => response);
}

function toLocal(id: number, confluenceId: string) {
  return app.inject({
    method: 'POST', url: `/api/pages/${id}/relocate`,
    payload: {
      target: 'local', spaceKey: 'LOCAL', visibility: 'shared', acknowledgeAccessChange: true,
      confirmDeleteConfluencePage: { confluenceId, spaceKey: 'CONF' },
    },
  }).then((response) => response);
}

async function edit(id: number, userId = actor) {
  actor = userId;
  // Both sources take the same real local writer. That endpoint marks dirty
  // but does not launch an embedding worker, so do not invent a worker barrier.
  await query('UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1', [userId]);
  await holdOtherEmbeddingLease(redis);
  return app.inject({
    method: 'PUT', url: `/api/pages/${id}`, payload: { title: 'Edited after outcome', bodyHtml: '<p>ordinary edit</p>' },
  });
}

async function importNotes(userId: string, overwriteExisting = false) {
  const items = await runNotionImport({
    userId, client: new NotionClient(TOKEN), pageIds: ['notes'],
    spaceKey: 'LOCAL', visibility: 'shared', overwriteExisting,
  });
  return items.find((item) => item.notionPageId === 'notes')!;
}

async function successfulImport(userId: string) {
  const item = await importNotes(userId);
  expect(item.status).toBe('success');
  expect(item.localPageId).toBeTypeOf('number');
  return item.localPageId!;
}

async function tree() {
  const response = await app.inject({ method: 'GET', url: '/api/notion/tree' });
  expect(response.statusCode).toBe(200);
  return response.json<{ nodes: Array<{ id: string; alreadyImported?: boolean; localPageId?: number }> }>();
}

async function blockedBy(pid: number, shape = 'pg_advisory_xact_lock') {
  let waitingPid = 0;
  expect(await waitForDatabaseCondition(async () => {
    const result = await query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND $1::integer = ANY(pg_blocking_pids(pid)) AND query ILIKE $2
        ORDER BY pid LIMIT 1`, [pid, `%${shape}%`],
    );
    waitingPid = result.rows[0]?.pid ?? 0;
    return waitingPid !== 0;
  })).toBe(true);
  return waitingPid;
}

async function holder(lock: number) {
  const client = await getPool().connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock($1)', [lock]);
  const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  return { client, pid };
}

async function closeHolder(client: PoolClient) {
  try { await client.query('ROLLBACK'); } finally { client.release(); }
}

beforeAll(async () => {
  expect(await isDbAvailable(), 'The owned PostgreSQL must execute every case').toBe(true);
  expect(await isRedisAvailable(), 'The owned Redis must execute every case').toBe(true);
  await setupTestDb();
  await query(`
    CREATE TABLE test_1774_identity_events (
      sequence BIGSERIAL PRIMARY KEY, page_id INTEGER NOT NULL,
      old_source TEXT, new_source TEXT, old_owner UUID, new_owner UUID,
      old_token TEXT, new_token TEXT
    );
    CREATE FUNCTION test_1774_observe_identity() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF ROW(OLD.source,OLD.created_by_user_id,OLD.notion_page_id)
         IS DISTINCT FROM ROW(NEW.source,NEW.created_by_user_id,NEW.notion_page_id) THEN
        INSERT INTO test_1774_identity_events
          (page_id,old_source,new_source,old_owner,new_owner,old_token,new_token)
        VALUES (NEW.id,OLD.source,NEW.source,OLD.created_by_user_id,NEW.created_by_user_id,
                OLD.notion_page_id,NEW.notion_page_id);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_1774_identity_observer AFTER UPDATE ON pages
      FOR EACH ROW EXECUTE FUNCTION test_1774_observe_identity();
  `);
  previousAttachmentsRoot = process.env.ATTACHMENTS_DIR;
  attachmentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'compendiq-1774-relocate-'));
  process.env.ATTACHMENTS_DIR = attachmentsRoot;
  redis = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 1000, reconnectStrategy: false } });
  await redis.connect();
  setRedisClient(redis);
  notion = await startFakeNotionServer({
    validToken: TOKEN,
    pages: { notes: {
      object: 'page', id: 'notes', parent: { type: 'workspace', workspace: true },
      properties: { title: { type: 'title', title: [{ type: 'text', plain_text: 'Notes' }] } },
    } },
    searchResults: [{
      object: 'page', id: 'notes', parent: { type: 'workspace', workspace: true },
      properties: { title: { type: 'title', title: [{ type: 'text', plain_text: 'Notes' }] } },
    }],
    blockChildren: { notes: [{
      object: 'block', id: 'notes-body', type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', plain_text: 'A real imported body', text: { content: 'A real imported body' } }] },
    }] },
  });
  setNotionApiBaseUrlForTests(notion.baseUrl);
  registerPageRelocateReconciler();
  app = await buildKnowledgeTestApp(() => actor, async (instance) => {
    instance.redis = redis;
    instance.addHook('preHandler', async (request) => {
      request.userRole = (await query<{ role: 'admin' | 'user' }>('SELECT role FROM users WHERE id = $1', [request.userId])).rows[0]!.role;
      request.userCan = (permission: string) => userHasGlobalPermission(request.userId, permission);
    });
    await instance.register(pagesRelocateRoutes, { prefix: '/api' });
    await instance.register(pagesCrudRoutes, { prefix: '/api' });
    await instance.register(notionRoutes, { prefix: '/api' });
  });
});

beforeEach(async () => {
  await truncateAllTables();
  await redis.flushDb();
  await holdOtherEmbeddingLease(redis);
  await fs.rm(attachmentsRoot, { force: true, recursive: true });
  await fs.mkdir(attachmentsRoot, { recursive: true });
  h.documents.clear();
  h.gone.clear();
  h.files.clear();
  h.client.createPage.mockReset().mockImplementation(async (_space: string, title: string, storage: string) => {
    const result = providerPage('910001', title, storage);
    h.documents.set('910001', result);
    return result;
  });
  h.client.getPage.mockReset().mockImplementation(async (id: string) => {
    if (h.gone.has(id)) throw new ConfluenceError('Resource not found', 404);
    const document = h.documents.get(id);
    if (!document) throw new Error(`Missing provider fixture ${id}`);
    return document;
  });
  h.client.deletePage.mockReset().mockImplementation(async (id: string) => { h.gone.add(id); });
  h.client.getPageAttachments.mockReset().mockImplementation(async (id: string) => ({
    results: [...h.files.entries()].filter(([name]) => name.startsWith(`/download/attachments/${id}/`))
      .map(([name, bytes]) => ({
        id: `att-${path.basename(name)}`, title: path.basename(name), mediaType: 'image/png',
        extensions: { fileSize: bytes.length }, version: { number: 1 }, _links: { download: name },
      })),
    start: 0, limit: 100, size: h.files.size, _links: {},
  }));
  ownerA = await user('original-owner');
  ownerB = await user('relocating-owner');
  administrator = await user('recovery-admin');
  actor = ownerA;
  await query("INSERT INTO spaces (space_key, space_name, source) VALUES ('CONF','Confluence','confluence'), ('LOCAL','Local','local')");
});

afterEach(async () => {
  // Every individual barrier test releases and awaits its request in finally
  // before this shared test-owned data can be reset.
  expect(JSON.stringify(notion.requests)).not.toContain('api.notion.com');
});

// Declared first on purpose: afterAll hooks run last-declared first, so this
// runs after the teardown below and a failure here cannot skip that teardown.
afterAll(async () => {
  await expectNoEmbeddingLeaseLeak();
});

afterAll(async () => {
  await app?.close();
  await query(`
    DROP TRIGGER IF EXISTS test_1774_identity_observer ON pages;
    DROP FUNCTION IF EXISTS test_1774_observe_identity();
    DROP TABLE IF EXISTS test_1774_identity_events;
  `);
  setNotionApiBaseUrlForTests(null);
  await notion?.close();
  setRedisClient(null);
  if (redis?.isOpen) await redis.quit();
  await teardownTestDb();
  if (attachmentsRoot) await fs.rm(attachmentsRoot, { force: true, recursive: true });
  if (previousAttachmentsRoot === undefined) delete process.env.ATTACHMENTS_DIR;
  else process.env.ATTACHMENTS_DIR = previousAttachmentsRoot;
});

describe('1774 consumer regressions — real PostgreSQL relocation', () => {
  it('[RED R03/A01] re-imports after the same-PK Confluence cutover without losing dependencies', async () => {
    const id = await successfulImport(ownerA);
    const child = await page({ source: 'standalone', parent: String(id), deleted: true });
    const moved = await toConfluence(id);
    expect(moved.statusCode).toBe(200);
    const item = await importNotes(ownerA);
    // ORIGINAL: status fail/23505, not a missing snapshot field.
    expect(item.status).toBe('success');
    expect(item.localPageId).not.toBe(id);
    expect(await row(id)).toMatchObject({ source: 'confluence', confluence_id: '910001', notion_page_id: null });
    expect(await row(child)).toMatchObject({ parent_id: '910001' });
    expect((await intent(id)).status).toBe('completed');
    expect((await query(
      'SELECT old_source,new_source,old_owner,new_owner,old_token,new_token FROM test_1774_identity_events WHERE page_id=$1 ORDER BY sequence', [id],
    )).rows).toEqual([{
      old_source: 'standalone', new_source: 'confluence', old_owner: ownerA, new_owner: ownerA,
      old_token: 'notes', new_token: null,
    }]);
  });

  it('[RED R04a] refreshes a primed public tree after actual relocation without redis invalidation', async () => {
    const id = await successfulImport(ownerA);
    expect((await tree()).nodes.find((node) => node.id === 'notes')).toMatchObject({ alreadyImported: true, localPageId: id });
    const cached = await redis.get(`kb:${ownerA}:notion_tree:workspace`);
    const searchCount = notion.requests.filter((request) => request.url.includes('/v1/search')).length;
    expect((await toConfluence(id)).statusCode).toBe(200);
    const marker = (await tree()).nodes.find((node) => node.id === 'notes')!;
    // SAME public assertion must fail original AND preserving extraction.
    expect(marker.alreadyImported).toBe(false);
    expect(marker.localPageId).toBeUndefined();
    expect(await redis.get(`kb:${ownerA}:notion_tree:workspace`)).toBe(cached);
    expect(notion.requests.filter((request) => request.url.includes('/v1/search'))).toHaveLength(searchCount);
    const fresh = await successfulImport(ownerA);
    expect((await tree()).nodes.find((node) => node.id === 'notes')).toMatchObject({ alreadyImported: true, localPageId: fresh });
  });

  it('[RED R05] B moves A former import back despite B independently importing the same source', async () => {
    const id = await successfulImport(ownerA);
    expect((await toConfluence(id)).statusCode).toBe(200);
    const other = await successfulImport(ownerB);
    const preservedOther = await row(other);
    actor = ownerB;
    const moved = await toLocal(id, '910001');
    // ORIGINAL reaches this assertion: B's own import is in another owner
    // namespace until the old publisher flips A's row to B and hits23505.
    expect(moved.statusCode).toBe(200);
    expect(await row(other)).toEqual(preservedOther);
    expect(await row(id)).toMatchObject({ source: 'standalone', created_by_user_id: ownerB, notion_page_id: null });
    expect((await intent(id)).status).toBe('completed');
    expect(await preparation((await intent(id)).id)).toBeUndefined();
    expect((await edit(id, ownerB)).statusCode).toBe(200);
  });

  it('[RED R06/A02] imports a fresh page instead of rebinding a moved-local legacy copy', async () => {
    const id = await page({ confluenceId: '710001', notion: LEGACY_TOKEN });
    const originalBody = (await row(id)).body_html;
    expect((await toLocal(id, '710001')).statusCode).toBe(200);
    const item = await importNotes(ownerA);
    expect(item.localPageId).not.toBe(id);
    expect(item.status).toBe('success');
    expect(await row(id)).toMatchObject({ notion_page_id: null, body_html: originalBody });
    expect((await query(
      'SELECT old_source,new_source,old_token,new_token FROM test_1774_identity_events WHERE page_id=$1 ORDER BY sequence', [id],
    )).rows).toEqual([{
      old_source: 'confluence', new_source: 'standalone', old_token: LEGACY_TOKEN, new_token: null,
    }]);
  });

  it.each([null, LEGACY_TOKEN])('[PASS C01] exact normal provably-live rollback, original token %s', async (token) => {
    const id = await page({ confluenceId: '710002', notion: token });
    const child = await page({ confluenceId: '710003', parent: '710002', deleted: true });
    await query("INSERT INTO access_control_entries (resource_type,resource_id,principal_type,principal_id,permission) VALUES ('page',$1,'user',$2,'edit')", [id, ownerB]);
    const original = await row(id);
    const originalChild = await row(child);
    const originalAces = await aces(id);
    const originalCapacity = await capacity();
    h.client.deletePage.mockRejectedValue(new Error('controlled original deletion failure'));
    const response = await toLocal(id, '710002');
    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('controlled original deletion failure');
    expect(await row(id)).toEqual(original);
    expect(await row(child)).toEqual(originalChild);
    expect(await aces(id)).toEqual(originalAces);
    expect(await capacity()).toEqual(originalCapacity);
    expect(await intent(id)).toMatchObject({ status: 'completed', remote_terminal_result: { outcome: 'live' } });
    expect(await preparation((await intent(id)).id)).toBeUndefined();
  });

  it.each([null, LEGACY_TOKEN])('[PASS C03] undispatched local cutover recovers exact token %s', async (token) => {
    const id = await page({ confluenceId: '710004', notion: token });
    const original = await row(id);
    const lock = await holder(ATTACHMENT_SNAPSHOT_LOCK_ID);
    const pending = toLocal(id, '710004');
    try {
      await blockedBy(lock.pid);
      await query('UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1', [ownerA]);
      await lock.client.query('COMMIT');
      expect((await pending).statusCode).toBe(409);
      expect(h.client.deletePage).not.toHaveBeenCalled();
      const held = await intent(id);
      expect(held.remote_effect_started_at).toBeNull();
      await query('UPDATE user_settings SET confluence_enabled = TRUE WHERE user_id = $1', [ownerA]);
      await retired(held.id);
      expect(await recover(held.id)).toEqual({ intentId: held.id, status: 'reconciled_not_applied' });
      expect(await row(id)).toEqual(original);
      expect(await preparation(held.id)).toBeUndefined();
    } finally {
      await closeHolder(lock.client);
      await pending;
    }
  });

  it.each([null, LEGACY_TOKEN])('[PASS C04/C06] changed cutover ACL refuses, then exact live rollback token %s', async (token) => {
    const id = await page({ confluenceId: '710005', notion: token });
    const original = await row(id);
    const originalCapacity = await capacity();
    h.client.deletePage.mockImplementation(async () => {
      await query("INSERT INTO access_control_entries (resource_type,resource_id,principal_type,principal_id,permission) VALUES ('page',$1,'user',$2,'read')", [id, ownerB]);
      throw new Error('controlled live delete refusal');
    });
    const response = await toLocal(id, '710005');
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: 'intent_local_evidence_mismatch' });
    const held = await intent(id);
    expect(held).toMatchObject({ status: 'pending', remote_terminal_result: { outcome: 'live' } });
    const preservedCutover = await row(id);
    const preservedPrep = await preparation(held.id);
    await retired(held.id);
    await expect(recover(held.id)).rejects.toMatchObject({ reason: 'intent_local_evidence_mismatch' });
    expect(await row(id)).toEqual(preservedCutover);
    expect(await preparation(held.id)).toEqual(preservedPrep);
    expect(await aces(id)).toHaveLength(1);
    await query("DELETE FROM access_control_entries WHERE resource_type='page' AND resource_id=$1 AND principal_id=$2", [id, ownerB]);
    expect(await recover(held.id)).toEqual({ intentId: held.id, status: 'reconciled_not_applied' });
    expect(await row(id)).toEqual(original);
    expect(await capacity()).toEqual(originalCapacity);
  });

  it.each(['original-provider-error', 'downstream-edit'] as const)('[RED N01] preserves %s when A imports during B late compensation', async (oracle) => {
    actor = ownerB;
    const golden = await page({ confluenceId: '710010', notion: 'golden-token' });
    const failure = new Error('controlled original provider deletion failure');
    h.client.deletePage.mockRejectedValue(failure);
    const ordinaryFailure = await toLocal(golden, '710010');
    expect(ordinaryFailure.statusCode).toBe(500);
    expect(await row(golden)).toMatchObject({ source: 'confluence' });
    expect((await edit(golden, ownerB)).statusCode).toBe(200);
    await query('UPDATE user_settings SET confluence_enabled=TRUE WHERE user_id=$1', [ownerB]);

    const id = await page({
      confluenceId: '710011', notion: LEGACY_TOKEN,
      body: '<p><img src="/api/attachments/710011/pic.png"></p>',
    });
    const child = await page({ source: 'standalone', parent: '710011', deleted: true });
    await fs.mkdir(path.join(attachmentsRoot, '710011'), { recursive: true });
    await fs.writeFile(path.join(attachmentsRoot, '710011', 'pic.png'), 'preserved attachment bytes');
    h.files.set('/download/attachments/710011/pic.png', Buffer.from('preserved attachment bytes'));
    const original = await row(id);
    const originalChild = await row(child);
    const originalAces = await aces(id);
    const originalCapacity = await capacity();
    const entered = deferred();
    const release = deferred();
    h.client.deletePage.mockImplementation(async () => {
      entered.release();
      await release.promise;
      throw failure;
    });
    const pending = toLocal(id, '710011');
    try {
      await entered.promise;
      const held = await intent(id);
      expect(held.status).toBe('pending');
      expect(await row(id)).toMatchObject({ source: 'standalone', created_by_user_id: ownerB });
      const savedPrep = await preparation(held.id); // observation only before primary consumer oracle
      const imported = await successfulImport(ownerA);
      const importedBody = await row(imported);
      release.release();
      const response = await pending;
      const rollback = await row(id);
      if (oracle === 'original-provider-error') {
        expect({ status: response.statusCode, body: response.body }).toEqual({
          status: ordinaryFailure.statusCode, body: ordinaryFailure.body,
        });
      } else {
        expect((await edit(id, ownerB)).statusCode).toBe(200);
      }
      expect(rollback).toEqual(original);
      expect(await row(child)).toEqual(originalChild);
      expect(await aces(id)).toEqual(originalAces);
      expect(await row(imported)).toEqual(importedBody);
      expect(await capacity()).toEqual(originalCapacity);
      expect(await intent(id)).toMatchObject({ status: 'completed', remote_terminal_result: { outcome: 'live' } });
      expect(await preparation(held.id)).toBeUndefined();
      expect(await fs.readFile(path.join(attachmentsRoot, '710011', 'pic.png'), 'utf8')).toBe('preserved attachment bytes');
      expect((await query('SELECT 1 FROM local_attachments WHERE page_id=$1', [id])).rowCount).toBe(0);
      await expect(fs.stat(path.join(attachmentsRoot, 'local', String(id), 'pic.png'))).rejects.toMatchObject({ code: 'ENOENT' });
      // Ancillary feature observation only after actual error/edit outcome.
      expect(savedPrep?.original_notion_page_id).toBe(LEGACY_TOKEN);
    } finally {
      release.release();
      await pending;
    }
  });

  it('[PASS U01] keeps unknown remote outcome pending and fences edit/policy without losing local bytes', async () => {
    const id = await page({ confluenceId: '710020', notion: LEGACY_TOKEN });
    h.client.deletePage.mockRejectedValue(new Error('unknown delete transport'));
    h.client.getPage.mockRejectedValue(new Error('unknown readback transport'));
    expect((await toLocal(id, '710020')).statusCode).toBe(500);
    const held = await intent(id);
    const safe = await row(id);
    const progress = await preparation(held.id);
    expect(held.status).toBe('pending');
    expect(held.remote_effect_started_at).not.toBeNull();
    expect(held.remote_effects_completed_at).toBeNull();
    expect((await edit(id)).statusCode).toBe(409);
    let policyCallback = false;
    await expect(withAiPolicyWriteTransaction([id], async () => { policyCallback = true; }))
      .rejects.toMatchObject({ statusCode: 409, reason: 'page_write_busy' });
    expect(policyCallback).toBe(false);
    expect(await row(id)).toEqual(safe);
    expect(await preparation(held.id)).toEqual(progress);
  });

  for (const keyClass of ['to-local-current-key', 'to-local-destination-key', 'to-confluence-current-key'] as const) {
    for (const trashed of [false, true]) {
      it(`[RED K/I1] ${keyClass} ${trashed ? 'trashed' : 'live'} clash refuses before admission, then edit works`, async () => {
        const movingToConfluence = keyClass === 'to-confluence-current-key';
        const id = await page({
          source: movingToConfluence ? 'standalone' : 'confluence',
          confluenceId: movingToConfluence ? undefined : '2000000000', notion: LEGACY_TOKEN,
        });
        const before = await row(id);
        const beforeCapacity = await capacity();
        const lock = await holder(PAGE_HIERARCHY_LOCK_ID);
        const pending = movingToConfluence ? toConfluence(id) : toLocal(id, '2000000000');
        let alias = 0;
        try {
          await blockedBy(lock.pid);
          expect((await query("SELECT 1 FROM page_write_intents WHERE kind='page.relocate' AND page_ids @> ARRAY[$1]::int[]", [id])).rowCount).toBe(0);
          if (keyClass === 'to-local-current-key') {
            alias = 2000000000;
            await lock.client.query(
              `INSERT INTO pages (id,title,source,space_key,visibility,body_html,body_text,version,created_by_user_id,deleted_at)
               VALUES ($1,'Foreign identifier owner','standalone','LOCAL','private','<p>alias</p>','alias',1,$2,
                 CASE WHEN $3::boolean THEN NOW() ELSE NULL END)`, [alias, ownerB, trashed],
            );
          } else {
            alias = (await lock.client.query<{ id: number }>(
              `INSERT INTO pages (title,source,confluence_id,space_key,visibility,body_html,body_text,version,created_by_user_id,deleted_at)
               VALUES ('Foreign identifier owner','confluence',$1,'CONF','private','<p>alias</p>','alias',1,$2,
                 CASE WHEN $3::boolean THEN NOW() ELSE NULL END) RETURNING id`, [String(id), ownerB, trashed],
            )).rows[0]!.id;
          }
          await lock.client.query('COMMIT');
          const response = await pending;
          const unchanged = await row(id);
          // Removing only the test alias must not require force-clearing a
          // mistakenly admitted intent. This is the first consumer red.
          await query('DELETE FROM pages WHERE id=$1', [alias]);
          expect((await edit(id)).statusCode).toBe(200);
          expect(response.statusCode).toBe(409);
          expect(response.body).not.toContain('Foreign identifier owner');
          expect(unchanged).toEqual(before);
          expect((await query("SELECT 1 FROM page_write_intents WHERE kind='page.relocate' AND page_ids @> ARRAY[$1]::int[]", [id])).rowCount).toBe(0);
          expect((await query('SELECT 1 FROM page_relocation_preparations WHERE page_id=$1', [id])).rowCount).toBe(0);
          expect((await query('SELECT 1 FROM local_attachments WHERE page_id=$1', [id])).rowCount).toBe(0);
          expect(h.client.createPage).not.toHaveBeenCalled();
          expect(h.client.deletePage).not.toHaveBeenCalled();
          expect(h.client.getPage).not.toHaveBeenCalled();
          expect(await capacity()).toEqual(beforeCapacity);
        } finally {
          await closeHolder(lock.client);
          await pending;
        }
      });
    }
  }

  it('[RED R11/I2] detects a token-only repair committed while waiting before reservation', async () => {
    const id = await page({ confluenceId: '720002', notion: LEGACY_TOKEN });
    const beforeRevisions = (await query<{ content_revision: number; lifecycle_revision: number }>(
      'SELECT content_revision,lifecycle_revision FROM pages WHERE id=$1', [id],
    )).rows[0];
    const lock = await holder(PAGE_HIERARCHY_LOCK_ID);
    const pending = toLocal(id, '720002');
    try {
      await blockedBy(lock.pid);
      await lock.client.query('UPDATE pages SET notion_page_id=NULL WHERE id=$1', [id]);
      await lock.client.query('COMMIT');
      expect((await pending).statusCode).toBe(409);
      expect((await query("SELECT 1 FROM page_write_intents WHERE kind='page.relocate' AND page_ids @> ARRAY[$1]::int[]", [id])).rowCount).toBe(0);
      expect((await query('SELECT 1 FROM page_relocation_preparations WHERE page_id=$1', [id])).rowCount).toBe(0);
      expect((await query(
        'SELECT content_revision,lifecycle_revision FROM pages WHERE id=$1', [id],
      )).rows[0]).toEqual(beforeRevisions);
      expect(h.client.createPage).not.toHaveBeenCalled();
      expect(h.client.deletePage).not.toHaveBeenCalled();
      expect(await row(id)).toMatchObject({ source: 'confluence', notion_page_id: null });
    } finally {
      await closeHolder(lock.client);
      await pending;
    }
  });

  it('[PASS I3] pending Notion publication refuses relocation before clearing its binding', async () => {
    const id = await successfulImport(ownerA);
    const original = await row(id);
    const bodyHtml = '<p>held publication</p>';
    const bodyText = 'held publication';
    const held = await reservePageWriteIntent({
      pageIds: [id], kind: 'import.notion.publish', actorId: ownerA,
      effect: {
        effectClass: 'local', operation: 'write-notion-body', pageId: id, notionPageId: 'notes',
        bodyHtmlSha256: createHash('sha256').update(bodyHtml).digest('hex'),
        bodyTextSha256: createHash('sha256').update(bodyText).digest('hex'),
        bodyHtmlBytes: Buffer.byteLength(bodyHtml), bodyTextBytes: Buffer.byteLength(bodyText), hierarchyComponent: false,
      },
    });
    try {
      expect((await query('SELECT status,effect_started_at FROM page_write_intents WHERE id=$1', [held.id])).rows[0])
        .toMatchObject({ status: 'pending', effect_started_at: null });
      expect((await toConfluence(id)).statusCode).toBe(409);
      expect(await row(id)).toEqual(original);
      expect(h.client.createPage).not.toHaveBeenCalled();
    } finally {
      await cancelPageWriteIntentBeforeEffect(held);
    }
  });

  it('[PASS I3 reverse] import overwrite cannot bypass a committed relocation intent', async () => {
    const id = await successfulImport(ownerA);
    const original = await row(id);
    const entered = deferred();
    const release = deferred();
    h.client.createPage.mockImplementation(async (_space: string, title: string, storage: string) => {
      entered.release();
      await release.promise;
      const result = providerPage('910003', title, storage);
      h.documents.set('910003', result);
      return result;
    });
    const pending = toConfluence(id);
    try {
      await entered.promise;
      const held = await intent(id);
      expect(held.status).toBe('pending');
      expect(await preparation(held.id)).toBeDefined();
      const item = await importNotes(ownerA, true);
      expect(item.status).toBe('fail');
      expect(await row(id)).toEqual(original);
      expect((await intent(id)).id).toBe(held.id);
    } finally {
      release.release();
      await pending;
    }
  });

  it('[PASS U02] never deletes an acknowledged create whose generated identifier clashes', async () => {
    const id = await page({ source: 'standalone' });
    await page({ source: 'standalone', title: 'Alias target' });
    const alias = await page({ source: 'standalone' });
    h.client.createPage.mockImplementation(async (_space: string, title: string, storage: string) => {
      const result = providerPage(String(alias), title, storage);
      h.documents.set(String(alias), result);
      return result;
    });
    const before = await row(id);
    expect((await toConfluence(id)).statusCode).toBe(409);
    expect(await row(id)).toEqual(before);
    const held = await intent(id);
    expect(held.status).toBe('pending');
    expect((await preparation(held.id))?.created_confluence_id).toBe(String(alias));
    expect(h.client.createPage).toHaveBeenCalledTimes(1);
    expect(h.client.deletePage).not.toHaveBeenCalled();
  });
});

interface ControlledProviderPage {
  id: string;
  title: string;
  status: string;
  type: string;
  version: { number: number; when: string };
  body: { storage: { value: string } };
}

interface HeldDatabaseLock {
  client: PoolClient;
  pid: number;
}

async function retainedPublication(direction: 'local' | 'confluence') {
  const toRemote = direction === 'confluence';
  const confluenceId = toRemote ? undefined : '730001';
  const id = await page({
    source: toRemote ? 'standalone' : 'confluence', confluenceId,
    body: '<p>publication <img src="TEMP_ATTACHMENT/pic.png"></p>',
  });
  const oldKey = confluenceId ?? String(id);
  await query('UPDATE pages SET body_html=replace(body_html,$2,$3) WHERE id=$1',
    [id, 'TEMP_ATTACHMENT', `/api/attachments/${oldKey}`]);
  const directory = path.join(attachmentsRoot, oldKey);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'pic.png'), 'publication bytes');
  h.files.set(`/download/attachments/${oldKey}/pic.png`, Buffer.from('publication bytes'));
  await fs.chmod(directory, 0o500);
  try {
    expect((await (toRemote ? toConfluence(id) : toLocal(id, oldKey))).statusCode).toBe(500);
  } finally {
    await fs.chmod(directory, 0o700);
  }
  const held = await intent(id);
  expect(held).toMatchObject({ status: 'pending', remote_effects_completed_at: expect.any(String) });
  expect(await preparation(held.id)).toBeDefined();
  if (toRemote) {
    // Actual create/upload receipts are durable; failed old-cache cleanup
    // rolled back SQL publication. This is its reachable committed-before-
    // settlement fixture, with page/revisions changed in ONE real transaction.
    // The independent NULL companion must pass the original verifier.
    const createdId = String((await preparation(held.id))!.created_confluence_id);
    const document = h.documents.get(createdId);
    if (!document) throw new Error('The acknowledged create must have a provider document');
    const storage = document.body.storage.value;
    const html = confluenceToHtml(storage, createdId, 'CONF');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE pages SET source='confluence',confluence_id=$2,space_key='CONF',visibility='shared',
          title=$3,body_storage=$4,body_html=$5,body_text=$6,version=1,last_synced=NOW(),
          embedding_dirty=TRUE,image_analysis_dirty=TRUE,embedding_status='not_embedded',embedded_at=NULL
          WHERE id=$1`, [id, createdId, document.title, storage, html, htmlToText(html)],
      );
      await client.query(
        `UPDATE page_write_intents SET revisions=jsonb_build_object(p.id::text,jsonb_build_object(
          'contentRevision',p.content_revision::text,'lifecycleRevision',p.lifecycle_revision::text))
          FROM pages p WHERE page_write_intents.id=$1 AND p.id=$2`, [held.id, id],
      );
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  await retired(held.id);
  return { id, held };
}

describe('1774 published evidence and safe failure boundaries', () => {
  for (const direction of ['local', 'confluence'] as const) {
    it(`[PASS P01] valid NULL ${direction} publication reconciles applied`, async () => {
      const { id, held } = await retainedPublication(direction);
      expect((await row(id)).notion_page_id).toBeNull();
      expect(await recover(held.id)).toEqual({ intentId: held.id, status: 'reconciled_applied' });
      expect(await preparation(held.id)).toBeUndefined();
    });

    it(`[RED R09/P02] ONLY a nonNULL token rejects otherwise valid ${direction} publication`, async () => {
      const { id, held } = await retainedPublication(direction);
      await query('UPDATE pages SET notion_page_id=$2 WHERE id=$1', [id, 'unexpected-identity']);
      const safe = await row(id);
      const progress = await preparation(held.id);
      const beforeCapacity = await capacity();
      await expect(recover(held.id)).rejects.toMatchObject({ reason: 'intent_terminal_evidence_mismatch' });
      expect((await intent(id)).status).toBe('pending');
      expect(await row(id)).toEqual(safe);
      expect(await preparation(held.id)).toEqual(progress);
      expect(await capacity()).toEqual(beforeCapacity);
    });
  }

  it.each([null, LEGACY_TOKEN])('[PASS C02/post-effect23505] original recovery preserves CURRENT grants and token %s', async (token) => {
    const id = await page({ confluenceId: '730002', notion: token });
    await page({ source: 'standalone', owner: ownerB, title: 'Unrelated destination identity' });
    // A real unrelated uniqueness violation in the admitted source-changing
    // UPDATE remains a failure even after notion_page_id is correctly cleared.
    await query("CREATE UNIQUE INDEX test_1774_posteffect_identity ON pages (created_by_user_id) WHERE source='standalone'");
    actor = ownerB;
    const original = await row(id);
    try {
      const failed = await toLocal(id, '730002');
      expect(failed.statusCode).toBe(500);
      const held = await intent(id);
      expect(held).toMatchObject({ status: 'pending', effect_started_at: expect.any(String), remote_effect_started_at: null });
      expect(h.client.deletePage).not.toHaveBeenCalled();
      expect((await edit(id, ownerB)).statusCode).toBe(409);
      await query("INSERT INTO access_control_entries (resource_type,resource_id,principal_type,principal_id,permission) VALUES ('page',$1,'user',$2,'read')", [id, ownerB]);
      const currentAces = await aces(id);
      await query('UPDATE user_settings SET confluence_enabled=TRUE WHERE user_id=$1', [ownerB]);
      await retired(held.id);
      expect(await recover(held.id)).toEqual({ intentId: held.id, status: 'reconciled_not_applied' });
      expect(await row(id)).toEqual(original);
      expect(await aces(id)).toEqual(currentAces);
    } finally {
      await query('DROP INDEX test_1774_posteffect_identity');
    }
  });

  it('[RED R03 / PASS N02] owns the token before cutover, then releases without later standalone compensation', async () => {
    const id = await successfulImport(ownerA);
    const entered = deferred();
    const release = deferred();
    h.client.createPage.mockImplementation(async (_space: string, title: string, storage: string) => {
      entered.release();
      await release.promise;
      const result = providerPage('910004', title, storage);
      h.documents.set('910004', result);
      return result;
    });
    const pending = toConfluence(id);
    let lock: HeldDatabaseLock | undefined;
    let competing: Promise<unknown> | undefined;
    try {
      await entered.promise;
      lock = await holder(PAGE_MOVE_ADVISORY_LOCK_ID);
      release.release();
      await blockedBy(lock.pid);
      expect(await row(id)).toMatchObject({ source: 'standalone', notion_page_id: 'notes' });
      await expect(query(
        `INSERT INTO pages (title,source,version,visibility,created_by_user_id,notion_page_id)
         VALUES ('Duplicate before cutover','standalone',1,'private',$1,'notes')`, [ownerA],
      )).rejects.toMatchObject({ code: '23505' });
      competing = importNotes(ownerA);
      // Do not await an importer behind the publisher's lifecycle lock while
      // holding move: that would manufacture a test deadlock.
      await lock.client.query('COMMIT');
      expect((await pending).statusCode).toBe(200);
      await competing;
      const item = await importNotes(ownerA);
      expect(item.status).not.toBe('fail');
      expect(item.localPageId).not.toBe(id);
      expect(h.client.deletePage).not.toHaveBeenCalled();
    } finally {
      release.release();
      if (lock) await closeHolder(lock.client);
      await pending;
      if (competing) await competing;
    }
  });
});

describe('existing compensation lock order', () => {
  it('[PASS C06/ACE order] compensation waits on the ACL relation before taking the root row', async () => {
    const id = await page({ confluenceId: '710040', notion: LEGACY_TOKEN });
    const entered = deferred();
    const release = deferred();
    h.client.deletePage.mockImplementation(async () => {
      entered.release();
      await release.promise;
      throw new Error('controlled live deletion refusal after the cutover');
    });
    const pending = toLocal(id, '710040');
    let blocker: PoolClient | undefined;
    try {
      await entered.promise;
      const held = await intent(id);
      const safeCutover = await row(id);
      const safePreparation = await preparation(held.id);
      const safeCapacity = await capacity();
      blocker = await getPool().connect();
      await blocker.query('BEGIN');
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await blocker.query(
        "INSERT INTO access_control_entries (resource_type,resource_id,principal_type,principal_id,permission) VALUES ('page',$1,'user',$2,'read')",
        [id, ownerB],
      );
      release.release();
      // Positive wait observation, not a sleep: the uncommitted grant holds
      // RowExclusive on ACE; compensation requests its existing table lock.
      await blockedBy(pid, 'LOCK TABLE access_control_entries');
      // This finishes only if compensation has not already locked the root.
      // A root-first implementation creates a real PostgreSQL deadlock here.
      await blocker.query('UPDATE pages SET title=title WHERE id=$1', [id]);
      await blocker.query('COMMIT');
      blocker.release();
      blocker = undefined;
      const response = await pending;
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ reason: 'intent_local_evidence_mismatch' });
      expect(await row(id)).toEqual(safeCutover);
      expect(await preparation(held.id)).toEqual(safePreparation);
      expect(await aces(id)).toHaveLength(1);
      expect(await intent(id)).toMatchObject({
        status: 'pending', remote_terminal_result: { outcome: 'live' },
      });
      expect(await capacity()).toEqual(safeCapacity);
      expect(h.client.deletePage).toHaveBeenCalled();
    } finally {
      release.release();
      if (blocker) await closeHolder(blocker);
      await pending;
    }
  });
});
