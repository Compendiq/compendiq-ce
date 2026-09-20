import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { getPool, query } from '../db/postgres.js';
import { fencePageWriterRuntime, reconcilePageWriteIntent } from './page-write-admission.js';
import { inspectBaselineManifest, isBaselinePreparationAbsent, verifyBaselineAttachments } from './page-baseline-manifest.js';
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

/** Persist a crash-state fixture, not a mock of the recovery service or DB. */
async function interruptedPreparation(
  copiedFiles: number,
  options: { effectStarted?: boolean; fenced?: boolean } = {},
) {
  const suffix = randomUUID();
  const actor = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, 'not-used-for-login', 'user') RETURNING id`,
    [`baseline-writer-${suffix}`, `${suffix}@baseline-recovery.test`],
  );
  const actorId = actor.rows[0]!.id;
  const administrator = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, 'not-used-for-login', 'admin') RETURNING id`,
    [`baseline-recovery-admin-${suffix}`, `${suffix}@baseline-recovery-admin.test`],
  );
  const administratorId = administrator.rows[0]!.id;
  const page = await query<{ id: number }>(
    `INSERT INTO pages (title, source, visibility, created_by_user_id, body_html, body_text, version)
     VALUES ('Recovery source', 'standalone', 'private', $1, '<p>initial</p>', 'initial', 4)
     RETURNING id`,
    [actorId],
  );
  const pageId = page.rows[0]!.id;
  const sourceDir = path.join(attachmentsDir, 'local', String(pageId));
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'a.txt'), 'first retained source');
  await fs.writeFile(path.join(sourceDir, 'b.txt'), 'second retained source');
  await query(
    `UPDATE pages SET body_html = $2 WHERE id = $1`,
    [pageId, `<a href="/api/local-attachments/${pageId}/a.txt">A</a><a href="/api/local-attachments/${pageId}/b.txt">B</a>`],
  );
  const baselineId = randomUUID();
  const client = await getPool().connect();
  let prepared;
  try {
    prepared = await inspectBaselineManifest(client, pageId, baselineId, actorId);
  } finally {
    client.release();
  }
  expect(prepared.attachments.map((attachment) => attachment.filename).sort()).toEqual(['a.txt', 'b.txt']);
  const revisions = await query<{ content_revision: string; lifecycle_revision: string }>(
    'SELECT content_revision::text, lifecycle_revision::text FROM pages WHERE id = $1', [pageId],
  );
  const revision = revisions.rows[0]!;
  const runtimeId = randomUUID();
  const acknowledgmentId = randomUUID();
  const intentId = randomUUID();
  await query(
    `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity, quiesced_at, quiescence_ack)
     VALUES ($1, $2::jsonb, NOW(), $3)`,
    [runtimeId, JSON.stringify({ host: 'retired-baseline-fixture', pid: 42, startedAt: new Date().toISOString() }), acknowledgmentId],
  );
  await query(
    `INSERT INTO page_write_intents
       (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect, effect_started_at)
     VALUES ($1, $2, 'baseline.prepare', $3, ARRAY[$4]::integer[], $5::jsonb, 'local_verified', $6::jsonb,
             CASE WHEN $7::boolean THEN NOW() END)`,
    [intentId, runtimeId, actorId, pageId,
      JSON.stringify({ [pageId]: { contentRevision: revision.content_revision, lifecycleRevision: revision.lifecycle_revision } }),
      JSON.stringify({ effectClass: 'local', baselineId, pageId, sourcePageIds: [pageId], manifestDigest: prepared.manifestDigest, totalBytes: prepared.totalBytes }),
      options.effectStarted !== false,
    ],
  );
  const manifest = prepared.manifest;
  await query(
    `INSERT INTO page_baselines (
       id, page_id, original_page_id, page_identity, version, content_revision, lifecycle_revision,
       manifest_digest, manifest, manifest_bytes, title, body_html, body_storage, body_text, labels,
       parent_identity, icon, attachments, total_bytes, reserved_bytes,
       prepared_by_user_id, prepared_by_name, preparation_intent_id
     ) VALUES (
       $1, $2, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14,
       $15::jsonb, $16::jsonb, $17::jsonb, $18, $18, $19, 'Recovery fixture', $20
     )`,
    [baselineId, pageId, JSON.stringify(manifest[3]), prepared.version, prepared.contentRevision,
      revision.lifecycle_revision, prepared.manifestDigest, JSON.stringify(manifest), prepared.manifestBytes,
      manifest[6], manifest[7], manifest[8], manifest[9], manifest[10],
      manifest[11] === null ? null : JSON.stringify(manifest[11]),
      manifest[12] === null ? null : JSON.stringify(manifest[12]),
      JSON.stringify(prepared.attachments), prepared.totalBytes, actorId, intentId,
    ],
  );
  await query('UPDATE page_baseline_capacity SET reserved_bytes = reserved_bytes + $1 WHERE singleton = TRUE', [prepared.totalBytes]);
  for (const attachment of prepared.attachments.slice(0, copiedFiles)) {
    const destination = path.join(attachmentsDir, ...attachment.retainedPath.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(sourceDir, attachment.filename), destination);
  }
  if (options.fenced !== false) {
    await fencePageWriterRuntime({
      runtimeId,
      mode: options.effectStarted === false ? 'durable_no_started_effects' : 'owner_ack',
      acknowledgmentId,
      actorId: administratorId,
      reason: 'Fixture models a retired writer whose copy did not settle',
    });
  }
  return { actorId, administratorId, pageId, baselineId, intentId, prepared, sourceDir, revision };
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
