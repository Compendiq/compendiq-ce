/**
 * #1965 body_text backfill against real PostgreSQL (design r12 §10).
 *
 * Every race runs through the job's hooks with barriers; nothing sleeps.
 * Untouched columns are asserted by full-row comparison. Test names carry
 * the acceptance bullet (AC1–AC11, numbered as in the issue body) or the
 * maintainer decision (D1–D13) they prove.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  type BodyTextBackfillHooks,
  type BodyTextBackfillLimits,
  type BodyTextBackfillOptions,
  type BodyTextBackfillState,
  type BodyTextBackfillSummary,
} from './body-text-backfill.js';
import { htmlToText } from './content-converter.js';
import { setPageBaselineReadinessProvider } from './page-baseline-governance.js';
import {
  freezePage,
  previewPageBaseline,
  setPageBaselineCreationEnabled,
  unfreezePage,
} from './page-baseline-service.js';
import {
  cancelPageWriteIntentBeforeEffect,
  completePageWriteIntent,
  lockPageLifecycle,
  reservePageWriteIntent,
  runPageWriteIntentEffect,
  withPageHierarchyWriteTransaction,
} from './page-write-admission.js';
import { setRedisClient } from './redis-cache.js';
import { fillVersionBody, snapshotLocalVersionBeforeOverwrite, upsertVersionMetadata } from './version-snapshot.js';
import { restoreVersion } from '../../domains/knowledge/services/version-tracker.js';
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
  });

  // keep helpers referenced while sections grow
  it.skip('placeholder', () => {
    void htmlToText; void logger; void formatBodyTextBackfillSummary; void processBodyTextBackfillJob;
    void startBodyTextBackfillWorker; void freezePage; void previewPageBaseline; void setPageBaselineCreationEnabled;
    void unfreezePage; void cancelPageWriteIntentBeforeEffect; void lockPageLifecycle; void withPageHierarchyWriteTransaction;
    void fillVersionBody; void snapshotLocalVersionBeforeOverwrite; void upsertVersionMetadata; void restoreVersion;
    void dbNow; void PAGE_HIERARCHY_LOCK_ID; void PAGE_LIFECYCLE_LOCK_KEY;
    const unused: BodyTextBackfillHooks[] = [];
    void unused;
  });
});
