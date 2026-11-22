/**
 * #1965 body_text backfill against real PostgreSQL (design r12 §10).
 *
 * Every race runs through the job's hooks with barriers; nothing sleeps.
 * Untouched columns are asserted by full-row comparison. Test names carry
 * the acceptance bullet (AC1–AC11, numbered as in the issue body) or the
 * maintainer decision (D1–D13) they prove.
 */
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import pg, { type PoolClient } from 'pg';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  insertTestRuntime,
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { PAGE_HIERARCHY_LOCK_ID, PAGE_LIFECYCLE_LOCK_KEY } from '../db/advisory-locks.js';
import { closePool, getPool, query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import {
  BODY_TEXT_BACKFILL_STATE_KEY,
  armBodyTextBackfill,
  formatBodyTextBackfillSummary,
  processBodyTextBackfillJob,
  runBodyTextBackfill,
  startBodyTextBackfillWorker,
  stopBodyTextBackfill,
  stopBodyTextBackfillWorker,
  type BodyTextBackfillLimits,
  type BodyTextBackfillOptions,
  type BodyTextBackfillState,
  type BodyTextBackfillSummary,
} from './body-text-backfill.js';
import { assignTaskIds, hasOnlyUncarriedTasks, htmlToText } from './content-converter.js';
import { PAGE_WRITER_ENFORCEMENT_VERSION, setPageBaselineReadinessProvider } from './page-baseline-governance.js';
import {
  freezePage,
  previewPageBaseline,
  setPageBaselineCreationEnabled,
  unfreezePage,
} from './page-baseline-service.js';
import {
  completePageWriteIntent,
  reconcilePageWriteIntent,
  reservePageWriteIntent,
  runPageWriteIntentEffect,
} from './page-write-admission.js';
import { setRedisClient } from './redis-cache.js';
import { fillVersionBody, snapshotLocalVersionBeforeOverwrite, upsertVersionMetadata } from './version-snapshot.js';
import { encryptPat } from '../utils/crypto.js';
import { confluencePagePutDigest, registerConfluencePagePutIntentReconcilers } from '../../domains/confluence/services/page-put-intent-reconciler.js';
import { recordConfluenceVersionObservation } from '../../domains/confluence/services/sync-service.js';
import { restoreVersion } from '../../domains/knowledge/services/version-tracker.js';
import { buildKnowledgeTestApp } from '../../routes/knowledge/pages.test-helpers.js';
import { searchRoutes } from '../../routes/knowledge/search.js';

const dbAvailable = await isDbAvailable();
const redisAvailable = dbAvailable && await isRedisAvailable();

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A pre-#1735 pair: html shows `&lt;word&gt;`, stored text was decoded twice to `<word>`. */
function preFix(word = 'br', prefix = 'Use'): { html: string; text: string; fixed: string } {
  return {
    html: `<p>${prefix} &amp;lt;${word}&amp;gt; here</p>`,
    text: `${prefix} <${word}> here`,
    fixed: `${prefix} &lt;${word}&gt; here`,
  };
}

let sequence = 0;
async function insertUser(role: 'user' | 'admin' = 'user'): Promise<string> {
  sequence += 1;
  const suffix = `${sequence}-${randomUUID().slice(0, 8)}`;
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role, display_name)
     VALUES ($1, $2, 'x', $3, $1) RETURNING id`,
    [`backfill-${suffix}`, `backfill-${suffix}@test.invalid`, role],
  );
  return result.rows[0]!.id;
}

interface PageSeed {
  title?: string;
  html?: string | null;
  text?: string | null;
  draftHtml?: string | null;
  draftText?: string | null;
  source?: 'standalone' | 'confluence';
  version?: number;
  remoteVersion?: number | null;
  localModifiedBy?: string | null;
  localModifiedAt?: Date | null;
  deletedAt?: Date | null;
  createdBy?: string | null;
  spaceKey?: string | null;
  visibility?: 'shared' | 'private';
}

async function insertPage(seed: PageSeed = {}): Promise<number> {
  const source = seed.source ?? 'standalone';
  const result = await query<{ id: number }>(
    `INSERT INTO pages
       (title, body_html, body_storage, body_text, draft_body_html, draft_body_text, source, version,
        remote_version, confluence_id, local_modified_by, local_modified_at, deleted_at, created_by_user_id,
        visibility, space_key, embedding_dirty, embedding_status, labels, inherit_perms)
     VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $15, $14, FALSE, 'not_embedded',
             ARRAY['keep'], TRUE)
     RETURNING id`,
    [
      seed.title ?? 'Neutral title', seed.html === undefined ? preFix().html : seed.html,
      seed.text === undefined ? preFix().text : seed.text, seed.draftHtml ?? null, seed.draftText ?? null, source,
      seed.version ?? 7, seed.remoteVersion ?? null, source === 'confluence' ? `c-${randomUUID()}` : null,
      seed.localModifiedBy ?? null, seed.localModifiedAt ?? null, seed.deletedAt ?? null, seed.createdBy ?? null,
      seed.spaceKey ?? null, seed.visibility ?? 'shared',
    ],
  );
  return result.rows[0]!.id;
}

interface VersionSeed {
  source?: 'local' | 'confluence';
  version: number;
  title?: string;
  html: string | null;
  text: string | null;
  id?: string;
}

async function insertVersion(pageId: number, seed: VersionSeed): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO page_versions (id, page_id, source, version_number, title, body_html, body_text)
     VALUES (COALESCE($7::uuid, gen_random_uuid()), $1, $2, $3, $4, $5, $6) RETURNING id::text AS id`,
    [pageId, seed.source ?? 'local', seed.version, seed.title ?? `Snapshot ${seed.version}`, seed.html, seed.text,
      seed.id ?? null],
  );
  return result.rows[0]!.id;
}

async function pageRow(pageId: number): Promise<Record<string, unknown>> {
  return (await query('SELECT * FROM pages WHERE id = $1', [pageId])).rows[0]!;
}

async function versionRow(id: string): Promise<Record<string, unknown> | undefined> {
  return (await query('SELECT * FROM page_versions WHERE id = $1', [id])).rows[0];
}

async function versionRows(pageId: number): Promise<Record<string, unknown>[]> {
  return (await query('SELECT * FROM page_versions WHERE page_id = $1 ORDER BY id', [pageId])).rows;
}

/** Full-row comparison: every column except `changed` is byte-identical. */
function expectUnchangedExcept(before: Record<string, unknown>, after: Record<string, unknown>, changed: string[]): void {
  const strip = (row: Record<string, unknown>) => Object.fromEntries(
    Object.entries(row).filter(([key]) => !changed.includes(key)),
  );
  expect(strip(after)).toEqual(strip(before));
}

async function state(): Promise<BodyTextBackfillState> {
  const row = (await query<{ setting_value: string }>(
    'SELECT setting_value FROM admin_settings WHERE setting_key = $1', [BODY_TEXT_BACKFILL_STATE_KEY],
  )).rows[0];
  return JSON.parse(row!.setting_value) as BodyTextBackfillState;
}

/** Rewrite the state row as an earlier (or crashed) run would have left it. */
async function patchState(patch: Partial<BodyTextBackfillState>, updatedAgo = '0 seconds'): Promise<void> {
  const current = await state();
  await query(
    `UPDATE admin_settings SET setting_value = $2, updated_at = NOW() - $3::interval WHERE setting_key = $1`,
    [BODY_TEXT_BACKFILL_STATE_KEY, JSON.stringify({ ...current, ...patch }), updatedAgo],
  );
}

async function dbNow(): Promise<number> {
  return (await query<{ now: Date }>('SELECT NOW() AS now')).rows[0]!.now.getTime();
}

const run = (options: BodyTextBackfillOptions = {}): Promise<BodyTextBackfillSummary> => runBodyTextBackfill(options);

/** Resolves when the job reached a hook; the job then waits until `release`. */
function pause<A extends unknown[]>(): { reached: Promise<void>; release: () => void; hook: (...args: A) => Promise<void> } {
  let reachedResolve!: () => void;
  let releaseResolve!: () => void;
  const reached = new Promise<void>((resolve) => { reachedResolve = resolve; });
  const released = new Promise<void>((resolve) => { releaseResolve = resolve; });
  let used = false;
  return {
    reached,
    release: releaseResolve,
    hook: async () => {
      if (used) return;
      used = true;
      reachedResolve();
      await released;
    },
  };
}

