import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type * as Undici from 'undici';
import { createClient, type RedisClientType } from 'redis';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../../test-db-helper.js';
import { isRedisAvailable } from '../../../../test-redis-helper.js';
import { getPool, query, runMigrations } from '../../postgres.js';
import { setRedisClient } from '../../../services/redis-cache.js';
import { encryptPat } from '../../../utils/crypto.js';
import { userHasGlobalPermission } from '../../../services/rbac-service.js';
import { confluenceToHtml, htmlToText } from '../../../services/content-converter.js';
import {
  admitPageRuntime,
  advancePageWriteIntent,
  fencePageWriterRuntime,
  getPageWriterRuntimeId,
  quiescePageWriterRuntime,
  reconcilePageWriteIntent,
  reservePageWriteIntent,
  runPageWriteIntentEffect,
  withAiPolicyWriteTransaction,
  type PageWriteIntent,
} from '../../../services/page-write-admission.js';
import { ConfluenceClient } from '../../../../domains/confluence/services/confluence-client.js';
import { registerPageRelocateReconciler } from '../../../../domains/knowledge/services/page-relocate-service.js';
import { runNotionImport } from '../../../../domains/knowledge/services/notion-import-service.js';
import { NotionClient, setNotionApiBaseUrlForTests } from '../../../../domains/knowledge/services/notion-client.js';
import { startFakeNotionServer, type FakeNotionServer } from '../../../../domains/knowledge/services/__fixtures__/fake-notion-server.js';
import { buildKnowledgeTestApp, expectNoEmbeddingLeaseLeak, holdOtherEmbeddingLease } from '../../../../routes/knowledge/pages.test-helpers.js';
import { pagesCrudRoutes } from '../../../../routes/knowledge/pages-crud.js';
import { notionRoutes } from '../../../../routes/knowledge/notion.js';

interface ProviderPage {
  id: string;
  title: string;
  status: string;
  type: string;
  version: { number: number; when: string };
  body: { storage: { value: string } };
}

const h = vi.hoisted(() => {
  process.env.CONFLUENCE_RATE_LIMIT_RPM = '100000';
  return {
    documents: new Map<string, ProviderPage>(),
    failures: new Map<string, Error>(),
    gone: new Set<string>(),
    deletions: [] as string[],
    creations: 0,
    nextId: '990000000001',
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
      if (method === 'POST' && parsed.pathname === '/rest/api/content') {
        const body = z.object({
          title: z.string(), body: z.object({ storage: z.object({ value: z.string() }) }),
        }).parse(JSON.parse(String(options.body)));
        const result: ProviderPage = {
          id: h.nextId, title: body.title, status: 'current', type: 'page',
          version: { number: 1, when: '' }, body: { storage: { value: body.body.storage.value } },
        };
        h.documents.set(result.id, result);
        h.creations++;
        return { statusCode: 200, headers: {}, body: { text: async () => JSON.stringify(result) } };
      }
      if (method === 'DELETE' && page) {
        h.deletions.push(page[1]!);
        const failure = h.failures.get(page[1]!);
        if (failure) throw failure;
        h.gone.add(page[1]!);
        return { statusCode: 204, headers: {}, body: { text: async () => '' } };
      }
      if (method === 'GET' && inventory) {
        return { statusCode: 200, headers: {}, body: { text: async () => JSON.stringify({ results: [], start: 0, limit: 100, size: 0, _links: {} }) } };
      }
      if (method === 'GET' && page) {
        const value = h.documents.get(page[1]!);
        if (!value || h.gone.has(page[1]!)) {
          return { statusCode: 404, headers: {}, body: { text: async () => '{"message":"Resource not found"}' } };
        }
        return { statusCode: 200, headers: {}, body: { text: async () => JSON.stringify(value) } };
      }
      throw new Error(`Unexpected controlled provider request ${method} ${parsed.pathname}`);
    }),
  };
});

const MIGRATION = '152_relocation_notion_identity.sql';
const UPGRADE_RETIREMENT = '151b_page_writer_upgrade_retirement.sql';
const TOKEN = '1774-upgrade-controlled-notion';
const STORAGE = '<p>fixture body</p>';
const OLD_STAMP = '2026-08-09T10:11:12.123456Z';
const ORIGINAL_FIELDS = [
  'source', 'confluence_id', 'space_key', 'title', 'body_html', 'body_storage', 'body_text',
  'version', 'visibility', 'created_by_user_id', 'inherit_perms', 'local_modified_at',
  'local_modified_by', 'embedding_dirty', 'image_analysis_dirty', 'embedding_status', 'embedded_at',
] as const;

const PageSchema = z.object({
  id: z.number().int().positive(), title: z.string(), source: z.enum(['standalone', 'confluence']),
  confluence_id: z.string().nullable(), space_key: z.string().nullable(),
  body_html: z.string().nullable(), body_storage: z.string().nullable(), body_text: z.string().nullable(),
  version: z.number().int(), visibility: z.enum(['private', 'shared']),
  created_by_user_id: z.string().nullable(), inherit_perms: z.boolean(),
  local_modified_at: z.string().nullable(), local_modified_by: z.string().nullable(),
  embedding_dirty: z.boolean(), image_analysis_dirty: z.boolean(),
  embedding_status: z.string().nullable(), embedded_at: z.string().nullable(),
  notion_page_id: z.string().nullable(), ai_policy: z.enum(['all', 'local_only', 'none']),
  ai_policy_revision: z.number().int(),
}).passthrough();
type PageSnapshot = z.infer<typeof PageSchema>;

interface RetainedFixture {
  name: string;
  pageId: number;
  intentId: string;
  actorId: string;
  original: PageSnapshot;
  childIds: number[];
  originalChildren: PageSnapshot[];
  currentChildren: PageSnapshot[];
  currentAces: Record<string, unknown>[];
}

