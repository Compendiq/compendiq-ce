import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'undici';
import type * as Undici from 'undici';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../../test-db-helper.js';
import { isRedisAvailable } from '../../../test-redis-helper.js';
import { attachmentCacheDir } from '../../../core/services/attachment-store.js';
import { resolveBulkSelection } from '../../../core/services/bulk-page-selection.js';
import { getPool, query } from '../../../core/db/postgres.js';
import { setRedisClient } from '../../../core/services/redis-cache.js';
import {
  type RuntimeQuiescenceAcknowledgment,
  fencePageWriterRuntime,
  quiescePageWriterRuntime,
  reconcilePageWriteIntent,
  withPageWriteTransaction,
} from '../../../core/services/page-write-admission.js';
import { encryptPat } from '../../../core/utils/crypto.js';
import { registerOrdinaryPageWriteReconcilers } from './ordinary-page-write-reconciler.js';

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof Undici>()),
  request: vi.fn(),
}));

const mockRequest = vi.mocked(request);
const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);
let redis: RedisClientType;
let cacheKey: string | null = null;

function jsonResponse(data: unknown, statusCode = 200) {
  return {
    statusCode,
    headers: {},
    body: { text: async () => JSON.stringify(data) },
  };
}

async function seedRecoveryActor(prefix: string): Promise<string> {
  const suffix = randomUUID();
  const actor = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, 'x', 'user') RETURNING id`,
    [`${prefix}-${suffix}`, `${suffix}@test.invalid`],
  );
  const actorId = actor.rows[0]!.id;
  await query(
    `INSERT INTO spaces (space_key, space_name) VALUES ('REC', 'Recovery')
     ON CONFLICT (space_key) DO NOTHING`,
  );
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, permissions)
     VALUES ($1, 'Recovery writer', ARRAY['read', 'write', 'delete']) RETURNING id`,
    [`${prefix}-writer-${suffix}`],
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ('REC', 'user', $1, $2)`,
    [actorId, role.rows[0]!.id],
  );
  await query(
    `INSERT INTO user_settings (user_id, confluence_url, confluence_pat)
     VALUES ($1, 'https://confluence.example.com', $2)`,
    [actorId, encryptPat('recovery-pat')],
  );
  return actorId;
}

async function seedRecoveryAdmin(prefix: string): Promise<string> {
  const suffix = randomUUID();
  const admin = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, 'x', 'admin') RETURNING id`,
    [`${prefix}-admin-${suffix}`, `${suffix}@admin.test.invalid`],
  );
  return admin.rows[0]!.id;
}

async function seedFencedRuntime(actorId: string): Promise<string> {
  const runtimeId = `dead-${randomUUID()}`;
  await query(
    `INSERT INTO page_writer_runtimes
       (runtime_id, deployment_identity, fenced_at, fenced_by, fence_reason, fence_proof)
     VALUES ($1, $2::jsonb, NOW(), $3, 'Verified dead writer for recovery', $4::jsonb)`,
    [
      runtimeId,
      JSON.stringify({ host: 'test-host', pid: 999999, startedAt: new Date().toISOString() }),
      actorId,
      JSON.stringify({ kind: 'verified_local_termination', deploymentIdentity: { host: 'test-host' } }),
    ],
  );
  return runtimeId;
}

