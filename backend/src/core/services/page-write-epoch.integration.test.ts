import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import { createClient, type RedisClientType } from 'redis';
import { setRedisClient } from './redis-cache.js';
import { initPageBaselineOutbox } from './page-baseline-outbox.js';
import {
  fencePageWriterRuntime,
  getPageWriterRuntimeId,
  withPageWriteTransaction,
} from './page-write-admission.js';
import {
  _resetPageBaselineGovernanceForTests,
  setPageBaselineReadinessProvider,
} from './page-baseline-governance.js';
import {
  freezePage,
  previewPageBaseline,
  setPageBaselineCreationEnabled,
  unfreezePage,
} from './page-baseline-service.js';

const available = await isDbAvailable();

// Fencing is irreversible for this module's process epoch. Keep this scenario
// isolated from suites whose later cases still need to admit writes.
describe.skipIf(!available)('SQL-only writer epoch — real PostgreSQL', () => {
  let attachmentsDir: string;
  let redis: RedisClientType;
  let stopOutbox: () => Promise<void>;
  beforeAll(async () => {
    await setupTestDb();
    await truncateAllTables();
    redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false } });
    await redis.connect();
    setRedisClient(redis);
    stopOutbox = await initPageBaselineOutbox();
    attachmentsDir = await mkdtemp(join(tmpdir(), 'baseline-epoch-'));
    vi.stubEnv('ATTACHMENTS_DIR', attachmentsDir);
    setPageBaselineReadinessProvider(async () => ({ ready: true, blockers: [] }));
  });
  afterAll(async () => {
    await stopOutbox();
    await redis.quit();
    _resetPageBaselineGovernanceForTests();
    await teardownTestDb();
    await rm(attachmentsDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('drains an admitted SQL commit before fencing and refuses later writes', async () => {
    const actor = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, 'hash', 'admin') RETURNING id",
      [`epoch-admin-${randomUUID()}`],
    );
    const actorId = actor.rows[0]!.id;
    const page = await query<{ id: number }>(
      `INSERT INTO pages (title, body_html, source, visibility, created_by_user_id)
       VALUES ('Original', '<p>Original</p>', 'standalone', 'private', $1) RETURNING id`,
      [actorId],
    );
    const pageId = page.rows[0]!.id;
    await setPageBaselineCreationEnabled(actorId, true);
    const lifecyclePages = await query<{ id: number; title: string }>(
      `INSERT INTO pages (title, body_html, source, visibility, created_by_user_id)
       VALUES ('Frozen', '<p>Frozen</p>', 'standalone', 'private', $1),
              ('Editable', '<p>Editable</p>', 'standalone', 'private', $1)
       RETURNING id, title`,
      [actorId],
    );
    const frozenPageId = lifecyclePages.rows.find((row) => row.title === 'Frozen')!.id;
    const editablePageId = lifecyclePages.rows.find((row) => row.title === 'Editable')!.id;
    const preparedFrozen = await previewPageBaseline(frozenPageId, actorId);
    const frozen = await freezePage({
      pageId: frozenPageId,
      actorId,
      reason: 'Publish before the runtime is retired',
      expectedContentRevision: preparedFrozen.contentRevision,
      expectedManifestDigest: preparedFrozen.manifestDigest,
    });
    const preparedEditable = await previewPageBaseline(editablePageId, actorId);
    const runtimeId = await getPageWriterRuntimeId();
    const entered = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const write = withPageWriteTransaction([pageId], async (client) => {
      await client.query('UPDATE pages SET title = $2 WHERE id = $1', [pageId, 'Admitted write']);
      const identity = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      entered.resolve(identity.rows[0]!.pid);
      await release.promise;
    });
    const writerPid = await entered.promise;
    let fenceCompleted = false;
    const fence = fencePageWriterRuntime({
      runtimeId,
      actorId,
      mode: 'durable_no_started_effects',
      reason: 'Retire an epoch containing an admitted SQL-only writer',
    }).then((result) => {
      fenceCompleted = true;
      return result;
    });
    let committedBeforeDrain = false;
    try {
      // Observe the actual lock wait or the faulty early fence, never a sleep.
      while (!fenceCompleted) {
        const state = await query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND $1 = ANY(pg_blocking_pids(pid))
           ) AS waiting`,
          [writerPid],
        );
        if (state.rows[0]!.waiting) break;
        await nextEventLoopTurn();
      }
      committedBeforeDrain = fenceCompleted;
    } finally {
      release.resolve();
      await write;
      await fence;
    }
    expect(committedBeforeDrain).toBe(false);
    await expect(withPageWriteTransaction([pageId], (client) => client.query(
      'UPDATE pages SET title = $2 WHERE id = $1', [pageId, 'Forbidden late write'],
    ))).rejects.toMatchObject({ statusCode: 409, reason: 'runtime_fenced' });
    expect((await query<{ title: string }>('SELECT title FROM pages WHERE id = $1', [pageId]))
      .rows[0]!.title).toBe('Admitted write');
    await expect(freezePage({
      pageId: editablePageId,
      actorId,
      reason: 'A retired runtime cannot publish another baseline',
      expectedContentRevision: preparedEditable.contentRevision,
      expectedManifestDigest: preparedEditable.manifestDigest,
    })).rejects.toMatchObject({ statusCode: 409, reason: 'runtime_fenced' });
    await expect(unfreezePage(frozenPageId, actorId, {
      reason: 'A retired runtime cannot thaw the published baseline',
      expectedBaselineId: frozen.baselineId!,
      expectedLifecycleRevision: frozen.lifecycleRevision,
    })).rejects.toMatchObject({ statusCode: 409, reason: 'runtime_fenced' });
    expect((await query(
      'SELECT id, baseline_id FROM pages WHERE id = ANY($1::int[]) ORDER BY id',
      [[frozenPageId, editablePageId]],
    )).rows).toEqual([
      { id: frozenPageId, baseline_id: frozen.baselineId },
      { id: editablePageId, baseline_id: null },
    ]);
  });
});
