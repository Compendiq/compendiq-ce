/**
 * #1742 original-consumer regressions and preservation controls, real PostgreSQL/Redis.
 * No future restore-body/PK schema or helper import is needed for this baseline.
 * A01-A03 are post-delta controls, separate from the accepted original-red ledger.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { createClient, type RedisClientType } from 'redis';
import { getPool, query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables, waitForDatabaseCondition } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { pagesCrudRoutes } from './pages-crud.js';
import { localSpacesRoutes } from './local-spaces.js';
import { buildKnowledgeTestApp, insertConfluencePage, insertLocalSpace, insertStandalonePage, insertUser } from './pages.test-helpers.js';

const ORIGINAL = 'ORIGINAL';
const TARGET = 'TARGET';
const RETAINED = 'RETAINED';
const PARENT = 'PARENT';
const REMOTE = 'REMOTE';
const BATCH_STAMP = '2026-06-01T12:34:56.123456Z';
const OLDER_STAMP = '2020-01-01T00:00:00.654321Z';
const MAX_PK = 2_147_483_647;

interface HttpResponse {
  statusCode: number;
  payload: string;
  json<T>(): T;
}

interface PageState {
  id: number;
  title: string;
  source: string;
  created_by_user_id: string | null;
  visibility: string;
  space_key: string | null;
  parent_id: string | null;
  path: string | null;
  depth: number;
  deleted_at: string | null;
  content_revision: string;
  lifecycle_revision: string;
  notion_page_id: string | null;
  body_html: string | null;
  version: number;
  baseline_id: string | null;
}

interface AuditRow {
  resource_id: string | null;
  metadata: Record<string, unknown>;
}

interface Tree {
  root: number;
  child: number;
  grandchild: number;
  ids: number[];
}

interface TrackedResponse {
  promise: Promise<HttpResponse>;
  response?: HttpResponse;
  failure?: { error: unknown };
  pid?: number;
}

let app: FastifyInstance;
let redis: RedisClientType;
let userA: string;
let userB: string;
let currentUserId: string;
let activeRaceCleanup: (() => Promise<void>) | undefined;

async function buildAdditionalOwnerClient(): Promise<FastifyInstance> {
  return buildKnowledgeTestApp(() => userA, async (instance) => {
    instance.redis = redis;
    await instance.register(pagesCrudRoutes, { prefix: '/api' });
    await instance.register(localSpacesRoutes, { prefix: '/api' });
  });
}

async function rehomeAndRetrash(client: FastifyInstance, tree: Tree): Promise<void> {
  const rehomed = await client.inject({
    method: 'POST',
    url: `/api/pages/${tree.root}/restore`,
    payload: { targetSpaceKey: RETAINED },
  });
  expect(rehomed.statusCode, rehomed.payload).toBe(200);
  expect(rehomed.json()).toMatchObject({ restored: true });
  const trashed = await client.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });
  expect(trashed.statusCode, trashed.payload).toBe(200);
  const state = await pages(tree.ids);
  expect(state.every((page) => page.space_key === RETAINED && page.deleted_at !== null)).toBe(true);
  expect(new Set(state.map((page) => page.deleted_at)).size).toBe(1);
}

async function fixtureMissingOwnedChildSpace(tree: Tree): Promise<void> {
  const before = (await pages([tree.child]))[0]!;
  const changed = await query(
    `UPDATE pages SET space_key = $2
      WHERE id = $1 AND source = 'standalone'
        AND created_by_user_id = $3 AND deleted_at IS NOT NULL`,
    [tree.child, ORIGINAL, userA],
  );
  expect(changed.rowCount).toBe(1);
  expect(await pages([tree.child])).toEqual([{
    ...before,
    space_key: ORIGINAL,
    content_revision: String(BigInt(before.content_revision) + 1n),
  }]);
}

function missingRoot(key: string) {
  return {
    statusCode: 409,
    error: 'Conflict',
    reason: 'restore_space_missing',
    message: `The space "${key}" no longer exists. Choose a space to restore into.`,
    missingSpaceKey: key,
    canChooseTarget: true,
  };
}

function missingRetained(key: string) {
  return {
    statusCode: 409,
    error: 'Conflict',
    reason: 'restore_space_missing',
    message: `The space "${key}" for another page in this trash batch no longer exists. This batch cannot be restored by choosing a target for this page.`,
    missingSpaceKey: key,
    canChooseTarget: false,
  };
}

const invalidTarget = {
  statusCode: 409,
  error: 'Conflict',
  reason: 'restore_target_space_invalid',
  message: 'The selected restore space is unavailable. Choose an existing local space.',
};
const inapplicableTarget = {
  statusCode: 400,
  error: 'ValidationError',
  reason: 'restore_target_not_applicable',
  message: 'A restore target can only be chosen when the stored space no longer exists.',
};

async function restore(pageId: string | number, body?: unknown): Promise<HttpResponse> {
  return body === undefined
    ? await app.inject({ method: 'POST', url: `/api/pages/${pageId}/restore` })
    : await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/restore`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
}

async function deleteSpace(key: string): Promise<HttpResponse> {
  return app.inject({ method: 'DELETE', url: `/api/spaces/local/${key}` });
}

async function removeSpace(key = ORIGINAL): Promise<void> {
  const result = await deleteSpace(key);
  expect(result.statusCode, result.payload).toBe(200);
  expect(result.json()).toEqual({ key, deleted: true });
}

async function pages(ids: readonly number[]): Promise<PageState[]> {
  return (await query<PageState>(
    `SELECT id, title, source, created_by_user_id, visibility, space_key, parent_id,
            path, depth, deleted_at::text, content_revision::text,
            lifecycle_revision::text, notion_page_id, body_html, version, baseline_id::text
       FROM pages WHERE id = ANY($1::int[]) ORDER BY id`,
    [ids],
  )).rows;
}

async function audits(): Promise<AuditRow[]> {
  return (await query<AuditRow>(
    `SELECT resource_id, metadata FROM audit_log
      WHERE action = 'PAGE_RESTORED' ORDER BY created_at, id`,
  )).rows;
}

async function seedPageCaches(): Promise<void> {
  await Promise.all([userA, userB].map((userId) => redis.set(`kb:${userId}:pages:sentinel`, userId)));
}

async function cacheValues(): Promise<Array<string | null>> {
  return Promise.all([userA, userB].map((userId) => redis.get(`kb:${userId}:pages:sentinel`)));
}

async function effects(ids: readonly number[]) {
  return { pages: await pages(ids), audits: await audits(), caches: await cacheValues() };
}

async function stampTogether(ids: readonly number[]): Promise<void> {
  await query('UPDATE pages SET deleted_at = $2::timestamptz WHERE id = ANY($1::int[])', [ids, BATCH_STAMP]);
}

async function seedTree(spaceKey = ORIGINAL, sharedChild = false): Promise<Tree> {
  const root = await insertStandalonePage('Restore root', 'private', userA, spaceKey);
  const child = await insertStandalonePage('Restore child', sharedChild ? 'shared' : 'private', userA, spaceKey, { parentId: String(root) });
  const grandchild = await insertStandalonePage('Restore grandchild', 'private', userA, spaceKey, { parentId: String(child) });
  await query('UPDATE pages SET path = $2, depth = $3 WHERE id = $1', [root, `/${root}`, 0]);
  await query('UPDATE pages SET path = $2, depth = $3 WHERE id = $1', [child, `/${root}/${child}`, 1]);
  await query('UPDATE pages SET path = $2, depth = $3 WHERE id = $1', [grandchild, `/${root}/${child}/${grandchild}`, 2]);
  return { root, child, grandchild, ids: [root, child, grandchild] };
}

async function trashTree(tree: Tree): Promise<void> {
  const response = await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });
  expect(response.statusCode, response.payload).toBe(200);
  const stamps = await query<{ count: string; trashed: string }>(
    `SELECT COUNT(DISTINCT deleted_at)::text AS count,
            COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::text AS trashed
       FROM pages WHERE id = ANY($1::int[])`,
    [tree.ids],
  );
  expect(stamps.rows[0]).toEqual({ count: '1', trashed: '3' });
}

async function seededTrash(spaceKey: string | null = ORIGINAL): Promise<number> {
  const id = await insertStandalonePage('Trashed restore candidate', 'private', userA, spaceKey ?? ORIGINAL);
  if (spaceKey === null) await query('UPDATE pages SET space_key = NULL WHERE id = $1', [id]);
  await stampTogether([id]);
  return id;
}

function restoredState(before: PageState, spaceKey = before.space_key, parentId = before.parent_id): PageState {
  return {
    ...before,
    deleted_at: null,
    space_key: spaceKey,
    parent_id: parentId,
    content_revision: String(BigInt(before.content_revision) + 1n),
  };
}

async function noLiveMissingSpace(): Promise<Array<{ id: number; space_key: string }>> {
  return (await query<{ id: number; space_key: string }>(
    `SELECT p.id, p.space_key FROM pages p LEFT JOIN spaces s ON s.space_key = p.space_key
      WHERE p.deleted_at IS NULL AND p.space_key IS NOT NULL
        AND p.space_key <> '__local__' AND s.space_key IS NULL ORDER BY p.id`,
  )).rows;
}

async function grantRemoteRead(): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, is_system, permissions)
     VALUES ('restore-space-reader', 'Restore space reader', FALSE, ARRAY['read']) RETURNING id`,
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)`,
    [REMOTE, userA, role.rows[0]!.id],
  );
}

// The same durable local-baseline fixture shape used by the existing cascade suite.
async function fixtureIntent(pageId: number, actorId: string, completed: boolean) {
  await query(
    `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity, ai_policy_enforcement_version)
     VALUES ('restore-space-fixture', '{"kind":"test"}'::jsonb, 1)
     ON CONFLICT (runtime_id) DO NOTHING`,
  );
  const result = await query<{ intent_id: string; baseline_id: string }>(
    `WITH ids AS (SELECT gen_random_uuid() AS intent_id, gen_random_uuid() AS baseline_id)
     INSERT INTO page_write_intents (
       id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode,
       effect, status, settled_at, settlement_reason, settlement_proof
     )
     SELECT ids.intent_id, 'restore-space-fixture', 'baseline.prepare', $2,
            ARRAY[p.id], jsonb_build_object(p.id::text, jsonb_build_object(
              'contentRevision', p.content_revision::text,
              'lifecycleRevision', p.lifecycle_revision::text)),
            'local_verified', jsonb_build_object('effectClass', 'local', 'baselineId', ids.baseline_id::text),
            CASE WHEN $3::boolean THEN 'completed' ELSE 'pending' END,
            CASE WHEN $3::boolean THEN NOW() ELSE NULL END,
            CASE WHEN $3::boolean THEN 'effect_committed' ELSE NULL END,
            CASE WHEN $3::boolean THEN '{}'::jsonb ELSE NULL END
       FROM ids JOIN pages p ON p.id = $1
     RETURNING id::text AS intent_id, effect->>'baselineId' AS baseline_id`,
    [pageId, actorId, completed],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function freezePage(pageId: number, actorId = userA): Promise<void> {
  const fixture = await fixtureIntent(pageId, actorId, true);
  const state = (await pages([pageId]))[0]!;
  await query(
    `INSERT INTO page_baselines (
       id, page_id, original_page_id, page_identity, version,
       content_revision, lifecycle_revision, manifest_digest, manifest,
       manifest_bytes, title, body_html, total_bytes, reserved_bytes,
       status, prepared_by_user_id, prepared_by_name, preparation_intent_id,
       published_by_user_id, published_by_name, published_at, provenance, freeze_reason
     ) VALUES (
       $2, $1, $1, '[]'::jsonb, $3, $4::bigint, $5::bigint, $6, '[]'::jsonb,
       convert_to('[]', 'UTF8'), 'PRIVATE FROZEN RESTORE TITLE', $7, 0, 0,
       'published', $8, 'Restore fixture', $9, $8, 'Restore fixture', NOW(),
       'manual_assertion', 'Restore preservation control'
     )`,
    [pageId, fixture.baseline_id, state.version, state.content_revision, state.lifecycle_revision,
      '7'.repeat(64), state.body_html, actorId, fixture.intent_id],
  );
  await query(
    `UPDATE pages SET baseline_id = $2, frozen_version = version, frozen_at = NOW(),
       frozen_by_user_id = $3, frozen_by_name = 'Restore fixture',
       freeze_reason = 'Restore preservation control', freeze_provenance = 'manual_assertion',
       freeze_reported_signatories = '[]'::jsonb WHERE id = $1`,
    [pageId, fixture.baseline_id, actorId],
  );
}

function track(operation: PromiseLike<HttpResponse>): TrackedResponse {
  const tracked: TrackedResponse = { promise: Promise.resolve(operation) };
  tracked.promise = tracked.promise.then(
    (response) => { tracked.response = response; return response; },
    (error: unknown) => { tracked.failure = { error }; throw error; },
  );
  // The original promise is still awaited/settled below; this only prevents an
  // early rejection from becoming unhandled while the other request is observed.
  void tracked.promise.catch(() => undefined);
  return tracked;
}

async function blockedPid(blockers: readonly number[], relation: 'pages' | 'spaces'): Promise<number | undefined> {
  const result = await query<{ pid: number }>(
    `SELECT a.pid FROM pg_stat_activity a
      WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
        AND NOT (a.pid = ANY($1::int[]))
        AND a.state = 'active' AND a.wait_event_type = 'Lock'
        AND pg_blocking_pids(a.pid) && $1::int[]
        AND a.query ILIKE $2
      ORDER BY a.pid LIMIT 1`,
    [blockers, relation === 'pages' ? '%UPDATE pages%' : '%spaces%'],
  );
  return result.rows[0]?.pid;
}

async function requiredWaiter(tracked: TrackedResponse, blockers: readonly number[], relation: 'pages' | 'spaces'): Promise<number> {
  let pid: number | undefined;
  const reached = await waitForDatabaseCondition(async () => {
    if (tracked.failure) throw tracked.failure.error;
    if (tracked.response) throw new Error(`[setup, not red] request settled before its ${relation} fixture barrier: ${tracked.response.statusCode} ${tracked.response.payload}`);
    pid = await blockedPid(blockers, relation);
    return pid !== undefined;
  });
  if (!reached || pid === undefined) throw new Error(`[setup, not red] no positively observed ${relation} fixture waiter`);
  tracked.pid = pid;
  return pid;
}

async function settledOrBlocked(tracked: TrackedResponse, blockers: readonly number[]): Promise<'settled' | 'blocked'> {
  let classification: 'settled' | 'blocked' | undefined;
  const classified = await waitForDatabaseCondition(async () => {
    if (tracked.failure) throw tracked.failure.error;
    if (tracked.response) { classification = 'settled'; return true; }
    const pid = await blockedPid(blockers, 'spaces');
    if (pid === undefined) return false;
    tracked.pid = pid;
    classification = 'blocked';
    return true;
  });
  if (!classified || classification === undefined) {
    throw new Error('[setup, not red] request neither settled nor had a positively observed space-lock waiter');
  }
  return classification;
}

async function race(order: 'restore-first' | 'delete-first', kind: 'original' | 'target' | 'retained', cancelRequest?: 'restore' | 'delete'): Promise<void> {
  const tree = await seedTree();
  if (kind === 'retained') await query('UPDATE pages SET space_key = $2 WHERE id = $1', [tree.child, RETAINED]);
  await stampTogether(tree.ids);
  if (kind !== 'original') await removeSpace();
  const contested = kind === 'original' ? ORIGINAL : kind === 'target' ? TARGET : RETAINED;
  const body = kind === 'original' ? undefined : { targetSpaceKey: TARGET };
  await seedPageCaches();
  const before = await effects(tree.ids);
  const holder: PoolClient = await getPool().connect();
  const requests: TrackedResponse[] = [];
  let held = false;
  let released = false;
  let holderPid: number | undefined;
  let cleanupPromise: Promise<void> | undefined;

  async function releaseHolder(commit: boolean): Promise<void> {
    if (released) return;
    let failure: Error | undefined;
    try {
      if (held) await holder.query(commit ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      held = false;
      released = true;
      holder.release(failure);
    }
    if (failure) throw failure;
  }

  function cleanup(): Promise<void> {
    cleanupPromise ??= (async () => {
      let releaseFailure: unknown;
      try { await releaseHolder(false); } catch (error) { releaseFailure = error; }
      const settled = await waitForDatabaseCondition(async () => requests.every((request) => request.response !== undefined || request.failure !== undefined));
      if (!settled) {
        const ownedPids = requests.filter((request) => !request.response && !request.failure && request.pid !== undefined).map((request) => request.pid!);
        if (ownedPids.length > 0) {
          await query(
            `SELECT pg_cancel_backend(pid) FROM pg_stat_activity
              WHERE datname = current_database() AND pid = ANY($1::int[])
                AND pid <> pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock'`,
            [ownedPids],
          );
        }
      }
      const outcomes = await Promise.allSettled(requests.map((request) => request.promise));
      const capturedPids = [
        ...(holderPid === undefined ? [] : [holderPid]),
        ...requests.flatMap((request) => request.pid === undefined ? [] : [request.pid]),
      ];
      const idleTransactions = await query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND pid = ANY($1::int[])
            AND state IN ('idle in transaction', 'idle in transaction (aborted)')`,
        [capturedPids],
      );
      if (idleTransactions.rows.length > 0) {
        throw new Error('[cleanup, not regression red] Captured case client remains idle in transaction');
      }
      if (releaseFailure) throw releaseFailure;
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
    })();
    return cleanupPromise;
  }
  activeRaceCleanup = cleanup;

  try {
    await holder.query('BEGIN');
    held = true;
    holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    let restoreRequest: TrackedResponse;
    let deleteRequest: TrackedResponse;
    let classification: 'settled' | 'blocked';
    if (order === 'restore-first') {
      await holder.query('SELECT id FROM pages WHERE id = $1 FOR UPDATE', [tree.root]);
      restoreRequest = track(restore(tree.root, body));
      requests.push(restoreRequest);
      const restorePid = await requiredWaiter(restoreRequest, [holderPid], 'pages');
      deleteRequest = track(deleteSpace(contested));
      requests.push(deleteRequest);
      classification = await settledOrBlocked(deleteRequest, [restorePid]);
    } else {
      await holder.query('SELECT space_key FROM spaces WHERE space_key = $1 FOR UPDATE', [contested]);
      deleteRequest = track(deleteSpace(contested));
      requests.push(deleteRequest);
      const deletePid = await requiredWaiter(deleteRequest, [holderPid], 'spaces');
      restoreRequest = track(restore(tree.root, body));
      requests.push(restoreRequest);
      classification = await settledOrBlocked(restoreRequest, [holderPid, deletePid]);
    }

    if (cancelRequest) {
      // Post-delta rollback controls only; never credited as original-red evidence.
      expect(classification).toBe('blocked');
      const canceledRequest = cancelRequest === 'restore' ? restoreRequest : deleteRequest;
      if (canceledRequest.pid === undefined) throw new Error('[setup, not red] missing owned cancellation PID');
      const canceled = await query<{ canceled: boolean }>(
        `SELECT pg_cancel_backend(pid) AS canceled FROM pg_stat_activity
          WHERE datname = current_database() AND pid = $1 AND pid <> pg_backend_pid()
            AND state = 'active' AND wait_event_type = 'Lock'`,
        [canceledRequest.pid],
      );
      expect(canceled.rows).toEqual([{ canceled: true }]);
      const canceledResponse = await canceledRequest.promise;
      expect(canceledResponse.statusCode).toBeGreaterThanOrEqual(400);
      if (cancelRequest === 'restore') {
        // H still holds the page barrier: R's rollback alone must release its space SHARE.
        const deleted = await deleteRequest.promise;
        expect(deleted.statusCode, deleted.payload).toBe(200);
        expect(await effects(tree.ids)).toEqual(before);
        expect((await query('SELECT 1 FROM spaces WHERE space_key = $1', [contested])).rows).toEqual([]);
      } else {
        expect(await effects(tree.ids)).toEqual(before);
        await releaseHolder(true);
        const restored = await restoreRequest.promise;
        expect(restored.statusCode, restored.payload).toBe(200);
        expect(restored.json()).toMatchObject({ restored: true });
        expect(await pages(tree.ids)).toEqual(before.pages.map((page) => restoredState(page)));
        expect((await query('SELECT 1 FROM spaces WHERE space_key = $1', [contested])).rows).toHaveLength(1);
        const restoredAudits = await audits();
        expect(restoredAudits).toHaveLength(1);
        expect(restoredAudits[0]?.metadata).toMatchObject({ restoredCount: 3 });
        expect(restoredAudits[0]?.metadata).not.toHaveProperty('targetSpaceKey');
        expect(restoredAudits[0]?.metadata).not.toHaveProperty('missingSpaceKey');
      }
      expect(await noLiveMissingSpace()).toEqual([]);
      return;
    }

    await releaseHolder(true);
    const [restored, deleted] = await Promise.all([restoreRequest.promise, deleteRequest.promise]);
    if (order === 'restore-first') {
      // On original code DELETE is positively classified as settled200, not a
      // timeout or an absent future FOR SHARE predicate. This status is the red.
      expect(deleted.statusCode, `DELETE was ${classification} before the page barrier released: ${deleted.payload}`).toBe(409);
      expect(restored.statusCode, restored.payload).toBe(200);
      expect(restored.json()).toMatchObject({ restored: true });
      expect(deleted.payload).toContain('Space still has pages. Delete or move all pages first.');
      expect(classification).toBe('blocked');
      expect((await query('SELECT 1 FROM spaces WHERE space_key = $1', [contested])).rows).toHaveLength(1);
      const expected = before.pages.map((page) => restoredState(page, kind !== 'original' && page.space_key === ORIGINAL ? TARGET : page.space_key));
      expect(await pages(tree.ids)).toEqual(expected);
      expect(await noLiveMissingSpace()).toEqual([]);
      expect((await audits())[0]?.metadata).toMatchObject({ restoredCount: 3 });
    } else {
      // Original restore is positively classified as settled200 while DELETE
      // waits on the fixture. The final real response, not a timeout, is red.
      expect(restored.statusCode, `restore was ${classification} before the space barrier released: ${restored.payload}`).toBe(409);
      expect(deleted.statusCode, deleted.payload).toBe(200);
      expect(classification).toBe('blocked');
      expect(restored.json()).toEqual(kind === 'target' ? invalidTarget : kind === 'original' ? missingRoot(ORIGINAL) : missingRetained(RETAINED));
      expect(await effects(tree.ids)).toEqual(before);
      expect((await query('SELECT 1 FROM spaces WHERE space_key = $1', [contested])).rows).toEqual([]);
      expect(await noLiveMissingSpace()).toEqual([]);
    }
  } finally {
    await cleanup();
    activeRaceCleanup = undefined;
  }
}

describe('#1742 restore space routes — real PostgreSQL and Redis', () => {
  beforeAll(async () => {
    expect(await isDbAvailable(), 'real PostgreSQL is required; unavailable is not a regression red').toBe(true);
    expect(await isRedisAvailable(), 'real Redis is required; unavailable is not a regression red').toBe(true);
    await setupTestDb();
    redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false, connectTimeout: 1_000 } }) as RedisClientType;
    await redis.connect();
    setRedisClient(redis);
    app = await buildKnowledgeTestApp(() => currentUserId, async (instance) => {
      instance.redis = redis;
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
      await instance.register(localSpacesRoutes, { prefix: '/api' });
    });
  });

  afterEach(async () => {
    if (activeRaceCleanup) await activeRaceCleanup();
    activeRaceCleanup = undefined;
  });

  afterAll(async () => {
    if (activeRaceCleanup) await activeRaceCleanup();
    if (app) await app.close();
    if (redis?.isOpen) await redis.quit();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await redis.flushDb();
    userA = await insertUser(`restore_owner_${randomUUID()}`);
    userB = await insertUser(`restore_other_${randomUUID()}`);
    currentUserId = userA;
    for (const key of [ORIGINAL, TARGET, RETAINED, PARENT]) await insertLocalSpace(key, key === TARGET ? userB : userA);
    await query(`INSERT INTO spaces (space_key, space_name, source, last_synced) VALUES ($1, $1, 'confluence', NOW())`, [REMOTE]);
  });

  describe('#1742 REGRESSION existing restore consumers', () => {
    it('[R01] refuses the actual create-trash-delete-space-bodyless-restore sequence', async () => {
      const key = 'API_ORIGINAL';
      const createdSpace = await app.inject({ method: 'POST', url: '/api/spaces/local', payload: { key, name: 'API original space' } });
      expect(createdSpace.statusCode, createdSpace.payload).toBe(200);
      const created = await app.inject({ method: 'POST', url: '/api/pages', payload: { title: 'Actual restore sequence', bodyHtml: '<p>Restore sequence</p>', source: 'standalone', spaceKey: key, visibility: 'private' } });
      expect(created.statusCode, created.payload).toBe(200);
      const root = created.json<{ id: number }>().id;
      const trashed = await app.inject({ method: 'DELETE', url: `/api/pages/${root}` });
      expect(trashed.statusCode, trashed.payload).toBe(200);
      await removeSpace(key);
      const untouched = await insertStandalonePage('Untouched live page', 'private', userB, RETAINED);
      await seedPageCaches();
      const before = await effects([root, untouched]);
      const response = await restore(root);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(missingRoot(key));
      expect(await effects([root, untouched])).toEqual(before);
    });

    it('[R03] restores every same-batch missing-key row into the explicit existing local target', async () => {
      const tree = await seedTree();
      await trashTree(tree);
      await removeSpace();
      const before = await pages(tree.ids);
      const response = await restore(tree.root, { targetSpaceKey: TARGET });
      expect(response.statusCode, response.payload).toBe(200);
      expect((await pages(tree.ids)).map((page) => page.space_key)).toEqual([TARGET, TARGET, TARGET]);
      expect(await pages(tree.ids)).toEqual(before.map((page) => restoredState(page, TARGET)));
      const targetTree = await app.inject({ method: 'GET', url: `/api/spaces/${TARGET}/tree` });
      expect(targetTree.statusCode, targetTree.payload).toBe(200);
      expect(targetTree.json<{ items: Array<{ id: number }> }>().items.map((page) => page.id).sort((a, b) => a - b)).toEqual([...tree.ids].sort((a, b) => a - b));
      expect(await noLiveMissingSpace()).toEqual([]);
      expect((await audits())[0]?.metadata).toMatchObject({ restoredCount: 3, targetSpaceKey: TARGET, missingSpaceKey: ORIGINAL });
    });

    it('[R04] rewrites only the missing key across an exact mixed batch and preserves excluded rows', async () => {
      const root = await insertStandalonePage('Mixed root', 'private', userA, ORIGINAL);
      const child = await insertStandalonePage('Same missing key', 'private', userA, ORIGINAL, { parentId: String(root) });
      const retained = await insertStandalonePage('Retained space', 'private', userA, RETAINED, { parentId: String(root) });
      const noSpace = await insertStandalonePage('No-space member', 'private', userA, ORIGINAL, { parentId: String(root) });
      await query('UPDATE pages SET space_key = NULL WHERE id = $1', [noSpace]);
      const virtualRoot = await insertStandalonePage('Virtual member', 'private', userA, '__local__', { parentId: String(root) });
      const older = await insertStandalonePage('Older trashed bridge', 'private', userA, ORIGINAL, { parentId: String(root) });
      await query('UPDATE pages SET deleted_at = $2::timestamptz WHERE id = $1', [older, OLDER_STAMP]);
      const olderGrandchild = await insertStandalonePage('Beyond older bridge', 'private', userA, ORIGINAL, { parentId: String(older) });
      const liveBridge = await insertStandalonePage('Live bridge', 'private', userA, RETAINED, { parentId: String(root) });
      const liveGrandchild = await insertStandalonePage('Beyond live bridge', 'private', userA, ORIGINAL, { parentId: String(liveBridge) });
      const foreign = await insertStandalonePage('FOREIGN PRIVATE MEMBER', 'private', userB, ORIGINAL, { parentId: String(root) });
      const synced = await insertConfluencePage('mixed-source-member', 'SYNCED MEMBER', ORIGINAL, { parentId: String(root) });
      const unrelated = await insertStandalonePage('Unrelated live page', 'private', userA, RETAINED);
      const members = [root, child, retained, noSpace, virtualRoot, olderGrandchild, liveGrandchild];
      const excluded = [older, liveBridge, foreign, synced, unrelated];
      await stampTogether([...members, foreign, synced]);
      await removeSpace();
      const before = await pages([...members, ...excluded]);
      const response = await restore(root, { targetSpaceKey: TARGET });
      expect(response.statusCode, response.payload).toBe(200);
      expect((await pages([root]))[0]?.space_key).toBe(TARGET);
      expect(await pages([...members, ...excluded])).toEqual(before.map((page) => members.includes(page.id) ? restoredState(page, page.space_key === ORIGINAL ? TARGET : page.space_key) : page));
      expect((await audits())[0]?.metadata).toMatchObject({ restoredCount: members.length, targetSpaceKey: TARGET, missingSpaceKey: ORIGINAL });
      expect(response.payload).not.toContain('FOREIGN PRIVATE MEMBER');
    });

    it('[R05] stores null only after an explicit no-space target choice', async () => {
      const root = await seededTrash();
      await removeSpace();
      const before = (await pages([root]))[0]!;
      const response = await restore(root, { targetSpaceKey: '__local__' });
      expect(response.statusCode, response.payload).toBe(200);
      expect((await pages([root]))[0]?.space_key).toBeNull();
      expect(await pages([root])).toEqual([restoredState(before, null)]);
      const tree = await app.inject({ method: 'GET', url: '/api/pages/tree' });
      expect(tree.statusCode, tree.payload).toBe(200);
      expect(tree.json<{ items: Array<{ id: string }> }>().items.some((page) => page.id === String(root))).toBe(true);
      expect((await query('SELECT 1 FROM spaces WHERE space_key = $1', ['__local__'])).rows).toEqual([]);
      expect((await audits())[0]?.metadata).toMatchObject({ targetSpaceKey: '__local__', missingSpaceKey: ORIGINAL });
    });

    it('[R06] refuses an assigned readable Confluence destination without disclosing target details', async () => {
      await grantRemoteRead();
      const readable = await app.inject({ method: 'GET', url: `/api/spaces/${REMOTE}/tree` });
      expect(readable.statusCode, readable.payload).toBe(200);
      const root = await seededTrash();
      await removeSpace();
      await seedPageCaches();
      const before = await effects([root]);
      const response = await restore(root, { targetSpaceKey: REMOTE });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(invalidTarget);
      expect(await effects([root])).toEqual(before);
    });

    it('[R07] refuses unknown raw targets instead of case-folding or trimming an existing local key', async () => {
      const root = await seededTrash();
      await removeSpace();
      await seedPageCaches();
      const before = await effects([root]);
      const response = await restore(root, { targetSpaceKey: TARGET.toLowerCase() });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(invalidTarget);
      expect(await effects([root])).toEqual(before);
      const paddedTarget = await restore(root, { targetSpaceKey: ` ${TARGET} ` });
      expect(paddedTarget.statusCode).toBe(409);
      expect(paddedTarget.json()).toEqual(invalidTarget);
      expect(await effects([root])).toEqual(before);
    });

    it('[R08] refuses the deleted original key as its own nonexistent target', async () => {
      const root = await seededTrash();
      await removeSpace();
      await seedPageCaches();
      const before = await effects([root]);
      const response = await restore(root, { targetSpaceKey: ORIGINAL });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(invalidTarget);
      expect(await effects([root])).toEqual(before);
      expect((await query('SELECT 1 FROM spaces WHERE space_key = $1', [ORIGINAL])).rows).toEqual([]);
    });

    it.each([
      { name: 'R09', stored: ORIGINAL, target: TARGET },
      { name: 'R10', stored: ORIGINAL, target: '__local__' },
      { name: 'R11', stored: null, target: TARGET },
      { name: 'R12', stored: '__local__', target: TARGET },
    ])('[$name] refuses a different target for a present or valid virtual root', async ({ stored, target }) => {
      const root = await seededTrash(stored);
      await seedPageCaches();
      const before = await effects([root]);
      const response = await restore(root, { targetSpaceKey: target });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(inapplicableTarget);
      expect(await effects([root])).toEqual(before);
    });

    it('[R13] refuses a retained missing child key while the root space still exists', async () => {
      const tree = await seedTree();
      await query('UPDATE pages SET space_key = $2 WHERE id = $1', [tree.child, 'SECONDARY_GONE']);
      await stampTogether(tree.ids);
      await seedPageCaches();
      const before = await effects(tree.ids);
      const response = await restore(tree.root);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(missingRetained('SECONDARY_GONE'));
      expect(await effects(tree.ids)).toEqual(before);
    });

    it('[R14] refuses the whole batch when a valid root target cannot repair another missing key', async () => {
      const tree = await seedTree();
      await query('UPDATE pages SET space_key = $2 WHERE id = $1', [tree.child, 'SECONDARY_GONE']);
      await stampTogether(tree.ids);
      await removeSpace();
      await seedPageCaches();
      const before = await effects(tree.ids);
      const response = await restore(tree.root, { targetSpaceKey: TARGET });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(missingRetained('SECONDARY_GONE'));
      expect(await effects(tree.ids)).toEqual(before);
    });

    it.each([
      { name: 'R15', remoteParent: false, target: TARGET },
      { name: 'R16', remoteParent: true, target: TARGET },
      { name: 'R17', remoteParent: false, target: '__local__' },
    ])('[$name] detaches only the rehomed root from a distinct-space resolved live parent', async ({ remoteParent, target }) => {
      const contentId = '9007199254740993';
      const parent = remoteParent
        ? await insertConfluencePage(contentId, 'Hidden live remote parent', REMOTE)
        : await insertStandalonePage('Live other-space parent', 'private', userA, PARENT);
      const root = await insertStandalonePage('Linked root', 'private', userA, ORIGINAL, { parentId: remoteParent ? contentId : String(parent) });
      const child = await insertStandalonePage('Linked child', 'private', userA, ORIGINAL, { parentId: String(root) });
      await query('UPDATE pages SET path = $2, depth = $3 WHERE id = $1', [root, `/${parent}/${root}`, 1]);
      await query('UPDATE pages SET path = $2, depth = $3 WHERE id = $1', [child, `/${parent}/${root}/${child}`, 2]);
      await stampTogether([root, child]);
      await removeSpace();
      const before = await pages([parent, root, child]);
      const response = await restore(root, { targetSpaceKey: target });
      expect(response.statusCode, response.payload).toBe(200);
      expect((await pages([root]))[0]?.parent_id).toBeNull();
      expect(await pages([parent, root, child])).toEqual(before.map((page) => page.id === parent ? page : restoredState(page, target === '__local__' ? null : target, page.id === root ? null : page.parent_id)));
      expect(response.payload).not.toContain('Hidden live remote parent');
    });

    it('[R18] records actual rehome target and missing key in the single persisted restore audit', async () => {
      const root = await seededTrash();
      await removeSpace();
      const rawId = `000${root}`;
      const response = await restore(rawId, { targetSpaceKey: TARGET });
      expect(response.statusCode, response.payload).toBe(200);
      const rows = await audits();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata).toMatchObject({ source: 'standalone', title: 'Trashed restore candidate', restoredCount: 1, targetSpaceKey: TARGET, missingSpaceKey: ORIGINAL });
      expect(rows[0]?.resource_id).toBe(rawId);
    });

    it.each([
      { name: 'R19', body: null },
      { name: 'R20', body: { targetSpaceKey: null } },
      { name: 'R21', body: { targetSpaceKey: 7 } },
      { name: 'R22', body: { targetSpaceKey: '' } },
      { name: 'R23a', body: [] },
      { name: 'R23b', body: 7 },
      { name: 'R23c', body: 'x' },
    ])('[$name] rejects a malformed optional restore body before mutation', async ({ body }) => {
      const root = await seededTrash();
      await seedPageCaches();
      const before = await effects([root]);
      const response = await restore(root, body);
      expect(response.statusCode).toBe(400);
      expect(await effects([root])).toEqual(before);
    });

    it.each([
      { name: 'R24', rawId: '3000000000' },
      { name: 'R25', rawId: 'abc' },
      { name: 'R26', rawId: '1.5' },
      { name: 'R27', rawId: '0' },
    ])('[$name] validates the PK-only restore path without a textual-identity fallback', async ({ rawId }) => {
      const decoy = await insertConfluencePage(rawId, 'Untouched textual decoy', REMOTE, { deletedAt: new Date() });
      await seedPageCaches();
      const before = await effects([decoy]);
      const response = await restore(rawId);
      expect(response.statusCode).toBe(400);
      expect(await effects([decoy])).toEqual(before);
    });

    it('[R28] restore-first original-space deletion waits and loses with the live-page conflict', async () => {
      await race('restore-first', 'original');
    });
    it('[R29] delete-first original-space restore observes deletion and refuses without effect', async () => {
      await race('delete-first', 'original');
    });
    it('[R30] restore-first chosen-target deletion waits and loses with the live-page conflict', async () => {
      await race('restore-first', 'target');
    });
    it('[R31] delete-first chosen target makes the restore refuse that invalid destination', async () => {
      await race('delete-first', 'target');
    });
    it('[R32] restore-first deletion of another retained batch space waits and loses', async () => {
      await race('restore-first', 'retained');
    });
    it('[R33] delete-first retained batch space makes the entire targeted restore refuse', async () => {
      await race('delete-first', 'retained');
    });
  });

  describe('#1742 FEATURE post-delta real-PG controls', () => {
    it('[A01a] reports the current missing root after another client rehomes, retrashes and deletes its new space', async () => {
      const tree = await seedTree();
      await trashTree(tree);
      await removeSpace();
      const first = await restore(tree.root);
      expect(first.statusCode).toBe(409);
      expect(first.json()).toEqual(missingRoot(ORIGINAL));
      const otherClient = await buildAdditionalOwnerClient();
      try {
        await rehomeAndRetrash(otherClient, tree);
        const deleted = await otherClient.inject({ method: 'DELETE', url: `/api/spaces/local/${RETAINED}` });
        expect(deleted.statusCode, deleted.payload).toBe(200);
        await seedPageCaches();
        const before = await effects(tree.ids);
        const current = await restore(tree.root);
        expect(current.statusCode).toBe(409);
        expect(current.json()).toEqual(missingRoot(RETAINED));
        expect(await effects(tree.ids)).toEqual(before);
      } finally {
        await otherClient.close();
      }
    });

    it('[A01b] reports a retained missing key as secondary even when it equals a historical root refusal key', async () => {
      const tree = await seedTree();
      await trashTree(tree);
      await removeSpace();
      const first = await restore(tree.root);
      expect(first.statusCode).toBe(409);
      expect(first.json()).toEqual(missingRoot(ORIGINAL));
      const otherClient = await buildAdditionalOwnerClient();
      try {
        await rehomeAndRetrash(otherClient, tree);
        await fixtureMissingOwnedChildSpace(tree);
        await seedPageCaches();
        const before = await effects(tree.ids);
        const current = await restore(tree.root);
        expect(current.statusCode).toBe(409);
        expect(current.json()).toEqual(missingRetained(ORIGINAL));
        expect(await effects(tree.ids)).toEqual(before);
      } finally {
        await otherClient.close();
      }
    });

    it('[A01c] refuses an old selected target remedy honestly when the same historical key is now secondary', async () => {
      const tree = await seedTree();
      await trashTree(tree);
      await removeSpace();
      const first = await restore(tree.root);
      expect(first.statusCode).toBe(409);
      expect(first.json()).toEqual(missingRoot(ORIGINAL));
      const otherClient = await buildAdditionalOwnerClient();
      try {
        await rehomeAndRetrash(otherClient, tree);
        await fixtureMissingOwnedChildSpace(tree);
        const deleted = await otherClient.inject({ method: 'DELETE', url: `/api/spaces/local/${RETAINED}` });
        expect(deleted.statusCode, deleted.payload).toBe(200);
        await seedPageCaches();
        const before = await effects(tree.ids);
        const current = await restore(tree.root, { targetSpaceKey: TARGET });
        expect(current.statusCode).toBe(409);
        expect(current.json()).toEqual(missingRetained(ORIGINAL));
        expect(await effects(tree.ids)).toEqual(before);
      } finally {
        await otherClient.close();
      }
    });

    it.each([
      'same local live parent',
      'null live parent',
      'sentinel live parent',
      'unresolved text parent',
      'foreign trashed parent',
      'Confluence trashed parent',
    ] as const)('[A02] actual rehome preserves an eligible non-detaching parent: %s', async (kind) => {
      let parentId: string;
      let parent: number | undefined;
      let targetSpaceKey: string = TARGET;
      if (kind === 'unresolved text parent') {
        parentId = '9007199254740993';
      } else if (kind === 'Confluence trashed parent') {
        parentId = '9007199254740993';
        parent = await insertConfluencePage(parentId, 'HIDDEN REMOTE PARENT', REMOTE, { deletedAt: new Date() });
      } else {
        const parentSpace = kind === 'same local live parent' ? TARGET : kind === 'sentinel live parent' ? '__local__' : PARENT;
        parent = await insertStandalonePage('HIDDEN PARENT', 'private', kind === 'foreign trashed parent' ? userB : userA, parentSpace);
        if (kind === 'null live parent') await query('UPDATE pages SET space_key = NULL WHERE id = $1', [parent]);
        if (kind === 'foreign trashed parent') await stampTogether([parent]);
        if (kind === 'null live parent' || kind === 'sentinel live parent') targetSpaceKey = '__local__';
        parentId = String(parent);
      }
      const root = await insertStandalonePage('Actual rehome preserves its parent', 'private', userA, ORIGINAL, { parentId });
      const child = await insertStandalonePage('Same-batch child', 'private', userA, ORIGINAL, { parentId: String(root) });
      const rootPath = parent === undefined ? `/${root}` : `/${parent}/${root}`;
      const rootDepth = parent === undefined ? 0 : 1;
      await query('UPDATE pages SET path = $2, depth = $3 WHERE id = $1', [root, rootPath, rootDepth]);
      await query('UPDATE pages SET path = $2, depth = $3 WHERE id = $1', [child, `${rootPath}/${child}`, rootDepth + 1]);
      await stampTogether([root, child]);
      await removeSpace();
      const before = await pages([root, child]);
      const parentBefore = parent === undefined ? [] : await pages([parent]);
      const response = await restore(root, { targetSpaceKey });
      expect(response.statusCode, response.payload).toBe(200);
      expect(response.json()).toMatchObject({ restored: true });
      const storedTarget = targetSpaceKey === '__local__' ? null : targetSpaceKey;
      expect(await pages([root, child])).toEqual(before.map((page) => restoredState(page, storedTarget)));
      if (parent !== undefined) expect(await pages([parent])).toEqual(parentBefore);
      expect(response.payload).not.toContain('HIDDEN');
      expect(await noLiveMissingSpace()).toEqual([]);
      expect((await audits())[0]?.metadata).toMatchObject({ targetSpaceKey, missingSpaceKey: ORIGINAL, restoredCount: 2 });
    });

    it('[A03a] canceling the paused restore rolls back its batch and releases the space for deletion', async () => {
      await race('restore-first', 'original', 'restore');
    });

    it('[A03b] canceling queued deletion leaves the space available for the waiting restore', async () => {
      await race('delete-first', 'original', 'delete');
    });
  });

  describe('#1742 CONTROL original behavior', () => {
    it('[P01a] deletion counts all live rows but leaves trash alone once the container is empty', async () => {
      const own = await insertStandalonePage('Live own row', 'private', userA, ORIGINAL);
      const synced = await insertConfluencePage('delete-count-remote', 'Live remote row', ORIGINAL);
      expect((await deleteSpace(ORIGINAL)).statusCode).toBe(409);
      await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [own]);
      expect((await deleteSpace(ORIGINAL)).statusCode).toBe(409);
      await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [synced]);
      const before = await pages([own, synced]);
      await removeSpace();
      expect(await pages([own, synced])).toEqual(before);
      expect(await audits()).toEqual([]);
    });

    it('[P01b] local deletion keeps missing and nonlocal refusals and has no container-owner restriction', async () => {
      await removeSpace(TARGET);
      expect((await deleteSpace('ABSENT_SPACE')).statusCode).toBe(404);
      const response = await deleteSpace(REMOTE);
      expect(response.statusCode).toBe(400);
      expect(response.payload).toContain('Cannot delete a Confluence-synced space');
      expect((await query('SELECT source FROM spaces WHERE space_key = $1', [REMOTE])).rows).toEqual([{ source: 'confluence' }]);
      expect(await audits()).toEqual([]);
    });

    it.each([
      { label: 'bodyless', body: undefined },
      { label: 'empty-object', body: {} },
      { label: 'same-key target', body: { targetSpaceKey: ORIGINAL } },
    ])('[P02] ordinary existing-space restore stays unchanged: $label', async ({ body }) => {
      const root = await seededTrash();
      const before = (await pages([root]))[0]!;
      const response = await restore(root, body);
      expect(response.statusCode, response.payload).toBe(200);
      expect(response.json()).toEqual({ id: root, title: before.title, restored: true });
      expect(await pages([root])).toEqual([restoredState(before)]);
      const rows = await audits();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata).toEqual({ source: 'standalone', title: before.title, restoredCount: 1 });
    });

    it.each([
      { label: 'null bodyless', stored: null, body: undefined },
      { label: 'null explicit virtual choice', stored: null, body: { targetSpaceKey: '__local__' } },
      { label: 'legacy sentinel bodyless', stored: '__local__', body: undefined },
      { label: 'legacy sentinel same choice', stored: '__local__', body: { targetSpaceKey: '__local__' } },
    ])('[P03] treats $label as a valid ordinary virtual root', async ({ stored, body }) => {
      const root = await seededTrash(stored);
      const before = (await pages([root]))[0]!;
      const response = await restore(root, body);
      expect(response.statusCode, response.payload).toBe(200);
      expect(await pages([root])).toEqual([restoredState(before)]);
      expect((await audits())[0]?.metadata).toEqual({ source: 'standalone', title: before.title, restoredCount: 1 });
    });

    it.each([
      { label: 'bodyless', body: undefined },
      { label: 'same stored key', body: { targetSpaceKey: REMOTE } },
    ])('[P04] preserves standalone restoration in an existing Confluence container: $label', async ({ body }) => {
      const root = await seededTrash(REMOTE);
      const before = (await pages([root]))[0]!;
      const response = await restore(root, body);
      expect(response.statusCode, response.payload).toBe(200);
      expect(await pages([root])).toEqual([restoredState(before)]);
      expect((await audits())[0]?.metadata).not.toHaveProperty('targetSpaceKey');
      expect((await audits())[0]?.metadata).not.toHaveProperty('missingSpaceKey');
    });

    it.each(['private', 'shared'] as const)('[P05 owner] refuses another owner’s %s row before space/target details', async (visibility) => {
      const root = await insertStandalonePage('FOREIGN SECRET RESTORE', visibility, userB, 'FOREIGN_GONE');
      await stampTogether([root]);
      await seedPageCaches();
      const before = await effects([root]);
      for (const body of [undefined, { targetSpaceKey: TARGET }]) {
        const response = await restore(root, body);
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ reason: 'not_authorized' });
        expect(response.payload).not.toContain('FOREIGN_GONE');
        expect(response.payload).not.toContain('FOREIGN SECRET RESTORE');
        expect(response.json()).not.toHaveProperty('canChooseTarget');
        expect(await effects([root])).toEqual(before);
      }
    });

    it('[P05 source] refuses a Confluence-sourced root before target inspection', async () => {
      const root = await insertConfluencePage('restore-source-guard', 'Synced root', 'GONE_REMOTE', { deletedAt: new Date() });
      await seedPageCaches();
      const before = await effects([root]);
      const response = await restore(root, { targetSpaceKey: TARGET });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ reason: 'restore_source_invalid' });
      expect(response.json()).not.toHaveProperty('canChooseTarget');
      expect(response.payload).not.toContain('GONE_REMOTE');
      expect(await effects([root])).toEqual(before);
    });

    it('[P05 missing] keeps the ordinary valid-but-missing PK404 without effects', async () => {
      await seedPageCaches();
      const before = await effects([]);
      const response = await restore(MAX_PK, { targetSpaceKey: TARGET });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ reason: 'page_not_found' });
      expect(await effects([])).toEqual(before);
    });

    it.each([ORIGINAL, 'ALREADY_LIVE_ORPHAN'])('[P06] already-live %s is an idempotent no-op, never a repair', async (key) => {
      const root = await insertStandalonePage('Already live', 'private', userA, key);
      await seedPageCaches();
      const before = await effects([root]);
      const response = await restore(root, { targetSpaceKey: TARGET });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id: root, title: 'Already live', restored: false });
      expect(await effects([root])).toEqual(before);
    });

    it('[P07a] keeps the actionable direct-owner ancestor refusal and ordinary recovery', async () => {
      const parent = await insertStandalonePage('Owned blocker', 'private', userA, PARENT);
      const root = await insertStandalonePage('Owned child', 'private', userA, ORIGINAL, { parentId: String(parent) });
      await stampTogether([parent, root]);
      await seedPageCaches();
      const before = await effects([parent, root]);
      const refusal = await restore(root, { targetSpaceKey: TARGET });
      expect(refusal.statusCode).toBe(409);
      expect(refusal.json()).toMatchObject({ reason: 'restore_ancestor_trashed', message: 'Restore "Owned blocker" first' });
      expect(await effects([parent, root])).toEqual(before);
      expect((await restore(parent)).statusCode).toBe(200);
      expect((await restore(root)).statusCode).toBe(200);
      expect((await pages([parent, root])).every((page) => page.deleted_at === null)).toBe(true);
    });

    it('[P07b] ancestor refusal still wins when the root space is missing and a target was supplied', async () => {
      const parent = await insertStandalonePage('Owned missing-space blocker', 'private', userA, PARENT);
      const root = await insertStandalonePage('Missing-space child', 'private', userA, ORIGINAL, { parentId: String(parent) });
      await stampTogether([parent, root]);
      await removeSpace();
      await seedPageCaches();
      const before = await effects([parent, root]);
      const response = await restore(root, { targetSpaceKey: TARGET });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ reason: 'restore_ancestor_trashed', message: 'Restore "Owned missing-space blocker" first' });
      expect(response.json()).not.toHaveProperty('canChooseTarget');
      expect(await effects([parent, root])).toEqual(before);
    });

    it('[P08 parent] keeps ambiguous-parent refusal ahead of missing-space rehoming without leaking decoys', async () => {
      const parent = await insertStandalonePage('Owned ambiguous parent', 'private', userA, PARENT);
      const decoy = await insertConfluencePage(String(parent), 'HIDDEN PARENT DECOY', REMOTE, { deletedAt: new Date() });
      const root = await insertStandalonePage('Ambiguous child', 'private', userA, ORIGINAL, { parentId: String(parent) });
      await stampTogether([parent, root]);
      await removeSpace();
      await seedPageCaches();
      const before = await effects([parent, decoy, root]);
      const response = await restore(root, { targetSpaceKey: TARGET });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ reason: 'restore_parent_ambiguous' });
      expect(response.payload).not.toContain('HIDDEN PARENT DECOY');
      expect(response.json()).not.toHaveProperty('canChooseTarget');
      expect(await effects([parent, decoy, root])).toEqual(before);
    });

    it('[P08 subtree] keeps source-key collision refusal ahead of target changes', async () => {
      const root = await insertStandalonePage('Ambiguous root', 'private', userA, ORIGINAL);
      const child = await insertStandalonePage('Ambiguous descendant', 'private', userA, ORIGINAL, { parentId: String(root) });
      const decoy = await insertConfluencePage(String(root), 'HIDDEN SUBTREE DECOY', REMOTE, { deletedAt: new Date() });
      await stampTogether([root, child]);
      await removeSpace();
      await seedPageCaches();
      const before = await effects([root, child, decoy]);
      const response = await restore(root, { targetSpaceKey: TARGET });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ reason: 'subtree_identifier_ambiguous' });
      expect(response.payload).not.toContain('HIDDEN SUBTREE DECOY');
      expect(response.json()).not.toHaveProperty('canChooseTarget');
      expect(await effects([root, child, decoy])).toEqual(before);
    });

    it('[P09 clash] preserves normalized same-owner live Notion refusal before missing-space effects', async () => {
      const root = await seededTrash();
      const live = await insertStandalonePage('Live Notion copy', 'private', userA, RETAINED);
      await query('UPDATE pages SET notion_page_id = $2 WHERE id = $1', [root, 'ABCD-1234']);
      await query('UPDATE pages SET notion_page_id = $2 WHERE id = $1', [live, 'abcd1234']);
      await removeSpace();
      await seedPageCaches();
      const before = await effects([root, live]);
      const response = await restore(root, { targetSpaceKey: TARGET });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ reason: 'restore_import_conflict' });
      expect(response.json()).not.toHaveProperty('canChooseTarget');
      expect(await effects([root, live])).toEqual(before);
    });

    it('[P09 other owner] another owner’s live Notion identity does not block ordinary restoration', async () => {
      const root = await seededTrash();
      const foreign = await insertStandalonePage('Foreign Notion copy', 'private', userB, RETAINED);
      await query('UPDATE pages SET notion_page_id = $2 WHERE id = $1', [root, 'CDEF-5678']);
      await query('UPDATE pages SET notion_page_id = $2 WHERE id = $1', [foreign, 'cdef5678']);
      const before = await pages([root, foreign]);
      const response = await restore(root);
      expect(response.statusCode, response.payload).toBe(200);
      expect(await pages([root, foreign])).toEqual(before.map((page) => page.id === root ? restoredState(page) : page));
    });

    it('[P10 root] preserves frozen-root423 before missing-space target checks', async () => {
      const root = await seededTrash();
      await freezePage(root);
      await removeSpace();
      await seedPageCaches();
      const before = await effects([root]);
      const response = await restore(root, { targetSpaceKey: TARGET });
      expect(response.statusCode).toBe(423);
      expect(response.json()).toMatchObject({ reason: 'page_is_frozen' });
      expect(response.json()).not.toHaveProperty('canChooseTarget');
      expect(await effects([root])).toEqual(before);
    });

    it('[P10 descendant] preserves authorized-frozen-subtree409 without revealing frozen content', async () => {
      const tree = await seedTree();
      await stampTogether(tree.ids);
      await freezePage(tree.child);
      await removeSpace();
      await seedPageCaches();
      const before = await effects(tree.ids);
      const response = await restore(tree.root, { targetSpaceKey: TARGET });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ reason: 'subtree_contains_frozen_page', blockedCount: 1 });
      expect(response.payload).not.toContain('PRIVATE FROZEN RESTORE TITLE');
      expect(response.json()).not.toHaveProperty('canChooseTarget');
      expect(await effects(tree.ids)).toEqual(before);
    });

    it('[P10 parent intent] preserves live-parent pending-write refusal before a target can detach it', async () => {
      const parent = await insertStandalonePage('Pending live parent', 'private', userA, PARENT);
      const root = await insertStandalonePage('Pending-parent child', 'private', userA, ORIGINAL, { parentId: String(parent) });
      await stampTogether([root]);
      const intent = await fixtureIntent(parent, userA, false);
      await removeSpace();
      await seedPageCaches();
      const before = await effects([parent, root]);
      const response = await restore(root, { targetSpaceKey: TARGET });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ reason: 'page_write_busy' });
      expect(await effects([parent, root])).toEqual(before);
      expect((await query('SELECT status FROM page_write_intents WHERE id = $1', [intent.intent_id])).rows).toEqual([{ status: 'pending' }]);
    });

    it('[P10 batch intent] preserves pending batch writes instead of clearing their intents to restore', async () => {
      const tree = await seedTree();
      await stampTogether(tree.ids);
      const intent = await fixtureIntent(tree.child, userA, false);
      await removeSpace();
      await seedPageCaches();
      const before = await effects(tree.ids);
      const response = await restore(tree.root, { targetSpaceKey: TARGET });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ reason: 'page_write_busy' });
      expect(await effects(tree.ids)).toEqual(before);
      expect((await query('SELECT status FROM page_write_intents WHERE id = $1', [intent.intent_id])).rows).toEqual([{ status: 'pending' }]);
    });

    it('[P11] crosses an older trashed intermediate but preserves its exact original microsecond stamp', async () => {
      const tree = await seedTree();
      await query('UPDATE pages SET deleted_at = $2::timestamptz WHERE id = $1', [tree.child, OLDER_STAMP]);
      const deleted = await app.inject({ method: 'DELETE', url: `/api/pages/${tree.root}` });
      expect(deleted.statusCode, deleted.payload).toBe(200);
      const before = await pages(tree.ids);
      const response = await restore(tree.root);
      expect(response.statusCode, response.payload).toBe(200);
      expect(await pages(tree.ids)).toEqual(before.map((page) => page.id === tree.child ? page : restoredState(page)));
      expect((await audits())[0]?.metadata).toMatchObject({ restoredCount: 2 });
    });

    it('[P12 rows] never restores foreign or synced same-stamp rows or lets their missing keys block', async () => {
      const root = await insertStandalonePage('Authorized root', 'private', userA, ORIGINAL);
      const mine = await insertStandalonePage('Authorized child', 'private', userA, ORIGINAL, { parentId: String(root) });
      const foreign = await insertStandalonePage('FOREIGN PRIVATE TRASH', 'private', userB, 'FOREIGN_MISSING', { parentId: String(root) });
      const synced = await insertConfluencePage('excluded-synced-key', 'SYNCED PRIVATE TRASH', 'SYNCED_MISSING', { parentId: String(root) });
      await stampTogether([root, mine, foreign, synced]);
      const before = await pages([root, mine, foreign, synced]);
      const response = await restore(root);
      expect(response.statusCode, response.payload).toBe(200);
      expect(await pages([root, mine, foreign, synced])).toEqual(before.map((page) => page.id === root || page.id === mine ? restoredState(page) : page));
      expect((await audits())[0]?.metadata).toMatchObject({ restoredCount: 2 });
      expect(response.payload).not.toContain('FOREIGN PRIVATE TRASH');
      expect(response.payload).not.toContain('SYNCED PRIVATE TRASH');
    });

    it('[P12 frozen foreign] an excluded frozen foreign row neither blocks nor leaks into restoration', async () => {
      const root = await insertStandalonePage('Authorized root', 'private', userA, ORIGINAL);
      const foreign = await insertStandalonePage('FOREIGN FROZEN TRASH', 'private', userB, 'FOREIGN_MISSING', { parentId: String(root) });
      await stampTogether([root, foreign]);
      await freezePage(foreign, userB);
      const before = await pages([root, foreign]);
      const response = await restore(root);
      expect(response.statusCode, response.payload).toBe(200);
      expect(await pages([root, foreign])).toEqual(before.map((page) => page.id === root ? restoredState(page) : page));
      expect(response.payload).not.toContain('FOREIGN FROZEN TRASH');
      expect((await audits())[0]?.metadata).toMatchObject({ restoredCount: 1 });
    });

    it.each(['same-space live', 'missing text key', 'foreign trashed', 'Confluence trashed', 'live with trashed grandparent'] as const)('[P13] ordinary restore preserves its parent state: %s', async (kind) => {
      let parentId: string;
      if (kind === 'missing text key') {
        parentId = '9007199254740993';
      } else if (kind === 'Confluence trashed') {
        parentId = 'ordinary-remote-parent';
        await insertConfluencePage(parentId, 'Remote hidden ancestor', REMOTE, { deletedAt: new Date() });
      } else if (kind === 'foreign trashed') {
        const parent = await insertStandalonePage('FOREIGN HIDDEN PARENT', 'private', userB, PARENT);
        await stampTogether([parent]);
        parentId = String(parent);
      } else if (kind === 'live with trashed grandparent') {
        const grandparent = await insertStandalonePage('Trashed distant ancestor', 'private', userA, PARENT);
        await stampTogether([grandparent]);
        parentId = String(await insertStandalonePage('Live direct parent', 'private', userA, ORIGINAL, { parentId: String(grandparent) }));
      } else {
        parentId = String(await insertStandalonePage('Live same-space parent', 'private', userA, ORIGINAL));
      }
      const root = await insertStandalonePage('Parent-preservation root', 'private', userA, ORIGINAL, { parentId });
      await stampTogether([root]);
      const before = (await pages([root]))[0]!;
      const response = await restore(root);
      expect(response.statusCode, response.payload).toBe(200);
      expect(await pages([root])).toEqual([restoredState(before)]);
      expect(response.payload).not.toContain('FOREIGN HIDDEN PARENT');
    });

    it.each([false, true])('[P14] restore cache scope follows every returned row, shared child=%s', async (sharedChild) => {
      const tree = await seedTree(ORIGINAL, sharedChild);
      await stampTogether(tree.ids);
      await seedPageCaches();
      const response = await restore(tree.root);
      expect(response.statusCode, response.payload).toBe(200);
      expect(await cacheValues()).toEqual(sharedChild ? [null, null] : [null, userB]);
      expect((await audits())[0]?.metadata).toMatchObject({ restoredCount: 3 });
    });

    it('[P15] preserves padded raw audit identity and canonical idempotence without a second effect', async () => {
      const tree = await seedTree();
      await stampTogether(tree.ids);
      const rawId = `000${tree.root}`;
      const response = await restore(rawId);
      expect(response.statusCode, response.payload).toBe(200);
      expect(response.json()).toMatchObject({ id: tree.root, restored: true });
      expect(await audits()).toEqual([{ resource_id: rawId, metadata: { source: 'standalone', title: 'Restore root', restoredCount: 3 } }]);
      await seedPageCaches();
      const before = await effects(tree.ids);
      const repeated = await restore(tree.root, { targetSpaceKey: TARGET });
      expect(repeated.statusCode, repeated.payload).toBe(200);
      expect(repeated.json()).toMatchObject({ id: tree.root, restored: false });
      expect(await effects(tree.ids)).toEqual(before);
    });

    it('[P16] a valid maximum int4 PK remains a usable restore identity', async () => {
      const temporary = await seededTrash();
      await query('UPDATE pages SET id = $2 WHERE id = $1', [temporary, MAX_PK]);
      const before = (await pages([MAX_PK]))[0]!;
      const response = await restore(String(MAX_PK));
      expect(response.statusCode, response.payload).toBe(200);
      expect(response.json()).toMatchObject({ id: MAX_PK, restored: true });
      expect(await pages([MAX_PK])).toEqual([restoredState(before)]);
    });

    it('[P18] another user’s local container remains available without a Confluence assignment', async () => {
      const root = await seededTrash(TARGET);
      const before = (await pages([root]))[0]!;
      const response = await restore(root, { targetSpaceKey: TARGET });
      expect(response.statusCode, response.payload).toBe(200);
      expect(await pages([root])).toEqual([restoredState(before)]);
      const tree = await app.inject({ method: 'GET', url: `/api/spaces/${TARGET}/tree` });
      expect(tree.statusCode, tree.payload).toBe(200);
      expect(tree.json<{ items: Array<{ id: number }> }>().items.map((page) => page.id)).toEqual([root]);
      expect((await audits())[0]?.metadata).not.toHaveProperty('targetSpaceKey');
    });

    it('[P20 syntax] malformed JSON already fails without changing the trashed row', async () => {
      const root = await seededTrash();
      await seedPageCaches();
      const before = await effects([root]);
      const response = await app.inject({ method: 'POST', url: `/api/pages/${root}/restore`, headers: { 'content-type': 'application/json' }, payload: '{bad-json' });
      expect(response.statusCode).toBe(400);
      expect(await effects([root])).toEqual(before);
    });

    it('[P20 object] unrelated object keys do not turn ordinary restoration into a move', async () => {
      const root = await seededTrash();
      const before = (await pages([root]))[0]!;
      const response = await restore(root, { unrelated: 'not a restore target' });
      expect(response.statusCode, response.payload).toBe(200);
      expect(await pages([root])).toEqual([restoredState(before)]);
    });
  });
});