let app: FastifyInstance;
let redis: RedisClientType;
let server: FakeNotionServer;
let attachmentRoot: string;
let previousAttachmentRoot: string | undefined;
let ownerA: string;
let ownerB: string;
let administrator: string;
let actor: string;
let repairLive: number;
let repairTrash: number;
let standaloneLive: number;
let standaloneTrash: number;
let primedCache: string | null;
let initialSearches: number;
let beforeCapacity: unknown[];
let beforePages: PageSnapshot[];
let beforePreparations: Record<string, unknown>[];
let beforeIntents: unknown[];
const fixtures = new Map<string, RetainedFixture>();

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function snapshot(id: number) {
  const result = await query<{ value: unknown }>('SELECT to_jsonb(p) AS value FROM pages p WHERE id=$1', [id]);
  return PageSchema.parse(result.rows[0]!.value);
}

function authored(value: PageSnapshot) {
  const { content_revision, lifecycle_revision, updated_at, ...fields } = value;
  void content_revision;
  void lifecycle_revision;
  void updated_at;
  return fields;
}
async function rollbackExpected(fixture: RetainedFixture) {
  const expected: Record<string, unknown> = authored(await snapshot(fixture.pageId));
  // Only these historical page fields and the token are rollback-authored.
  // Current derived caches, policy/revision and root parent are NOT guessed
  // historical snapshots and must survive compensation as they stand.
  for (const field of ORIGINAL_FIELDS) expected[field] = fixture.original[field];
  expected.notion_page_id = fixture.original.notion_page_id;
  return expected;
}


async function preparation(id: string) {
  return (await query<{ value: Record<string, unknown> }>(
    'SELECT to_jsonb(p) AS value FROM page_relocation_preparations p WHERE intent_id=$1', [id],
  )).rows[0]?.value;
}

async function aceRows(id: number) {
  return (await query<Record<string, unknown>>(
    `SELECT principal_type,principal_id,permission FROM access_control_entries
      WHERE resource_type='page' AND resource_id=$1 ORDER BY principal_type,principal_id,permission`, [id],
  )).rows;
}

async function capacity() {
  return (await query('SELECT to_jsonb(c) AS value FROM page_baseline_capacity c ORDER BY to_jsonb(c)::text')).rows;
}

async function insertUser(label: string) {
  const id = (await query<{ id: string }>(
    "INSERT INTO users (username,password_hash,role) VALUES ($1,'test-only','admin') RETURNING id",
    [`${label}-${randomUUID()}`],
  )).rows[0]!.id;
  await query(
    `INSERT INTO user_settings (user_id,confluence_url,confluence_pat,confluence_enabled,notion_integration_token)
     VALUES ($1,'https://confluence.test',$2,TRUE,$3)`, [id, encryptPat('1774-provider-pat'), encryptPat(TOKEN)],
  );
  return id;
}

async function seedPage(options: {
  title: string; source: 'standalone' | 'confluence'; token?: string | null;
  owner?: string | null; confluenceId?: string; parent?: string; deleted?: boolean;
}) {
  const id = (await query<{ id: number }>(
    `INSERT INTO pages (title,source,confluence_id,space_key,created_by_user_id,visibility,
       notion_page_id,parent_id,deleted_at,body_html,body_storage,body_text,version,ai_policy,ai_policy_revision,
       expected_image_files,expected_drawio_files)
     VALUES ($1,$2,$3,$4,$5,'shared',$6,$7,$8::timestamptz,$9,$9,'fixture body',1,'none',7,
       NULL,NULL) RETURNING id`,
    [options.title, options.source, options.confluenceId ?? null,
      options.source === 'confluence' ? 'CONF' : 'LOCAL', options.owner === undefined ? ownerA : options.owner, options.token ?? null,
      options.parent ?? null, options.deleted ? OLD_STAMP : null, STORAGE],
  )).rows[0]!.id;
  if (options.confluenceId) {
    h.documents.set(options.confluenceId, {
      id: options.confluenceId, title: options.title, status: 'current', type: 'page',
      version: { number: 1, when: '' }, body: { storage: { value: STORAGE } },
    });
  }
  return id;
}

