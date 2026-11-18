import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables, waitForDatabaseCondition,
} from '../../../../test-db-helper.js';
import { getPool, query, runMigrations } from '../../postgres.js';
import {
  admitPageRuntime,
  fencePageWriterRuntime,
  getPageWriterRuntimeId,
  PageWriteError,
  quiescePageWriterRuntime,
  releasePageRuntime,
  reconcilePageWriteIntent,
  registerPageWriteIntentReconciler,
} from '../../../services/page-write-admission.js';
import { capturePageWriterDeploymentIdentity } from '../../../services/page-writer-process-identity.js';

/**
 * #2063 — migration 151b retires the writer epochs a stopped deployment left
 * behind, so the one-time migration 152 cutover can run without manual SQL.
 *
 * These cases execute the REAL migration runner, not copies of its statements:
 * they un-apply 151b/152 (schema plus `_migrations` rows) to rebuild the exact
 * state a container restart sees, then let `runMigrations()` replay both files.
 */

const MIGRATION_151B = '151b_page_writer_upgrade_retirement.sql';
const MIGRATION_152 = '152_relocation_notion_identity.sql';

const dbAvailable = await isDbAvailable();

/** Rebuild the pre-151b schema so the runner applies it again. */
async function unapply151b(): Promise<void> {
  await query('ALTER TABLE page_writer_runtimes DROP CONSTRAINT IF EXISTS page_writer_runtimes_retirement_state_check');
  await query('ALTER TABLE page_writer_runtimes DROP COLUMN IF EXISTS upgrade_retired_at');
  await query('ALTER TABLE page_writer_runtimes DROP CONSTRAINT IF EXISTS page_writer_runtimes_check');
  await query(`ALTER TABLE page_writer_runtimes ADD CONSTRAINT page_writer_runtimes_check CHECK (
    (quiesced_at IS NULL AND quiescence_ack IS NULL)
    OR (quiesced_at IS NOT NULL AND quiescence_ack IS NOT NULL))`);
  await query('ALTER TABLE page_runtime_admissions DROP CONSTRAINT IF EXISTS page_runtime_admissions_release_kind_check');
  await query(`ALTER TABLE page_runtime_admissions ADD CONSTRAINT page_runtime_admissions_release_kind_check
    CHECK (release_kind IN ('clean_disconnect', 'runtime_fenced'))`);
  await query('DELETE FROM _migrations WHERE name = $1', [MIGRATION_151B]);
}

/** Rebuild the pre-152 schema so the runner applies it again. */
async function unapply152(): Promise<void> {
  await query('ALTER TABLE page_relocation_preparations DROP COLUMN IF EXISTS original_notion_page_id');
  await query('DROP INDEX IF EXISTS pages_notion_page_id_owner_live_uidx');
  await query(`CREATE UNIQUE INDEX pages_notion_page_id_owner_live_uidx ON pages
    (created_by_user_id, (lower(replace(notion_page_id, '-', ''))))
    WHERE notion_page_id IS NOT NULL AND deleted_at IS NULL`);
  await query('DELETE FROM _migrations WHERE name = $1', [MIGRATION_152]);
}

async function insertAdmin(): Promise<string> {
  return (await query<{ id: string }>(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'test-only', 'admin') RETURNING id",
    [`upgrade-retirement-admin-${randomUUID()}`],
  )).rows[0]!.id;
}

async function insertPage(owner: string): Promise<number> {
  return (await query<{ id: number }>(
    `INSERT INTO pages (title, source, space_key, created_by_user_id, visibility,
       body_html, body_storage, body_text, version, ai_policy, ai_policy_revision,
       expected_image_files, expected_drawio_files)
     VALUES ($1, 'standalone', 'LOCAL', $2, 'shared', '<p>x</p>', '<p>x</p>', 'x', 1, 'all', 1, NULL, NULL)
     RETURNING id`,
    [`retirement-page-${randomUUID()}`, owner],
  )).rows[0]!.id;
}

