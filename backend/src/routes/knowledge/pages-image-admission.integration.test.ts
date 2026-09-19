import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { getPool, query } from '../../core/db/postgres.js';
import { lockPageLifecycle, reconcilePageWriteIntent } from '../../core/services/page-write-admission.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import {
  addAllowedBaseUrlSilent,
  clearAllowedBaseUrls,
} from '../../core/utils/ssrf-guard.js';
import {
  buildKnowledgeTestApp,
  insertConfluencePage,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);
const PNG_DATA_URI = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
const dbAvailable = await isDbAvailable();
let app: FastifyInstance;
let userId: string;
let redis: RedisClientType;
let attachmentsDir: string;
let originalAttachmentsDir: string | undefined;
let originalFetch: typeof globalThis.fetch;
let fetchMock = vi.fn<typeof globalThis.fetch>();
function pngResponse(): Response {
  return new Response(PNG_BYTES, {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'content-length': String(PNG_BYTES.length),
    },
  });
}

async function waitForBlockedLifecycleLock(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
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
    if (waiting.rows[0]?.waiting) return;
  }
  throw new Error('image writer did not reach the lifecycle lock barrier');
}

async function expectAttachmentAbsent(pageKey: string, filename: string): Promise<void> {
  await expect(access(join(attachmentsDir, pageKey, filename))).rejects.toMatchObject({
    code: 'ENOENT',
  });
}

async function seedFencedImageRuntime(): Promise<string> {
  const runtimeId = `dead-image-${randomUUID()}`;
  await query(
    `INSERT INTO page_writer_runtimes
       (runtime_id, deployment_identity, fenced_at, fenced_by, fence_reason, fence_proof)
     VALUES ($1, $2::jsonb, NOW(), $3, 'Verified dead image writer fixture', $4::jsonb)`,
    [
      runtimeId,
      JSON.stringify({ host: 'test-host', pid: 999999, startedAt: new Date().toISOString() }),
      userId,
      JSON.stringify({ kind: 'verified_local_termination', deploymentIdentity: { host: 'test-host' } }),
    ],
  );
  return runtimeId;
}