async function seedPendingLabelIntent(input: {
  remoteStarted: boolean;
  remoteCompleted: boolean;
}): Promise<{ actorId: string; recoveryAdminId: string; intentId: string; pageId: number }> {
  const actorId = await seedRecoveryActor('label-recovery');
  const recoveryAdminId = await seedRecoveryAdmin('label-recovery');
  const page = await query<{
    id: number;
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `INSERT INTO pages
       (confluence_id, space_key, title, labels, source, visibility, created_by_user_id)
     VALUES ('remote-label-page', 'REC', 'Label recovery', ARRAY['before'],
             'confluence', 'private', $1)
     RETURNING id, content_revision::text, lifecycle_revision::text`,
    [actorId],
  );
  const pageRow = page.rows[0]!;
  const runtimeId = await seedFencedRuntime(recoveryAdminId);
  const intentId = randomUUID();
  await query(
    `INSERT INTO page_write_intents
       (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect,
        effect_started_at, remote_effect_started_at, remote_effects_completed_at,
        remote_terminal_result)
     VALUES ($1, $2, 'page.labels', $3, ARRAY[$4]::int[], $5::jsonb,
             'remote_terminal_only', $6::jsonb, NOW(),
             CASE WHEN $7 THEN NOW() ELSE NULL END,
             CASE WHEN $8 THEN NOW() ELSE NULL END,
             CASE WHEN $8 THEN '{}'::jsonb ELSE NULL END)`,
    [
      intentId,
      runtimeId,
      actorId,
      pageRow.id,
      JSON.stringify({
        [pageRow.id]: {
          contentRevision: pageRow.content_revision,
          lifecycleRevision: pageRow.lifecycle_revision,
        },
      }),
      JSON.stringify({
        effectClass: 'remote',
        pageId: pageRow.id,
        confluenceId: 'remote-label-page',
        priorLabels: ['before'],
        targetLabels: ['after', 'reviewed'],
      }),
      input.remoteStarted,
      input.remoteCompleted,
    ],
  );
  return { actorId, recoveryAdminId, intentId, pageId: pageRow.id };
}

async function seedPendingPublicationIntent(
  kind: 'pages.update.confluence' | 'pages.draft.publish.confluence',
): Promise<{
  actorId: string;
  recoveryAdminId: string;
  intentId: string;
  pageId: number;
  confluenceId: string;
  remote: { title: string; storage: string; version: number };
}> {
  const actorId = await seedRecoveryActor('publication-recovery');
  const recoveryAdminId = await seedRecoveryAdmin('publication-recovery');
  const confluenceId = `publication-${randomUUID()}`;
  const page = await query<{
    id: number;
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `INSERT INTO pages
       (confluence_id, space_key, title, body_storage, body_html, body_text,
        version, source, visibility, created_by_user_id,
        summary_status, summary_retry_count, quality_status, quality_retry_count)
     VALUES ($1, 'REC', 'Old title', '<p>Old</p>', '<p>Old</p>', 'Old',
             1, 'confluence', 'private', $2, 'summarized', 4, 'analyzed', 5)
     RETURNING id, content_revision::text, lifecycle_revision::text`,
    [confluenceId, actorId],
  );
  const pageRow = page.rows[0]!;
  const runtimeId = await seedFencedRuntime(recoveryAdminId);
  const intentId = randomUUID();
  const remote = {
    title: 'Recovered title',
    storage: '<p>Recovered body</p>',
    version: 2,
  };
  await query(
    `INSERT INTO page_write_intents
       (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect,
        effect_started_at, effect_finished_at, remote_effect_started_at,
        remote_effects_completed_at, remote_terminal_result)
     VALUES ($1, $2, $3, $4, ARRAY[$5]::int[], $6::jsonb,
             'remote_terminal_only', $7::jsonb, NOW(), NOW(), NOW(), NOW(), $8::jsonb)`,
    [
      intentId,
      runtimeId,
      kind,
      actorId,
      pageRow.id,
      JSON.stringify({
        [pageRow.id]: {
          contentRevision: pageRow.content_revision,
          lifecycleRevision: pageRow.lifecycle_revision,
        },
      }),
      JSON.stringify({ effectClass: 'remote', confluenceId }),
      JSON.stringify({
        accepted: true,
        expectedVersion: remote.version,
        confluenceId,
        version: remote.version,
        titleSha256: createHash('sha256').update(remote.title).digest('hex'),
        storageSha256: createHash('sha256').update(remote.storage).digest('hex'),
      }),
    ],
  );
  return { actorId, recoveryAdminId, intentId, pageId: pageRow.id, confluenceId, remote };
}

