import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../../test-db-helper.js';
import { isRedisAvailable } from '../../../test-redis-helper.js';
import { getPool, query } from '../../../core/db/postgres.js';
import { attachmentCacheDir } from '../../../core/services/attachment-store.js';
import { initCollabBus } from '../../../core/services/collab-room-service.js';
import { localAttachmentsDir } from '../../../core/services/local-attachment-service.js';
import {
  reconcilePageWriteIntent,
  type IntentKind,
} from '../../../core/services/page-write-admission.js';
import { setRedisClient } from '../../../core/services/redis-cache.js';
import { registerOrdinaryPageWriteReconcilers } from './ordinary-page-write-reconciler.js';

const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);
const describeIntegration = dbAvailable && redisAvailable ? describe : describe.skip;
const settlementTargetTable = 'local_delete_recovery_settlement_targets';
const deleteProbeTable = 'local_delete_recovery_delete_probes';
const settlementSequence = 'local_delete_recovery_settlement_attempt_seq';

let redis: RedisClientType;
let closeCollabBus: (() => Promise<void>) | undefined;
let attachmentsDir: string;
const activeKeys: string[] = [];

async function installProbeTriggers(): Promise<void> {
  await query(`CREATE TABLE ${settlementTargetTable} (intent_id UUID PRIMARY KEY)`);
  await query(`CREATE SEQUENCE ${settlementSequence}`);
  await query(`
    CREATE FUNCTION local_delete_recovery_fail_first_settlement()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status = 'pending'
         AND NEW.status IN ('reconciled_applied', 'reconciled_not_applied')
         AND EXISTS (SELECT 1 FROM ${settlementTargetTable} WHERE intent_id = NEW.id)
         AND nextval('${settlementSequence}') = 1
      THEN
        RAISE EXCEPTION 'simulated crash before recovery settlement' USING ERRCODE = '40001';
      END IF;
      RETURN NEW;
    END
    $$
  `);
  await query(`
    CREATE TRIGGER local_delete_recovery_fail_first_settlement_trigger
    BEFORE UPDATE OF status ON page_write_intents
    FOR EACH ROW EXECUTE FUNCTION local_delete_recovery_fail_first_settlement()
  `);
  await query(`CREATE TABLE ${deleteProbeTable} (page_id INTEGER PRIMARY KEY, delete_count INTEGER NOT NULL)`);
  await query(`
    CREATE FUNCTION local_delete_recovery_count_page_delete()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO ${deleteProbeTable} (page_id, delete_count) VALUES (OLD.id, 1)
      ON CONFLICT (page_id) DO UPDATE SET delete_count = ${deleteProbeTable}.delete_count + 1;
      RETURN OLD;
    END
    $$
  `);
  await query(`
    CREATE TRIGGER local_delete_recovery_count_page_delete_trigger
    BEFORE DELETE ON pages
    FOR EACH ROW EXECUTE FUNCTION local_delete_recovery_count_page_delete()
  `);
}

async function removeProbeTriggers(): Promise<void> {
  await query('DROP TRIGGER IF EXISTS local_delete_recovery_fail_first_settlement_trigger ON page_write_intents');
  await query('DROP FUNCTION IF EXISTS local_delete_recovery_fail_first_settlement()');
  await query('DROP TRIGGER IF EXISTS local_delete_recovery_count_page_delete_trigger ON pages');
  await query('DROP FUNCTION IF EXISTS local_delete_recovery_count_page_delete()');
  await query(`DROP TABLE IF EXISTS ${settlementTargetTable}`);
  await query(`DROP TABLE IF EXISTS ${deleteProbeTable}`);
  await query(`DROP SEQUENCE IF EXISTS ${settlementSequence}`);
}

