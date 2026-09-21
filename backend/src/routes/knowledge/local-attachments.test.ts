import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { setPageBaselineReadinessProvider } from '../../core/services/page-baseline-governance.js';
import {
  freezePage,
  previewPageBaseline,
  setPageBaselineCreationEnabled,
} from '../../core/services/page-baseline-service.js';
import { MAX_LOCAL_ATTACHMENT_BYTES } from '../../core/services/local-attachment-service.js';
import { REAL_PNG_40x30_BASE64 } from '../../core/services/test-image-fixtures.js';
import {
  buildKnowledgeTestApp,
  insertConfluencePage,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';

const PNG_BYTES = Buffer.from(REAL_PNG_40x30_BASE64, 'base64');
const PNG_DATA_URI = `data:image/png;base64,${REAL_PNG_40x30_BASE64}`;
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
const PDF_BYTES = Buffer.from('%PDF-1.4\n%%EOF\n');
const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);

let app: FastifyInstance;
let redis: RedisClientType;
let userId: string;
let attachmentsDir: string;
let originalAttachmentsDir: string | undefined;

function localFile(pageId: number, filename: string): string {
  return join(attachmentsDir, 'local', String(pageId), filename);
}

async function expectFileAbsent(pageId: number, filename: string): Promise<void> {
  await expect(access(localFile(pageId, filename))).rejects.toMatchObject({ code: 'ENOENT' });
}

async function seedPage(
  visibility: 'private' | 'shared' = 'private',
  ownerId = userId,
): Promise<number> {
  const spaceKey = `LOCAL-${randomUUID()}`;
  await insertLocalSpace(spaceKey, ownerId);
  return insertStandalonePage('Attachment page', visibility, ownerId, spaceKey);
}

async function upload(pageId: number, filename: string, dataUri = PNG_DATA_URI, xml?: string) {
  return app.inject({
    method: 'PUT',
    url: `/api/local-attachments/${pageId}/${encodeURIComponent(filename)}`,
    payload: { dataUri, ...(xml === undefined ? {} : { xml }) },
  });
}

async function publishBaseline(pageId: number): Promise<void> {
  const adminId = await insertUser(`attachment-admin-${randomUUID()}`);
  await query("UPDATE users SET role = 'admin' WHERE id = $1", [adminId]);
  await setPageBaselineCreationEnabled(adminId, true);
  const prepared = await previewPageBaseline(pageId, userId);
  await freezePage({
    pageId,
    actorId: userId,
    reason: 'Approved attachment evidence',
    expectedContentRevision: prepared.contentRevision,
    expectedManifestDigest: prepared.manifestDigest,
    reportedSignatories: [],
  });
}

/**
 * A fixture for legacy rows that could predate the upload MIME allowlist. It
 * deliberately uses the real DB and filesystem so the GET route still proves
 * it never reflects stored active-content MIME metadata.
 */
