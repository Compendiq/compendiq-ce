import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
import {
  completePageWriteIntent,
  reservePageWriteIntent,
  runPageWriteIntentEffect,
} from '../../core/services/page-write-admission.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import {
  REAL_GIF_40x30_BASE64,
  REAL_JPEG_40x30_BASE64,
  REAL_PNG_40x30_BASE64,
  REAL_WEBP_VP8_40x30_BASE64,
} from '../../core/services/test-image-fixtures.js';
import {
  buildKnowledgeTestApp,
  insertConfluencePage,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';

const IMAGE_FORMATS = [
  { label: 'PNG', mime: 'image/png', extension: 'png', base64: REAL_PNG_40x30_BASE64 },
  { label: 'JPEG', mime: 'image/jpeg', extension: 'jpg', base64: REAL_JPEG_40x30_BASE64 },
  { label: 'JPG MIME alias', mime: 'image/jpg', extension: 'jpg', base64: REAL_JPEG_40x30_BASE64 },
  { label: 'GIF', mime: 'image/gif', extension: 'gif', base64: REAL_GIF_40x30_BASE64 },
  { label: 'WebP', mime: 'image/webp', extension: 'webp', base64: REAL_WEBP_VP8_40x30_BASE64 },
] as const;

const PNG_BYTES = Buffer.from(REAL_PNG_40x30_BASE64, 'base64');
const PNG_DATA_URI = `data:image/png;base64,${REAL_PNG_40x30_BASE64}`;
const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);
let app: FastifyInstance;
let redis: RedisClientType;
let userId: string;
let attachmentsDir: string;
let originalAttachmentsDir: string | undefined;
async function expectStoredAttachment(
  pageKey: string,
  filename: string,
  expectedBytes: Buffer,
): Promise<void> {
  expect(await readFile(join(attachmentsDir, pageKey, filename))).toEqual(expectedBytes);
}

async function expectAttachmentAbsent(pageKey: string, filename: string): Promise<void> {
  await expect(access(join(attachmentsDir, pageKey, filename))).rejects.toMatchObject({ code: 'ENOENT' });
}

async function expectAttachmentDirectoryAbsent(pageKey: string): Promise<void> {
  await expect(access(join(attachmentsDir, pageKey))).rejects.toMatchObject({ code: 'ENOENT' });
}

async function freezePage(pageId: number, actorId: string): Promise<void> {
  const page = await query<{
    version: number;
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `SELECT version, content_revision::text, lifecycle_revision::text
       FROM pages WHERE id = $1`,
    [pageId],
  );
  const state = page.rows[0]!;
  const baselineId = randomUUID();
  const preparation = await reservePageWriteIntent({
    pageIds: [pageId],
    kind: 'baseline.prepare',
    actorId,
    effect: { effectClass: 'local', baselineId },
  });
  await runPageWriteIntentEffect(preparation, { kind: 'local' }, async () => undefined);
  await completePageWriteIntent(preparation, async () => undefined);
  await query(
    `INSERT INTO page_baselines
       (id, page_id, original_page_id, page_identity, version, content_revision,
        lifecycle_revision, manifest_digest, manifest, manifest_bytes, title,
        labels, attachments, total_bytes, reserved_bytes, status,
        prepared_by_user_id, prepared_by_name, published_by_user_id,
        published_by_name, published_at, provenance, freeze_reason, preparation_intent_id)
     VALUES ($1, $2, $2, '[]'::jsonb, $3, $4::bigint, $5::bigint,
             $6, '[]'::jsonb, $7, 'Frozen image page', '{}', '[]'::jsonb, 0, 0,
             'published', $8, 'Test actor', $8, 'Test actor', NOW(),
             'manual_assertion', 'Approved image evidence', $9)`,
    [
      baselineId,
      pageId,
      state.version,
      state.content_revision,
      state.lifecycle_revision,
      'a'.repeat(64),
      Buffer.from('[]'),
      actorId,
      preparation.id,
    ],
  );
  await query(
    `UPDATE pages
        SET baseline_id = $2, frozen_version = version, frozen_at = NOW(),
            frozen_by_user_id = $3, frozen_by_name = 'Test actor',
            freeze_reason = 'Approved image evidence', freeze_provenance = 'manual_assertion',
            freeze_reported_signatories = '[]'::jsonb
      WHERE id = $1`,
    [pageId, baselineId, actorId],
  );
}