/** True once some other backend waits on a lock held elsewhere (pg_blocking_pids). */
async function expectBlockedBackend(match: string): Promise<void> {
  await expect.poll(async () => (await query<{ waiting: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND query LIKE $1 AND cardinality(pg_blocking_pids(pid)) > 0
     ) AS waiting`, [match],
  )).rows[0]!.waiting, { timeout: 15_000, interval: 20 }).toBe(true);
}

async function withClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

/**
 * A transaction on its own connection, outside the pool, so pool swaps
 * (the COMMIT-dropping proxy) never wait for it.
 */
async function withHeldClient(): Promise<{ client: pg.Client; done: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: process.env.POSTGRES_URL });
  await client.connect();
  await client.query('BEGIN');
  return {
    client,
    done: async () => {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    },
  };
}

/** A published baseline row (status `published`) for `pageId`, optionally linking a snapshot. */
async function insertBaseline(pageId: number, actorId: string, versionSnapshotId: string | null): Promise<string> {
  const baselineId = randomUUID();
  const preparation = await reservePageWriteIntent({
    pageIds: [pageId], kind: 'baseline.prepare', actorId, effect: { effectClass: 'local', baselineId },
  });
  await runPageWriteIntentEffect(preparation, { kind: 'local' }, async () => undefined);
  await completePageWriteIntent(preparation, async () => undefined);
  const revision = (await query<{ c: string; l: string }>(
    'SELECT content_revision::text AS c, lifecycle_revision::text AS l FROM pages WHERE id = $1', [pageId],
  )).rows[0]!;
  await query(
    `INSERT INTO page_baselines
       (id, page_id, original_page_id, page_identity, version, content_revision,
        lifecycle_revision, manifest_digest, manifest, manifest_bytes, title,
        labels, attachments, total_bytes, reserved_bytes, status,
        prepared_by_user_id, prepared_by_name, published_by_user_id,
        published_by_name, published_at, provenance, freeze_reason, preparation_intent_id, version_snapshot_id)
     VALUES ($1, $2, $2, '[]'::jsonb, 1, $3::bigint, $4::bigint,
             $5, '[]'::jsonb, $6, 'Baseline', '{}', '[]'::jsonb, 0, 0,
             'published', $7, 'Test actor', $7, 'Test actor', NOW(),
             'manual_assertion', 'Test freeze reason', $8, $9)`,
    [baselineId, pageId, revision.c, revision.l, 'a'.repeat(64), Buffer.from('[]'), actorId, preparation.id,
      versionSnapshotId],
  );
  return baselineId;
}

/** Freeze fixture: a published baseline plus the frozen page columns. */
async function freezeFixture(pageId: number, actorId: string): Promise<void> {
  const baselineId = await insertBaseline(pageId, actorId, null);
  await query(
    `UPDATE pages
        SET baseline_id = $2, frozen_version = version, frozen_at = NOW(),
            frozen_by_user_id = $3, frozen_by_name = 'Test actor',
            freeze_reason = 'Test freeze reason', freeze_provenance = 'manual_assertion',
            freeze_reported_signatories = '[]'::jsonb
      WHERE id = $1`,
    [pageId, baselineId, actorId],
  );
}

/** An administrator with the Confluence integration off and baseline creation enabled. */
async function freezingAdmin(): Promise<string> {
  const admin = await insertUser('admin');
  await query('INSERT INTO user_settings (user_id, confluence_enabled) VALUES ($1, FALSE)', [admin]);
  await setPageBaselineCreationEnabled(admin, true);
  return admin;
}

/** The real freeze: preview, then publish (lifecycle_revision + 1, local snapshot link). */
async function realFreeze(pageId: number, actorId: string): Promise<{ baselineId: string; lifecycleRevision: string }> {
  const prepared = await previewPageBaseline(pageId, actorId);
  const frozen = await freezePage({
    pageId, actorId, reason: 'Freeze the reviewed page for the backfill test',
    expectedContentRevision: prepared.contentRevision, expectedManifestDigest: prepared.manifestDigest,
  });
  return { baselineId: frozen.baselineId!, lifecycleRevision: frozen.lifecycleRevision };
}

async function realThaw(pageId: number, actorId: string, frozen: { baselineId: string; lifecycleRevision: string }): Promise<void> {
  await unfreezePage(pageId, actorId, {
    reason: 'Thaw the page again for the backfill test',
    expectedBaselineId: frozen.baselineId, expectedLifecycleRevision: frozen.lifecycleRevision,
  });
}

/** A pending external write intent covering `pageId` (the page is `busy`). */
async function pendingIntent(pageId: number, kind = 'page.relocate'): Promise<string> {
  const runtimeId = await insertTestRuntime();
  const revision = (await query<{ c: string; l: string }>(
    'SELECT content_revision::text AS c, lifecycle_revision::text AS l FROM pages WHERE id = $1', [pageId],
  )).rows[0]!;
  const result = await query<{ id: string }>(
    `INSERT INTO page_write_intents (runtime_id, kind, page_ids, revisions, recovery_mode, effect)
     VALUES ($1, $2, ARRAY[$3]::integer[], $4::jsonb, $6, $5::jsonb) RETURNING id`,
    [runtimeId, kind, pageId, JSON.stringify({ [pageId]: { contentRevision: revision.c, lifecycleRevision: revision.l } }),
      JSON.stringify(kind === 'page.version_restore'
        ? { effectClass: 'remote', pageId, confluenceId: 'c-restore', expectedRemoteVersion: '7',
          intendedStateDigest: 'a'.repeat(64), targetVersion: 2 }
        : { effectClass: 'remote', pageId }),
      kind === 'page.version_restore' ? 'remote_conditional' : 'remote_terminal_only'],
  );
  return result.rows[0]!.id;
}

async function settleIntent(intentId: string): Promise<void> {
  await query('DELETE FROM page_relocation_preparations WHERE intent_id = $1', [intentId]);
  await query(
    `UPDATE page_write_intents SET status = 'cancelled', settled_at = NOW(),
            settlement_reason = 'test_settled', settlement_proof = '{"assertion":"no_remote_io_began"}'::jsonb
      WHERE id = $1`,
    [intentId],
  );
}

/** Drop the real PostgreSQL acknowledgment of the next COMMIT once `arm()` was called. */
async function withLostCommitAcknowledgment(
  operation: (arm: () => void) => Promise<void>,
): Promise<{ dropped: () => boolean }> {
  const originalUrl = process.env.POSTGRES_URL!;
  const upstreamUrl = new URL(originalUrl);
  const sockets = new Set<Socket>();
  let armed = false;
  let dropped = false;
  const proxy = createServer((downstream) => {
    const upstream = createConnection({ host: upstreamUrl.hostname, port: Number(upstreamUrl.port || 5432) });
    sockets.add(downstream);
    sockets.add(upstream);
    downstream.pipe(upstream);
    let buffered: Buffer = Buffer.alloc(0);
    upstream.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 5) {
        const size = 1 + buffered.readUInt32BE(1);
        if (buffered.length < size) break;
        const message = buffered.subarray(0, size);
        buffered = buffered.subarray(size);
        // CommandComplete proves PostgreSQL committed; the client never sees it.
        if (armed && !dropped && message[0] === 0x43 && message.subarray(5).toString() === 'COMMIT\0') {
          dropped = true;
          downstream.destroy();
          upstream.destroy();
          return;
        }
        downstream.write(message);
      }
    });
    downstream.on('error', () => upstream.destroy());
    upstream.on('error', () => downstream.destroy());
    downstream.on('close', () => { sockets.delete(downstream); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); downstream.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  const proxyUrl = new URL(originalUrl);
  proxyUrl.hostname = '127.0.0.1';
  proxyUrl.port = String((proxy.address() as AddressInfo).port);
  try {
    await closePool();
    process.env.POSTGRES_URL = proxyUrl.toString();
    await operation(() => { armed = true; });
  } finally {
    await closePool();
    process.env.POSTGRES_URL = originalUrl;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => { proxy.close((error) => error ? reject(error) : resolve()); });
  }
  return { dropped: () => dropped };
}

/** Fresh module instances: a second replica with its own process state and pool. */
async function replica(): Promise<{
  run: typeof runBodyTextBackfill; close: () => Promise<void>;
  quiesce?: () => Promise<void>;
}> {
  vi.resetModules();
  const job = await import('./body-text-backfill.js');
  const pg = await import('../db/postgres.js');
  const admission = await import('./page-write-admission.js');
  vi.resetModules();
  return {
    run: job.runBodyTextBackfill,
    close: async () => {
      await job.stopBodyTextBackfill();
      await pg.closePool();
    },
    quiesce: async () => {
      const admin = await insertUser('admin');
      await admission.quiescePageWriterRuntime({ actorId: admin, reason: 'Quiesce the replica before its next checkout' });
    },
  };
}

const counts = (summary: BodyTextBackfillSummary) => summary.counts;

describe.skipIf(!dbAvailable)('body_text backfill (#1965) — real PostgreSQL', () => {
  let attachmentsDir: string;
  let redis: RedisClientType | null = null;

  beforeAll(async () => {
    await setupTestDb();
    attachmentsDir = await mkdtemp(join(tmpdir(), 'body-text-backfill-'));
    vi.stubEnv('ATTACHMENTS_DIR', attachmentsDir);
    if (redisAvailable) {
      redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false } });
      await redis.connect();
      setRedisClient(redis);
    }
    setPageBaselineReadinessProvider(async () => ({ ready: true, blockers: [] }));
  });

  beforeEach(async () => {
    armBodyTextBackfill();
    await truncateAllTables();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    setPageBaselineReadinessProvider(null);
    if (redis?.isOpen) await redis.quit();
    vi.unstubAllEnvs();
    await rm(attachmentsDir, { recursive: true, force: true });
    await teardownTestDb();
  });

  // ─── 1. Repair ────────────────────────────────────────────────────────────

  describe('1. repair', () => {
    async function seedSentinels(pageId: number): Promise<void> {
      await query(
        `UPDATE pages SET summary_ai_operation_id = gen_random_uuid(), summary_ai_attempt = 3,
                          quality_ai_operation_id = gen_random_uuid(), quality_ai_attempt = 2
          WHERE id = $1`,
        [pageId],
      );
      await query(
        `INSERT INTO embedding_ai_operations (page_id, content_revision, image_revision)
         SELECT id, content_revision, image_analysis_revision FROM pages WHERE id = $1`,
        [pageId],
      );
      await query('DELETE FROM deterministic_relationship_dirty');
    }

    async function consequences(pageId: number) {
      const page = (await query<{
        content_revision: string; summary_ai_operation_id: string | null; summary_ai_attempt: number;
        quality_ai_operation_id: string | null; quality_ai_attempt: number; tsv_br: boolean;
      }>(
        `SELECT content_revision::text, summary_ai_operation_id, summary_ai_attempt, quality_ai_operation_id,
                quality_ai_attempt, tsv @@ to_tsquery('simple', 'br') AS tsv_br
           FROM pages WHERE id = $1`, [pageId],
      )).rows[0]!;
      const embeddingOperation = (await query('SELECT 1 FROM embedding_ai_operations WHERE page_id = $1', [pageId])).rows.length;
      const relationshipDirty = (await query('SELECT 1 FROM deterministic_relationship_dirty WHERE page_id = $1', [pageId])).rows.length;
      return { ...page, embeddingOperation, relationshipDirty };
    }

    it('AC1/AC5: corrects published body_text with content_revision +1, tsv rebuilt, relationship-dirty, summary/quality/embedding operation resets; untouched columns unchanged', async () => {
      const pair = preFix();
      const pageId = await insertPage({ html: pair.html, text: pair.text });
      await seedSentinels(pageId);
      const before = await pageRow(pageId);
      expect((await consequences(pageId)).tsv_br).toBe(false);

      const summary = await run();

      expect(summary.outcome).toBe('done');
      const after = await pageRow(pageId);
      expect(after.body_text).toBe(pair.fixed);
      const effect = await consequences(pageId);
      expect(Number(effect.content_revision)).toBe(Number(before.content_revision) + 1);
      expect(effect.tsv_br).toBe(true);
      expect(effect.relationshipDirty).toBe(1);
      expect(effect.summary_ai_operation_id).toBeNull();
      expect(effect.summary_ai_attempt).toBe(0);
      expect(effect.quality_ai_operation_id).toBeNull();
      expect(effect.quality_ai_attempt).toBe(0);
      expect(effect.embeddingOperation).toBe(0);
      expectUnchangedExcept(before, after, [
        'body_text', 'content_revision', 'tsv', 'summary_ai_operation_id', 'summary_ai_attempt',
        'quality_ai_operation_id', 'quality_ai_attempt',
      ]);
      expect(after.local_modified_at).toBeNull();
      expect(counts(summary).repaired).toBe(1);
    });

    it('AC1/§9: corrects a draft only — one statement, content_revision +1, operation resets; tsv, relationship marker and local_modified_at untouched', async () => {
      const pair = preFix('em');
      const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain', draftHtml: pair.html, draftText: pair.text });
      await seedSentinels(pageId);
      const before = await pageRow(pageId);
      const statements: string[] = [];
      await run({ hooks: { onStatement: (info) => { statements.push(info.kind); } } });
      const after = await pageRow(pageId);
      expect(after.draft_body_text).toBe(pair.fixed);
      const effect = await consequences(pageId);
      expect(Number(effect.content_revision)).toBe(Number(before.content_revision) + 1);
      expect(effect.relationshipDirty).toBe(0);
      expect(effect.summary_ai_operation_id).toBeNull();
      expect(effect.quality_ai_operation_id).toBeNull();
      expect(effect.embeddingOperation).toBe(0);
      expect(statements.filter((kind) => kind === 'write_page')).toHaveLength(1);
      expectUnchangedExcept(before, after, [
        'draft_body_text', 'content_revision', 'summary_ai_operation_id', 'summary_ai_attempt',
        'quality_ai_operation_id', 'quality_ai_attempt',
      ]);
    });

    it('AC1: corrects published and draft in one statement (content_revision +1 exactly)', async () => {
      const published = preFix('br');
      const draft = preFix('em', 'Draft');
      const pageId = await insertPage({ html: published.html, text: published.text, draftHtml: draft.html, draftText: draft.text });
      const before = await pageRow(pageId);
      const statements: string[] = [];
      await run({ hooks: { onStatement: (info) => { statements.push(info.kind); } } });
      const after = await pageRow(pageId);
      expect(after.body_text).toBe(published.fixed);
      expect(after.draft_body_text).toBe(draft.fixed);
      expect(Number(after.content_revision)).toBe(Number(before.content_revision) + 1);
      expect(statements.filter((kind) => kind === 'write_page')).toHaveLength(1);
    });

    it('§9 exception: published and draft whose corrected texts together exceed the statement budget are still one page update, reported with its real bytes', async () => {
      const published = preFix('br');
      const draft = preFix('em', 'Draft');
      const pageId = await insertPage({ html: published.html, text: published.text, draftHtml: draft.html, draftText: draft.text });
      const before = await pageRow(pageId);
      // Each column fits the budget alone; the two corrected texts do not.
      const statementBytes = 38;
      const corrected = Buffer.byteLength(published.fixed) + Buffer.byteLength(draft.fixed);
      expect(corrected).toBeGreaterThan(statementBytes);
      const writes: number[] = [];
      await run({
        limits: { statementBytes },
        hooks: { onStatement: (info) => { if (info.kind === 'write_page') writes.push(info.bytes); } },
      });
      const after = await pageRow(pageId);
      expect(after.body_text).toBe(published.fixed);
      expect(after.draft_body_text).toBe(draft.fixed);
      expect(Number(after.content_revision)).toBe(Number(before.content_revision) + 1);
      expect(writes).toEqual([corrected]);
    });

    it('AC1/§9: corrects a page_versions row only — no page update, revision unchanged, page row identical', async () => {
      const pair = preFix('code');
      const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      const versionId = await insertVersion(pageId, { version: 3, html: pair.html, text: pair.text });
      const before = await pageRow(pageId);
      const versionBefore = await versionRow(versionId);
      const statements: string[] = [];
      await run({ hooks: { onStatement: (info) => { statements.push(info.kind); } } });
      expect(await pageRow(pageId)).toEqual(before);
      expect(statements).not.toContain('write_page');
      const versionAfter = await versionRow(versionId);
      expect(versionAfter!.body_text).toBe(pair.fixed);
      expectUnchangedExcept(versionBefore!, versionAfter!, ['body_text']);
    });

    it('AC1/D11: corrects published, draft and history together in one transaction', async () => {
      const published = preFix('br');
      const draft = preFix('em', 'Draft');
      const history = preFix('code', 'Old');
      const pageId = await insertPage({ html: published.html, text: published.text, draftHtml: draft.html, draftText: draft.text });
      const versionId = await insertVersion(pageId, { version: 2, html: history.html, text: history.text });
      const before = await pageRow(pageId);
      const summary = await run();
      const after = await pageRow(pageId);
      expect(after.body_text).toBe(published.fixed);
      expect(after.draft_body_text).toBe(draft.fixed);
      expect((await versionRow(versionId))!.body_text).toBe(history.fixed);
      expect(Number(after.content_revision)).toBe(Number(before.content_revision) + 1);
      expect(counts(summary).repaired).toBe(3);
    });

    it('D2/AC8: advances local_modified_at on a row with a local edit, sets it for local_modified_by without a timestamp, leaves it NULL without a local edit; never writes version, title, labels, local_modified_by', async () => {
      const actor = await insertUser();
      const pair = preFix();
      const edited = await insertPage({ html: pair.html, text: pair.text, localModifiedBy: actor, localModifiedAt: new Date('2020-01-01T00:00:00Z') });
      const markerOnly = await insertPage({ html: pair.html, text: pair.text, localModifiedBy: actor, localModifiedAt: null });
      const clean = await insertPage({ html: pair.html, text: pair.text });
      const before = await Promise.all([edited, markerOnly, clean].map(pageRow));
      await run();
      const after = await Promise.all([edited, markerOnly, clean].map(pageRow));
      expect(after.map((row) => row.body_text)).toEqual([pair.fixed, pair.fixed, pair.fixed]);
      expect((after[0]!.local_modified_at as Date).getTime()).toBeGreaterThan(new Date('2020-01-01T00:00:00Z').getTime());
      expect(after[1]!.local_modified_at).not.toBeNull();
      expect(after[2]!.local_modified_at).toBeNull();
      const changed = ['body_text', 'content_revision', 'tsv', 'local_modified_at'];
      after.forEach((row, index) => expectUnchangedExcept(before[index]!, row, changed));
    });

    it('AC4: corrects a trashed page', async () => {
      const pair = preFix();
      const pageId = await insertPage({ html: pair.html, text: pair.text, deletedAt: new Date() });
      await run();
      expect((await pageRow(pageId)).body_text).toBe(pair.fixed);
    });

    it('AC3: a frozen page is skipped without page_is_frozen while its affected, unlinked history row unrelated to the live text is repaired', async () => {
      const actor = await insertUser();
      const live = preFix('br');
      const history = preFix('code', 'Old');
      const pageId = await insertPage({ html: live.html, text: live.text });
      const versionId = await insertVersion(pageId, { version: 3, html: history.html, text: history.text });
      await freezeFixture(pageId, actor);
      const before = await pageRow(pageId);
      const summary = await run();
      expect(summary.outcome).toBe('done');
      expect(await pageRow(pageId)).toEqual(before);
      expect((await versionRow(versionId))!.body_text).toBe(history.fixed);
      expect(counts(summary)).toMatchObject({ frozen: 1, no_text: 1, repaired: 1 });
    });

    it('AC1: keyword search through the real route finds `br` on a neutral-title page only after the repair', async () => {
      const userId = await insertUser();
      await query(`INSERT INTO spaces (space_key, space_name) VALUES ('DEV', 'Dev')`);
      const role = await query<{ id: number }>(
        `INSERT INTO roles (name, display_name, permissions) VALUES ($1, 'Reader', ARRAY['read']) RETURNING id`,
        [`backfill-reader-${randomUUID()}`],
      );
      await query(
        `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id) VALUES ('DEV', 'user', $1, $2)`,
        [userId, role.rows[0]!.id],
      );
      const pair = preFix();
      await insertPage({ html: pair.html, text: pair.text, source: 'confluence', spaceKey: 'DEV', title: 'Release notes' });
      const app: FastifyInstance = Fastify({ logger: false });
      await app.register(sensible);
      app.decorate('authenticate', async (request: { userId: string }) => { request.userId = userId; });
      await app.register(searchRoutes, { prefix: '/api' });
      await app.ready();
      try {
        const search = async () => {
          const response = await app.inject({ method: 'GET', url: '/api/search?q=br&mode=keyword' });
          expect(response.statusCode).toBe(200);
          return (response.json() as { items: { title: string }[] }).items.map((item) => item.title);
        };
        expect(await search()).toEqual([]);
        await run();
        expect(await search()).toEqual(['Release notes']);
      } finally {
        await app.close();
      }
    });

    it('AC2: a second run touches 0 rows (restart re-check pass)', async () => {
      const pair = preFix();
      const pageId = await insertPage({ html: pair.html, text: pair.text });
      await insertVersion(pageId, { version: 2, html: pair.html, text: pair.text });
      expect(counts(await run()).repaired).toBe(2);
      const before = await pageRow(pageId);
      const versionsBefore = await versionRows(pageId);
      const second = await run({ restart: true });
      expect(second.outcome).toBe('done');
      expect(counts(second).repaired ?? 0).toBe(0);
      expect(counts(second).current).toBe(2);
      expect(await pageRow(pageId)).toEqual(before);
      expect(await versionRows(pageId)).toEqual(versionsBefore);
      expect((await state()).passTotals.repaired ?? 0).toBe(0);
    });
  });

  // ─── 2. Copies never touched ─────────────────────────────────────────────

  describe('2. copies never touched, each counted under its reason', () => {
    it('AC3: Notion-joined, folder, already-current, no-&, oversized (never loaded), NULL-body versions (not counted), relocation preparation, pending sync version, baseline-linked unrelated snapshot', async () => {
      const actor = await insertUser();
      const limits: Partial<BodyTextBackfillLimits> = { ceilingBytes: 4096 };
      const notion = await insertPage({ html: '<p>Intro &amp;lt;b&amp;gt;</p><p>Second</p>', text: 'Intro &lt;b&gt;\n\nSecond' });
      const folder = await insertPage({ html: '', text: '' });
      const current = await insertPage({ html: preFix().html, text: preFix().fixed });
      const noAmp = await insertPage({ html: '<p>plain words</p>', text: 'plain words' });
      const bigHtml = await insertPage({ html: `<p>${'x'.repeat(5000)}</p>`, text: 'x' });
      const bigText = await insertPage({ html: preFix().html, text: 'y'.repeat(5000) });
      const withNullVersions = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      await insertVersion(withNullVersions, { version: 1, html: null, text: null });
      await insertVersion(withNullVersions, { version: 2, html: null, text: preFix().text });
      await insertVersion(withNullVersions, { version: 3, html: preFix().html, text: null });
      const linkedOwner = await insertPage({ html: preFix().html, text: preFix().text });
      const linkedId = await insertVersion(linkedOwner, { version: 2, html: preFix('em').html, text: preFix('em').text });
      await insertBaseline(linkedOwner, actor, linkedId);
      const pendingSync = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      await query(
        `INSERT INTO pending_sync_versions (page_id, confluence_version, body_storage, body_html, body_text, sync_run_id)
         VALUES ($1, 9, $2, $2, $3, gen_random_uuid())`,
        [pendingSync, preFix().html, preFix().text],
      );
      const relocating = await insertPage({ html: preFix().html, text: preFix().text, source: 'confluence', spaceKey: 'CONF' });
      const relocationIntent = await pendingIntent(relocating);
      await query(
        `INSERT INTO page_relocation_preparations (
           intent_id, page_id, direction, actor_id, target_space_key, target_visibility, original_source,
           original_confluence_id, original_space_key, original_title, original_body_html, original_body_storage,
           original_body_text, original_version, original_visibility, original_inherit_perms, original_embedding_dirty,
           original_image_analysis_dirty, original_key, child_ids, access_control_entries, attachments)
         SELECT $1, id, 'to_local', $2, 'LOCAL', 'shared', source, confluence_id, space_key, title, body_html,
                body_storage, body_text, version, visibility, TRUE, FALSE, FALSE, confluence_id, '{}'::integer[],
                '[]'::jsonb, '[]'::jsonb
           FROM pages WHERE id = $3`,
        [relocationIntent, actor, relocating],
      );
      const exempt = async () => ({
        notion: await pageRow(notion), folder: await pageRow(folder), current: await pageRow(current),
        noAmp: await pageRow(noAmp), bigHtml: await pageRow(bigHtml), bigText: await pageRow(bigText),
        nullVersions: await versionRows(withNullVersions), linked: await versionRow(linkedId),
        pending: (await query('SELECT * FROM pending_sync_versions WHERE page_id = $1', [pendingSync])).rows,
        preparation: (await query('SELECT * FROM page_relocation_preparations WHERE page_id = $1', [relocating])).rows,
        relocating: await pageRow(relocating),
      });
      const before = await exempt();
      const loaded: string[] = [];
      const summary = await run({
        limits,
        hooks: { onLoad: (info) => { loaded.push(`${info.ownerId}:${info.key}`); } },
      });
      expect(await exempt()).toEqual(before);
      // The linked snapshot is unrelated to A: its page is still repaired.
      expect((await pageRow(linkedOwner)).body_text).toBe(preFix().fixed);
      expect(loaded.some((key) => key.startsWith(`${bigHtml}:`) || key.startsWith(`${bigText}:`))).toBe(false);
      expect(counts(summary)).toMatchObject({
        diverged: 1, current: 1, oversized: 2, baseline_referenced: 1, repaired: 1, busy: 1,
      });
      // folder `''`, no-&, and the plain pages: html without `&`.
      expect(counts(summary).no_ampersand).toBe(4);
      expect((await state()).unresolved.ids).toEqual([relocating]);
    });
  });

  // ─── 3. Whole page or nothing (job-level fixtures) ───────────────────────

  describe('3. whole page or nothing (D11)', () => {
    const pair = preFix();
    const other = preFix('em', 'Other');
    type Witness = {
      name: string;
      seed: (pageId: number, actor: string, text: string) => Promise<void>;
      frozenOwner?: boolean;
    };
    const witnesses: Witness[] = [
      {
        name: 'a baseline-linked snapshot',
        seed: async (pageId, actor, text) => {
          const id = await insertVersion(pageId, { version: 3, html: text === pair.text ? pair.html : other.html, text });
          await insertBaseline(pageId, actor, id);
        },
      },
      {
        name: 'a text-only snapshot',
        seed: async (pageId, _actor, text) => { await insertVersion(pageId, { source: 'confluence', version: 3, html: null, text }); },
      },
      {
        name: "a frozen page's own published text",
        frozenOwner: true,
        seed: async () => undefined,
      },
      {
        name: 'a diverged copy (same text, other html)',
        seed: async (pageId, _actor, text) => { await insertVersion(pageId, { version: 3, html: '<p>Other &amp;amp; html</p>', text }); },
      },
      {
        name: 'a current copy',
        seed: async (pageId, _actor, text) => {
          await insertVersion(pageId, { version: 3, html: `<p>${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`, text });
        },
      },
      {
        name: 'a no-& copy',
        seed: async (pageId, _actor, text) => { await insertVersion(pageId, { version: 3, html: '<p>no ampersand</p>', text }); },
      },
      {
        name: 'a copy with small matching text and over-ceiling html (its html is never read)',
        seed: async (pageId, _actor, text) => {
          await insertVersion(pageId, { version: 3, html: `<p>&amp;${'z'.repeat(6000)}</p>`, text });
        },
      },
    ];

    for (const witness of witnesses) {
      it(`D11 rule (a): ${witness.name} with the same stored text leaves every copy unchanged (paired_exempt); with a different text the page is repaired`, async () => {
        const actor = await insertUser();
        const limits: Partial<BodyTextBackfillLimits> = { ceilingBytes: 4096 };
        // Same stored text → exempt.
        let same: number;
        let affectedVersion: string | null = null;
        if (witness.frozenOwner) {
          same = await insertPage({ html: pair.html, text: pair.text });
          affectedVersion = await insertVersion(same, { version: 3, html: pair.html, text: pair.text });
          await freezeFixture(same, actor);
        } else {
          same = await insertPage({ html: pair.html, text: pair.text });
          await witness.seed(same, actor, pair.text);
        }
        // Different stored text → repaired.
        let different: number;
        let differentVersion: string | null = null;
        if (witness.frozenOwner) {
          different = await insertPage({ html: other.html, text: other.text });
          differentVersion = await insertVersion(different, { version: 3, html: pair.html, text: pair.text });
          await freezeFixture(different, actor);
        } else {
          different = await insertPage({ html: pair.html, text: pair.text });
          await witness.seed(different, actor, other.text);
        }
        const sameBefore = { page: await pageRow(same), versions: await versionRows(same) };
        const loadedHtml: string[] = [];
        const summary = await run({ limits, hooks: { onLoad: (info) => { loadedHtml.push(`${info.ownerId}:${info.key}`); } } });
        expect({ page: await pageRow(same), versions: await versionRows(same) }).toEqual(sameBefore);
        expect(counts(summary).paired_exempt).toBe(1);
        if (witness.frozenOwner) {
          expect((await versionRow(differentVersion!))!.body_text).toBe(pair.fixed);
          expect(affectedVersion).not.toBeNull();
        } else {
          expect((await pageRow(different)).body_text).toBe(pair.fixed);
        }
        expect(counts(summary).repaired).toBe(1);
        if (witness.name.includes('over-ceiling')) {
          expect(loadedHtml.filter((key) => key.startsWith(`${same}:v:`))).toEqual([]);
        }
      });
    }

    it('D11 rule (b): two affected copies with equal stored text but different corrected texts → nothing written (paired_exempt)', async () => {
      const pageId = await insertPage({ html: '<p>&amp;lt;br&amp;gt;</p>', text: '<br>' });
      await insertVersion(pageId, { version: 3, html: '<p>&amp;#60;br&amp;#62;</p>', text: '<br>' });
      const before = { page: await pageRow(pageId), versions: await versionRows(pageId) };
      const summary = await run();
      expect({ page: await pageRow(pageId), versions: await versionRows(pageId) }).toEqual(before);
      expect(counts(summary).paired_exempt).toBe(2);
    });

    it('D11: a standalone page with an unlinked text-only confluence:8 of the same text is exempt (not narrowed by reachability); of a different text it is repaired', async () => {
      const exempt = await insertPage({ html: pair.html, text: pair.text, version: 7 });
      await insertVersion(exempt, { source: 'confluence', version: 8, html: null, text: pair.text });
      const repaired = await insertPage({ html: pair.html, text: pair.text, version: 7 });
      await insertVersion(repaired, { source: 'confluence', version: 8, html: null, text: 'unrelated' });
      const before = await pageRow(exempt);
      await run();
      expect(await pageRow(exempt)).toEqual(before);
      expect((await pageRow(repaired)).body_text).toBe(pair.fixed);
    });

    it('D11: a copy with the already-correct text beside an affected copy does not block the page (not a witness)', async () => {
      const pageId = await insertPage({ html: pair.html, text: pair.text });
      const correct = await insertVersion(pageId, { version: 3, html: pair.html, text: pair.fixed });
      await run();
      expect((await pageRow(pageId)).body_text).toBe(pair.fixed);
      expect((await versionRow(correct))!.body_text).toBe(pair.fixed);
    });

    describe('history keyset on the uuid column', () => {
      const NIL = '00000000-0000-0000-0000-000000000000';

      it('an affected history row with the nil UUID is scanned and repaired', async () => {
        const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain' });
        await insertVersion(pageId, { id: NIL, version: 2, html: pair.html, text: pair.text });
        const summary = await run();
        expect(counts(summary)).toMatchObject({ repaired: 1 });
        expect((await versionRow(NIL))!.body_text).toBe(pair.fixed);
      });

      it('a text-only witness with the nil UUID is found: paired_exempt, nothing written', async () => {
        const pageId = await insertPage({ html: pair.html, text: pair.text });
        await insertVersion(pageId, { id: NIL, source: 'confluence', version: 8, html: null, text: pair.text });
        const before = { page: await pageRow(pageId), versions: await versionRows(pageId) };
        const summary = await run();
        expect(counts(summary)).toMatchObject({ paired_exempt: 1 });
        expect({ page: await pageRow(pageId), versions: await versionRows(pageId) }).toEqual(before);
      });

      it('a witness in a later read window (window scaled to 2 rows, ids across the first hex digit) is found', async () => {
        // Text order and uuid order agree under this database's collation; the
        // query compares and orders `pv.id` as uuid, so a collation where
        // they differ cannot move a witness out of the windows either.
        const pageId = await insertPage({ html: pair.html, text: pair.text });
        const decoys = ['02000000-0000-4000-8000-000000000000', '0a000000-0000-4000-8000-000000000000',
          '0f000000-0000-4000-8000-000000000000'];
        for (const [index, id] of decoys.entries()) {
          await insertVersion(pageId, { id, source: 'confluence', version: 10 + index, html: null, text: 'Use <xx> here' });
        }
        await insertVersion(pageId, { id: '100aaaaa-0000-4000-8000-000000000000', source: 'confluence', version: 20, html: null, text: pair.text });
        const windows: number[] = [];
        const summary = await run({
          limits: { scanRows: 2 },
          hooks: { onStatement: (info) => { if (info.kind === 'witness_versions') windows.push(info.bytes); } },
        });
        expect(counts(summary)).toMatchObject({ paired_exempt: 1 });
        expect(windows.length).toBeGreaterThanOrEqual(2);
        expect((await pageRow(pageId)).body_text).toBe(pair.text);
      });

      it('collation-sensitive: under a numeric ICU text order a text-ordered walk skips the witness at 02000000-…; the job walks uuid order, finds it and writes nothing', async () => {
        // A discriminating text order, as a database default collation could
        // impose on the `id::text` alias: digits compare as numbers.
        await query(`CREATE COLLATION IF NOT EXISTS zz_bt_numeric (provider = icu, locale = 'en-u-kn-true')`);
        try {
          const pageId = await insertPage({ html: pair.html, text: pair.text });
          const witness = '02000000-0000-4000-8000-000000000000';
          const decoys = ['0a000000-0000-4000-8000-000000000000', '0f000000-0000-4000-8000-000000000000',
            '100aaaaa-0000-4000-8000-000000000000'];
          for (const [index, id] of decoys.entries()) {
            await insertVersion(pageId, { id, source: 'confluence', version: 10 + index, html: null, text: 'Use <xx> here' });
          }
          await insertVersion(pageId, { id: witness, source: 'confluence', version: 20, html: null, text: pair.text });
          // The fixture discriminates: the same two-row keyset walk (uuid comparison) visits
          // the witness in uuid order and skips it in numeric text order.
          const walk = async (order: string) => {
            const seen: string[] = [];
            let after: string | null = null;
            for (;;) {
              const rows: { id: string }[] = (await query<{ id: string }>(
                `SELECT pv.id::text AS id FROM page_versions pv
                  WHERE pv.page_id = $1 AND ($2::uuid IS NULL OR pv.id > $2::uuid) ORDER BY ${order} LIMIT 2`,
                [pageId, after],
              )).rows;
              seen.push(...rows.map((row) => row.id));
              if (rows.length < 2) return seen;
              after = rows[rows.length - 1]!.id;
            }
          };
          expect(await walk('pv.id')).toContain(witness);
          expect(await walk('pv.id::text COLLATE zz_bt_numeric')).not.toContain(witness);
          const before = { page: await pageRow(pageId), versions: await versionRows(pageId) };
          const summary = await run({ limits: { scanRows: 2 } });
          expect(counts(summary)).toMatchObject({ paired_exempt: 1 });
          expect({ page: await pageRow(pageId), versions: await versionRows(pageId) }).toEqual(before);
        } finally {
          await query('DROP COLLATION IF EXISTS zz_bt_numeric');
        }
      });
    });
  });

  // ─── 4. Pending intent ────────────────────────────────────────────────────

  describe('4. pending intent', () => {
    it('a pending Confluence version restore makes the owner busy, later owners are served; after it settles the owner is handled', async () => {
      const busyPage = await insertPage({ source: 'confluence', remoteVersion: 7 });
      const later = await insertPage();
      const intentId = await pendingIntent(busyPage, 'page.version_restore');
      const first = await run();
      expect(first.outcome).toBe('retry');
      expect(counts(first)).toMatchObject({ busy: 1, repaired: 1 });
      expect((await pageRow(later)).body_text).toBe(preFix().fixed);
      expect((await pageRow(busyPage)).body_text).toBe(preFix().text);
      expect((await state()).unresolved.ids).toEqual([busyPage]);
      await settleIntent(intentId);
      const second = await run();
      expect(second.outcome).toBe('done');
      expect((await pageRow(busyPage)).body_text).toBe(preFix().fixed);
    });
  });

  // ─── 7. Page-update combinations and D9 ──────────────────────────────────

  describe('7. page-update combinations and D9', () => {
    /** Old text: 90,000 tags (no lexemes). Corrected: 90,000 words, beyond the 1 MB tsvector limit. */
    function unindexablePair(): { html: string; text: string } {
      const terms = Array.from({ length: 90_000 }, (_, i) => `w${i.toString(36)}xxxxxxxx`);
      return {
        html: `<p>${terms.map((term) => `&amp;lt;${term}&amp;gt;`).join(' ')}</p>`,
        text: terms.map((term) => `<${term}>`).join(' '),
      };
    }

    it('D9: the seeded 90,000-term published value beside an affected draft and history → nothing of the page written, unindexable; pass reaches done; a later good owner is repaired', async () => {
      const huge = unindexablePair();
      const draft = preFix('em', 'Draft');
      const history = preFix('code', 'Old');
      const bigId = await insertPage({ html: huge.html, text: huge.text, draftHtml: draft.html, draftText: draft.text });
      const versionId = await insertVersion(bigId, { version: 1, html: history.html, text: history.text });
      const good = preFix();
      const goodId = await insertPage({ html: good.html, text: good.text });
      const before = await pageRow(bigId);
      const versionBefore = await versionRow(versionId);
      const summary = await run();
      expect(summary.outcome).toBe('done');
      expect(await pageRow(bigId)).toEqual(before);
      expect(await versionRow(versionId)).toEqual(versionBefore);
      expect((await pageRow(goodId)).body_text).toBe(good.fixed);
      expect(counts(summary).unindexable).toBe(3);
      expect((await state()).status).toBe('done');
    });

    it('D9: another 54000 error during the page update is not treated as unindexable — the run ends and nothing is written', async () => {
      const pair = preFix();
      const pageId = await insertPage({ html: pair.html, text: pair.text });
      const before = await pageRow(pageId);
      await query(`CREATE OR REPLACE FUNCTION zz_backfill_test_54000() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION USING ERRCODE = '54000', MESSAGE = 'other program limit'; END $$ LANGUAGE plpgsql`);
      await query(`CREATE TRIGGER zz_backfill_test_54000 BEFORE UPDATE OF body_text ON pages
        FOR EACH ROW EXECUTE FUNCTION zz_backfill_test_54000()`);
      try {
        await expect(run()).rejects.toMatchObject({ code: 'sql_54000' });
      } finally {
        await query('DROP TRIGGER zz_backfill_test_54000 ON pages');
        await query('DROP FUNCTION zz_backfill_test_54000()');
      }
      expect(await pageRow(pageId)).toEqual(before);
      expect((await state()).status).toBe('idle');
    });
  });

  // ─── 8. Ownership ─────────────────────────────────────────────────────────

  describe('8. ownership', () => {
    it('AC2: simultaneous first starts on an empty key → one claims, the other is already_running', async () => {
      await insertPage();
      const other = await replica();
      try {
        const claimPaused = pause<[string, number | null, PoolClient]>();
        const first = run({ hooks: { beforeCommit: async (step) => { if (step === 'claim') await claimPaused.hook(); } } });
        await claimPaused.reached;
        const second = other.run();
        await expectBlockedBackend('%admin_settings%');
        claimPaused.release();
        expect((await second).outcome).toBe('already_running');
        expect((await first).outcome).toBe('done');
      } finally {
        await other.close();
      }
    });

    it('AC2: a second start while one runs is already_running; a delayed claimant after done is already_completed', async () => {
      await insertPage();
      const other = await replica();
      try {
        const scanPaused = pause<[number, { affected: number }]>();
        const first = run({ hooks: { afterScan: scanPaused.hook } });
        await scanPaused.reached;
        expect((await other.run()).outcome).toBe('already_running');
        scanPaused.release();
        expect((await first).outcome).toBe('done');
        expect((await other.run()).outcome).toBe('already_completed');
      } finally {
        await other.close();
      }
    });

    it("a stale owner's late transaction after a takeover writes nothing (ownership_lost) and the page is repaired once", async () => {
      const pageId = await insertPage();
      const before = await pageRow(pageId);
      const other = await replica();
      try {
        const scanPaused = pause<[number, { affected: number }]>();
        const stale = run({ hooks: { afterScan: scanPaused.hook } });
        await scanPaused.reached;
        await query(`UPDATE admin_settings SET updated_at = NOW() - interval '20 minutes' WHERE setting_key = $1`,
          [BODY_TEXT_BACKFILL_STATE_KEY]);
        expect((await other.run()).outcome).toBe('done');
        scanPaused.release();
        await expect(stale).rejects.toMatchObject({ code: 'ownership_lost' });
        const after = await pageRow(pageId);
        expect(Number(after.content_revision)).toBe(Number(before.content_revision) + 1);
        expect((await state()).status).toBe('done');
      } finally {
        await other.close();
      }
    });

    it('AC2: crash after COMMIT — a takeover of the dead runner resumes from the cursor, never redoing the committed owner', async () => {
      const first = await insertPage();
      const second = await insertPage();
      await run({ hooks: { atOpen: (ownerId) => { if (ownerId === second) void stopBodyTextBackfill(); } } });
      armBodyTextBackfill();
      // The process died before its release: the row still names it, aged past the lease.
      const crashed = await state();
      expect(crashed.cursor).toBe(first);
      await patchState({ status: 'running', owner: randomUUID() }, '20 minutes');
      const firstBefore = await pageRow(first);
      const resumed = await run();
      expect(resumed.outcome).toBe('done');
      expect(resumed.pass).toBe(crashed.pass);
      expect(await pageRow(first)).toEqual(firstBefore);
      expect((await pageRow(second)).body_text).toBe(preFix().fixed);
    });

    it('uncertain commit of a write: a lost COMMIT acknowledgment is settled by the reconciliation read as committed, never also recorded busy', async () => {
      const pageId = await insertPage();
      let summary!: BodyTextBackfillSummary;
      const proxy = await withLostCommitAcknowledgment(async (arm) => {
        summary = await run({ hooks: { beforeCommit: (step) => { if (step === 'close') arm(); } } });
      });
      expect(proxy.dropped()).toBe(true);
      expect(summary.outcome).toBe('done');
      expect((await pageRow(pageId)).body_text).toBe(preFix().fixed);
      const doc = await state();
      expect(doc.passTotals.busy ?? 0).toBe(0);
      expect(doc.passTotals.repaired).toBe(1);
      expect(doc.unresolved.ids).toEqual([]);
    });

    it('uncertain commit of the terminal release: settled as committed by owner = null, lastOwner = this run and the advanced seq', async () => {
      await insertPage();
      let summary!: BodyTextBackfillSummary;
      const proxy = await withLostCommitAcknowledgment(async (arm) => {
        summary = await run({ hooks: { beforeCommit: (step) => { if (step === 'release') arm(); } } });
      });
      expect(proxy.dropped()).toBe(true);
      expect(summary.outcome).toBe('done');
      const doc = await state();
      expect(doc).toMatchObject({ status: 'done', owner: null, lastOwner: summary.runId });
    });

    it('a step found not committed (session ended before COMMIT) is recorded busy and redone later', async () => {
      const pageId = await insertPage();
      const summary = await run({
        hooks: {
          beforeCommit: async (step, _owner, client) => {
            if (step !== 'close') return;
            const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
            await query('SELECT pg_terminate_backend($1)', [pid]);
          },
        },
      });
      expect(summary.outcome).toBe('retry');
      expect(counts(summary)).toMatchObject({ busy: 1 });
      expect((await pageRow(pageId)).body_text).toBe(preFix().text);
      expect((await run()).outcome).toBe('done');
      expect((await pageRow(pageId)).body_text).toBe(preFix().fixed);
    });

    it('a reconciliation read that times out stops the run (fail closed)', async () => {
      await insertPage();
      const holder = await withHeldClient();
      try {
        let locking: Promise<unknown> | null = null;
        const summary = withLostCommitAcknowledgment(async (arm) => {
          await expect(run({
            limits: { lockTimeoutMs: 300 },
            hooks: {
              beforeCommit: async (step) => {
                if (step !== 'close') return;
                locking = holder.client.query('SELECT 1 FROM admin_settings WHERE setting_key = $1 FOR UPDATE', [BODY_TEXT_BACKFILL_STATE_KEY]);
                await expectBlockedBackend('SELECT 1 FROM admin_settings WHERE setting_key = $1 FOR UPDATE');
                arm();
              },
            },
          })).rejects.toMatchObject({ code: 'reconciliation_failed' });
        });
        await summary;
        await locking;
      } finally {
        await holder.done();
      }
    });

    it('a stalled state write ends the run interrupted (state_timeout); nothing is advanced', async () => {
      const first = await insertPage();
      await insertPage();
      const holder = await withHeldClient();
      try {
        await expect(run({
          limits: { lockTimeoutMs: 300 },
          hooks: {
            afterScan: async (ownerId) => {
              if (ownerId !== first) return;
              await holder.client.query('SELECT 1 FROM admin_settings WHERE setting_key = $1 FOR UPDATE', [BODY_TEXT_BACKFILL_STATE_KEY]);
            },
          },
        })).rejects.toMatchObject({ code: 'state_timeout' });
      } finally {
        await holder.done();
      }
      const doc = await state();
      expect(doc.cursor).toBe(0);
      expect(doc.passTotals).toEqual({});
      expect((await pageRow(first)).body_text).toBe(preFix().text);
    });

    it('takeover of a dead runner resumes; malformed state is never overwritten and reports no counts (state_invalid)', async () => {
      await insertPage();
      await run({ hooks: { atOpen: () => { void stopBodyTextBackfill(); } } });
      armBodyTextBackfill();
      await patchState({ status: 'running', owner: randomUUID() }, '16 minutes');
      expect((await run()).outcome).toBe('done');
      await query(`UPDATE admin_settings SET setting_value = '{"v":2}' WHERE setting_key = $1`, [BODY_TEXT_BACKFILL_STATE_KEY]);
      await expect(run({ restart: true })).rejects.toMatchObject({ code: 'state_invalid' });
      expect((await query('SELECT setting_value FROM admin_settings WHERE setting_key = $1', [BODY_TEXT_BACKFILL_STATE_KEY])).rows[0])
        .toEqual({ setting_value: '{"v":2}' });
    });

    it('a held first-claim lock during stop: the stop returns once the claim deadline expires; nothing is claimed', async () => {
      await insertPage();
      await run();
      const holder = await withHeldClient();
      try {
        await holder.client.query('SELECT 1 FROM admin_settings WHERE setting_key = $1 FOR UPDATE', [BODY_TEXT_BACKFILL_STATE_KEY]);
        const running = run({ restart: true, limits: { lockTimeoutMs: 500 } });
        await expectBlockedBackend('%admin_settings%');
        await stopBodyTextBackfill();
        expect((await running).outcome).toBe('interrupted');
      } finally {
        await holder.done();
      }
      expect((await state()).owner).toBeNull();
    });

    it('local quiesce before checkout: runtime_quiescing ends the run interrupted, state and page untouched', async () => {
      const pageId = await insertPage();
      const other = await replica();
      try {
        await other.quiesce!();
        const before = await pageRow(pageId);
        await expect(other.run()).rejects.toMatchObject({ code: 'runtime_quiescing' });
        expect(await pageRow(pageId)).toEqual(before);
        const doc = await state();
        expect(doc).toMatchObject({ cursor: 0, passTotals: {}, owner: null, status: 'idle' });
      } finally {
        await other.close();
      }
    });

    it('a first claim behind an uncommitted insert of the state key waits at most its lock deadline; a stop during the wait returns within it; nothing is claimed and a later run claims', async () => {
      const pageId = await insertPage();
      const holder = await withHeldClient();
      try {
        await holder.client.query(
          `INSERT INTO admin_settings (setting_key, setting_value, updated_at) VALUES ($1, '{}', NOW())`,
          [BODY_TEXT_BACKFILL_STATE_KEY],
        );
        const unstopped = await run({ limits: { lockTimeoutMs: 300 } });
        expect(unstopped).toMatchObject({ outcome: 'interrupted', interruptCode: 'state_timeout' });
        const started = performance.now();
        const running = run({ limits: { lockTimeoutMs: 1_500 } });
        await expectBlockedBackend('%admin_settings%');
        await stopBodyTextBackfill();
        expect(performance.now() - started).toBeLessThan(10_000);
        expect((await running).outcome).toBe('interrupted');
      } finally {
        await holder.done();
      }
      expect((await query('SELECT 1 FROM admin_settings WHERE setting_key = $1', [BODY_TEXT_BACKFILL_STATE_KEY])).rows).toEqual([]);
      armBodyTextBackfill();
      expect((await run()).outcome).toBe('done');
      expect((await pageRow(pageId)).body_text).toBe(preFix().fixed);
    });

    it('uncertain commit of the claim: a lost COMMIT acknowledgment is settled as claimed and the run completes', async () => {
      const pageId = await insertPage();
      let summary!: BodyTextBackfillSummary;
      const proxy = await withLostCommitAcknowledgment(async (arm) => {
        summary = await run({ hooks: { beforeCommit: (step) => { if (step === 'claim') arm(); } } });
      });
      expect(proxy.dropped()).toBe(true);
      expect(summary.outcome).toBe('done');
      expect((await pageRow(pageId)).body_text).toBe(preFix().fixed);
      expect(await state()).toMatchObject({ status: 'done', owner: null, lastOwner: summary.runId });
    });

    it('a claim found not committed (session ended before COMMIT) is never reported as another runner: interrupted, nothing claimed, the next run claims', async () => {
      const pageId = await insertPage();
      await run();
      const before = await state();
      const terminateOn = (wanted: string) => async (step: string, _owner: number | null, client: PoolClient) => {
        if (step !== wanted) return;
        const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        await query('SELECT pg_terminate_backend($1)', [pid]);
      };
      const refused = await run({ restart: true, hooks: { beforeCommit: terminateOn('claim') } });
      expect(refused).toMatchObject({ outcome: 'interrupted', interruptCode: 'claim_transaction_refused' });
      expect(await state()).toEqual(before);
      await query('UPDATE pages SET body_text = $2 WHERE id = $1', [pageId, preFix().text]);
      const next = await run({ restart: true });
      expect(next.outcome).toBe('done');
      expect((await pageRow(pageId)).body_text).toBe(preFix().fixed);
    });

    it('true rollback of a first claim (session ended before COMMIT): interrupted claim_transaction_refused; the committed `new` row is unchanged and owned by nobody; the next run claims and completes', async () => {
      await insertPage();
      const refused = await run({
        hooks: {
          beforeCommit: async (step, _owner, client) => {
            if (step !== 'claim') return;
            const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
            await query('SELECT pg_terminate_backend($1)', [pid]);
          },
        },
      });
      expect(refused).toMatchObject({ outcome: 'interrupted', interruptCode: 'claim_transaction_refused' });
      expect(await state()).toMatchObject({ status: 'new', owner: null, seq: 0, pass: 0 });
      expect((await run()).outcome).toBe('done');
    });

    describe('a connection lost while PostgreSQL is still inside COMMIT (a deferred trigger holds the COMMIT)', () => {
      const HOLD_KEY = 19_651_965;

      /**
       * Holds the COMMIT of the next state-row INSERT or UPDATE inside the
       * server: a deferred constraint trigger waits on an advisory lock this
       * test holds. Every pg client that runs a query is recorded so the one
       * whose backend sits in that COMMIT can have its socket closed.
       */
      async function withHeldCommit(event: 'INSERT' | 'UPDATE', body: (hold: {
        dropClientInCommit: () => Promise<void>;
        release: () => Promise<void>;
      }) => Promise<void>): Promise<void> {
        const clients = new Set<pg.Client>();
        const original = pg.Client.prototype.query;
        vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
          clients.add(this);
          return (original as (...a: unknown[]) => unknown).apply(this, args);
        } as never);
        const holder = new pg.Client({ connectionString: process.env.POSTGRES_URL });
        await holder.connect();
        await holder.query('SELECT pg_advisory_lock($1)', [HOLD_KEY]);
        await query(`CREATE OR REPLACE FUNCTION zz_bt_hold_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(${HOLD_KEY}); RETURN NULL; END $$`);
        await query(`CREATE CONSTRAINT TRIGGER zz_bt_hold_commit AFTER ${event} ON admin_settings
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.setting_key = '${BODY_TEXT_BACKFILL_STATE_KEY}')
          EXECUTE FUNCTION zz_bt_hold_commit()`);
        let released = false;
        const release = async () => {
          if (released) return;
          released = true;
          await holder.query('SELECT pg_advisory_unlock($1)', [HOLD_KEY]);
        };
        try {
          await body({
            dropClientInCommit: async () => {
              let pid = 0;
              await expect.poll(async () => {
                pid = (await query<{ pid: number }>(
                  `SELECT pid FROM pg_stat_activity
                    WHERE datname = current_database() AND query = 'COMMIT' AND wait_event_type = 'Lock'`,
                )).rows[0]?.pid ?? 0;
                return pid;
              }, { timeout: 15_000, interval: 20 }).toBeGreaterThan(0);
              const victim = [...clients].find((client) => (client as unknown as { processID: number }).processID === pid)!;
              (victim as unknown as { connection: { stream: Socket } }).connection.stream.destroy();
            },
            release,
          });
        } finally {
          await release();
          await holder.end();
          await query('DROP TRIGGER IF EXISTS zz_bt_hold_commit ON admin_settings');
          await query('DROP FUNCTION IF EXISTS zz_bt_hold_commit()');
        }
      }

      it('the first-ever claim: reconciliation locks the committed row, waits for the COMMIT in flight and settles it claimed; the run completes and the next invocation is already_completed', async () => {
        const pageId = await insertPage();
        await withHeldCommit('UPDATE', async (hold) => {
          // Generous deadlines: the held COMMIT and the reconciliation read must outlast the test's own steps.
          const running = run({ limits: { lockTimeoutMs: 30_000, statementTimeoutMs: 30_000, transactionTimeoutMs: 60_000 } });
          await hold.dropClientInCommit();
          // The reconciliation read is blocked behind the COMMIT still in flight.
          await expectBlockedBackend('%FROM admin_settings WHERE setting_key = $1 FOR UPDATE%');
          await hold.release();
          const summary = await running;
          expect(summary.outcome).toBe('done');
          expect(await state()).toMatchObject({ status: 'done', owner: null, lastOwner: summary.runId });
        });
        expect((await pageRow(pageId)).body_text).toBe(preFix().fixed);
        expect((await run()).outcome).toBe('already_completed');
      });

      it('the bootstrap insert: its repeat waits for the COMMIT in flight, finds the row, and the claim and the pass proceed', async () => {
        const pageId = await insertPage();
        await withHeldCommit('INSERT', async (hold) => {
          const running = run({ limits: { lockTimeoutMs: 30_000, statementTimeoutMs: 30_000, transactionTimeoutMs: 60_000 } });
          await hold.dropClientInCommit();
          await expectBlockedBackend('%INSERT INTO admin_settings%');
          await hold.release();
          expect((await running).outcome).toBe('done');
        });
        expect((await pageRow(pageId)).body_text).toBe(preFix().fixed);
        expect(await state()).toMatchObject({ status: 'done', owner: null, pass: 1 });
      });
    });

    it('a terminal release found not committed is retried within the run: done, owner = null, lastOwner = this run', async () => {
      await insertPage();
      let terminated = 0;
      const summary = await run({
        hooks: {
          beforeCommit: async (step, _owner, client) => {
            if (step !== 'release' || terminated > 0) return;
            terminated += 1;
            const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
            await query('SELECT pg_terminate_backend($1)', [pid]);
          },
        },
      });
      expect(terminated).toBe(1);
      expect(summary.outcome).toBe('done');
      expect(await state()).toMatchObject({ status: 'done', owner: null, lastOwner: summary.runId });
    });

    it('a stop during the close of an unaffected owner (after its scan) ends the run interrupted with nothing recorded', async () => {
      await insertPage({ html: '<p>plain</p>', text: 'plain' });
      const summary = await run({ hooks: { afterScan: () => { void stopBodyTextBackfill(); } } });
      expect(summary.outcome).toBe('interrupted');
      expect(counts(summary)).toEqual({});
      expect(await state()).toMatchObject({ cursor: 0, passTotals: {}, owner: null });
    });

    it('an unaffected page held FOR UPDATE by another session is busy within the lock deadline; a later affected page is repaired in the same run', async () => {
      const held = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      const affected = await insertPage();
      const holder = await withHeldClient();
      let summary!: BodyTextBackfillSummary;
      try {
        await holder.client.query('SELECT 1 FROM pages WHERE id = $1 FOR UPDATE', [held]);
        summary = await run({ limits: { lockTimeoutMs: 300 } });
      } finally {
        await holder.done();
      }
      expect(counts(summary)).toMatchObject({ repaired: 1 });
      expect(counts(summary).busy).toBeGreaterThanOrEqual(1);
      expect((await pageRow(affected)).body_text).toBe(preFix().fixed);
      expect((await state()).unresolved.ids).toContain(held);
    });

    it('an explicit restart before a stored future re-check carries it: kept when the restart is interrupted, and the earlier time wins at completion', async () => {
      await insertPage();
      await run();
      const stored = (await state()).nextFullPassAfter!;
      expect(Date.parse(stored)).toBeGreaterThan(await dbNow());
      const interrupted = await run({ restart: true, hooks: { atOpen: () => { void stopBodyTextBackfill(); } } });
      expect(interrupted.outcome).toBe('interrupted');
      expect((await state()).nextFullPassAfter).toBe(stored);
      armBodyTextBackfill();
      expect((await run()).outcome).toBe('done');
      expect((await state()).nextFullPassAfter).toBe(stored);
    });

    it('state invariants: an unreachable combination is state_invalid on the fast path and before a forced restart, the row byte-identical; the shapes the job writes are accepted under their list bound', async () => {
      const pageIds = [await insertPage(), await insertPage(), await insertPage()];
      const [pageId] = pageIds as [number];
      await run();
      const valid = await state();
      const list = (ids: number[]) => ({ ids, overflow: false, count: ids.length, sample: ids.slice(0, 20) });
      const empty = list([]);
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const write = (doc: unknown, ago = '0 seconds') => query(
        `UPDATE admin_settings SET setting_value = $2, updated_at = NOW() - $3::interval WHERE setting_key = $1`,
        [BODY_TEXT_BACKFILL_STATE_KEY, JSON.stringify(doc), ago],
      );
      const raw = async () => (await query<{ setting_value: string }>(
        'SELECT setting_value FROM admin_settings WHERE setting_key = $1', [BODY_TEXT_BACKFILL_STATE_KEY],
      )).rows[0]!.setting_value;
      const overflow = (count: number, sample: number[]) => ({ ids: [], overflow: true, count, sample });
      // A too-large owner is always counted in the pass and lifetime counters too.
      const tooLargeOne = {
        tooLarge: 1,
        passTotals: { ...valid.passTotals, page_too_large: 1 },
        totals: { ...valid.totals, page_too_large: (valid.totals.page_too_large ?? 0) + 1 },
      };
      const invalid: Partial<BodyTextBackfillState>[] = [
        { status: 'running', owner: null },
        { status: 'idle', owner: randomUUID() },
        { status: 'idle', cursor: valid.highWater + 1 },
        { phase: 'retry' },
        { status: 'waiting', unresolved: empty, tooLarge: 0 },
        // The release writes idle/retry for an exact list, never `waiting`.
        { status: 'waiting', unresolved: list([pageId]), ...tooLargeOne, nextFullPassAfter: future },
        { status: 'idle', cursor: pageId, unresolved: { ids: [pageId, pageId], overflow: false, count: 2, sample: [pageId, pageId] } },
        { status: 'idle', cursor: pageId, unresolved: { ids: [pageId], overflow: false, count: 2, sample: [pageId] } },
        { status: 'idle', cursor: pageId, unresolved: { ids: [pageId], overflow: false, count: 1, sample: [] } },
        { status: 'idle', unresolved: list([valid.highWater + 1]) },
        // A scan lists only owners the cursor has passed.
        { status: 'idle', cursor: 0, unresolved: list([pageId]) },
        { status: 'idle', unresolved: overflow(0, []) },
        { status: 'waiting', unresolved: overflow(1, [valid.highWater + 1]), nextFullPassAfter: future },
        { status: 'waiting', unresolved: overflow(3, pageIds), nextFullPassAfter: future },
        { status: 'idle', phase: 'retry', unresolved: overflow(201, pageIds) },
        { pass: 0 },
        { seq: 0 },
        { status: 'done', ...tooLargeOne },
        // Counters and stamps move together.
        { tooLarge: 1, status: 'waiting', nextFullPassAfter: future },
        { passTotals: { ...valid.passTotals, repaired: (valid.totals.repaired ?? 0) + 1 } },
        { firstCompletedAt: null },
        { firstCompletedAt: new Date(Date.parse(valid.completedAt!) + 1000).toISOString() },
      ];
      const expectRejected = async (patch: Partial<BodyTextBackfillState>, limits: Partial<BodyTextBackfillLimits> = {}) => {
        await write({ ...valid, ...patch });
        const stored = await raw();
        await expect(run({ limits }), `fast path ${JSON.stringify(patch)}`).rejects.toMatchObject({ code: 'state_invalid' });
        expect(await raw()).toBe(stored);
        await expect(run({ restart: true, limits }), `restart ${JSON.stringify(patch)}`).rejects.toMatchObject({ code: 'state_invalid' });
        expect(await raw()).toBe(stored);
      };
      for (const patch of invalid) await expectRejected(patch);
      // Overflow samples under list bound 2 (count 3, three ids): only the
      // order, or only the last id's horizon, differs from the accepted control.
      const scaled = { transientListMax: 2 };
      const [first, second, third] = pageIds as [number, number, number];
      const waitingOverflow = (sample: number[]) => ({
        status: 'waiting' as const, unresolved: overflow(3, sample), nextFullPassAfter: future,
      });
      await expectRejected(waitingOverflow([first, third, second]), scaled);
      await expectRejected(waitingOverflow([first, second, valid.highWater + 1]), scaled);
      const accepted: [Partial<BodyTextBackfillState>, string, Partial<BodyTextBackfillLimits>][] = [
        [waitingOverflow([first, second, third]), '0 seconds', scaled],
        [{ status: 'idle', phase: 'scan', cursor: pageId, unresolved: list([pageId]) }, '0 seconds', {}],
        [{ status: 'idle', phase: 'retry', unresolved: list([pageId]), ...tooLargeOne }, '0 seconds', {}],
        [{ status: 'waiting', ...tooLargeOne, nextFullPassAfter: future }, '0 seconds', {}],
        [{ status: 'running', owner: randomUUID(), phase: 'scan' }, '16 minutes', {}],
      ];
      for (const [patch, ago, limits] of accepted) {
        await write({ ...valid, ...patch }, ago);
        await expect(run({ limits }), JSON.stringify(patch)).resolves.toMatchObject({ runId: expect.any(String) });
      }
    });

    it('status new is accepted only in its canonical pre-claim shape: each independent bad field is state_invalid on the fast read and on a forced restart, the row byte-identical; the canonical row bootstraps and completes with the first +24 h re-check', async () => {
      await insertPage();
      // The canonical row as the bootstrap writes it: a refused first claim leaves it.
      await run({
        hooks: {
          beforeCommit: async (step, _owner, client) => {
            if (step !== 'claim') return;
            const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
            await query('SELECT pg_terminate_backend($1)', [pid]);
          },
        },
      });
      const canonical = await state();
      expect(canonical).toMatchObject({ status: 'new', seq: 0, pass: 0 });
      const stamp = '2001-01-01T00:00:00.000Z';
      const bad: Partial<BodyTextBackfillState>[] = [
        { seq: 1 },
        { pass: 1, seq: 1 },
        { lastOwner: randomUUID() },
        { passStartedAt: stamp },
        { highWater: 5 },
        { phase: 'retry' },
        { highWater: 5, cursor: 1 },
        { unresolved: { ids: [], overflow: false, count: 0, sample: [1] } },
        { highWater: 5, unresolved: { ids: [1], overflow: false, count: 1, sample: [1] } },
        { tooLarge: 1, passTotals: { page_too_large: 1 }, totals: { page_too_large: 1 } },
        { nextFullPassAfter: stamp },
        { overflowBackoffMs: 3_600_000 },
        { firstCompletedAt: stamp, completedAt: stamp },
        { passTotals: { repaired: 1 }, totals: { repaired: 1 } },
        { totals: { repaired: 1 } },
      ];
      const raw = async () => (await query<{ setting_value: string }>(
        'SELECT setting_value FROM admin_settings WHERE setting_key = $1', [BODY_TEXT_BACKFILL_STATE_KEY],
      )).rows[0]!.setting_value;
      for (const patch of bad) {
        await query(`UPDATE admin_settings SET setting_value = $2 WHERE setting_key = $1`,
          [BODY_TEXT_BACKFILL_STATE_KEY, JSON.stringify({ ...canonical, ...patch })]);
        const stored = await raw();
        await expect(run(), `fast path ${JSON.stringify(patch)}`).rejects.toMatchObject({ code: 'state_invalid' });
        expect(await raw()).toBe(stored);
        await expect(run({ restart: true }), `restart ${JSON.stringify(patch)}`).rejects.toMatchObject({ code: 'state_invalid' });
        expect(await raw()).toBe(stored);
      }
      // Control: the canonical row is claimed and the first completion schedules the +24 h re-check.
      await query(`UPDATE admin_settings SET setting_value = $2 WHERE setting_key = $1`,
        [BODY_TEXT_BACKFILL_STATE_KEY, JSON.stringify(canonical)]);
      expect((await run()).outcome).toBe('done');
      const doc = await state();
      expect(Date.parse(doc.nextFullPassAfter!) - Date.parse(doc.completedAt!)).toBe(24 * 3600_000);
      expect(doc.firstCompletedAt).toBe(doc.completedAt);
    });

    it('a stop latched while a takeover claim of a stale running/retry image (empty list) waits on the state row: interrupted, released idle without completing the pass; the next run completes it', async () => {
      const pageId = await insertPage();
      const intent = await pendingIntent(pageId);
      expect((await run()).outcome).toBe('retry');
      await settleIntent(intent);
      // The crash image between the last resolved retry owner and the release.
      await patchState({
        status: 'running', owner: randomUUID(), phase: 'retry', cursor: pageId,
        unresolved: { ids: [], overflow: false, count: 0, sample: [] },
      }, '16 minutes');
      const holder = await withHeldClient();
      let summary!: BodyTextBackfillSummary;
      let released = false;
      try {
        await holder.client.query('SELECT 1 FROM admin_settings WHERE setting_key = $1 FOR UPDATE', [BODY_TEXT_BACKFILL_STATE_KEY]);
        const running = run({ limits: { lockTimeoutMs: 30_000 } });
        await expectBlockedBackend('%FROM admin_settings WHERE setting_key = $1 FOR UPDATE%');
        // Latch the stop while the takeover claim waits, then let the claim through.
        const stopping = stopBodyTextBackfill();
        released = true;
        await holder.done();
        await stopping;
        summary = await running;
      } finally {
        if (!released) await holder.done();
      }
      expect(summary).toMatchObject({ outcome: 'interrupted', interruptCode: 'stopped' });
      expect(await state()).toMatchObject({
        status: 'idle', phase: 'retry', owner: null, lastOwner: summary.runId, completedAt: null, firstCompletedAt: null,
      });
      armBodyTextBackfill();
      expect((await run()).outcome).toBe('done');
      expect((await state()).firstCompletedAt).not.toBeNull();
    });

    it('every invocation writes exactly one terminal line; whole-page decisions are logged only after their transaction committed', async () => {
      const exempt = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      const member = await insertVersion(exempt, { version: 2, html: preFix().html, text: preFix().text });
      const witness = await insertVersion(exempt, { version: 3, html: '<p>other</p>', text: preFix().text });
      const info = vi.spyOn(logger, 'info');
      const warn = vi.spyOn(logger, 'warn');
      const terminal = () => info.mock.calls.filter((call) => call[1] === 'body_text backfill run finished').length;
      const decisions = () => warn.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .filter((fields) => fields.kind === 'decision');
      // The close of the exempt page is refused at COMMIT: no decision line.
      const refused = await run({
        hooks: {
          beforeCommit: async (step, ownerId, client) => {
            if (step !== 'close' || ownerId !== exempt) return;
            const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
            await query('SELECT pg_terminate_backend($1)', [pid]);
          },
        },
      });
      expect(counts(refused).busy).toBeGreaterThanOrEqual(1);
      expect(decisions()).toEqual([]);
      expect(terminal()).toBe(1);
      expect((await run()).outcome).toBe('done');
      expect(decisions()).toEqual([expect.objectContaining({
        pageId: exempt, reason: 'paired_exempt', rule: 'a', witness, member, copies: 1,
      })]);
      expect(terminal()).toBe(2);
      expect((await run()).outcome).toBe('already_completed');
      expect(terminal()).toBe(3);
    });
  });

  // ─── 5. The close under its locks ────────────────────────────────────────

  describe('5. the close under its locks', () => {
    const pair = preFix();

    it('§6: with the connection default set to REPEATABLE READ, a metadata insert and a fixed lazy fill committing after admission and before the page lock are found as witness; the close runs READ COMMITTED', async () => {
      const pageId = await insertPage({ html: pair.html, text: pair.text, source: 'confluence', remoteVersion: 7 });
      const database = (await query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
      await query(`ALTER DATABASE "${database}" SET default_transaction_isolation TO 'repeatable read'`);
      await closePool();
      let isolation = '';
      try {
        expect((await query<{ transaction_isolation: string }>('SHOW transaction_isolation')).rows[0]!.transaction_isolation)
          .toBe('repeatable read');
        const before = await pageRow(pageId);
        const summary = await run({
          hooks: {
            afterAdmission: async (_owner, client) => {
              isolation = (await client.query<{ transaction_isolation: string }>('SHOW transaction_isolation')).rows[0]!
                .transaction_isolation;
              const lazyHtml = '<p>Use &lt;br&gt; here</p>';
              await upsertVersionMetadata(pageId, 9, 'v9', { editedAt: null, author: null, message: null });
              await fillVersionBody(pageId, 9, lazyHtml, htmlToText(lazyHtml));
            },
          },
        });
        expect(isolation).toBe('read committed');
        expect(counts(summary).paired_exempt).toBe(1);
        expect(await pageRow(pageId)).toEqual(before);
        expect((await query('SELECT body_text FROM page_versions WHERE page_id = $1', [pageId])).rows)
          .toEqual([{ body_text: pair.text }]);
      } finally {
        await query(`ALTER DATABASE "${database}" RESET default_transaction_isolation`);
        await closePool();
      }
    });

    describe('a protected writer between Open and the close → nothing written, changed, resolved by a later tick', () => {
      async function expectChangedThenResolved(pageId: number, writer: () => Promise<void>): Promise<void> {
        const first = await run({ hooks: { afterScan: async (ownerId) => { if (ownerId === pageId) await writer(); } } });
        expect(counts(first)).toMatchObject({ changed: 1 });
        expect(counts(first).repaired ?? 0).toBe(0);
        expect((await state()).unresolved.ids).toEqual([pageId]);
        const later = await run();
        expect(later.outcome).toBe('done');
        expect((await state()).unresolved.ids).toEqual([]);
      }

      it('restore (real restoreVersion)', async () => {
        const actor = await insertUser();
        const pageId = await insertPage({ html: pair.html, text: pair.text, createdBy: actor });
        await insertVersion(pageId, { version: 3, html: '<p>version three</p>', text: 'version three' });
        await expectChangedThenResolved(pageId, async () => {
          await restoreVersion(pageId, 3, { source: 'local', actorId: actor });
        });
        // The restore stored the pre-fix live text as local:7; the later tick repaired it.
        const snapshot = (await query<{ body_text: string }>(
          `SELECT body_text FROM page_versions WHERE page_id = $1 AND source = 'local' AND version_number = 7`, [pageId],
        )).rows[0]!;
        expect(snapshot.body_text).toBe(pair.fixed);
      });

      it('freeze (real) and thaw (real) move lifecycle_revision', async () => {
        const admin = await freezingAdmin();
        const freezing = await insertPage({ html: pair.html, text: pair.text, createdBy: admin, visibility: 'private' });
        await expectChangedThenResolved(freezing, async () => { await realFreeze(freezing, admin); });
        await truncateAllTables();
        armBodyTextBackfill();
        const admin2 = await freezingAdmin();
        const thawing = await insertPage({ html: pair.html, text: pair.text, createdBy: admin2, visibility: 'private' });
        const frozen = await realFreeze(thawing, admin2);
        await expectChangedThenResolved(thawing, async () => { await realThaw(thawing, admin2, frozen); });
      });

      it('draft publish, sync overwrite and relocation compensation (their protected page updates)', async () => {
        const draft = await insertPage({ html: pair.html, text: pair.text, draftHtml: '<p>draft</p>', draftText: 'draft' });
        await expectChangedThenResolved(draft, async () => {
          await query(`UPDATE pages SET body_html = draft_body_html, body_text = draft_body_text, version = version + 1,
                         draft_body_html = NULL, draft_body_text = NULL WHERE id = $1`, [draft]);
        });
        await truncateAllTables();
        armBodyTextBackfill();
        const synced = await insertPage({ html: pair.html, text: pair.text, source: 'confluence', remoteVersion: 7 });
        await expectChangedThenResolved(synced, async () => {
          await query(`UPDATE pages SET body_html = '<p>upstream</p>', body_text = 'upstream',
                         version = GREATEST(version + 1, 9), remote_version = 9 WHERE id = $1`, [synced]);
        });
        await truncateAllTables();
        armBodyTextBackfill();
        const relocated = await insertPage({ html: pair.html, text: pair.text });
        await expectChangedThenResolved(relocated, async () => {
          await query(`UPDATE pages SET source = 'standalone', body_html = $2, body_text = $3 WHERE id = $1`,
            [relocated, '<p>original</p>', 'original']);
        });
      });

      it('a member of A edited (same-length html, same-length stored text) or deleted (retention) after the scan → changed', async () => {
        // Same-length edits: only the digests under the row lock can see them.
        const edits = [
          `UPDATE page_versions SET body_html = '<p>Use &amp;lt;br&amp;gt; hers</p>' WHERE id = $1`,
          `UPDATE page_versions SET body_text = 'Use <br> hare' WHERE id = $1`,
          'DELETE FROM page_versions WHERE id = $1',
        ];
        for (const edit of edits) {
          await truncateAllTables();
          armBodyTextBackfill();
          const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain' });
          const member = await insertVersion(pageId, { version: 2, html: pair.html, text: pair.text });
          await expectChangedThenResolved(pageId, async () => { await query(edit, [member]); });
        }
      });
    });

    it('a lazy fill of the same id (text-only `xxxx`, filled after the scan and before admission with `<p>&lt;br&gt;</p>` / `<br>`) is found as witness under the lock; page untouched', async () => {
      const pageId = await insertPage({ html: '<p>&amp;lt;br&amp;gt;</p>', text: '<br>', source: 'confluence', remoteVersion: 7 });
      const textOnly = await insertVersion(pageId, { source: 'confluence', version: 5, html: null, text: 'xxxx' });
      const before = await pageRow(pageId);
      const summary = await run({
        hooks: {
          beforeAdmission: async () => { await fillVersionBody(pageId, 5, '<p>&lt;br&gt;</p>', '<br>'); },
        },
      });
      expect(counts(summary).paired_exempt).toBe(1);
      expect(await pageRow(pageId)).toEqual(before);
      expect(await versionRow(textOnly)).toMatchObject({ body_html: '<p>&lt;br&gt;</p>', body_text: '<br>' });
    });

    it('a lazy fill of an all-NULL placeholder after the witness decision blocks on the row lock until commit, then proceeds; a metadata-only insert in that window blocks on the page row and proceeds after commit', async () => {
      const pageId = await insertPage({ html: pair.html, text: pair.text, source: 'confluence', remoteVersion: 7 });
      await upsertVersionMetadata(pageId, 6, 'v6', { editedAt: null, author: null, message: null });
      let fill: Promise<void> | null = null;
      let insert: Promise<void> | null = null;
      const summary = await run({
        hooks: {
          afterDecision: async () => {
            fill = fillVersionBody(pageId, 6, '<p>six</p>', 'six');
            await expectBlockedBackend('%UPDATE page_versions SET body_html%');
            insert = upsertVersionMetadata(pageId, 10, 'v10', { editedAt: null, author: null, message: null });
            await expectBlockedBackend('%INSERT INTO page_versions%');
            const rows = (await query<{ version_number: number; body_html: string | null }>(
              'SELECT version_number, body_html FROM page_versions WHERE page_id = $1 ORDER BY version_number', [pageId],
            )).rows;
            expect(rows).toEqual([{ version_number: 6, body_html: null }]);
          },
        },
      });
      await fill;
      await insert;
      expect(counts(summary).repaired).toBe(1);
      expect((await pageRow(pageId)).body_text).toBe(pair.fixed);
      expect((await query('SELECT version_number, body_text FROM page_versions WHERE page_id = $1 ORDER BY version_number', [pageId])).rows)
        .toEqual([{ version_number: 6, body_text: 'six' }, { version_number: 10, body_text: null }]);
    });

    it('no-write proof: A = {h `<br>`, published `<em>`}, linked witness `<br>`; retention deletes h before the close → changed; the next attempt repairs the published text', async () => {
      const actor = await insertUser();
      const em = preFix('em');
      const br = preFix('br');
      const pageId = await insertPage({ html: em.html, text: em.text });
      const h = await insertVersion(pageId, { version: 2, html: br.html, text: br.text });
      const w = await insertVersion(pageId, { version: 1, html: br.html, text: br.text });
      await insertBaseline(pageId, actor, w);
      const first = await run({
        hooks: { afterScan: async () => { await query('DELETE FROM page_versions WHERE id = $1', [h]); } },
      });
      expect(counts(first)).toMatchObject({ changed: 1 });
      expect((await pageRow(pageId)).body_text).toBe(em.text);
      const second = await run();
      expect(second.outcome).toBe('done');
      expect((await pageRow(pageId)).body_text).toBe(em.fixed);
      expect((await versionRow(w))!.body_text).toBe(br.text);
    });

    it('no-write proof, rule (b) variant: one half of an equal-text split deleted after the scan, a third repairable copy → changed, then repaired', async () => {
      const third = preFix('em', 'Third');
      const pageId = await insertPage({ html: '<p>&amp;lt;br&amp;gt;</p>', text: '<br>' });
      const half = await insertVersion(pageId, { version: 2, html: '<p>&amp;#60;br&amp;#62;</p>', text: '<br>' });
      const thirdId = await insertVersion(pageId, { version: 3, html: third.html, text: third.text });
      const first = await run({
        hooks: { afterScan: async () => { await query('DELETE FROM page_versions WHERE id = $1', [half]); } },
      });
      expect(counts(first)).toMatchObject({ changed: 1 });
      expect((await run()).outcome).toBe('done');
      expect((await pageRow(pageId)).body_text).toBe('&lt;br&gt;');
      expect((await versionRow(thirdId))!.body_text).toBe(third.fixed);
    });

    it('retention attempting to delete the locked h during the close blocks until commit', async () => {
      const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      const h = await insertVersion(pageId, { version: 2, html: pair.html, text: pair.text });
      let deleting: Promise<unknown> | null = null;
      const summary = await run({
        hooks: {
          afterMembersLocked: async () => {
            deleting = query('DELETE FROM page_versions WHERE id = $1', [h]);
            await expectBlockedBackend('DELETE FROM page_versions WHERE id = $1');
          },
        },
      });
      expect(counts(summary).repaired).toBe(1);
      await deleting;
      expect(await versionRow(h)).toBeUndefined();
    });

    for (const order of ['retention holds a row of A', 'retention holds a placeholder'] as const) {
      it(`${order} → the close rolls back at once: zero repair effects and zero success deltas at rollback; after the busy checkpoint the owner is listed, the cursor is past it and a later owner is served`, async () => {
        const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain' });
        const member = await insertVersion(pageId, { version: 2, html: pair.html, text: pair.text });
        const placeholder = await insertVersion(pageId, { source: 'confluence', version: 3, html: null, text: null });
        const later = await insertPage();
        const holder = await withHeldClient();
        try {
          await holder.client.query('SELECT 1 FROM page_versions WHERE id = $1 FOR UPDATE',
            [order === 'retention holds a row of A' ? member : placeholder]);
          const pageBefore = await pageRow(pageId);
          const memberBefore = await versionRow(member);
          let atRollback: { page: unknown; member: unknown; totals: unknown } | null = null;
          const summary = await run({
            hooks: {
              beforeCommit: async (step, ownerId) => {
                if (step !== 'checkpoint' || ownerId !== pageId) return;
                atRollback = { page: await pageRow(pageId), member: await versionRow(member), totals: (await state()).passTotals };
              },
            },
          });
          expect(atRollback).toEqual({ page: pageBefore, member: memberBefore, totals: {} });
          const doc = await state();
          expect(doc.unresolved.ids).toEqual([pageId]);
          expect(doc.passTotals).toMatchObject({ busy: 1, repaired: 1 });
          expect(summary.outcome).toBe('retry');
          expect((await pageRow(later)).body_text).toBe(preFix().fixed);
        } finally {
          await holder.done();
        }
      });
    }

    it('A empty: a protected write between Open and the fenced close → changed; none → closed with the page row held FOR SHARE', async () => {
      const quiet = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      const outsider = await withHeldClient();
      let refusal: string | undefined;
      try {
        const summary = await run({
          hooks: {
            beforeCommit: async (step, ownerId) => {
              if (step !== 'fenced_close' || ownerId !== quiet) return;
              refusal = await outsider.client.query('SELECT 1 FROM pages WHERE id = $1 FOR UPDATE NOWAIT', [quiet])
                .then(() => 'acquired', (error: { code?: string }) => error.code);
            },
          },
        });
        expect(summary.outcome).toBe('done');
        expect(refusal).toBe('55P03');
      } finally {
        await outsider.done();
      }
      await truncateAllTables();
      armBodyTextBackfill();
      const moving = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      const summary = await run({
        hooks: { afterScan: async () => { await query(`UPDATE pages SET title = 'Renamed' WHERE id = $1`, [moving]); } },
      });
      expect(counts(summary)).toMatchObject({ changed: 1 });
    });

    it('an interrupted owner is observed again from Open and ends correct', async () => {
      const pageId = await insertPage({ html: pair.html, text: pair.text });
      const interrupted = await run({ hooks: { afterScan: () => { void stopBodyTextBackfill(); } } });
      expect(interrupted).toMatchObject({ outcome: 'interrupted', interruptCode: 'stopped', counts: {} });
      expect((await pageRow(pageId)).body_text).toBe(pair.text);
      armBodyTextBackfill();
      const opened: number[] = [];
      const resumed = await run({ hooks: { atOpen: (ownerId) => { opened.push(ownerId); } } });
      expect(opened).toEqual([pageId]);
      expect(resumed.outcome).toBe('done');
      expect((await pageRow(pageId)).body_text).toBe(pair.fixed);
    });
  });

  // ─── 6. Bounds ────────────────────────────────────────────────────────────

  describe('6. bounds', () => {
    const MIB = 1024 * 1024;
    const KIB = 1024;
    /**
     * CI-scaled budgets: the same code paths as the production 32 MiB / 8 MiB /
     * 4 MiB bounds, with data a hundred to a thousand times smaller. Real-size
     * evidence: the measurements and the 1,024 MiB container run in the report.
     */
    const SCALED: Partial<BodyTextBackfillLimits> = {
      statementBytes: 64 * KIB, largeColumnBytes: 16 * KIB, windowBytes: 32 * KIB, ceilingBytes: 128 * KIB,
    };

    /** Server-side history rows (no client transfer): `count` affected copies of `<br>`. */
    async function affectedHistory(pageId: number, count: number, padding = 0): Promise<void> {
      await query(
        `INSERT INTO page_versions (page_id, source, version_number, title, body_html, body_text)
         SELECT $1, 'local', n, 'v' || n, '<p>&amp;lt;br&amp;gt;</p>' || CASE WHEN $3 > 0 THEN '<!--' || repeat('x', $3) || '-->' ELSE '' END,
                '<br>'
           FROM generate_series(1, $2) AS n`,
        [pageId, count, padding],
      );
    }

    it('D12: 201 affected copies → nothing written, page_too_large, status never done; exactly 200 → written', async () => {
      const tooLarge = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      await affectedHistory(tooLarge, 201);
      const atLimit = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      await affectedHistory(atLimit, 200);
      const before = await versionRows(tooLarge);
      const summary = await run();
      expect(await versionRows(tooLarge)).toEqual(before);
      expect(counts(summary)).toMatchObject({ page_too_large: 1, repaired: 200 });
      const doc = await state();
      expect(doc).toMatchObject({ status: 'waiting', tooLarge: 1 });
      expect(Date.parse(doc.nextFullPassAfter!)).toBe(Date.parse(doc.passStartedAt!) + 24 * 3600_000);
    });

    it('D12: corrected text one byte over the limit → nothing written, page_too_large; exactly at the limit → written (limit scaled from 64 MiB)', async () => {
      const corrected = Buffer.byteLength('&lt;br&gt;');
      const over = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      await affectedHistory(over, 3);
      const limits = { maxCorrectedBytes: corrected * 3 - 1 };
      const first = await run({ limits });
      expect(counts(first)).toMatchObject({ page_too_large: 1 });
      expect((await versionRows(over)).map((row) => row.body_text)).toEqual(['<br>', '<br>', '<br>']);
      const second = await run({ restart: true, limits: { maxCorrectedBytes: corrected * 3 } });
      expect(counts(second)).toMatchObject({ repaired: 3 });
    });

    it('D12: 180 affected copies far above the statement budget (12 KiB html each, 2.1 MiB stored, budget scaled to 64 KiB) with a few bytes of corrected text → written, not page_too_large, under a corrected-text limit (4 KiB) between their corrected total and their raw input; no statement exceeds the budget', async () => {
      const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      await affectedHistory(pageId, 180, 12 * KIB);
      // D12 limits corrected output only: a raw-input cap at the same value
      // would refuse this page (180 × 10 B corrected, 180 × ~12 KiB raw).
      const maxCorrectedBytes = 4 * KIB;
      const sizes = (await query<{ corrected: string; raw: string }>(
        `SELECT (count(*) * octet_length('&lt;br&gt;'))::text AS corrected,
                sum(octet_length(body_html) + octet_length(body_text))::text AS raw
           FROM page_versions WHERE page_id = $1`, [pageId],
      )).rows[0]!;
      expect(Number(sizes.corrected)).toBeLessThan(maxCorrectedBytes);
      expect(Number(sizes.raw)).toBeGreaterThan(maxCorrectedBytes);
      let maxBytes = 0;
      const summary = await run({
        limits: { ...SCALED, maxCorrectedBytes },
        hooks: { onStatement: (info) => { maxBytes = Math.max(maxBytes, info.bytes); } },
      });
      expect(counts(summary)).toMatchObject({ repaired: 180 });
      expect(counts(summary).page_too_large ?? 0).toBe(0);
      expect(maxBytes).toBeGreaterThan(0);
      expect(maxBytes).toBeLessThanOrEqual(SCALED.statementBytes!);
    });

    it('one affected copy beside 10,000 non-matching rows of the same text length (read window scaled to 100) → written; reads and hashing stay windowed', async () => {
      const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      await affectedHistory(pageId, 1);
      await query(
        `INSERT INTO page_versions (page_id, source, version_number, title, body_html, body_text)
         SELECT $1, 'confluence', n, 'v' || n, '<p>abcd</p>', 'abcd' FROM generate_series(1, 10000) AS n`,
        [pageId],
      );
      const heapBefore = process.memoryUsage().heapUsed;
      let heapAtDecision = 0;
      const statements = new Map<string, number>();
      const summary = await run({
        limits: { scanRows: 100 },
        hooks: {
          onStatement: (info) => { statements.set(info.kind, (statements.get(info.kind) ?? 0) + 1); },
          afterDecision: () => { heapAtDecision = process.memoryUsage().heapUsed; },
        },
      });
      expect(counts(summary)).toMatchObject({ repaired: 1, no_ampersand: 10_001 });
      // 10,000 candidates hashed in windows of at most 100 ids.
      expect(statements.get('witness_versions')).toBeGreaterThanOrEqual(100);
      expect(heapAtDecision - heapBefore).toBeLessThan(64 * MIB);
    }, 60_000);

    it('96 outside copies of 16 KiB with a text length occurring in A and the only witness in a late hash group (budget scaled to 512 KiB) → found; no statement exceeds the budget', async () => {
      const pad = 16 * KIB - 5;
      const limits = { statementBytes: 512 * KIB };
      const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      await query(
        `INSERT INTO page_versions (page_id, source, version_number, title, body_html, body_text)
         VALUES ($1, 'local', 1, 'A', '<p>&amp;lt;br&amp;gt; ' || repeat('y', $2) || '</p>', '<br> ' || repeat('y', $2))`,
        [pageId, pad],
      );
      await query(
        `INSERT INTO page_versions (page_id, source, version_number, title, body_html, body_text)
         SELECT $1, 'confluence', n, 'v' || n, '<p>z</p>', repeat('q', $2 + 5) FROM generate_series(1, 95) AS n`,
        [pageId, pad],
      );
      await query(
        `INSERT INTO page_versions (id, page_id, source, version_number, title, body_html, body_text)
         VALUES ('ffffffff-ffff-4fff-bfff-ffffffffffff', $1, 'confluence', 200, 'late', '<p>z</p>', '<br> ' || repeat('y', $2))`,
        [pageId, pad],
      );
      const witnessStatements: number[] = [];
      let maxBytes = 0;
      const summary = await run({
        limits,
        hooks: {
          onStatement: (info) => {
            maxBytes = Math.max(maxBytes, info.bytes);
            if (info.kind === 'witness_versions') witnessStatements.push(info.bytes);
          },
        },
      });
      expect(counts(summary)).toMatchObject({ paired_exempt: 1 });
      expect(witnessStatements.length).toBeGreaterThanOrEqual(3);
      expect(maxBytes).toBeLessThanOrEqual(limits.statementBytes);
    });

    it('a page with very many NULL placeholders is drained server-side and repaired', async () => {
      const pageId = await insertPage({ html: pair().html, text: pair().text, source: 'confluence', remoteVersion: 7 });
      await query(
        `INSERT INTO page_versions (page_id, source, version_number, title)
         SELECT $1, 'confluence', n, 'v' || n FROM generate_series(1, 5000) AS n`,
        [pageId],
      );
      const summary = await run();
      expect(counts(summary).repaired).toBe(1);
    });

    it('a published column that grows past the ceiling between metadata and load is never transferred → changed', async () => {
      const pageId = await insertPage({ html: pair().html, text: pair().text });
      const loaded: string[] = [];
      const summary = await run({
        limits: { ceilingBytes: 4096 },
        hooks: {
          onStatement: async (info) => {
            if (info.kind === 'load_page' && info.ownerId === pageId) {
              await query(`UPDATE pages SET body_html = $2 WHERE id = $1`, [pageId, `<p>&amp;${'g'.repeat(5000)}</p>`]);
            }
          },
          onLoad: (info) => { loaded.push(info.key); },
        },
      });
      expect(loaded).toEqual([]);
      expect(summary.bytesLoaded).toBe(0);
      expect(counts(summary)).toMatchObject({ changed: 1 });
    });

    it('an owner with very many current rows does not block and keeps memory bounded', async () => {
      const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      await query(
        `INSERT INTO page_versions (page_id, source, version_number, title, body_html, body_text)
         SELECT $1, 'local', n, 'v' || n, '<p>A &amp; B ' || n || '</p>', 'A & B ' || n FROM generate_series(1, 1000) AS n`,
        [pageId],
      );
      const heapBefore = process.memoryUsage().heapUsed;
      let heapAfterScan = 0;
      const summary = await run({ limits: { scanRows: 100 }, hooks: { afterScan: () => { heapAfterScan = process.memoryUsage().heapUsed; } } });
      expect(counts(summary)).toMatchObject({ current: 1000, owners: 1 });
      expect(heapAfterScan - heapBefore).toBeLessThan(64 * MIB);
    }, 60_000);

    it('heartbeat during a long observation keeps the lease: no takeover while healthy', async () => {
      const pageId = await insertPage();
      await insertVersion(pageId, { version: 2, html: pair().html, text: pair().text });
      const other = await replica();
      try {
        let seqBefore = 0;
        let takeover: BodyTextBackfillSummary | null = null;
        const summary = await run({
          limits: { heartbeatMs: 0 },
          hooks: {
            atOpen: async () => { seqBefore = (await state()).seq; },
            afterScan: async () => {
              await patchState({}, '14 minutes');
              takeover = await other.run();
            },
          },
        });
        expect(takeover).toMatchObject({ outcome: 'already_running' });
        expect(summary.outcome).toBe('done');
        expect((await state()).seq).toBeGreaterThan(seqBefore + 2);
      } finally {
        await other.close();
      }
    });

    it('D4/D10 (bounds scaled: large 16 KiB, ceiling 128 KiB): a column one byte over the large bound and one exactly at the ceiling are each parsed alone and repaired; one byte over the ceiling is oversized and never loaded', async () => {
      const head = '<p>&amp;lt;br&amp;gt;</p><!--';
      const tail = '-->';
      const large = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      const atCeiling = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      const over = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      for (const [pageId, total] of [[large, 16 * KIB + 1], [atCeiling, 128 * KIB], [over, 128 * KIB + 1]] as const) {
        await query(
          `UPDATE pages SET body_html = $2 || repeat('x', $3) || $4, body_text = '<br>' WHERE id = $1`,
          [pageId, head, total - head.length - tail.length, tail],
        );
      }
      const requests: [number, string[]][] = [];
      const loaded: number[] = [];
      const summary = await run({
        limits: SCALED,
        hooks: {
          beforeParserRequest: (ownerId, keys) => { requests.push([ownerId, keys]); },
          onLoad: (info) => { loaded.push(info.ownerId); },
        },
      });
      expect((await pageRow(large)).body_text).toBe('&lt;br&gt;');
      expect((await pageRow(atCeiling)).body_text).toBe('&lt;br&gt;');
      expect((await pageRow(over)).body_text).toBe('<br>');
      expect(loaded).toEqual([large, atCeiling]);
      expect(requests).toEqual([[large, ['p:']], [atCeiling, ['p:']]]);
      expect(counts(summary)).toMatchObject({ oversized: 1, repaired: 2 });
    });

    it('D4 (scaled): on one owner a large + 1 B pair and a small pair that together fit the ordinary window are still two parser requests, the large one alone', async () => {
      const head = '<p>&amp;lt;br&amp;gt;</p><!--';
      const tail = '-->';
      const small = preFix('em', 'Draft');
      const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain', draftHtml: small.html, draftText: small.text });
      await query(
        `UPDATE pages SET body_html = $2 || repeat('x', $3) || $4, body_text = '<br>' WHERE id = $1`,
        [pageId, head, 16 * KIB + 1 - head.length - tail.length, tail],
      );
      const together = 16 * KIB + 1 + Buffer.byteLength('<br>') + Buffer.byteLength(small.html) + Buffer.byteLength(small.text);
      expect(together).toBeLessThanOrEqual(SCALED.windowBytes!);
      const requests: string[][] = [];
      const summary = await run({ limits: SCALED, hooks: { beforeParserRequest: (_ownerId, keys) => { requests.push(keys); } } });
      expect(requests).toEqual([['p:'], ['d:']]);
      expect(counts(summary)).toMatchObject({ repaired: 2 });
    });

    describe('the run-owned parser worker', () => {
      /** About 1.6 MiB of html whose parse takes far longer than the scaled request limit. */
      const slowHtml = `<div>${'<span>&amp;lt;x&amp;gt;</span>'.repeat(50_000)}</div>`;

      /** Wraps Worker#terminate to record when each terminated worker has exited. */
      function recordExits(events: string[]) {
        const original = Worker.prototype.terminate;
        return vi.spyOn(Worker.prototype, 'terminate').mockImplementation(async function (this: Worker) {
          const code = await original.call(this);
          events.push('exited');
          return code;
        });
      }

      /** Records every message the parent posts to a real worker. */
      function recordPosts(onPost: (message: { type: string; pairs?: { key: string }[] }) => void) {
        const original = Worker.prototype.postMessage;
        return vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message: unknown, ...rest: unknown[]) {
          onPost(message as { type: string; pairs?: { key: string }[] });
          return (original as (...a: unknown[]) => void).call(this, message, ...rest);
        });
      }

      it('stop during the handshake (before any row is posted) terminates the cold worker, returns after its exit; nothing recorded', async () => {
        const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain' });
        await insertVersion(pageId, { version: 2, html: slowHtml, text: 'x' });
        const events: string[] = [];
        recordExits(events);
        const rowRequests: string[][] = [];
        recordPosts((message) => {
          if (message.type === 'classify' && message.pairs?.[0]?.key !== 'canary') rowRequests.push(message.pairs!.map((p) => p.key));
        });
        let stopped: Promise<number> | null = null;
        const summary = await run({
          hooks: {
            beforeParserRequest: () => {
              setImmediate(() => { stopped = stopBodyTextBackfill().then(() => events.push('stop returned')); });
            },
          },
        });
        await stopped;
        expect(rowRequests).toEqual([]);
        expect(summary.outcome).toBe('interrupted');
        expect(counts(summary)).toEqual({});
        expect(events[0]).toBe('exited');
        expect(events.at(-1)).toBe('stop returned');
        expect(await state()).toMatchObject({ cursor: 0, passTotals: {}, owner: null });
      });

      it('stop after a healthy worker received the row request terminates it mid-parse and returns only after it exited; no owner checkpoint', async () => {
        const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain' });
        await insertVersion(pageId, { version: 2, html: slowHtml, text: 'x' });
        const events: string[] = [];
        recordExits(events);
        const posted: string[] = [];
        let stopped: Promise<number> | null = null;
        recordPosts((message) => {
          if (message.type !== 'classify') return;
          const key = message.pairs?.[0]?.key ?? '';
          posted.push(key);
          // The canary answered (the worker is healthy) and the row request is posted.
          if (key !== 'canary' && !stopped) {
            setImmediate(() => { stopped = stopBodyTextBackfill().then(() => events.push('stop returned')); });
          }
        });
        const summary = await run();
        await stopped;
        expect(posted[0]).toBe('canary');
        expect(posted.filter((key) => key !== 'canary')).toHaveLength(1);
        expect(summary.outcome).toBe('interrupted');
        expect(counts(summary)).toEqual({});
        expect(events[0]).toBe('exited');
        expect(events.at(-1)).toBe('stop returned');
        expect(await state()).toMatchObject({ cursor: 0, passTotals: {}, owner: null });
      });

      it('a window over the request limit is retried one pair per request on replaced workers: the pair that never answers is unevaluable, the other repaired (controlled entry, 3 s limit)', async () => {
        // A controlled worker entry: the real classifyPair behind the real
        // protocol, except that a request holding the marker text is never
        // answered. The deadline only has to expire against that request; the
        // ordinary pair has seconds of headroom on a fresh worker.
        const marker = 'zz-stall-1965';
        const dir = await mkdtemp(join(tmpdir(), 'bt-entry-'));
        const entry = join(dir, 'stalling-parser.ts');
        // An ES module scope for the entry (top-level await under tsx).
        await writeFile(join(dir, 'package.json'), '{"type":"module"}');
        await writeFile(entry, `
          import { parentPort, workerData } from 'node:worker_threads';
          import { getHeapStatistics } from 'node:v8';
          // Keep the real module's own message loop inert; this entry speaks the protocol.
          (workerData as { marker: string }).marker = 'inert';
          const { classifyPair } = await import(${JSON.stringify(new URL('./body-text-backfill-parser.ts', import.meta.url).href)});
          const port = parentPort!;
          port.on('message', (request: { requestId: number; pairs: { key: string; html: string; text: string }[] }) => {
            if (request.pairs.some((pair) => pair.text === ${JSON.stringify(marker)})) return;
            port.postMessage({ type: 'result', requestId: request.requestId,
              results: request.pairs.map((pair) => ({ ...classifyPair(pair.html, pair.text), key: pair.key })) });
          });
          port.postMessage({ type: 'ready', heapSizeLimitMb: getHeapStatistics().heap_size_limit / 1048576 });
        `);
        try {
          const good = preFix();
          const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain' });
          const stalled = await insertVersion(pageId, { version: 2, html: '<p>&amp;lt;stall&amp;gt;</p>', text: marker });
          const fast = await insertVersion(pageId, { version: 3, html: good.html, text: good.text });
          const events: string[] = [];
          recordExits(events);
          const requests: string[][] = [];
          const summary = await run({
            limits: { requestTimeoutMs: 3_000 },
            parserEntry: pathToFileURL(entry),
            hooks: { beforeParserRequest: (_ownerId, keys) => { requests.push(keys); } },
          });
          const both = [`v:${fast}`, `v:${stalled}`].sort();
          expect(requests).toHaveLength(3);
          expect([...requests[0]!].sort()).toEqual(both);
          expect(requests.slice(1).map((keys) => keys.length)).toEqual([1, 1]);
          expect(requests.slice(1).flat().sort()).toEqual(both);
          expect(counts(summary)).toMatchObject({ unevaluable: 1, repaired: 1 });
          expect((await versionRow(fast))!.body_text).toBe(good.fixed);
          expect((await versionRow(stalled))!.body_text).toBe(marker);
          // The timed-out window's worker and the stalled pair's worker were replaced.
          expect(events.filter((event) => event === 'exited').length).toBeGreaterThanOrEqual(2);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }, 60_000);
    });

    it('held hierarchy and lifecycle locks → busy within the lock deadline', async () => {
      const first = await insertPage();
      const second = await insertPage();
      const holder = await withHeldClient();
      try {
        await holder.client.query('SELECT pg_advisory_xact_lock($1)', [PAGE_HIERARCHY_LOCK_ID]);
        const hierarchy = await run({ limits: { lockTimeoutMs: 300 } });
        expect(counts(hierarchy)).toMatchObject({ busy: 2 });
      } finally {
        await holder.done();
      }
      const lifecycle = await withHeldClient();
      try {
        await lifecycle.client.query('SELECT pg_advisory_xact_lock($1, $2)', [PAGE_LIFECYCLE_LOCK_KEY, first]);
        const retried = await run({ limits: { lockTimeoutMs: 300 } });
        expect(counts(retried)).toMatchObject({ busy: 1, repaired: 1 });
        expect((await state()).unresolved.ids).toEqual([first]);
      } finally {
        await lifecycle.done();
      }
      expect((await pageRow(second)).body_text).toBe(preFix().fixed);
    });

    it('a slow last statement past the transaction deadline ends the session; the uncertain-commit rule settles it (not committed → busy)', async () => {
      const server = (await query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0]!.v;
      if (Number(server) < 170000) return;
      const pageId = await insertPage();
      const holder = await withHeldClient();
      try {
        await holder.client.query('SELECT pg_advisory_xact_lock(1965001)');
        const summary = await run({
          // 3 s: every other transaction of the run (claim, reads, release) must finish inside it.
          limits: { transactionTimeoutMs: 3_000, lockTimeoutMs: 10_000, statementTimeoutMs: 10_000 },
          hooks: {
            beforeCommit: async (step, _owner, client) => {
              if (step === 'close') await client.query('SELECT pg_advisory_xact_lock(1965001)');
            },
          },
        });
        expect(counts(summary)).toMatchObject({ busy: 1 });
        expect(counts(summary).repaired ?? 0).toBe(0);
      } finally {
        await holder.done();
      }
      expect((await pageRow(pageId)).body_text).toBe(preFix().text);
    });

    it('stop during nested admission, a lock wait, a parse and the scan ends the run interrupted with consistent state', async () => {
      // nested admission: the close in progress completes; the next statement stops.
      const admitted = await insertPage();
      await insertPage();
      const duringAdmission = await run({ hooks: { afterAdmission: () => { void stopBodyTextBackfill(); } } });
      expect(duringAdmission).toMatchObject({ outcome: 'interrupted', interruptCode: 'stopped' });
      expect((await state()).cursor).toBe(admitted);
      armBodyTextBackfill();
      // lock wait: bounded by the lock deadline.
      await truncateAllTables();
      const waiting = await insertPage();
      const holder = await withHeldClient();
      try {
        await holder.client.query('SELECT pg_advisory_xact_lock($1, $2)', [PAGE_LIFECYCLE_LOCK_KEY, waiting]);
        const duringLock = await run({
          limits: { lockTimeoutMs: 500 },
          hooks: { beforeAdmission: () => { void stopBodyTextBackfill(); } },
        });
        expect(duringLock.outcome).toBe('interrupted');
      } finally {
        await holder.done();
      }
      armBodyTextBackfill();
      // a parse: the request is refused, nothing counted.
      await truncateAllTables();
      await insertPage();
      const duringParse = await run({ hooks: { beforeParserRequest: () => { void stopBodyTextBackfill(); } } });
      expect(duringParse).toMatchObject({ outcome: 'interrupted', counts: {} });
      armBodyTextBackfill();
      // the scan.
      await truncateAllTables();
      await insertPage();
      const duringScan = await run({ hooks: { afterScan: () => { void stopBodyTextBackfill(); } } });
      expect(duringScan).toMatchObject({ outcome: 'interrupted', counts: {} });
      expect((await state())).toMatchObject({ status: 'idle', owner: null, cursor: 0 });
    });

    it('works with PG_POOL_MAX=1 (one pooled connection at a time)', async () => {
      const original = process.env.PG_POOL_MAX;
      const pageId = await insertPage({ draftHtml: preFix('em').html, draftText: preFix('em').text });
      await insertVersion(pageId, { version: 2, html: preFix('code').html, text: preFix('code').text });
      await closePool();
      process.env.PG_POOL_MAX = '1';
      try {
        const summary = await run();
        expect(summary.outcome).toBe('done');
        expect(counts(summary).repaired).toBe(3);
      } finally {
        await closePool();
        if (original === undefined) delete process.env.PG_POOL_MAX;
        else process.env.PG_POOL_MAX = original;
      }
    });

    function pair() {
      return preFix();
    }
  });

  // ─── 9. Completion and schedule ──────────────────────────────────────────

  describe('9. completion and schedule (controlled database clock)', () => {
    const DAY = 24 * 3600_000;

    it('D12: a permanently busy owner beside a page_too_large owner whose history is then reduced → the full pass runs on the daily cadence, repairs the reduced page, never reports done early', async () => {
      const limits = { maxAffectedCopies: 3 };
      const busy = await insertPage();
      await pendingIntent(busy);
      const large = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      const ids = await Promise.all([1, 2, 3, 4].map((version) => insertVersion(large, { version, ...preFix() })));
      const first = await run({ limits });
      expect(first.outcome).toBe('retry');
      let doc = await state();
      expect(doc).toMatchObject({ status: 'idle', phase: 'retry', tooLarge: 1, unresolved: { ids: [busy] } });
      expect(Date.parse(doc.nextFullPassAfter!)).toBe(Date.parse(doc.passStartedAt!) + DAY);
      expect((await run({ limits })).outcome).toBe('retry');
      await query('DELETE FROM page_versions WHERE id = $1', [ids[0]]);
      await patchState({ nextFullPassAfter: new Date((await dbNow()) - 1000).toISOString() });
      const daily = await run({ limits });
      doc = await state();
      expect(doc.pass).toBe(2);
      expect(daily.outcome).toBe('retry');
      expect(doc.status).not.toBe('done');
      expect((await versionRows(large)).map((row) => row.body_text)).toEqual([preFix().fixed, preFix().fixed, preFix().fixed]);
    });

    it('D12: more page_too_large owners than the list bound and no transient one → the daily cadence, not the overflow backoff (list bound scaled from 200 to 2)', async () => {
      for (let index = 0; index < 3; index += 1) await insertPage();
      await run({ limits: { maxAffectedCopies: 0, transientListMax: 2 } });
      const doc = await state();
      expect(doc).toMatchObject({ status: 'waiting', tooLarge: 3, overflowBackoffMs: null });
      expect(Date.parse(doc.nextFullPassAfter!)).toBe(Date.parse(doc.passStartedAt!) + DAY);
    });

    it('D12 after an explicit restart: the too-large checkpoint keeps the earlier carried re-check — at the waiting release and across an interruption and resume; a consumed due trigger starts its pass with NULL and the daily time', async () => {
      await insertPage();
      await run();
      const carried = new Date((await dbNow()) + 3_600_000).toISOString();
      await patchState({ nextFullPassAfter: carried });
      const big = await insertPage();
      const later = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      const limits = { maxAffectedCopies: 0 };
      // Immediate release: waiting, and the carried time is still the next one.
      expect((await run({ restart: true, limits })).outcome).toBe('waiting');
      expect(await state()).toMatchObject({ status: 'waiting', tooLarge: 1, nextFullPassAfter: carried });
      // Interrupted after the checkpoint: the stored time is already the carried one.
      const interrupted = await run({
        restart: true, limits, hooks: { atOpen: (ownerId) => { if (ownerId === later) void stopBodyTextBackfill(); } },
      });
      expect(interrupted.outcome).toBe('interrupted');
      expect(await state()).toMatchObject({ status: 'idle', cursor: big, tooLarge: 1, nextFullPassAfter: carried });
      armBodyTextBackfill();
      expect((await run({ limits })).outcome).toBe('waiting');
      expect((await state()).nextFullPassAfter).toBe(carried);
      // A due trigger is consumed: the fresh pass starts with NULL; the checkpoint stores the daily time.
      await patchState({ nextFullPassAfter: new Date((await dbNow()) - 1000).toISOString() });
      const atOpen: (string | null)[] = [];
      await run({ limits, hooks: { atOpen: async () => { atOpen.push((await state()).nextFullPassAfter); } } });
      expect(atOpen[0]).toBeNull();
      const doc = await state();
      expect(doc.status).toBe('waiting');
      expect(Date.parse(doc.nextFullPassAfter!)).toBe(Date.parse(doc.passStartedAt!) + DAY);
    });

    it('a crash immediately after claiming a due pass and checkpointing one owner → the takeover resumes the same pass number, horizon and cursor', async () => {
      const first = await insertPage();
      const second = await insertPage();
      await run();
      await patchState({ nextFullPassAfter: new Date((await dbNow()) - 1000).toISOString() });
      await query('UPDATE pages SET body_text = $2 WHERE id = ANY($1::int[])', [[first, second], preFix().text]);
      await run({ hooks: { atOpen: (ownerId) => { if (ownerId === second) void stopBodyTextBackfill(); } } });
      armBodyTextBackfill();
      const crashed = await state();
      expect(crashed).toMatchObject({ pass: 2, cursor: first, nextFullPassAfter: null });
      await patchState({ status: 'running', owner: randomUUID() }, '20 minutes');
      const opened: number[] = [];
      await run({ hooks: { atOpen: (ownerId) => { opened.push(ownerId); } } });
      const resumed = await state();
      expect(opened).toEqual([second]);
      expect(resumed).toMatchObject({ pass: 2, highWater: crashed.highWater, status: 'done' });
    });

    it('201 transient owners plus one too-large owner → the stored next time is passStartedAt + 24 h (overflow scaled: list limit 2)', async () => {
      const limits = { transientListMax: 2, maxAffectedCopies: 1 };
      for (let index = 0; index < 3; index += 1) await pendingIntent(await insertPage());
      const large = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      await insertVersion(large, { version: 1, ...preFix() });
      await insertVersion(large, { version: 2, ...preFix() });
      await run({ limits });
      const doc = await state();
      expect(doc).toMatchObject({ status: 'waiting', tooLarge: 1, unresolved: { overflow: true, count: 3 } });
      expect(Date.parse(doc.nextFullPassAfter!)).toBe(Date.parse(doc.passStartedAt!) + DAY);
    });

    it('at one clock instant with the daily time due: stale running/retry → fresh full pass; stale running/scan → resumed; idle/retry → fresh full pass', async () => {
      await insertPage();
      await run();
      const base = await state();
      const due = new Date((await dbNow()) - 1000).toISOString();
      for (const [status, phase, fresh] of [
        ['running', 'retry', true], ['running', 'scan', false], ['idle', 'retry', true],
      ] as const) {
        await query(`UPDATE admin_settings SET setting_value = $2, updated_at = NOW() - interval '20 minutes' WHERE setting_key = $1`, [
          BODY_TEXT_BACKFILL_STATE_KEY,
          JSON.stringify({ ...base, status, phase, owner: status === 'running' ? randomUUID() : null, nextFullPassAfter: due,
            cursor: 0, unresolved: { ids: [], overflow: false, count: 0, sample: [] } }),
        ]);
        const summary = await run();
        expect({ status, phase, pass: summary.pass }).toEqual({ status, phase, pass: fresh ? base.pass + 1 : base.pass });
      }
    });

    it('an owner found too large in the retry phase is counted once and leaves the list', async () => {
      const pageId = await insertPage();
      const intent = await pendingIntent(pageId);
      await run({ limits: { maxAffectedCopies: 1 } });
      expect((await state()).unresolved.ids).toEqual([pageId]);
      await settleIntent(intent);
      await insertVersion(pageId, { version: 1, ...preFix() });
      await run({ limits: { maxAffectedCopies: 1 } });
      const doc = await state();
      expect(doc).toMatchObject({ tooLarge: 1, unresolved: { ids: [] }, status: 'waiting' });
      expect(doc.passTotals.page_too_large).toBe(1);
    });

    it('busy → released → done; a permanently refused owner never lets the pass report done while others are served', async () => {
      const refused = await insertPage();
      await pendingIntent(refused);
      const served = await insertPage();
      for (let tick = 0; tick < 3; tick += 1) {
        const summary = await run();
        expect(summary.outcome).toBe('retry');
      }
      expect((await pageRow(served)).body_text).toBe(preFix().fixed);
      await query(`UPDATE page_write_intents SET status = 'cancelled', settled_at = NOW(), settlement_reason = 'test_settled',
                     settlement_proof = '{"assertion":"no_remote_io_began"}'::jsonb WHERE page_ids && ARRAY[$1]::int[]`, [refused]);
      expect((await run()).outcome).toBe('done');
    });

    it('K+1 unresolved with a small K: overflow → spaced pass → done; a crash mid-overflow resumes', async () => {
      const limits = { transientListMax: 1 };
      const a = await insertPage();
      const b = await insertPage();
      const intents = [await pendingIntent(a), await pendingIntent(b)];
      expect((await run({ limits })).outcome).toBe('waiting');
      let doc = await state();
      expect(doc).toMatchObject({ unresolved: { overflow: true, count: 2 }, overflowBackoffMs: 3600_000 });
      expect(Date.parse(doc.nextFullPassAfter!) - (await dbNow())).toBeGreaterThan(3500_000);
      expect((await run({ limits })).outcome).toBe('waiting');
      for (const intent of intents) await settleIntent(intent);
      await patchState({ nextFullPassAfter: new Date((await dbNow()) - 1000).toISOString() });
      // crash mid-overflow pass: claimed, one owner done, process gone.
      await run({ limits, hooks: { atOpen: (ownerId) => { if (ownerId === b) void stopBodyTextBackfill(); } } });
      armBodyTextBackfill();
      await patchState({ status: 'running', owner: randomUUID() }, '20 minutes');
      expect((await run({ limits })).outcome).toBe('done');
      doc = await state();
      expect(doc.overflowBackoffMs).toBeNull();
    });

    it('ticks before a due time are one settings read; at the due time a fresh pass starts; simultaneous due claimants start it once', async () => {
      await insertPage();
      await run();
      const before = await state();
      // Every statement on every client: the pool, bootstrap and claim paths alike.
      const spy = vi.spyOn(pg.Client.prototype, 'query');
      expect((await run()).outcome).toBe('already_completed');
      const reads = spy.mock.calls.map((call) => String(typeof call[0] === 'string' ? call[0] : (call[0] as { text?: string }).text))
        .filter((sql) => sql.includes('admin_settings'));
      spy.mockRestore();
      expect(reads).toHaveLength(1);
      expect(reads[0]).toContain('SELECT setting_value, NOW() AS now FROM admin_settings');
      expect((await state()).seq).toBe(before.seq);
      await patchState({ nextFullPassAfter: new Date((await dbNow()) - 1000).toISOString() });
      const other = await replica();
      try {
        const claimPaused = pause<[string, number | null, PoolClient]>();
        const first = run({ hooks: { beforeCommit: async (step) => { if (step === 'claim') await claimPaused.hook(); } } });
        await claimPaused.reached;
        const second = other.run();
        await expectBlockedBackend('%admin_settings%');
        claimPaused.release();
        const results = await Promise.all([first, second]);
        expect(results.map((result) => result.outcome)).toEqual(['done', 'already_running']);
        expect((await state()).pass).toBe(before.pass + 1);
      } finally {
        await other.close();
      }
    });

    it('a page deleted mid-owner is gone; a trashed page is not gone', async () => {
      const deleted = await insertPage();
      const trashed = await insertPage();
      const summary = await run({
        hooks: {
          afterScan: async (ownerId) => {
            if (ownerId === deleted) await query('DELETE FROM pages WHERE id = $1', [deleted]);
            if (ownerId === trashed) await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [trashed]);
          },
        },
      });
      expect(counts(summary)).toMatchObject({ gone: 1, changed: 1 });
      expect((await run()).outcome).toBe('done');
      expect((await pageRow(trashed)).body_text).toBe(preFix().fixed);
    });

    it('a lower page id committing behind the cursor is outside the cohort; pages above highWater are not visited; the re-check pass repairs them', async () => {
      const writer = await withHeldClient();
      let lowId = 0;
      try {
        lowId = (await writer.client.query<{ id: number }>(
          `INSERT INTO pages (title, body_html, body_text, source, version, visibility) VALUES ('late', $1, $2, 'standalone', 1, 'shared') RETURNING id`,
          [preFix().html, preFix().text],
        )).rows[0]!.id;
        const committed = await insertPage();
        const above: number[] = [];
        const summary = await run({
          hooks: {
            afterScan: async () => { above.push(await insertPage()); },
          },
        });
        expect(summary.outcome).toBe('done');
        expect((await pageRow(committed)).body_text).toBe(preFix().fixed);
        expect(above).toHaveLength(1);
        await writer.client.query('COMMIT');
        expect((await pageRow(lowId)).body_text).toBe(preFix().text);
        expect((await pageRow(above[0]!)).body_text).toBe(preFix().text);
      } finally {
        await writer.done();
      }
      expect((await run({ restart: true })).outcome).toBe('done');
      expect((await pageRow(lowId)).body_text).toBe(preFix().fixed);
    });

    it('premise: an old-style lazy fill committing after the scan and before the close, and an old-style draft save after the close, are repaired by the re-check pass', async () => {
      const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain', source: 'confluence', remoteVersion: 7 });
      await upsertVersionMetadata(pageId, 3, 'v3', { editedAt: null, author: null, message: null });
      // A backend older than #1940 fills the placeholder with pre-fix text
      // between this owner's observation and its close.
      const first = await run({
        hooks: {
          afterScan: async (ownerId) => {
            if (ownerId !== pageId) return;
            await query(`UPDATE page_versions SET body_html = $2, body_text = $3 WHERE page_id = $1 AND version_number = 3`,
              [pageId, preFix().html, preFix().text]);
          },
        },
      });
      expect(first.outcome).toBe('done');
      expect((await query('SELECT body_text FROM page_versions WHERE page_id = $1', [pageId])).rows).toEqual([{ body_text: preFix().text }]);
      await query('UPDATE pages SET draft_body_html = $2, draft_body_text = $3 WHERE id = $1', [pageId, preFix('em').html, preFix('em').text]);
      await patchState({ nextFullPassAfter: new Date((await dbNow()) - 1000).toISOString() });
      expect((await run()).outcome).toBe('done');
      expect((await pageRow(pageId)).draft_body_text).toBe(preFix('em').fixed);
      expect((await query('SELECT body_text FROM page_versions WHERE page_id = $1', [pageId])).rows).toEqual([{ body_text: preFix().fixed }]);
    });

    it('D8: first completion → re-check after 24 h → then every 30 days, across a restart, on the database clock', async () => {
      await insertPage();
      const t0 = await dbNow();
      await run();
      let doc = await state();
      expect(doc.status).toBe('done');
      expect(doc.firstCompletedAt).not.toBeNull();
      expect(Date.parse(doc.nextFullPassAfter!) - Date.parse(doc.completedAt!)).toBe(DAY);
      expect(Date.parse(doc.completedAt!)).toBeGreaterThanOrEqual(t0 - 1000);
      const first = doc.firstCompletedAt;
      // A process restart: the next tick decides from the stored row only.
      await patchState({ nextFullPassAfter: new Date((await dbNow()) - 1000).toISOString() });
      expect((await run()).outcome).toBe('done');
      doc = await state();
      expect(doc.pass).toBe(2);
      expect(doc.firstCompletedAt).toBe(first);
      expect(Date.parse(doc.nextFullPassAfter!) - Date.parse(doc.completedAt!)).toBe(30 * DAY);
    });

    it('first-ever claim on an empty installation completes', async () => {
      expect((await run()).outcome).toBe('done');
      expect(await state()).toMatchObject({ status: 'done', pass: 1, highWater: 0 });
    });
  });

  // ─── 10. Scheduling ───────────────────────────────────────────────────────

  describe('10. scheduling', () => {
    /** Every job terminal outcome line (`run finished`, and any other run outcome line), at any level. */
    function recordOutcomeLines(): { level: string; message: string; fields: Record<string, unknown> }[] {
      const lines: { level: string; message: string; fields: Record<string, unknown> }[] = [];
      for (const level of ['info', 'warn', 'error'] as const) {
        vi.spyOn(logger, level).mockImplementation(((fields: Record<string, unknown>, message?: string) => {
          if (fields?.job === 'body_text_backfill' && /^body_text backfill run /.test(String(message))) {
            lines.push({ level, message: String(message), fields });
          }
        }) as never);
      }
      return lines;
    }

    it('legacy: a stop before the first run cancels it (zero invocations while its timer is advanced through the first deadline); the same timer without a stop starts a run; a stop during an in-flight run awaits it', async () => {
      await insertPage();
      const lines = recordOutcomeLines();
      const timers = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const };
      vi.useFakeTimers({ toFake: [...timers.toFake] });
      try {
        startBodyTextBackfillWorker(3_600_000, 1_000);
        await stopBodyTextBackfill();
        vi.advanceTimersByTime(2 * 3_600_000);
      } finally {
        vi.useRealTimers();
      }
      // A fired callback would invoke the job (refused by the latch, but
      // still one terminal line); a cancelled one invokes nothing.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(lines).toEqual([]);
      expect((await query('SELECT 1 FROM admin_settings WHERE setting_key = $1', [BODY_TEXT_BACKFILL_STATE_KEY])).rows).toEqual([]);
      armBodyTextBackfill();
      // Control: without the stop, the first-delay timer starts a run.
      vi.useFakeTimers({ toFake: [...timers.toFake] });
      try {
        startBodyTextBackfillWorker(3_600_000, 1_000);
        vi.advanceTimersByTime(1_000);
        stopBodyTextBackfillWorker();
      } finally {
        vi.useRealTimers();
      }
      await expect.poll(async () => (await query<{ setting_value: string }>(
        'SELECT setting_value FROM admin_settings WHERE setting_key = $1', [BODY_TEXT_BACKFILL_STATE_KEY],
      )).rows.map((row) => (JSON.parse(row.setting_value) as BodyTextBackfillState).status), { timeout: 30_000 }).toEqual(['done']);
      // Settle the timer's run (stop awaits it), then pause a fresh pass in flight.
      await stopBodyTextBackfill();
      armBodyTextBackfill();
      const opened = pause<[number]>();
      // The processor entry used by both modes, with a hook to pause in flight.
      const inFlight = runBodyTextBackfill({ restart: true, hooks: { atOpen: opened.hook } });
      await opened.reached;
      const stopping = stopBodyTextBackfill();
      opened.release();
      await stopping;
      expect((await inFlight).outcome).toBe('interrupted');
      expect((await state()).owner).toBeNull();
    });

    it('legacy: a failed timer invocation logs exactly one terminal outcome line (failed, fixed code, error level)', async () => {
      await insertPage();
      await run();
      await query(`UPDATE admin_settings SET setting_value = '{"v":2}' WHERE setting_key = $1`, [BODY_TEXT_BACKFILL_STATE_KEY]);
      const lines = recordOutcomeLines();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      try {
        startBodyTextBackfillWorker(3_600_000, 1_000);
        vi.advanceTimersByTime(1_000);
        stopBodyTextBackfillWorker();
      } finally {
        vi.useRealTimers();
      }
      await expect.poll(() => lines.length, { timeout: 15_000 }).toBeGreaterThan(0);
      await stopBodyTextBackfill();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(lines).toEqual([expect.objectContaining({
        level: 'error', message: 'body_text backfill run finished',
        fields: expect.objectContaining({ outcome: 'failed', code: 'state_invalid' }),
      })]);
    });

    it('the BullMQ/legacy processor returns the summary string', async () => {
      await insertPage();
      const text = await processBodyTextBackfillJob({});
      expect(text).toMatch(/^body_text backfill done; pass 1 scan; /);
    });
  });

  // ─── 11. Reporting ────────────────────────────────────────────────────────

  describe('11. reporting', () => {
    it('per-commit progress, residual and final lines for ordinary, all-skip and interrupted runs; summary ≤ 500 characters; canary and raw error text absent from logs, errors and the stored result', async () => {
      const canary = 'zz-private-canary-1965';
      const lines: { level: string; message: string; payload: string }[] = [];
      for (const level of ['info', 'warn', 'error', 'debug'] as const) {
        vi.spyOn(logger, level).mockImplementation(((payload: unknown, message?: string) => {
          lines.push({ level, message: String(message), payload: JSON.stringify(payload) });
        }) as never);
      }
      // Run 1, ordinary: a repaired page whose HTML carries the canary, and an oversized residual.
      const html = `<style>@import "${canary}";</style><p>Use &amp;lt;br&amp;gt;</p>`;
      const canaryPage = await insertPage({ html, text: `@import "${canary}";Use <br>` });
      const oversized = await insertPage({ html: `<p>&amp;${'w'.repeat(5000)}</p>`, text: 'x' });
      const ordinary = await runBodyTextBackfill({ limits: { ceilingBytes: 4096 } });
      expect((await pageRow(canaryPage)).body_text).toBe(`@import "${canary}";Use &lt;br&gt;`);
      // Run 2, all-skip: the re-check pass finds nothing to write.
      const allSkip = await processBodyTextBackfillJob({ restart: true });
      // Run 3, interrupted by a raw PostgreSQL error that quotes page text.
      await query(`CREATE OR REPLACE FUNCTION zz_backfill_test_raw() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'raw failure %', '${canary}'; END $$ LANGUAGE plpgsql`);
      await query(`CREATE TRIGGER zz_backfill_test_raw BEFORE UPDATE OF body_text ON pages FOR EACH ROW EXECUTE FUNCTION zz_backfill_test_raw()`);
      await insertPage();
      let thrown: unknown;
      try {
        await processBodyTextBackfillJob({ restart: true });
      } catch (error) {
        thrown = error;
      } finally {
        await query('DROP TRIGGER zz_backfill_test_raw ON pages');
        await query('DROP FUNCTION zz_backfill_test_raw()');
      }
      const progress = lines.filter((line) => line.message === 'body_text backfill progress');
      expect(progress.length).toBeGreaterThanOrEqual(4);
      expect(lines.filter((line) => line.message === 'body_text backfill run finished')).toHaveLength(3);
      const residual = lines.filter((line) => line.message === 'body_text backfill residual');
      expect(residual.map((line) => JSON.parse(line.payload) as Record<string, unknown>)).toEqual([
        expect.objectContaining({ reason: 'oversized', pageId: oversized, column: 'published', htmlBytes: 5012, textBytes: 1 }),
      ]);
      expect(ordinary.outcome).toBe('done');
      expect(allSkip).toMatch(/^body_text backfill done; pass 2 scan; .*current=1/);
      expect(allSkip).not.toContain('repaired=');
      expect(thrown).toMatchObject({ name: 'BodyTextBackfillError', code: 'sql_P0001' });
      // What BullMQ would store in job_history: the returned summary or the error message.
      const stored = [formatBodyTextBackfillSummary(ordinary), allSkip, String((thrown as Error).message)];
      const everything = [...stored, ...lines.map((line) => `${line.message} ${line.payload}`)].join('\n');
      expect(everything).not.toContain(canary);
      expect(everything).not.toContain('raw failure');
      const huge = formatBodyTextBackfillSummary({
        outcome: 'interrupted', runId: randomUUID(), pass: 99999, phase: 'retry', bytesLoaded: Number.MAX_SAFE_INTEGER,
        interruptCode: 'reconciliation_failed',
        counts: Object.fromEntries(['repaired', 'current', 'diverged', 'no_ampersand', 'no_text', 'oversized', 'unevaluable',
          'frozen', 'baseline_referenced', 'paired_exempt', 'identity_conflict', 'unindexable', 'owners', 'gone', 'busy',
          'changed', 'page_too_large'].map((key) => [key, Number.MAX_SAFE_INTEGER])),
      });
      expect(huge.length).toBeLessThanOrEqual(500);
    });
  });

  // ─── 3b. Whole page or nothing: real later writers, each against a no-job control ──

  describe.skipIf(!redisAvailable)('3b. later writers behave as in the no-job control', () => {
    const pair = preFix();
    let confluence: Server;
    let confluenceUrl = '';
    const remote = new Map<string, { id: string; title: string; version: { number: number }; body: { storage: { value: string } } }>();
    let app: FastifyInstance;
    let currentUser = '';

    beforeAll(async () => {
      registerConfluencePagePutIntentReconcilers();
      confluence = createHttpServer((request, response) => {
        void (async () => {
          const id = decodeURIComponent((request.url ?? '').split('?')[0]!.replace('/rest/api/content/', ''));
          if (request.method === 'PUT') {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              title: string; version: { number: number }; body: { storage: { value: string } };
            };
            remote.set(id, { id, title: body.title, version: { number: body.version.number }, body: { storage: { value: body.body.storage.value } } });
          }
          const page = remote.get(id);
          if (!page) { response.writeHead(404).end(); return; }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(page));
        })();
      });
      await new Promise<void>((resolve) => confluence.listen(0, '127.0.0.1', resolve));
      confluenceUrl = `http://127.0.0.1:${(confluence.address() as AddressInfo).port}`;
      app = await buildKnowledgeTestApp(() => currentUser, async (instance) => {
        instance.redis = redis!;
        const { pagesCrudRoutes } = await import('../../routes/knowledge/pages-crud.js');
        await instance.register(pagesCrudRoutes, { prefix: '/api' });
      });
    });

    afterAll(async () => {
      await app.close();
      await new Promise<void>((resolve, reject) => confluence.close((error) => error ? reject(error) : resolve()));
    });

    beforeEach(() => {
      remote.clear();
    });

    /** A writer with Confluence credentials and write access to space REC, plus a recovery admin. */
    async function confluenceWriter(enabled = true): Promise<{ writer: string; admin: string }> {
      const writer = await insertUser();
      const admin = await insertUser('admin');
      await query(`INSERT INTO spaces (space_key, space_name) VALUES ('REC', 'Recovery') ON CONFLICT DO NOTHING`);
      const role = await query<{ id: number }>(
        `INSERT INTO roles (name, display_name, permissions) VALUES ($1, 'Writer', ARRAY['read', 'write']) RETURNING id`,
        [`backfill-writer-${randomUUID()}`],
      );
      await query(
        `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id) VALUES ('REC', 'user', $1, $2)`,
        [writer, role.rows[0]!.id],
      );
      await query(
        `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled) VALUES ($1, $2, $3, $4)`,
        [writer, confluenceUrl, encryptPat('backfill-writer-pat'), enabled],
      );
      await query('INSERT INTO user_settings (user_id, confluence_enabled) VALUES ($1, FALSE)', [admin]);
      currentUser = writer;
      return { writer, admin };
    }

    async function confluenceId(pageId: number): Promise<string> {
      return (await pageRow(pageId)).confluence_id as string;
    }

    /**
     * The real remote "restore version" completion: a pending
     * `page.version_restore` intent of a fenced writer, the provider at E+1
     * with the intended state, settled by `reconcilePageWriteIntent`.
     */
    async function remoteRestore(pageId: number, users: { writer: string; admin: string }): Promise<string> {
      const id = await confluenceId(pageId);
      const page = (await query<{ c: string; l: string; remote_version: number }>(
        'SELECT content_revision::text AS c, lifecycle_revision::text AS l, remote_version FROM pages WHERE id = $1', [pageId],
      )).rows[0]!;
      await query(
        `INSERT INTO page_versions (page_id, source, version_number, title, body_html, body_text)
         VALUES ($1, 'confluence', 2, 'Intended title', '<p>intended storage</p>', 'intended storage')
         ON CONFLICT DO NOTHING`,
        [pageId],
      );
      const runtimeId = `restore-runtime-${randomUUID()}`;
      const acknowledgmentId = randomUUID();
      await query(
        `INSERT INTO page_writer_runtimes
           (runtime_id, deployment_identity, quiesced_at, quiescence_ack, fenced_at, fenced_by, fence_reason, fence_proof,
            enforcement_version)
         VALUES ($1, '{"host":"restore-test"}'::jsonb, NOW(), $2, NOW(), $3,
                 'Owner runtime quiesced before conditional recovery', $4::jsonb, $5)`,
        [runtimeId, acknowledgmentId, users.admin,
          JSON.stringify({ kind: 'owner_quiescence_ack', acknowledgmentId, deploymentIdentity: { host: 'restore-test' } }),
          PAGE_WRITER_ENFORCEMENT_VERSION],
      );
      const digest = confluencePagePutDigest({
        pageId, confluenceId: id, title: 'Intended title', bodyStorage: '<p>intended storage</p>',
        expectedRemoteVersion: page.remote_version,
      });
      const intent = await query<{ id: string }>(
        `INSERT INTO page_write_intents (runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect)
         VALUES ($1, 'page.version_restore', $2, ARRAY[$3]::integer[], $4::jsonb, 'remote_conditional', $5::jsonb)
         RETURNING id`,
        [runtimeId, users.writer, pageId,
          JSON.stringify({ [pageId]: { contentRevision: page.c, lifecycleRevision: page.l } }),
          JSON.stringify({ effectClass: 'remote', pageId, confluenceId: id, expectedRemoteVersion: String(page.remote_version),
            intendedStateDigest: digest, targetVersion: 2 })],
      );
      remote.set(id, {
        id, title: 'Intended title', version: { number: page.remote_version + 1 },
        body: { storage: { value: '<p>intended storage</p>' } },
      });
      try {
        await reconcilePageWriteIntent(intent.rows[0]!.id, {
          actorId: users.admin, reason: 'Recover the remote restore after the backfill test',
        });
      } catch (error) {
        return (error as { reason?: string }).reason ?? 'error';
      }
      return (await query<{ status: string }>('SELECT status FROM page_write_intents WHERE id = $1', [intent.rows[0]!.id]))
        .rows[0]!.status;
    }

    /** Run `scenario` without the job, then on a fresh database with the job first; both outcomes must match. */
    async function withControl<T>(scenario: (job: boolean) => Promise<T>): Promise<{ control: T; job: T }> {
      const control = await scenario(false);
      await truncateAllTables();
      armBodyTextBackfill();
      const job = await scenario(true);
      return { control, job };
    }

    it('live v7 and an unlinked identical local:8; a kept-local observation of remote v8, then the real overwrite path → no local_edit_snapshot_conflict, as in the control', async () => {
      const outcomes = await withControl(async (job) => {
        const { writer } = await confluenceWriter(false);
        const pageId = await insertPage({
          html: pair.html, text: pair.text, source: 'confluence', spaceKey: 'REC', version: 7, remoteVersion: 7,
          localModifiedBy: writer, localModifiedAt: new Date(),
        });
        await insertVersion(pageId, { version: 8, title: 'Neutral title', html: pair.html, text: pair.text });
        if (job) expect(counts(await run()).repaired).toBe(2);
        return withClient(async (client) => {
          await client.query('BEGIN');
          try {
            await recordConfluenceVersionObservation(client, pageId, 8);
            const row = (await client.query<{ id: number; version: number; title: string; body_html: string | null; body_text: string | null }>(
              'SELECT id, version, title, body_html, body_text FROM pages WHERE id = $1 FOR UPDATE', [pageId],
            )).rows[0]!;
            await snapshotLocalVersionBeforeOverwrite(client, row, 'local');
            await client.query('COMMIT');
            return 'stored';
          } catch (error) {
            await client.query('ROLLBACK');
            return (error as { reason?: string }).reason ?? 'error';
          }
        });
      });
      expect(outcomes).toEqual({ control: 'stored', job: 'stored' });
    });

    it('live pair A, draft B, unlinked local:8 with pair B: publish the draft (integration off), then the real version-jump overwrite → succeeds, as in the control', async () => {
      const a = preFix('br');
      const b = preFix('em', 'Draft');
      const outcomes = await withControl(async (job) => {
        const { writer } = await confluenceWriter(false);
        const pageId = await insertPage({
          html: a.html, text: a.text, draftHtml: b.html, draftText: b.text, source: 'confluence', spaceKey: 'REC',
          version: 7, remoteVersion: 7,
        });
        await query('UPDATE pages SET draft_updated_by = $2, draft_updated_at = NOW() WHERE id = $1', [pageId, writer]);
        await insertVersion(pageId, { version: 8, title: 'Neutral title', html: b.html, text: b.text });
        if (job) expect(counts(await run()).repaired).toBe(3);
        const published = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/draft/publish` });
        expect(published.statusCode, published.body).toBe(200);
        return withClient(async (client) => {
          await client.query('BEGIN');
          try {
            const row = (await client.query<{ id: number; version: number; title: string; body_html: string | null; body_text: string | null }>(
              'SELECT id, version, title, body_html, body_text FROM pages WHERE id = $1 FOR UPDATE', [pageId],
            )).rows[0]!;
            expect(row.version).toBe(8);
            await snapshotLocalVersionBeforeOverwrite(client, row, 'local');
            await client.query('COMMIT');
            return 'stored';
          } catch (error) {
            await client.query('ROLLBACK');
            return (error as { reason?: string }).reason ?? 'error';
          }
        });
      });
      expect(outcomes).toEqual({ control: 'stored', job: 'stored' });
    });

    it('a task-list draft without ids holding `&amp;lt;br&amp;gt;` and a complete unlinked confluence:8 with the post-assignTaskIds html and the old text: remote publish returning v8, then a real remote restore completion → no intent_restore_history_unavailable, as in the control', async () => {
      const draftHtml = '<ul data-type="taskList"><li data-type="taskItem" data-checked="false">Use &amp;lt;br&amp;gt; here</li></ul>';
      const outcomes = await withControl(async (job) => {
        const users = await confluenceWriter(true);
        const pageId = await insertPage({
          title: 'Guide', html: '<p>live</p>', text: 'live', draftHtml, draftText: 'Use <br> here',
          source: 'confluence', spaceKey: 'REC', version: 7, remoteVersion: 7,
        });
        await query('UPDATE pages SET draft_updated_by = $2, draft_updated_at = NOW() WHERE id = $1', [pageId, users.writer]);
        const live = await pageRow(pageId);
        const withIds = assignTaskIds(draftHtml, {
          previousStorage: live.body_storage as string, legacyTasks: hasOnlyUncarriedTasks(live.body_html as string),
        }).html;
        await insertVersion(pageId, { source: 'confluence', version: 8, title: 'Guide', html: withIds, text: 'Use <br> here' });
        const id = await confluenceId(pageId);
        remote.set(id, { id, title: 'Guide', version: { number: 7 }, body: { storage: { value: '<p>live</p>' } } });
        if (job) expect(counts(await run()).repaired).toBe(2);
        const published = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/draft/publish` });
        expect(published.statusCode, published.body).toBe(200);
        expect(await pageRow(pageId)).toMatchObject({ version: 8, remote_version: 8, body_html: withIds });
        return remoteRestore(pageId, users);
      });
      expect(outcomes).toEqual({ control: 'reconciled_applied', job: 'reconciled_applied' });
    });

    for (const mirror of [false, true]) {
      it(`standalone v7, ${mirror ? 'linked local:8 and unlinked local:3' : 'linked local:3 and unlinked local:8'} with the same pair: nothing written; restore v3, then freeze → the baseline links the exact v8 snapshot, as in the control`, async () => {
        const outcomes = await withControl(async (job) => {
          const admin = await freezingAdmin();
          const pageId = await insertPage({ html: pair.html, text: pair.text, createdBy: admin, visibility: 'private', version: 7 });
          const v3 = await insertVersion(pageId, { version: 3, title: 'Neutral title', html: pair.html, text: pair.text });
          const v8 = await insertVersion(pageId, { version: 8, title: 'Neutral title', html: pair.html, text: pair.text });
          await insertBaseline(pageId, admin, mirror ? v8 : v3);
          if (job) {
            const before = { page: await pageRow(pageId), versions: await versionRows(pageId) };
            expect(counts(await run()).paired_exempt).toBe(2);
            expect({ page: await pageRow(pageId), versions: await versionRows(pageId) }).toEqual(before);
          }
          await restoreVersion(pageId, 3, { source: 'local', actorId: admin });
          const frozen = await realFreeze(pageId, admin);
          const linked = (await query<{ version_snapshot_id: string | null }>(
            'SELECT version_snapshot_id FROM page_baselines WHERE id = $1', [frozen.baselineId],
          )).rows[0]!.version_snapshot_id;
          return linked === v8 ? 'v8' : String(linked);
        });
        expect(outcomes).toEqual({ control: 'v8', job: 'v8' });
      });
    }

    describe('D13: identity switch onto an occupied key', () => {
      interface Slot { title: string; html: string | null; text: string | null; linked?: boolean }

      async function d13(slot: Slot | null, job: boolean): Promise<{ restore: string; written: boolean; reason?: number }> {
        const users = await confluenceWriter(true);
        const pageId = await insertPage({
          title: 'Guide', html: pair.html, text: pair.text, source: 'confluence', spaceKey: 'REC', version: 7, remoteVersion: 7,
          localModifiedBy: users.writer, localModifiedAt: null,
        });
        if (slot) {
          const slotId = await insertVersion(pageId, { source: 'local', version: 7, ...slot });
          if (slot.linked) await insertBaseline(pageId, users.writer, slotId);
        }
        let written = false;
        let reason: number | undefined;
        if (job) {
          const summary = await run();
          written = (summary.counts.repaired ?? 0) > 0;
          reason = summary.counts.identity_conflict;
          const row = await pageRow(pageId);
          if (written) expect(row.local_modified_at).not.toBeNull();
          else expect(row).toMatchObject({ body_text: pair.text, local_modified_at: null });
        }
        return { restore: await remoteRestore(pageId, users), written, ...(reason === undefined ? {} : { reason }) };
      }

      const cases: { name: string; slot: Slot | null; written: boolean }[] = [
        { name: 'a complete local:7 with unrelated html and text → nothing written, identity_conflict', slot: { title: 'Guide', html: '<p>unrelated</p>', text: 'unrelated' }, written: false },
        { name: 'no local:7 row → repaired, marker set (D2)', slot: null, written: true },
        { name: 'an unlinked bodyless local:7 of the same title → repaired', slot: { title: 'Guide', html: null, text: null }, written: true },
        { name: 'a bodyless local:7 titled `Manual` → nothing written, identity_conflict', slot: { title: 'Manual', html: null, text: null }, written: false },
        { name: 'a bodyless local:7 titled `v7` → nothing written, identity_conflict', slot: { title: 'v7', html: null, text: null }, written: false },
        { name: 'a same-titled but linked bodyless local:7 → nothing written, identity_conflict', slot: { title: 'Guide', html: null, text: null, linked: true }, written: false },
        { name: "local:7 being the page's own content in A → repaired together", slot: { title: 'Guide', html: pair.html, text: pair.text }, written: true },
        { name: 'local:7 with the same title and html and the already-correct text (not in A, not a witness) → repaired', slot: { title: 'Guide', html: pair.html, text: pair.fixed }, written: true },
      ];

      for (const testCase of cases) {
        it(`D13: ${testCase.name}; the real remote restore completion then succeeds as in the control`, async () => {
          const outcomes = await withControl((job) => d13(testCase.slot, job));
          expect(outcomes.control).toEqual({ restore: 'reconciled_applied', written: false });
          expect(outcomes.job).toEqual(testCase.written
            ? { restore: 'reconciled_applied', written: true }
            : { restore: 'reconciled_applied', written: false, reason: 1 });
        });
      }
    });
  });
});
