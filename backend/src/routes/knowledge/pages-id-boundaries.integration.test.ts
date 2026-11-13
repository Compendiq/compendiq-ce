/**
 * #1739: real PostgreSQL/Redis boundary regressions, using origin/dev exports.
 * RED names predict an application assertion failure; CONTROL names preserve
 * existing behavior. Only authentication and outbound HTTP are injected.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { setupTestDb, teardownTestDb, truncateAllTables, isDbAvailable } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { initPresenceBus, recordHeartbeat, getActiveViewers } from '../../core/services/presence-service.js';
import { invalidateRbacCache, userHasGlobalPermission } from '../../core/services/rbac-service.js';
import { buildPng, REAL_PNG_40x30_BASE64 } from '../../core/services/test-image-fixtures.js';
import { bumpProviderCacheVersion } from '../../domains/llm/services/cache-bus.js';
import { buildKnowledgeTestApp, insertUser, insertLocalSpace } from './pages.test-helpers.js';
import { cachedAttachmentPath } from '../../core/services/attachment-store.js';
import { pagesCrudRoutes } from './pages-crud.js';
import { pagesTagRoutes } from './pages-tags.js';
import { verificationRoutes } from './verification.js';
import { pagesIconRoutes } from './pages-icon.js';
import { pagesPresenceRoutes } from './pages-presence.js';
import { pagesVersionRoutes } from './pages-versions.js';
import { pagesExportRoutes } from './pages-export.js';
import { pinnedPagesRoutes } from './pinned-pages.js';
import { commentsRoutes } from './comments.js';
import { contentAnalyticsRoutes } from './content-analytics.js';
import { pagesConnectionRoutes } from './pages-connections.js';
import { localAttachmentsRoutes } from './local-attachments.js';
import { pagesRelocateRoutes } from './pages-relocate.js';
import { localSpacesRoutes } from './local-spaces.js';
import { pageBaselineRoutes } from './page-baselines.js';

// Deliberate test module-loading boundary: attachment-store snapshots its root
// at import time. Hoist owned storage before even transitive route imports.
const attachmentRoot = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'page-id-1739-'));
  vi.stubEnv('ATTACHMENTS_DIR', root);
  return root;
});

const PNG = Buffer.from(REAL_PNG_40x30_BASE64, 'base64');
const DECOY_PNG = buildPng(41, 31);
const DATA_URI = `data:image/png;base64,${REAL_PNG_40x30_BASE64}`;
const IMAGE_URL = 'https://8.8.8.8/id-boundary.png';
const UUID = '11111111-1111-4111-8111-111111111111';
const nativeFetch = globalThis.fetch;
const SQL_DIAGNOSTIC = /22003|22P02|out of range for type integer|invalid input syntax for (?:type )?integer|NaN/;

function assertNoPageDisclosure(body: string): void {
  expect.soft(body).not.toMatch(SQL_DIAGNOSTIC);
  expect.soft(body).not.toContain('ID target');
  expect.soft(body).not.toContain('ID decoy');
  expect.soft(body).not.toContain('<p>Draft</p>');
}

type Page = {
  id: number; source: 'standalone' | 'confluence'; confluence_id: string | null;
  title: string; body_html: string; body_text: string; version: number;
  content_revision: string; lifecycle_revision: string; labels: string[];
  icon_kind: string | null; icon_value: string | null; owner_id: string | null;
  created_by_user_id: string | null; deleted_at: Date | null; path: string; depth: number;
  draft_body_html: string | null; verified_by: string | null; verified_at: Date | null;
  review_interval_days: number; ai_policy_revision: string;
};
type LegacyCase = { code: string; method: HTTPMethods; suffix: string; payload?: Record<string, unknown>; hidden: number };
const legacyCases: LegacyCase[] = [
  { code: 'L01', method: 'GET', suffix: '', hidden: 404 },
  { code: 'L02', method: 'PUT', suffix: '', payload: { title: 'Updated', bodyHtml: '<p>Updated</p>' }, hidden: 403 },
  { code: 'L03', method: 'DELETE', suffix: '', hidden: 403 },
  { code: 'L03-permanent', method: 'DELETE', suffix: '?permanent=true', hidden: 403 },
  { code: 'L04', method: 'POST', suffix: '/auto-tag', payload: { model: 'fixture-model' }, hidden: 404 },
  { code: 'L05', method: 'POST', suffix: '/apply-tags', payload: { tags: ['architecture'] }, hidden: 404 },
  { code: 'L06', method: 'PUT', suffix: '/labels', payload: { addLabels: ['id-boundary-tag'], removeLabels: ['remove-me'] }, hidden: 404 },
  { code: 'L07', method: 'POST', suffix: '/verify', hidden: 404 },
  { code: 'L08', method: 'PUT', suffix: '/owner', hidden: 404 },
  { code: 'L09', method: 'PUT', suffix: '/review-interval', payload: { days: 30 }, hidden: 404 },
  { code: 'L10', method: 'PATCH', suffix: '/icon', payload: { icon: { kind: 'lucide', value: 'book' } }, hidden: 403 },
  { code: 'L11', method: 'POST', suffix: '/icon-image', payload: { dataUri: DATA_URI }, hidden: 403 },
  { code: 'L12', method: 'GET', suffix: '/icon-image', hidden: 404 },
  { code: 'L14', method: 'POST', suffix: '/presence/heartbeat', payload: { isEditing: false }, hidden: 404 },
  { code: 'L15', method: 'DELETE', suffix: '/presence', hidden: 204 },
  { code: 'L16', method: 'GET', suffix: '/versions', hidden: 200 },
  { code: 'L17', method: 'GET', suffix: '/versions/1', hidden: 404 },
  { code: 'L18', method: 'POST', suffix: '/versions/semantic-diff', payload: { v1: 1, v2: 1 }, hidden: 404 },
  { code: 'L19', method: 'POST', suffix: '/versions/1/restore', payload: { version: 3 }, hidden: 404 },
  { code: 'L20', method: 'POST', suffix: '/images', payload: { dataUri: DATA_URI, filename: 'id-boundary.png' }, hidden: 403 },
  { code: 'L21', method: 'POST', suffix: '/images/import', payload: { url: IMAGE_URL }, hidden: 403 },
];

type PkCase = {
  code: string; method: HTTPMethods; suffix: string; attachment?: boolean;
  payload?: Record<string, unknown>; parser: 'parse-int' | 'raw' | 'coerce' | 'bounded'; admin?: boolean;
};
const pkCases: PkCase[] = [
  { code: 'P01', method: 'PUT', suffix: '/draft', payload: { title: 'Updated draft', bodyHtml: '<p>Updated draft</p>' }, parser: 'parse-int' },
  { code: 'P02', method: 'GET', suffix: '/draft', parser: 'parse-int' },
  { code: 'P03', method: 'POST', suffix: '/draft/publish', parser: 'parse-int' },
  { code: 'P04', method: 'DELETE', suffix: '/draft', parser: 'parse-int' },
  { code: 'P05', method: 'POST', suffix: '/restore', parser: 'raw' },
  { code: 'P06', method: 'POST', suffix: '/export/pdf', parser: 'parse-int' },
  { code: 'P08', method: 'POST', suffix: '/pin', parser: 'parse-int' },
  { code: 'P09', method: 'DELETE', suffix: '/pin', parser: 'parse-int' },
  { code: 'P10', method: 'GET', suffix: '/comments', parser: 'coerce' },
  { code: 'P11', method: 'POST', suffix: '/comments', payload: { body: 'Identifier comment' }, parser: 'coerce' },
  { code: 'P12', method: 'POST', suffix: '/feedback', payload: { isHelpful: true }, parser: 'coerce' },
  { code: 'P13', method: 'GET', suffix: '/feedback', parser: 'coerce' },
  { code: 'P14', method: 'POST', suffix: '/view', payload: { sessionId: 'id-boundary-view' }, parser: 'coerce' },
  { code: 'P15', method: 'GET', suffix: '/connections', parser: 'coerce' },
  { code: 'P16', method: 'POST', suffix: '/connections/events', payload: { event: 'impression', visitId: UUID }, parser: 'coerce' },
  { code: 'P18', method: 'GET', suffix: '/list', attachment: true, parser: 'coerce' },
  { code: 'P19', method: 'GET', suffix: '/id-boundary.png', attachment: true, parser: 'coerce' },
  { code: 'P20', method: 'PUT', suffix: '/id-boundary.png', attachment: true, payload: { dataUri: DATA_URI }, parser: 'coerce' },
  { code: 'P21', method: 'GET', suffix: '/relocate/preview', parser: 'coerce', admin: true },
  { code: 'P22', method: 'POST', suffix: '/relocate', parser: 'coerce', admin: true, payload: {
    target: 'confluence', spaceKey: 'IDDOCS', acknowledgeAccessChange: true, acknowledgeDiscardedVersions: 0,
  } },
  { code: 'P23', method: 'GET', suffix: '/freeze-preview', parser: 'bounded' },
  { code: 'P24', method: 'POST', suffix: '/freeze', parser: 'bounded', payload: {
    reason: 'Identifier boundary freeze', expectedContentRevision: '1', expectedManifestDigest: 'a'.repeat(64),
    reportedSignatories: [{ displayName: 'Identifier approver', email: 'identifier@example.test' }],
  } },
  { code: 'P25', method: 'POST', suffix: '/unfreeze', parser: 'bounded', payload: {
    reason: 'Identifier boundary unfreeze', expectedBaselineId: UUID, expectedLifecycleRevision: '1',
  } },
  { code: 'P26', method: 'GET', suffix: '/freeze-history', parser: 'coerce' },
  { code: 'P27', method: 'GET', suffix: `/baselines/${UUID}/media/${'a'.repeat(64)}`, parser: 'coerce' },
  { code: 'P28', method: 'PUT', suffix: '/ai-policy', payload: { aiPolicy: 'all', expectedRevision: 0 }, parser: 'coerce' },
  { code: 'P31', method: 'PUT', suffix: '/move', payload: { parentId: null }, parser: 'bounded' },
  { code: 'P32', method: 'PUT', suffix: '/reorder', payload: { sortOrder: 0 }, parser: 'bounded' },
  { code: 'P33', method: 'GET', suffix: '/breadcrumb', parser: 'bounded' },
];

describe('#1739 real page-ID route boundaries', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let stopPresence: (() => Promise<void>) | undefined;
  const attachmentsDir = attachmentRoot;
  let providerServer: Server;
  let providerUrl = '';
  let owner = '';
  let other = '';
  let admin = '';
  let actor: string | null = null;
  const imageFetches: string[] = [];
  const llmRequests: unknown[] = [];
  const ownedPresenceKeys = new Set<string>();

  beforeAll(async () => {
    expect(await isDbAvailable(), 'Real PostgreSQL is required, not skipped').toBe(true);
    expect(await isRedisAvailable(), 'Real Redis is required, not skipped').toBe(true);
    await setupTestDb();
    redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false } });
    await redis.connect();
    setRedisClient(redis);
    stopPresence = await initPresenceBus(redis);
    providerServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      llmRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'synthetic-identifier-diff', object: 'chat.completion', model: 'diff-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'identifier diff' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }));
    });
    const listening = Promise.withResolvers<void>();
    providerServer.once('error', listening.reject);
    providerServer.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    providerServer.off('error', listening.reject);
    providerUrl = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}/v1`;
    app = await buildKnowledgeTestApp(() => {
      if (!actor) throw Object.assign(new Error('Unauthenticated'), { statusCode: 401 });
      return actor;
    }, async (instance) => {
      instance.redis = redis;
      instance.addHook('onRequest', async (request) => {
        request.userCan = (permission) => userHasGlobalPermission(request.userId, permission);
      });
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
      await instance.register(pagesTagRoutes, { prefix: '/api' });
      await instance.register(verificationRoutes, { prefix: '/api' });
      await instance.register(pagesIconRoutes, { prefix: '/api' });
      await instance.register(pagesPresenceRoutes, { prefix: '/api' });
      await instance.register(pagesVersionRoutes, { prefix: '/api' });
      await instance.register(pagesExportRoutes, { prefix: '/api' });
      await instance.register(pinnedPagesRoutes, { prefix: '/api' });
      await instance.register(commentsRoutes, { prefix: '/api' });
      await instance.register(contentAnalyticsRoutes, { prefix: '/api' });
      await instance.register(pagesConnectionRoutes, { prefix: '/api' });
      await instance.register(localAttachmentsRoutes, { prefix: '/api' });
      await instance.register(pagesRelocateRoutes, { prefix: '/api' });
      await instance.register(localSpacesRoutes, { prefix: '/api' });
      await instance.register(pageBaselineRoutes, { prefix: '/api' });
    });
  }, 60_000);

  beforeEach(async () => {
    await truncateAllTables();
    await rm(attachmentsDir, { recursive: true, force: true });
    await mkdir(attachmentsDir, { recursive: true });
    owner = await insertUser(`id-owner-${randomUUID()}`);
    other = await insertUser(`id-other-${randomUUID()}`);
    admin = await insertUser(`id-admin-${randomUUID()}`);
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [admin]);
    await query(
      `INSERT INTO user_settings (user_id, confluence_enabled)
       SELECT id, FALSE FROM users WHERE id = ANY($1::uuid[])
       ON CONFLICT (user_id) DO UPDATE SET confluence_enabled = FALSE`, [[owner, other, admin]],
    );
    await insertLocalSpace('IDLOCAL', owner);
    await query("UPDATE spaces SET space_name = 'ID Local' WHERE space_key = 'IDLOCAL'");
    await query("INSERT INTO spaces (space_key, space_name, source) VALUES ('IDDOCS', 'ID Docs', 'confluence')");
    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, permissions)
       VALUES ($1, 'ID boundary editor', ARRAY['read','comment','edit','delete','manage']) RETURNING id`,
      [`id-boundary-editor-${randomUUID()}`],
    );
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ('IDDOCS', 'user', $1, $2)`, [owner, role.rows[0]!.id],
    );
    await invalidateRbacCache();
    const provider = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default, default_model)
       VALUES ('identifier-synthetic-http', $1, 'none', TRUE, TRUE, 'diff-model') RETURNING id`, [providerUrl],
    );
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('chat', $1, 'diff-model')
       ON CONFLICT (usecase) DO UPDATE SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model`,
      [provider.rows[0]!.id],
    );
    await bumpProviderCacheVersion();
    actor = owner;
    imageFetches.length = 0;
    llmRequests.length = 0;
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === IMAGE_URL) {
        imageFetches.push(url);
        return new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } });
      }
      if (url.startsWith(`${providerUrl}/`)) return nativeFetch(input, init);
      throw new Error(`Unexpected outbound HTTP in page-ID boundary test: ${url}`);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (redis?.isOpen && ownedPresenceKeys.size > 0) await redis.del([...ownedPresenceKeys]);
    ownedPresenceKeys.clear();
  });

  afterAll(async () => {
    await app?.close();
    await stopPresence?.();
    setRedisClient(null);
    if (redis?.isOpen) await redis.quit();
    if (providerServer?.listening) {
      const closed = Promise.withResolvers<void>();
      providerServer.close((error) => {
        if (error) closed.reject(error);
        else closed.resolve();
      });
      await closed.promise;
    }
    await teardownTestDb();
    if (attachmentsDir) await rm(attachmentsDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function seedPage(options: {
    id?: number; source?: 'standalone' | 'confluence'; raw?: string; marker?: string;
    ownerId?: string; visibility?: 'private' | 'shared'; title?: string; version?: number;
    parentId?: string; deletedAt?: string; empty?: boolean; reviewDays?: number;
  } = {}): Promise<Page> {
    const source = options.source ?? (options.raw === undefined ? 'standalone' : 'confluence');
    const marker = options.marker ?? 'ID target body';
    const html = options.empty ? '' : `<p>${marker}</p>`;
    const row = await query<Page>(
      `INSERT INTO pages
         (id, source, confluence_id, space_key, title, body_html, body_storage, body_text, version,
          visibility, created_by_user_id, labels, parent_id, deleted_at, embedding_dirty, embedding_status,
          last_modified_at, last_synced, verified_at, review_interval_days,
          draft_body_html, draft_body_text, draft_updated_at, draft_updated_by)
       VALUES (COALESCE($1::int, nextval('pages_id_seq')::int), $2, $3, $4, $5, $6, $6, $7, $8,
               $9, $10, $11, $12, $13::timestamptz, FALSE, 'not_embedded',
               '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z',
               '2020-01-01T00:00:00Z', $14, '<p>Draft</p>', 'Draft', '2020-01-01T00:00:00Z', $10)
       RETURNING *`,
      [options.id ?? null, source, options.raw ?? null, source === 'confluence' ? 'IDDOCS' : 'IDLOCAL',
        options.title ?? 'ID target', html, options.empty ? '' : marker, options.version ?? 1,
        options.visibility ?? 'shared', options.ownerId ?? owner,
        marker === 'ID decoy body' ? ['decoy-label'] : ['keep-me', 'remove-me'],
        options.parentId ?? null, options.deletedAt ?? null, options.reviewDays ?? 90],
    );
    const page = row.rows[0]!;
    await query('UPDATE pages SET path = $2, depth = 0 WHERE id = $1', [page.id, `/${page.id}`]);
    const current = await query<Page>('SELECT * FROM pages WHERE id = $1', [page.id]);
    return current.rows[0]!;
  }

  async function seedHistory(page: Page, title = 'Historical target', marker = 'Historical target body') {
    await query(
      `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text, synced_at, edited_at, author, message)
       VALUES ($1, 1, $2, $3, $4, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 'Fixture author', 'Fixture history')`,
      [page.id, title, `<p>${marker}</p>`, marker],
    );
  }

  function attachmentKey(page: Page): string {
    return page.source === 'standalone' ? String(page.id) : page.confluence_id!;
  }

  async function seedCacheFile(page: Page, bytes: Buffer) {
    const file = cachedAttachmentPath(attachmentKey(page), 'id-boundary.png');
    expect(file).not.toBeNull();
    expect(relative(attachmentsDir, file!)).not.toMatch(/^\.\./);
    await mkdir(dirname(file!), { recursive: true });
    await writeFile(file!, bytes);
  }

  async function fileState(directory = attachmentsDir): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) Object.assign(files, await fileState(absolute));
      else if (entry.isFile()) files[relative(attachmentsDir, absolute)] = createHash('sha256').update(await readFile(absolute)).digest('hex');
    }
    return files;
  }

  async function databaseState() {
    const state: Record<string, unknown> = {};
    for (const table of [
      'pages', 'page_versions', 'pinned_pages', 'comments', 'notifications', 'article_feedback',
      'page_views', 'audit_log', 'local_attachments', 'page_write_intents',
      'page_relocation_preparations', 'page_baselines', 'page_collaborative_docs',
    ]) {
      state[table] = (await query<{ rows: unknown }>(
        `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM ${table} t`,
      )).rows[0]!.rows;
    }
    return state;
  }

  async function observableState() {
    const presence: Record<string, unknown> = {};
    for (const key of ownedPresenceKeys) {
      const type = await redis.type(key);
      presence[key] = type === 'zset' ? await redis.zRangeWithScores(key, 0, -1)
        : type === 'set' ? (await redis.sMembers(key)).sort()
          : type === 'hash' ? await redis.hGetAll(key) : null;
    }
    return { database: await databaseState(), files: await fileState(), presence,
      imageFetches: [...imageFetches], llmRequests: [...llmRequests] };
  }

  async function seedViewer(key: string, userId: string) {
    ownedPresenceKeys.add(`presence:viewers:${key}`);
    ownedPresenceKeys.add(`presence:editing:${key}`);
    ownedPresenceKeys.add(`presence:meta:${userId}`);
    await recordHeartbeat(key, userId, true, { name: userId === owner ? 'Identifier owner' : 'Decoy viewer', role: 'user' });
    expect(await getActiveViewers(key)).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId, isEditing: true }),
    ]));
  }

  async function legacyRequest(operation: LegacyCase, raw: string) {
    const payload = operation.code === 'L08' ? { ownerId: other } : operation.payload;
    return app.inject({ method: operation.method, url: `/api/pages/${raw}${operation.suffix}`, ...(payload ? { payload } : {}) });
  }

  function projectedResponse(value: unknown, page: Page, raw: string): unknown {
    if (Array.isArray(value)) return value.map((item) => projectedResponse(item, page, raw));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (key === 'id' && (entry === page.id || entry === String(page.id))) return [key, '$target-pk'];
      if (key === 'pageId' && (entry === raw || entry === page.id || entry === String(page.id))) return [key, '$request-page-id'];
      if (key === 'confluenceId' && entry === page.confluence_id) return [key, '$target-confluence-id'];
      return [key, projectedResponse(entry, page, raw)];
    }));
  }

  async function arrangeLegacy(operation: LegacyCase, raw: string, scenario = 'large') {
    const collision = scenario.startsWith('collision-');
    const targetHidden = scenario === 'collision-hidden-target' || scenario === 'large-hidden';
    const privateTarget = scenario === 'collision-private-target';
    const privateDecoy = scenario === 'collision-private-decoy';
    const missingTarget = scenario === 'collision-missing-target';
    const targetId = collision ? 2_000_000_000 : scenario === 'max' ? 2_147_483_647 : undefined;
    const targetRaw = targetId === undefined ? raw : '4000000001';
    const version = operation.code === 'L19' ? 3 : operation.code === 'L16' ? 2 : 1;
    const target = missingTarget ? null : await seedPage({
      id: targetId, raw: targetRaw, source: privateTarget ? 'standalone' : 'confluence',
      ownerId: privateTarget ? other : owner, visibility: privateTarget ? 'private' : 'shared',
      version, empty: operation.code === 'L04', reviewDays: operation.code === 'L07' ? 30 : 90,
    });
    const canonical = await seedPage({ raw: 'canonical-control', version, empty: operation.code === 'L04', reviewDays: operation.code === 'L07' ? 30 : 90 });
    const decoyRaw = collision || scenario === 'max' ? raw
      : raw === '3000000000' ? '0003000000000'
        : raw === '0003000000000' ? '3000000000' : '9007199254740992';
    const decoy = await seedPage({
      raw: decoyRaw, source: privateDecoy ? 'standalone' : 'confluence',
      title: 'ID decoy', marker: 'ID decoy body', ownerId: other,
      visibility: privateDecoy ? 'private' : 'shared', version: 7,
    });
    for (const page of [target, canonical, decoy]) {
      if (!page) continue;
      await seedCacheFile(page, page.id === decoy.id || operation.code === 'L20' || operation.code === 'L21' ? DECOY_PNG : PNG);
      if (operation.code === 'L16' || operation.code === 'L19') {
        await seedHistory(page, page.id === decoy.id ? 'Decoy history' : 'Historical target',
          page.id === decoy.id ? 'ID decoy historical body' : 'Historical target body');
      }
      if (operation.code === 'L12') {
        actor = page.source === 'standalone' ? page.created_by_user_id : owner;
        const uploaded = await app.inject({ method: 'POST', url: `/api/pages/${page.id}/icon-image`, payload: {
          dataUri: page.id === decoy.id ? `data:image/png;base64,${DECOY_PNG.toString('base64')}` : DATA_URI,
        } });
        expect(uploaded.statusCode, uploaded.body).toBe(200);
      }
    }
    actor = owner;
    if (target && targetHidden) await query('UPDATE pages SET inherit_perms = FALSE WHERE id = $1', [target.id]);
    if (scenario === 'collision-hidden-decoy') await query('UPDATE pages SET inherit_perms = FALSE WHERE id = $1', [decoy.id]);
    await invalidateRbacCache();
    if (operation.code === 'L14' || operation.code === 'L15') {
      await seedViewer(raw, owner);
      await seedViewer(String(canonical.id), owner);
      await seedViewer(attachmentKey(decoy), other);
      if (raw === attachmentKey(decoy)) await seedViewer(String(canonical.id), other);
    }
    return { target, canonical, decoy };
  }

  async function decoyState(page: Page) {
    const files = await fileState();
    return {
      page: (await query('SELECT to_jsonb(p) AS page FROM pages p WHERE id = $1', [page.id])).rows,
      history: (await query('SELECT to_jsonb(v) AS version FROM page_versions v WHERE page_id = $1 ORDER BY version_number', [page.id])).rows,
      files: Object.fromEntries(Object.entries(files).filter(([name]) =>
        name.startsWith(`${attachmentKey(page)}/`) || name.startsWith(`local/${page.id}/`) || name.startsWith(`page-icons/${page.id}/`))),
    };
  }

  async function assertLegacySuccess(operation: LegacyCase, raw: string, page: Page) {
    const before = (await query<Page>('SELECT * FROM pages WHERE id = $1', [page.id])).rows[0]!;
    const fetchCount = imageFetches.length;
    const providerCount = llmRequests.length;
    const response = await legacyRequest(operation, raw);
    expect(response.statusCode, response.body).toBe(operation.code === 'L14' || operation.code === 'L15' ? 204 : 200);
    const after = (await query<Page>('SELECT * FROM pages WHERE id = $1', [page.id])).rows[0];
    let body: unknown = operation.code === 'L12'
      ? { contentType: response.headers['content-type'], sha256: createHash('sha256').update(response.rawPayload).digest('hex') }
      : response.body ? response.json() : null;
    switch (operation.code) {
      case 'L01':
        expect(response.json()).toMatchObject({ id: String(page.id), confluenceId: page.confluence_id, title: 'ID target', bodyHtml: before.body_html, version: before.version });
        break;
      case 'L02':
        expect(response.json()).toEqual({ id: page.id, title: 'Updated', version: 2, source: 'confluence' });
        expect(after).toMatchObject({ title: 'Updated', body_html: '<p>Updated</p>', version: 2, confluence_id: page.confluence_id });
        break;
      case 'L03':
      case 'L03-permanent':
        expect(response.json()).toEqual({ message: 'Page removed locally. Confluence is disconnected, so the Confluence page was left untouched.' });
        expect(after).toBeUndefined();
        expect((await fileState())[`${attachmentKey(page)}/id-boundary.png`]).toBeUndefined();
        break;
      case 'L04':
        expect(response.json()).toEqual({ suggestedTags: [], existingLabels: before.labels });
        expect(after!.labels).toEqual(before.labels);
        break;
      case 'L05':
        expect(response.json()).toEqual({ labels: after!.labels });
        expect(after!.labels).toEqual(expect.arrayContaining(['keep-me', 'architecture']));
        break;
      case 'L06':
        expect(response.json()).toEqual({ labels: after!.labels });
        expect(after!.labels).toEqual(expect.arrayContaining(['keep-me', 'id-boundary-tag']));
        expect(after!.labels).not.toContain('remove-me');
        break;
      case 'L07':
      case 'L09': {
        expect(response.json()).toEqual({ success: true });
        const review = await query<{ exact: boolean }>(
          "SELECT next_review_at = verified_at + review_interval_days * interval '1 day' AS exact FROM pages WHERE id = $1", [page.id],
        );
        expect(review.rows[0]!.exact).toBe(true);
        expect(after!.review_interval_days).toBe(30);
        if (operation.code === 'L07') {
          expect(after!.verified_by).toBe(owner);
          expect(after!.verified_at!.getTime()).toBeGreaterThan(new Date('2020-01-01T00:00:00Z').getTime());
        } else expect(after!.verified_at).toEqual(before.verified_at);
        break;
      }
      case 'L08':
        expect(response.json()).toEqual({ success: true });
        expect(after!.owner_id).toBe(other);
        break;
      case 'L10':
        expect(response.json()).toMatchObject({ icon: { kind: 'lucide', value: 'book' } });
        expect(after).toMatchObject({ icon_kind: 'lucide', icon_value: 'book' });
        break;
      case 'L11': {
        const sha = createHash('sha256').update(PNG).digest('hex');
        expect(response.json()).toMatchObject({ icon: { kind: 'image', value: sha } });
        expect(after).toMatchObject({ icon_kind: 'image', icon_value: sha });
        const fetched = await app.inject({ method: 'GET', url: `/api/pages/${page.id}/icon-image` });
        expect(fetched.statusCode, fetched.body).toBe(200);
        expect(fetched.rawPayload).toEqual(PNG);
        break;
      }
      case 'L12':
        expect(response.headers['content-type']).toBe('image/png');
        expect(response.rawPayload).toEqual(PNG);
        break;
      case 'L14':
        expect(response.body).toBe('');
        expect(await getActiveViewers(raw)).toEqual(expect.arrayContaining([expect.objectContaining({ userId: owner, isEditing: false })]));
        body = await getActiveViewers(raw);
        break;
      case 'L15':
        expect(response.body).toBe('');
        expect((await getActiveViewers(raw)).some((viewer) => viewer.userId === owner)).toBe(false);
        body = await getActiveViewers(raw);
        break;
      case 'L16':
        expect(response.json()).toMatchObject({ pageId: raw, backfillStatus: 'skipped_confluence_off' });
        expect(response.json<{ versions: unknown[] }>().versions).toEqual(expect.arrayContaining([
          expect.objectContaining({ versionNumber: 1, title: 'Historical target' }),
          expect.objectContaining({ versionNumber: 2, title: 'ID target' }),
        ]));
        break;
      case 'L17':
        expect(response.json()).toMatchObject({ versionNumber: 1, confluenceId: page.confluence_id, title: 'ID target', bodyHtml: before.body_html });
        break;
      case 'L18':
        expect(response.json()).toEqual({ diff: 'identifier diff', v1: 1, v2: 1, pageId: raw });
        expect(llmRequests.length - providerCount).toBe(1);
        expect(JSON.stringify(llmRequests.at(-1))).toContain('ID target body');
        expect(JSON.stringify(llmRequests.at(-1))).not.toContain('ID decoy');
        expect((await query('SELECT version_number, body_html FROM page_versions WHERE page_id = $1', [page.id])).rows).toEqual([
          { version_number: 1, body_html: before.body_html },
        ]);
        break;
      case 'L19':
        expect(response.json()).toEqual({ id: page.id, title: 'Historical target', version: 4, restoredFrom: 1, source: 'confluence', pushedToConfluence: false });
        expect(after).toMatchObject({ title: 'Historical target', body_html: '<p>Historical target body</p>', version: 4, confluence_id: page.confluence_id });
        expect((await query('SELECT title, body_html FROM page_versions WHERE page_id = $1 AND version_number = 3', [page.id])).rows).toEqual([
          { title: before.title, body_html: before.body_html },
        ]);
        break;
      case 'L20':
      case 'L21': {
        const url = response.json<{ url: string }>().url;
        expect(url.startsWith(`/api/attachments/${encodeURIComponent(attachmentKey(page))}/`)).toBe(true);
        const filename = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
        if (operation.code === 'L20') expect(filename).toBe('id-boundary.png');
        const file = cachedAttachmentPath(attachmentKey(page), filename);
        expect(file).not.toBeNull();
        expect(await readFile(file!)).toEqual(PNG);
        body = { attachmentKey: '$target-attachment-key', bytes: PNG.toString('base64') };
        expect(imageFetches.length - fetchCount).toBe(operation.code === 'L21' ? 1 : 0);
        break;
      }
    }
    if (operation.code !== 'L18') expect(llmRequests.length).toBe(providerCount);
    if (operation.code !== 'L21') expect(imageFetches.length).toBe(fetchCount);
    const pending = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM page_write_intents WHERE status = 'pending' AND $1 = ANY(page_ids)", [page.id],
    );
    expect(pending.rows[0]!.count).toBe(0);
    return { body: projectedResponse(body, page, raw),
      contentDelta: after ? (BigInt(after.content_revision) - BigInt(before.content_revision)).toString() : 'deleted',
      lifecycleDelta: after ? (BigInt(after.lifecycle_revision) - BigInt(before.lifecycle_revision)).toString() : 'deleted',
      versionDelta: after ? after.version - before.version : 'deleted' };
  }

  async function assertLegacyDenied(operation: LegacyCase, raw: string, target: Page | null, hidden: boolean) {
    const canonicalRaw = target ? String(target.id) : '1999999999';
    if (operation.code === 'L14' || operation.code === 'L15') {
      for (const key of [raw, canonicalRaw]) {
        ownedPresenceKeys.add(`presence:viewers:${key}`);
        ownedPresenceKeys.add(`presence:editing:${key}`);
      }
      ownedPresenceKeys.add(`presence:meta:${owner}`);
      if (operation.code === 'L15') await seedViewer(raw, owner);
    }
    const before = await observableState();
    const canonical = await legacyRequest(operation, canonicalRaw);
    const response = await legacyRequest(operation, raw);
    const status = hidden ? operation.hidden : operation.code === 'L15' ? 204 : operation.code === 'L16' ? 200 : 404;
    expect.soft(canonical.statusCode, canonical.body).toBe(status);
    expect.soft(response.statusCode, response.body).toBe(status);
    if (operation.code === 'L16') expect.soft(response.json()).toEqual({ versions: [], pageId: raw });
    else if (operation.code === 'L15') expect.soft(response.body).toBe('');
    else expect.soft(response.body).toBe(canonical.body);
    assertNoPageDisclosure(response.body);
    expect(await observableState()).toEqual(before);
  }

  for (const operation of legacyCases) {
    for (const raw of ['2147483648', '3000000000', '9007199254740993']) {
      it(`#1739 RED R-${operation.code} missing large ${raw}`, async () => {
        await assertLegacyDenied(operation, raw, null, false);
      });
    }
    for (const raw of ['3000000000', '0003000000000', '9007199254740993']) {
      it(`#1739 RED ${operation.code} exact raw text ${raw} matches canonical-PK effects`, async () => {
        const fixture = await arrangeLegacy(operation, raw);
        const decoyBefore = await decoyState(fixture.decoy);
        const decoyViewers = await getActiveViewers(attachmentKey(fixture.decoy));
        try {
          const canonical = await assertLegacySuccess(operation, String(fixture.canonical.id), fixture.canonical);
          const actual = await assertLegacySuccess(operation, raw, fixture.target!);
          expect(actual).toEqual(canonical);
        } finally {
          expect(await decoyState(fixture.decoy)).toEqual(decoyBefore);
          expect(await getActiveViewers(attachmentKey(fixture.decoy))).toEqual(decoyViewers);
        }
      });
      it(`#1739 RED ${operation.code} hidden raw text ${raw} preserves canonical denial`, async () => {
        const fixture = await arrangeLegacy(operation, raw, 'large-hidden');
        await assertLegacyDenied(operation, raw, fixture.target, true);
      });
    }
    for (const variant of ['canonical', 'padded', 'opaque'] as const) {
      it(`#1739 CONTROL ${operation.code} valid ${variant} identifier preserves exact effects`, async () => {
        const fixture = await arrangeLegacy(operation, 'conf-id-control');
        const input = variant === 'canonical' ? String(fixture.target!.id)
          : variant === 'padded' ? `000${fixture.target!.id}` : 'conf-id-control';
        if (operation.code === 'L14' || operation.code === 'L15') await seedViewer(input, owner);
        const decoyBefore = await decoyState(fixture.decoy);
        const canonical = await assertLegacySuccess(operation, String(fixture.canonical.id), fixture.canonical);
        const actual = await assertLegacySuccess(operation, input, fixture.target!);
        expect(actual).toEqual(canonical);
        expect(await decoyState(fixture.decoy)).toEqual(decoyBefore);
      });
    }
    it(`#1739 CONTROL ${operation.code} unknown opaque text keeps existing missing result`, async () => {
      await assertLegacyDenied(operation, 'unknown-opaque', null, false);
    });
    it(`#1739 CONTROL ${operation.code} maximum int4 PK remains reachable`, async () => {
      const fixture = await arrangeLegacy(operation, '2147483647', 'max');
      const decoyBefore = await decoyState(fixture.decoy);
      const canonical = await assertLegacySuccess(operation, String(fixture.canonical.id), fixture.canonical);
      const actual = await assertLegacySuccess(operation, '2147483647', fixture.target!);
      expect(actual).toEqual(canonical);
      expect(await decoyState(fixture.decoy)).toEqual(decoyBefore);
    });
    for (const raw of ['2000000000', '0002000000000']) {
      for (const scenario of [
        'collision-readable', 'collision-hidden-decoy', 'collision-private-decoy',
        'collision-hidden-target', 'collision-private-target', 'collision-missing-target',
      ]) {
        it(`#1739 CONTROL ${operation.code} ${scenario} ${raw} preserves PK precedence`, async () => {
          const fixture = await arrangeLegacy(operation, raw, scenario);
          if (scenario.endsWith('target')) {
            await assertLegacyDenied(operation, raw, fixture.target, scenario !== 'collision-missing-target');
            return;
          }
          const before = await decoyState(fixture.decoy);
          const beforeOther = (await getActiveViewers(attachmentKey(fixture.decoy))).filter((viewer) => viewer.userId === other);
          const canonical = await assertLegacySuccess(operation, String(fixture.canonical.id), fixture.canonical);
          const actual = await assertLegacySuccess(operation, raw, fixture.target!);
          expect(actual).toEqual(canonical);
          expect(await decoyState(fixture.decoy)).toEqual(before);
          expect((await getActiveViewers(attachmentKey(fixture.decoy))).filter((viewer) => viewer.userId === other)).toEqual(beforeOther);
        });
      }
    }
  }

  async function pkRequest(operation: PkCase, raw: string) {
    const base = operation.attachment ? '/api/local-attachments/' : '/api/pages/';
    return app.inject({ method: operation.method, url: `${base}${raw}${operation.suffix}`,
      ...(operation.payload ? { payload: operation.payload } : {}) });
  }

  for (const operation of pkCases) {
    for (const raw of ['abc', '2147483648', '3000000000', '9007199254740993']) {
      const alreadyRejected = operation.parser === 'bounded' ||
        (raw === 'abc' && operation.parser !== 'raw' && (operation.parser !== 'parse-int' || operation.code === 'P08' || operation.code === 'P09')) ||
        (raw === '9007199254740993' && operation.parser === 'coerce');
      it(`#1739 ${alreadyRejected ? 'CONTROL' : 'RED'} R-${operation.code} PK-only ${raw} cannot use text arm`, async () => {
        await seedPage({ raw, title: 'ID decoy', marker: 'ID decoy body' });
        actor = operation.admin ? admin : owner;
        const before = await observableState();
        const response = await pkRequest(operation, raw);
        expect.soft(response.statusCode, response.body).toBe(400);
        assertNoPageDisclosure(response.body);
        expect.soft(response.headers['content-type']).not.toContain('application/pdf');
        expect(await observableState()).toEqual(before);
      });
    }
    it(`#1739 CONTROL ${operation.code} missing valid maximum PK is not invalid input`, async () => {
      actor = operation.admin ? admin : owner;
      const before = await observableState();
      const response = await pkRequest(operation, '2147483647');
      expect.soft(response.statusCode, response.body).toBe(404);
      expect(await observableState()).toEqual(before);
    });
  }

  for (const operation of pkCases.filter((entry) => ['P01', 'P02', 'P03', 'P04', 'P06', 'P08', 'P09'].includes(entry.code))) {
    it(`#1739 RED ${operation.code} rejects a valid-PK prefix without touching it`, async () => {
      const page = await seedPage();
      if (operation.code === 'P09') {
        await query('INSERT INTO pinned_pages (user_id, page_id, pin_order) VALUES ($1, $2, 1)', [owner, page.id]);
      }
      const before = await observableState();
      const response = await pkRequest(operation, `${page.id}tail`);
      expect.soft(response.statusCode, response.body).toBe(400);
      assertNoPageDisclosure(response.body);
      expect(await observableState()).toEqual(before);
    });
  }

  for (const route of ['export', 'policy'] as const) {
    for (const invalid of [3_000_000_000, '3000000000']) {
      for (const mixed of [false, true]) {
        it(`#1739 RED ${route === 'export' ? 'R-P07' : 'R-P29'} ${typeof invalid} mixed=${mixed} is atomic400`, async () => {
          const page = await seedPage();
          await seedPage({ raw: '3000000000', marker: 'ID decoy body' });
          const ids = mixed ? [page.id, invalid] : [invalid];
          const before = await observableState();
          const response = await app.inject(route === 'export' ? {
            method: 'POST', url: '/api/pages/export/pdf', payload: { pageIds: ids },
          } : {
            method: 'POST', url: '/api/pages/bulk/ai-policy',
            payload: { aiPolicy: 'all', items: ids.map((pageId) => ({ pageId, expectedRevision: 0 })) },
          });
          expect.soft(response.statusCode, response.body).toBe(400);
          expect.soft(response.headers['content-type']).not.toContain('application/pdf');
          assertNoPageDisclosure(response.body);
          expect(await observableState()).toEqual(before);
        });
      }
    }
  }

  for (const spelling of ['canonical', 'padded'] as const) {
    it(`#1739 CONTROL drafts ${spelling} save/read/publish/discard retain DTOs and published content`, async () => {
      const page = await seedPage();
      const id = spelling === 'padded' ? `000${page.id}` : String(page.id);
      const saved = await app.inject({ method: 'PUT', url: `/api/pages/${id}/draft`, payload: { title: page.title, bodyHtml: '<p>New draft</p>' } });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json()).toMatchObject({ id: page.id, hasDraft: true });
      expect((await query<Page>('SELECT * FROM pages WHERE id = $1', [page.id])).rows[0]).toMatchObject({ body_html: page.body_html, version: 1, draft_body_html: '<p>New draft</p>' });
      const read = await app.inject({ method: 'GET', url: `/api/pages/${id}/draft` });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ id: page.id, bodyHtml: '<p>New draft</p>', bodyText: 'New draft', updatedBy: owner });
      const published = await app.inject({ method: 'POST', url: `/api/pages/${id}/draft/publish` });
      expect(published.statusCode, published.body).toBe(200);
      expect(published.json()).toEqual({ id: page.id, version: 2, published: true });
      expect((await query<Page>('SELECT * FROM pages WHERE id = $1', [page.id])).rows[0]).toMatchObject({ body_html: '<p>New draft</p>', version: 2, draft_body_html: null });
      await app.inject({ method: 'PUT', url: `/api/pages/${id}/draft`, payload: { title: page.title, bodyHtml: '<p>Discard me</p>' } });
      const discarded = await app.inject({ method: 'DELETE', url: `/api/pages/${id}/draft` });
      expect(discarded.statusCode, discarded.body).toBe(200);
      expect(discarded.json()).toEqual({ id: page.id, hasDraft: false });
      expect((await query<Page>('SELECT * FROM pages WHERE id = $1', [page.id])).rows[0]).toMatchObject({ body_html: '<p>New draft</p>', version: 2, draft_body_html: null });
    });
    it(`#1739 CONTROL pins ${spelling} echo raw URL, remain idempotent and delete only caller pin`, async () => {
      const page = await seedPage({ ownerId: other, visibility: 'shared' });
      const id = spelling === 'padded' ? `000${page.id}` : String(page.id);
      for (let attempt = 0; attempt < 2; attempt++) {
        const pinned = await app.inject({ method: 'POST', url: `/api/pages/${id}/pin` });
        expect(pinned.statusCode).toBe(200);
        expect(pinned.json()).toEqual({ message: 'Page pinned', pageId: id });
      }
      await query('INSERT INTO pinned_pages (user_id, page_id, pin_order) VALUES ($1, $2, 1)', [other, page.id]);
      await query("UPDATE pages SET visibility = 'private' WHERE id = $1", [page.id]);
      await invalidateRbacCache();
      expect((await app.inject({ method: 'POST', url: `/api/pages/${id}/pin` })).statusCode).toBe(404);
      const removed = await app.inject({ method: 'DELETE', url: `/api/pages/${id}/pin` });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toEqual({ message: 'Page unpinned', pageId: id });
      expect((await query('SELECT user_id, page_id FROM pinned_pages WHERE page_id = $1', [page.id])).rows).toEqual([{ user_id: other, page_id: page.id }]);
      expect((await app.inject({ method: 'DELETE', url: `/api/pages/${id}/pin` })).statusCode).toBe(404);
    });
  }

  for (const padded of [false, true]) {
    it(`#1739 CONTROL valid comment/feedback/view/connections/policy PKs preserve public DTOs padded=${padded}`, async () => {
      const page = await seedPage({ visibility: 'private' });
      const id = padded ? `000${page.id}` : String(page.id);
      const posted = await app.inject({ method: 'POST', url: `/api/pages/${id}/comments`, payload: { body: 'Identifier comment' } });
      expect(posted.statusCode, posted.body).toBe(201);
      expect(posted.json()).toMatchObject({ body: 'Identifier comment', reactions: {}, replies: [] });
      expect((await query('SELECT page_id, user_id, body FROM comments')).rows).toEqual([
        { page_id: page.id, user_id: owner, body: 'Identifier comment' },
      ]);
      const comments = await app.inject({ method: 'GET', url: `/api/pages/${id}/comments` });
      const canonicalComments = await app.inject({ method: 'GET', url: `/api/pages/${page.id}/comments` });
      expect(comments.statusCode).toBe(200);
      expect(comments.json()).toEqual(canonicalComments.json());
      expect(comments.json()).toMatchObject({ total: 1 });
      const vote = await app.inject({ method: 'POST', url: `/api/pages/${id}/feedback`, payload: { isHelpful: true } });
      expect(vote.statusCode).toBe(201);
      expect(vote.json()).toEqual({ id: expect.any(Number) });
      const feedback = await app.inject({ method: 'GET', url: `/api/pages/${id}/feedback` });
      expect(feedback.statusCode).toBe(200);
      expect(feedback.json()).toEqual({ helpful: 1, notHelpful: 0, total: 1, userVote: { isHelpful: true, comment: null } });
      const viewed = await app.inject({ method: 'POST', url: `/api/pages/${id}/view`, payload: { sessionId: 'id-boundary-view' } });
      expect(viewed.statusCode).toBe(201);
      expect(viewed.json()).toEqual({ recorded: true });
      const duplicate = await app.inject({ method: 'POST', url: `/api/pages/${page.id}/view`, payload: { sessionId: 'id-boundary-view' } });
      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.json()).toEqual({ recorded: false, reason: 'duplicate' });
      expect((await query('SELECT page_id, user_id, session_id FROM page_views')).rows).toEqual([
        { page_id: page.id, user_id: owner, session_id: 'id-boundary-view' },
      ]);
      const connections = await app.inject({ method: 'GET', url: `/api/pages/${id}/connections` });
      expect(connections.statusCode, connections.body).toBe(200);
      expect(connections.json()).toEqual({ linked: [], section: [], related: [] });
      const event = await app.inject({ method: 'POST', url: `/api/pages/${id}/connections/events`,
        payload: { event: 'impression', visitId: UUID } });
      expect(event.statusCode).toBe(200);
      expect(event.json()).toEqual({ recorded: true });
      expect((await query(
        "SELECT resource_id, metadata FROM audit_log WHERE action = 'CONNECTION_IMPRESSION'",
      )).rows).toEqual([{ resource_id: String(page.id), metadata: { event: 'impression', visitId: UUID } }]);
      const policy = await app.inject({ method: 'PUT', url: `/api/pages/${id}/ai-policy`,
        payload: { aiPolicy: 'all', expectedRevision: Number(page.ai_policy_revision) } });
      expect(policy.statusCode, policy.body).toBe(200);
      const storedPolicy = await query<{ ai_policy: string; ai_policy_revision: string }>(
        'SELECT ai_policy, ai_policy_revision::text FROM pages WHERE id = $1', [page.id],
      );
      expect(storedPolicy.rows[0]!.ai_policy).toBe('all');
      expect(policy.json()).toMatchObject({
        pageId: page.id, aiPolicy: 'all', aiPolicyRevision: Number(storedPolicy.rows[0]!.ai_policy_revision),
      });
    });
  }

  for (const operation of pkCases.filter((entry) => ['P01', 'P02', 'P03', 'P04', 'P10', 'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P28'].includes(entry.code))) {
    it(`#1739 CONTROL ${operation.code} hidden private page retains its current refusal and no effects`, async () => {
      const page = await seedPage({ ownerId: other, visibility: 'private' });
      const before = await observableState();
      const response = await pkRequest(operation, String(page.id));
      const expected = ['P01', 'P03', 'P04'].includes(operation.code) ? 403 : 404;
      expect.soft(response.statusCode, response.body).toBe(expected);
      assertNoPageDisclosure(response.body);
      expect(await observableState()).toEqual(before);
    });
  }

  it('#1739 CONTROL restore preserves exact owner trash batches across older intermediates', async () => {
    const stamp = '2020-02-02T12:00:00.123456Z';
    const oldStamp = '2020-02-01T12:00:00.654321Z';
    const root = await seedPage({ title: 'Trash root', deletedAt: stamp });
    const child = await seedPage({ parentId: String(root.id), deletedAt: stamp });
    const older = await seedPage({ parentId: String(root.id), deletedAt: oldStamp });
    const grandchild = await seedPage({ parentId: String(older.id), deletedAt: stamp });
    const foreign = await seedPage({ parentId: String(root.id), deletedAt: stamp, ownerId: other });
    const synced = await seedPage({ parentId: String(root.id), deletedAt: stamp, raw: 'trash-confluence' });
    actor = other;
    const before = await observableState();
    const refused = await app.inject({ method: 'POST', url: `/api/pages/${root.id}/restore` });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ reason: 'not_authorized' });
    expect(await observableState()).toEqual(before);
    actor = owner;
    const restored = await app.inject({ method: 'POST', url: `/api/pages/000${root.id}/restore` });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toEqual({ id: root.id, title: 'Trash root', restored: true });
    const selected = await query<{ id: number; live: boolean; same_stamp: boolean; older_stamp: boolean }>(
      `SELECT id, deleted_at IS NULL AS live, deleted_at = $2::timestamptz AS same_stamp,
              deleted_at = $3::timestamptz AS older_stamp FROM pages WHERE id = ANY($1::int[]) ORDER BY id`,
      [[root.id, child.id, older.id, grandchild.id, foreign.id, synced.id], stamp, oldStamp],
    );
    expect(selected.rows.filter((row) => row.live).map((row) => row.id).sort((a, b) => a - b)).toEqual([root.id, child.id, grandchild.id].sort((a, b) => a - b));
    expect(selected.rows.find((row) => row.id === older.id)?.older_stamp).toBe(true);
    expect(selected.rows.find((row) => row.id === foreign.id)?.same_stamp).toBe(true);
    expect(selected.rows.find((row) => row.id === synced.id)?.same_stamp).toBe(true);
    const audits = await query<{ metadata: { restoredCount: number } }>("SELECT metadata FROM audit_log WHERE action = 'PAGE_RESTORED'");
    expect(audits.rows.map((row) => row.metadata.restoredCount)).toEqual([3]);
    const after = await observableState();
    const repeat = await app.inject({ method: 'POST', url: `/api/pages/${root.id}/restore` });
    expect(repeat.json()).toEqual({ id: root.id, title: 'Trash root', restored: false });
    expect(await observableState()).toEqual(after);
  });

  for (const refusal of ['confluence', 'ancestor'] as const) {
    it(`#1739 CONTROL restore ${refusal} refusal remains typed and mutation-free`, async () => {
      const parent = await seedPage({ deletedAt: '2020-02-01T00:00:00Z' });
      const page = refusal === 'confluence' ? await seedPage({ raw: 'restore-source-control' })
        : await seedPage({ parentId: String(parent.id), deletedAt: '2020-02-02T00:00:00Z' });
      const before = await observableState();
      const response = await app.inject({ method: 'POST', url: `/api/pages/${page.id}/restore` });
      expect(response.statusCode).toBe(refusal === 'confluence' ? 400 : 409);
      expect(response.json()).toMatchObject({ reason: refusal === 'confluence' ? 'restore_source_invalid' : 'restore_ancestor_trashed' });
      expect(await observableState()).toEqual(before);
    });
  }

  for (const refusal of ['current', 'stale'] as const) {
    it(`#1739 CONTROL historical restore ${refusal} refusal preserves content and history`, async () => {
      const page = await seedPage({ raw: 'version-refusal-control', version: 3 });
      await seedHistory(page);
      const before = await observableState();
      const response = await app.inject({ method: 'POST',
        url: `/api/pages/${page.id}/versions/${refusal === 'current' ? 3 : 1}/restore`,
        payload: refusal === 'current' ? {} : { version: 2 } });
      expect(response.statusCode, response.body).toBe(refusal === 'current' ? 400 : 409);
      expect(await observableState()).toEqual(before);
    });
  }

  async function extractPdf(buffer: Buffer) {
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    const document = await getDocumentProxy(new Uint8Array(buffer));
    try {
      const { text } = await extractText(document, { mergePages: true });
      return { pages: document.numPages, text: String(text).replace(/\s+/g, ' ') };
    } finally {
      await document.destroy();
    }
  }

  it('#1739 CONTROL single export uses the real renderer and exact readable page', async () => {
    const page = await seedPage({ title: 'Target Export', marker: 'Visible export body' });
    const response = await app.inject({ method: 'POST', url: `/api/pages/000${page.id}/export/pdf` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toBe('attachment; filename="target-export.pdf"');
    const pdf = await extractPdf(response.rawPayload);
    expect(pdf.pages).toBeGreaterThan(0);
    expect(pdf.text).toContain('Target Export');
    expect(pdf.text).toContain('Visible export body');
    expect(pdf.text).not.toContain('ID decoy');
  });

  it('#1739 CONTROL real batch PDF filters private/ACE/trash/missing rows before merging', async () => {
    const first = await seedPage({ title: 'A Readable', marker: 'First visible body' });
    const second = await seedPage({ title: 'B Readable', marker: 'Second visible body' });
    const hidden = await seedPage({ title: 'Hidden Private', marker: 'Secret private body', ownerId: other, visibility: 'private' });
    const restricted = await seedPage({ title: 'Hidden ACE', marker: 'Secret ACE body', raw: 'export-ace' });
    await query('UPDATE pages SET inherit_perms = FALSE WHERE id = $1', [restricted.id]);
    const trash = await seedPage({ title: 'Hidden Trash', marker: 'Secret trash body', deletedAt: '2020-01-01T00:00:00Z' });
    const singlePdfs = [];
    for (const page of [first, second]) {
      const response = await app.inject({ method: 'POST', url: `/api/pages/${page.id}/export/pdf` });
      expect(response.statusCode, response.body).toBe(200);
      singlePdfs.push(await extractPdf(response.rawPayload));
    }
    const response = await app.inject({ method: 'POST', url: '/api/pages/export/pdf',
      payload: { pageIds: [second.id, hidden.id, first.id, restricted.id, trash.id, 1_999_999_999, first.id] } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-disposition']).toBe('attachment; filename="kb-export.pdf"');
    const pdf = await extractPdf(response.rawPayload);
    expect(pdf.pages).toBe(singlePdfs.reduce((sum, item) => sum + item.pages, 0));
    expect(pdf.text).toContain('First visible body');
    expect(pdf.text).toContain('Second visible body');
    expect(pdf.text.indexOf('A Readable')).toBeLessThan(pdf.text.indexOf('B Readable'));
    expect(pdf.text).not.toMatch(/Secret|Hidden/);
    const before = await observableState();
    const empty = await app.inject({ method: 'POST', url: '/api/pages/export/pdf', payload: { pageIds: [hidden.id, restricted.id, trash.id, 1_999_999_999] } });
    expect(empty.statusCode).toBe(404);
    expect(empty.body).toContain('No pages found');
    for (const id of [hidden.id, restricted.id, 1_999_999_999]) {
      const refused = await app.inject({ method: 'POST', url: `/api/pages/${id}/export/pdf` });
      expect(refused.statusCode).toBe(404);
      expect(refused.body).toContain('Page not found');
      expect(refused.headers['content-type']).not.toContain('application/pdf');
      expect(refused.body).not.toMatch(/Secret|Hidden/);
    }
    expect(await observableState()).toEqual(before);
  });

  for (const targetPageId of ['2147483648', '3000000000', '9007199254740993']) {
    it(`#1739 RED R-P17 click target ${targetPageId} rejects at schema before audit`, async () => {
      const source = await seedPage();
      await seedPage({ raw: targetPageId, marker: 'ID decoy body' });
      const before = await observableState();
      const response = await app.inject({ method: 'POST', url: `/api/pages/${source.id}/connections/events`,
        payload: { event: 'connection_click', visitId: UUID, targetPageId, group: 'related' } });
      expect.soft(response.statusCode, response.body).toBe(400);
      expect(await observableState()).toEqual(before);
    });
  }

  for (const sourceAccess of ['readable', 'hidden', 'missing'] as const) {
    for (const targetAccess of ['readable', 'hidden', 'missing'] as const) {
      it(`#1739 CONTROL connection source=${sourceAccess} target=${targetAccess} preserves source-first access`, async () => {
        const source = sourceAccess === 'missing' ? null : await seedPage({ ownerId: sourceAccess === 'hidden' ? other : owner, visibility: 'private' });
        const target = targetAccess === 'missing' ? null : await seedPage({ ownerId: targetAccess === 'hidden' ? other : owner, visibility: 'private' });
        const visitId = randomUUID();
        const sourceId = source?.id ?? 1_999_999_998;
        const targetId = target?.id ?? 1_999_999_999;
        const before = await observableState();
        const response = await app.inject({ method: 'POST', url: `/api/pages/${sourceId}/connections/events`,
          payload: { event: 'connection_click', visitId, targetPageId: String(targetId), group: 'related' } });
        const audit = await query<{ user_id: string; action: string; resource_type: string; resource_id: string; metadata: unknown }>(
          "SELECT user_id, action, resource_type, resource_id, metadata FROM audit_log WHERE action = 'CONNECTION_CLICK'",
        );
        if (sourceAccess === 'readable' && targetAccess === 'readable') {
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual({ recorded: true });
          expect(audit.rows).toEqual([{ user_id: owner, action: 'CONNECTION_CLICK', resource_type: 'page_connections', resource_id: String(sourceId), metadata: { event: 'connection_click', visitId, group: 'related' } }]);
        } else {
          expect(response.statusCode).toBe(404);
          expect(response.json()).toEqual({ error: sourceAccess === 'readable' ? 'Target page not found' : 'Page not found' });
          expect(audit.rows).toEqual([]);
          expect(await observableState()).toEqual(before);
        }
      });
    }
  }

  for (const hidden of [false, true]) {
    it(`#1739 CONTROL invalid click grammar is parsed before source authorization hidden=${hidden}`, async () => {
      const source = await seedPage({ ownerId: hidden ? other : owner, visibility: 'private' });
      const before = await observableState();
      const response = await app.inject({ method: 'POST', url: `/api/pages/${source.id}/connections/events`,
        payload: { event: 'connection_click', visitId: UUID, targetPageId: 'abc', group: 'related' } });
      expect(response.statusCode).toBe(400);
      expect(await observableState()).toEqual(before);
    });
  }

  it('#1739 CONTROL local attachment publication/list/blob use real bytes and metadata', async () => {
    const page = await seedPage({ visibility: 'private' });
    const decoy = await seedPage({ ownerId: other, visibility: 'private', marker: 'ID decoy body' });
    actor = other;
    const seeded = await app.inject({ method: 'PUT', url: `/api/local-attachments/${decoy.id}/id-boundary.png`, payload: { dataUri: `data:image/png;base64,${DECOY_PNG.toString('base64')}` } });
    expect(seeded.statusCode).toBe(200);
    actor = owner;
    const before = await decoyState(decoy);
    const uploaded = await app.inject({ method: 'PUT', url: `/api/local-attachments/000${page.id}/id-boundary.png`, payload: { dataUri: DATA_URI } });
    const sha = createHash('sha256').update(PNG).digest('hex');
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(uploaded.json()).toEqual({ success: true, filename: 'id-boundary.png', size: PNG.length, sha256: sha });
    expect((await query('SELECT page_id, filename, size_bytes::int AS size_bytes, sha256 FROM local_attachments WHERE page_id = $1', [page.id])).rows).toEqual([{ page_id: page.id, filename: 'id-boundary.png', size_bytes: PNG.length, sha256: sha }]);
    const listed = await app.inject({ method: 'GET', url: `/api/local-attachments/${page.id}/list` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ attachments: [{ filename: 'id-boundary.png', size: PNG.length, sha256: sha, url: `/api/local-attachments/${page.id}/id-boundary.png` }] });
    const downloaded = await app.inject({ method: 'GET', url: `/api/local-attachments/${page.id}/id-boundary.png` });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers['content-type']).toBe('image/png');
    expect(downloaded.rawPayload).toEqual(PNG);
    expect(await decoyState(decoy)).toEqual(before);
    expect((await query("SELECT id FROM page_write_intents WHERE status = 'pending'")).rows).toEqual([]);
  });

  for (const access of ['hidden', 'missing'] as const) {
    for (const action of ['list', 'read', 'write'] as const) {
      it(`#1739 CONTROL local attachment ${action} ${access} has no file/metadata/intent effect`, async () => {
        const page = access === 'hidden' ? await seedPage({ ownerId: other, visibility: 'private', marker: 'ID decoy body' }) : null;
        if (page) {
          actor = other;
          const response = await app.inject({ method: 'PUT', url: `/api/local-attachments/${page.id}/id-boundary.png`, payload: { dataUri: DATA_URI } });
          expect(response.statusCode).toBe(200);
          actor = owner;
        }
        const before = await observableState();
        const id = page?.id ?? 1_999_999_999;
        const response = await app.inject({ method: action === 'write' ? 'PUT' : 'GET',
          url: `/api/local-attachments/${id}/${action === 'list' ? 'list' : 'id-boundary.png'}`,
          ...(action === 'write' ? { payload: { dataUri: DATA_URI } } : {}) });
        expect(response.statusCode, response.body).toBe(access === 'hidden' && action !== 'read' ? 403 : 404);
        if (action === 'list' || action === 'write') expect(response.json()).toMatchObject({ error: access === 'hidden' ? 'FORBIDDEN' : 'PAGE_NOT_FOUND' });
        expect(response.body).not.toContain('ID decoy body');
        expect(await observableState()).toEqual(before);
      });
    }
  }

  for (const padded of [false, true]) {
    it(`#1739 CONTROL move/reorder/breadcrumb retain canonical hierarchy padded=${padded}`, async () => {
      const root = await seedPage({ title: 'Root' });
      const page = await seedPage({ title: 'Moved' });
      const child = await seedPage({ title: 'Child', parentId: String(page.id) });
      await query('UPDATE pages SET path = $2, depth = 1 WHERE id = $1', [child.id, `/${page.id}/${child.id}`]);
      const id = padded ? `000${page.id}` : String(page.id);
      const moved = await app.inject({ method: 'PUT', url: `/api/pages/${id}/move`, payload: { parentId: String(root.id) } });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json()).toEqual({ id: page.id, parentId: String(root.id), spaceKey: 'IDLOCAL', path: `/${root.id}/${page.id}`, depth: 1 });
      expect((await query('SELECT path, depth FROM pages WHERE id = $1', [child.id])).rows).toEqual([{ path: `/${root.id}/${page.id}/${child.id}`, depth: 2 }]);
      const first = await seedPage({ title: 'First', parentId: String(root.id) });
      const second = await seedPage({ title: 'Second', parentId: String(root.id) });
      await query('UPDATE pages SET sort_order = CASE id WHEN $1 THEN 0 WHEN $2 THEN 1 ELSE 2 END WHERE id = ANY($3::int[])', [first.id, second.id, [first.id, second.id, page.id]]);
      const reordered = await app.inject({ method: 'PUT', url: `/api/pages/${id}/reorder`, payload: { sortOrder: 0 } });
      expect(reordered.statusCode).toBe(200);
      expect(reordered.json()).toEqual({ id: page.id, sortOrder: 0 });
      expect((await query('SELECT id, sort_order FROM pages WHERE parent_id = $1 ORDER BY sort_order', [String(root.id)])).rows).toEqual([
        { id: page.id, sort_order: 0 }, { id: first.id, sort_order: 1 }, { id: second.id, sort_order: 2 },
      ]);
      const crumb = await app.inject({ method: 'GET', url: `/api/pages/${padded ? '000' : ''}${child.id}/breadcrumb` });
      expect(crumb.statusCode).toBe(200);
      expect(crumb.json()).toEqual({ spaceKey: 'IDLOCAL', spaceName: 'ID Local', source: 'local', ancestors: [{ id: root.id, title: 'Root' }, { id: page.id, title: 'Moved' }], current: { id: child.id, title: 'Child' } });
      await query("UPDATE pages SET visibility = 'private', created_by_user_id = $2 WHERE id = $1", [page.id, other]);
      await invalidateRbacCache();
      const rerooted = await app.inject({ method: 'GET', url: `/api/pages/${child.id}/breadcrumb` });
      expect(rerooted.json()).toEqual({ spaceKey: 'IDLOCAL', spaceName: 'ID Local', source: 'local', ancestors: [], current: { id: child.id, title: 'Child' } });
    });
  }

  for (const raw of ['3000000000', '0003000000000', '9007199254740993']) {
    for (const suffix of ['children', 'has-children']) {
      it(`#1739 CONTROL true-D ${suffix} retains large raw ${raw}`, async () => {
        const parent = await seedPage({ raw });
        const child = await seedPage({ parentId: raw, title: 'Visible child' });
        const response = await app.inject({ method: 'GET', url: `/api/pages/${raw}/${suffix}` });
        expect(response.statusCode, response.body).toBe(200);
        if (suffix === 'has-children') expect(response.json()).toEqual({ hasChildren: true });
        else expect(response.json<{ children: unknown[] }>().children).toEqual(expect.arrayContaining([expect.objectContaining({ id: child.id, title: 'Visible child' })]));
        expect((await query<Page>('SELECT * FROM pages WHERE id = $1', [parent.id])).rows[0]!.confluence_id).toBe(raw);
      });
    }
  }

  for (const hidden of [false, true]) {
    for (const suffix of ['children', 'has-children']) {
      it(`#1739 CONTROL true-D ${suffix} preserves ambiguity/non-disclosure hidden=${hidden}`, async () => {
        const parent = await seedPage({ raw: '2000000000' });
        await seedPage({ id: 2_000_000_000, ownerId: other, visibility: hidden ? 'private' : 'shared' });
        await seedPage({ parentId: '2000000000', title: 'Ambiguous child' });
        const before = await observableState();
        const response = await app.inject({ method: 'GET', url: `/api/pages/${parent.id}/${suffix}` });
        expect(response.statusCode).toBe(hidden ? 200 : 409);
        if (hidden) expect(response.json()).toEqual(suffix === 'children' ? { children: [] } : { hasChildren: false });
        else expect(response.body).toContain('Page identifier is ambiguous');
        expect(await observableState()).toEqual(before);
      });
    }
  }

  for (const operation of pkCases.filter((entry) => entry.admin)) {
    it(`#1739 CONTROL ${operation.code} global denial precedes oversized-ID parsing`, async () => {
      actor = owner;
      const before = await observableState();
      const response = await pkRequest(operation, '3000000000');
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ message: 'Permission "pages:relocate" required' });
      expect(await observableState()).toEqual(before);
    });
  }

  it('#1739 CONTROL authenticated boundaries still reject an unauthenticated request first', async () => {
    actor = null;
    const response = await app.inject({ method: 'GET', url: '/api/pages/3000000000' });
    expect(response.statusCode).toBe(401);
  });
});
