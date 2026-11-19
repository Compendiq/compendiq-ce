/**
 * #1773 — a sync that brings a newer upstream version of an existing page
 * keeps the attachment-cache files that local content still names.
 *
 * Real PostgreSQL and Redis; the real routes (`POST /api/pages/:id/images`,
 * `PUT /api/pages/:id/draft`, `PUT /api/pages/:id`, `GET /api/attachments/…`);
 * the real `ConfluenceClient` against the in-process HTTP fixture below, the
 * only stand-in for Confluence; and a temp ATTACHMENTS_DIR. The AC6 case also
 * spies on `fs.rm` so that one delete fails.
 *
 * Scope: every fixture is a `source = 'confluence'` page. A standalone page
 * whose id equals a Confluence page's directory key is out of scope (design R2).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import fs, { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { isRedisAvailable } from '../../../test-redis-helper.js';
import { query } from '../../../core/db/postgres.js';
import { attachmentCacheDir } from '../../../core/services/attachment-store.js';
import { confluenceToHtml, htmlToText } from '../../../core/services/content-converter.js';
import { setRedisClient } from '../../../core/services/redis-cache.js';
import { REAL_PNG_40x30_BASE64 } from '../../../core/services/test-image-fixtures.js';
import { saveVersionSnapshotByPageId } from '../../../core/services/version-snapshot.js';
import { encryptPat } from '../../../core/utils/crypto.js';
import { logger } from '../../../core/utils/logger.js';
import { buildKnowledgeTestApp } from '../../../routes/knowledge/pages.test-helpers.js';
import { pagesCrudRoutes } from '../../../routes/knowledge/pages-crud.js';
import { attachmentRoutes } from '../../../routes/confluence/attachments.js';
import { ConfluenceClient, type ConfluencePage } from './confluence-client.js';
import { registerOrdinaryPageWriteReconcilers } from './ordinary-page-write-reconciler.js';
import { __internal } from './sync-service.js';

// The ordinary Confluence cache and its readers capture their root at module
// initialisation, while the removal helpers resolve it per call. Set the
// fixture root before the production import graph is evaluated so both agree.
// `vi.hoisted` runs before the static imports, so its built-ins load here.
const { attachmentsRoot, originalAttachmentsRoot } = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const attachmentsRoot = join(tmpdir(), `sync-version-jump-cache-${globalThis.crypto.randomUUID()}`);
  const originalAttachmentsRoot = process.env.ATTACHMENTS_DIR;
  process.env.ATTACHMENTS_DIR = attachmentsRoot;
  return { attachmentsRoot, originalAttachmentsRoot };
});

const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);
const SPACE_KEY = 'DEV';
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_B = Buffer.from(REAL_PNG_40x30_BASE64, 'base64');
const XML_OLD = '<mxfile><diagram>old</diagram></mxfile>';
const XML_NEW = '<mxfile><diagram>new</diagram></mxfile>';
/** A draw.io classification receipt: a dot-file no reader can address. */
const RECEIPT = `.drawio-bare-${'0'.repeat(64)}`;
const REFUSED_DELETE = 'Version-jump attachment cleanup could not remove a cached file';