async function seedUser(role: 'admin' | 'user'): Promise<string> {
  const suffix = randomUUID();
  const inserted = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, 'x', $3) RETURNING id`,
    [`local-delete-${suffix}`, `${suffix}@test.invalid`, role],
  );
  return inserted.rows[0]!.id;
}

type LocalDeleteKind = Extract<
  IntentKind,
  'pages.delete.standalone' | 'pages.delete.local' | 'pages.bulk.delete.local'
>;

type SeededDeletion = {
  intentId: string;
  pageId: number;
  confluenceId: string | null;
  recoveryAdminId: string;
  preserveSharedCache: boolean;
};

async function seedCommittedDeletion(kind: LocalDeleteKind): Promise<SeededDeletion> {
  const originalActorId = await seedUser('user');
  const recoveryAdminId = await seedUser('admin');
  const standalone = kind === 'pages.delete.standalone';
  const confluenceId = standalone ? null : `local-delete-${randomUUID()}`;
  const inserted = await query<{
    id: number;
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `INSERT INTO pages
       (confluence_id, space_key, title, source, visibility, created_by_user_id)
     VALUES ($1, 'REC', 'Delete recovery', $2, 'private', $3)
     RETURNING id, content_revision::text, lifecycle_revision::text`,
    [confluenceId, standalone ? 'standalone' : 'confluence', originalActorId],
  );
  const pageId = inserted.rows[0]!.id;
  let revisions = inserted.rows[0]!;
  if (!standalone) {
    const hidden = await query<{ content_revision: string; lifecycle_revision: string }>(
      `UPDATE pages SET deleted_at = NOW() WHERE id = $1
       RETURNING content_revision::text, lifecycle_revision::text`,
      [pageId],
    );
    revisions = { id: pageId, ...hidden.rows[0]! };
  }

  if (standalone) {
    const sharedCache = attachmentCacheDir(String(pageId));
    await fs.mkdir(sharedCache, { recursive: true });
    await fs.writeFile(path.join(sharedCache, 'shared-or-stale.bin'), 'retained bytes');
    await fs.mkdir(localAttachmentsDir(pageId), { recursive: true });
    await fs.writeFile(path.join(localAttachmentsDir(pageId), 'local.bin'), 'local bytes');
  } else {
    const cache = attachmentCacheDir(confluenceId!);
    await fs.mkdir(cache, { recursive: true });
    await fs.writeFile(path.join(cache, 'cached.bin'), 'cached bytes');
  }
  const iconDir = path.join(attachmentsDir, 'page-icons', String(pageId));
  await fs.mkdir(iconDir, { recursive: true });
  await fs.writeFile(path.join(iconDir, `${'a'.repeat(64)}.png`), 'icon bytes');

  let preserveSharedCache = false;
  if (standalone) {
    preserveSharedCache = true;
    await query(
      `INSERT INTO pages (confluence_id, space_key, title, source, visibility, created_by_user_id)
       VALUES ($1, 'REC', 'Live shared-key claimant', 'confluence', 'private', $2)`,
      [String(pageId), originalActorId],
    );
  }

  const runtimeId = `dead-local-delete-${randomUUID()}`;
  await query(
    `INSERT INTO page_writer_runtimes
       (runtime_id, deployment_identity, fenced_at, fenced_by, fence_reason, fence_proof)
     VALUES ($1, $2::jsonb, NOW(), $3, 'Verified terminated delete writer', $4::jsonb)`,
    [
      runtimeId,
      JSON.stringify({ host: 'test-host', pid: 999999, startedAt: new Date().toISOString() }),
      recoveryAdminId,
      JSON.stringify({ kind: 'verified_local_termination', deploymentIdentity: { host: 'test-host' } }),
    ],
  );
  const intentId = randomUUID();
  const effect = standalone
    ? {
        effectClass: 'local',
        rootPageId: pageId,
        targetCount: 1,
        attachmentStores: ['attachment-cache', 'local', 'page-icons'],
      }
    : {
        effectClass: 'local',
        confluenceId,
        spaceKey: 'REC',
        upstreamDelete: false,
        attachmentStore: 'confluence',
        iconStore: 'page-icons',
      };

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO page_write_intents
         (id, runtime_id, kind, actor_id, page_ids, revisions, deleted_page_ids,
          recovery_mode, effect, effect_started_at)
       VALUES ($1, $2, $3, $4, ARRAY[$5]::integer[], $6::jsonb, ARRAY[]::integer[],
               'local_verified', $7::jsonb, NOW())`,
      [
        intentId,
        runtimeId,
        kind,
        originalActorId,
        pageId,
        JSON.stringify({
          [pageId]: {
            contentRevision: revisions.content_revision,
            lifecycleRevision: revisions.lifecycle_revision,
          },
        }),
        JSON.stringify(effect),
      ],
    );
    await client.query('DELETE FROM pages WHERE id = $1', [pageId]);
    await client.query(
      'UPDATE page_write_intents SET deleted_page_ids = ARRAY[$2]::integer[] WHERE id = $1',
      [intentId, pageId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [originalActorId]);
  await query(`INSERT INTO ${settlementTargetTable} (intent_id) VALUES ($1)`, [intentId]);
  const activeKey = `collab:active:${pageId}`;
  activeKeys.push(activeKey);
  await redis.set(activeKey, 'stale-writer');
  return { intentId, pageId, confluenceId, recoveryAdminId, preserveSharedCache };
}