async function seedLegacyAttachment(
  pageId: number,
  filename: string,
  contentType: string,
  bytes: Buffer,
): Promise<void> {
  await mkdir(join(attachmentsDir, 'local', String(pageId)), { recursive: true });
  await writeFile(localFile(pageId, filename), bytes);
  await query(
    `INSERT INTO local_attachments
       (page_id, filename, content_type, size_bytes, sha256, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      pageId,
      filename,
      contentType,
      bytes.length,
      createHash('sha256').update(bytes).digest('hex'),
      userId,
    ],
  );
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  'local attachment routes — real PostgreSQL, Redis and filesystem',
  () => {
    beforeAll(async () => {
      await setupTestDb();
      redis = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: false, connectTimeout: 1_000 },
      });
      await redis.connect();
      setRedisClient(redis);
      originalAttachmentsDir = process.env.ATTACHMENTS_DIR;
      attachmentsDir = await mkdtemp(join(tmpdir(), 'local-attachment-routes-'));
      process.env.ATTACHMENTS_DIR = attachmentsDir;
      setPageBaselineReadinessProvider(async () => ({ ready: true, blockers: [] }));
      app = await buildKnowledgeTestApp(() => userId, async (instance) => {
        instance.redis = redis;
        // ATTACHMENTS_DIR is a module-loading boundary for the attachment stores,
        // so the known route import must remain after the isolated path is set.
        const { localAttachmentsRoutes } = await import('./local-attachments.js');
        await instance.register(localAttachmentsRoutes, { prefix: '/api' });
      });
    });

    afterAll(async () => {
      await app.close();
      setPageBaselineReadinessProvider(null);
      if (redis.isOpen) await redis.quit();
      await teardownTestDb();
      await rm(attachmentsDir, { recursive: true, force: true });
      if (originalAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
      else process.env.ATTACHMENTS_DIR = originalAttachmentsDir;
    });

    beforeEach(async () => {
      await truncateAllTables();
      await rm(attachmentsDir, { recursive: true, force: true });
      await mkdir(attachmentsDir, { recursive: true });
      userId = await insertUser(`local-attachment-${randomUUID()}`);
    });

    it('writes, reads and lists a genuine PNG through the public routes', async () => {
      const pageId = await seedPage();

      const put = await upload(pageId, 'diagram with spaces.png');

      expect(put.statusCode, put.body).toBe(200);
      expect(put.json()).toMatchObject({
        success: true,
        filename: 'diagram with spaces.png',
        size: PNG_BYTES.length,
        sha256: createHash('sha256').update(PNG_BYTES).digest('hex'),
      });
      expect(await readFile(localFile(pageId, 'diagram with spaces.png'))).toEqual(PNG_BYTES);

      const rows = await query<{
        filename: string;
        content_type: string;
        size_bytes: string;
      }>(
        'SELECT filename, content_type, size_bytes FROM local_attachments WHERE page_id = $1',
        [pageId],
      );
      expect(rows.rows).toEqual([{
        filename: 'diagram with spaces.png',
        content_type: 'image/png',
        size_bytes: String(PNG_BYTES.length),
      }]);
      const revision = await query<{ content_revision: string }>(
        'SELECT content_revision::text FROM pages WHERE id = $1',
        [pageId],
      );
      expect(revision.rows[0]?.content_revision).toBe('1');

      const get = await app.inject({
        method: 'GET',
        url: `/api/local-attachments/${pageId}/diagram%20with%20spaces.png`,
      });
      expect(get.statusCode, get.body).toBe(200);
      expect(get.rawPayload).toEqual(PNG_BYTES);
      expect(get.headers['content-type']).toContain('image/png');
      expect(get.headers['content-disposition']).toBe('inline');
      expect(get.headers['x-content-type-options']).toBe('nosniff');
      expect(get.headers['content-security-policy']).toBeUndefined();

      const list = await app.inject({
        method: 'GET',
        url: `/api/local-attachments/${pageId}/list`,
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().attachments).toEqual([
        expect.objectContaining({
          filename: 'diagram with spaces.png',
          size: PNG_BYTES.length,
          contentType: 'image/png',
          url: `/api/local-attachments/${pageId}/diagram%20with%20spaces.png`,
        }),
      ]);
    });

    it('commits a PNG and Draw.io XML sibling as one attachment mutation', async () => {
      const pageId = await seedPage();
      const xml = '<mxfile host="app.diagrams.net"><diagram/></mxfile>';

      const response = await upload(pageId, 'diagram.png', PNG_DATA_URI, xml);

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        success: true,
        filename: 'diagram.png',
        size: PNG_BYTES.length,
        xmlFilename: 'diagram.drawio',
        xmlSize: Buffer.byteLength(xml),
      });
      expect(await readFile(localFile(pageId, 'diagram.png'))).toEqual(PNG_BYTES);
      expect(await readFile(localFile(pageId, 'diagram.drawio'), 'utf8')).toBe(xml);
      const stored = await query<{ filename: string; content_type: string }>(
        `SELECT filename, content_type FROM local_attachments
          WHERE page_id = $1 ORDER BY filename`,
        [pageId],
      );
      expect(stored.rows).toEqual([
        { filename: 'diagram.drawio', content_type: 'application/xml' },
        { filename: 'diagram.png', content_type: 'image/png' },
      ]);
      const revision = await query<{ content_revision: string }>(
        'SELECT content_revision::text FROM pages WHERE id = $1',
        [pageId],
      );
      expect(revision.rows[0]?.content_revision).toBe('1');

      const xmlGet = await app.inject({
        method: 'GET',
        url: `/api/local-attachments/${pageId}/diagram.drawio`,
      });
      expect(xmlGet.statusCode, xmlGet.body).toBe(200);
      expect(xmlGet.rawPayload).toEqual(Buffer.from(xml));
      expect(xmlGet.headers['content-type']).toContain('application/xml');
      expect(xmlGet.headers['content-disposition']).toBe('attachment');
      expect(xmlGet.headers['content-security-policy']).toBe('sandbox');
    });


    it('accepts SVG and PDF uploads but serves both as sandboxed downloads', async () => {
      const pageId = await seedPage();
      const cases = [
        { filename: 'vector.svg', mime: 'image/svg+xml', bytes: SVG_BYTES, served: 'image/svg+xml' },
        { filename: 'document.pdf', mime: 'application/pdf', bytes: PDF_BYTES, served: 'application/pdf' },
      ];

      for (const item of cases) {
        const put = await upload(
          pageId,
          item.filename,
          `data:${item.mime};base64,${item.bytes.toString('base64')}`,
        );
        expect(put.statusCode, put.body).toBe(200);
        const get = await app.inject({
          method: 'GET',
          url: `/api/local-attachments/${pageId}/${item.filename}`,
        });
        expect(get.statusCode, get.body).toBe(200);
        expect(get.rawPayload).toEqual(item.bytes);
        expect(get.headers['content-type']).toContain(item.served);
        expect(get.headers['content-disposition']).toBe('attachment');
        expect(get.headers['content-security-policy']).toBe('sandbox');
        expect(get.headers['x-content-type-options']).toBe('nosniff');
      }
    });

    it.each([
      {
        label: 'a non-data URI',
        dataUri: 'https://example.invalid/image.png',
        error: 'BAD_DATA_URI',
      },
      {
        label: 'an invalid MIME shape',
        dataUri: 'data:not-a-mime;base64,AAAA',
        error: 'BAD_DATA_URI',
      },
      {
        label: 'HTML bytes',
        dataUri: `data:text/html;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`,
        error: 'UNSUPPORTED_CONTENT_TYPE',
      },
      {
        label: 'JavaScript bytes',
        dataUri: `data:text/javascript;base64,${Buffer.from('fetch("/steal")').toString('base64')}`,
        error: 'UNSUPPORTED_CONTENT_TYPE',
      },
      {
        label: 'an untyped binary payload',
        dataUri: `data:application/octet-stream;base64,${Buffer.from([0, 1, 2, 3]).toString('base64')}`,
        error: 'UNSUPPORTED_CONTENT_TYPE',
      },
      {
        label: 'an uppercase active MIME',
        dataUri: `data:TEXT/HTML;base64,${Buffer.from('<b>unsafe</b>').toString('base64')}`,
        error: 'UNSUPPORTED_CONTENT_TYPE',
      },
    ])('rejects $label without persistent effects', async ({ dataUri, error }) => {
      const pageId = await seedPage();

      const response = await upload(pageId, 'rejected.bin', dataUri);

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error });
      const stored = await query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM local_attachments WHERE page_id = $1',
        [pageId],
      );
      expect(stored.rows[0]?.count).toBe('0');
      await expectFileAbsent(pageId, 'rejected.bin');
    });

    it('rejects decoded bytes over the attachment cap without writing attachment state', async () => {
      const pageId = await seedPage();
      const bytes = Buffer.alloc(MAX_LOCAL_ATTACHMENT_BYTES + 1, 0x61);

      const response = await upload(
        pageId,
        'oversized.png',
        `data:image/png;base64,${bytes.toString('base64')}`,
      );

      expect(response.statusCode, response.body).toBe(413);
      expect(response.json()).toMatchObject({ error: 'TOO_LARGE' });
      await expectFileAbsent(pageId, 'oversized.png');
      const stored = await query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM local_attachments WHERE page_id = $1',
        [pageId],
      );
      expect(stored.rows[0]?.count).toBe('0');
    });

    it('rejects a hidden filename through the real store validation', async () => {
      const pageId = await seedPage();

      const response = await upload(pageId, '.secret');

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: 'INVALID_FILENAME' });
      await expectFileAbsent(pageId, '.secret');
    });

    it.each([
      { filename: 'legacy.html', storedType: 'text/html', bytes: Buffer.from('<script>alert(1)</script>') },
      { filename: 'legacy.js', storedType: 'text/javascript', bytes: Buffer.from('fetch("/steal")') },
    ])('does not serve a stored $storedType row as active content', async ({ filename, storedType, bytes }) => {
      const pageId = await seedPage();
      await seedLegacyAttachment(pageId, filename, storedType, bytes);

      const response = await app.inject({
        method: 'GET',
        url: `/api/local-attachments/${pageId}/${filename}`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.rawPayload).toEqual(bytes);
      expect(response.headers['content-type']).toContain('application/octet-stream');
      expect(response.headers['content-type']).not.toContain(storedType);
      expect(response.headers['content-disposition']).toBe('attachment');
      expect(response.headers['content-security-policy']).toBe('sandbox');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });

    it('returns NOT_FOUND when attachment metadata outlives its file', async () => {
      const pageId = await seedPage();
      expect((await upload(pageId, 'missing.png')).statusCode).toBe(200);
      await rm(localFile(pageId, 'missing.png'));

      const response = await app.inject({
        method: 'GET',
        url: `/api/local-attachments/${pageId}/missing.png`,
      });

      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: 'NOT_FOUND' });
    });

    it('returns PAGE_NOT_FOUND and writes nothing for an unknown page', async () => {
      const missingPageId = 2_000_000_000;

      const put = await upload(missingPageId, 'missing.png');
      const list = await app.inject({
        method: 'GET',
        url: `/api/local-attachments/${missingPageId}/list`,
      });

      expect(put.statusCode, put.body).toBe(404);
      expect(put.json()).toMatchObject({ error: 'PAGE_NOT_FOUND' });
      expect(list.statusCode, list.body).toBe(404);
      expect(list.json()).toMatchObject({ error: 'PAGE_NOT_FOUND' });
      await expectFileAbsent(missingPageId, 'missing.png');
    });

    it('denies another user access to a private page without changing its attachment', async () => {
      const ownerId = await insertUser(`attachment-owner-${randomUUID()}`);
      const pageId = await seedPage('private', ownerId);
      userId = ownerId;
      expect((await upload(pageId, 'private.png')).statusCode).toBe(200);
      userId = await insertUser(`attachment-stranger-${randomUUID()}`);

      const put = await upload(pageId, 'denied.png');
      const list = await app.inject({
        method: 'GET',
        url: `/api/local-attachments/${pageId}/list`,
      });
      const get = await app.inject({
        method: 'GET',
        url: `/api/local-attachments/${pageId}/private.png`,
      });

      expect(put.statusCode, put.body).toBe(403);
      expect(put.json()).toMatchObject({ error: 'FORBIDDEN' });
      expect(list.statusCode, list.body).toBe(403);
      expect(list.json()).toMatchObject({ error: 'FORBIDDEN' });
      // The frozen/evidence reader intentionally hides unreadable page identity.
      expect(get.statusCode, get.body).toBe(404);
      await expectFileAbsent(pageId, 'denied.png');
      expect(await readFile(localFile(pageId, 'private.png'))).toEqual(PNG_BYTES);
    });

    it('allows an authenticated non-owner to write, list and read a shared page', async () => {
      const ownerId = await insertUser(`shared-owner-${randomUUID()}`);
      const pageId = await seedPage('shared', ownerId);

      const put = await upload(pageId, 'shared.png');
      const list = await app.inject({
        method: 'GET',
        url: `/api/local-attachments/${pageId}/list`,
      });
      const get = await app.inject({
        method: 'GET',
        url: `/api/local-attachments/${pageId}/shared.png`,
      });

      expect(put.statusCode, put.body).toBe(200);
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().attachments).toEqual([
        expect.objectContaining({ filename: 'shared.png' }),
      ]);
      expect(get.statusCode, get.body).toBe(200);
      expect(get.rawPayload).toEqual(PNG_BYTES);
    });

    it('refuses the local store for a Confluence-sourced page', async () => {
      const spaceKey = `CONF-${randomUUID()}`;
      await insertLocalSpace(spaceKey, userId);
      const pageId = await insertConfluencePage(`conf-${randomUUID()}`, 'Confluence page', spaceKey);

      const put = await upload(pageId, 'wrong-store.png');
      const list = await app.inject({
        method: 'GET',
        url: `/api/local-attachments/${pageId}/list`,
      });

      expect(put.statusCode, put.body).toBe(403);
      expect(put.json()).toMatchObject({ error: 'FORBIDDEN' });
      expect(list.statusCode, list.body).toBe(403);
      expect(list.json()).toMatchObject({ error: 'FORBIDDEN' });
      await expectFileAbsent(pageId, 'wrong-store.png');
    });

    it('serves retained bytes after freeze and denies a new write through real admission', async () => {
      const pageId = await seedPage();
      expect((await upload(pageId, 'evidence.png')).statusCode).toBe(200);
      await query('UPDATE pages SET body_html = $2 WHERE id = $1', [
        pageId,
        `<p>Approved evidence</p><img src="/api/local-attachments/${pageId}/evidence.png">`,
      ]);
      await publishBaseline(pageId);
      // Prove the response comes from retained evidence, not the mutable store.
      await writeFile(localFile(pageId, 'evidence.png'), Buffer.from('changed live bytes'));

      const denied = await upload(pageId, 'after-freeze.png');
      expect(denied.statusCode, denied.body).toBe(423);
      await expectFileAbsent(pageId, 'after-freeze.png');

      const retained = await app.inject({
        method: 'GET',
        url: `/api/local-attachments/${pageId}/evidence.png`,
      });
      expect(retained.statusCode, retained.body).toBe(200);
      expect(retained.rawPayload).toEqual(PNG_BYTES);
      expect(retained.headers['content-length']).toBe(String(PNG_BYTES.length));
      expect(retained.headers['content-disposition']).toBe('inline');

      const absent = await app.inject({
        method: 'GET',
        url: `/api/local-attachments/${pageId}/not-in-baseline.png`,
      });
      expect(absent.statusCode, absent.body).toBe(404);
      expect(absent.json()).toMatchObject({ error: 'NOT_FOUND' });
    });
  },
);