describe.skipIf(!dbAvailable || !redisAvailable)('POST /api/pages/:id/images — real PostgreSQL and Redis', () => {
  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    });
    await redis.connect();
    setRedisClient(redis);
    originalAttachmentsDir = process.env.ATTACHMENTS_DIR;
    attachmentsDir = await mkdtemp(join(tmpdir(), 'page-image-upload-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;
    app = await buildKnowledgeTestApp(() => userId, async (instance) => {
      instance.redis = redis;
      // attachment-store captures ATTACHMENTS_DIR when pages-crud is imported,
      // so this intentionally exercises the module-loading boundary.
      const { pagesCrudRoutes } = await import('./pages-crud.js');
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    if (redis.isOpen) await redis.quit();
    await teardownTestDb();
    if (originalAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = originalAttachmentsDir;
    await rm(attachmentsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAllTables();
    await rm(attachmentsDir, { recursive: true, force: true });
    userId = await insertUser(`image-upload-${randomUUID()}`);
  });

  it.each(IMAGE_FORMATS)(
    'stores genuine $label bytes and returns their attachment URL',
    async ({ mime, extension, base64 }) => {
      await insertLocalSpace('LOCAL', userId);
      const pageId = await insertStandalonePage('Image page', 'private', userId, 'LOCAL');
      const filename = `pasted-image.${extension}`;
      const bytes = Buffer.from(base64, 'base64');

      const response = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/images`,
        payload: { dataUri: `data:${mime};base64,${base64}`, filename },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ url: string }>()).toEqual({
        url: `/api/attachments/${pageId}/${filename}`,
      });
      await expectStoredAttachment(String(pageId), filename, bytes);
    },
  );

  it('rejects a frozen page through real admission before writing bytes', async () => {
    await insertLocalSpace('LOCAL', userId);
    const pageId = await insertStandalonePage('Frozen image page', 'private', userId, 'LOCAL');
    await freezePage(pageId, userId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/images`,
      payload: { dataUri: PNG_DATA_URI, filename: 'frozen.png' },
    });

    expect(response.statusCode).toBe(423);
    await expectAttachmentAbsent(String(pageId), 'frozen.png');
  });

  it('rejects non-image data URIs before writing bytes', async () => {
    await insertLocalSpace('LOCAL', userId);
    const pageId = await insertStandalonePage('Validation page', 'private', userId, 'LOCAL');

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/images`,
      payload: {
        dataUri: `data:text/plain;base64,${REAL_PNG_40x30_BASE64}`,
        filename: 'not-an-image.txt',
      },
    });

    expect(response.statusCode).toBe(400);
    await expectAttachmentDirectoryAbsent(String(pageId));
  });

  it('rejects unsupported image MIME types before writing bytes', async () => {
    await insertLocalSpace('LOCAL', userId);
    const pageId = await insertStandalonePage('Validation page', 'private', userId, 'LOCAL');

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/images`,
      payload: {
        dataUri: `data:image/svg+xml;base64,${REAL_PNG_40x30_BASE64}`,
        filename: 'unsupported.svg',
      },
    });

    expect(response.statusCode).toBe(400);
    await expectAttachmentDirectoryAbsent(String(pageId));
  });

  it('rejects malformed data URIs before writing bytes', async () => {
    await insertLocalSpace('LOCAL', userId);
    const pageId = await insertStandalonePage('Validation page', 'private', userId, 'LOCAL');

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/images`,
      payload: { dataUri: 'not-a-data-uri', filename: 'malformed.png' },
    });

    expect(response.statusCode).toBe(400);
    await expectAttachmentDirectoryAbsent(String(pageId));
  });

  it('returns 404 and writes no bytes when the page does not exist', async () => {
    const missingPageId = '999999999';
    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${missingPageId}/images`,
      payload: { dataUri: PNG_DATA_URI, filename: 'missing.png' },
    });

    expect(response.statusCode).toBe(404);
    await expectAttachmentAbsent(missingPageId, 'missing.png');
  });

  it('denies a private standalone page owned by another user before writing bytes', async () => {
    const ownerId = await insertUser(`image-owner-${randomUUID()}`);
    await insertLocalSpace('PRIVATE', ownerId);
    const pageId = await insertStandalonePage('Private image page', 'private', ownerId, 'PRIVATE');

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/images`,
      payload: { dataUri: PNG_DATA_URI, filename: 'denied.png' },
    });

    expect(response.statusCode).toBe(403);
    await expectAttachmentAbsent(String(pageId), 'denied.png');
  });

  it('allows a reader to upload to a shared standalone page they did not create', async () => {
    const ownerId = await insertUser(`image-owner-${randomUUID()}`);
    await insertLocalSpace('SHARED', ownerId);
    const pageId = await insertStandalonePage('Shared image page', 'shared', ownerId, 'SHARED');

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/images`,
      payload: { dataUri: PNG_DATA_URI, filename: 'shared.png' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ url: string }>().url).toBe(`/api/attachments/${pageId}/shared.png`);
    await expectStoredAttachment(String(pageId), 'shared.png', PNG_BYTES);
  });

  it('allows a system admin to upload to another user’s private standalone page', async () => {
    const ownerId = await insertUser(`image-owner-${randomUUID()}`);
    await insertLocalSpace('ADMIN', ownerId);
    const pageId = await insertStandalonePage('Admin image page', 'private', ownerId, 'ADMIN');
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [userId]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/images`,
      payload: { dataUri: PNG_DATA_URI, filename: 'admin.png' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ url: string }>().url).toBe(`/api/attachments/${pageId}/admin.png`);
    await expectStoredAttachment(String(pageId), 'admin.png', PNG_BYTES);
  });

  it('rejects decoded image bytes over 10 MiB before writing a file', async () => {
    await insertLocalSpace('LOCAL', userId);
    const pageId = await insertStandalonePage('Large image page', 'private', userId, 'LOCAL');
    const oversizedBytes = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/images`,
      payload: {
        dataUri: `data:image/png;base64,${oversizedBytes.toString('base64')}`,
        filename: 'large.png',
      },
    });

    expect(response.statusCode).toBe(413);
    await expectAttachmentAbsent(String(pageId), 'large.png');
  });

  it('rejects filenames containing path traversal characters before writing bytes', async () => {
    await insertLocalSpace('LOCAL', userId);
    const pageId = await insertStandalonePage('Filename validation page', 'private', userId, 'LOCAL');

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/images`,
      payload: { dataUri: PNG_DATA_URI, filename: '../../../etc/passwd' },
    });

    expect(response.statusCode).toBe(400);
    await expectAttachmentDirectoryAbsent(String(pageId));
  });

  it('uses the Confluence id namespace for an authorized Confluence page', async () => {
    await insertLocalSpace('CONF', userId);
    const confluenceId = 'conf-12345';
    const pageId = await insertConfluencePage(confluenceId, 'Confluence image page', 'CONF');
    await query('UPDATE pages SET inherit_perms = FALSE WHERE id = $1', [pageId]);
    await query(
      `INSERT INTO access_control_entries
         (resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ('page', $1, 'user', $2, 'edit')`,
      [pageId, userId],
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/images`,
      payload: { dataUri: PNG_DATA_URI, filename: 'confluence.png' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ url: string }>().url).toBe(
      `/api/attachments/${confluenceId}/confluence.png`,
    );
    await expectStoredAttachment(confluenceId, 'confluence.png', PNG_BYTES);
    await expectAttachmentAbsent(String(pageId), 'confluence.png');
  });

  it('denies a Confluence page without a space before writing bytes', async () => {
    await insertLocalSpace('CONF', userId);
    const confluenceId = 'conf-no-space';
    const pageId = await insertConfluencePage(confluenceId, 'Orphaned Confluence page', 'CONF');
    await query('UPDATE pages SET space_key = NULL WHERE id = $1', [pageId]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/images`,
      payload: { dataUri: PNG_DATA_URI, filename: 'denied-confluence.png' },
    });

    expect(response.statusCode).toBe(403);
    await expectAttachmentAbsent(confluenceId, 'denied-confluence.png');
  });
});