async function seedPendingCreateIntent(
  parentSource: 'confluence' | 'standalone' = 'confluence',
): Promise<{
  recoveryAdminId: string;
  intentId: string;
  parentId: number;
  parentConfluenceId: string | null;
  remote: { id: string; title: string; storage: string; version: number };
}> {
  const actorId = await seedRecoveryActor('create-recovery');
  const recoveryAdminId = await seedRecoveryAdmin('create-recovery');
  const parentConfluenceId = parentSource === 'confluence'
    ? `parent-${randomUUID()}`
    : null;
  const parent = await query<{
    id: number;
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `INSERT INTO pages
       (confluence_id, space_key, title, source, visibility, created_by_user_id)
     VALUES ($1, 'REC', 'Create parent', $2, 'private', $3)
     RETURNING id, content_revision::text, lifecycle_revision::text`,
    [parentConfluenceId, parentSource, actorId],
  );
  const parentRow = parent.rows[0]!;
  const runtimeId = await seedFencedRuntime(recoveryAdminId);
  const intentId = randomUUID();
  const remote = {
    id: `created-${randomUUID()}`,
    title: 'Recovered child',
    storage: '<p>Recovered child body</p>',
    version: 1,
  };
  await query(
    `INSERT INTO page_write_intents
       (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect,
        effect_started_at, effect_finished_at, remote_effect_started_at,
        remote_effects_completed_at, remote_terminal_result)
     VALUES ($1, $2, 'pages.create.confluence', $3, ARRAY[$4]::int[], $5::jsonb,
             'remote_terminal_only', $6::jsonb, NOW(), NOW(), NOW(), NOW(), $7::jsonb)`,
    [
      intentId,
      runtimeId,
      actorId,
      parentRow.id,
      JSON.stringify({
        [parentRow.id]: {
          contentRevision: parentRow.content_revision,
          lifecycleRevision: parentRow.lifecycle_revision,
        },
      }),
      JSON.stringify({
        effectClass: 'remote',
        parentPageId: parentRow.id,
        parentConfluenceId,
        spaceKey: 'REC',
        titleSha256: createHash('sha256').update(remote.title).digest('hex'),
        storageSha256: createHash('sha256').update(remote.storage).digest('hex'),
      }),
      JSON.stringify({
        accepted: true,
        confluenceId: remote.id,
        expectedVersion: remote.version,
        observedConfluenceId: remote.id,
        version: remote.version,
        titleSha256: createHash('sha256').update(remote.title).digest('hex'),
        storageSha256: createHash('sha256').update(remote.storage).digest('hex'),
      }),
    ],
  );
  return {
    recoveryAdminId,
    intentId,
    parentId: parentRow.id,
    parentConfluenceId,
    remote,
  };
}

async function seedPendingDeleteIntent(): Promise<{
  actorId: string;
  recoveryAdminId: string;
  intentId: string;
  pageId: number;
  confluenceId: string;
}> {
  const actorId = await seedRecoveryActor('delete-recovery');
  const recoveryAdminId = await seedRecoveryAdmin('delete-recovery');
  const confluenceId = `deletion-${randomUUID()}`;
  const page = await query<{
    id: number;
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `INSERT INTO pages
       (confluence_id, space_key, title, source, visibility, created_by_user_id, deleted_at)
     VALUES ($1, 'REC', 'Delete recovery', 'confluence', 'private', $2, NOW())
     RETURNING id, content_revision::text, lifecycle_revision::text`,
    [confluenceId, actorId],
  );
  const pageRow = page.rows[0]!;
  const runtimeId = await seedFencedRuntime(recoveryAdminId);
  const intentId = randomUUID();
  await query(
    `INSERT INTO page_write_intents
       (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect,
        effect_started_at, effect_finished_at, remote_effect_started_at,
        remote_effects_completed_at, remote_terminal_result)
     VALUES ($1, $2, 'pages.delete.confluence', $3, ARRAY[$4]::int[], $5::jsonb,
             'remote_terminal_only', $6::jsonb, NOW(), NOW(), NOW(), NOW(), $7::jsonb)`,
    [
      intentId,
      runtimeId,
      actorId,
      pageRow.id,
      JSON.stringify({
        [pageRow.id]: {
          contentRevision: pageRow.content_revision,
          lifecycleRevision: pageRow.lifecycle_revision,
        },
      }),
      JSON.stringify({ effectClass: 'remote', confluenceId, spaceKey: 'REC' }),
      JSON.stringify({ confluenceId, outcome: 'deleted' }),
    ],
  );
  return { actorId, recoveryAdminId, intentId, pageId: pageRow.id, confluenceId };
}

beforeAll(async () => {
  if (!dbAvailable || !redisAvailable) return;
  await setupTestDb();
  registerOrdinaryPageWriteReconcilers();
  redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false } });
  await redis.connect();
  setRedisClient(redis);
});

beforeEach(async () => {
  if (!dbAvailable || !redisAvailable) return;
  await truncateAllTables();
  mockRequest.mockReset();
});

