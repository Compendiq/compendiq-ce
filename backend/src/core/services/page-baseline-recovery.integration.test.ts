import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertTestRuntime, isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { getPool, query } from '../db/postgres.js';
import { fencePageWriterRuntime, reconcilePageWriteIntent } from './page-write-admission.js';
import {
  inspectBaselineManifest,
  isBaselinePreparationAbsent,
  verifyBaselineAttachments,
  type BaselineAttachment,
  type PreparedBaselineManifest,
} from './page-baseline-manifest.js';
import { setPageBaselineReadinessProvider } from './page-baseline-governance.js';
import {
  cleanupAbandonedBaselinePreparation,
  cleanupAbandonedBaselinePreparations,
  previewPageBaseline,
  setPageBaselineCreationEnabled,
} from './page-baseline-service.js';

const available = await isDbAvailable();
const originalAttachmentsDir = process.env.ATTACHMENTS_DIR;
let attachmentsDir = '';

interface RecoveryFixture {
  actorId: string;
  administratorId: string;
  pageId: number;
  baselineId: string;
  intentId: string;
  runtimeId: string;
  prepared: PreparedBaselineManifest;
  sourceDir: string;
  revision: { content_revision: string; lifecycle_revision: string };
}
/** Persist a crash-state fixture, not a mock of the recovery service or DB. */
async function interruptedPreparation(
  copiedFiles: number,
  options: {
    effectStarted?: boolean;
    fenced?: boolean;
    withMedia?: boolean;
    createdAt?: string;
    target?: { actorId: string; administratorId: string; pageId: number };
  } = {},
): Promise<RecoveryFixture> {
  let target = options.target;
  if (!target) {
    const suffix = randomUUID();
    const actor = await query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, role)
       VALUES ($1, $2, 'not-used-for-login', 'user') RETURNING id`,
      [`baseline-writer-${suffix}`, `${suffix}@baseline-recovery.test`],
    );
    const administrator = await query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, role)
       VALUES ($1, $2, 'not-used-for-login', 'admin') RETURNING id`,
      [`baseline-recovery-admin-${suffix}`, `${suffix}@baseline-recovery-admin.test`],
    );
    const actorId = actor.rows[0]!.id;
    const administratorId = administrator.rows[0]!.id;
    await query(
      `INSERT INTO user_settings (user_id, confluence_enabled)
       VALUES ($1, FALSE), ($2, FALSE)`,
      [actorId, administratorId],
    );
    const page = await query<{ id: number }>(
      `INSERT INTO pages (title, source, visibility, created_by_user_id, body_html, body_text, version)
       VALUES ('Recovery source', 'standalone', 'private', $1, '<p>initial</p>', 'initial', 4)
       RETURNING id`,
      [actorId],
    );
    target = { actorId, administratorId, pageId: page.rows[0]!.id };
  }
  const { actorId, administratorId, pageId } = target;
  const sourceDir = path.join(attachmentsDir, 'local', String(pageId));
  if (!options.target && options.withMedia !== false) {
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'a.txt'), 'first retained source');
    await fs.writeFile(path.join(sourceDir, 'b.txt'), 'second retained source');
    await query(
      `UPDATE pages SET body_html = $2 WHERE id = $1`,
      [pageId, `<a href="/api/local-attachments/${pageId}/a.txt">A</a><a href="/api/local-attachments/${pageId}/b.txt">B</a>`],
    );
  }
  const baselineId = randomUUID();
  const client = await getPool().connect();
  let prepared;
  try {
    prepared = await inspectBaselineManifest(client, pageId, baselineId, actorId);
  } finally {
    client.release();
  }
  expect(prepared.attachments.map((attachment) => attachment.filename).sort())
    .toEqual(options.withMedia === false ? [] : ['a.txt', 'b.txt']);
  const revisions = await query<{ content_revision: string; lifecycle_revision: string }>(
    'SELECT content_revision::text, lifecycle_revision::text FROM pages WHERE id = $1', [pageId],
  );
  const revision = revisions.rows[0]!;
  const runtimeId = randomUUID();
  const intentId = randomUUID();
  const createdAt = options.createdAt ?? new Date().toISOString();
  await insertTestRuntime({ runtimeId, quiesced: options.fenced !== false });
  await query(
    `INSERT INTO page_write_intents
       (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect, effect_started_at, created_at)
     VALUES ($1, $2, 'baseline.prepare', $3, ARRAY[$4]::integer[], $5::jsonb, 'local_verified', $6::jsonb,
             CASE WHEN $7::boolean THEN NOW() END, $8::timestamptz)`,
    [intentId, runtimeId, actorId, pageId,
      JSON.stringify({ [pageId]: { contentRevision: revision.content_revision, lifecycleRevision: revision.lifecycle_revision } }),
      JSON.stringify({ effectClass: 'local', baselineId, pageId, sourcePageIds: [pageId], manifestDigest: prepared.manifestDigest, totalBytes: prepared.totalBytes }),
      options.effectStarted !== false, createdAt,
    ],
  );
  const manifest = prepared.manifest;
  await query(
    `INSERT INTO page_baselines (
       id, page_id, original_page_id, page_identity, version, content_revision, lifecycle_revision,
       manifest_digest, manifest, manifest_bytes, title, body_html, body_storage, body_text, labels,
       parent_identity, icon, attachments, total_bytes, reserved_bytes,
       prepared_by_user_id, prepared_by_name, preparation_intent_id, prepared_at
     ) VALUES (
       $1, $2, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14,
       $15::jsonb, $16::jsonb, $17::jsonb, $18, $18, $19, 'Recovery fixture', $20, $21::timestamptz
     )`,
    [baselineId, pageId, JSON.stringify(manifest[3]), prepared.version, prepared.contentRevision,
      revision.lifecycle_revision, prepared.manifestDigest, JSON.stringify(manifest), prepared.manifestBytes,
      manifest[6], manifest[7], manifest[8], manifest[9], manifest[10],
      manifest[11] === null ? null : JSON.stringify(manifest[11]),
      manifest[12] === null ? null : JSON.stringify(manifest[12]),
      JSON.stringify(prepared.attachments), prepared.totalBytes, actorId, intentId, createdAt,
    ],
  );
  await query('UPDATE page_baseline_capacity SET reserved_bytes = reserved_bytes + $1 WHERE singleton = TRUE', [prepared.totalBytes]);
  for (const attachment of prepared.attachments.slice(0, copiedFiles)) {
    const destination = path.join(attachmentsDir, ...attachment.retainedPath.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(sourceDir, attachment.filename), destination);
  }
  if (options.fenced !== false) {
    const runtime = await query<{ quiescence_ack: string }>(
      'SELECT quiescence_ack::text FROM page_writer_runtimes WHERE runtime_id = $1', [runtimeId],
    );
    await fencePageWriterRuntime({
      runtimeId,
      mode: options.effectStarted === false ? 'durable_no_started_effects' : 'owner_ack',
      acknowledgmentId: runtime.rows[0]!.quiescence_ack,
      actorId: administratorId,
      reason: 'Fixture models a retired writer whose copy did not settle',
    });
  }
  return { actorId, administratorId, pageId, baselineId, intentId, runtimeId, prepared, sourceDir, revision };
}

