/**
 * The restore-derivation contract (#1953, epic #2027) on real PostgreSQL,
 * Redis and a loopback Confluence.
 *
 * A version restore records only a digest of the storage it derived. Its
 * recovery derives that storage again, possibly on a later release, with the
 * storage-derivation features the intent recorded (storage-derivation.ts).
 * {@link describeRestoreDerivationFeature} is what a pull request that
 * registers a feature runs to prove a restore reserved before its feature and
 * one reserved with it are both recovered, once, without another provider PUT.
 * {@link useRestoreDerivationHarness} is the same fixture for other cases.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { isRedisAvailable } from '../../../test-redis-helper.js';
import { query } from '../../../core/db/postgres.js';
import { reconcilePageWriteIntent } from '../../../core/services/page-write-admission.js';
import { setPageBaselineCreationEnabled } from '../../../core/services/page-baseline-service.js';
import {
  PAGE_WRITER_ENFORCEMENT_VERSION,
  registerPageBaselineEnforcementReadiness,
  setPageBaselineReadinessProvider,
} from '../../../core/services/page-baseline-governance.js';
import { setRedisClient } from '../../../core/services/redis-cache.js';
import {
  ALL_STORAGE_DERIVATION_FEATURES,
  NO_STORAGE_DERIVATION_FEATURES,
  STORAGE_DERIVATION_EFFECT_KEY,
  encodeStorageDerivationFeatures,
  type StorageDerivationFeature,
  type StorageDerivationFeatures,
} from '../../../core/services/storage-derivation.js';
import type { StorageDerivationBaseEntry } from '../../../core/services/__fixtures__/storage-derivation-base-corpus.js';
import { encryptPat } from '../../../core/utils/crypto.js';
import { ConfluenceHttpFixture } from '../../../routes/knowledge/confluence-http-fixture.test-helpers.js';
import { setRateLimit } from './confluence-rate-limiter.js';
import {
  confluencePagePutDigest,
  deriveVersionRestoreStorage,
  registerConfluencePagePutIntentReconcilers,
} from './page-put-intent-reconciler.js';

/** Whether the test PostgreSQL and Redis are reachable; the contract is skipped without them. */
export const restoreDerivationStackAvailable = (await isDbAvailable()) && (await isRedisAvailable());

/** The remote version the restore was conditional on; Confluence accepted `+ 1`. */
const EXPECTED_REMOTE_VERSION = 5;
const TARGET_VERSION = 2;
const LIVE_TITLE = 'Live title';
const RESTORED_TITLE = 'Restored title';

/** The live page and the historical version a restore derives from: the inputs of a corpus entry. */
export type RestoreDerivationInput = Pick<StorageDerivationBaseEntry, 'targetHtml' | 'previousStorage' | 'storedBodyHtml'>;

export interface SeededRestore {
  intentId: string;
  pageId: number;
  confluenceId: string;
}

export interface RestoreDerivationHarness {
  /** The loopback Confluence; `confluence.sent('update')` are the PUTs the backend issued. */
  readonly confluence: ConfluenceHttpFixture;
  readonly actorId: string;
  readonly adminId: string;
  /** A synced page as the row of `input`, with the Confluence credentials of the actor. */
  seedPage(input: Pick<RestoreDerivationInput, 'previousStorage' | 'storedBodyHtml'>): Promise<{
    pageId: number;
    confluenceId: string;
  }>;
  /** A pending intent of a fenced runtime: its request died after the provider call was sent. */
  insertPendingIntent(input: {
    kind: 'page.version_restore' | 'page.ai_apply';
    pageId: number;
    effect: Record<string, unknown>;
  }): Promise<string>;
  /**
   * A restore of `input` that reserved `reservedStorage` and recorded
   * `recordedFeatures` (`undefined`: no key, a restore reserved before the
   * first feature). Confluence accepted the PUT and holds `remoteStorage`
   * (default: what was reserved) at the conditional version.
   */
  seedRestore(input: RestoreDerivationInput & {
    reservedStorage: string;
    recordedFeatures?: unknown;
    remoteStorage?: string;
  }): Promise<SeededRestore>;
  /** Run the operator recovery of the intent. */
  recover(intentId: string): Promise<{ intentId: string; status: string }>;
  intentStatus(intentId: string): Promise<string>;
  page(pageId: number): Promise<{ title: string; body_storage: string | null; version: number; remote_version: number | null }>;
}

