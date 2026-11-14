import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { createClient, type RedisClientType } from 'redis';
import { createHash, randomUUID } from 'node:crypto';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables, waitForDatabaseCondition } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { getPool, query } from '../../core/db/postgres.js';
import { PAGE_HIERARCHY_LOCK_ID } from '../../core/db/advisory-locks.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { encryptPat } from '../../core/utils/crypto.js';
import { userHasGlobalPermission } from '../../core/services/rbac-service.js';
import { cancelPageWriteIntentBeforeEffect, reservePageWriteIntent } from '../../core/services/page-write-admission.js';
import { runNotionImport } from '../../domains/knowledge/services/notion-import-service.js';
import { NotionClient, setNotionApiBaseUrlForTests } from '../../domains/knowledge/services/notion-client.js';
import { startFakeNotionServer, type FakeNotionServer } from '../../domains/knowledge/services/__fixtures__/fake-notion-server.js';
import { buildKnowledgeTestApp, holdOtherEmbeddingLease } from './pages.test-helpers.js';
import { pagesCrudRoutes } from './pages-crud.js';
import { notionRoutes } from './notion.js';

const TOKEN = '1774-identity-controlled-notion';
const PARKED_PK = 2000000000;
const OLD_STAMP = '2026-09-01T12:34:56.123456Z';
let app: FastifyInstance;
let redis: RedisClientType;
let server: FakeNotionServer;
let actor: string;
let owner: string;
let other: string;

interface TreeNode {
  id: string;
  type: string;
  alreadyImported?: boolean;
  localPageId?: number;
  children: TreeNode[];
}

function nodeById(nodes: readonly TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = nodeById(node.children, id);
    if (nested) return nested;
  }
  return undefined;
}

async function insertUser(label: string) {
  const result = await query<{ id: string }>(
    "INSERT INTO users (username,password_hash,role) VALUES ($1,'test-only','admin') RETURNING id",
    [`${label}-${randomUUID()}`],
  );
  const id = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id,notion_integration_token,confluence_enabled) VALUES ($1,$2,FALSE)',
    [id, encryptPat(TOKEN)]);
  return id;
}

async function seed(options: {
  source?: 'standalone' | 'confluence'; owner?: string; token?: string | null;
  parent?: string | null; confluenceId?: string | null; deleted?: boolean;
  title?: string; visibility?: 'private' | 'shared';
} = {}) {
  return (await query<{ id: number }>(
    `INSERT INTO pages (title,source,space_key,created_by_user_id,visibility,
       notion_page_id,confluence_id,parent_id,deleted_at,body_html,body_text,version,ai_policy)
     VALUES ($1,$2,'LOCAL',$3,$4,$5,$6,$7,$8::timestamptz,'<p>original content</p>','original content',1,'none')
     RETURNING id`,
    [options.title ?? 'Original content', options.source ?? 'standalone', options.owner ?? owner,
      options.visibility ?? 'private', options.token ?? null, options.confluenceId ?? null,
      options.parent ?? null, options.deleted ? OLD_STAMP : null],
  )).rows[0]!.id;
}

async function states(ids: readonly number[]) {
  return (await query<{ value: Record<string, unknown> }>(
    'SELECT to_jsonb(p) AS value FROM pages p WHERE id=ANY($1::integer[]) ORDER BY id', [ids],
  )).rows.map((row) => row.value);
}

async function capacity() {
  return (await query('SELECT to_jsonb(c) AS value FROM page_baseline_capacity c ORDER BY to_jsonb(c)::text')).rows;
}

async function importItem(id = 'notes') {
  const items = await runNotionImport({
    userId: owner, client: new NotionClient(TOKEN), pageIds: [id],
    spaceKey: 'LOCAL', visibility: 'private', databaseModes: { crm: 'table' },
  });
  return items.find((item) => item.notionPageId === id)!;
}