afterEach(async () => {
  if (cacheKey !== null) {
    await redis.del(cacheKey);
    cacheKey = null;
  }
});

afterAll(async () => {
  if (!dbAvailable || !redisAvailable) return;
  await redis.quit();
  await teardownTestDb();
});

const describeDb = dbAvailable && redisAvailable ? describe : describe.skip;

describeDb('ordinary page-write reconciliation', () => {
  it('rechecks administrator authority while claiming real recovery ownership', async () => {
    const seeded = await seedPendingLabelIntent({ remoteStarted: true, remoteCompleted: true });
    const originalRuntime = (await query<{ runtime_id: string }>(
      'SELECT runtime_id FROM page_write_intents WHERE id = $1',
      [seeded.intentId],
    )).rows[0]!.runtime_id;
    const blocker = await getPool().connect();
    let pending: Promise<{
      intentId: string;
      status: 'reconciled_applied' | 'reconciled_not_applied';
    }> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query("UPDATE users SET role = 'user' WHERE id = $1", [seeded.recoveryAdminId]);
      const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]!.pid;
      pending = reconcilePageWriteIntent(seeded.intentId, {
        actorId: seeded.recoveryAdminId,
        reason: 'Claim recovery only after committed administrator authority is known',
      });
      await vi.waitFor(async () => {
        const wait = await query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND $1 = ANY(pg_blocking_pids(pid))
           ) AS waiting`,
          [blockerPid],
        );
        expect(wait.rows[0]!.waiting).toBe(true);
      });
      await blocker.query('COMMIT');
      await expect(pending).rejects.toMatchObject({
        statusCode: 403,
        reason: 'recovery_admin_required',
      });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await pending?.catch(() => undefined);
    }
    expect(mockRequest).not.toHaveBeenCalled();
    expect((await query<{ runtime_id: string; status: string }>(
      'SELECT runtime_id, status FROM page_write_intents WHERE id = $1',
      [seeded.intentId],
    )).rows[0]).toEqual({ runtime_id: originalRuntime, status: 'pending' });
  });

  it('publishes terminal labels and invalidates cached reads with only one free database connection', async () => {
    const seeded = await seedPendingLabelIntent({ remoteStarted: true, remoteCompleted: true });
    mockRequest.mockResolvedValueOnce(jsonResponse({
      results: [{ name: 'reviewed' }, { name: 'after' }],
    }) as never);

    cacheKey = `kb:${seeded.actorId}:pages:recovery`;
    await redis.set(cacheKey, 'cached labels from before the write');
    const pool = getPool();
    const holders: PoolClient[] = [];
    while (holders.length < pool.options.max - 1) {
      holders.push(await pool.connect());
    }

    let settled = false;
    let outcome: 'completed' | 'second-checkout';
    const pending = reconcilePageWriteIntent(seeded.intentId, {
      actorId: seeded.recoveryAdminId,
      reason: 'The fenced writer recorded terminal remote success before its local publication commit',
    });
    try {
      const completion = pending.then(() => {
        settled = true;
        return 'completed' as const;
      });
      const secondCheckout = (async () => {
        while (!settled && mockRequest.mock.calls.length === 0 && pool.waitingCount === 0) {
          await nextEventLoopTurn();
        }
        return pool.waitingCount > 0 ? ('second-checkout' as const) : completion;
      })();
      outcome = await Promise.race([completion, secondCheckout]);
    } finally {
      settled = true;
      for (const holder of holders) holder.release();
      await pending;
    }
    expect(outcome).toBe('completed');
    await expect(pending).resolves.toEqual({
      intentId: seeded.intentId, status: 'reconciled_applied',
    });

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const page = await query<{ labels: string[] }>('SELECT labels FROM pages WHERE id = $1', [seeded.pageId]);
    expect(page.rows[0]!.labels).toEqual(['after', 'reviewed']);
    const intent = await query<{ status: string; cache_invalidation_pending: boolean }>(
      'SELECT status, cache_invalidation_pending FROM page_write_intents WHERE id = $1',
      [seeded.intentId],
    );
    expect(intent.rows[0]).toEqual({
      status: 'reconciled_applied', cache_invalidation_pending: false,
    });
    expect(await redis.get(cacheKey)).toBeNull();
  });

  it('refuses a genuinely unknown remote outcome without calling Confluence', async () => {
    const seeded = await seedPendingLabelIntent({ remoteStarted: true, remoteCompleted: false });

    await expect(reconcilePageWriteIntent(seeded.intentId, {
      actorId: seeded.recoveryAdminId,
      reason: 'No terminal outcome was recorded before the fenced writer disappeared',
    })).rejects.toMatchObject({ statusCode: 409, reason: 'intent_outcome_unrecoverable' });

    expect(mockRequest).not.toHaveBeenCalled();
    const intent = await query<{ status: string }>(
      'SELECT status FROM page_write_intents WHERE id = $1',
      [seeded.intentId],
    );
    expect(intent.rows[0]!.status).toBe('pending');
  });

  it('returns the exact label revision pair from both bulk selection paths', async () => {
    const actorId = await seedRecoveryActor('bulk-revisions');
    const inserted = await query<{
      id: number;
      content_revision: string;
      lifecycle_revision: string;
    }>(
      `INSERT INTO pages
         (confluence_id, space_key, title, labels, source, visibility, created_by_user_id)
       VALUES ($1, 'REC', 'Bulk revision row', ARRAY['observed'],
               'confluence', 'private', $2)
       RETURNING id, content_revision::text, lifecycle_revision::text`,
      [`bulk-revision-${randomUUID()}`, actorId],
    );
    const expected = inserted.rows[0]!;

    const byId = await resolveBulkSelection(
      actorId,
      { ids: [String(expected.id)] },
      ['REC'],
      { idMode: 'numeric-only' },
    );
    expect(byId.rows).toMatchObject([{
      id: expected.id,
      labels: ['observed'],
      contentRevision: expected.content_revision,
      lifecycleRevision: expected.lifecycle_revision,
    }]);

    const byFilter = await resolveBulkSelection(
      actorId,
      { filter: { spaceKey: 'REC' }, expectedCount: 1, driftToleranceFraction: 0 },
      ['REC'],
    );
    expect(byFilter.rows).toMatchObject([{
      id: expected.id,
      labels: ['observed'],
      contentRevision: expected.content_revision,
      lifecycleRevision: expected.lifecycle_revision,
    }]);
  });


  it('publishes an acknowledged child create during recovery without reissuing it upstream', async () => {
    const seeded = await seedPendingCreateIntent();
    mockRequest.mockResolvedValueOnce(jsonResponse({
      id: seeded.remote.id,
      title: seeded.remote.title,
      status: 'current',
      version: { number: seeded.remote.version },
      body: { storage: { value: seeded.remote.storage } },
    }) as never);

    await expect(reconcilePageWriteIntent(seeded.intentId, {
      actorId: seeded.recoveryAdminId,
      reason: 'Publish the exact terminal child creation without another POST',
    })).resolves.toEqual({ intentId: seeded.intentId, status: 'reconciled_applied' });

    const child = await query<{
      confluence_id: string;
      parent_id: string | null;
      title: string;
      body_storage: string;
      version: number;
    }>(
      `SELECT confluence_id, parent_id, title, body_storage, version
         FROM pages WHERE confluence_id = $1`,
      [seeded.remote.id],
    );
    expect(child.rows).toEqual([{
      confluence_id: seeded.remote.id,
      parent_id: seeded.parentConfluenceId,
      title: seeded.remote.title,
      body_storage: seeded.remote.storage,
      version: seeded.remote.version,
    }]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(String(mockRequest.mock.calls[0]?.[1]?.method ?? 'GET')).toBe('GET');
  });

  it('recovers a Confluence child under a standalone parent with the canonical local parent key', async () => {
    const seeded = await seedPendingCreateIntent('standalone');
    mockRequest.mockResolvedValueOnce(jsonResponse({
      id: seeded.remote.id,
      title: seeded.remote.title,
      status: 'current',
      version: { number: seeded.remote.version },
      body: { storage: { value: seeded.remote.storage } },
    }) as never);

    await expect(reconcilePageWriteIntent(seeded.intentId, {
      actorId: seeded.recoveryAdminId,
      reason: 'Publish the terminal child beneath its unchanged standalone parent',
    })).resolves.toEqual({ intentId: seeded.intentId, status: 'reconciled_applied' });

    const child = await query<{ parent_id: string | null }>(
      'SELECT parent_id FROM pages WHERE confluence_id = $1',
      [seeded.remote.id],
    );
    expect(child.rows).toEqual([{ parent_id: String(seeded.parentId) }]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(String(mockRequest.mock.calls[0]?.[1]?.method ?? 'GET')).toBe('GET');
  });

  it('resets derived work when recovering an ordinary body publication', async () => {
    const seeded = await seedPendingPublicationIntent('pages.update.confluence');
    mockRequest.mockResolvedValueOnce(jsonResponse({
      id: seeded.confluenceId,
      title: seeded.remote.title,
      status: 'current',
      version: { number: seeded.remote.version },
      body: { storage: { value: seeded.remote.storage } },
    }) as never);

    await expect(reconcilePageWriteIntent(seeded.intentId, {
      actorId: seeded.recoveryAdminId,
      reason: 'Recover the exact terminal ordinary page update',
    })).resolves.toEqual({ intentId: seeded.intentId, status: 'reconciled_applied' });

    const page = await query<{
      title: string;
      body_storage: string;
      summary_status: string;
      summary_retry_count: number;
      quality_status: string;
      quality_retry_count: number;
    }>(
      `SELECT title, body_storage, summary_status, summary_retry_count,
              quality_status, quality_retry_count
         FROM pages WHERE id = $1`,
      [seeded.pageId],
    );
    expect(page.rows[0]).toEqual({
      title: seeded.remote.title,
      body_storage: seeded.remote.storage,
      summary_status: 'pending',
      summary_retry_count: 0,
      quality_status: 'pending',
      quality_retry_count: 0,
    });
  });

  it('does not reset derived work when recovering draft publication mirroring', async () => {
    const seeded = await seedPendingPublicationIntent('pages.draft.publish.confluence');
    mockRequest.mockResolvedValueOnce(jsonResponse({
      id: seeded.confluenceId,
      title: seeded.remote.title,
      status: 'current',
      version: { number: seeded.remote.version },
      body: { storage: { value: seeded.remote.storage } },
    }) as never);

    await expect(reconcilePageWriteIntent(seeded.intentId, {
      actorId: seeded.recoveryAdminId,
      reason: 'Recover the exact terminal draft mirror',
    })).resolves.toEqual({ intentId: seeded.intentId, status: 'reconciled_applied' });

    const page = await query<{
      summary_status: string;
      summary_retry_count: number;
      quality_status: string;
      quality_retry_count: number;
    }>(
      `SELECT summary_status, summary_retry_count, quality_status, quality_retry_count
         FROM pages WHERE id = $1`,
      [seeded.pageId],
    );
    expect(page.rows[0]).toEqual({
      summary_status: 'summarized',
      summary_retry_count: 4,
      quality_status: 'analyzed',
      quality_retry_count: 5,
    });
  });
  it('keeps a trashed provider page pending instead of publishing it as live content', async () => {
    const seeded = await seedPendingPublicationIntent('pages.update.confluence');
    mockRequest.mockResolvedValueOnce(jsonResponse({
      id: seeded.confluenceId, title: seeded.remote.title, status: 'trashed',
      version: { number: seeded.remote.version },
      body: { storage: { value: seeded.remote.storage } },
    }) as never);
    await expect(reconcilePageWriteIntent(seeded.intentId, {
      actorId: seeded.recoveryAdminId,
      reason: 'A terminal version in provider trash cannot certify a live local publication',
    })).rejects.toMatchObject({ reason: 'intent_terminal_evidence_mismatch' });
    expect((await query('SELECT title FROM pages WHERE id = $1', [seeded.pageId])).rows)
      .toEqual([{ title: 'Old title' }]);
    expect((await query('SELECT status FROM page_write_intents WHERE id = $1', [seeded.intentId])).rows)
      .toEqual([{ status: 'pending' }]);
  });

  it('retries a fully settled failed recovery under its current owner after authority is restored', async () => {
    const seeded = await seedPendingLabelIntent({ remoteStarted: true, remoteCompleted: true });
    const original = (await query<{ runtime_id: string }>(
      'SELECT runtime_id FROM page_write_intents WHERE id = $1', [seeded.intentId],
    )).rows[0]!.runtime_id;
    await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [seeded.actorId]);
    await expect(reconcilePageWriteIntent(seeded.intentId, {
      actorId: seeded.recoveryAdminId, reason: 'Current original-writer authority is required even after terminal provider success',
    })).rejects.toMatchObject({ reason: 'intent_actor_inactive' });
    const claimed = (await query<{ runtime_id: string }>(
      'SELECT runtime_id FROM page_write_intents WHERE id = $1', [seeded.intentId],
    )).rows[0]!.runtime_id;
    expect(claimed).not.toBe(original);
    expect(mockRequest).not.toHaveBeenCalled();

    await query('UPDATE users SET deactivated_at = NULL WHERE id = $1', [seeded.actorId]);
    mockRequest.mockResolvedValueOnce(jsonResponse({
      results: [{ name: 'after' }, { name: 'reviewed' }],
    }) as never);
    await expect(reconcilePageWriteIntent(seeded.intentId, {
      actorId: seeded.recoveryAdminId, reason: 'The previous callback ended and the original actor is authorized again',
    })).resolves.toEqual({ intentId: seeded.intentId, status: 'reconciled_applied' });
    expect((await query('SELECT labels FROM pages WHERE id = $1', [seeded.pageId])).rows)
      .toEqual([{ labels: ['after', 'reviewed'] }]);
  });


  it.skipIf(process.getuid?.() === 0)(
    'keeps a recovered delete pending when its attachment directory cannot be removed',
    async () => {
      const seeded = await seedPendingDeleteIntent();
      const directory = attachmentCacheDir(seeded.confluenceId);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(`${directory}/retained.bin`, 'must survive failed cleanup');
      await fs.chmod(directory, 0o000);
      try {
        mockRequest.mockResolvedValueOnce(jsonResponse({ message: 'Not found' }, 404) as never);

        await expect(reconcilePageWriteIntent(seeded.intentId, {
          actorId: seeded.recoveryAdminId,
          reason: 'Recover a terminal delete only after verified local cleanup',
        })).rejects.toMatchObject({ code: 'EACCES' });

        const page = await query<{ deleted_at: Date | null }>(
          'SELECT deleted_at FROM pages WHERE id = $1',
          [seeded.pageId],
        );
        expect(page.rows[0]?.deleted_at).not.toBeNull();
        const intent = await query<{ status: string }>(
          'SELECT status FROM page_write_intents WHERE id = $1',
          [seeded.intentId],
        );
        expect(intent.rows[0]?.status).toBe('pending');
      } finally {
        await fs.chmod(directory, 0o700).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );
  it('holds recovery administrator authority through the final publication transaction', async () => {
    const seeded = await seedPendingLabelIntent({ remoteStarted: true, remoteCompleted: true });
    const reading = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    mockRequest.mockImplementationOnce(async () => {
      reading.resolve();
      await releaseRead.promise;
      return jsonResponse({ results: [{ name: 'after' }, { name: 'reviewed' }] }) as never;
    });
    const pending = reconcilePageWriteIntent(seeded.intentId, {
      actorId: seeded.recoveryAdminId,
      reason: 'Publication keeps administrator authority locked until settlement commits',
    });
    const demoter = await getPool().connect();
    let demoting: Promise<unknown> | undefined;
    try {
      await reading.promise;
      await demoter.query('BEGIN');
      const demoterPid = (await demoter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]!.pid;
      demoting = demoter.query("UPDATE users SET role = 'user' WHERE id = $1", [seeded.recoveryAdminId]);
      await vi.waitFor(async () => {
        const waiting = await query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND pid = $1
                AND wait_event_type = 'Lock'
           ) AS waiting`,
          [demoterPid],
        );
        expect(waiting.rows[0]!.waiting).toBe(true);
      });
      releaseRead.resolve();
      await expect(pending).resolves.toEqual({
        intentId: seeded.intentId,
        status: 'reconciled_applied',
      });
      await demoting;
      await demoter.query('COMMIT');
      expect((await query('SELECT labels FROM pages WHERE id = $1', [seeded.pageId])).rows)
        .toEqual([{ labels: ['after', 'reviewed'] }]);
      expect((await query('SELECT status FROM page_write_intents WHERE id = $1', [seeded.intentId])).rows)
        .toEqual([{ status: 'reconciled_applied' }]);
      expect((await query('SELECT role FROM users WHERE id = $1', [seeded.recoveryAdminId])).rows)
        .toEqual([{ role: 'user' }]);
    } finally {
      releaseRead.resolve();
      await pending.catch(() => undefined);
      await demoter.query('ROLLBACK').catch(() => undefined);
      demoter.release();
      await demoting?.catch(() => undefined);
    }
  });

  it('owns the production recovery callback until publication finishes before acknowledging quiescence', async () => {
    const seeded = await seedPendingLabelIntent({ remoteStarted: true, remoteCompleted: true });
    const quiescenceAdminId = await seedRecoveryAdmin('quiescence');
    let enterRead!: () => void;
    let releaseRead!: () => void;
    const reading = new Promise<void>((resolve) => { enterRead = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    mockRequest.mockImplementationOnce(async () => {
      enterRead();
      await readGate;
      return jsonResponse({ results: [{ name: 'after' }, { name: 'reviewed' }] }) as never;
    });
    const pending = reconcilePageWriteIntent(seeded.intentId, {
      actorId: seeded.recoveryAdminId, reason: 'Verify terminal labels on the recovering backend before publishing them',
    });
    let quiescing: Promise<RuntimeQuiescenceAcknowledgment> | undefined;
    try {
      await reading;
      const owned = (await query<{ runtime_id: string; recovery_started_at: Date | null }>(
        'SELECT runtime_id, recovery_started_at FROM page_write_intents WHERE id = $1',
        [seeded.intentId],
      )).rows[0]!;
      expect(owned.runtime_id).not.toMatch(/^dead-/);
      expect(owned.recovery_started_at).toBeInstanceOf(Date);
      await expect(reconcilePageWriteIntent(seeded.intentId, {
        actorId: seeded.recoveryAdminId, reason: 'A second request must not enter the same live recovery callback',
      })).rejects.toMatchObject({ reason: 'intent_recovery_running' });
      quiescing = quiescePageWriterRuntime({
        actorId: quiescenceAdminId, reason: 'Drain this recovering runtime without abandoning its active callback',
      });
      await vi.waitFor(async () => {
        const requested = await query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM audit_log
            WHERE user_id = $1 AND resource_id = $2
              AND metadata->>'action' = 'page_writer_quiesce_requested'`,
          [quiescenceAdminId, owned.runtime_id],
        );
        expect(Number(requested.rows[0]!.count)).toBe(1);
      });
      expect((await query('SELECT quiesced_at FROM page_writer_runtimes WHERE runtime_id = $1', [owned.runtime_id])).rows)
        .toEqual([{ quiesced_at: null }]);
      await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [quiescenceAdminId]);
      releaseRead();
      await expect(pending).resolves.toEqual({ intentId: seeded.intentId, status: 'reconciled_applied' });
      await expect(quiescing).rejects.toMatchObject({
        statusCode: 403,
        reason: 'recovery_admin_required',
      });
      expect((await query('SELECT quiesced_at FROM page_writer_runtimes WHERE runtime_id = $1', [owned.runtime_id])).rows)
        .toEqual([{ quiesced_at: null }]);
      await expect(
        withPageWriteTransaction([seeded.pageId], async () => undefined),
      ).rejects.toMatchObject({ statusCode: 409, reason: 'runtime_quiescing' });
      await query('UPDATE users SET deactivated_at = NULL WHERE id = $1', [quiescenceAdminId]);
      const ack = await quiescePageWriterRuntime({
        actorId: quiescenceAdminId,
        reason: 'Retry final acknowledgment after restoring administrator authority',
      });
      expect((await query('SELECT labels FROM pages WHERE id = $1', [seeded.pageId])).rows)
        .toEqual([{ labels: ['after', 'reviewed'] }]);
      await expect(fencePageWriterRuntime({
        mode: 'owner_ack', runtimeId: ack.runtimeId, acknowledgmentId: ack.acknowledgmentId,
        actorId: quiescenceAdminId, reason: 'The recovering owner acknowledged only after its callback and publication settled',
      })).resolves.toEqual({ unresolvedIntents: 0 });
    } finally {
      releaseRead();
      await pending.catch(() => undefined);
      await quiescing?.catch(() => undefined);
      await query('UPDATE users SET deactivated_at = NULL WHERE id = $1', [quiescenceAdminId]);
    }
  });
});