async function seedUnappliedDeletion(kind: LocalDeleteKind): Promise<{
  intentId: string;
  pageId: number;
  recoveryAdminId: string;
}> {
  const originalActorId = await seedUser('user');
  const recoveryAdminId = await seedUser('admin');
  const standalone = kind === 'pages.delete.standalone';
  const confluenceId = standalone ? null : `unapplied-local-delete-${randomUUID()}`;
  const inserted = await query<{
    id: number;
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `INSERT INTO pages
       (confluence_id, space_key, title, source, visibility, created_by_user_id)
     VALUES ($1, 'REC', 'Unapplied delete recovery', $2, 'private', $3)
     RETURNING id, content_revision::text, lifecycle_revision::text`,
    [confluenceId, standalone ? 'standalone' : 'confluence', originalActorId],
  );
  const pageId = inserted.rows[0]!.id;
  let revisions = inserted.rows[0]!;
  if (!standalone) {
    const hidden = await query<{ content_revision: string; lifecycle_revision: string }>(
      `UPDATE pages SET deleted_at = NOW() WHERE id = $1
       RETURNING content_revision::text, lifecycle_revision::text`,
      [pageId],
    );
    revisions = { id: pageId, ...hidden.rows[0]! };
  }
  const runtimeId = `dead-unapplied-delete-${randomUUID()}`;
  await query(
    `INSERT INTO page_writer_runtimes
       (runtime_id, deployment_identity, fenced_at, fenced_by, fence_reason, fence_proof)
     VALUES ($1, $2::jsonb, NOW(), $3, 'Verified terminated pre-delete writer', $4::jsonb)`,
    [
      runtimeId,
      JSON.stringify({ host: 'test-host', pid: 999998, startedAt: new Date().toISOString() }),
      recoveryAdminId,
      JSON.stringify({ kind: 'verified_local_termination', deploymentIdentity: { host: 'test-host' } }),
    ],
  );
  const intentId = randomUUID();
  const effect = standalone
    ? {
        effectClass: 'local',
        rootPageId: pageId,
        targetCount: 1,
        attachmentStores: ['attachment-cache', 'local', 'page-icons'],
      }
    : {
        effectClass: 'local',
        confluenceId,
        spaceKey: 'REC',
        upstreamDelete: false,
        attachmentStore: 'confluence',
        iconStore: 'page-icons',
      };
  await query(
    `INSERT INTO page_write_intents
       (id, runtime_id, kind, actor_id, page_ids, revisions, deleted_page_ids,
        recovery_mode, effect, effect_started_at)
     VALUES ($1, $2, $3, $4, ARRAY[$5]::integer[], $6::jsonb, ARRAY[]::integer[],
             'local_verified', $7::jsonb, CASE WHEN $8 THEN NOW() ELSE NULL END)`,
    [
      intentId,
      runtimeId,
      kind,
      originalActorId,
      pageId,
      JSON.stringify({
        [pageId]: {
          contentRevision: revisions.content_revision,
          lifecycleRevision: revisions.lifecycle_revision,
        },
      }),
      JSON.stringify(effect),
      !standalone,
    ],
  );
  await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [originalActorId]);
  const activeKey = `collab:active:${pageId}`;
  activeKeys.push(activeKey);
  await redis.set(activeKey, 'must-remain-live');
  return { intentId, pageId, recoveryAdminId };
}

async function expectFileMissing(file: string): Promise<void> {
  await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
}

beforeAll(async () => {
  if (!dbAvailable || !redisAvailable) return;
  attachmentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compendiq-local-delete-recovery-'));
  process.env.ATTACHMENTS_DIR = attachmentsDir;
  await setupTestDb();
  await installProbeTriggers();
  registerOrdinaryPageWriteReconcilers();
  redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false } });
  await redis.connect();
  setRedisClient(redis);
  closeCollabBus = await initCollabBus(redis);
});

beforeEach(async () => {
  if (!dbAvailable || !redisAvailable) return;
  await truncateAllTables();
  await query(`TRUNCATE ${settlementTargetTable}, ${deleteProbeTable}`);
  await query(`ALTER SEQUENCE ${settlementSequence} RESTART WITH 1`);
  await fs.rm(attachmentsDir, { recursive: true, force: true });
  await fs.mkdir(attachmentsDir, { recursive: true });
});

afterEach(async () => {
  if (!dbAvailable || !redisAvailable) return;
  await Promise.all(activeKeys.splice(0).map((key) => redis.del(key)));
});

afterAll(async () => {
  if (!dbAvailable || !redisAvailable) return;
  await closeCollabBus?.();
  setRedisClient(null);
  await redis.quit();
  await removeProbeTriggers();
  await teardownTestDb();
  await fs.rm(attachmentsDir, { recursive: true, force: true });
});