async function insertRuntime(options: {
  runtimeId: string;
  deploymentIdentity?: Record<string, unknown>;
  enforcementVersion?: number;
}): Promise<void> {
  await query(
    `INSERT INTO page_writer_runtimes
       (runtime_id, deployment_identity, enforcement_version, ai_policy_enforcement_version)
     VALUES ($1, $2::jsonb, $3, 1)`,
    [
      options.runtimeId,
      JSON.stringify(options.deploymentIdentity ?? {
        host: 'killed-container', pid: 1, startedAt: '2026-11-18T07:00:00.000Z',
      }),
      options.enforcementVersion ?? 1,
    ],
  );
}

async function insertAdmission(runtimeId: string, pageId: number): Promise<string> {
  return (await query<{ id: string }>(
    `INSERT INTO page_runtime_admissions (runtime_id, page_id, lifecycle_revision, purpose)
     VALUES ($1, $2, 0, 'collab_room') RETURNING id`,
    [runtimeId, pageId],
  )).rows[0]!.id;
}

async function insertIntent(options: {
  runtimeId: string;
  pageId: number;
  kind: string;
  effectClass: 'local' | 'remote';
  recoveryMode: 'local_verified' | 'remote_terminal_only' | 'remote_conditional';
  effectStarted: boolean;
}): Promise<string> {
  // A started intent carries the revisions it was admitted at; recovery's
  // token check refuses an intent that omits its own page.
  const page = (await query<{ content_revision: string; lifecycle_revision: string }>(
    'SELECT content_revision::text, lifecycle_revision::text FROM pages WHERE id = $1', [options.pageId],
  )).rows[0]!;
  const revisions = {
    [options.pageId]: {
      contentRevision: page.content_revision,
      lifecycleRevision: page.lifecycle_revision,
    },
  };
  return (await query<{ id: string }>(
    `INSERT INTO page_write_intents
       (runtime_id, kind, page_ids, revisions, recovery_mode, effect, effect_started_at)
     VALUES ($1, $2, $3::int[], $4::jsonb, $5, $6::jsonb, CASE WHEN $7::boolean THEN NOW() END)
     RETURNING id`,
    [
      options.runtimeId, options.kind, [options.pageId], JSON.stringify(revisions), options.recoveryMode,
      JSON.stringify({ effectClass: options.effectClass }), options.effectStarted,
    ],
  )).rows[0]!.id;
}

type RuntimeRow = {
  runtime_id: string;
  fenced_at: Date | null;
  quiesced_at: Date | null;
  quiescence_ack: string | null;
  upgrade_retired_at: Date | null;
  fence_reason: string | null;
  fence_proof: Record<string, unknown> | null;
};

async function runtimeRow(runtimeId: string): Promise<RuntimeRow> {
  return (await query<RuntimeRow>(
    `SELECT runtime_id, fenced_at, quiesced_at, quiescence_ack::text, upgrade_retired_at,
            fence_reason, fence_proof
       FROM page_writer_runtimes WHERE runtime_id = $1`,
    [runtimeId],
  )).rows[0]!;
}

async function admissionRow(id: string) {
  return (await query<{ released_at: Date | null; release_kind: string | null }>(
    'SELECT released_at, release_kind FROM page_runtime_admissions WHERE id = $1', [id],
  )).rows[0]!;
}

async function intentRow(id: string) {
  return (await query<{
    status: string; settled_at: Date | null; settled_by: string | null;
    settlement_reason: string | null; settlement_proof: Record<string, unknown> | null;
    effect_started_at: Date | null; recovery_started_at: Date | null;
  }>(
    `SELECT status, settled_at, settled_by, settlement_reason, settlement_proof,
            effect_started_at, recovery_started_at
       FROM page_write_intents WHERE id = $1`,
    [id],
  )).rows[0]!;
}

/** The exact killed-container state: unfenced epoch, room token, work in flight. */
async function blockedInstallFixture(options: {
  noStart: boolean;
  deploymentIdentity?: Record<string, unknown>;
  enforcementVersion?: number;
}): Promise<{ runtimeId: string; pageId: number; admissionId: string; intentId: string }> {
  const owner = await insertAdmin();
  const pageId = await insertPage(owner);
  const runtimeId = `killed-${options.noStart ? 'no-start' : 'started'}-${randomUUID()}`;
  await insertRuntime({
    runtimeId,
    deploymentIdentity: options.deploymentIdentity,
    enforcementVersion: options.enforcementVersion,
  });
  return {
    runtimeId,
    pageId,
    admissionId: await insertAdmission(runtimeId, pageId),
    intentId: await insertIntent({
      runtimeId, pageId,
      kind: options.noStart ? 'baseline.prepare' : 'attachment.local.put',
      effectClass: 'local',
      recoveryMode: 'local_verified',
      effectStarted: !options.noStart,
    }),
  };
}