async function oldSchema() {
  // Never read/import the absent future migration. Both heads use their REAL
  // original runner; on origin it simply has no new file and resolves normally.
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE page_relocation_preparations DROP COLUMN IF EXISTS original_notion_page_id');
    await client.query('DROP INDEX IF EXISTS pages_notion_page_id_owner_live_uidx');
    await client.query(`CREATE UNIQUE INDEX pages_notion_page_id_owner_live_uidx ON pages
      (created_by_user_id,(lower(replace(notion_page_id,'-',''))))
      WHERE notion_page_id IS NOT NULL AND deleted_at IS NULL`);
    await client.query('DELETE FROM _migrations WHERE name=$1', [MIGRATION]);
    // #2063: also rebuild the pre-151b state, so the real 151b -> 152 order is
    // exercised instead of only the guard.
    await client.query('ALTER TABLE page_writer_runtimes DROP CONSTRAINT IF EXISTS page_writer_runtimes_retirement_state_check');
    await client.query('ALTER TABLE page_writer_runtimes DROP COLUMN IF EXISTS upgrade_retired_at');
    await client.query('ALTER TABLE page_writer_runtimes DROP CONSTRAINT IF EXISTS page_writer_runtimes_check');
    await client.query(`ALTER TABLE page_writer_runtimes ADD CONSTRAINT page_writer_runtimes_check CHECK (
      (quiesced_at IS NULL AND quiescence_ack IS NULL)
      OR (quiesced_at IS NOT NULL AND quiescence_ack IS NOT NULL))`);
    await client.query('ALTER TABLE page_runtime_admissions DROP CONSTRAINT IF EXISTS page_runtime_admissions_release_kind_check');
    await client.query(`ALTER TABLE page_runtime_admissions ADD CONSTRAINT page_runtime_admissions_release_kind_check
      CHECK (release_kind IN ('clean_disconnect', 'runtime_fenced'))`);
    await client.query('DELETE FROM _migrations WHERE name=$1', [UPGRADE_RETIREMENT]);
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function createPreparation(input: {
  intentId: string; original: PageSnapshot; actorId: string;
  direction: 'to_local' | 'to_confluence'; childIds: number[];
}) {
  const originals = ORIGINAL_FIELDS.map((field) => `original_${field}`);
  const values: unknown[] = [
    input.intentId, input.original.id, input.direction, input.actorId,
    input.direction === 'to_local' ? 'LOCAL' : 'CONF', 'shared',
    ...ORIGINAL_FIELDS.map((field) => input.original[field]),
    input.original.source === 'confluence' ? input.original.confluence_id : String(input.original.id),
    input.childIds, JSON.stringify(await aceRows(input.original.id)), '[]',
    digest(input.original.title), digest(input.original.body_storage ?? ''), null,
  ];
  const columns = [
    'intent_id', 'page_id', 'direction', 'actor_id', 'target_space_key', 'target_visibility',
    ...originals, 'original_key', 'child_ids', 'access_control_entries', 'attachments',
    'expected_remote_title_sha256', 'expected_remote_body_storage_sha256', 'parent_confluence_id',
  ];
  // Identifiers are the CLOSED original schema list above, never caller data.
  await query(
    `INSERT INTO page_relocation_preparations (${columns.join(',')})
     VALUES (${values.map((_, index) => `$${index + 1}`).join(',')})`, values,
  );
}

async function legacyFixture(options: {
  name: string; token: string | null; direction?: 'to_local' | 'to_confluence';
  phase: 'original' | 'local' | 'confluence' | 'compensated';
  terminal?: 'live' | 'unknown'; actorId?: string; children?: boolean; changedAcl?: boolean;
}) {
  const direction = options.direction ?? 'to_local';
  const actorId = options.actorId ?? ownerB;
  const source = direction === 'to_local' ? 'confluence' : 'standalone';
  const oldId = `88${String(fixtures.size + 1).padStart(10, '0')}`;
  const pageId = await seedPage({
    title: options.name, source, token: options.token,
    confluenceId: source === 'confluence' ? oldId : undefined,
  });
  await query(
    "INSERT INTO access_control_entries (resource_type,resource_id,principal_type,principal_id,permission) VALUES ('page',$1,'user',$2,'read')",
    [pageId, ownerA],
  );
  const original = await snapshot(pageId);
  const childIds: number[] = [];
  if (options.children) {
    childIds.push(await seedPage({
      title: `${options.name} old trashed child`, source: 'standalone',
      parent: source === 'confluence' ? oldId : String(pageId), deleted: true,
    }));
  }
  const originalChildren = await Promise.all(childIds.map(snapshot));
  const pageIds = [pageId, ...childIds].sort((a, b) => a - b);
  const runtime = `1774-old-retired-${randomUUID()}`;
  // This is existing-row input from an already-retired old execution, not a
  // claim to exercise fencing. W01 below uses the ACTUAL retirement functions.
  await query(
    `INSERT INTO page_writer_runtimes (runtime_id,deployment_identity,enforcement_version,ai_policy_enforcement_version,fenced_at,fence_reason,fence_proof)
     VALUES ($1,'{"fixture":"old retired execution"}',1,1,NOW(),'Existing old execution retained for upgrade',
       '{"kind":"verified_local_termination"}')`, [runtime],
  );
  const intentId = (await query<{ id: string }>(
    `INSERT INTO page_write_intents (runtime_id,kind,actor_id,page_ids,revisions,recovery_mode,effect,effect_started_at,effect_finished_at)
     VALUES ($1,'page.relocate',$2,$3::int[],'{}','remote_terminal_only',$4::jsonb,NOW(),NOW()) RETURNING id`,
    [runtime, actorId, pageIds, JSON.stringify({
      effectClass: 'remote', pageId, target: direction === 'to_local' ? 'local' : 'confluence',
      fromSource: source, fromConfluenceId: original.confluence_id, fromSpaceKey: original.space_key,
      targetSpaceKey: direction === 'to_local' ? 'LOCAL' : 'CONF', affectedPageIds: pageIds,
    })],
  )).rows[0]!.id;
  await createPreparation({ intentId, original, actorId, direction, childIds });
  if (options.phase === 'local') {
    await query(
      `UPDATE pages SET source='standalone',confluence_id=NULL,space_key='LOCAL',visibility='shared',
        created_by_user_id=$2,inherit_perms=TRUE,embedding_dirty=TRUE,image_analysis_dirty=TRUE,
        embedding_status='not_embedded',embedded_at=NULL,local_modified_at=NOW(),local_modified_by=$2 WHERE id=$1`,
      [pageId, actorId],
    );
    await query("DELETE FROM access_control_entries WHERE resource_type='page' AND resource_id=$1", [pageId]);
    await query('UPDATE pages SET parent_id=$2 WHERE id=ANY($1::int[])', [childIds, String(pageId)]);
  } else if (options.phase === 'confluence') {
    h.nextId = `99${String(fixtures.size + 1).padStart(10, '0')}`;
    const client = new ConfluenceClient('https://confluence.test', '1774-provider-pat');
    const acknowledged = await client.createPage('CONF', original.title, STORAGE);
    const provider = h.documents.get(acknowledged.id);
    if (!provider) throw new Error('Actual create must supply the corresponding controlled provider state');
    const receipt = {
      id: provider.id, version: provider.version.number,
      titleSha256: digest(provider.title), bodyStorageSha256: digest(provider.body.storage.value),
    };
    await query(
      `UPDATE page_relocation_preparations SET created_confluence_id=$2,created_page_receipt=$3::jsonb,
        expected_remote_body_storage_sha256=$4 WHERE intent_id=$1`,
      [intentId, provider.id, JSON.stringify(receipt), digest(provider.body.storage.value)],
    );
    const html = confluenceToHtml(provider.body.storage.value, provider.id, 'CONF');
    await query(
      `UPDATE pages SET source='confluence',confluence_id=$2,space_key='CONF',visibility='shared',
        title=$3,body_storage=$4,body_html=$5,body_text=$6,version=$7,last_synced=NOW(),
        embedding_dirty=TRUE,image_analysis_dirty=TRUE,embedding_status='not_embedded',embedded_at=NULL WHERE id=$1`,
      [pageId, provider.id, provider.title, provider.body.storage.value, html, htmlToText(html), provider.version.number],
    );
    await query('UPDATE pages SET parent_id=$2 WHERE id=ANY($1::int[])', [childIds, provider.id]);
    await query(
      `UPDATE page_write_intents SET remote_effect_started_at=NOW(),remote_effects_completed_at=NOW(),
        remote_terminal_result=$2::jsonb WHERE id=$1`,
      [intentId, JSON.stringify({
        outcome: 'committed', createdConfluenceId: provider.id, page: receipt,
        attachmentCount: 0, attachmentReceiptsSha256: digest(''),
      })],
    );
  }
  if (options.terminal) {
    await query(
      `UPDATE page_write_intents SET remote_effect_started_at=NOW(),
        remote_effects_completed_at=CASE WHEN $2='live' THEN NOW() ELSE NULL END,
        remote_terminal_result=CASE WHEN $2='live' THEN $3::jsonb ELSE NULL END WHERE id=$1`,
      [intentId, options.terminal, JSON.stringify({ outcome: 'live', pageId, confluenceId: oldId })],
    );
  }
  if (options.changedAcl) {
    await query("DELETE FROM access_control_entries WHERE resource_type='page' AND resource_id=$1", [pageId]);
    await query(
      "INSERT INTO access_control_entries (resource_type,resource_id,principal_type,principal_id,permission) VALUES ('page',$1,'user',$2,'edit')",
      [pageId, actorId],
    );
  }
  await query(
    `UPDATE page_write_intents SET revisions=(SELECT jsonb_object_agg(p.id::text,jsonb_build_object(
      'contentRevision',p.content_revision::text,'lifecycleRevision',p.lifecycle_revision::text))
      FROM pages p WHERE p.id=ANY($2::int[])) WHERE id=$1`, [intentId, pageIds],
  );
  const fixture: RetainedFixture = {
    name: options.name, pageId, intentId, actorId, original, childIds, originalChildren,
    currentChildren: await Promise.all(childIds.map(snapshot)), currentAces: await aceRows(pageId),
  };
  fixtures.set(options.name, fixture);
  return fixture;
}

async function recover(fixture: RetainedFixture) {
  return reconcilePageWriteIntent(fixture.intentId, {
    actorId: administrator, reason: 'Verify actual existing-row relocation recovery after the one-time schema cutover',
  });
}

async function importId(id: string) {
  const items = await runNotionImport({
    userId: ownerA, client: new NotionClient(TOKEN), pageIds: [id], spaceKey: 'LOCAL', visibility: 'shared',
  });
  return items.find((item) => item.notionPageId === id)!;
}

async function getTree() {
  actor = ownerA;
  const response = await app.inject({ method: 'GET', url: '/api/notion/tree' });
  expect(response.statusCode).toBe(200);
  return response.json<{ nodes: Array<{ id: string; alreadyImported?: boolean; localPageId?: number }> }>();
}

async function ordinaryEdit(id: number, userId: string) {
  actor = userId;
  await query('UPDATE user_settings SET confluence_enabled=FALSE WHERE user_id=$1', [userId]);
  await holdOtherEmbeddingLease(redis);
  // This real local writer marks dirty but launches no embedding worker.
  return app.inject({
    method: 'PUT', url: `/api/pages/${id}`, payload: { title: 'Editable after recovery', bodyHtml: '<p>ordinary recovered edit</p>' },
  });
}

beforeAll(async () => {
  expect(await isDbAvailable(), 'Owned PostgreSQL must execute migration/consumer cases').toBe(true);
  expect(await isRedisAvailable(), 'Owned Redis must execute cache/re-import cases').toBe(true);
  await setupTestDb();
  await truncateAllTables();
  redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false, connectTimeout: 1000 } });
  await redis.connect();
  await redis.flushDb();
  setRedisClient(redis);
  previousAttachmentRoot = process.env.ATTACHMENTS_DIR;
  attachmentRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'compendiq-1774-upgrade-'));
  process.env.ATTACHMENTS_DIR = attachmentRoot;
  ownerA = await insertUser('upgrade-original-owner');
  ownerB = await insertUser('upgrade-local-owner');
  administrator = await insertUser('upgrade-recovery-admin');
  actor = ownerA;
  await query("INSERT INTO spaces (space_key,space_name,source) VALUES ('LOCAL','Local','local'),('CONF','Confluence','confluence')");
  const notionIds = ['repair', 'notes', 'recoveryedit'];
  const notionPages = Object.fromEntries(notionIds.map((id) => [id, {
    object: 'page', id, parent: { type: 'workspace', workspace: true },
    properties: { title: { type: 'title', title: [{ type: 'text', plain_text: id }] } },
  }]));
  server = await startFakeNotionServer({
    validToken: TOKEN, pages: notionPages, searchResults: Object.values(notionPages),
    blockChildren: Object.fromEntries(notionIds.map((id) => [id, [{
      object: 'block', id: `${id}-body`, type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', plain_text: `new ${id}`, text: { content: `new ${id}` } }] },
    }]])),
  });
  setNotionApiBaseUrlForTests(server.baseUrl);
  registerPageRelocateReconciler();
  app = await buildKnowledgeTestApp(() => actor, async (instance) => {
    instance.redis = redis;
    instance.addHook('preHandler', async (request) => {
      request.userRole = (await query<{ role: 'admin' | 'user' }>('SELECT role FROM users WHERE id=$1', [request.userId])).rows[0]!.role;
      request.userCan = (permission: string) => userHasGlobalPermission(request.userId, permission);
    });
    await instance.register(notionRoutes, { prefix: '/api' });
    await instance.register(pagesCrudRoutes, { prefix: '/api' });
  });
  await oldSchema();

  // Prime a REAL public imported marker while the row is eligible on BOTH
  // source heads, then represent the settled OLD relocation retaining token.
  // Neither GET nor these old-schema fixtures registers a current writer.
  repairLive = await seedPage({ title: 'Historical moved import', source: 'standalone', token: 'RE-PAIR' });
  expect((await getTree()).nodes.find((node) => node.id === 'repair')).toMatchObject({ alreadyImported: true, localPageId: repairLive });
  primedCache = await redis.get(`kb:${ownerA}:notion_tree:workspace`);
  initialSearches = server.requests.filter((request) => request.url.includes('/v1/search')).length;
  await query(
    "UPDATE pages SET source='confluence',confluence_id='870000000001',space_key='CONF' WHERE id=$1", [repairLive],
  );
  repairTrash = await seedPage({ title: 'Trashed moved import', source: 'confluence', confluenceId: '870000000002', token: 'Trashed-CF', deleted: true });
  standaloneLive = await seedPage({ title: 'Legitimate import', source: 'standalone', token: 'Legitimate' });
  standaloneTrash = await seedPage({ title: 'Legitimate trash', source: 'standalone', token: 'LEG-ITIMATE', deleted: true });
  await legacyFixture({ name: 'original-standalone', token: 'Standalone-Old', direction: 'to_confluence', phase: 'original' });
  for (const token of [null, 'Original-CF']) {
    await legacyFixture({ name: `original-cf-${token === null ? 'null' : 'exact'}`, token, phase: 'original', changedAcl: true });
  }
  for (const token of [null, 'Local-No-Start']) {
    await legacyFixture({ name: `no-start-${token === null ? 'null' : 'exact'}`, token, phase: 'local', children: true });
  }
  for (const token of [null, 'Local-Live']) {
    await legacyFixture({ name: `live-${token === null ? 'null' : 'exact'}`, token, phase: 'local', terminal: 'live', children: true });
  }
  for (const token of [null, 'Already-Compensated']) {
    await legacyFixture({ name: `compensated-${token === null ? 'null' : 'exact'}`, token, phase: 'compensated', terminal: 'live', changedAcl: true });
  }
  await legacyFixture({ name: 'published-confluence', token: 'Published-Old', direction: 'to_confluence', phase: 'confluence', children: true });
  await legacyFixture({ name: 'unknown-local', token: 'Unknown-Local', phase: 'local', terminal: 'unknown' });
  await legacyFixture({ name: 'changed-cutover-acl', token: 'Changed-ACL', phase: 'local', terminal: 'live', changedAcl: true });
  await legacyFixture({ name: 'late-recovery-status', token: 'NO-TeS', phase: 'local', terminal: 'live', children: true });
  await legacyFixture({ name: 'late-recovery-edit', token: 'RE-COVERYEDIT', phase: 'local', terminal: 'live', children: true });
  const deletedActor = await insertUser('deleted-old-actor');
  const near = await legacyFixture({ name: 'deleted-actor-near-match', token: 'Deleted-Actor', phase: 'local', actorId: deletedActor });
  await query('DELETE FROM users WHERE id=$1', [deletedActor]);
  expect((await snapshot(near.pageId)).created_by_user_id).toBeNull();
  // This is a legitimate derived-cache update, not authored/revision drift.
  await query("UPDATE pages SET expected_image_files=ARRAY[]::text[],expected_drawio_files=ARRAY[]::text[] WHERE id=$1",
    [fixtures.get('no-start-exact')!.pageId]);

  const allIds = [repairLive, repairTrash, standaloneLive, standaloneTrash, ...[...fixtures.values()].flatMap((fixture) => [fixture.pageId, ...fixture.childIds])];
  beforePages = await Promise.all(allIds.map(snapshot));
  beforePreparations = (await query<{ value: Record<string, unknown> }>(
    'SELECT to_jsonb(p) AS value FROM page_relocation_preparations p ORDER BY intent_id',
  )).rows.map((row) => row.value);
  beforeIntents = (await query('SELECT to_jsonb(i) AS value FROM page_write_intents i ORDER BY id')).rows;
  beforeCapacity = await capacity();
  await runMigrations(); // origin: real successful no-op, NOT missing152.
});

