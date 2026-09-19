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
  fencePageWriterRuntime,
  quiescePageWriterRuntime,
  reconcilePageWriteIntent,
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
  const actor = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, 'x', 'admin') RETURNING id`,
    [`${prefix}-${randomUUID()}`, `${randomUUID()}@test.invalid`],
  );
  const actorId = actor.rows[0]!.id;
  await query(
    `INSERT INTO spaces (space_key, space_name) VALUES ('REC', 'Recovery')
     ON CONFLICT (space_key) DO NOTHING`,
  );
  await query(
    `INSERT INTO user_settings (user_id, confluence_url, confluence_pat)
     VALUES ($1, 'https://confluence.example.com', $2)`,
    [actorId, encryptPat('recovery-pat')],
  );
  return actorId;
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
}): Promise<{ actorId: string; intentId: string; pageId: number }> {
  const actorId = await seedRecoveryActor('label-recovery');
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
  const runtimeId = await seedFencedRuntime(actorId);
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
  return { actorId, intentId, pageId: pageRow.id };
}

async function seedPendingPublicationIntent(
  kind: 'pages.update.confluence' | 'pages.draft.publish.confluence',
): Promise<{
  actorId: string;
  intentId: string;
  pageId: number;
  confluenceId: string;
  remote: { title: string; storage: string; version: number };
}> {
  const actorId = await seedRecoveryActor('publication-recovery');
  const confluenceId = `remote-page-${randomUUID()}`;
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
  const runtimeId = await seedFencedRuntime(actorId);
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
  return { actorId, intentId, pageId: pageRow.id, confluenceId, remote };
}

async function seedPendingDeleteIntent(): Promise<{
  actorId: string;
  intentId: string;
  pageId: number;
  confluenceId: string;
}> {
  const actorId = await seedRecoveryActor('delete-recovery');
  const confluenceId = `delete-page-${randomUUID()}`;
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
  const runtimeId = await seedFencedRuntime(actorId);
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
  return { actorId, intentId, pageId: pageRow.id, confluenceId };
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
      actorId: seeded.actorId,
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
      actorId: seeded.actorId,
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
      actorId: seeded.actorId,
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
      actorId: seeded.actorId,
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
      actorId: seeded.actorId,
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
      actorId: seeded.actorId, reason: 'Current actor authority is required even after terminal provider success',
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
      actorId: seeded.actorId, reason: 'The previous callback ended and the original actor is authorized again',
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
          actorId: seeded.actorId,
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
  it('owns the production recovery callback until publication finishes before acknowledging quiescence', async () => {
    const seeded = await seedPendingLabelIntent({ remoteStarted: true, remoteCompleted: true });
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
      actorId: seeded.actorId, reason: 'Verify terminal labels on the recovering backend before publishing them',
    });
    let quiescing: ReturnType<typeof quiescePageWriterRuntime> | undefined;
    let acknowledged = false;
    try {
      await reading;
      const owned = (await query<{ runtime_id: string; recovery_started_at: Date | null }>(
        'SELECT runtime_id, recovery_started_at FROM page_write_intents WHERE id = $1',
        [seeded.intentId],
      )).rows[0]!;
      expect(owned.runtime_id).not.toMatch(/^dead-/);
      expect(owned.recovery_started_at).toBeInstanceOf(Date);
      await expect(reconcilePageWriteIntent(seeded.intentId, {
        actorId: seeded.actorId, reason: 'A second request must not enter the same live recovery callback',
      })).rejects.toMatchObject({ reason: 'intent_recovery_running' });
      quiescing = quiescePageWriterRuntime({
        actorId: seeded.actorId, reason: 'Drain this recovering runtime without abandoning its active callback',
      }).then((ack) => { acknowledged = true; return ack; });
      await nextEventLoopTurn();
      expect(acknowledged).toBe(false);
      expect((await query('SELECT quiesced_at FROM page_writer_runtimes WHERE runtime_id = $1', [owned.runtime_id])).rows)
        .toEqual([{ quiesced_at: null }]);
      releaseRead();
      await expect(pending).resolves.toEqual({ intentId: seeded.intentId, status: 'reconciled_applied' });
      const ack = await quiescing;
      expect((await query('SELECT labels FROM pages WHERE id = $1', [seeded.pageId])).rows)
        .toEqual([{ labels: ['after', 'reviewed'] }]);
      await expect(fencePageWriterRuntime({
        mode: 'owner_ack', runtimeId: ack.runtimeId, acknowledgmentId: ack.acknowledgmentId,
        actorId: seeded.actorId, reason: 'The recovering owner acknowledged only after its callback and publication settled',
      })).resolves.toEqual({ unresolvedIntents: 0 });
    } finally {
      releaseRead();
      await pending.catch(() => undefined);
      await quiescing?.catch(() => undefined);
    }
  });
});
