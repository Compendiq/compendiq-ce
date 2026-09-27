import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
  waitForDatabaseCondition,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { getPool, query } from '../../core/db/postgres.js';
import { PAGE_WRITER_ENFORCEMENT_VERSION, setPageBaselineReadinessProvider } from '../../core/services/page-baseline-governance.js';
import {
  freezePage,
  previewPageBaseline,
  setPageBaselineCreationEnabled,
} from '../../core/services/page-baseline-service.js';
import {
  fencePageWriterRuntime,
  lockPageLifecycle,
  reconcilePageWriteIntent,
} from '../../core/services/page-write-admission.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import {
  REAL_JPEG_40x30_BASE64,
  REAL_PNG_40x30_BASE64,
} from '../../core/services/test-image-fixtures.js';
import {
  buildKnowledgeTestApp,
  insertConfluencePage,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';

const PNG_BYTES = Buffer.from(REAL_PNG_40x30_BASE64, 'base64');
const JPEG_BYTES = Buffer.from(REAL_JPEG_40x30_BASE64, 'base64');
const PNG_SHA = createHash('sha256').update(PNG_BYTES).digest('hex');
const JPEG_SHA = createHash('sha256').update(JPEG_BYTES).digest('hex');
const PNG_DATA_URI = `data:image/png;base64,${REAL_PNG_40x30_BASE64}`;
const JPEG_DATA_URI = `data:image/jpeg;base64,${REAL_JPEG_40x30_BASE64}`;

const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);

interface StoredIconRow {
  icon_kind: string | null;
  icon_value: string | null;
  icon_color: string | null;
  icon_filled: boolean | null;
  content_revision: string;
}

let app: FastifyInstance;
let redis: RedisClientType;
let attachmentsDir: string;
let originalAttachmentsDir: string | undefined;
let userId: string;

function iconDirectory(pageId: number): string {
  return join(attachmentsDir, 'page-icons', String(pageId));
}

function iconPath(pageId: number, sha: string, extension: 'png' | 'jpg' | 'webp'): string {
  return join(iconDirectory(pageId), `${sha}.${extension}`);
}