async function getTree() {
  const response = await app.inject({ method: 'GET', url: '/api/notion/tree' });
  expect(response.statusCode).toBe(200);
  expect(response.body).not.toContain(TOKEN);
  return response.json<{ nodes: TreeNode[] }>();
}

function restore(id: number) {
  return app.inject({ method: 'POST', url: `/api/pages/${id}/restore` }).then((response) => response);
}

async function trash(id: number) {
  const response = await app.inject({ method: 'DELETE', url: `/api/pages/${id}` });
  expect(response.statusCode).toBe(200);
}

async function waitBlockedBy(blocker: number, shape: string) {
  let waiting = 0;
  expect(await waitForDatabaseCondition(async () => {
    const rows = await query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
         AND pid<>pg_backend_pid() AND $1::integer=ANY(pg_blocking_pids(pid))
         AND query ILIKE $2 ORDER BY pid LIMIT 1`, [blocker, `%${shape}%`],
    );
    waiting = rows.rows[0]?.pid ?? 0;
    return waiting !== 0;
  })).toBe(true);
  return waiting;
}

async function transaction() {
  const client = await getPool().connect();
  await client.query('BEGIN');
  const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  return { client, pid };
}

async function release(client: PoolClient) {
  try { await client.query('ROLLBACK'); } finally { client.release(); }
}

async function batch() {
  const root = await seed({ title: 'Batch root' });
  const child = await seed({ title: 'Imported child', parent: String(root), token: 'AB-CD' });
  await trash(root);
  return { root, child };
}

async function freeze(id: number) {
  const runtime = `1774-freeze-${randomUUID()}`;
  await query(
    'INSERT INTO page_writer_runtimes (runtime_id,deployment_identity,enforcement_version,ai_policy_enforcement_version) VALUES ($1,$2::jsonb,1,1)',
    [runtime, JSON.stringify({ fixture: 'published baseline' })],
  );
  const fixture = (await query<{ intent_id: string; baseline_id: string }>(
    `WITH ids AS (SELECT gen_random_uuid() AS intent_id,gen_random_uuid() AS baseline_id), inserted AS (
       INSERT INTO page_write_intents (id,runtime_id,kind,actor_id,page_ids,revisions,recovery_mode,
         effect,status,settled_at,settlement_reason,settlement_proof)
       SELECT ids.intent_id,$2,'baseline.prepare',$3,ARRAY[p.id],jsonb_build_object(p.id::text,
         jsonb_build_object('contentRevision',p.content_revision::text,'lifecycleRevision',p.lifecycle_revision::text)),
         'local_verified',jsonb_build_object('effectClass','local','baselineId',ids.baseline_id::text),
         'completed',NOW(),'effect_committed','{}'::jsonb FROM ids JOIN pages p ON p.id=$1
       RETURNING id,(effect->>'baselineId')::uuid AS baseline_id)
     SELECT id::text AS intent_id,baseline_id::text FROM inserted`, [id, runtime, owner],
  )).rows[0]!;
  await query(
    `INSERT INTO page_baselines (id,page_id,original_page_id,page_identity,version,content_revision,
       lifecycle_revision,manifest_digest,manifest,manifest_bytes,title,body_html,total_bytes,reserved_bytes,
       status,prepared_by_user_id,prepared_by_name,preparation_intent_id,published_by_user_id,
       published_by_name,published_at,provenance,freeze_reason)
     SELECT $2,p.id,p.id,'[]',p.version,p.content_revision,p.lifecycle_revision,$3,'[]',convert_to('[]','UTF8'),
       'FROZEN PRIVATE TITLE',p.body_html,0,0,'published',$4,'1774 fixture',$5,$4,'1774 fixture',NOW(),
       'manual_assertion','Existing refusal control' FROM pages p WHERE p.id=$1`,
    [id, fixture.baseline_id, '7'.repeat(64), owner, fixture.intent_id],
  );
  await query(
    `UPDATE pages SET baseline_id=$2,frozen_version=version,frozen_at=NOW(),frozen_by_user_id=$3,
       frozen_by_name='1774 fixture',freeze_reason='Existing refusal control',freeze_provenance='manual_assertion',
       freeze_reported_signatories='[]'::jsonb WHERE id=$1`, [id, fixture.baseline_id, owner],
  );
}

async function pendingPublication(id: number, notionPageId: string) {
  const html = '<p>held</p>';
  const text = 'held';
  return reservePageWriteIntent({
    pageIds: [id], kind: 'import.notion.publish', actorId: owner,
    effect: {
      effectClass: 'local', operation: 'write-notion-body', pageId: id, notionPageId,
      bodyHtmlSha256: createHash('sha256').update(html).digest('hex'),
      bodyTextSha256: createHash('sha256').update(text).digest('hex'),
      bodyHtmlBytes: Buffer.byteLength(html), bodyTextBytes: Buffer.byteLength(text), hierarchyComponent: false,
    },
  });
}

beforeAll(async () => {
  expect(await isDbAvailable(), 'Owned PostgreSQL must execute, never skip').toBe(true);
  expect(await isRedisAvailable(), 'Owned Redis must execute, never skip').toBe(true);
  await setupTestDb();
  redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false, connectTimeout: 1000 } });
  await redis.connect();
  setRedisClient(redis);
  const notionPage = (id: string, parent = 'workspace') => ({
    object: 'page', id,
    parent: parent === 'workspace' ? { type: 'workspace', workspace: true } : { type: 'page_id', page_id: parent },
    properties: { title: { type: 'title', title: [{ type: 'text', plain_text: id === 'notes' ? 'Notes' : id }] } },
  });
  server = await startFakeNotionServer({
    validToken: TOKEN,
    pages: { notes: notionPage('notes'), nested: notionPage('nested', 'notes'), abcd: notionPage('abcd') },
    databases: { crm: {
      object: 'database', id: 'crm', parent: { type: 'page_id', page_id: 'notes' },
      title: [{ type: 'text', plain_text: 'CRM' }], properties: { Name: { id: 'title', type: 'title', title: {} } },
    } },
    searchResults: [notionPage('notes'), notionPage('nested', 'notes'), notionPage('abcd'), {
      object: 'database', id: 'crm', parent: { type: 'page_id', page_id: 'notes' },
      title: [{ type: 'text', plain_text: 'CRM' }],
    }],
    databaseQueryResults: { crm: [] },
    blockChildren: Object.fromEntries(['notes', 'nested', 'abcd'].map((id) => [id, [{
      object: 'block', id: `${id}-body`, type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', plain_text: `remote ${id}`, text: { content: `remote ${id}` } }] },
    }]])),
  });
  setNotionApiBaseUrlForTests(server.baseUrl);
  app = await buildKnowledgeTestApp(() => actor, async (instance) => {
    instance.redis = redis;
    instance.addHook('preHandler', async (request) => {
      request.userRole = (await query<{ role: 'admin' | 'user' }>('SELECT role FROM users WHERE id=$1', [request.userId])).rows[0]!.role;
      request.userCan = (permission: string) => userHasGlobalPermission(request.userId, permission);
    });
    await instance.register(notionRoutes, { prefix: '/api' });
    await instance.register(pagesCrudRoutes, { prefix: '/api' });
  });
});

beforeEach(async () => {
  await truncateAllTables();
  await redis.flushDb();
  await holdOtherEmbeddingLease(redis);
  server.requests.length = 0;
  owner = await insertUser('identity-owner');
  other = await insertUser('identity-other');
  actor = owner;
  await query("INSERT INTO spaces (space_key,space_name,source) VALUES ('LOCAL','Local','local')");
});

afterAll(async () => {
  await app?.close();
  setNotionApiBaseUrlForTests(null);
  await server?.close();
  setRedisClient(null);
  if (redis?.isOpen) await redis.quit();
  await teardownTestDb();
});

describe('1774 public tree/import agreement — real PostgreSQL and Redis', () => {
  it.each(['notes', 'nested', 'crm'])('[RED R04b] cached %s marker follows current identity without rewriting metadata', async (id) => {
    const imported = await importItem(id);
    expect(imported.status).toBe('success');
    expect(nodeById((await getTree()).nodes, id)).toMatchObject({ alreadyImported: true, localPageId: imported.localPageId });
    const key = `kb:${owner}:notion_tree:workspace`;
    const cached = await redis.get(key);
    const searchCount = server.requests.filter((request) => request.url.includes('/v1/search')).length;
    await query('UPDATE pages SET notion_page_id=NULL WHERE id=$1', [imported.localPageId]);
    const marker = nodeById((await getTree()).nodes, id)!;
    // SAME literal public GET oracle on original and preserving extraction.
    expect(marker.alreadyImported).toBe(false);
    expect(marker.localPageId).toBeUndefined();
    expect(await redis.get(key)).toBe(cached);
    expect(server.requests.filter((request) => request.url.includes('/v1/search'))).toHaveLength(searchCount);
    const fresh = await importItem(id);
    expect(fresh.status).toBe('success');
    expect(fresh.localPageId).not.toBe(imported.localPageId);
    expect(nodeById((await getTree()).nodes, id)).toMatchObject({ alreadyImported: true, localPageId: fresh.localPageId });
  });

  it.each(['notes', 'nested', 'crm'])('[RED R02] a stray Confluence %s token is not an imported marker', async (id) => {
    await seed({ source: 'confluence', confluenceId: `cf-${id}`, token: id });
    const marker = nodeById((await getTree()).nodes, id)!;
    expect(marker.alreadyImported).toBe(false);
    expect(marker.localPageId).toBeUndefined();
  });

  it('[RED R03] real import ignores a non-import Confluence row without altering that row', async () => {
    const decoy = await seed({ source: 'confluence', confluenceId: '999999999999', token: 'NO-TeS' });
    const before = await states([decoy]);
    const item = await importItem();
    expect(item.status).toBe('success');
    expect(item.localPageId).not.toBe(decoy);
    expect(await states([decoy])).toEqual(before);
    expect(nodeById((await getTree()).nodes, 'notes')).toMatchObject({ alreadyImported: true, localPageId: item.localPageId });
  });

  it('[PASS owner/auth] never reports another owner private import or returns a cached tree without a token', async () => {
    const privatePage = await seed({ owner: other, token: 'notes', title: 'OTHER OWNER PRIVATE BODY' });
    const response = await getTree();
    const marker = nodeById(response.nodes, 'notes')!;
    expect(marker.alreadyImported).not.toBe(true);
    expect(marker.localPageId).toBeUndefined();
    expect(marker.localPageId).not.toBe(privatePage);
    expect(JSON.stringify(response)).not.toContain('OTHER OWNER PRIVATE BODY');
    await query('UPDATE user_settings SET notion_integration_token=NULL WHERE user_id=$1', [owner]);
    const missingToken = await app.inject({ method: 'GET', url: '/api/notion/tree' });
    expect(missingToken.statusCode).toBe(400);
    expect(missingToken.body).not.toContain('OTHER OWNER PRIVATE BODY');
    expect(missingToken.body).not.toContain(TOKEN);
  });

  it('[RED live-read safety] a primed cache cannot fabricate an authoritative marker when PG read fails', async () => {
    expect((await importItem()).status).toBe('success');
    await getTree();
    const cached = await redis.get(`kb:${owner}:notion_tree:workspace`);
    // Actual relation lookup failure, not a mocked query or fake pg error.
    await query('ALTER TABLE pages RENAME TO test_1774_unavailable_pages');
    try {
      const failed = await app.inject({ method: 'GET', url: '/api/notion/tree' });
      expect(failed.statusCode).toBe(500);
      expect(await redis.get(`kb:${owner}:notion_tree:workspace`)).toBe(cached);
      expect(failed.body).not.toContain(TOKEN);
    } finally {
      await query('ALTER TABLE test_1774_unavailable_pages RENAME TO pages');
    }
  });

  for (const code of ['23505', '23514'] as const) {
    it(`[RED R12] actual ${code} yields a safe item reason without constraint names`, async () => {
      const name = code === '23505' ? 'test_1774_private_unique_name' : 'test_1774_private_check_name';
      if (code === '23505') {
        await seed({ owner: other, title: 'Notes' });
        await query(`CREATE UNIQUE INDEX test_1774_private_unique_name ON pages ((TRUE)) WHERE title='Notes'`);
      } else {
        await query("ALTER TABLE pages ADD CONSTRAINT test_1774_private_check_name CHECK (notion_page_id IS DISTINCT FROM 'notes') NOT VALID");
      }
      try {
        const item = await importItem();
        expect(item.status).toBe('fail');
        expect(item.reason).toBe(code === '23505'
          ? 'Import conflicts with existing content. Refresh and try again.'
          : 'Import could not be completed because the content changed. Refresh and try again.');
        expect(item.reason).not.toContain(name);
        expect(item.reason).not.toMatch(/duplicate key|violates|constraint|SQLSTATE/i);
        expect((await query("SELECT 1 FROM page_write_intents WHERE status='pending' AND kind LIKE 'import.notion.%'")).rowCount).toBe(0);
      } finally {
        if (code === '23505') await query('DROP INDEX test_1774_private_unique_name');
        else await query('ALTER TABLE pages DROP CONSTRAINT test_1774_private_check_name');
      }
    });
  }

  for (const finish of ['COMMIT', 'ROLLBACK'] as const) {
    it(`[PASS safe23505] placeholder allocation waits for a real unique-index owner ${finish}`, async () => {
      const held = await transaction();
      const winner = (await held.client.query<{ id: number }>(
        `INSERT INTO pages (title,source,space_key,created_by_user_id,visibility,notion_page_id,body_html,body_text,version)
         VALUES ('Concurrent complete import','standalone','LOCAL',$1,'private','notes','<p>racing content</p>','racing content',1)
         RETURNING id`, [owner],
      )).rows[0]!.id;
      const pending = importItem();
      try {
        await waitBlockedBy(held.pid, 'INSERT INTO pages');
        await held.client.query(finish);
        const item = await pending;
        expect(item.status).not.toBe('fail');
        if (finish === 'COMMIT') {
          expect(item).toMatchObject({ localPageId: winner, status: 'already_imported' });
          expect((await states([winner]))[0]!.body_html).toBe('<p>racing content</p>');
        } else {
          expect(item.status).toBe('success');
          expect(item.localPageId).not.toBe(winner);
        }
        expect((await query("SELECT id FROM pages WHERE source='standalone' AND created_by_user_id=$1 AND deleted_at IS NULL AND notion_page_id='notes'", [owner])).rowCount).toBe(1);
      } finally {
        await release(held.client);
        await pending;
      }
    });
  }
});

describe('1774 source-aware restore admission and authoritative batch', () => {
  it('[RED R13] a live same-owner Confluence decoy does not block root restore', async () => {
    const root = await seed({ token: 'AB-CD' });
    await trash(root);
    const decoy = await seed({ source: 'confluence', confluenceId: '9223372036854', token: 'abcd' });
    const untouched = await states([decoy]);
    expect((await restore(root)).statusCode).toBe(200);
    expect(await states([decoy])).toEqual(untouched);
  });

  it('[RED R15] a descendant Confluence decoy neither blocks nor mutates the exact batch', async () => {
    const { root, child } = await batch();
    const decoy = await seed({ source: 'confluence', confluenceId: '9223372036855', token: 'abcd' });
    const untouched = await states([decoy]);
    expect((await restore(root)).statusCode).toBe(200);
    expect((await states([root, child])).every((row) => row.deleted_at === null)).toBe(true);
    expect(await states([decoy])).toEqual(untouched);
  });

  it('[RED R14] descendant standalone clash refuses409 before any batch effect', async () => {
    const { root, child } = await batch();
    const live = await seed({ token: 'abcd', title: 'LIVE COPY MUST SURVIVE' });
    const before = await states([root, child, live]);
    const beforeCapacity = await capacity();
    await redis.set(`kb:${owner}:pages:1774-sentinel`, 'unchanged');
    const audits = (await query("SELECT COUNT(*)::text AS n FROM audit_log WHERE action='PAGE_RESTORED'")).rows;
    const response = await restore(root);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: 'restore_import_conflict' });
    expect(response.body).not.toContain('LIVE COPY MUST SURVIVE');
    expect(await states([root, child, live])).toEqual(before);
    expect(await capacity()).toEqual(beforeCapacity);
    expect(await redis.get(`kb:${owner}:pages:1774-sentinel`)).toBe('unchanged');
    expect((await query("SELECT COUNT(*)::text AS n FROM audit_log WHERE action='PAGE_RESTORED'")).rows).toEqual(audits);
  });

  it.each(['root', 'descendant'] as const)('[PASS root / RED descendant I4] import commits before %s restore admission', async (where) => {
    const { root, child } = await batch();
    if (where === 'root') await query('UPDATE pages SET notion_page_id=$2 WHERE id=$1', [root, 'root-token']);
    const ids = [root, child];
    const before = await states(ids);
    const held = await transaction();
    await held.client.query('SELECT pg_advisory_xact_lock_shared($1)', [PAGE_HIERARCHY_LOCK_ID]);
    await held.client.query(
      `INSERT INTO pages (title,source,space_key,created_by_user_id,visibility,notion_page_id,body_html,body_text,version)
       VALUES ('Concurrent import','standalone','LOCAL',$1,'private',$2,'<p>live import</p>','live import',1)`,
      [owner, where === 'root' ? 'ROOT-TOKEN' : 'abcd'],
    );
    const pending = restore(root);
    try {
      await waitBlockedBy(held.pid, 'pg_advisory_xact_lock');
      expect(await states(ids)).toEqual(before);
      await held.client.query('COMMIT');
      const response = await pending;
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ reason: 'restore_import_conflict' });
      expect(await states(ids)).toEqual(before);
    } finally {
      await release(held.client);
      await pending;
    }
  });

  it('[PASS I5] actual restore wins hierarchy, actual importer waits, and pre-effect23505 reconciles', async () => {
    const root = await seed({ token: 'notes' });
    await trash(root);
    const held = await transaction();
    await held.client.query('SELECT id FROM pages WHERE id=$1 FOR UPDATE', [root]);
    const restoring = restore(root);
    let importing: Promise<unknown> | undefined;
    try {
      const restorePid = await waitBlockedBy(held.pid, 'UPDATE pages%SET deleted_at');
      const pendingImport = importItem();
      importing = pendingImport;
      await waitBlockedBy(restorePid, 'pg_advisory_xact_lock');
      expect((await states([root]))[0]!.deleted_at).not.toBeNull();
      await held.client.query('COMMIT');
      expect((await restoring).statusCode).toBe(200);
      const imported = await pendingImport;
      expect(imported).toMatchObject({ localPageId: root, status: 'already_imported' });
      expect((await query("SELECT id FROM pages WHERE created_by_user_id=$1 AND source='standalone' AND notion_page_id='notes' AND deleted_at IS NULL", [owner])).rows).toEqual([{ id: root }]);
      expect((await query("SELECT id FROM page_write_intents WHERE status='pending' AND kind LIKE 'import.notion.%'")).rowCount).toBe(0);
    } finally {
      await release(held.client);
      await restoring;
      if (importing) await importing;
    }
  });

  it.each(['foreign-live', 'same-owner-trashed'] as const)('[PASS CF decoy] %s does not block ordinary batch restore', async (kind) => {
    const { root, child } = await batch();
    const decoy = await seed({
      source: 'confluence', token: 'abcd', confluenceId: '9223372036856',
      owner: kind === 'foreign-live' ? other : owner, deleted: kind === 'same-owner-trashed',
    });
    const untouched = await states([decoy]);
    expect((await restore(root)).statusCode).toBe(200);
    expect((await states([root, child])).every((row) => row.deleted_at === null)).toBe(true);
    expect(await states([decoy])).toEqual(untouched);
  });

  it('[PASS subtree] restore crosses old-trash/foreign/CF intermediates and uses standalone PK despite historical CF id', async () => {
    const root = await seed({ confluenceId: '999999999998', title: 'Source-aware root' });
    const oldIntermediate = await seed({ parent: String(root), deleted: true });
    const throughOld = await seed({ parent: String(oldIntermediate) });
    const foreign = await seed({ parent: String(root), owner: other, title: 'FOREIGN PRIVATE TITLE' });
    const throughForeign = await seed({ parent: String(foreign), visibility: 'shared' });
    const confluence = await seed({ source: 'confluence', confluenceId: '999999999997', parent: String(root) });
    const throughConfluence = await seed({ parent: '999999999997' });
    const wrongKey = await seed({ parent: '999999999998' });
    const untouchedIds = [oldIntermediate, foreign, confluence, wrongKey];
    const untouched = await states(untouchedIds);
    await trash(root);
    const eligible = [root, throughOld, throughForeign, throughConfluence];
    const trashed = await states(eligible);
    expect(new Set(trashed.map((row) => row.deleted_at)).size).toBe(1);
    expect(await states(untouchedIds)).toEqual(untouched);
    expect((await restore(root)).statusCode).toBe(200);
    expect((await states(eligible)).every((row) => row.deleted_at === null)).toBe(true);
    expect(await states(untouchedIds)).toEqual(untouched);
    const audit = (await query<{ metadata: { restoredCount: number } }>(
      "SELECT metadata FROM audit_log WHERE action='PAGE_RESTORED' AND resource_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [String(root)],
    )).rows[0]!;
    expect(audit.metadata.restoredCount).toBe(eligible.length);
  });

  it('[PASS UNION] cyclic delete terminates once per row and restore keeps actionable-parent refusal', async () => {
    const root = await seed();
    const child = await seed({ parent: String(root) });
    await query('UPDATE pages SET parent_id=$2 WHERE id=$1', [root, String(child)]);
    await trash(root);
    const before = await states([root, child]);
    expect(before.every((row) => row.deleted_at !== null)).toBe(true);
    const response = await restore(root);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: 'restore_ancestor_trashed' });
    expect(await states([root, child])).toEqual(before);
  });

  it('[PASS auth/refusals] missing/source/nonowner/live-noop retain original precedence and non-disclosure', async () => {
    expect((await restore(PARKED_PK + 1)).statusCode).toBe(404);
    const foreign = await seed({ owner: other, deleted: true, title: 'SECRET FOREIGN ROOT' });
    expect((await restore(foreign)).statusCode).toBe(403);
    expect((await restore(foreign)).body).not.toContain('SECRET FOREIGN ROOT');
    const confluence = await seed({ source: 'confluence', owner: other, deleted: true, confluenceId: '9223372036857' });
    expect((await restore(confluence)).statusCode).toBe(400);
    const live = await seed();
    expect((await restore(live)).json()).toMatchObject({ restored: false });
    expect((await query("SELECT 1 FROM audit_log WHERE action='PAGE_RESTORED'")).rowCount).toBe(0);
  });

  it('[PASS ancestor ordering] own trash parent precedes root import clash; foreign trash parent remains untouched', async () => {
    const parent = await seed({ title: 'Own parent' });
    const root = await seed({ parent: String(parent), token: 'abcd' });
    await trash(parent);
    await seed({ token: 'AB-CD' });
    const before = await states([parent, root]);
    const refused = await restore(root);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: 'restore_ancestor_trashed' });
    expect(await states([parent, root])).toEqual(before);
    const foreignParent = await seed({ owner: other, deleted: true, title: 'SECRET TRASH PARENT' });
    const ownRoot = await seed({ parent: String(foreignParent), deleted: true });
    const foreignBefore = await states([foreignParent]);
    expect((await restore(ownRoot)).statusCode).toBe(200);
    expect(await states([foreignParent])).toEqual(foreignBefore);
  });

  it('[PASS parent ambiguity ordering] never chooses an identifier winner or exposes candidate titles', async () => {
    await query(
      `INSERT INTO pages (id,title,source,space_key,created_by_user_id,visibility,body_html,body_text,version)
       VALUES ($1,'SECRET PK PARENT','standalone','LOCAL',$2,'private','<p>x</p>','x',1)`, [PARKED_PK, owner],
    );
    await seed({ source: 'confluence', confluenceId: String(PARKED_PK), title: 'SECRET CF PARENT' });
    const root = await seed({ parent: String(PARKED_PK), deleted: true, token: 'abcd' });
    await seed({ token: 'AB-CD' });
    const before = await states([root]);
    const response = await restore(root);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: 'restore_parent_ambiguous' });
    expect(response.body).not.toMatch(/SECRET PK PARENT|SECRET CF PARENT|2000000000/);
    expect(await states([root])).toEqual(before);
  });

  it.each(['root-import-first', 'subtree-ambiguity-first', 'root-frozen', 'descendant-frozen', 'pending-descendant'] as const)(
    '[PASS refusal ordering] %s is preserved before bounded descendant clash admission',
    async (kind) => {
      const { root, child } = await batch();
      const observedIds = [root, child];
      await seed({ token: 'abcd' });
      if (kind === 'root-import-first') {
        await query('UPDATE pages SET notion_page_id=$2 WHERE id=$1', [root, 'root-token']);
        await seed({ token: 'ROOT-TOKEN' });
        await freeze(root);
      } else if (kind === 'subtree-ambiguity-first') {
        // A colliding leaf key is safe until a child actually stores that key.
        observedIds.push(await seed({ parent: String(child), deleted: true }));
        await seed({ source: 'confluence', confluenceId: String(child), title: 'SECRET AMBIGUOUS ALIAS' });
      } else if (kind === 'root-frozen') {
        await freeze(root);
      } else if (kind === 'descendant-frozen') {
        await freeze(child);
      }
      const pending = kind === 'pending-descendant' ? await pendingPublication(child, 'abcd') : undefined;
      const before = await states(observedIds);
      try {
        const response = await restore(root);
        expect(response.statusCode).toBe(kind === 'root-frozen' ? 423 : 409);
        const expected = kind === 'root-import-first' ? 'restore_import_conflict'
          : kind === 'subtree-ambiguity-first' ? 'subtree_identifier_ambiguous'
            : kind === 'root-frozen' ? 'page_is_frozen'
              : kind === 'pending-descendant' ? 'page_write_busy' : 'subtree_contains_frozen_page';
        expect(response.json()).toMatchObject({ reason: expected });
        expect(response.body).not.toMatch(/SECRET AMBIGUOUS ALIAS|FROZEN PRIVATE TITLE/);
        expect(await states(observedIds)).toEqual(before);
      } finally {
        if (pending) await cancelPageWriteIntentBeforeEffect(pending);
      }
    },
  );

  it('[PASS live-parent pending] parent hierarchy intent precedes child root-clash disclosure', async () => {
    const parent = await seed();
    const root = await seed({ parent: String(parent), deleted: true, token: 'abcd' });
    await seed({ token: 'AB-CD' });
    const held = await reservePageWriteIntent({
      pageIds: [parent, root], kind: 'page.relocate', actorId: owner,
      effect: {
        effectClass: 'remote', pageId: parent, target: 'confluence', fromSource: 'standalone',
        fromConfluenceId: null, fromSpaceKey: 'LOCAL', targetSpaceKey: 'CONF', affectedPageIds: [parent, root],
      },
    });
    try {
      const response = await restore(root);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ reason: 'page_write_busy' });
    } finally {
      await cancelPageWriteIntentBeforeEffect(held);
    }
  });
});