describeIntegration('local page-delete recovery', () => {
  it.each([
    'pages.delete.standalone',
    'pages.delete.local',
    'pages.bulk.delete.local',
  ] as const)('settles proven absence for %s without cleanup or another destructive write', async (kind) => {
    const seeded = await seedUnappliedDeletion(kind);

    await expect(reconcilePageWriteIntent(seeded.intentId, {
      actorId: seeded.recoveryAdminId,
      reason: 'Settle the fenced local delete whose destructive SQL never committed',
    })).resolves.toEqual({ intentId: seeded.intentId, status: 'reconciled_not_applied' });

    expect((await query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM pages WHERE id = $1',
      [seeded.pageId],
    )).rows[0]).toEqual({ deleted_at: null });
    expect((await query(
      `SELECT delete_count FROM ${deleteProbeTable} WHERE page_id = $1`,
      [seeded.pageId],
    )).rowCount).toBe(0);
    expect(await redis.exists(`collab:active:${seeded.pageId}`)).toBe(1);
  });

  it('keeps a local delete pending when another live page claims its durable attachment identity', async () => {
    const seeded = await seedCommittedDeletion('pages.delete.local');
    await query(
      `INSERT INTO pages
         (confluence_id, space_key, title, source, visibility, created_by_user_id)
       VALUES ($1, 'REC', 'Re-imported current page', 'confluence', 'private', $2)`,
      [seeded.confluenceId, seeded.recoveryAdminId],
    );

    await expect(reconcilePageWriteIntent(seeded.intentId, {
      actorId: seeded.recoveryAdminId,
      reason: 'Refuse cleanup after the deleted attachment identity was claimed again',
    })).rejects.toMatchObject({ reason: 'intent_local_identity_changed' });

    expect((await query<{ status: string }>(
      'SELECT status FROM page_write_intents WHERE id = $1',
      [seeded.intentId],
    )).rows[0]?.status).toBe('pending');
    await expect(fs.stat(path.join(attachmentCacheDir(seeded.confluenceId!), 'cached.bin')))
      .resolves.toBeDefined();
    await expect(fs.stat(path.join(attachmentsDir, 'page-icons', String(seeded.pageId))))
      .resolves.toBeDefined();
    expect((await query<{ delete_count: number }>(
      `SELECT delete_count FROM ${deleteProbeTable} WHERE page_id = $1`,
      [seeded.pageId],
    )).rows[0]?.delete_count).toBe(1);
  });

  it.each([
    'pages.delete.standalone',
    'pages.delete.local',
    'pages.bulk.delete.local',
  ] as const)('repairs and retries %s from its committed tombstone without deleting a page twice', async (kind) => {
    const seeded = await seedCommittedDeletion(kind);

    await expect(reconcilePageWriteIntent(seeded.intentId, {
      actorId: seeded.recoveryAdminId,
      reason: 'Repair exact post-delete cleanup before settling the fenced writer intent',
    })).rejects.toMatchObject({ code: '40001' });

    expect((await query<{ status: string }>(
      'SELECT status FROM page_write_intents WHERE id = $1',
      [seeded.intentId],
    )).rows[0]?.status).toBe('pending');
    expect((await query<{ delete_count: number }>(
      `SELECT delete_count FROM ${deleteProbeTable} WHERE page_id = $1`,
      [seeded.pageId],
    )).rows[0]?.delete_count).toBe(1);
    if (seeded.preserveSharedCache) await expectFileMissing(localAttachmentsDir(seeded.pageId));
    await expectFileMissing(path.join(attachmentsDir, 'page-icons', String(seeded.pageId)));
    if (seeded.confluenceId) await expectFileMissing(attachmentCacheDir(seeded.confluenceId));
    if (seeded.preserveSharedCache) {
      await expect(fs.stat(path.join(attachmentCacheDir(String(seeded.pageId)), 'shared-or-stale.bin')))
        .resolves.toBeDefined();
    }
    expect(await redis.exists(`collab:active:${seeded.pageId}`)).toBe(0);

    // Emulate another pod recreating a stale activity marker after the first
    // recovery process died. The retry must re-run the idempotent tombstone.
    await redis.set(`collab:active:${seeded.pageId}`, 'stale-retry-writer');
    await expect(reconcilePageWriteIntent(seeded.intentId, {
      actorId: seeded.recoveryAdminId,
      reason: 'Retry the interrupted cleanup publication from durable deletion evidence',
    })).resolves.toEqual({ intentId: seeded.intentId, status: 'reconciled_applied' });

    expect(await redis.exists(`collab:active:${seeded.pageId}`)).toBe(0);
    expect((await query<{ delete_count: number }>(
      `SELECT delete_count FROM ${deleteProbeTable} WHERE page_id = $1`,
      [seeded.pageId],
    )).rows[0]?.delete_count).toBe(1);
    expect((await query<{ status: string; cache_invalidation_pending: boolean }>(
      `SELECT status, cache_invalidation_pending
         FROM page_write_intents WHERE id = $1`,
      [seeded.intentId],
    )).rows[0]).toEqual({ status: 'reconciled_applied', cache_invalidation_pending: false });
  });
});