async function capacityBytes(): Promise<bigint> {
  const capacity = await query<{ reserved_bytes: string }>('SELECT reserved_bytes::text FROM page_baseline_capacity');
  return BigInt(capacity.rows[0]!.reserved_bytes);
}

async function reservationBytes(baselineId: string): Promise<bigint> {
  const reservation = await query<{ reserved_bytes: string }>(
    'SELECT reserved_bytes::text FROM page_baselines WHERE id = $1', [baselineId],
  );
  return BigInt(reservation.rows[0]!.reserved_bytes);
}

async function retainedBytes(attachments: readonly BaselineAttachment[]) {
  return Promise.all(attachments.map(async (attachment) => {
    try {
      return await fs.readFile(path.join(attachmentsDir, ...attachment.retainedPath.split('/')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }));
}

async function preparationEvidence(fixture: RecoveryFixture) {
  return {
    baseline: (await query('SELECT to_jsonb(b) AS evidence FROM page_baselines b WHERE id = $1', [fixture.baselineId])).rows,
    intent: (await query('SELECT to_jsonb(i) AS evidence FROM page_write_intents i WHERE id = $1', [fixture.intentId])).rows,
    page: (await query('SELECT to_jsonb(p) AS evidence FROM pages p WHERE id = $1', [fixture.pageId])).rows,
    source: await Promise.all(fixture.prepared.attachments.map((attachment) =>
      fs.readFile(path.join(fixture.sourceDir, attachment.filename)))),
    retained: await retainedBytes(fixture.prepared.attachments),
  };
}

async function preparedRow(baselineId: string) {
  const result = await query<{
    id: string;
    status: string;
    preparation_intent_id: string;
    attachments: BaselineAttachment[];
    intent_status: string;
    settled_at: Date | null;
  }>(
    `SELECT b.id, b.status, b.preparation_intent_id, b.attachments,
            i.status AS intent_status, i.settled_at
       FROM page_baselines b JOIN page_write_intents i ON i.id = b.preparation_intent_id
      WHERE b.id = $1`,
    [baselineId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function freshPage(actorId: string) {
  const result = await query<{ id: number }>(
    `INSERT INTO pages (source, title, body_html, visibility, created_by_user_id)
     VALUES ('standalone', 'Independent preview', '<p>No retained media</p>', 'private', $1) RETURNING id`,
    [actorId],
  );
  return result.rows[0]!.id;
}

describe.skipIf(!available)('baseline preparation recovery over persisted crash states', () => {
  beforeAll(async () => {
    await setupTestDb();
    attachmentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baseline-recovery-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;
    // This fixture exposes no unadmitted collab/sync/HTTP writers.
    setPageBaselineReadinessProvider(async () => ({ ready: true, blockers: [] }));
  });
  beforeEach(async () => {
    await truncateAllTables();
    for (const entry of await fs.readdir(attachmentsDir)) {
      await fs.rm(path.join(attachmentsDir, entry), { recursive: true, force: true });
    }
  });
  afterAll(async () => {
    setPageBaselineReadinessProvider(null);
    if (originalAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = originalAttachmentsDir;
    await fs.rm(attachmentsDir, { recursive: true, force: true });
    await teardownTestDb();
  });

  it('1765 regression: re-previews a fenced no-start preparation before maintenance and releases its reservation once', async () => {
    const cancelled = await interruptedPreparation(0, { effectStarted: false });
    const active = await interruptedPreparation(0, { effectStarted: false, fenced: false });
    const interrupted = await interruptedPreparation(1);
    await setPageBaselineCreationEnabled(cancelled.administratorId, true);
    const before = await preparationEvidence(cancelled);
    const activeBefore = await preparationEvidence(active);
    const interruptedBefore = await preparationEvidence(interrupted);
    const oldBytes = await reservationBytes(cancelled.baselineId);
    const otherBytes = await capacityBytes() - oldBytes;
    expect(before.baseline[0]!.evidence).toMatchObject({ status: 'preparing' });
    expect(before.intent[0]!.evidence).toMatchObject({
      status: 'cancelled', settled_at: expect.any(String),
      effect_started_at: null, remote_effect_started_at: null,
    });

    // No preparation maintenance or per-ID cleanup has run before this call.
    const fresh = await previewPageBaseline(cancelled.pageId, cancelled.actorId);
    expect(fresh.baselineId).not.toBe(cancelled.baselineId);
    expect(fresh.contentRevision).toBe(cancelled.revision.content_revision);
    const row = await preparedRow(fresh.baselineId);
    expect(row).toMatchObject({ status: 'prepared', intent_status: 'completed', settled_at: expect.any(Date) });
    expect(row.preparation_intent_id).not.toBe(cancelled.intentId);
    const after = await preparationEvidence(cancelled);
    expect(after.baseline).toEqual([]);
    expect(after.intent).toEqual(before.intent);
    expect(after.page).toEqual(before.page);
    expect(after.source).toEqual(before.source);
    expect(await isBaselinePreparationAbsent(cancelled.baselineId)).toBe(true);
    expect((await query(
      'SELECT id FROM page_baselines WHERE original_page_id = $1 AND prepared_by_user_id = $2',
      [cancelled.pageId, cancelled.actorId],
    )).rows).toEqual([{ id: fresh.baselineId }]);
    expect((await query('SELECT id FROM page_baseline_history WHERE original_page_id = $1', [cancelled.pageId])).rows)
      .toEqual([]);
    expect((await query('SELECT id FROM page_versions WHERE page_id = $1', [cancelled.pageId])).rows).toEqual([]);
    expect(await capacityBytes()).toBe(otherBytes + BigInt(fresh.totalBytes));
    expect(await preparationEvidence(active)).toEqual(activeBefore);
    expect(await preparationEvidence(interrupted)).toEqual(interruptedBefore);
    expect(await verifyBaselineAttachments(fresh.baselineId, row.attachments)).toEqual({ valid: true, failures: [] });
    const freshBytes = await retainedBytes(row.attachments);

    expect(await previewPageBaseline(cancelled.pageId, cancelled.actorId)).toEqual(fresh);
    expect(await cleanupAbandonedBaselinePreparations()).toBe(0);
    await expect(cleanupAbandonedBaselinePreparation(cancelled.baselineId)).rejects.toMatchObject({
      statusCode: 409, reason: 'baseline_cleanup_forbidden',
    });
    expect(await capacityBytes()).toBe(otherBytes + BigInt(fresh.totalBytes));
    expect(await retainedBytes(row.attachments)).toEqual(freshBytes);
  });

  it('1765 regression: never reuses a cancelled zero-media preparing row', async () => {
    const cancelled = await interruptedPreparation(0, { effectStarted: false, withMedia: false });
    await setPageBaselineCreationEnabled(cancelled.administratorId, true);
    expect(cancelled.prepared.attachments).toEqual([]);
    expect(await reservationBytes(cancelled.baselineId)).toBe(0n);
    const before = await preparationEvidence(cancelled);

    const fresh = await previewPageBaseline(cancelled.pageId, cancelled.actorId);
    expect(fresh.baselineId).not.toBe(cancelled.baselineId);
    expect(fresh.totalBytes).toBe(0);
    const row = await preparedRow(fresh.baselineId);
    expect(row).toMatchObject({ status: 'prepared', intent_status: 'completed', settled_at: expect.any(Date) });
    expect(row.preparation_intent_id).not.toBe(cancelled.intentId);
    const after = await preparationEvidence(cancelled);
    expect(after.baseline).toEqual([]);
    expect(after.intent).toEqual(before.intent);
    expect(after.page).toEqual(before.page);
    expect(await isBaselinePreparationAbsent(cancelled.baselineId)).toBe(true);
    expect(await capacityBytes()).toBe(0n);
    expect((await previewPageBaseline(cancelled.pageId, cancelled.actorId)).baselineId).toBe(fresh.baselineId);
    expect(await capacityBytes()).toBe(0n);
  });

  it('1765 regression: cleans the cancelled reservation before reapplying capacity admission', async () => {
    const cancelled = await interruptedPreparation(0, { effectStarted: false });
    await setPageBaselineCreationEnabled(cancelled.administratorId, true);
    const oldBytes = await reservationBytes(cancelled.baselineId);
    expect(oldBytes).toBeGreaterThan(0n);
    expect(await capacityBytes()).toBe(oldBytes);
    const originalLimit = process.env.PAGE_BASELINE_MAX_RETAINED_BYTES;
    process.env.PAGE_BASELINE_MAX_RETAINED_BYTES = oldBytes.toString();
    try {
      const fresh = await previewPageBaseline(cancelled.pageId, cancelled.actorId);
      expect(fresh.baselineId).not.toBe(cancelled.baselineId);
      expect(BigInt(fresh.totalBytes)).toBe(oldBytes);
      expect(await preparedRow(fresh.baselineId)).toMatchObject({ status: 'prepared', intent_status: 'completed' });
      expect(await isBaselinePreparationAbsent(cancelled.baselineId)).toBe(true);
      expect(await capacityBytes()).toBe(oldBytes);
      expect(await cleanupAbandonedBaselinePreparations()).toBe(0);
      expect(await capacityBytes()).toBe(oldBytes);
    } finally {
      if (originalLimit === undefined) delete process.env.PAGE_BASELINE_MAX_RETAINED_BYTES;
      else process.env.PAGE_BASELINE_MAX_RETAINED_BYTES = originalLimit;
    }
  });

  it.each([
    { label: 'active no-start work', copiedFiles: 0, effectStarted: false, fenced: false, effectFinished: false },
    { label: 'a fenced uncertain local effect', copiedFiles: 1, effectStarted: true, fenced: true, effectFinished: false },
    { label: 'fully copied but unsettled work', copiedFiles: 2, effectStarted: true, fenced: true, effectFinished: true },
  ])('1765 preservation: refuses $label without reclaiming its reservation', async ({
    copiedFiles, effectStarted, fenced, effectFinished,
  }) => {
    const fixture = await interruptedPreparation(copiedFiles, { effectStarted, fenced });
    if (effectFinished) {
      await query('UPDATE page_write_intents SET effect_finished_at = NOW() WHERE id = $1', [fixture.intentId]);
      expect(await verifyBaselineAttachments(fixture.baselineId, fixture.prepared.attachments))
        .toEqual({ valid: true, failures: [] });
    }
    await setPageBaselineCreationEnabled(fixture.administratorId, true);
    const before = await preparationEvidence(fixture);
    const capacity = await capacityBytes();
    expect(before.intent[0]!.evidence).toMatchObject({ status: 'pending', settled_at: null });
    if (!fenced) {
      expect((await query(
        'SELECT fenced_at, quiesced_at FROM page_writer_runtimes WHERE runtime_id = $1', [fixture.runtimeId],
      )).rows).toEqual([{ fenced_at: null, quiesced_at: null }]);
    }

    await expect(previewPageBaseline(fixture.pageId, fixture.actorId)).rejects.toMatchObject({
      statusCode: 409, reason: 'freeze_busy',
    });
    expect(await preparationEvidence(fixture)).toEqual(before);
    expect(await capacityBytes()).toBe(capacity);
    expect((await query('SELECT id FROM page_baselines')).rows).toEqual([{ id: fixture.baselineId }]);
  });

  it('1765 preservation: a recovery marker prevents no-start cancellation and preview reclamation', async () => {
    const fixture = await interruptedPreparation(0, { effectStarted: false, fenced: false });
    await query('UPDATE page_write_intents SET recovery_started_at = NOW() WHERE id = $1', [fixture.intentId]);
    await setPageBaselineCreationEnabled(fixture.administratorId, true);
    const before = await preparationEvidence(fixture);
    const capacity = await capacityBytes();

    await expect(previewPageBaseline(fixture.pageId, fixture.actorId)).rejects.toMatchObject({
      statusCode: 409, reason: 'freeze_busy',
    });
    await expect(fencePageWriterRuntime({
      runtimeId: fixture.runtimeId, actorId: fixture.administratorId, mode: 'durable_no_started_effects',
      reason: 'A claimed recovery cannot be treated as never-started work',
    })).rejects.toMatchObject({ statusCode: 409, reason: 'runtime_effects_started' });
    expect(await preparationEvidence(fixture)).toEqual(before);
    expect(await capacityBytes()).toBe(capacity);
  });

  it('1765 preservation: an authorized different actor cannot sweep the owner reservation on the same page', async () => {
    const fixture = await interruptedPreparation(0, { effectStarted: false });
    await setPageBaselineCreationEnabled(fixture.administratorId, true);
    const before = await preparationEvidence(fixture);
    const capacity = await capacityBytes();

    const administratorPreview = await previewPageBaseline(fixture.pageId, fixture.administratorId);
    expect(administratorPreview.baselineId).not.toBe(fixture.baselineId);
    expect(await preparedRow(administratorPreview.baselineId)).toMatchObject({
      status: 'prepared', intent_status: 'completed',
    });
    expect(await preparationEvidence(fixture)).toEqual(before);
    expect(await capacityBytes()).toBe(capacity + BigInt(administratorPreview.totalBytes));
  });

  it('1765 preservation: an unrelated successful preview does not perform a global cancelled-preparation sweep', async () => {
    const fixture = await interruptedPreparation(0, { effectStarted: false });
    await setPageBaselineCreationEnabled(fixture.administratorId, true);
    const otherPageId = await freshPage(fixture.actorId);
    const before = await preparationEvidence(fixture);
    const capacity = await capacityBytes();

    const independent = await previewPageBaseline(otherPageId, fixture.actorId);
    expect(await preparedRow(independent.baselineId)).toMatchObject({ status: 'prepared', intent_status: 'completed' });
    expect(await preparationEvidence(fixture)).toEqual(before);
    expect(await capacityBytes()).toBe(capacity + BigInt(independent.totalBytes));
  });

  it('1765 preservation: old preparation timestamps never substitute for durable cancellation', async () => {
    const fixture = await interruptedPreparation(0, {
      effectStarted: false, fenced: false, createdAt: '2000-01-01T00:00:00.000Z',
    });
    await setPageBaselineCreationEnabled(fixture.administratorId, true);
    const otherPageId = await freshPage(fixture.actorId);
    const before = await preparationEvidence(fixture);
    const capacity = await capacityBytes();
    expect(before.baseline[0]!.evidence.prepared_at).toMatch(/^2000-01-01/);
    expect(before.intent[0]!.evidence.created_at).toMatch(/^2000-01-01/);

    await expect(previewPageBaseline(fixture.pageId, fixture.actorId)).rejects.toMatchObject({
      statusCode: 409, reason: 'freeze_busy',
    });
    await previewPageBaseline(otherPageId, fixture.actorId);
    expect(await preparationEvidence(fixture)).toEqual(before);
    expect(await capacityBytes()).toBe(capacity);
  });

  it('1765 preservation: competing cleaners release a committed abandoned reservation exactly once', async () => {
    const fixture = await interruptedPreparation(0, { effectStarted: false });
    const other = await interruptedPreparation(1);
    await query("UPDATE page_baselines SET status = 'abandoned', abandoned_at = NOW() WHERE id = $1", [fixture.baselineId]);
    const before = await preparationEvidence(fixture);
    const otherBefore = await preparationEvidence(other);
    const capacity = await capacityBytes();
    const released = await reservationBytes(fixture.baselineId);

    const results = await Promise.allSettled([
      cleanupAbandonedBaselinePreparation(fixture.baselineId),
      cleanupAbandonedBaselinePreparation(fixture.baselineId),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((result) => result.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatchObject({ statusCode: 409, reason: 'baseline_cleanup_forbidden' });
    expect(await capacityBytes()).toBe(capacity - released);
    const after = await preparationEvidence(fixture);
    expect(after.baseline).toEqual([]);
    expect(after.intent).toEqual(before.intent);
    expect(after.page).toEqual(before.page);
    expect(after.source).toEqual(before.source);
    expect(await isBaselinePreparationAbsent(fixture.baselineId)).toBe(true);
    expect(await preparationEvidence(other)).toEqual(otherBefore);
    expect(await cleanupAbandonedBaselinePreparations()).toBe(0);
    expect(await capacityBytes()).toBe(capacity - released);
  });

  it('1765 preservation: cleanup storage failure keeps abandoned bytes charged and admits no replacement', async () => {
    const fixture = await interruptedPreparation(2);
    await reconcilePageWriteIntent(fixture.intentId, {
      actorId: fixture.administratorId, reason: 'Publish the fully copied crash-state fixture as prepared',
    });
    await setPageBaselineCreationEnabled(fixture.administratorId, true);
    await query('UPDATE pages SET title = $2 WHERE id = $1', [fixture.pageId, 'Needs a new preview']);
    const before = await preparationEvidence(fixture);
    const capacity = await capacityBytes();
    const namespace = path.join(attachmentsDir, 'page-baselines', fixture.baselineId);
    const backup = path.join(attachmentsDir, `fault-backup-${fixture.baselineId}`);
    await fs.rename(namespace, backup);
    await fs.symlink(backup, namespace, 'dir');
    try {
      await expect(previewPageBaseline(fixture.pageId, fixture.actorId)).rejects.toMatchObject({
        statusCode: 503, reason: 'baseline_storage_unavailable',
      });
      const after = await preparationEvidence(fixture);
      expect(after.baseline).toEqual([{
        evidence: { ...before.baseline[0]!.evidence, status: 'abandoned', abandoned_at: expect.any(String) },
      }]);
      expect(after.intent).toEqual(before.intent);
      expect(after.page).toEqual(before.page);
      expect(after.source).toEqual(before.source);
      expect(after.retained).toEqual(before.retained);
      expect(await capacityBytes()).toBe(capacity);
      expect((await query('SELECT id FROM page_write_intents')).rows).toEqual([{ id: fixture.intentId }]);
      expect((await query('SELECT id FROM page_baselines')).rows).toEqual([{ id: fixture.baselineId }]);
    } finally {
      await fs.rm(namespace, { force: true });
      await fs.rename(backup, namespace);
    }
    await cleanupAbandonedBaselinePreparation(fixture.baselineId);
    expect(await capacityBytes()).toBe(0n);
    expect(await isBaselinePreparationAbsent(fixture.baselineId)).toBe(true);
    const fresh = await previewPageBaseline(fixture.pageId, fixture.actorId);
    expect(fresh.baselineId).not.toBe(fixture.baselineId);
    expect(await capacityBytes()).toBe(BigInt(fresh.totalBytes));
    await expect(cleanupAbandonedBaselinePreparation(fixture.baselineId)).rejects.toMatchObject({
      statusCode: 409, reason: 'baseline_cleanup_forbidden',
    });
    expect(await capacityBytes()).toBe(BigInt(fresh.totalBytes));
  });

  it('1765 preservation: multirow supersession retains only uncleaned reservations after a cleanup fault', async () => {
    const first = await interruptedPreparation(2);
    await reconcilePageWriteIntent(first.intentId, {
      actorId: first.administratorId, reason: 'Recover the first revision without running preview maintenance',
    });
    await query('UPDATE pages SET title = $2 WHERE id = $1', [first.pageId, 'Second persisted revision']);
    const second = await interruptedPreparation(2, { target: first });
    await reconcilePageWriteIntent(second.intentId, {
      actorId: second.administratorId, reason: 'Recover the second revision without superseding the first',
    });
    await setPageBaselineCreationEnabled(first.administratorId, true);
    await query('UPDATE pages SET title = $2 WHERE id = $1', [first.pageId, 'Third persisted revision']);
    expect(first.revision.content_revision).not.toBe(second.revision.content_revision);
    const before = await preparationEvidence(second);
    const intentsBefore = (await query('SELECT to_jsonb(i) AS evidence FROM page_write_intents i ORDER BY id')).rows;
    const secondBytes = await reservationBytes(second.baselineId);
    const namespace = path.join(attachmentsDir, 'page-baselines', second.baselineId);
    const backup = path.join(attachmentsDir, `fault-backup-${second.baselineId}`);
    await fs.rename(namespace, backup);
    await fs.symlink(backup, namespace, 'dir');
    let remainingCount = 0;
    try {
      await expect(previewPageBaseline(first.pageId, first.actorId)).rejects.toMatchObject({
        statusCode: 503, reason: 'baseline_storage_unavailable',
      });
      const remaining = await query<{ id: string; status: string; reserved_bytes: string }>(
        'SELECT id, status, reserved_bytes::text FROM page_baselines ORDER BY id',
      );
      // Selection has no ORDER BY: an earlier successful cleanup may already
      // have committed, but the failed UUID must retain its whole reservation.
      expect(remaining.rows.length).toBeGreaterThanOrEqual(1);
      expect(remaining.rows.length).toBeLessThanOrEqual(2);
      expect(remaining.rows.every((row) =>
        [first.baselineId, second.baselineId].includes(row.id) && row.status === 'abandoned')).toBe(true);
      expect(remaining.rows.find((row) => row.id === second.baselineId)?.reserved_bytes).toBe(secondBytes.toString());
      const charged = remaining.rows.reduce((sum, row) => sum + BigInt(row.reserved_bytes), 0n);
      expect(await capacityBytes()).toBe(charged);
      expect((await query('SELECT to_jsonb(i) AS evidence FROM page_write_intents i ORDER BY id')).rows).toEqual(intentsBefore);
      const after = await preparationEvidence(second);
      expect(after.page).toEqual(before.page);
      expect(after.source).toEqual(before.source);
      expect(after.retained).toEqual(before.retained);
      remainingCount = remaining.rows.length;
    } finally {
      await fs.rm(namespace, { force: true });
      await fs.rename(backup, namespace);
    }
    expect(await cleanupAbandonedBaselinePreparations()).toBe(remainingCount);
    expect(await capacityBytes()).toBe(0n);
    expect(await isBaselinePreparationAbsent(first.baselineId)).toBe(true);
    expect(await isBaselinePreparationAbsent(second.baselineId)).toBe(true);
    expect(await cleanupAbandonedBaselinePreparations()).toBe(0);
    expect(await capacityBytes()).toBe(0n);
  });

  it('1765 preservation: preview and per-ID cleanup contention cannot double-release or reuse the obsolete UUID', async () => {
    const fixture = await interruptedPreparation(2);
    await reconcilePageWriteIntent(fixture.intentId, {
      actorId: fixture.administratorId, reason: 'Recover exact bytes before racing obsolete preview cleanup',
    });
    await setPageBaselineCreationEnabled(fixture.administratorId, true);
    await query('UPDATE pages SET title = $2 WHERE id = $1', [fixture.pageId, 'Concurrent preview revision']);
    const before = await preparationEvidence(fixture);

    const [previewResult, cleanupResult] = await Promise.allSettled([
      previewPageBaseline(fixture.pageId, fixture.actorId),
      cleanupAbandonedBaselinePreparation(fixture.baselineId),
    ]);
    if (previewResult.status === 'rejected') {
      expect(previewResult.reason).toMatchObject({ statusCode: 409, reason: 'baseline_cleanup_forbidden' });
      expect(cleanupResult.status).toBe('fulfilled');
    } else {
      expect(previewResult.value.baselineId).not.toBe(fixture.baselineId);
      expect(await preparedRow(previewResult.value.baselineId)).toMatchObject({
        status: 'prepared', intent_status: 'completed',
      });
    }
    if (cleanupResult.status === 'rejected') {
      expect(cleanupResult.reason).toMatchObject({ statusCode: 409, reason: 'baseline_cleanup_forbidden' });
    }
    const remaining = await query<{ id: string; status: string; reserved_bytes: string }>(
      'SELECT id, status, reserved_bytes::text FROM page_baselines',
    );
    expect(remaining.rows).toHaveLength(previewResult.status === 'fulfilled' ? 1 : 0);
    expect(remaining.rows.every((row) => row.id !== fixture.baselineId && row.status === 'prepared')).toBe(true);
    expect(await capacityBytes()).toBe(remaining.rows.reduce((sum, row) => sum + BigInt(row.reserved_bytes), 0n));
    const after = await preparationEvidence(fixture);
    expect(after.baseline).toEqual([]);
    expect(after.intent).toEqual(before.intent);
    expect(after.page).toEqual(before.page);
    expect(after.source).toEqual(before.source);
    expect(await isBaselinePreparationAbsent(fixture.baselineId)).toBe(true);
    expect(await cleanupAbandonedBaselinePreparations()).toBe(0);
  });

  it('1765 preservation: recovery cannot transfer or resurrect a terminal cancelled no-start intent', async () => {
    const fixture = await interruptedPreparation(0, { effectStarted: false });
    const before = await preparationEvidence(fixture);
    const capacity = await capacityBytes();
    await expect(reconcilePageWriteIntent(fixture.intentId, {
      actorId: fixture.administratorId, reason: 'Terminal cancellation cannot be converted into recovery work',
    })).rejects.toMatchObject({ statusCode: 409, reason: 'intent_not_pending' });
    expect(await preparationEvidence(fixture)).toEqual(before);
    expect(await capacityBytes()).toBe(capacity);
  });

  it('1765 preservation: failed accounting rolls back deletion and can retry after the namespace is already absent', async () => {
    const fixture = await interruptedPreparation(2);
    const other = await interruptedPreparation(1);
    await query("UPDATE page_baselines SET status = 'abandoned', abandoned_at = NOW() WHERE id = $1", [fixture.baselineId]);
    const before = await preparationEvidence(fixture);
    const otherBefore = await preparationEvidence(other);
    const reserved = await reservationBytes(fixture.baselineId);
    const otherReserved = await reservationBytes(other.baselineId);
    // Persist a damaged singleton rather than mocking the cleanup transaction.
    // This cleanup must unlink first, then roll back its DELETE/subtraction.
    const damagedCapacity = reserved - 1n;
    await query('UPDATE page_baseline_capacity SET reserved_bytes = $1 WHERE singleton = TRUE', [damagedCapacity.toString()]);

    await expect(cleanupAbandonedBaselinePreparation(fixture.baselineId)).rejects.toMatchObject({
      statusCode: 500, reason: 'baseline_capacity_invalid',
    });
    const after = await preparationEvidence(fixture);
    expect(after.baseline).toEqual(before.baseline);
    expect(after.intent).toEqual(before.intent);
    expect(after.page).toEqual(before.page);
    expect(after.source).toEqual(before.source);
    expect(await isBaselinePreparationAbsent(fixture.baselineId)).toBe(true);
    expect(await capacityBytes()).toBe(damagedCapacity);
    expect(await preparationEvidence(other)).toEqual(otherBefore);
    expect((await query('SELECT id FROM page_write_intents ORDER BY id')).rows.map((row) => row.id))
      .toEqual([fixture.intentId, other.intentId].sort());

    // Repair only this test's deliberately damaged accounting. The existing
    // cleanup must accept proven namespace absence, not resurrect retained I/O.
    await query('UPDATE page_baseline_capacity SET reserved_bytes = $1 WHERE singleton = TRUE', [
      (reserved + otherReserved).toString(),
    ]);
    await cleanupAbandonedBaselinePreparation(fixture.baselineId);
    expect(await capacityBytes()).toBe(otherReserved);
    expect((await preparationEvidence(fixture)).baseline).toEqual([]);
    await expect(cleanupAbandonedBaselinePreparation(fixture.baselineId)).rejects.toMatchObject({
      statusCode: 409, reason: 'baseline_cleanup_forbidden',
    });
    expect(await capacityBytes()).toBe(otherReserved);
    expect(await preparationEvidence(other)).toEqual(otherBefore);
  });

  it('reclaims cancelled pre-copy reservations without touching active or interrupted preparations', async () => {
    const cancelled = await interruptedPreparation(0, { effectStarted: false });
    const active = await interruptedPreparation(0, { effectStarted: false, fenced: false });
    const interrupted = await interruptedPreparation(1);
    expect((await query('SELECT status FROM page_write_intents WHERE id = $1', [cancelled.intentId])).rows)
      .toEqual([{ status: 'cancelled' }]);

    expect(await cleanupAbandonedBaselinePreparations()).toBe(1);
    expect((await query('SELECT id FROM page_baselines WHERE id = $1', [cancelled.baselineId])).rows).toEqual([]);
    expect(await isBaselinePreparationAbsent(cancelled.baselineId)).toBe(true);
    expect((await query('SELECT reserved_bytes::text FROM page_baseline_capacity')).rows)
      .toEqual([{ reserved_bytes: String(active.prepared.totalBytes + interrupted.prepared.totalBytes) }]);
    expect((await query('SELECT id FROM page_baselines WHERE id = ANY($1::uuid[]) ORDER BY id', [
      [active.baselineId, interrupted.baselineId],
    ])).rows.map((row) => row.id)).toEqual([active.baselineId, interrupted.baselineId].sort());
    const retained = interrupted.prepared.attachments[0]!;
    expect(await fs.readFile(path.join(attachmentsDir, ...retained.retainedPath.split('/')), 'utf8'))
      .toBe(await fs.readFile(path.join(interrupted.sourceDir, retained.filename), 'utf8'));
    expect(await fs.readFile(path.join(cancelled.sourceDir, 'a.txt'), 'utf8')).toBe('first retained source');

    expect(await cleanupAbandonedBaselinePreparations()).toBe(0);
    await setPageBaselineCreationEnabled(cancelled.administratorId, true);
    const retry = await previewPageBaseline(cancelled.pageId, cancelled.actorId);
    expect(retry.baselineId).not.toBe(cancelled.baselineId);
    expect(retry.contentRevision).toBe(cancelled.revision.content_revision);
    expect((await query('SELECT reserved_bytes::text FROM page_baseline_capacity')).rows)
      .toEqual([{ reserved_bytes: String(active.prepared.totalBytes + interrupted.prepared.totalBytes + retry.totalBytes) }]);
  });

  it('recovers exact copied bytes into the same preview without changing authored content or revision', async () => {
    const fixture = await interruptedPreparation(2);
    expect(await reconcilePageWriteIntent(fixture.intentId, { actorId: fixture.administratorId, reason: 'Recover fully copied immutable preparation' }))
      .toMatchObject({ status: 'reconciled_applied' });
    await setPageBaselineCreationEnabled(fixture.administratorId, true);
    const preview = await previewPageBaseline(fixture.pageId, fixture.actorId);
    expect(preview.baselineId).toBe(fixture.baselineId);
    expect(preview.manifestDigest).toBe(fixture.prepared.manifestDigest);
    const page = await query('SELECT version, content_revision::text, lifecycle_revision::text FROM pages WHERE id = $1', [fixture.pageId]);
    expect(page.rows).toEqual([{ version: 4, ...fixture.revision }]);
    expect(await verifyBaselineAttachments(fixture.baselineId, fixture.prepared.attachments)).toEqual({ valid: true, failures: [] });
  });

  it('abandons partial bytes and releases only that reservation while preserving source and other retained bytes', async () => {
    const partial = await interruptedPreparation(1);
    const other = await interruptedPreparation(2);
    expect(await reconcilePageWriteIntent(partial.intentId, { actorId: partial.administratorId, reason: 'Discard an incomplete unpublished copy safely' }))
      .toMatchObject({ status: 'reconciled_not_applied' });
    expect(await isBaselinePreparationAbsent(partial.baselineId)).toBe(true);
    expect((await query('SELECT id FROM page_baselines WHERE id = $1', [partial.baselineId])).rows).toEqual([]);
    expect((await query('SELECT reserved_bytes::text FROM page_baseline_capacity')).rows)
      .toEqual([{ reserved_bytes: String(other.prepared.totalBytes) }]);
    expect(await fs.readFile(path.join(partial.sourceDir, 'a.txt'), 'utf8')).toBe('first retained source');
    expect(await verifyBaselineAttachments(other.baselineId, other.prepared.attachments)).toEqual({ valid: true, failures: [] });
  });

  it('never re-promotes an abandoned preparation even when all its bytes are valid', async () => {
    const fixture = await interruptedPreparation(2);
    await query("UPDATE page_baselines SET status = 'abandoned', abandoned_at = NOW() WHERE id = $1", [fixture.baselineId]);
    expect(await reconcilePageWriteIntent(fixture.intentId, { actorId: fixture.administratorId, reason: 'Resume committed abandonment without resurrecting evidence' }))
      .toMatchObject({ status: 'reconciled_not_applied' });
    expect(await isBaselinePreparationAbsent(fixture.baselineId)).toBe(true);
    expect((await query('SELECT reserved_bytes::text FROM page_baseline_capacity')).rows).toEqual([{ reserved_bytes: '0' }]);
  });

  it('resumes after maintenance already removed the abandoned row and its bytes', async () => {
    const fixture = await interruptedPreparation(1);
    await query("UPDATE page_baselines SET status = 'abandoned', abandoned_at = NOW() WHERE id = $1", [fixture.baselineId]);
    await cleanupAbandonedBaselinePreparation(fixture.baselineId);
    expect(await reconcilePageWriteIntent(fixture.intentId, { actorId: fixture.administratorId, reason: 'Settle the already completed abandoned cleanup' }))
      .toMatchObject({ status: 'reconciled_not_applied' });
    expect((await query('SELECT reserved_bytes::text FROM page_baseline_capacity')).rows).toEqual([{ reserved_bytes: '0' }]);
  });

  it('does not claim absence when the reservation is missing but retained bytes remain', async () => {
    const fixture = await interruptedPreparation(1);
    await query("UPDATE page_baselines SET status = 'abandoned', abandoned_at = NOW() WHERE id = $1", [fixture.baselineId]);
    await query('DELETE FROM page_baselines WHERE id = $1', [fixture.baselineId]);
    await expect(reconcilePageWriteIntent(fixture.intentId, { actorId: fixture.administratorId, reason: 'Inspect inconsistent orphaned retained bytes' }))
      .rejects.toMatchObject({ reason: 'baseline_recovery_invalid' });
    expect(await isBaselinePreparationAbsent(fixture.baselineId)).toBe(false);
    expect((await query('SELECT status FROM page_write_intents WHERE id = $1', [fixture.intentId])).rows).toEqual([{ status: 'pending' }]);
  });
});