beforeAll(async () => {
  if (!dbAvailable) return;
  await setupTestDb();
  await truncateAllTables();
});

afterAll(async () => {
  if (!dbAvailable) return;
  // Leave the schema as every later file expects it.
  await runMigrations();
  await teardownTestDb();
});

describe.skipIf(!dbAvailable)('151b upgrade writer retirement (#2063)', () => {
  it('retires a killed container without manual SQL, in the two truthful shapes', async () => {
    await truncateAllTables();
    await unapply151b();
    await unapply152();
    const noStart = await blockedInstallFixture({ noStart: true });
    const started = await blockedInstallFixture({ noStart: false });
    const actor = await insertAdmin();

    await runMigrations();

    // No dispatched work: the identical server-verified no-start fence.
    const fenced = await runtimeRow(noStart.runtimeId);
    expect(fenced).toMatchObject({
      fenced_at: expect.any(Date),
      quiesced_at: expect.any(Date),
      quiescence_ack: null,
      fence_proof: expect.objectContaining({ kind: 'durable_no_started_effects' }),
    });
    expect(fenced.upgrade_retired_at).toEqual(fenced.quiesced_at);
    expect(fenced.fence_reason!.length).toBeGreaterThanOrEqual(10);
    expect(fenced.fence_reason!.length).toBeLessThanOrEqual(1000);
    expect(await admissionRow(noStart.admissionId)).toMatchObject({
      released_at: expect.any(Date), release_kind: 'runtime_fenced',
    });
    expect(await intentRow(noStart.intentId)).toMatchObject({
      status: 'cancelled',
      settled_at: expect.any(Date),
      settled_by: null,
      settlement_reason: 'runtime_fenced_before_effect',
      settlement_proof: { assertion: 'durable_no_started_effects' },
    });

    // Started work: gate closed, never fenced, intent kept as recovery evidence.
    const closed = await runtimeRow(started.runtimeId);
    expect(closed).toMatchObject({
      fenced_at: null,
      quiesced_at: expect.any(Date),
      quiescence_ack: null,
    });
    expect(closed.upgrade_retired_at).toEqual(closed.quiesced_at);
    expect(await admissionRow(started.admissionId)).toMatchObject({
      released_at: expect.any(Date), release_kind: 'upgrade_retired',
    });
    expect(await intentRow(started.intentId)).toMatchObject({
      status: 'pending', settled_at: null, settlement_reason: null,
      effect_started_at: expect.any(Date),
    });

    // The gate both states close is enforced by the database against the epoch.
    for (const [fixture, reason] of [
      [noStart, 'runtime_fenced'],
      [started, 'runtime_quiesced'],
    ] as const) {
      await expect(admitPageRuntime(fixture.pageId, actor, 'collab_room', fixture.runtimeId))
        .rejects.toMatchObject({ reason });
    }

    const audits = await query<{ resource_id: string; metadata: Record<string, unknown> }>(
      "SELECT resource_id, metadata FROM audit_log WHERE action = 'PAGE_WRITER_UPGRADE_RETIREMENT' ORDER BY resource_id",
    );
    expect(audits.rows.map((row) => row.resource_id).sort())
      .toEqual([noStart.runtimeId, started.runtimeId].sort());
    expect(audits.rows.find((row) => row.resource_id === started.runtimeId)!.metadata)
      .toEqual({ mode: 'gate_closed_started_work', startedIntents: 1, by: 'migration_151b' });

    // The one-time 152 cutover actually ran after the retirement.
    expect((await query('SELECT 1 FROM _migrations WHERE name = $1', [MIGRATION_152])).rowCount).toBe(1);
  });

  it('keeps started work unrecoverable until a termination-verified fence', async () => {
    const identity = await capturePageWriterDeploymentIdentity();
    // Same host/boot/PID namespace as this test process, with a dead PID:
    // exactly what `verified_local_termination` needs.
    const deadIdentity = {
      ...identity,
      pid: 2_147_483_647,
      processProof: identity.processProof
        ? { ...identity.processProof, startIdentity: '1' }
        : null,
    };
    await truncateAllTables();
    await unapply151b();
    await unapply152();
    const owner = await insertAdmin();
    const pageId = await insertPage(owner);
    const runtimeId = `killed-started-recovery-${randomUUID()}`;
    await insertRuntime({ runtimeId, deploymentIdentity: deadIdentity as unknown as Record<string, unknown> });
    await insertAdmission(runtimeId, pageId);
    const intentId = await insertIntent({
      runtimeId, pageId, kind: 'attachment.local.put',
      effectClass: 'local', recoveryMode: 'local_verified', effectStarted: true,
    });
    await runMigrations();

    const receipt: string[] = [];
    registerPageWriteIntentReconciler('attachment.local.put', async () => {
      receipt.push('reached');
      throw new PageWriteError(409, 'controlled_verifier_evidence_missing', 'Stop after the fence gate');
    });

    await expect(reconcilePageWriteIntent(intentId, {
      actorId: owner, reason: 'Started unknown outcome must not be reconciled without a fence',
    })).rejects.toMatchObject({ reason: 'runtime_not_safely_fenced' });

    // No owner acknowledgment exists, so neither the app nor the fence CHECK
    // can turn this into an owner_ack fence.
    await expect(fencePageWriterRuntime({
      mode: 'owner_ack', runtimeId, acknowledgmentId: randomUUID(), actorId: owner,
      reason: 'A migration-closed epoch has no owner acknowledgment to present',
    })).rejects.toMatchObject({ reason: 'runtime_not_quiesced' });
    await expect(query(
      `UPDATE page_writer_runtimes
          SET fenced_at = NOW(), fence_reason = 'Forbidden fabricated owner acknowledgment',
              fence_proof = '{"kind":"owner_quiescence_ack"}'::jsonb
        WHERE runtime_id = $1`, [runtimeId],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(fencePageWriterRuntime({
      mode: 'durable_no_started_effects', runtimeId, actorId: owner,
      reason: 'Dispatched work cannot be retired from no-start evidence',
    })).rejects.toMatchObject({ reason: 'runtime_effects_started' });

    if (identity.processProof) {
      await expect(fencePageWriterRuntime({
        mode: 'verified_local_termination', runtimeId, actorId: owner,
        reason: 'This local kernel scope proves the original writer process is gone',
      })).resolves.toEqual({ unresolvedIntents: 1 });
      await expect(reconcilePageWriteIntent(intentId, {
        actorId: owner, reason: 'The original runtime is terminally fenced and may be reconciled',
      })).rejects.toMatchObject({ reason: 'controlled_verifier_evidence_missing' });
      expect(receipt).toEqual(['reached']);
    } else {
      await expect(fencePageWriterRuntime({
        mode: 'verified_local_termination', runtimeId, actorId: owner,
        reason: 'Hardened host process identity cannot be verified here',
      })).rejects.toMatchObject({ reason: 'runtime_termination_unverified' });
      expect(receipt).toEqual([]);
    }
    expect(await intentRow(intentId)).toMatchObject({ status: 'pending' });
  });

  it('matches the server no-start fence shape for cancelled reservations and room tokens', async () => {
    // Scoped to the fixture: other cases in this file leave epochs behind.
    const snapshot = async (runtimeId: string) => ({
      fences: (await query<{ kind: string | null; ack: string | null; fenced: boolean }>(
        `SELECT fence_proof->>'kind' AS kind, quiescence_ack::text AS ack, fenced_at IS NOT NULL AS fenced
           FROM page_writer_runtimes WHERE runtime_id = $1`,
        [runtimeId],
      )).rows,
      admissions: (await query<{ release_kind: string | null; released: boolean }>(
        `SELECT release_kind, released_at IS NOT NULL AS released
           FROM page_runtime_admissions WHERE runtime_id = $1 ORDER BY id`,
        [runtimeId],
      )).rows,
      intents: (await query<{
        status: string; settlement_reason: string | null; settlement_proof: Record<string, unknown> | null;
      }>(
        `SELECT status, settlement_reason, settlement_proof
           FROM page_write_intents WHERE runtime_id = $1 ORDER BY id`,
        [runtimeId],
      )).rows,
    });

    // Control: the existing server-verified API fence.
    await truncateAllTables();
    await unapply151b();
    await unapply152();
    const owner = await insertAdmin();
    const pageId = await insertPage(owner);
    const controlRuntime = `control-${randomUUID()}`;
    await insertRuntime({ runtimeId: controlRuntime });
    await insertAdmission(controlRuntime, pageId);
    await insertIntent({
      runtimeId: controlRuntime, pageId, kind: 'baseline.prepare',
      effectClass: 'local', recoveryMode: 'local_verified', effectStarted: false,
    });
    await fencePageWriterRuntime({
      mode: 'durable_no_started_effects', runtimeId: controlRuntime, actorId: owner,
      reason: 'Retire a crashed epoch that dispatched no external work',
    });
    const apiShape = await snapshot(controlRuntime);

    // Subject: the same fixture retired by the upgrade.
    await truncateAllTables();
    await unapply151b();
    await unapply152();
    const subjectOwner = await insertAdmin();
    const subjectPageId = await insertPage(subjectOwner);
    const subjectRuntime = `subject-${randomUUID()}`;
    await insertRuntime({ runtimeId: subjectRuntime });
    await insertAdmission(subjectRuntime, subjectPageId);
    await insertIntent({
      runtimeId: subjectRuntime, pageId: subjectPageId, kind: 'baseline.prepare',
      effectClass: 'local', recoveryMode: 'local_verified', effectStarted: false,
    });
    await runMigrations();
    const upgradeShape = await snapshot(subjectRuntime);

    expect(upgradeShape.fences).toEqual(apiShape.fences);
    expect(upgradeShape.admissions).toEqual(apiShape.admissions);
    expect(upgradeShape.intents).toEqual(apiShape.intents);
  });

  it('is idempotent: a re-run of the retirement changes no writer state', async () => {
    // Settle any epoch an earlier case left active, so the comparison is two
    // consecutive retirement runs rather than "first run vs. second run".
    await runMigrations();
    const before = {
      runtimes: (await query('SELECT to_jsonb(r) AS value FROM page_writer_runtimes r ORDER BY runtime_id')).rows,
      admissions: (await query('SELECT to_jsonb(a) AS value FROM page_runtime_admissions a ORDER BY id')).rows,
      intents: (await query('SELECT to_jsonb(i) AS value FROM page_write_intents i ORDER BY id')).rows,
    };
    await unapply152();
    await query('DELETE FROM _migrations WHERE name = $1', [MIGRATION_151B]);
    await runMigrations();
    expect((await query('SELECT to_jsonb(r) AS value FROM page_writer_runtimes r ORDER BY runtime_id')).rows)
      .toEqual(before.runtimes);
    expect((await query('SELECT to_jsonb(a) AS value FROM page_runtime_admissions a ORDER BY id')).rows)
      .toEqual(before.admissions);
    expect((await query('SELECT to_jsonb(i) AS value FROM page_write_intents i ORDER BY id')).rows)
      .toEqual(before.intents);
  });

  it('leaves an install that already recorded 152 untouched', async () => {
    await truncateAllTables();
    const fixture = await blockedInstallFixture({ noStart: false });
    const before = {
      runtime: (await query('SELECT to_jsonb(r) AS value FROM page_writer_runtimes r WHERE runtime_id = $1',
        [fixture.runtimeId])).rows,
      admission: (await query('SELECT to_jsonb(a) AS value FROM page_runtime_admissions a WHERE id = $1',
        [fixture.admissionId])).rows,
      intent: (await query('SELECT to_jsonb(i) AS value FROM page_write_intents i WHERE id = $1',
        [fixture.intentId])).rows,
    };
    // 152 stays recorded: this is the dev-image install where the cutover
    // already happened and a live replica must not be cut.
    await query('DELETE FROM _migrations WHERE name = $1', [MIGRATION_151B]);
    await runMigrations();
    expect((await query('SELECT to_jsonb(r) AS value FROM page_writer_runtimes r WHERE runtime_id = $1',
      [fixture.runtimeId])).rows).toEqual(before.runtime);
    expect((await query('SELECT to_jsonb(a) AS value FROM page_runtime_admissions a WHERE id = $1',
      [fixture.admissionId])).rows).toEqual(before.admission);
    expect((await query('SELECT to_jsonb(i) AS value FROM page_write_intents i WHERE id = $1',
      [fixture.intentId])).rows).toEqual(before.intent);
    expect((await query(
      "SELECT 1 FROM audit_log WHERE action = 'PAGE_WRITER_UPGRADE_RETIREMENT'",
    )).rowCount).toBe(0);
  });

  it('stamps the AI-policy legacy window for a version-0 no-start epoch', async () => {
    await truncateAllTables();
    await unapply151b();
    await unapply152();
    const fixture = await blockedInstallFixture({ noStart: true, enforcementVersion: 0 });
    await runMigrations();
    // Fencing a long-dead row must not hide a possibly-live pre-#1881 replica:
    // the gate closure also restarts the legacy-client window conservatively.
    expect(await runtimeRow(fixture.runtimeId)).toMatchObject({
      fenced_at: expect.any(Date),
      quiesced_at: expect.any(Date),
      quiescence_ack: null,
    });
    const active = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM page_writer_runtimes
          WHERE fenced_at IS NULL AND quiesced_at IS NULL
            AND ai_policy_enforcement_version <> 1
       ) AS exists`,
    );
    expect(active.rows[0]!.exists).toBe(false);
  });

  it('enforces the retirement-state CHECK at the database', async () => {
    const runtimeId = `check-${randomUUID()}`;
    await truncateAllTables();
    await insertRuntime({ runtimeId });
    await expect(query(
      'UPDATE page_writer_runtimes SET upgrade_retired_at = NOW() WHERE runtime_id = $1', [runtimeId],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(query(
      `UPDATE page_writer_runtimes
          SET quiesced_at = NOW(), upgrade_retired_at = NOW() - interval '1 second'
        WHERE runtime_id = $1`, [runtimeId],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(query(
      `UPDATE page_writer_runtimes
          SET quiesced_at = NOW(), quiescence_ack = gen_random_uuid(), upgrade_retired_at = NOW()
        WHERE runtime_id = $1`, [runtimeId],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('waits for an in-flight writer instead of aborting the migration', async () => {
    await truncateAllTables();
    await unapply151b();
    await unapply152();
    const fixture = await blockedInstallFixture({ noStart: true });
    const holder = await getPool().connect();
    try {
      const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM page_writer_runtimes WHERE runtime_id = $1 FOR SHARE', [fixture.runtimeId]);
      const migrating = runMigrations();
      const blocked = await waitForDatabaseCondition(async () => {
        const wait = await query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND $1 = ANY(pg_blocking_pids(pid))
           ) AS waiting`,
          [rows[0]!.pid],
        );
        return wait.rows[0]!.waiting;
      });
      expect(blocked).toBe(true);
      await holder.query('COMMIT');
      await migrating;
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(await runtimeRow(fixture.runtimeId)).toMatchObject({ fenced_at: expect.any(Date) });
  });

  // LAST: this closes the module's own write gate, so no later case may write.
  it('refuses to claim an acknowledgment for an upgrade-retired own epoch', async () => {
    await truncateAllTables();
    const owner = await insertAdmin();
    const pageId = await insertPage(owner);
    // The module's own epoch cannot be upgrade-retired in production (151b runs
    // before registration); cook the state to pin the defensive path.
    const runtimeId = await getPageWriterRuntimeId();
    const admission = await admitPageRuntime(pageId, owner, 'collab_room', runtimeId);
    await releasePageRuntime(admission);
    await query(
      `UPDATE page_writer_runtimes
          SET quiesced_at = NOW(), upgrade_retired_at = NOW()
        WHERE runtime_id = $1`, [runtimeId],
    );
    await expect(quiescePageWriterRuntime({ actorId: owner, reason: 'Own epoch upgrade-retired' }))
      .rejects.toMatchObject({ reason: 'runtime_upgrade_retired' });
    expect((await runtimeRow(runtimeId)).quiescence_ack).toBeNull();
  });
});