// Declared first on purpose: afterAll hooks run last-declared first, so this
// runs after the teardown below and a failure here cannot skip that teardown.
afterAll(async () => {
  await expectNoEmbeddingLeaseLeak();
});

afterAll(async () => {
  // W01 closes this module's execution authority. Only direct migration/read/
  // teardown remains here: never invoke a writer/recovery from that epoch.
  await runMigrations();
  await app?.close();
  setNotionApiBaseUrlForTests(null);
  await server?.close();
  setRedisClient(null);
  if (redis?.isOpen) await redis.quit();
  await teardownTestDb();
  if (attachmentRoot) await fs.rm(attachmentRoot, { force: true, recursive: true });
  if (previousAttachmentRoot === undefined) delete process.env.ATTACHMENTS_DIR;
  else process.env.ATTACHMENTS_DIR = previousAttachmentRoot;
});

// Suites are serial by default. Do not use .concurrent: W01 retires this module's writer.
describe('1774 actual old-row upgrade and independent consumer controls', () => {
  it('[RED R16c] primed public GET reflects repaired persistence without metadata invalidation', async () => {
    const marker = (await getTree()).nodes.find((node) => node.id === 'repair')!;
    expect(marker.alreadyImported).toBe(false);
    expect(marker.localPageId).toBeUndefined();
    expect(await redis.get(`kb:${ownerA}:notion_tree:workspace`)).toBe(primedCache);
    expect(server.requests.filter((request) => request.url.includes('/v1/search'))).toHaveLength(initialSearches);
  });

  it('[RED R16a / ancillary M01-M10] actual re-import succeeds and upgrade changes no unrelated evidence', async () => {
    const item = await importId('repair');
    expect(item.status).toBe('success');
    expect(item.localPageId).not.toBe(repairLive);
    expect((await snapshot(repairLive)).notion_page_id).toBeNull();
    expect((await snapshot(repairTrash)).notion_page_id).toBeNull();
    expect((await snapshot(standaloneLive)).notion_page_id).toBe('Legitimate');
    expect((await snapshot(standaloneTrash)).notion_page_id).toBe('LEG-ITIMATE');
    for (const old of beforePages) {
      const current = await snapshot(old.id);
      const { notion_page_id: beforeToken, ...beforeFields } = old;
      const { notion_page_id: afterToken, ...afterFields } = current;
      void beforeToken;
      void afterToken;
      expect(afterFields).toEqual(beforeFields);
    }
    for (const previous of beforePreparations) {
      const id = z.string().parse(previous.intent_id);
      const current = await preparation(id);
      expect(current).toBeDefined();
      const { original_notion_page_id: captured, ...rest } = current!;
      expect(rest).toEqual(previous);
      const pageId = z.number().parse(previous.page_id);
      expect(captured).toBe(beforePages.find((page) => page.id === pageId)!.notion_page_id);
    }
    expect((await query('SELECT to_jsonb(i) AS value FROM page_write_intents i WHERE kind=\'page.relocate\' ORDER BY id')).rows)
      .toEqual(beforeIntents);
    expect(await capacity()).toEqual(beforeCapacity);
  });

  for (const name of ['original-standalone', 'original-cf-null', 'original-cf-exact',
    'no-start-null', 'no-start-exact', 'live-null', 'live-exact', 'compensated-null', 'compensated-exact']) {
    it(`[PASS C02-C05] ${name} recovers exact original state/NULL/spelling and current-authority ACL`, async () => {
      const fixture = fixtures.get(name)!;
      const expected = await rollbackExpected(fixture);
      const expectedAces = name.startsWith('original-') || name.startsWith('compensated-')
        ? fixture.currentAces : [{ principal_type: 'user', principal_id: ownerA, permission: 'read' }];
      expect(await recover(fixture)).toEqual({ intentId: fixture.intentId, status: 'reconciled_not_applied' });
      expect(authored(await snapshot(fixture.pageId))).toEqual(expected);
      expect(await aceRows(fixture.pageId)).toEqual(expectedAces);
      for (let index = 0; index < fixture.childIds.length; index++) {
        const current = await snapshot(fixture.childIds[index]!);
        expect(authored(current)).toEqual(authored(fixture.originalChildren[index]!));
      }
      expect(await preparation(fixture.intentId)).toBeUndefined();
      expect(await capacity()).toEqual(beforeCapacity);
    });
  }

  it('[PASS M04] acknowledged provider creation verifies and never rolls a successful publication back to standalone', async () => {
    const fixture = fixtures.get('published-confluence')!;
    expect(h.creations).toBe(1);
    expect(await recover(fixture)).toEqual({ intentId: fixture.intentId, status: 'reconciled_applied' });
    expect((await snapshot(fixture.pageId)).source).toBe('confluence');
    expect(h.deletions).toEqual([]);
    expect(await preparation(fixture.intentId)).toBeUndefined();
  });

  it('[PASS M05] deleted-actor near-match stays pending/untouched without blocking safe repair', async () => {
    const fixture = fixtures.get('deleted-actor-near-match')!;
    const safe = await snapshot(fixture.pageId);
    const prep = await preparation(fixture.intentId);
    expect(safe).toMatchObject({ source: 'standalone', created_by_user_id: null, notion_page_id: 'Deleted-Actor' });
    await expect(recover(fixture)).rejects.toMatchObject({ reason: 'intent_recovery_metadata_invalid' });
    expect(await snapshot(fixture.pageId)).toEqual(safe);
    expect(await preparation(fixture.intentId)).toEqual(prep);
  });

  it('[PASS C06/M08] real intervening ACL survives upgrade and still refuses destructive compensation', async () => {
    const fixture = fixtures.get('changed-cutover-acl')!;
    const safe = await snapshot(fixture.pageId);
    const prep = await preparation(fixture.intentId);
    await expect(recover(fixture)).rejects.toMatchObject({ reason: 'intent_local_evidence_mismatch' });
    expect(await snapshot(fixture.pageId)).toEqual(safe);
    expect(await aceRows(fixture.pageId)).toEqual(fixture.currentAces);
    expect(await preparation(fixture.intentId)).toEqual(prep);
    expect(await capacity()).toEqual(beforeCapacity);
  });

  it('[PASS U01/M09] unknown provider outcome remains pending and policy callback never starts', async () => {
    const fixture = fixtures.get('unknown-local')!;
    const safe = await snapshot(fixture.pageId);
    const prep = await preparation(fixture.intentId);
    let invoked = false;
    await expect(withAiPolicyWriteTransaction([fixture.pageId], async () => { invoked = true; }))
      .rejects.toMatchObject({ reason: 'page_write_busy' });
    expect(invoked).toBe(false);
    await expect(recover(fixture)).rejects.toMatchObject({ reason: 'intent_outcome_unrecoverable' });
    expect(await snapshot(fixture.pageId)).toEqual(safe);
    expect(await preparation(fixture.intentId)).toEqual(prep);
    expect(h.deletions).toEqual([]);
  });

  for (const oracle of ['status', 'edit'] as const) {
    it(`[RED N01 recovery-${oracle}] original owner import survives exact terminal-live compensation`, async () => {
      const fixture = fixtures.get(`late-recovery-${oracle}`)!;
      const item = await importId(oracle === 'status' ? 'notes' : 'recoveryedit');
      expect(item.status).toBe('success'); // reachable on BOTH heads: root currently belongs to B.
      const imported = await snapshot(item.localPageId!);
      const expected = await rollbackExpected(fixture);
      const result: unknown = await recover(fixture).catch((error: unknown) => error);
      const rollback = await snapshot(fixture.pageId);
      if (oracle === 'status') {
        expect(result).toEqual({ intentId: fixture.intentId, status: 'reconciled_not_applied' });
      } else {
        expect((await ordinaryEdit(fixture.pageId, ownerB)).statusCode).toBe(200);
      }
      expect(authored(rollback)).toEqual(expected);
      expect(await snapshot(item.localPageId!)).toEqual(imported);
      for (let index = 0; index < fixture.childIds.length; index++) {
        expect(authored(await snapshot(fixture.childIds[index]!))).toEqual(authored(fixture.originalChildren[index]!));
      }
      expect(await preparation(fixture.intentId)).toBeUndefined();
      expect(await capacity()).toEqual(beforeCapacity);
    });
  }

  it('[PASS index controls / RED CF coexistence] real normalized source/owner/trash uniqueness agrees', async () => {
    const identityOwner = await insertUser('index-policy-owner');
    const first = await seedPage({ title: 'Eligible', source: 'standalone', owner: identityOwner, token: 'AB-CD' });
    await expect(seedPage({ title: 'Duplicate', source: 'standalone', owner: identityOwner, token: 'abcd' }))
      .rejects.toMatchObject({ code: '23505' });
    await seedPage({ title: 'Other owner', source: 'standalone', owner: ownerA, token: 'abcd' });
    await seedPage({ title: 'Trash', source: 'standalone', owner: identityOwner, token: 'abcd', deleted: true });
    await seedPage({ title: 'NULL token', source: 'standalone', owner: identityOwner });
    await seedPage({ title: 'Second NULL token', source: 'standalone', owner: identityOwner });
    await seedPage({ title: 'Unowned original', source: 'standalone', owner: null, token: 'un-owned' });
    await seedPage({ title: 'Unowned duplicate', source: 'standalone', owner: null, token: 'unowned' });
    // This FIRST new source-policy consumer assertion fails on origin23505.
    const coexistence = seedPage({
      title: 'Not an import', source: 'confluence', owner: identityOwner, token: 'abcd', confluenceId: '870000000003',
    });
    await expect(coexistence).resolves.toBeTypeOf('number');
    const decoy = await coexistence;
    expect(decoy).not.toBe(first);
  });

  it('[PASS recorded migration] ordinary rerun neither repairs compensated metadata again nor mutates pending evidence', async () => {
    const before = (await query('SELECT to_jsonb(p) AS value FROM pages p ORDER BY id')).rows;
    const pending = (await query("SELECT to_jsonb(i) AS value FROM page_write_intents i WHERE status='pending' ORDER BY id")).rows;
    await runMigrations();
    expect((await query('SELECT to_jsonb(p) AS value FROM pages p ORDER BY id')).rows).toEqual(before);
    expect((await query("SELECT to_jsonb(i) AS value FROM page_write_intents i WHERE status='pending' ORDER BY id")).rows).toEqual(pending);
  });

  // LAST case, deliberately irreversible for this module's execution authority.
  // --isolate ensures later files receive a new module/runtime. No writer or
  // recovery is invoked below retirement, including teardown.
  it('[FEATURE SAFETY W01] actual failed/unknown work survives the self-retiring upgrade', async () => {
    await truncateAllTables();
    await oldSchema();
    ownerA = await insertUser('retirement-owner');
    ownerB = await insertUser('retirement-writer');
    administrator = await insertUser('retirement-admin');
    await query("INSERT INTO spaces (space_key,space_name,source) VALUES ('LOCAL','Local','local'),('CONF','Confluence','confluence')");
    const p = await seedPage({ title: 'Old index failure', source: 'confluence', token: 'NO-TeS', confluenceId: '860000000001' });
    await seedPage({ title: 'B existing import', source: 'standalone', owner: ownerB, token: 'notes' });
    const u = await seedPage({ title: 'Unknown deletion', source: 'confluence', token: 'Un-Known', confluenceId: '860000000002' });
    const pOriginal = await snapshot(p);
    const uOriginal = await snapshot(u);
    const reserve = async (id: number, original: PageSnapshot) => reservePageWriteIntent({
      pageIds: [id], kind: 'page.relocate', actorId: ownerB,
      effect: {
        effectClass: 'remote', pageId: id, target: 'local', fromSource: 'confluence',
        fromConfluenceId: original.confluence_id, fromSpaceKey: 'CONF', targetSpaceKey: 'LOCAL', affectedPageIds: [id],
      },
    });
    const pIntent = await reserve(p, pOriginal);
    await createPreparation({ intentId: pIntent.id, original: pOriginal, actorId: ownerB, direction: 'to_local', childIds: [] });
    const oldPublish = (intent: PageWriteIntent, id: number) => advancePageWriteIntent(intent, async (client) => {
      await client.query(
        `UPDATE pages SET source='standalone',confluence_id=NULL,space_key='LOCAL',visibility='shared',
          created_by_user_id=$2,inherit_perms=TRUE,embedding_dirty=TRUE,image_analysis_dirty=TRUE,
          embedding_status='not_embedded',embedded_at=NULL,local_modified_at=NOW(),local_modified_by=$2 WHERE id=$1`,
        [id, ownerB],
      );
    });
    await expect(runPageWriteIntentEffect(pIntent, { kind: 'local' }, () => oldPublish(pIntent, p)))
      .rejects.toMatchObject({ code: '23505' });
    const uIntent = await reserve(u, uOriginal);
    await createPreparation({ intentId: uIntent.id, original: uOriginal, actorId: ownerB, direction: 'to_local', childIds: [] });
    await runPageWriteIntentEffect(uIntent, { kind: 'local' }, () => oldPublish(uIntent, u));
    const transportFailure = new Error('Controlled provider response lost with unknown outcome');
    h.failures.set('860000000002', transportFailure);
    const provider = new ConfluenceClient('https://confluence.test', '1774-provider-pat');
    await expect(runPageWriteIntentEffect(uIntent, { kind: 'remote', completesRemoteWork: true },
      () => provider.deletePage('860000000002'))).rejects.toBe(transportFailure);
    const admissionPage = await seedPage({ title: 'Actual writable admission', source: 'standalone' });
    const admission = await admitPageRuntime(admissionPage, ownerA, 'collab_room');
    const runtimeId = await getPageWriterRuntimeId();
    expect(admission.runtimeId).toBe(runtimeId);
    const pendingBefore = (await query(
      'SELECT to_jsonb(i) AS value FROM page_write_intents i WHERE id=ANY($1::uuid[]) ORDER BY id', [[pIntent.id, uIntent.id]],
    )).rows;
    const prepBefore = [await preparation(pIntent.id), await preparation(uIntent.id)];
    const pagesBefore = [await snapshot(p), await snapshot(u)];
    const capacityBefore = await capacity();
    try {
      // #2063: a killed deployment is retired by the upgrade itself, before the
      // one-time 152 guard. No manual SQL and no owner-acknowledgment fiction.
      await runMigrations();
      expect((await query('SELECT 1 FROM _migrations WHERE name=$1', [MIGRATION])).rowCount).toBe(1);
      expect((await query('SELECT 1 FROM _migrations WHERE name=$1', [UPGRADE_RETIREMENT])).rowCount).toBe(1);

      // This epoch dispatched work, so it is closed, never fenced, and has no
      // owner acknowledgment to claim.
      const retiredState = (await query(
        'SELECT quiesced_at,quiescence_ack,upgrade_retired_at,fenced_at FROM page_writer_runtimes WHERE runtime_id=$1', [runtimeId],
      )).rows[0]!;
      expect(retiredState).toMatchObject({
        quiesced_at: expect.any(Date), quiescence_ack: null, fenced_at: null,
        upgrade_retired_at: expect.any(Date),
      });
      expect(retiredState.upgrade_retired_at).toEqual(retiredState.quiesced_at);
      expect((await query('SELECT released_at,release_kind FROM page_runtime_admissions WHERE id=$1', [admission.id])).rows[0])
        .toMatchObject({ released_at: expect.any(Date), release_kind: 'upgrade_retired' });
      expect((await query('SELECT 1 FROM page_runtime_admissions WHERE released_at IS NULL')).rowCount).toBe(0);

      // Actual failed/unknown work survives exactly: intents, preparations and
      // capacity are untouched, and only 152's documented token repair ran.
      expect((await query('SELECT to_jsonb(i) AS value FROM page_write_intents i WHERE id=ANY($1::uuid[]) ORDER BY id',
        [[pIntent.id, uIntent.id]])).rows).toEqual(pendingBefore);
      for (let index = 0; index < 2; index++) {
        const id = index === 0 ? p : u;
        const intentId = index === 0 ? pIntent.id : uIntent.id;
        const current = await snapshot(id);
        const { notion_page_id: ignoredBefore, ...originalFields } = pagesBefore[index]!;
        const { notion_page_id: ignoredAfter, ...currentFields } = current;
        void ignoredBefore;
        void ignoredAfter;
        expect(currentFields).toEqual(originalFields);
        expect(current.notion_page_id).toBeNull();
        const prep = (await preparation(intentId))!;
        const { original_notion_page_id: token, ...existingFields } = prep;
        expect(existingFields).toEqual(prepBefore[index]);
        expect(token).toBe(index === 0 ? 'NO-TeS' : 'Un-Known');
      }
      expect(await capacity()).toEqual(capacityBefore);

      // Recovery authority is unchanged: no fabricated acknowledgment, no
      // no-start fence for dispatched work, and reconcile still needs a fence.
      await expect(quiescePageWriterRuntime({ actorId: administrator, reason: 'A retired migration epoch cannot re-acknowledge' }))
        .rejects.toMatchObject({ reason: 'runtime_upgrade_retired' });
      await expect(fencePageWriterRuntime({
        mode: 'owner_ack', runtimeId, actorId: administrator, acknowledgmentId: randomUUID(),
        reason: 'No owner acknowledgment exists for this retired epoch',
      })).rejects.toMatchObject({ reason: 'runtime_not_quiesced' });
      await expect(fencePageWriterRuntime({
        mode: 'durable_no_started_effects', runtimeId, actorId: administrator,
        reason: 'Dispatched unknown work cannot be retired from no-start evidence',
      })).rejects.toMatchObject({ reason: 'runtime_effects_started' });
      await expect(reconcilePageWriteIntent(pIntent.id, {
        actorId: administrator, reason: 'Recovery cannot start on a retired migration epoch',
      })).rejects.toMatchObject({ reason: 'runtime_quiesced' });
      await expect(admitPageRuntime(admissionPage, ownerA, 'collab_room'))
        .rejects.toMatchObject({ reason: 'runtime_quiesced' });
    } finally {
      await runMigrations();
    }
  });
});