const requestedPaths: string[] = [];
const upstreamPages = new Map<string, ConfluencePage>();
const upstreamAttachments = new Map<string, Map<string, Buffer>>();
let baseUrl = '';
let client: ConfluenceClient;
let app: FastifyInstance;
let redis: RedisClientType;
let bobId = '';

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function listing(results: unknown[]): Record<string, unknown> {
  return { results, start: 0, limit: 200, size: results.length, _links: {} };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://fixture.test');
  requestedPaths.push(url.pathname);

  if (url.pathname === '/rest/api/space') {
    json(response, 200, listing([{ key: SPACE_KEY, name: 'Development', type: 'global', status: 'current' }]));
    return;
  }

  if (url.pathname === '/rest/api/content') {
    const pages = [...upstreamPages.values()];
    json(response, 200, listing(url.searchParams.has('expand') ? pages : pages.map(({ id }) => ({ id }))));
    return;
  }

  const attachmentList = url.pathname.match(/^\/rest\/api\/content\/([^/]+)\/child\/attachment$/);
  if (attachmentList) {
    const pageId = decodeURIComponent(attachmentList[1]!);
    const files = upstreamAttachments.get(pageId) ?? new Map<string, Buffer>();
    json(response, 200, listing([...files].map(([title, bytes], index) => ({
      id: `att-${pageId}-${index + 1}`,
      title,
      mediaType: 'image/png',
      metadata: { mediaType: 'image/png' },
      extensions: { mediaType: 'image/png', fileSize: bytes.length },
      _links: { download: `/download/${encodeURIComponent(pageId)}/${encodeURIComponent(title)}` },
      version: { number: 2, when: '2026-11-10T09:00:00.000Z' },
    }))));
    return;
  }

  const download = url.pathname.match(/^\/download\/([^/]+)\/([^/]+)$/);
  if (download) {
    const bytes = upstreamAttachments.get(decodeURIComponent(download[1]!))?.get(decodeURIComponent(download[2]!));
    if (!bytes) {
      json(response, 404, { message: 'Missing fixture attachment' });
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
    response.end(bytes);
    return;
  }

  const pageMatch = url.pathname.match(/^\/rest\/api\/content\/([^/]+)$/);
  if (pageMatch) {
    const page = upstreamPages.get(decodeURIComponent(pageMatch[1]!));
    if (page) json(response, 200, page);
    else json(response, 404, { message: 'Not found upstream' });
    return;
  }

  json(response, 404, { message: `Unhandled fixture path ${url.pathname}` });
}

const upstream = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
  });
});

function image(filename: string): string {
  return `<ac:image><ri:attachment ri:filename="${filename}" /></ac:image>`;
}

function diagram(name: string): string {
  return `<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">${name}</ac:parameter></ac:structured-macro>`;
}

function remotePage(id: string, version: number, storage: string): ConfluencePage {
  return {
    id,
    title: `Page ${id}`,
    status: 'current',
    type: 'page',
    version: { number: version, when: '2026-11-10T10:00:00.000Z', by: { displayName: 'Fixture Author' } },
    body: { storage: { value: storage } },
    ancestors: [],
    metadata: { labels: { results: [] } },
  };
}

async function seedBob(): Promise<string> {
  const suffix = randomUUID();
  const user = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, 'x', 'user') RETURNING id`,
    [`bob-${suffix}`, `bob-${suffix}@test.invalid`],
  );
  const userId = user.rows[0]!.id;
  await query(
    `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
     VALUES ($1, $2, $3, TRUE)`,
    [userId, baseUrl, encryptPat('fixture-pat')],
  );
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, permissions)
     VALUES ($1, 'Version-jump editor', ARRAY['read', 'write']) RETURNING id`,
    [`version-jump-editor-${suffix}`],
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)`,
    [SPACE_KEY, userId, role.rows[0]!.id],
  );
  return userId;
}

/** A Confluence page synced at `version`, its body converted the way sync stores it. */
async function seedPage(
  confluenceId: string,
  version: number,
  storage: string,
  draftBodyHtml: string | null = null,
): Promise<number> {
  const html = confluenceToHtml(storage, confluenceId, SPACE_KEY);
  const result = await query<{ id: number }>(
    `INSERT INTO pages
       (source, confluence_id, space_key, title, body_storage, body_html, body_text,
        version, visibility, inherit_perms, draft_body_html, last_synced)
     VALUES ('confluence', $1, $2, $3, $4, $5, $6, $7, 'shared', TRUE, $8, NOW())
     RETURNING id`,
    [confluenceId, SPACE_KEY, `Page ${confluenceId}`, storage, html, htmlToText(html), version, draftBodyHtml],
  );
  return result.rows[0]!.id;
}

async function seedCache(confluenceId: string, files: Record<string, Buffer | string>): Promise<void> {
  const dir = attachmentCacheDir(confluenceId);
  await mkdir(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), bytes);
}

/** Every entry of the page's cache directory, dot-files included, sorted. */
async function cacheListing(confluenceId: string): Promise<string[]> {
  return (await readdir(attachmentCacheDir(confluenceId))).sort();
}

async function cached(confluenceId: string, name: string): Promise<Buffer> {
  return readFile(join(attachmentCacheDir(confluenceId), name));
}

async function uploadImage(pageId: number, filename: string, bytes: Buffer): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/pages/${pageId}/images`,
    payload: { filename, dataUri: `data:image/png;base64,${bytes.toString('base64')}` },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ url: string }>().url;
}