/**
 * Register the fixture's hooks in the enclosing `describe` (real PostgreSQL
 * and Redis, a loopback Confluence) and return its handle. Use it under
 * `describe.skipIf(!restoreDerivationStackAvailable)`.
 */
export function useRestoreDerivationHarness(): RestoreDerivationHarness {
  let confluence: ConfluenceHttpFixture;
  let cache: RedisClientType;
  let attachmentsDir = '';
  let actorId = '';
  let adminId = '';
  let sequence = 0;

  async function insertUser(role: 'user' | 'admin'): Promise<string> {
    sequence += 1;
    const result = await query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
      [`restore-derivation-${sequence}`, `restore-derivation-${sequence}@test.invalid`, role],
    );
    return result.rows[0]!.id;
  }

  beforeAll(async () => {
    await setupTestDb();
    confluence = await ConfluenceHttpFixture.start();
    setRateLimit(600);
    attachmentsDir = await mkdtemp(join(tmpdir(), 'restore-derivation-'));
    vi.stubEnv('ATTACHMENTS_DIR', attachmentsDir);
    registerPageBaselineEnforcementReadiness();
    registerConfluencePagePutIntentReconcilers();
    cache = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false } });
    await cache.connect();
    setRedisClient(cache);
  }, 60_000);

  beforeEach(async () => {
    confluence.reset();
    await truncateAllTables();
    actorId = await insertUser('user');
    adminId = await insertUser('admin');
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ('REC', 'Recovery')`);
    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, permissions)
       VALUES ($1, 'Restore derivation writer', ARRAY['read', 'write']) RETURNING id`,
      [`restore-derivation-writer-${randomUUID()}`],
    );
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ('REC', 'user', $1, $2)`,
      [actorId, role.rows[0]!.id],
    );
    await query(
      `INSERT INTO user_settings (user_id, confluence_url, confluence_pat) VALUES ($1, $2, $3)`,
      [actorId, confluence.url, encryptPat('restore-derivation-pat')],
    );
    await query(`INSERT INTO user_settings (user_id, confluence_enabled) VALUES ($1, FALSE)`, [adminId]);
    await setPageBaselineCreationEnabled(adminId, true);
  });

  afterAll(async () => {
    if (cache?.isOpen) await cache.quit();
    await confluence?.close();
    setRateLimit(60);
    await teardownTestDb();
    setPageBaselineReadinessProvider(null);
    vi.unstubAllEnvs();
    if (attachmentsDir) await rm(attachmentsDir, { recursive: true, force: true });
  });

  const harness: RestoreDerivationHarness = {
    get confluence() { return confluence; },
    get actorId() { return actorId; },
    get adminId() { return adminId; },

    async seedPage(input) {
      sequence += 1;
      const confluenceId = `restore-derivation-${sequence}`;
      const page = await query<{ id: number }>(
        `INSERT INTO pages
           (confluence_id, space_key, title, body_html, body_storage, body_text, version, remote_version,
            source, visibility, created_by_user_id, embedding_dirty, embedding_status)
         VALUES ($1, 'REC', $2, $3, $4, 'live', $5, $5, 'confluence', 'private', $6, FALSE, 'not_embedded')
         RETURNING id`,
        [confluenceId, LIVE_TITLE, input.storedBodyHtml, input.previousStorage, EXPECTED_REMOTE_VERSION, actorId],
      );
      return { pageId: page.rows[0]!.id, confluenceId };
    },

    async insertPendingIntent({ kind, pageId, effect }) {
      const revisions = await query<{ content_revision: string; lifecycle_revision: string }>(
        'SELECT content_revision::text, lifecycle_revision::text FROM pages WHERE id = $1',
        [pageId],
      );
      const runtimeId = `restore-derivation-runtime-${randomUUID()}`;
      const acknowledgmentId = randomUUID();
      await query(
        `INSERT INTO page_writer_runtimes
           (runtime_id, deployment_identity, quiesced_at, quiescence_ack, fenced_at,
            fenced_by, fence_reason, fence_proof, enforcement_version)
         VALUES ($1, $2::jsonb, NOW(), $3, NOW(), $4,
                 'Owner runtime quiesced before conditional recovery', $5::jsonb, $6)`,
        [
          runtimeId,
          JSON.stringify({ host: 'restore-derivation', startedAt: new Date().toISOString() }),
          acknowledgmentId,
          adminId,
          JSON.stringify({
            kind: 'owner_quiescence_ack',
            acknowledgmentId,
            deploymentIdentity: { host: 'restore-derivation' },
          }),
          PAGE_WRITER_ENFORCEMENT_VERSION,
        ],
      );
      const intentId = randomUUID();
      await query(
        `INSERT INTO page_write_intents
           (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect)
         VALUES ($1, $2, $3, $4, ARRAY[$5]::integer[], $6::jsonb, 'remote_conditional', $7::jsonb)`,
        [
          intentId,
          runtimeId,
          kind,
          actorId,
          pageId,
          JSON.stringify({
            [pageId]: {
              contentRevision: revisions.rows[0]!.content_revision,
              lifecycleRevision: revisions.rows[0]!.lifecycle_revision,
            },
          }),
          JSON.stringify(effect),
        ],
      );
      return intentId;
    },

    async seedRestore(input) {
      const { pageId, confluenceId } = await harness.seedPage(input);
      await query(
        `INSERT INTO page_versions (page_id, source, version_number, title, body_html, body_text)
         VALUES ($1, 'confluence', $2, $3, $4, 'restored')`,
        [pageId, TARGET_VERSION, RESTORED_TITLE, input.targetHtml],
      );
      const intentId = await harness.insertPendingIntent({
        kind: 'page.version_restore',
        pageId,
        // The effect `describeConfluencePagePut` writes for a restore; a
        // restore reserved before the first feature has every key but the last.
        effect: {
          effectClass: 'remote',
          pageId,
          confluenceId,
          expectedRemoteVersion: String(EXPECTED_REMOTE_VERSION),
          expectedLocalVersion: EXPECTED_REMOTE_VERSION,
          intendedStateDigest: confluencePagePutDigest({
            pageId,
            confluenceId,
            title: RESTORED_TITLE,
            bodyStorage: input.reservedStorage,
            expectedRemoteVersion: EXPECTED_REMOTE_VERSION,
          }),
          targetVersion: TARGET_VERSION,
          targetSource: 'confluence',
          ...(input.recordedFeatures === undefined
            ? {}
            : { [STORAGE_DERIVATION_EFFECT_KEY]: input.recordedFeatures }),
        },
      });
      confluence.addPage({
        id: confluenceId,
        title: RESTORED_TITLE,
        version: EXPECTED_REMOTE_VERSION + 1,
        storage: input.remoteStorage ?? input.reservedStorage,
      });
      return { intentId, pageId, confluenceId };
    },

    recover: (intentId) => reconcilePageWriteIntent(intentId, {
      actorId: adminId,
      reason: 'Restore-derivation contract: recover the accepted conditional restore',
    }),

    async intentStatus(intentId) {
      const result = await query<{ status: string }>('SELECT status FROM page_write_intents WHERE id = $1', [intentId]);
      return result.rows[0]!.status;
    },

    async page(pageId) {
      const result = await query<{
        title: string;
        body_storage: string | null;
        version: number;
        remote_version: number | null;
      }>('SELECT title, body_storage, version, remote_version FROM pages WHERE id = $1', [pageId]);
      return result.rows[0]!;
    },
  };
  return harness;
}

/** The restore was published once from the accepted remote version and no PUT was issued. */
export async function expectRestoreRecoveredOnce(
  harness: RestoreDerivationHarness,
  seeded: SeededRestore,
  storage: string,
): Promise<void> {
  await expect(harness.recover(seeded.intentId)).resolves.toEqual({
    intentId: seeded.intentId,
    status: 'reconciled_applied',
  });
  expect(await harness.page(seeded.pageId)).toEqual({
    title: RESTORED_TITLE,
    body_storage: storage,
    version: EXPECTED_REMOTE_VERSION + 1,
    remote_version: EXPECTED_REMOTE_VERSION + 1,
  });
  // The row the restore superseded is history, exactly once.
  expect((await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM page_versions
      WHERE page_id = $1 AND source = 'confluence' AND version_number = $2 AND title = $3`,
    [seeded.pageId, EXPECTED_REMOTE_VERSION, LIVE_TITLE],
  )).rows[0]!.count).toBe('1');
  // A settled intent is not recovered a second time.
  await expect(harness.recover(seeded.intentId)).rejects.toMatchObject({ statusCode: 409 });
  expect(await harness.intentStatus(seeded.intentId)).toBe('reconciled_applied');
  expect((await harness.page(seeded.pageId)).version).toBe(EXPECTED_REMOTE_VERSION + 1);
  expect(harness.confluence.sent('update')).toHaveLength(0);
}