async function storedIcon(pageId: number): Promise<StoredIconRow> {
  const result = await query<StoredIconRow>(
    `SELECT icon_kind, icon_value, icon_color, icon_filled, content_revision::text
       FROM pages WHERE id = $1`,
    [pageId],
  );
  return result.rows[0]!;
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function waitForLifecycleWaiter(): Promise<void> {
  const reachedBarrier = await waitForDatabaseCondition(async () => {
    const waiting = await query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND wait_event = 'advisory'
            AND query LIKE '%pg_advisory_xact_lock%'
       ) AS waiting`,
    );
    return waiting.rows[0]?.waiting ?? false;
  });
  if (!reachedBarrier) {
    throw new Error('icon writer did not reach the lifecycle lock barrier');
  }
}

async function seedPage(
  visibility: 'private' | 'shared' = 'private',
  ownerId = userId,
): Promise<number> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const spaceKey = `ICON_${suffix}`;
  await insertLocalSpace(spaceKey, ownerId);
  return insertStandalonePage(`Icon page ${suffix}`, visibility, ownerId, spaceKey);
}

async function uploadIcon(pageId: number, dataUri = PNG_DATA_URI) {
  return app.inject({
    method: 'POST',
    url: `/api/pages/${pageId}/icon-image`,
    payload: { dataUri },
  });
}

async function freezeCurrentPage(pageId: number, actorId = userId): Promise<string> {
  const preview = await previewPageBaseline(pageId, actorId);
  const state = await freezePage({
    pageId,
    actorId,
    reason: 'Approved icon evidence',
    expectedContentRevision: preview.contentRevision,
    expectedManifestDigest: preview.manifestDigest,
    reportedSignatories: [],
  });
  return state.baselineId!;
}

async function expectCompletedEffect(pageId: number, kind: string): Promise<void> {
  const result = await query<{
    status: string;
    effect_started_at: Date | null;
    effect_finished_at: Date | null;
    settled_at: Date | null;
  }>(
    `SELECT status, effect_started_at, effect_finished_at, settled_at
       FROM page_write_intents
      WHERE kind = $1 AND $2 = ANY(page_ids)
      ORDER BY created_at DESC
      LIMIT 1`,
    [kind, pageId],
  );
  expect(result.rows[0]).toMatchObject({
    status: 'completed',
    effect_started_at: expect.any(Date),
    effect_finished_at: expect.any(Date),
    settled_at: expect.any(Date),
  });
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  'page icon routes — real PostgreSQL, Redis, admission, authority and files',
  () => {
    beforeAll(async () => {
      await setupTestDb();
      await truncateAllTables();
      originalAttachmentsDir = process.env.ATTACHMENTS_DIR;
      attachmentsDir = await mkdtemp(join(tmpdir(), 'page-icons-'));
      process.env.ATTACHMENTS_DIR = attachmentsDir;
      redis = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: false, connectTimeout: 1_000 },
      });
      await redis.connect();
      setRedisClient(redis);
      app = await buildKnowledgeTestApp(() => userId, async (instance) => {
        instance.redis = redis;
        const { pagesIconRoutes } = await import('./pages-icon.js');
        await instance.register(pagesIconRoutes, { prefix: '/api' });
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
      setPageBaselineReadinessProvider(async () => ({ ready: true, blockers: [] }));
      const adminId = await insertUser(`icon-admin-${randomUUID()}`);
      await query("UPDATE users SET role = 'admin' WHERE id = $1", [adminId]);
      await query(
        `INSERT INTO user_settings (user_id, confluence_enabled)
         VALUES ($1, FALSE)`,
        [adminId],
      );
      await setPageBaselineCreationEnabled(adminId, true);
      userId = await insertUser(`icon-user-${randomUUID()}`);
      await query(
        `INSERT INTO user_settings (user_id, confluence_enabled)
         VALUES ($1, FALSE)`,
        [userId],
      );
    });

    it('sets an emoji and invalidates every consumer page cache for a shared page', async () => {
      const pageId = await seedPage('shared');
      const observerId = randomUUID();
      const callerPageKey = `kb:${userId}:pages:list`;
      const observerPageKey = `kb:${observerId}:pages:tree`;
      const unrelatedKey = `kb:${userId}:spaces:list`;
      await redis.mSet({
        [callerPageKey]: 'caller-pages',
        [observerPageKey]: 'observer-pages',
        [unrelatedKey]: 'caller-spaces',
      });
      const beforeRevision = BigInt((await storedIcon(pageId)).content_revision);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/pages/${pageId}/icon`,
        payload: { icon: { kind: 'emoji', value: '🚀' } },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ icon: { kind: 'emoji', value: '🚀' } });
      expect(await storedIcon(pageId)).toEqual({
        icon_kind: 'emoji',
        icon_value: '🚀',
        icon_color: null,
        icon_filled: false,
        content_revision: expect.any(String),
      });
      expect(BigInt((await storedIcon(pageId)).content_revision)).toBeGreaterThan(beforeRevision);
      expect(await redis.mGet([callerPageKey, observerPageKey, unrelatedKey])).toEqual([
        null,
        null,
        'caller-spaces',
      ]);
    });

    it('clears an existing mark in the response and database', async () => {
      const pageId = await seedPage();
      const set = await app.inject({
        method: 'PATCH',
        url: `/api/pages/${pageId}/icon`,
        payload: { icon: { kind: 'emoji', value: '📚' } },
      });
      expect(set.statusCode, set.body).toBe(200);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/pages/${pageId}/icon`,
        payload: { icon: null },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ icon: null });
      expect(await storedIcon(pageId)).toMatchObject({
        icon_kind: null,
        icon_value: null,
        icon_color: null,
        icon_filled: false,
      });
    });

    it('stores genuine uploaded bytes, commits metadata, and serves the current icon', async () => {
      const pageId = await seedPage();

      const response = await uploadIcon(pageId);

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ icon: { kind: 'image', value: PNG_SHA } });
      expect(await storedIcon(pageId)).toMatchObject({
        icon_kind: 'image',
        icon_value: PNG_SHA,
        icon_color: null,
        icon_filled: false,
      });
      expect(await readFile(iconPath(pageId, PNG_SHA, 'png'))).toEqual(PNG_BYTES);
      await expectCompletedEffect(pageId, 'icon.image.put');

      const read = await app.inject({
        method: 'GET',
        url: `/api/pages/${pageId}/icon-image?v=${PNG_SHA}`,
      });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.headers['content-type']).toBe('image/png');
      expect(read.headers['cache-control']).toBe('private, max-age=86400');
      expect(read.rawPayload).toEqual(PNG_BYTES);
    });

    it('replaces an uploaded icon atomically and no longer serves the prior bytes', async () => {
      const pageId = await seedPage();
      const first = await uploadIcon(pageId);
      expect(first.statusCode, first.body).toBe(200);

      const replacement = await uploadIcon(pageId, JPEG_DATA_URI);

      expect(replacement.statusCode, replacement.body).toBe(200);
      expect(replacement.json()).toEqual({ icon: { kind: 'image', value: JPEG_SHA } });
      expect(await storedIcon(pageId)).toMatchObject({
        icon_kind: 'image',
        icon_value: JPEG_SHA,
      });
      await expectMissing(iconPath(pageId, PNG_SHA, 'png'));
      expect(await readFile(iconPath(pageId, JPEG_SHA, 'jpg'))).toEqual(JPEG_BYTES);
      const priorRead = await app.inject({
        method: 'GET',
        url: `/api/pages/${pageId}/icon-image?v=${PNG_SHA}`,
      });
      expect(priorRead.statusCode).toBe(404);
    });

    it('removes uploaded bytes and metadata through a completed durable effect', async () => {
      const pageId = await seedPage();
      const uploaded = await uploadIcon(pageId);
      expect(uploaded.statusCode, uploaded.body).toBe(200);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/pages/${pageId}/icon`,
        payload: { icon: null },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ icon: null });
      expect(await storedIcon(pageId)).toMatchObject({
        icon_kind: null,
        icon_value: null,
        icon_color: null,
        icon_filled: false,
      });
      await expectMissing(iconPath(pageId, PNG_SHA, 'png'));
      await expectCompletedEffect(pageId, 'icon.metadata.patch');
      const read = await app.inject({ method: 'GET', url: `/api/pages/${pageId}/icon-image` });
      expect(read.statusCode).toBe(404);
    });

    it('persists catalogue brand and Lucide options as observable page state', async () => {
      const pageId = await seedPage();
      const brand = await app.inject({
        method: 'PATCH',
        url: `/api/pages/${pageId}/icon`,
        payload: { icon: { kind: 'brand', value: 'docker' } },
      });
      expect(brand.statusCode, brand.body).toBe(200);
      expect(brand.json()).toEqual({ icon: { kind: 'brand', value: 'docker' } });
      expect(await storedIcon(pageId)).toMatchObject({
        icon_kind: 'brand',
        icon_value: 'docker',
        icon_color: null,
        icon_filled: false,
      });

      const lucide = await app.inject({
        method: 'PATCH',
        url: `/api/pages/${pageId}/icon`,
        payload: { icon: { kind: 'lucide', value: 'camera', color: '#6366f1', filled: true } },
      });
      expect(lucide.statusCode, lucide.body).toBe(200);
      expect(lucide.json()).toEqual({
        icon: { kind: 'lucide', value: 'camera', color: '#6366f1', filled: true },
      });
      expect(await storedIcon(pageId)).toMatchObject({
        icon_kind: 'lucide',
        icon_value: 'camera',
        icon_color: '#6366f1',
        icon_filled: true,
      });
    });

    it.each([
      ['an unknown icon colour', { kind: 'lucide', value: 'rocket', color: '#ffffff' }],
      ['an unknown Lucide id', { kind: 'lucide', value: 'globe' }],
      ['an unsafe emoji value', { kind: 'emoji', value: 'a<script>' }],
    ])('rejects %s without changing page state', async (_label, icon) => {
      const pageId = await seedPage();
      const before = await storedIcon(pageId);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/pages/${pageId}/icon`,
        payload: { icon },
      });

      expect(response.statusCode).toBe(400);
      expect(await storedIcon(pageId)).toEqual(before);
    });

    it('rejects bytes that are not a supported image without staging or metadata', async () => {
      const pageId = await seedPage();
      const response = await uploadIcon(
        pageId,
        `data:image/png;base64,${Buffer.from('not a PNG').toString('base64')}`,
      );

      expect(response.statusCode).toBe(422);
      expect(await storedIcon(pageId)).toMatchObject({ icon_kind: null, icon_value: null });
      await expectMissing(iconDirectory(pageId));
    });

    it('rejects uploaded icon bytes above 512 KiB before staging', async () => {
      const pageId = await seedPage();
      const oversized = Buffer.alloc(512 * 1024 + 1, 0x61);
      const response = await uploadIcon(
        pageId,
        `data:image/png;base64,${oversized.toString('base64')}`,
      );

      expect(response.statusCode).toBe(413);
      expect(await storedIcon(pageId)).toMatchObject({ icon_kind: null, icon_value: null });
      await expectMissing(iconDirectory(pageId));
    });

    it('returns 404 for a missing page without creating an icon namespace', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/pages/999999999/icon',
        payload: { icon: { kind: 'emoji', value: '📚' } },
      });

      expect(response.statusCode).toBe(404);
      await expectMissing(iconDirectory(999999999));
    });

    it('enforces private ownership for mutation and reads through real authority', async () => {
      const pageId = await seedPage('private');
      const uploaded = await uploadIcon(pageId);
      expect(uploaded.statusCode, uploaded.body).toBe(200);
      userId = await insertUser(`icon-reader-${randomUUID()}`);

      const mutation = await app.inject({
        method: 'PATCH',
        url: `/api/pages/${pageId}/icon`,
        payload: { icon: { kind: 'emoji', value: '📚' } },
      });
      const read = await app.inject({
        method: 'GET',
        url: `/api/pages/${pageId}/icon-image?v=${PNG_SHA}`,
      });

      expect(mutation.statusCode).toBe(403);
      expect(read.statusCode).toBe(404);
      expect(await storedIcon(pageId)).toMatchObject({
        icon_kind: 'image',
        icon_value: PNG_SHA,
      });
      expect(await readFile(iconPath(pageId, PNG_SHA, 'png'))).toEqual(PNG_BYTES);
    });

    it('retains the existing shared-page edit permission for a non-owner', async () => {
      const ownerId = await insertUser(`icon-owner-${randomUUID()}`);
      const pageId = await seedPage('shared', ownerId);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/pages/${pageId}/icon`,
        payload: { icon: { kind: 'emoji', value: '📖' } },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(await storedIcon(pageId)).toMatchObject({
        icon_kind: 'emoji',
        icon_value: '📖',
      });
    });

    it('denies a deactivated actor after admission wait without publishing icon bytes or metadata', async () => {
      const pageId = await seedPage();
      const before = await storedIcon(pageId);
      const blocker = await getPool().connect();
      await blocker.query('BEGIN');
      await lockPageLifecycle(blocker, [pageId]);
      try {
        const pending = uploadIcon(pageId);
        await waitForLifecycleWaiter();
        await blocker.query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [userId]);
        await blocker.query('COMMIT');

        const response = await pending;
        expect(response.statusCode, response.body).toBe(403);
        expect(await storedIcon(pageId)).toEqual(before);
        await expectMissing(iconPath(pageId, PNG_SHA, 'png'));
      } catch (error) {
        await blocker.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        blocker.release();
      }
    });

    it.each(['metadata', 'image'] as const)(
      'refuses %s publication on an inherited Confluence page without current page access',
      async (kind) => {
        const spaceKey = `ICON_ORPHAN_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
        await insertLocalSpace(spaceKey, userId);
        const pageId = await insertConfluencePage(`icon-orphan-${randomUUID()}`, 'Orphaned icon page', spaceKey);
        await query('UPDATE pages SET space_key = NULL, inherit_perms = TRUE WHERE id = $1', [pageId]);
        const before = await storedIcon(pageId);

        const response = kind === 'image'
          ? await uploadIcon(pageId)
          : await app.inject({
            method: 'PATCH',
            url: `/api/pages/${pageId}/icon`,
            payload: { icon: { kind: 'lucide', value: 'rocket' } },
          });

        expect(response.statusCode, response.body).toBe(403);
        expect(await storedIcon(pageId)).toEqual(before);
        await expectMissing(iconDirectory(pageId));
      },
    );

    it('refuses recovery of a legacy inherited icon intent without current page access', async () => {
      const spaceKey = `ICON_REPAIR_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
      await insertLocalSpace(spaceKey, userId);
      const pageId = await insertConfluencePage(`icon-repair-${randomUUID()}`, 'Orphaned legacy icon', spaceKey);
      await query(
        `UPDATE pages SET space_key = NULL, inherit_perms = TRUE, icon_kind = 'image', icon_value = $2 WHERE id = $1`,
        [pageId, PNG_SHA],
      );
      await mkdir(iconDirectory(pageId), { recursive: true });
      await writeFile(iconPath(pageId, PNG_SHA, 'png'), PNG_BYTES);
      const before = await storedIcon(pageId);
      const revision = (await query<{ content_revision: string; lifecycle_revision: string }>(
        'SELECT content_revision::text, lifecycle_revision::text FROM pages WHERE id = $1', [pageId],
      )).rows[0]!;
      const administratorId = await insertUser(`icon-repair-admin-${randomUUID()}`);
      await query("UPDATE users SET role = 'admin' WHERE id = $1", [administratorId]);
      const runtimeId = randomUUID();
      const acknowledgmentId = randomUUID();
      const intentId = randomUUID();
      // The effect shape is legacy; its retired runtime still declares the installed protocol.
      await query(
        `INSERT INTO page_writer_runtimes
           (runtime_id, deployment_identity, quiesced_at, quiescence_ack, enforcement_version)
         VALUES ($1, $2::jsonb, NOW(), $3, $4)`,
        [
          runtimeId,
          JSON.stringify({ host: 'retired-icon-fixture', pid: 42, startedAt: new Date().toISOString() }),
          acknowledgmentId,
          PAGE_WRITER_ENFORCEMENT_VERSION,
        ],
      );
      await query(
        `INSERT INTO page_write_intents
           (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect, effect_started_at)
         VALUES ($1, $2, 'icon.metadata.patch', $3, ARRAY[$4]::integer[], $5::jsonb, 'local_verified', $6::jsonb, NOW())`,
        [
          intentId, runtimeId, userId, pageId,
          JSON.stringify({ [pageId]: { contentRevision: revision.content_revision, lifecycleRevision: revision.lifecycle_revision } }),
          JSON.stringify({
            effectClass: 'local', pageId, iconKind: 'lucide', iconValue: 'rocket',
            iconColor: null, iconFilled: false, removesUploadedImage: true, previousSha256: PNG_SHA,
          }),
        ],
      );
      await fencePageWriterRuntime({
        runtimeId, mode: 'owner_ack', acknowledgmentId, actorId: administratorId,
        reason: 'Recover a retired legacy icon writer without extending its authority',
      });

      await expect(reconcilePageWriteIntent(intentId, {
        actorId: administratorId, reason: 'Current page access must still authorize icon publication',
      })).rejects.toThrow('Page icon repair actor is no longer authorized');
      expect(await storedIcon(pageId)).toEqual(before);
      expect(await readFile(iconPath(pageId, PNG_SHA, 'png'))).toEqual(PNG_BYTES);
      expect((await query('SELECT status FROM page_write_intents WHERE id = $1', [intentId])).rows)
        .toEqual([{ status: 'pending' }]);
    });

    it('rechecks current Confluence page ACE authority after admission before metadata mutation', async () => {
      const spaceKey = `ICON_CONF_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
      await insertLocalSpace(spaceKey, userId);
      const pageId = await insertConfluencePage(`icon-${randomUUID()}`, 'ACE icon page', spaceKey);
      const role = await query<{ id: number }>(
        `INSERT INTO roles (name, display_name, permissions)
         VALUES ($1, 'Icon writer', ARRAY['read', 'edit']) RETURNING id`,
        [spaceKey],
      );
      await query(
        `INSERT INTO space_role_assignments
           (space_key, principal_type, principal_id, role_id)
         VALUES ($1, 'user', $2, $3)`,
        [spaceKey, userId, role.rows[0]!.id],
      );
      await query('UPDATE pages SET inherit_perms = FALSE WHERE id = $1', [pageId]);
      await query(
        `INSERT INTO access_control_entries
           (resource_type, resource_id, principal_type, principal_id, permission)
         VALUES ('page', $1, 'user', $2, 'edit')`,
        [pageId, userId],
      );
      const before = await storedIcon(pageId);

      const blocker = await getPool().connect();
      await blocker.query('BEGIN');
      await lockPageLifecycle(blocker, [pageId]);
      try {
        const pending = app.inject({
          method: 'PATCH',
          url: `/api/pages/${pageId}/icon`,
          payload: { icon: { kind: 'emoji', value: '🔐' } },
        });
        await waitForLifecycleWaiter();
        await blocker.query(
          `DELETE FROM access_control_entries
            WHERE resource_type = 'page'
              AND resource_id = $1
              AND principal_type = 'user'
              AND principal_id = $2`,
          [pageId, userId],
        );
        await blocker.query('COMMIT');

        const response = await pending;
        expect(response.statusCode, response.body).toBe(403);
        expect(await storedIcon(pageId)).toEqual(before);
        await expectMissing(iconDirectory(pageId));
      } catch (error) {
        await blocker.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        blocker.release();
      }
    });

    it('publishes a Confluence icon while the current role and page ACE still authorize it', async () => {
      const spaceKey = `ICON_OK_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
      await insertLocalSpace(spaceKey, userId);
      const pageId = await insertConfluencePage(`icon-ok-${randomUUID()}`, 'Authorized icon page', spaceKey);
      const role = await query<{ id: number }>(
        `INSERT INTO roles (name, display_name, permissions)
         VALUES ($1, 'Icon writer', ARRAY['read', 'edit']) RETURNING id`,
        [spaceKey],
      );
      await query(
        `INSERT INTO space_role_assignments
           (space_key, principal_type, principal_id, role_id)
         VALUES ($1, 'user', $2, $3)`,
        [spaceKey, userId, role.rows[0]!.id],
      );
      await query('UPDATE pages SET inherit_perms = FALSE WHERE id = $1', [pageId]);
      await query(
        `INSERT INTO access_control_entries
           (resource_type, resource_id, principal_type, principal_id, permission)
         VALUES ('page', $1, 'user', $2, 'edit')`,
        [pageId, userId],
      );

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/pages/${pageId}/icon`,
        payload: { icon: { kind: 'emoji', value: '✅' } },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(await storedIcon(pageId)).toMatchObject({
        icon_kind: 'emoji',
        icon_value: '✅',
      });
    });

    it('rejects both icon mutation paths on a frozen page without changing bytes or metadata', async () => {
      const pageId = await seedPage();
      const uploaded = await uploadIcon(pageId);
      expect(uploaded.statusCode, uploaded.body).toBe(200);
      await freezeCurrentPage(pageId);
      const filesBefore = await readdir(iconDirectory(pageId));

      const metadataMutation = await app.inject({
        method: 'PATCH',
        url: `/api/pages/${pageId}/icon`,
        payload: { icon: { kind: 'emoji', value: '🔒' } },
      });
      const imageMutation = await uploadIcon(pageId, JPEG_DATA_URI);

      expect(metadataMutation.statusCode, metadataMutation.body).toBe(423);
      expect(imageMutation.statusCode, imageMutation.body).toBe(423);
      expect(await storedIcon(pageId)).toMatchObject({
        icon_kind: 'image',
        icon_value: PNG_SHA,
      });
      expect(await readdir(iconDirectory(pageId))).toEqual(filesBefore);
      expect(await readFile(iconPath(pageId, PNG_SHA, 'png'))).toEqual(PNG_BYTES);
      await expectMissing(iconPath(pageId, JPEG_SHA, 'jpg'));
    });

    it('serves retained frozen icon bytes after the mutable copy is gone', async () => {
      const pageId = await seedPage();
      const uploaded = await uploadIcon(pageId);
      expect(uploaded.statusCode, uploaded.body).toBe(200);
      const baselineId = await freezeCurrentPage(pageId);
      await rm(iconPath(pageId, PNG_SHA, 'png'));

      const response = await app.inject({
        method: 'GET',
        url: `/api/pages/${pageId}/icon-image?v=${PNG_SHA}`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.headers['content-length']).toBe(String(PNG_BYTES.length));
      expect(response.rawPayload).toEqual(PNG_BYTES);
      const retained = await query<{
        attachments: Array<{ store: string; sha256: string; retainedPath: string }>;
      }>('SELECT attachments FROM page_baselines WHERE id = $1', [baselineId]);
      const retainedIcon = retained.rows[0]!.attachments.find(
        (attachment) => attachment.store === 'icon' && attachment.sha256 === PNG_SHA,
      );
      expect(retainedIcon).toBeDefined();
      expect(
        await readFile(join(attachmentsDir, ...retainedIcon!.retainedPath.split('/'))),
      ).toEqual(PNG_BYTES);
    });

    it('does not fall back to mutable icon bytes when the frozen baseline lacks that identity', async () => {
      const pageId = await seedPage();
      const uploaded = await uploadIcon(pageId);
      expect(uploaded.statusCode, uploaded.body).toBe(200);
      await freezeCurrentPage(pageId);
      await writeFile(iconPath(pageId, JPEG_SHA, 'jpg'), JPEG_BYTES);

      const response = await app.inject({
        method: 'GET',
        url: `/api/pages/${pageId}/icon-image?v=${JPEG_SHA}`,
      });

      expect(response.statusCode).toBe(404);
      expect(await readFile(iconPath(pageId, JPEG_SHA, 'jpg'))).toEqual(JPEG_BYTES);
    });
  },
);