async function syncVersionJump(confluenceId: string) {
  const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };
  await __internal.syncPage(client, bobId, SPACE_KEY, { id: confluenceId }, new Date(), new Map(), counts, randomUUID());
  return counts;
}

async function pageVersion(confluenceId: string): Promise<number> {
  const result = await query<{ version: number }>('SELECT version FROM pages WHERE confluence_id = $1', [confluenceId]);
  return result.rows[0]!.version;
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  '#1773 version-jump sync keeps locally referenced cache files — real PostgreSQL, Redis and HTTP',
  () => {
    beforeAll(async () => {
      await setupTestDb();
      await mkdir(attachmentsRoot, { recursive: true });
      const listening = Promise.withResolvers<void>();
      upstream.listen(0, '127.0.0.1', listening.resolve);
      await listening.promise;
      const address = upstream.address();
      if (!address || typeof address === 'string') throw new Error('Confluence fixture did not bind TCP');
      baseUrl = `http://127.0.0.1:${address.port}`;
      client = new ConfluenceClient(baseUrl, 'fixture-pat');

      redis = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: false, connectTimeout: 1_000 },
      });
      await redis.connect();
      setRedisClient(redis);

      app = await buildKnowledgeTestApp(() => bobId, async (instance) => {
        instance.redis = redis;
        await instance.register(pagesCrudRoutes, { prefix: '/api' });
        await instance.register(attachmentRoutes, { prefix: '/api' });
      });
      registerOrdinaryPageWriteReconcilers();
    }, 30_000);

    beforeEach(async () => {
      await truncateAllTables();
      await redis.flushDb();
      await rm(attachmentsRoot, { recursive: true, force: true });
      await mkdir(attachmentsRoot, { recursive: true });
      requestedPaths.length = 0;
      upstreamPages.clear();
      upstreamAttachments.clear();
      await query(`INSERT INTO spaces (space_key, space_name) VALUES ($1, 'Development')`, [SPACE_KEY]);
      bobId = await seedBob();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      await app?.close();
      setRedisClient(null);
      if (redis?.isOpen) await redis.quit();
      const closed = Promise.withResolvers<void>();
      upstream.close(() => closed.resolve());
      upstream.closeAllConnections();
      await closed.promise;
      await teardownTestDb();
      await rm(attachmentsRoot, { recursive: true, force: true });
      if (originalAttachmentsRoot === undefined) delete process.env.ATTACHMENTS_DIR;
      else process.env.ATTACHMENTS_DIR = originalAttachmentsRoot;
    });

    it('AC1: an image pasted into the draft survives an upstream version bump and is still served; a pasted image the new upstream body also names is re-downloaded and still served', async () => {
      const pageId = await seedPage('vj-draft', 1, '<p>v1</p>');
      const draftShot = await uploadImage(pageId, 'draft-shot.png', PNG_A);
      const published = await uploadImage(pageId, 'published.png', PNG_A);
      expect(draftShot).toBe('/api/attachments/vj-draft/draft-shot.png');
      const draft = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}/draft`,
        payload: { title: 'Page vj-draft', bodyHtml: `<p>draft</p><p><img src="${draftShot}"><img src="${published}"></p>` },
      });
      expect(draft.statusCode, draft.body).toBe(200);
      upstreamPages.set('vj-draft', remotePage('vj-draft', 2, `<p>v2</p>${image('published.png')}`));
      upstreamAttachments.set('vj-draft', new Map([['published.png', PNG_B]]));

      const counts = await syncVersionJump('vj-draft');

      const kept = await app.inject({ method: 'GET', url: draftShot });
      expect(kept.statusCode, kept.body).toBe(200);
      expect(kept.rawPayload).toEqual(PNG_A);
      const refreshed = await app.inject({ method: 'GET', url: published });
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      expect(refreshed.rawPayload).toEqual(PNG_B);
      expect(await pageVersion('vj-draft')).toBe(2);
      expect(counts.pagesUpdated).toBe(1);
    });

    it('AC2: an image a standalone-mode save put into the local body survives the version bump', async () => {
      const pageId = await seedPage('vj-local', 5, '<p>v5</p>');
      const localShot = await uploadImage(pageId, 'local-shot.png', PNG_A);
      await query('UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1', [bobId]);
      const save = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        payload: { title: 'Page vj-local', bodyHtml: `<p>local</p><p><img src="${localShot}"></p>`, version: 5 },
      });
      expect(save.statusCode, save.body).toBe(200);
      expect(await pageVersion('vj-local')).toBe(6);
      await query('UPDATE user_settings SET confluence_enabled = TRUE WHERE user_id = $1', [bobId]);
      upstreamPages.set('vj-local', remotePage('vj-local', 7, '<p>v7</p>'));

      await syncVersionJump('vj-local');

      const kept = await app.inject({ method: 'GET', url: localShot });
      expect(kept.statusCode, kept.body).toBe(200);
      expect(kept.rawPayload).toEqual(PNG_A);
      const row = await query<{ version: number; body_html: string }>(
        'SELECT version, body_html FROM pages WHERE id = $1',
        [pageId],
      );
      expect(row.rows[0]).toMatchObject({ version: 7 });
      expect(row.rows[0]!.body_html).not.toContain(localShot);
      const history = await query<{ body_html: string }>(
        'SELECT body_html FROM page_versions WHERE page_id = $1 AND version_number = 6',
        [pageId],
      );
      expect(history.rows[0]?.body_html).toContain(localShot);
    });

    it('AC2: a file only a page_versions row references survives the version bump', async () => {
      const pageId = await seedPage('vj-history', 2, '<p>v2</p>');
      await saveVersionSnapshotByPageId(
        pageId, 1, 'Page vj-history', '<p>v1</p><img src="/api/attachments/vj-history/history-only.png">', 'v1',
      );
      await seedCache('vj-history', { 'history-only.png': PNG_A });
      upstreamPages.set('vj-history', remotePage('vj-history', 3, '<p>v3</p>'));

      await syncVersionJump('vj-history');

      const kept = await app.inject({ method: 'GET', url: '/api/attachments/vj-history/history-only.png' });
      expect(kept.statusCode, kept.body).toBe(200);
      expect(await cached('vj-history', 'history-only.png')).toEqual(PNG_A);
    });

    it('AC3/AC4: refreshes a same-name file the incoming body references and deletes an unreferenced one, keeping local-only files and dot-file receipts', async () => {
      await seedPage(
        'vj-matrix', 1, `<p>v1</p>${image('evidence.png')}`,
        '<p>draft</p><img src="/api/attachments/vj-matrix/draft-only.png">',
      );
      await seedCache('vj-matrix', {
        'evidence.png': 'old evidence bytes',
        'orphan.png': 'orphan bytes',
        'draft-only.png': 'draft bytes',
        [RECEIPT]: 'receipt',
      });
      await redis.set(`attach:fail:vj-matrix:${encodeURIComponent('broken.png')}`, '3');
      upstreamPages.set('vj-matrix', remotePage('vj-matrix', 2, `<p>v2</p>${image('evidence.png')}`));
      upstreamAttachments.set('vj-matrix', new Map([['evidence.png', Buffer.from('new evidence bytes')]]));

      await syncVersionJump('vj-matrix');

      expect(await cacheListing('vj-matrix')).toEqual([RECEIPT, 'draft-only.png', 'evidence.png']);
      expect((await cached('vj-matrix', 'evidence.png')).toString('utf8')).toBe('new evidence bytes');
      expect((await cached('vj-matrix', 'draft-only.png')).toString('utf8')).toBe('draft bytes');
      expect(requestedPaths).toContain('/download/vj-matrix/evidence.png');
      // The Redis failure counters are cleared exactly as before.
      expect(await redis.exists(`attach:fail:vj-matrix:${encodeURIComponent('broken.png')}`)).toBe(0);
    });

    it("AC5: an incoming diagram's three files are removed and fetched again together; a local-only diagram keeps all three", async () => {
      const pageId = await seedPage('vj-drawio', 2, diagram('arch') + diagram('legacy'));
      await saveVersionSnapshotByPageId(
        pageId, 1, 'Page vj-drawio',
        '<div class="confluence-drawio" data-diagram-name="sketch" data-drawio-source="/api/attachments/vj-drawio/sketch.drawio"><img src="/api/attachments/vj-drawio/sketch.png"></div>',
        'sketch',
      );
      const localDiagrams: Record<string, Buffer | string> = {
        'legacy.png': PNG_A, 'legacy.drawio': XML_OLD, 'legacy.drawio.png': PNG_A,
        'sketch.png': PNG_A, 'sketch.drawio': XML_OLD, 'sketch.drawio.png': PNG_A,
      };
      await seedCache('vj-drawio', {
        'arch.png': PNG_A, 'arch.drawio': XML_OLD, 'arch.drawio.png': PNG_A,
        ...localDiagrams,
      });
      upstreamPages.set('vj-drawio', remotePage('vj-drawio', 3, diagram('arch')));
      upstreamAttachments.set('vj-drawio', new Map([
        ['arch.drawio', Buffer.from(XML_NEW)],
        ['arch.png', PNG_B],
        ['arch.drawio.png', PNG_B],
      ]));

      await syncVersionJump('vj-drawio');

      expect(await cacheListing('vj-drawio')).toEqual([
        'arch.drawio', 'arch.png',
        'legacy.drawio', 'legacy.drawio.png', 'legacy.png',
        'sketch.drawio', 'sketch.drawio.png', 'sketch.png',
      ]);
      expect(await cached('vj-drawio', 'arch.png')).toEqual(PNG_B);
      expect((await cached('vj-drawio', 'arch.drawio')).toString('utf8')).toBe(XML_NEW);
      for (const [name, bytes] of Object.entries(localDiagrams)) {
        expect(await cached('vj-drawio', name)).toEqual(Buffer.from(bytes));
      }
      // The removed preview comes back on demand, with the new upstream bytes.
      const preview = await app.inject({ method: 'GET', url: '/api/attachments/vj-drawio/arch.drawio.png' });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.rawPayload).toEqual(PNG_B);
      expect(requestedPaths).toContain('/download/vj-drawio/arch.drawio.png');
    });

    it('AC6: a refused delete is logged and neither the page nor the run fails', async () => {
      await seedPage(
        'vj-fsfail', 1, `<p>v1</p>${image('evidence.png')}`,
        '<p>draft</p><img src="/api/attachments/vj-fsfail/draft-only.png">',
      );
      await seedCache('vj-fsfail', {
        'evidence.png': 'old evidence bytes',
        'orphan.png': 'orphan bytes',
        'draft-only.png': 'draft bytes',
      });
      upstreamPages.set('vj-fsfail', remotePage('vj-fsfail', 2, `<p>v2</p>${image('evidence.png')}`));
      upstreamAttachments.set('vj-fsfail', new Map([['evidence.png', Buffer.from('new evidence bytes')]]));
      // One undeletable file, which also makes a recursive delete of its
      // directory fail (EACCES), whichever way the cleanup removes it.
      const dir = attachmentCacheDir('vj-fsfail');
      const realRm = fs.rm.bind(fs);
      vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
        const path = String(target);
        if (path === dir || path === join(dir, 'orphan.png')) {
          throw Object.assign(new Error(`EACCES: permission denied, rm '${path}'`), { code: 'EACCES' });
        }
        return realRm(target, options);
      });
      const warn = vi.spyOn(logger, 'warn');

      await __internal.syncSpace(client, bobId, SPACE_KEY, undefined, new Date(), new Map(), randomUUID());

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          attachmentKey: 'vj-fsfail',
          filename: 'orphan.png',
          err: expect.objectContaining({ code: 'EACCES' }),
        }),
        REFUSED_DELETE,
      );
      expect(warn).not.toHaveBeenCalledWith(expect.anything(), 'Page sync failed — skipping page and continuing sync');
      expect(await pageVersion('vj-fsfail')).toBe(2);
      expect((await cached('vj-fsfail', 'evidence.png')).toString('utf8')).toBe('new evidence bytes');
      expect(await cacheListing('vj-fsfail')).toEqual(['draft-only.png', 'evidence.png', 'orphan.png']);
      const space = await query<{ last_synced: Date | null }>(
        'SELECT last_synced FROM spaces WHERE space_key = $1',
        [SPACE_KEY],
      );
      expect(space.rows[0]!.last_synced).not.toBeNull();
    });
  },
);