/** Recovery refused the restore: the intent stays pending, the page is untouched and no PUT was issued. */
export async function expectRestoreFenced(
  harness: RestoreDerivationHarness,
  seeded: SeededRestore,
  reason: string,
): Promise<void> {
  const before = await harness.page(seeded.pageId);
  await expect(harness.recover(seeded.intentId)).rejects.toMatchObject({ statusCode: 409, reason });
  expect(await harness.intentStatus(seeded.intentId)).toBe('pending');
  expect(await harness.page(seeded.pageId)).toEqual(before);
  expect(before.version).toBe(EXPECTED_REMOTE_VERSION);
  expect(harness.confluence.sent('update')).toHaveLength(0);
}

function derive(input: RestoreDerivationInput, features: StorageDerivationFeatures): string {
  return deriveVersionRestoreStorage(
    input.targetHtml,
    { body_storage: input.previousStorage, body_html: input.storedBodyHtml },
    features,
  );
}

/**
 * The contract of one registered feature. `entry` is a base-corpus entry whose
 * derivation the feature changes (captured at the base commit, never from the
 * current converter); `featureStorage` is the literal storage the restore
 * derives for it with only this feature in force.
 */
export function describeRestoreDerivationFeature(options: {
  feature: StorageDerivationFeature;
  entry: StorageDerivationBaseEntry;
  featureStorage: string;
}): void {
  const { feature, entry, featureStorage } = options;
  const only: StorageDerivationFeatures = new Set([feature]);
  const allStorage = (): string => derive(entry, ALL_STORAGE_DERIVATION_FEATURES);

  describe.skipIf(!restoreDerivationStackAvailable)(`restore derivation feature "${feature}" (#1953)`, () => {
    const harness = useRestoreDerivationHarness();

    it('changes what the entry derives to, and only when the feature is in force', () => {
      expect(derive(entry, NO_STORAGE_DERIVATION_FEATURES)).toBe(entry.storage);
      expect(derive(entry, only)).toBe(featureStorage);
      expect(featureStorage).not.toBe(entry.storage);
    });

    it('recovers a restore reserved before the feature with the base bytes, once, without another PUT', async () => {
      const seeded = await harness.seedRestore({ ...entry, reservedStorage: entry.storage });
      await expectRestoreRecoveredOnce(harness, seeded, entry.storage);
    });

    it('recovers a restore that recorded only this feature with exactly this feature', async () => {
      const seeded = await harness.seedRestore({
        ...entry,
        reservedStorage: featureStorage,
        recordedFeatures: [feature],
      });
      await expectRestoreRecoveredOnce(harness, seeded, featureStorage);
    });

    it('recovers a restore that recorded every registered feature', async () => {
      const seeded = await harness.seedRestore({
        ...entry,
        reservedStorage: allStorage(),
        recordedFeatures: encodeStorageDerivationFeatures(ALL_STORAGE_DERIVATION_FEATURES),
      });
      await expectRestoreRecoveredOnce(harness, seeded, allStorage());
    });

    it('derives with the recorded set only: base bytes are not accepted under the feature, nor its bytes without it', async () => {
      const recordedButBase = await harness.seedRestore({
        ...entry,
        reservedStorage: entry.storage,
        recordedFeatures: [feature],
      });
      await expectRestoreFenced(harness, recordedButBase, 'intent_restore_target_changed');
      const unrecordedButFeature = await harness.seedRestore({ ...entry, reservedStorage: featureStorage });
      await expectRestoreFenced(harness, unrecordedButFeature, 'intent_restore_target_changed');
    });

    it('keeps a genuinely different historical target fenced with and without the feature', async () => {
      for (const [reservedStorage, recordedFeatures] of [
        [entry.storage, undefined],
        [featureStorage, [feature]],
      ] as const) {
        const seeded = await harness.seedRestore({ ...entry, reservedStorage, recordedFeatures });
        await query(
          `UPDATE page_versions SET body_html = body_html || '<p>rewritten after the reservation</p>'
            WHERE page_id = $1 AND version_number = $2`,
          [seeded.pageId, TARGET_VERSION],
        );
        await expectRestoreFenced(harness, seeded, 'intent_restore_target_changed');
      }
    });
  });
}