async function interruptImageWrite(pageId: number, phase: 'publication' | 'settlement') {
  await query('UPDATE pages SET image_analysis_dirty = FALSE WHERE id = $1', [pageId]);
  const before = await query<{ content_revision: string }>(
    'SELECT content_revision::text FROM pages WHERE id = $1', [pageId],
  );
  const table = phase === 'publication' ? 'pages' : 'page_write_intents';
  const predicate = phase === 'publication'
    ? `id <> ${pageId} OR image_analysis_dirty = FALSE`
    : `status <> 'completed'`;
  await query(`ALTER TABLE ${table} ADD CONSTRAINT image_write_failure_test CHECK (${predicate})`);
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/images`,
      payload: { filename: 'recover.png', dataUri: PNG_DATA_URI },
    });
    expect(response.statusCode).toBe(500);
  } finally {
    await query(`ALTER TABLE ${table} DROP CONSTRAINT image_write_failure_test`);
  }
  const pending = await query<{ id: string; status: string }>(
    `SELECT id, status FROM page_write_intents
      WHERE page_ids = ARRAY[$1]::int[] AND kind = 'pages.image.upload'`, [pageId],
  );
  expect(pending.rowCount).toBe(1);
  const intent = pending.rows[0]!;
  expect(intent.status).toBe('pending');
  const runtimeId = await seedFencedImageRuntime();
  await query('UPDATE page_write_intents SET runtime_id = $2 WHERE id = $1', [intent.id, runtimeId]);
  return {
    intentId: intent.id,
    originalRevision: before.rows[0]!.content_revision,
    livePath: join(attachmentsDir, String(pageId), 'recover.png'),
  };
}


describe.skipIf(!dbAvailable)('page image writer admission — real PostgreSQL', () => {
  beforeAll(async () => {
    await setupTestDb();
    originalAttachmentsDir = process.env.ATTACHMENTS_DIR;
    attachmentsDir = await mkdtemp(join(tmpdir(), 'page-image-admission-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;
    originalFetch = globalThis.fetch;
    redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false } });
    await redis.connect();
    setRedisClient(redis);
    app = await buildKnowledgeTestApp(() => userId, async (instance) => {
      instance.redis = redis;
      // ATTACHMENTS_DIR is module-load configuration, so the route import is
      // intentionally deferred until the suite has installed its sandbox.
      const { pagesCrudRoutes } = await import('./pages-crud.js');
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
    await teardownTestDb();
    globalThis.fetch = originalFetch;
    if (originalAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = originalAttachmentsDir;
    clearAllowedBaseUrls();
    await rm(attachmentsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAllTables();
    await rm(attachmentsDir, { recursive: true, force: true });
    userId = await insertUser(`image-writer-${randomUUID()}`);
    clearAllowedBaseUrls();
    addAllowedBaseUrlSilent('https://cdn.example.com');
    fetchMock = vi.fn<typeof globalThis.fetch>();
    globalThis.fetch = fetchMock;
  });

  it('denies a deactivated actor after the upload waited for admission and writes no bytes', async () => {
    await insertLocalSpace('LOCAL', userId);
    const pageId = await insertStandalonePage('Owned image page', 'private', userId, 'LOCAL');
    const blocker = await getPool().connect();
    await blocker.query('BEGIN');
    await lockPageLifecycle(blocker, [pageId]);
    try {
      const pending = app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/images`,
        payload: { dataUri: PNG_DATA_URI, filename: 'actor-revoked.png' },
      });
      await waitForBlockedLifecycleLock();
      await blocker.query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [userId]);
      await blocker.query('COMMIT');

      const response = await pending;
      expect(response.statusCode).toBe(403);
      await expectAttachmentAbsent(String(pageId), 'actor-revoked.png');
    } catch (err) {
      await blocker.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      blocker.release();
    }
  });

  it('rechecks shared-page authority after the upload lock wait and writes no bytes', async () => {
    const ownerId = await insertUser(`image-owner-${randomUUID()}`);
    await insertLocalSpace('LOCAL', ownerId);
    const pageId = await insertStandalonePage('Shared image page', 'shared', ownerId, 'LOCAL');
    const blocker = await getPool().connect();
    await blocker.query('BEGIN');
    await lockPageLifecycle(blocker, [pageId]);
    try {
      const pending = app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/images`,
        payload: { dataUri: PNG_DATA_URI, filename: 'visibility-revoked.png' },
      });
      await waitForBlockedLifecycleLock();
      await blocker.query("UPDATE pages SET visibility = 'private' WHERE id = $1", [pageId]);
      await blocker.query('COMMIT');

      const response = await pending;
      expect(response.statusCode).toBe(403);
      await expectAttachmentAbsent(String(pageId), 'visibility-revoked.png');
    } catch (err) {
      await blocker.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      blocker.release();
    }
  });

  it('rechecks page ACEs after the import lock wait and denies before fetch or file write', async () => {
    await insertLocalSpace('CONF', userId);
    const pageId = await insertConfluencePage('991001', 'ACE image page', 'CONF');
    await query('UPDATE pages SET inherit_perms = FALSE WHERE id = $1', [pageId]);
    await query(
      `INSERT INTO access_control_entries
         (resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ('page', $1, 'user', $2, 'edit')`,
      [pageId, userId],
    );

    const blocker = await getPool().connect();
    await blocker.query('BEGIN');
    await lockPageLifecycle(blocker, [pageId]);
    try {
      const pending = app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/images/import`,
        payload: { url: 'https://cdn.example.com/ace-revoked.png' },
      });
      await waitForBlockedLifecycleLock();
      await blocker.query(
        `DELETE FROM access_control_entries
          WHERE resource_type = 'page' AND resource_id = $1 AND principal_id = $2`,
        [pageId, userId],
      );
      await blocker.query('COMMIT');

      const response = await pending;
      expect(response.statusCode).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
      await expectAttachmentAbsent('991001', 'ace-revoked.png');
    } catch (err) {
      await blocker.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      blocker.release();
    }
  });

  it('leaves the page writable after a failed read-only image fetch', async () => {
    await insertLocalSpace('LOCAL', userId);
    const pageId = await insertStandalonePage('Read failure page', 'private', userId, 'LOCAL');
    fetchMock.mockRejectedValueOnce(new TypeError('upstream unavailable'));

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/images/import`,
      payload: { url: 'https://cdn.example.com/down.png' },
    });

    expect(response.statusCode).toBe(502);
    await expectAttachmentAbsent(String(pageId), 'down.png');
    const nextWrite = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/images`,
      payload: { filename: 'next-write.png', dataUri: PNG_DATA_URI },
    });
    expect(nextWrite.statusCode).toBe(200);
    expect(nextWrite.json()).toEqual({ url: `/api/attachments/${pageId}/next-write.png` });
  });

  it.each(['upload', 'import'] as const)('rechecks authority immediately before %s bytes are written', async (mode) => {
    await insertLocalSpace('LOCAL', userId);
    const pageId = await insertStandalonePage('Effect-gap image', 'private', userId, 'LOCAL');
    await query(`
      CREATE FUNCTION image_effect_authority_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.effect_started_at IS NULL AND NEW.effect_started_at IS NOT NULL
           AND NEW.kind IN ('pages.image.upload', 'pages.image.import.store') THEN
          UPDATE users SET deactivated_at = NOW() WHERE id = NEW.actor_id;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER image_effect_authority_test
        AFTER UPDATE OF effect_started_at ON page_write_intents
        FOR EACH ROW EXECUTE FUNCTION image_effect_authority_test();
    `);
    fetchMock.mockResolvedValueOnce(pngResponse());
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/images${mode === 'import' ? '/import' : ''}`,
        payload: mode === 'import'
          ? { url: 'https://cdn.example.com/effect-gap.png' }
          : { filename: 'effect-gap.png', dataUri: PNG_DATA_URI },
      });
      expect(response.statusCode).toBe(403);
      await expectAttachmentAbsent(String(pageId), 'effect-gap.png');
    } finally {
      await query(`
        DROP TRIGGER image_effect_authority_test ON page_write_intents;
        DROP FUNCTION image_effect_authority_test();
      `);
    }
  });

  it.each(['content_revision', 'lifecycle_revision'] as const)(
    'refuses a %s change during fetch before imported bytes are written',
    async (revisionColumn) => {
      await insertLocalSpace('LOCAL', userId);
      const pageId = await insertStandalonePage('Phased image page', 'private', userId, 'LOCAL');
      fetchMock.mockImplementationOnce(async () => {
        await query(`UPDATE pages SET ${revisionColumn} = ${revisionColumn} + 1 WHERE id = $1`, [pageId]);
        return pngResponse();
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/images/import`,
        payload: { url: 'https://cdn.example.com/phase-gap.png' },
      });

      expect(response.statusCode).toBe(409);
      await expectAttachmentAbsent(String(pageId), 'phase-gap.png');
      const nextWrite = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/images`,
        payload: { filename: 'current-revision.png', dataUri: PNG_DATA_URI },
      });
      expect(nextWrite.statusCode).toBe(200);
    },
  );

  it('settles an interrupted completed image without publishing its revision twice', async () => {
    await insertLocalSpace('LOCAL', userId);
    const pageId = await insertStandalonePage('Completed image', 'private', userId, 'LOCAL');
    const interrupted = await interruptImageWrite(pageId, 'settlement');
    await expect(readFile(interrupted.livePath)).resolves.toEqual(PNG_BYTES);

    await expect(reconcilePageWriteIntent(interrupted.intentId, {
      actorId: userId, reason: 'Verify the completed image after its writer was retired',
    })).resolves.toEqual({ intentId: interrupted.intentId, status: 'reconciled_applied' });

    const page = await query<{ content_revision: string; image_analysis_dirty: boolean }>(
      'SELECT content_revision::text, image_analysis_dirty FROM pages WHERE id = $1', [pageId],
    );
    expect(page.rows[0]).toEqual({
      content_revision: (BigInt(interrupted.originalRevision) + 1n).toString(),
      image_analysis_dirty: true,
    });
    await expect(readFile(interrupted.livePath)).resolves.toEqual(PNG_BYTES);
    const nextWrite = await app.inject({
      method: 'POST', url: `/api/pages/${pageId}/images`,
      payload: { filename: 'after-recovery.png', dataUri: PNG_DATA_URI },
    });
    expect(nextWrite.statusCode).toBe(200);
  });

  it('publishes exact activated bytes after the original metadata transaction rolled back', async () => {
    await insertLocalSpace('LOCAL', userId);
    const pageId = await insertStandalonePage('Partial image', 'private', userId, 'LOCAL');
    const interrupted = await interruptImageWrite(pageId, 'publication');
    await expect(readFile(interrupted.livePath)).resolves.toEqual(PNG_BYTES);

    await expect(reconcilePageWriteIntent(interrupted.intentId, {
      actorId: userId, reason: 'Publish verified activated bytes under a fresh runtime epoch',
    })).resolves.toEqual({ intentId: interrupted.intentId, status: 'reconciled_applied' });

    const page = await query<{ content_revision: string; image_analysis_dirty: boolean }>(
      'SELECT content_revision::text, image_analysis_dirty FROM pages WHERE id = $1', [pageId],
    );
    expect(page.rows[0]).toEqual({
      content_revision: (BigInt(interrupted.originalRevision) + 1n).toString(),
      image_analysis_dirty: true,
    });
    await expect(readFile(interrupted.livePath)).resolves.toEqual(PNG_BYTES);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps partial publication pending when the original image writer was deactivated', async () => {
    await insertLocalSpace('LOCAL', userId);
    const pageId = await insertStandalonePage('Revoked image', 'private', userId, 'LOCAL');
    const interrupted = await interruptImageWrite(pageId, 'publication');
    await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [userId]);
    const administrator = await insertUser(`image-recovery-admin-${randomUUID()}`);
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [administrator]);

    await expect(reconcilePageWriteIntent(interrupted.intentId, {
      actorId: administrator, reason: 'Recovery may not publish through revoked original authority',
    })).rejects.toMatchObject({ statusCode: 403, reason: 'not_authorized' });

    const state = await query<{ content_revision: string; status: string }>(
      `SELECT p.content_revision::text, i.status
         FROM pages p JOIN page_write_intents i ON i.page_ids = ARRAY[p.id]
        WHERE i.id = $1`, [interrupted.intentId],
    );
    expect(state.rows[0]).toEqual({ content_revision: interrupted.originalRevision, status: 'pending' });
    await expect(readFile(interrupted.livePath)).resolves.toEqual(PNG_BYTES);
  });

  it('does not settle or overwrite image bytes that conflict with durable publication evidence', async () => {
    await insertLocalSpace('LOCAL', userId);
    const pageId = await insertStandalonePage('Changed image', 'private', userId, 'LOCAL');
    const interrupted = await interruptImageWrite(pageId, 'settlement');
    const changedBytes = Buffer.from('Different bytes written after the original operation');
    await writeFile(interrupted.livePath, changedBytes);

    await expect(reconcilePageWriteIntent(interrupted.intentId, {
      actorId: userId, reason: 'Conflicting local bytes are not evidence of the admitted image',
    })).rejects.toMatchObject({ statusCode: 409, reason: 'intent_local_evidence_mismatch' });

    expect((await query('SELECT status FROM page_write_intents WHERE id = $1', [interrupted.intentId])).rows)
      .toEqual([{ status: 'pending' }]);
    await expect(readFile(interrupted.livePath)).resolves.toEqual(changedBytes);
  });

  it('removes only an unpublished owned stage without replacing an existing image after actor revocation', async () => {
    await insertLocalSpace('LOCAL', userId);
    const pageId = await insertStandalonePage('Staged image', 'private', userId, 'LOCAL');
    const page = (await query<{ content_revision: string; lifecycle_revision: string }>(
      'SELECT content_revision::text, lifecycle_revision::text FROM pages WHERE id = $1', [pageId],
    )).rows[0]!;
    const runtimeId = await seedFencedImageRuntime();
    const intentId = randomUUID();
    const original = Buffer.from('Original referenced image bytes');
    const directory = join(attachmentsDir, String(pageId));
    const livePath = join(directory, 'existing.png');
    const stagePath = join(directory, `.page-write-${intentId}.image-stage`);
    await mkdir(directory, { recursive: true });
    await writeFile(livePath, original);
    await writeFile(stagePath, PNG_BYTES.subarray(0, 12));
    await query(
      `INSERT INTO page_write_intents
         (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect, effect_started_at)
       VALUES ($1, $2, 'pages.image.upload', $3, ARRAY[$4]::int[], $5::jsonb,
               'local_verified', $6::jsonb, NOW())`,
      [
        intentId, runtimeId, userId, pageId,
        JSON.stringify({ [pageId]: { contentRevision: page.content_revision, lifecycleRevision: page.lifecycle_revision } }),
        JSON.stringify({
          effectClass: 'local', store: 'attachment-cache', pageKey: String(pageId), filename: 'existing.png',
          initialContentRevision: page.content_revision,
          size: PNG_BYTES.length, sha256: createHash('sha256').update(PNG_BYTES).digest('hex'),
          previous: { size: original.length, sha256: createHash('sha256').update(original).digest('hex') },
        }),
      ],
    );
    await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [userId]);
    const administrator = await insertUser(`image-stage-admin-${randomUUID()}`);
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [administrator]);

    await expect(reconcilePageWriteIntent(intentId, {
      actorId: administrator, reason: 'Discard only the retired writer unpublished temporary image',
    })).resolves.toEqual({ intentId, status: 'reconciled_not_applied' });

    await expect(readFile(livePath)).resolves.toEqual(original);
    await expect(access(stagePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await query('SELECT content_revision::text FROM pages WHERE id = $1', [pageId])).rows)
      .toEqual([{ content_revision: page.content_revision }]);
  });
});
