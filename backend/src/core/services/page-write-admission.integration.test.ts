import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
  waitForDatabaseCondition,
} from '../../test-db-helper.js';
import { getPool, query } from '../db/postgres.js';
import {
  type PageWriteIntent,
  PageWriteError,
  admitPageRuntime,
  advancePageWriteIntent,
  assertPageFreezeIdle,
  cancelPageWriteIntentBeforeEffect,
  completePageWriteIntent,
  fencePageWriterRuntime,
  lockPageLifecycle,
  quiescePageWriterRuntime,
  reconcilePageWriteIntent,
  registerPageWriteIntentReconciler,
  releasePageRuntime,
  reservePageWriteIntent,
  reservePageWriteIntentInTransaction,
  runPageWriteIntentEffect,
  withPageWriteTransaction,
} from './page-write-admission.js';

const dbAvailable = await isDbAvailable();
let sequence = 0;

async function insertUser(role = 'user'): Promise<string> {
  sequence += 1;
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, 'x', $3)
     RETURNING id`,
    [`admission-${sequence}`, `admission-${sequence}@test.invalid`, role],
  );
  return result.rows[0]!.id;
}

async function insertPage(actorId: string, title = 'Admission page'): Promise<number> {
  const result = await query<{ id: number }>(
    `INSERT INTO pages
       (title, body_html, body_storage, body_text, version, labels, source,
        visibility, created_by_user_id, embedding_dirty, embedding_status)
     VALUES ($1, '<p>body</p>', '<p>body</p>', 'body', 1, ARRAY['one'],
             'standalone', 'private', $2, FALSE, 'not_embedded')
     RETURNING id`,
    [title, actorId],
  );
  return result.rows[0]!.id;
}

async function revisionOf(pageId: number): Promise<{ content: string; lifecycle: string }> {
  const result = await query<{ content_revision: string; lifecycle_revision: string }>(
    `SELECT content_revision::text, lifecycle_revision::text FROM pages WHERE id = $1`,
    [pageId],
  );
  return {
    content: result.rows[0]!.content_revision,
    lifecycle: result.rows[0]!.lifecycle_revision,
  };
}

async function freezePage(pageId: number, actorId: string): Promise<string> {
  const baselineId = randomUUID();
  const revision = await revisionOf(pageId);
  const preparation = await reservePageWriteIntent({
    pageIds: [pageId],
    kind: 'baseline.prepare',
    actorId,
    effect: { effectClass: 'local', baselineId },
  });
  await runPageWriteIntentEffect(preparation, { kind: 'local' }, async () => undefined);
  await completePageWriteIntent(preparation, async () => undefined);
  await query(
    `INSERT INTO page_baselines
       (id, page_id, original_page_id, page_identity, version, content_revision,
        lifecycle_revision, manifest_digest, manifest, manifest_bytes, title,
        labels, attachments, total_bytes, reserved_bytes, status,
        prepared_by_user_id, prepared_by_name, published_by_user_id,
        published_by_name, published_at, provenance, freeze_reason, preparation_intent_id)
     VALUES ($1, $2, $2, '[]'::jsonb, 1, $3::bigint, $4::bigint,
             $5, '[]'::jsonb, $6, 'Admission page', '{}', '[]'::jsonb, 0, 0,
             'published', $7, 'Test actor', $7, 'Test actor', NOW(),
             'manual_assertion', 'Test freeze reason', $8)`,
    [baselineId, pageId, revision.content, revision.lifecycle, 'a'.repeat(64), Buffer.from('[]'), actorId, preparation.id],
  );
  await query(
    `UPDATE pages
        SET baseline_id = $2, frozen_version = version, frozen_at = NOW(),
            frozen_by_user_id = $3, frozen_by_name = 'Test actor',
            freeze_reason = 'Test freeze reason', freeze_provenance = 'manual_assertion',
            freeze_reported_signatories = '[]'::jsonb
      WHERE id = $1`,
    [pageId, baselineId, actorId],
  );
  return baselineId;
}

async function assertFreezeBusy(pageId: number): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await lockPageLifecycle(client, [pageId]);
    await expect(assertPageFreezeIdle(client, pageId)).rejects.toMatchObject({
      statusCode: 409,
      reason: 'freeze_busy',
    });
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

async function intentState(intentId: string): Promise<{
  status: string;
  deleted_page_ids: number[];
}> {
  const result = await query<{ status: string; deleted_page_ids: number[] }>(
    `SELECT status, deleted_page_ids FROM page_write_intents WHERE id = $1`,
    [intentId],
  );
  return result.rows[0]!;
}

describe.skipIf(!dbAvailable)('page-write-admission — real PostgreSQL', () => {
  beforeAll(async () => {
    await setupTestDb();
    // Keep the module's process-runtime row across cases; unlike production,
    // truncateAllTables between cases would erase it while the module promise
    // correctly remains cached for the process epoch.
    await truncateAllTables();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('increments only protected authored payload and leaves security/derived annotations mutable', async () => {
    const actor = await insertUser();
    const pageId = await insertPage(actor);

    expect(await revisionOf(pageId)).toEqual({ content: '0', lifecycle: '0' });
    await query(`UPDATE pages SET title = 'Authored title' WHERE id = $1`, [pageId]);
    expect(await revisionOf(pageId)).toEqual({ content: '1', lifecycle: '0' });

    await query(
      `UPDATE pages
          SET visibility = 'shared', verified_at = NOW(), embedding_dirty = TRUE,
              inherit_perms = FALSE
        WHERE id = $1`,
      [pageId],
    );
    expect(await revisionOf(pageId)).toEqual({ content: '1', lifecycle: '0' });
  });

  it('enforces frozen content in the service and defense trigger without blocking security tightening', async () => {
    const actor = await insertUser();
    const pageId = await insertPage(actor);
    await freezePage(pageId, actor);

    await expect(
      withPageWriteTransaction([pageId], (client) =>
        client.query(`UPDATE pages SET body_text = 'forbidden' WHERE id = $1`, [pageId]),
      ),
    ).rejects.toMatchObject({ statusCode: 423, reason: 'page_is_frozen' });
    await expect(
      query(`UPDATE pages SET title = 'raw bypass' WHERE id = $1`, [pageId]),
    ).rejects.toMatchObject({ code: '55000', message: 'page_is_frozen' });

    await query(`UPDATE pages SET visibility = 'shared', inherit_perms = FALSE WHERE id = $1`, [pageId]);
    const state = await query<{ visibility: string; inherit_perms: boolean; content_revision: string }>(
      `SELECT visibility, inherit_perms, content_revision::text FROM pages WHERE id = $1`,
      [pageId],
    );
    expect(state.rows[0]).toEqual({ visibility: 'shared', inherit_perms: false, content_revision: '0' });
  });

  it('sorts multi-page locks, exposes try-lock busy, and serializes reversed callers without deadlock', async () => {
    const actor = await insertUser();
    const low = await insertPage(actor, 'Low');
    const high = await insertPage(actor, 'High');
    const holder = await getPool().connect();
    const contender = await getPool().connect();
    try {
      await holder.query('BEGIN');
      await lockPageLifecycle(holder, [high, low]);
      await contender.query('BEGIN');
      await expect(lockPageLifecycle(contender, [high, low], { tryLock: true })).rejects.toMatchObject({
        statusCode: 409,
        reason: 'freeze_busy',
      });
      await contender.query('ROLLBACK');

      await contender.query('BEGIN');
      const contenderPid = await contender.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const waiting = lockPageLifecycle(contender, [low, high]);
      const waitingOnLifecycleLock = await waitForDatabaseCondition(async () => {
        const activity = await query<{ wait_event_type: string | null }>(
          'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
          [contenderPid.rows[0]!.pid],
        );
        return activity.rows[0]?.wait_event_type === 'Lock';
      });
      expect(waitingOnLifecycleLock).toBe(true);
      await holder.query('COMMIT');
      await waiting;
      await contender.query('COMMIT');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await contender.query('ROLLBACK').catch(() => undefined);
      contender.release();
      holder.release();
    }
  });

  it('accepts empty bulk lock sets and rolls back callback writes on failure', async () => {
    let emptyCallbackRan = false;
    await withPageWriteTransaction([], async () => {
      emptyCallbackRan = true;
    });
    expect(emptyCallbackRan).toBe(true);

    const actor = await insertUser();
    const pageId = await insertPage(actor, 'Before rollback');
    await expect(
      withPageWriteTransaction([pageId], async (client) => {
        await client.query(`UPDATE pages SET title = 'Must roll back' WHERE id = $1`, [pageId]);
        throw new Error('rollback probe');
      }),
    ).rejects.toThrow('rollback probe');
    const row = await query<{ title: string; content_revision: string }>(
      `SELECT title, content_revision::text FROM pages WHERE id = $1`,
      [pageId],
    );
    expect(row.rows[0]).toEqual({ title: 'Before rollback', content_revision: '0' });
  });

  it('admits only one unresolved external intent and keeps freeze busy until explicit cancellation', async () => {
    const actor = await insertUser();
    const pageId = await insertPage(actor);
    const intent = await reservePageWriteIntent({
      pageIds: [pageId],
      kind: 'icon.image.put',
      actorId: actor,
      effect: { effectClass: 'local', identity: 'fixture', sha256: 'b'.repeat(64) },
    });

    await expect(
      reservePageWriteIntent({
        pageIds: [pageId],
        kind: 'icon.image.delete',
        actorId: actor,
        effect: { effectClass: 'local', identity: 'fixture-2', sha256: 'c'.repeat(64) },
      }),
    ).rejects.toMatchObject({ statusCode: 409, reason: 'page_write_busy' });
    await assertFreezeBusy(pageId);

    await cancelPageWriteIntentBeforeEffect(intent);
    expect(await intentState(intent.id)).toMatchObject({ status: 'cancelled' });
    const retry = await reservePageWriteIntent({
      pageIds: [pageId],
      kind: 'attachment.local.put',
      actorId: actor,
      effect: { effectClass: 'local', identity: 'fixture-3', sha256: 'd'.repeat(64) },
    });
    await cancelPageWriteIntentBeforeEffect(retry);
  });

  it('rejects a phased write after content or lifecycle changes instead of adopting the newest revision', async () => {
    const actor = await insertUser();
    const pageId = await insertPage(actor, 'Phased import');
    const original = await revisionOf(pageId);
    const input = {
      pageIds: [pageId], kind: 'attachment.local.put', actorId: actor,
      effect: { effectClass: 'local', pageId, files: [] },
      expectedRevisions: {
        [pageId]: { contentRevision: original.content, lifecycleRevision: original.lifecycle },
      },
    };
    await withPageWriteTransaction([pageId], (client) =>
      client.query("UPDATE pages SET title = 'Concurrent edit' WHERE id = $1", [pageId]));
    await expect(reservePageWriteIntent(input)).rejects.toMatchObject({ reason: 'stale_content_revision' });
    const edited = await revisionOf(pageId);
    input.expectedRevisions[pageId] = { contentRevision: edited.content, lifecycleRevision: edited.lifecycle };
    await withPageWriteTransaction([pageId], (client) =>
      client.query('UPDATE pages SET lifecycle_revision = lifecycle_revision + 2 WHERE id = $1', [pageId]));
    await expect(reservePageWriteIntent(input)).rejects.toMatchObject({ reason: 'stale_lifecycle' });
    expect((await query(
      "SELECT id FROM page_write_intents WHERE status = 'pending' AND page_ids @> ARRAY[$1::integer]",
      [pageId],
    )).rows).toEqual([]);

    const current = await revisionOf(pageId);
    const admitted = await reservePageWriteIntent({
      ...input,
      expectedRevisions: { [pageId]: { contentRevision: current.content, lifecycleRevision: current.lifecycle } },
    });
    await completePageWriteIntent(admitted, (client) =>
      client.query("UPDATE pages SET title = 'Explicitly restarted write' WHERE id = $1", [pageId]));
    expect((await query('SELECT title FROM pages WHERE id = $1', [pageId])).rows)
      .toEqual([{ title: 'Explicitly restarted write' }]);
  });

  it('adopts an in-transaction reservation only after its caller commits', async () => {
    const actor = await insertUser();
    const pageId = await insertPage(actor, 'Transactional reservation');
    const rolledBackClient = await getPool().connect();
    let rolledBackIntent: PageWriteIntent | undefined;
    try {
      await rolledBackClient.query('BEGIN');
      rolledBackIntent = await reservePageWriteIntentInTransaction(rolledBackClient, {
        pageIds: [pageId],
        kind: 'baseline.prepare',
        actorId: actor,
        effect: {
          effectClass: 'local',
          baselineId: randomUUID(),
          intendedStateDigest: '7'.repeat(64),
          intendedSize: 4,
        },
      });
      await rolledBackClient.query('ROLLBACK');
    } finally {
      rolledBackClient.release();
    }
    let rolledBackEffectStarted = false;
    await expect(
      runPageWriteIntentEffect(rolledBackIntent!, { kind: 'local' }, async () => {
        rolledBackEffectStarted = true;
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(rolledBackEffectStarted).toBe(false);

    const committedClient = await getPool().connect();
    let committedIntent: PageWriteIntent | undefined;
    try {
      committedIntent = await reservePageWriteIntentInTransaction(committedClient, {
        pageIds: [pageId],
        kind: 'baseline.prepare',
        actorId: actor,
        effect: {
          effectClass: 'local',
          baselineId: randomUUID(),
          intendedStateDigest: '6'.repeat(64),
          intendedSize: 4,
        },
      });
      await committedClient.query('COMMIT');
    } finally {
      committedClient.release();
    }
    let committedEffectStarted = false;
    await runPageWriteIntentEffect(committedIntent!, { kind: 'local' }, async () => {
      committedEffectStarted = true;
    });
    expect(committedEffectStarted).toBe(true);
    await completePageWriteIntent(committedIntent!, async () => undefined);
  });

  it('fences stale room tokens by lifecycle revision and clean release, never by TTL', async () => {
    const actor = await insertUser();
    const pageId = await insertPage(actor);
    const admission = await admitPageRuntime(pageId, actor);
    await assertFreezeBusy(pageId);

    await query(`UPDATE pages SET lifecycle_revision = lifecycle_revision + 1 WHERE id = $1`, [pageId]);
    await expect(
      withPageWriteTransaction(
        [pageId],
        (client) => client.query(`UPDATE pages SET title = 'stale room' WHERE id = $1`, [pageId]),
        { admission },
      ),
    ).rejects.toMatchObject({ statusCode: 409, reason: 'stale_lifecycle' });

    await releasePageRuntime(admission);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await lockPageLifecycle(client, [pageId]);
      await expect(assertPageFreezeIdle(client, pageId)).resolves.toBeUndefined();
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('persists deletion tombstones before cleanup and refuses arbitrary page absence', async () => {
    const actor = await insertUser();
    const deleted = await insertPage(actor, 'Delete through intent');
    const intent = await reservePageWriteIntent({
      pageIds: [deleted],
      kind: 'pages.delete.standalone',
      actorId: actor,
      effect: { effectClass: 'local', identity: `page:${deleted}`, sha256: 'e'.repeat(64) },
    });
    const returned = await advancePageWriteIntent(intent, async (client) => {
      const result = await client.query<{ id: number }>(`DELETE FROM pages WHERE id = $1 RETURNING id`, [deleted]);
      return result.rows.map((row) => row.id);
    });
    expect(returned).toEqual([deleted]);
    expect(await intentState(intent.id)).toEqual({ status: 'pending', deleted_page_ids: [deleted] });
    await runPageWriteIntentEffect(intent, { kind: 'local' }, async () => undefined);
    await completePageWriteIntent(intent, async () => undefined);
    expect(await intentState(intent.id)).toMatchObject({ status: 'completed' });

    const bypassed = await insertPage(actor, 'Missing without tombstone');
    const bypassIntent = await reservePageWriteIntent({
      pageIds: [bypassed],
      kind: 'pages.delete.standalone',
      actorId: actor,
      effect: { effectClass: 'local', identity: `page:${bypassed}`, sha256: 'f'.repeat(64) },
    });
    await query(`DELETE FROM pages WHERE id = $1`, [bypassed]);
    await expect(completePageWriteIntent(bypassIntent, async () => undefined)).rejects.toMatchObject({
      statusCode: 409,
      reason: 'intent_deletion_tombstone_mismatch',
    });
    await query(`UPDATE page_write_intents SET deleted_page_ids = ARRAY[$2]::integer[] WHERE id = $1`, [
      bypassIntent.id,
      bypassed,
    ]);
    await runPageWriteIntentEffect(bypassIntent, { kind: 'local' }, async () => undefined);
    await completePageWriteIntent(bypassIntent, async () => undefined);
  });

  it('refuses a retirement row without a named server-proof kind', async () => {
    await expect(query(
      `INSERT INTO page_writer_runtimes
         (runtime_id, deployment_identity, fenced_at, fence_reason, fence_proof)
       VALUES ($1, '{}'::jsonb, NOW(), 'An empty object is not retirement evidence', '{}'::jsonb)`,
      [`incomplete-proof-${randomUUID()}`],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses to fence a DB-partitioned live runtime without owner quiescence proof', async () => {
    const actor = await insertUser();
    const administrator = await insertUser('admin');
    const pageId = await insertPage(actor);
    const runtimeId = `partitioned-${randomUUID()}`;
    await query(
      `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity)
       VALUES ($1, $2::jsonb)`,
      [runtimeId, JSON.stringify({ host: 'partitioned-pod', pid: 41, startedAt: new Date().toISOString() })],
    );
    await query(
      `INSERT INTO page_runtime_admissions
         (runtime_id, page_id, actor_id, lifecycle_revision)
       VALUES ($1, $2, $3, 0)`,
      [runtimeId, pageId, actor],
    );

    await expect(
      fencePageWriterRuntime({
        mode: 'owner_ack',
        runtimeId,
        acknowledgmentId: randomUUID(),
        actorId: administrator,
        reason: 'Operator cannot substitute a DB flag for process quiescence',
      }),
    ).rejects.toMatchObject({ statusCode: 409, reason: 'runtime_not_quiesced' });
    await assertFreezeBusy(pageId);
    const runtime = await query<{ fenced_at: Date | null; quiesced_at: Date | null }>(
      `SELECT fenced_at, quiesced_at FROM page_writer_runtimes WHERE runtime_id = $1`,
      [runtimeId],
    );
    expect(runtime.rows[0]).toEqual({ fenced_at: null, quiesced_at: null });
  });

  it('fences a crashed runtime from durable no-start evidence and blocks its late admission', async () => {
    const actor = await insertUser();
    const administrator = await insertUser('admin');
    const pageId = await insertPage(actor, 'Crashed pre-effect room');
    const revision = await revisionOf(pageId);
    const runtimeId = `crashed-pre-effect-${randomUUID()}`;
    const intentId = randomUUID();
    await query(
      `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity)
       VALUES ($1, $2::jsonb)`,
      [runtimeId, JSON.stringify({ host: 'same-db-runtime', pid: 42, startedAt: new Date().toISOString() })],
    );
    await query(
      `INSERT INTO page_runtime_admissions
         (runtime_id, page_id, actor_id, lifecycle_revision)
       VALUES ($1, $2, $3, $4::bigint)`,
      [runtimeId, pageId, actor, revision.lifecycle],
    );
    await query(
      `INSERT INTO page_write_intents
         (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect)
       VALUES ($1, $2, 'baseline.prepare', $3, ARRAY[$4]::integer[], $5::jsonb,
               'local_verified', $6::jsonb)`,
      [
        intentId,
        runtimeId,
        actor,
        pageId,
        JSON.stringify({
          [pageId]: { contentRevision: revision.content, lifecycleRevision: revision.lifecycle },
        }),
        JSON.stringify({
          effectClass: 'local',
          baselineId: randomUUID(),
          intendedStateDigest: '7'.repeat(64),
          intendedSize: 1,
        }),
      ],
    );

    await expect(
      fencePageWriterRuntime({
        mode: 'durable_no_started_effects',
        runtimeId,
        actorId: administrator,
        reason: 'The durable runtime epoch proves that no protected work started',
      }),
    ).resolves.toEqual({ unresolvedIntents: 0 });
    expect((await intentState(intentId)).status).toBe('cancelled');
    const admission = await query<{ released_at: Date | null; release_kind: string | null }>(
      `SELECT released_at, release_kind
         FROM page_runtime_admissions
        WHERE runtime_id = $1 AND page_id = $2`,
      [runtimeId, pageId],
    );
    expect(admission.rows[0]?.released_at).toBeInstanceOf(Date);
    expect(admission.rows[0]?.release_kind).toBe('runtime_fenced');
    await expect(admitPageRuntime(pageId, actor, runtimeId)).rejects.toMatchObject({
      statusCode: 409,
      reason: 'runtime_fenced',
    });
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await lockPageLifecycle(client, [pageId]);
      await expect(assertPageFreezeIdle(client, pageId)).resolves.toBeUndefined();
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('serializes a new-page reservation against a crash fence in both effect-start orders', async () => {
    const actor = await insertUser();
    const administrator = await insertUser('admin');
    for (const effectStarted of [false, true]) {
      const pageId = await insertPage(actor, effectStarted ? 'Started before fence' : 'Reserved before fence');
      const revision = await revisionOf(pageId);
      const runtimeId = `race-${effectStarted ? 'started' : 'reserved'}-${randomUUID()}`;
      const intentId = randomUUID();
      await query(
        `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity)
         VALUES ($1, $2::jsonb)`,
        [runtimeId, JSON.stringify({ host: 'partitioned-live', pid: 43, startedAt: new Date().toISOString() })],
      );
      const writer = await getPool().connect();
      try {
        await writer.query('BEGIN');
        await writer.query(
          `SELECT runtime_id FROM page_writer_runtimes WHERE runtime_id = $1 FOR SHARE`,
          [runtimeId],
        );
        await lockPageLifecycle(writer, [pageId]);
        await writer.query(
          `INSERT INTO page_write_intents
             (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect, effect_started_at)
           VALUES ($1, $2, 'baseline.prepare', $3, ARRAY[$4]::integer[], $5::jsonb,
                   'local_verified', $6::jsonb, CASE WHEN $7 THEN NOW() ELSE NULL END)`,
          [
            intentId,
            runtimeId,
            actor,
            pageId,
            JSON.stringify({
              [pageId]: { contentRevision: revision.content, lifecycleRevision: revision.lifecycle },
            }),
            JSON.stringify({
              effectClass: 'local',
              baselineId: randomUUID(),
              intendedStateDigest: '6'.repeat(64),
              intendedSize: 1,
            }),
            effectStarted,
          ],
        );
        const fencing = fencePageWriterRuntime({
          mode: 'durable_no_started_effects',
          runtimeId,
          actorId: administrator,
          reason: 'Deterministic runtime serialization race exercises the durable marker',
        });
        const fenceBlocked = await waitForDatabaseCondition(async () => {
          const activity = await query<{ exists: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
                WHERE wait_event_type = 'Lock'
                  AND query LIKE '%SELECT fenced_at, quiescence_ack::text, deployment_identity%'
             ) AS exists`,
          );
          return activity.rows[0]?.exists === true;
        });
        expect(fenceBlocked).toBe(true);
        await writer.query('COMMIT');
        if (effectStarted) {
          await expect(fencing).rejects.toMatchObject({
            statusCode: 409,
            reason: 'runtime_effects_started',
          });
          expect((await intentState(intentId)).status).toBe('pending');
          await assertFreezeBusy(pageId);
        } else {
          await expect(fencing).resolves.toEqual({ unresolvedIntents: 0 });
          expect((await intentState(intentId)).status).toBe('cancelled');
        }
      } finally {
        await writer.query('ROLLBACK').catch(() => undefined);
        writer.release();
      }
    }
  });

  it('claims recovery before verification and durably attributes same-runtime retries', async () => {
    const originalWriter = await insertUser();
    const fenceAdministrator = await insertUser('admin');
    const claimantAdministrator = await insertUser('admin');
    const retryingAdministrator = await insertUser('admin');
    let observedState: 'partial' | 'applied' = 'partial';
    let repairRuns = 0;
    let failingRepairFixture: string | null = null;
    registerPageWriteIntentReconciler(
      'icon.image.put',
      async () => {
        if (observedState === 'partial') {
          return { outcome: 'repair_required' as const, observedState: 'partially_applied' as const };
        }
        return {
          outcome: 'applied' as const,
          proof: {
            kind: 'local_bytes_verified' as const,
            observedAt: new Date().toISOString(),
            reference: 'icon:exact-repair',
            details: {
              syscallSettled: true as const,
              intendedStateDigest: '5'.repeat(64),
              observedStateDigest: '5'.repeat(64),
              intendedSize: 1,
              observedSize: 1,
            },
          },
          result: undefined,
        };
      },
      async (intent) => {
        repairRuns += 1;
        if (failingRepairFixture) {
          const actingAdministrator = intent.recoveryHistory.at(-1)?.actorId;
          await appendFile(failingRepairFixture, `${String(actingAdministrator)}\n`);
          throw new Error('fixture repair failed after its filesystem effect');
        }
        observedState = 'applied';
      },
    );

    const createFencedIntent = async (pageId: number): Promise<PageWriteIntent> => {
      const revision = await revisionOf(pageId);
      const runtimeId = `repair-origin-${randomUUID()}`;
      const acknowledgmentId = randomUUID();
      const intentId = randomUUID();
      await query(
        `INSERT INTO page_writer_runtimes
           (runtime_id, deployment_identity, quiesced_at, quiescence_ack)
         VALUES ($1, $2::jsonb, NOW(), $3)`,
        [
          runtimeId,
          JSON.stringify({ host: 'terminated-origin', pid: 44, startedAt: new Date().toISOString() }),
          acknowledgmentId,
        ],
      );
      await query(
        `INSERT INTO page_write_intents
           (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect,
            effect_started_at)
         VALUES ($1, $2, 'icon.image.put', $3, ARRAY[$4]::integer[], $5::jsonb,
                 'local_verified', $6::jsonb, NOW())`,
        [
          intentId,
          runtimeId,
          originalWriter,
          pageId,
          JSON.stringify({
            [pageId]: { contentRevision: revision.content, lifecycleRevision: revision.lifecycle },
          }),
          JSON.stringify({ effectClass: 'local', identity: `icon:${pageId}`, sha256: '5'.repeat(64) }),
        ],
      );
      await fencePageWriterRuntime({
        mode: 'owner_ack',
        runtimeId,
        acknowledgmentId,
        actorId: fenceAdministrator,
        reason: 'The original test runtime acknowledged quiescence before local repair',
      });
      return {
        id: intentId,
        runtimeId,
        pageIds: [pageId],
        revisions: {
          [pageId]: { contentRevision: revision.content, lifecycleRevision: revision.lifecycle },
        },
      };
    };

    const pageId = await insertPage(originalWriter, 'Repairable local icon');
    const oldToken = await createFencedIntent(pageId);
    const successfulClaimReason =
      'Trusted icon verifier found exact partial state and selected its registered repairer';
    await expect(
      reconcilePageWriteIntent(oldToken.id, {
        actorId: claimantAdministrator,
        reason: successfulClaimReason,
      }),
    ).resolves.toEqual({ intentId: oldToken.id, status: 'reconciled_applied' });
    expect(repairRuns).toBe(1);
    const repaired = await query<{
      actor_id: string;
      runtime_id: string;
      recovery_history: Array<Record<string, unknown>>;
      effect_started_at: Date | null;
      settled_by: string | null;
    }>(
      `SELECT actor_id, runtime_id, recovery_history, effect_started_at, settled_by
         FROM page_write_intents WHERE id = $1`,
      [oldToken.id],
    );
    expect(repaired.rows[0]?.runtime_id).not.toBe(oldToken.runtimeId);
    expect(repaired.rows[0]?.effect_started_at).toBeInstanceOf(Date);
    expect(repaired.rows[0]).toMatchObject({
      actor_id: originalWriter,
      settled_by: claimantAdministrator,
    });
    expect(repaired.rows[0]?.recovery_history).toEqual([
      expect.objectContaining({
        attemptKind: 'runtime_transfer',
        fromRuntimeId: oldToken.runtimeId,
        actorId: claimantAdministrator,
        reason: successfulClaimReason,
      }),
    ]);
    let staleCallbackRan = false;
    await expect(
      runPageWriteIntentEffect(oldToken, { kind: 'local' }, async () => {
        staleCallbackRan = true;
      }),
    ).rejects.toMatchObject({ statusCode: 409, reason: 'intent_runtime_mismatch' });
    expect(staleCallbackRan).toBe(false);

    observedState = 'partial';
    const stalePageId = await insertPage(originalWriter, 'Stale repair candidate');
    const staleToken = await createFencedIntent(stalePageId);
    await query(`UPDATE pages SET title = 'Unexpected protected mutation' WHERE id = $1`, [stalePageId]);
    await expect(
      reconcilePageWriteIntent(staleToken.id, {
        actorId: claimantAdministrator,
        reason: 'Unexpected protected revision must block ownership transfer and repair',
      }),
    ).rejects.toMatchObject({ statusCode: 409, reason: 'stale_content_revision' });
    expect(repairRuns).toBe(1);
    expect((await query<{ recovery_history: unknown[] }>(
      'SELECT recovery_history FROM page_write_intents WHERE id = $1',
      [staleToken.id],
    )).rows[0]?.recovery_history).toEqual([]);
    expect((await query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
         FROM page_write_recovery_history_segments
        WHERE intent_id = $1`,
      [staleToken.id],
    )).rows[0]?.count).toBe(0);

    const unauthorizedPageId = await insertPage(originalWriter, 'Unauthorized recovery candidate');
    const unauthorizedToken = await createFencedIntent(unauthorizedPageId);
    await expect(reconcilePageWriteIntent(unauthorizedToken.id, {
      actorId: originalWriter,
      reason: 'An ordinary writer must not claim a pending recovery attempt',
    })).rejects.toMatchObject({ statusCode: 403, reason: 'recovery_admin_required' });
    const unauthorizedEvidence = await query<{
      recovery_history: unknown[];
      archived_segments: number;
    }>(
      `SELECT i.recovery_history,
              (
                SELECT COUNT(*)::integer
                  FROM page_write_recovery_history_segments s
                 WHERE s.intent_id = i.id
              ) AS archived_segments
         FROM page_write_intents i
        WHERE i.id = $1`,
      [unauthorizedToken.id],
    );
    expect(unauthorizedEvidence.rows[0]).toEqual({
      recovery_history: [],
      archived_segments: 0,
    });
    expect(repairRuns).toBe(1);

    const repairFixtureDirectory = await mkdtemp(join(tmpdir(), 'page-write-recovery-attribution-'));
    try {
      const repairFixturePath = join(repairFixtureDirectory, 'entered-repairs');
      failingRepairFixture = repairFixturePath;
      observedState = 'partial';
      const retryPageId = await insertPage(originalWriter, 'Same-runtime recovery retry');
      const retryToken = await createFencedIntent(retryPageId);
      const claimantReason = 'Claim recovery and enter the fixture repair before its simulated failure';
      const retryReason = 'Retry recovery under a second administrator before its simulated failure';

      await expect(reconcilePageWriteIntent(retryToken.id, {
        actorId: claimantAdministrator,
        reason: claimantReason,
      })).rejects.toThrow('fixture repair failed after its filesystem effect');
      await expect(reconcilePageWriteIntent(retryToken.id, {
        actorId: retryingAdministrator,
        reason: retryReason,
      })).rejects.toThrow('fixture repair failed after its filesystem effect');

      const unresolved = await query<{
        actor_id: string;
        runtime_id: string;
        status: string;
        settled_by: string | null;
        recovery_history: Array<Record<string, unknown>>;
      }>(
        `SELECT actor_id, runtime_id, status, settled_by, recovery_history
           FROM page_write_intents
          WHERE id = $1`,
        [retryToken.id],
      );
      expect(unresolved.rows[0]).toMatchObject({
        actor_id: originalWriter,
        status: 'pending',
        settled_by: null,
        recovery_history: [
          expect.objectContaining({
            attemptKind: 'runtime_transfer',
            fromRuntimeId: retryToken.runtimeId,
            actorId: claimantAdministrator,
            reason: claimantReason,
          }),
          expect.objectContaining({
            attemptKind: 'same_runtime_retry',
            actorId: retryingAdministrator,
            reason: retryReason,
          }),
        ],
      });
      expect(unresolved.rows[0]?.recovery_history[1]).toMatchObject({
        fromRuntimeId: unresolved.rows[0]?.runtime_id,
        toRuntimeId: unresolved.rows[0]?.runtime_id,
      });
      expect(await readFile(repairFixturePath, 'utf8')).toBe(
        `${claimantAdministrator}\n${retryingAdministrator}\n`,
      );

      // Short reasons reach the entry-count bound independently of byte size.
      const countPageId = await insertPage(originalWriter, 'Count-bounded recovery history');
      const countToken = await createFencedIntent(countPageId);
      const countAttempts = Array.from({ length: 34 }, (_, index) => ({
        actorId: claimantAdministrator,
        reason: `Recover count-bounded segment attempt ${index + 1}`,
      }));
      const countFailures = countAttempts.slice(0, -1);
      for (const attempt of countFailures) {
        await expect(reconcilePageWriteIntent(countToken.id, attempt))
          .rejects.toThrow('fixture repair failed after its filesystem effect');
      }
      failingRepairFixture = null;
      observedState = 'applied';
      await expect(reconcilePageWriteIntent(countToken.id, countAttempts.at(-1)!))
        .resolves.toEqual({ intentId: countToken.id, status: 'reconciled_applied' });
      const countSegments = (await query<{
        recovery_history: Array<{ actorId: string; reason: string }>;
      }>(
        'SELECT recovery_history FROM page_write_recovery_history_segments WHERE intent_id = $1 ORDER BY id',
        [countToken.id],
      )).rows;
      const countActive = (await query<{
        recovery_history: Array<{ actorId: string; reason: string }>;
      }>(
        'SELECT recovery_history FROM page_write_intents WHERE id = $1',
        [countToken.id],
      )).rows[0]!;
      expect(countSegments.map(segment => segment.recovery_history.length)).toEqual([32]);
      expect(countActive.recovery_history).toHaveLength(2);
      expect([
        ...countSegments.flatMap(segment => segment.recovery_history),
        ...countActive.recovery_history,
      ].map(({ actorId, reason }) => ({ actorId, reason }))).toEqual(countAttempts);
      failingRepairFixture = repairFixturePath;

      const archivedActor = await insertUser('admin');
      const rolloverPageId = await insertPage(originalWriter, 'Segmented recovery history');
      const rolloverToken = await createFencedIntent(rolloverPageId);
      const multibyteRun = '界'.repeat(600);
      const attempts = Array.from({ length: 34 }, (_, index) => {
        const prefix = `Accepted recovery attempt ${String(index + 1).padStart(2, '0')}: `;
        const reason = `${prefix}${multibyteRun}${'\u0001'.repeat(
          1000 - prefix.length - multibyteRun.length,
        )}`;
        return {
          actorId: index === 0
            ? archivedActor
            : index % 2 === 0
              ? claimantAdministrator
              : retryingAdministrator,
          reason,
        };
      });
      const transientAttempts = attempts.slice(0, -1);
      expect(transientAttempts).toHaveLength(33);
      expect(attempts.every(({ reason }) => reason.length === 1000)).toBe(true);

      observedState = 'partial';
      for (const attempt of transientAttempts) {
        await expect(reconcilePageWriteIntent(rolloverToken.id, attempt))
          .rejects.toThrow('fixture repair failed after its filesystem effect');
      }
      expect((await readFile(repairFixturePath, 'utf8')).trim().split('\n')).toEqual([
        claimantAdministrator,
        retryingAdministrator,
        ...countFailures.map(({ actorId }) => actorId),
        ...transientAttempts.map(({ actorId }) => actorId),
      ]);
      failingRepairFixture = null;
      observedState = 'applied';
      await expect(reconcilePageWriteIntent(rolloverToken.id, attempts.at(-1)!))
        .resolves.toEqual({ intentId: rolloverToken.id, status: 'reconciled_applied' });

      const archivedSegments = await query<{
        id: string;
        recovery_history: Array<{ actorId: string; reason: string }>;
        encoded_bytes: number;
      }>(
        `SELECT id::text,
                recovery_history,
                octet_length(recovery_history::text) AS encoded_bytes
           FROM page_write_recovery_history_segments
          WHERE intent_id = $1
          ORDER BY archived_at, id`,
        [rolloverToken.id],
      );
      const activeSegment = await query<{
        recovery_history: Array<{ actorId: string; reason: string }>;
        encoded_bytes: number;
      }>(
        `SELECT recovery_history,
                octet_length(recovery_history::text) AS encoded_bytes
           FROM page_write_intents
          WHERE id = $1`,
        [rolloverToken.id],
      );
      expect(archivedSegments.rows.length).toBeGreaterThan(0);
      expect(archivedSegments.rows.some(
        ({ recovery_history }) => recovery_history.length < 32,
      )).toBe(true);
      expect([
        ...archivedSegments.rows,
        activeSegment.rows[0]!,
      ].every(({ recovery_history, encoded_bytes }) =>
        recovery_history.length <= 32 && encoded_bytes <= 65_536
      )).toBe(true);

      const recoveredAttempts = [
        ...archivedSegments.rows.flatMap(({ recovery_history }) => recovery_history),
        ...activeSegment.rows[0]!.recovery_history,
      ];
      expect(recoveredAttempts.map(({ actorId, reason }) => ({ actorId, reason })))
        .toEqual(attempts);

      await query('DELETE FROM users WHERE id = $1', [archivedActor]);
      expect((await query<{
        recovery_history: Array<{ actorId: string }>;
      }>(
        `SELECT recovery_history
           FROM page_write_recovery_history_segments
          WHERE id = $1`,
        [archivedSegments.rows[0]!.id],
      )).rows[0]?.recovery_history[0]?.actorId).toBe(archivedActor);

      await expect(query(
        `UPDATE page_write_recovery_history_segments
            SET archived_at = archived_at
          WHERE id = $1`,
        [archivedSegments.rows[0]!.id],
      )).rejects.toThrow('page write recovery history segments are append-only');
      await expect(query(
        'DELETE FROM page_write_recovery_history_segments WHERE id = $1',
        [archivedSegments.rows[0]!.id],
      )).rejects.toThrow('page write recovery history segments are append-only');
      await expect(query(
        'DELETE FROM page_write_intents WHERE id = $1',
        [rolloverToken.id],
      )).rejects.toMatchObject({ code: '23503' });
    } finally {
      failingRepairFixture = null;
      await rm(repairFixtureDirectory, { recursive: true, force: true });
    }
  });

  it('refuses non-admin quiescence before closing the process write gate', async () => {
    const actor = await insertUser();
    const pageId = await insertPage(actor, 'Write after refused quiescence');

    await expect(quiescePageWriterRuntime({
      actorId: actor,
      reason: 'An ordinary writer cannot retire the process epoch',
    })).rejects.toMatchObject({ statusCode: 403, reason: 'recovery_admin_required' });

    expect((await query(
      `SELECT 1 FROM audit_log
        WHERE user_id = $1 AND metadata->>'action' = 'page_writer_quiesce_requested'`,
      [actor],
    )).rows).toEqual([]);

    await expect(withPageWriteTransaction([pageId], async (client) => {
      await client.query(`UPDATE pages SET title = 'Gate remained usable' WHERE id = $1`, [pageId]);
    })).resolves.toBeUndefined();
    expect((await query<{ title: string }>('SELECT title FROM pages WHERE id = $1', [pageId]))
      .rows[0]!.title).toBe('Gate remained usable');
  });

  it('keeps admitted multi-phase continuations owned until final settlement during quiescence', async () => {
    const actor = await insertUser();
    const administrator = await insertUser('admin');
    const pageId = await insertPage(actor, 'Phased attachment');
    const completionPageId = await insertPage(actor, 'Completion retry');
    const cancelledPageId = await insertPage(actor, 'No-start cancellation');
    const uncommittedPageId = await insertPage(actor, 'Caller-owned no-start cancellation');
    const terminalPageId = await insertPage(actor, 'Unversioned remote recovery');
    const recoveryPageId = await insertPage(actor, 'Local recovery');
    const sqlPageId = await insertPage(actor, 'SQL-only writer after quiescence');
    const intendedDigest = '9'.repeat(64);
    const recoveryIntent = await reservePageWriteIntent({
      pageIds: [recoveryPageId],
      kind: 'baseline.prepare',
      actorId: actor,
      effect: {
        effectClass: 'local',
        baselineId: randomUUID(),
        intendedStateDigest: intendedDigest,
        intendedSize: 4,
      },
    });
    await expect(
      runPageWriteIntentEffect(recoveryIntent, { kind: 'local' }, async () => {
        throw new Error('fsync result lost');
      }),
    ).rejects.toThrow('fsync result lost');

    const terminalIntent = await reservePageWriteIntent({
      pageIds: [terminalPageId],
      kind: 'attachment.confluence.put',
      actorId: actor,
      effect: {
        effectClass: 'remote',
        remotePageId: 'conf-attachment-42',
        files: [{ filename: 'diagram.png', size: 4, sha256: '8'.repeat(64) }],
      },
    });
    await expect(
      runPageWriteIntentEffect(
        terminalIntent,
        { kind: 'remote', completesRemoteWork: true },
        async () => {
          throw new Error('attachment response lost');
        },
      ),
    ).rejects.toThrow('attachment response lost');
    let unversionedReplayStarted = false;
    await expect(
      runPageWriteIntentEffect(
        terminalIntent,
        { kind: 'remote', completesRemoteWork: true },
        async () => {
          unversionedReplayStarted = true;
        },
      ),
    ).rejects.toMatchObject({ statusCode: 409, reason: 'intent_outcome_unknown' });
    expect(unversionedReplayStarted).toBe(false);

    const phasedIntent = await reservePageWriteIntent({
      pageIds: [pageId],
      kind: 'attachment.confluence.put',
      actorId: actor,
      effect: {
        effectClass: 'remote',
        remotePageId: 'conf-phased-attachment',
        files: [{ filename: 'diagram.png', size: 4, sha256: '7'.repeat(64) }],
      },
    });
    let stageRuns = 0;
    await runPageWriteIntentEffect(phasedIntent, { kind: 'local' }, async () => {
      stageRuns += 1;
    });
    const stagedMarkers = await query<{
      effect_started_at: Date | null;
      remote_effect_started_at: Date | null;
      remote_effects_completed_at: Date | null;
    }>(
      `SELECT effect_started_at, remote_effect_started_at, remote_effects_completed_at
         FROM page_write_intents WHERE id = $1`,
      [phasedIntent.id],
    );
    expect(stagedMarkers.rows[0]).toMatchObject({
      effect_started_at: expect.any(Date),
      remote_effect_started_at: null,
      remote_effects_completed_at: null,
    });

    const completionIntent = await reservePageWriteIntent({
      pageIds: [completionPageId],
      kind: 'attachment.confluence.put',
      actorId: actor,
      effect: {
        effectClass: 'remote',
        remotePageId: 'conf-completion-retry',
        files: [{ filename: 'retry.png', size: 4, sha256: '6'.repeat(64) }],
      },
    });
    await runPageWriteIntentEffect(
      completionIntent,
      { kind: 'remote', completesRemoteWork: true },
      async () => undefined,
    );

    const cancelledIntent = await reservePageWriteIntent({
      pageIds: [cancelledPageId],
      kind: 'attachment.confluence.put',
      actorId: actor,
      effect: {
        effectClass: 'remote',
        remotePageId: 'conf-never-started',
        files: [{ filename: 'cancelled.png', size: 4, sha256: '5'.repeat(64) }],
      },
    });

    const reservationClient = await getPool().connect();
    let reservationClientReleased = false;
    let uncommittedIntent: PageWriteIntent;
    try {
      await reservationClient.query('BEGIN');
      uncommittedIntent = await reservePageWriteIntentInTransaction(reservationClient, {
        pageIds: [uncommittedPageId],
        kind: 'attachment.confluence.put',
        actorId: actor,
        effect: {
          effectClass: 'remote',
          remotePageId: 'conf-uncommitted-no-start',
          files: [{ filename: 'uncommitted.png', size: 4, sha256: '4'.repeat(64) }],
        },
      });

      let acknowledgmentResolved = false;
      const quiescing = quiescePageWriterRuntime({
        actorId: administrator,
        reason: 'Drain admitted continuations before retiring this process epoch',
      }).then((acknowledgment) => {
        acknowledgmentResolved = true;
        return acknowledgment;
      });
      // Authorization is asynchronous. Observe the closed gate rather than
      // assuming one event-loop turn includes the administrator/audit commit.
      await expect.poll(async () => {
        try {
          await withPageWriteTransaction([sqlPageId], async () => undefined);
          return null;
        } catch (error) {
          if (!(error instanceof PageWriteError)) throw error;
          return error.reason;
        }
      }).toBe('runtime_quiescing');
      await reservationClient.query('COMMIT');
      reservationClient.release();
      reservationClientReleased = true;

      // A refused tokenless transaction is the explicit barrier proving the
      // gate is closed while the successful phased intent remains unsettled.
      await expect(
        withPageWriteTransaction([sqlPageId], async () => undefined),
      ).rejects.toMatchObject({ statusCode: 409, reason: 'runtime_quiescing' });
      await expect(admitPageRuntime(sqlPageId, actor)).rejects.toMatchObject({
        statusCode: 409,
        reason: 'runtime_quiescing',
      });
      await expect(
        reservePageWriteIntent({
          pageIds: [sqlPageId],
          kind: 'attachment.local.put',
          actorId: actor,
          effect: { effectClass: 'local', filenames: ['new-work.txt'] },
        }),
      ).rejects.toMatchObject({ statusCode: 409, reason: 'runtime_quiescing' });
      let cancelledEffectStarted = false;
      await expect(
        runPageWriteIntentEffect(cancelledIntent, { kind: 'local' }, async () => {
          cancelledEffectStarted = true;
        }),
      ).rejects.toMatchObject({ statusCode: 409, reason: 'runtime_quiescing' });
      expect(cancelledEffectStarted).toBe(false);
      expect(acknowledgmentResolved).toBe(false);

      let remoteRuns = 0;
      await runPageWriteIntentEffect(
        phasedIntent,
        { kind: 'remote', completesRemoteWork: true },
        async () => {
          remoteRuns += 1;
        },
      );
      expect(acknowledgmentResolved).toBe(false);

      let activationRuns = 0;
      await runPageWriteIntentEffect(phasedIntent, { kind: 'local' }, () => {
        activationRuns += 1;
        return advancePageWriteIntent(phasedIntent, async (client) => {
          await client.query(`UPDATE pages SET title = 'Attachment activated' WHERE id = $1`, [pageId]);
        });
      });
      expect(acknowledgmentResolved).toBe(false);

      let completionAttempts = 0;
      await expect(
        completePageWriteIntent(completionIntent, async (client) => {
          completionAttempts += 1;
          await client.query(`UPDATE pages SET title = 'Rolled back completion' WHERE id = $1`, [
            completionPageId,
          ]);
          throw new Error('final SQL failed');
        }),
      ).rejects.toThrow('final SQL failed');
      expect(acknowledgmentResolved).toBe(false);
      expect(
        (await query<{ title: string }>('SELECT title FROM pages WHERE id = $1', [completionPageId]))
          .rows[0]!.title,
      ).toBe('Completion retry');

      let finalSqlRuns = 0;
      await completePageWriteIntent(phasedIntent, async (client) => {
        finalSqlRuns += 1;
        await client.query(`UPDATE pages SET body_text = 'Attachment settled' WHERE id = $1`, [pageId]);
      });
      expect(acknowledgmentResolved).toBe(false);
      await completePageWriteIntent(completionIntent, async (client) => {
        completionAttempts += 1;
        await client.query(`UPDATE pages SET title = 'Completion settled' WHERE id = $1`, [
          completionPageId,
        ]);
      });

      const acknowledgment = await quiescing;
      expect(acknowledgmentResolved).toBe(true);
      expect({ stageRuns, remoteRuns, activationRuns, finalSqlRuns, completionAttempts }).toEqual({
        stageRuns: 1,
        remoteRuns: 1,
        activationRuns: 1,
        finalSqlRuns: 1,
        completionAttempts: 2,
      });
      expect(cancelledEffectStarted).toBe(false);
      expect(await intentState(phasedIntent.id)).toMatchObject({ status: 'completed' });
      expect(await intentState(completionIntent.id)).toMatchObject({ status: 'completed' });
      expect(await intentState(cancelledIntent.id)).toMatchObject({ status: 'cancelled' });
      expect(await intentState(uncommittedIntent.id)).toMatchObject({ status: 'cancelled' });
      const quiescenceCancellations = await query<{
        id: string;
        actor_id: string;
        settled_by: string | null;
        settlement_reason: string | null;
      }>(
        `SELECT id, actor_id, settled_by, settlement_reason
           FROM page_write_intents
          WHERE id = ANY($1::uuid[])`,
        [[cancelledIntent.id, uncommittedIntent.id]],
      );
      expect(quiescenceCancellations.rows).toHaveLength(2);
      expect(quiescenceCancellations.rows).toEqual(expect.arrayContaining([
        {
          id: cancelledIntent.id,
          actor_id: actor,
          settled_by: administrator,
          settlement_reason: 'before_effect',
        },
        {
          id: uncommittedIntent.id,
          actor_id: actor,
          settled_by: administrator,
          settlement_reason: 'before_effect',
        },
      ]));
      expect(
        (await query<{ title: string; body_text: string; content_revision: string }>(
          'SELECT title, body_text, content_revision::text FROM pages WHERE id = $1',
          [pageId],
        )).rows[0],
      ).toEqual({
        title: 'Attachment activated',
        body_text: 'Attachment settled',
        content_revision: '2',
      });
      expect(
        (await query<{ title: string }>('SELECT title FROM pages WHERE id = $1', [completionPageId]))
          .rows[0]!.title,
      ).toBe('Completion settled');
      expect(
        (await query<{ title: string }>('SELECT title FROM pages WHERE id = $1', [sqlPageId]))
          .rows[0]!.title,
      ).toBe('SQL-only writer after quiescence');

      await fencePageWriterRuntime({
        mode: 'owner_ack',
        runtimeId: acknowledgment.runtimeId,
        acknowledgmentId: acknowledgment.acknowledgmentId,
        actorId: administrator,
        reason: 'Owner process drained admitted continuations and closed its external-effect gate',
      });
    } finally {
      if (!reservationClientReleased) {
        await reservationClient.query('ROLLBACK').catch(() => undefined);
        reservationClient.release();
      }
    }

    for (const intent of [terminalIntent, recoveryIntent]) {
      await expect(
        reconcilePageWriteIntent(intent.id, {
          actorId: administrator,
          reason: 'A quiesced runtime must not start recovery callbacks for its own retired epoch',
        }),
      ).rejects.toMatchObject({ statusCode: 409, reason: 'runtime_quiescing' });
      expect((await intentState(intent.id)).status).toBe('pending');
      await assertFreezeBusy(intent.pageIds[0]!);
    }
  });
});
