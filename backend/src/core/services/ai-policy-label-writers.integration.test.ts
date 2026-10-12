/**
 * #281 — label writers publish their policy consequence through
 * `applyPageLabelsOnClient` on the transaction they already hold. Real
 * PostgreSQL; no DB mocks.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { getPool, query } from '../db/postgres.js';
import { applyPageLabelsOnClient, updatePageAiPolicies } from './ai-policy-service.js';
import { PAGE_WRITER_ENFORCEMENT_VERSION } from './page-baseline-governance.js';
import {
  PageWriteError,
  fencePageWriterRuntime,
  reconcilePageWriteIntent,
} from './page-write-admission.js';
import { applyLabelChanges } from '../../domains/knowledge/services/auto-tagger.js';
import {
  initialPolicyFromEffect,
  publishCreatedConfluencePage,
  registerOrdinaryPageWriteReconcilers,
} from '../../domains/confluence/services/ordinary-page-write-reconciler.js';

// External seams only: the Confluence HTTP client the recovery reconciler
// reads labels from, and the enterprise event sink. PostgreSQL is real.
const seams = vi.hoisted(() => ({
  remoteLabels: [] as string[],
  events: [] as Array<Record<string, unknown>>,
}));
vi.mock('../../domains/confluence/services/sync-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../domains/confluence/services/sync-service.js')>();
  return {
    ...actual,
    getClientForUser: async () => ({ getLabels: async () => [...seams.remoteLabels] }),
  };
});
vi.mock('../enterprise/ai-policy-hooks.js', () => ({
  emitAiPolicyEvent: (event: Record<string, unknown>) => { seams.events.push(event); },
}));

const dbAvailable = await isDbAvailable();
let seq = 0;

async function user(role = 'user'): Promise<string> {
  seq += 1;
  const r = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
    [`lw${seq}`, `lw${seq}@test.invalid`, role],
  );
  return r.rows[0]!.id;
}

async function page(input: { owner: string; labels: string[]; policy?: string; revision?: number; visibility?: string }): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (title, body_html, body_storage, body_text, version, labels, source, visibility,
                        created_by_user_id, ai_policy, ai_policy_revision, embedding_dirty, embedding_status)
     VALUES ('T', '<p>b</p>', '<p>b</p>', 'b', 1, $2, 'standalone', $5, $1, $3, $4, FALSE, 'not_embedded')
     RETURNING id`,
    [input.owner, input.labels, input.policy ?? 'all', input.revision ?? 0, input.visibility ?? 'private'],
  );
  return r.rows[0]!.id;
}

async function state(id: number) {
  const r = await query<{
    labels: string[]; ai_policy: string; ai_policy_revision: string; embedding_status: string;
    summary_status: string; ai_policy_block_reason: string | null;
  }>(
    `SELECT labels, ai_policy, ai_policy_revision::text, embedding_status, summary_status, ai_policy_block_reason
       FROM pages WHERE id = $1`,
    [id],
  );
  return r.rows[0]!;
}

async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A fenced origin runtime holding a dispatched-and-acknowledged `page.labels`
 * intent for a Confluence-backed page: exactly the state recovery finds after
 * the original writer died between the provider's acknowledgement and its
 * local commit.
 */
async function fencedLabelIntent(input: {
  actor: string; admin: string; pageId: number; confluenceId: string; priorLabels: string[]; targetLabels: string[];
}): Promise<string> {
  const rev = await query<{ c: string; l: string }>(
    `SELECT content_revision::text AS c, lifecycle_revision::text AS l FROM pages WHERE id = $1`,
    [input.pageId],
  );
  const runtimeId = `labels-origin-${randomUUID()}`;
  const ack = randomUUID();
  const intentId = randomUUID();
  await query(
    `INSERT INTO page_writer_runtimes
       (runtime_id, deployment_identity, quiesced_at, quiescence_ack, enforcement_version)
     VALUES ($1, $2::jsonb, NOW(), $3, $4)`,
    [runtimeId, JSON.stringify({ host: 'labels-origin', pid: 7, startedAt: new Date().toISOString() }), ack, PAGE_WRITER_ENFORCEMENT_VERSION],
  );
  await query(
    `INSERT INTO page_write_intents
       (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect,
        effect_started_at, remote_effect_started_at, remote_effects_completed_at, remote_terminal_result)
     VALUES ($1, $2, 'page.labels', $3, ARRAY[$4]::integer[], $5::jsonb, 'remote_terminal_only', $6::jsonb,
             NOW(), NOW(), NOW(), $7::jsonb)`,
    [
      intentId, runtimeId, input.actor, input.pageId,
      JSON.stringify({ [input.pageId]: { contentRevision: rev.rows[0]!.c, lifecycleRevision: rev.rows[0]!.l } }),
      JSON.stringify({
        effectClass: 'remote', pageId: input.pageId, confluenceId: input.confluenceId,
        add: input.targetLabels.filter((l) => !input.priorLabels.includes(l)),
        remove: input.priorLabels.filter((l) => !input.targetLabels.includes(l)),
        priorLabels: input.priorLabels, targetLabels: input.targetLabels,
      }),
      JSON.stringify({ confluenceId: input.confluenceId, accepted: true }),
    ],
  );
  await fencePageWriterRuntime({
    mode: 'owner_ack', runtimeId, acknowledgmentId: ack, actorId: input.admin,
    reason: 'The origin runtime acknowledged quiescence before label recovery',
  });
  return intentId;
}

async function confluencePage(input: { owner: string; labels: string[]; policy?: string; revision?: number }): Promise<{ id: number; confluenceId: string }> {
  seq += 1;
  const confluenceId = `cf-${seq}`;
  const r = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, space_key, title, body_html, body_storage, body_text, version, labels, source,
                        visibility, created_by_user_id, ai_policy, ai_policy_revision, embedding_dirty, embedding_status)
     VALUES ($1, 'LW', 'T', '<p>b</p>', '<p>b</p>', 'b', 1, $3, 'confluence', 'private', $2, $4, $5, FALSE, 'not_embedded')
     RETURNING id`,
    [confluenceId, input.owner, input.labels, input.policy ?? 'all', input.revision ?? 0],
  );
  return { id: r.rows[0]!.id, confluenceId };
}

describe.skipIf(!dbAvailable)('label writers → applyPageLabelsOnClient (#281)', () => {
  beforeAll(async () => {
    await setupTestDb();
    await truncateAllTables();
    registerOrdinaryPageWriteReconcilers();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  afterEach(() => {
    seams.events.length = 0;
    seams.remoteLabels = [];
  });

  it('carried-over contradictory labels never block an ordinary tag (review B)', async () => {
    const owner = await user();
    const id = await page({ owner, labels: ['no-ai', 'ai-local-only'] });
    await query(`UPDATE pages SET ai_policy = 'all' WHERE id = $1`, [id]);
    const before = await state(id);
    const applied = await tx((c) => applyPageLabelsOnClient(c, { userId: owner, pageId: id, targetLabels: ['no-ai', 'ai-local-only', 'x'] }));
    expect(applied).toMatchObject({ labels: ['no-ai', 'x'], policy: 'all', revision: Number(before.ai_policy_revision), changes: [] });
    expect(await state(id)).toMatchObject({ labels: ['no-ai', 'x'], ai_policy: 'all', ai_policy_revision: before.ai_policy_revision });
  });

  it('re-asserting the same policy bumps the revision but re-queues nothing (review C)', async () => {
    const owner = await user();
    const id = await page({ owner, labels: ['one'] });
    await query(`UPDATE pages SET embedding_status = 'embedded', embedded_at = NOW(), embedding_dirty = FALSE WHERE id = $1`, [id]);
    const result = await updatePageAiPolicies(owner, 'all', [{ pageId: id, expectedRevision: 0 }]);
    expect(result).toEqual({ ok: true, rows: [{ pageId: id, policy: 'all', revision: 1 }] });
    const row = await query<{ embedding_status: string; embedding_dirty: boolean }>(
      `SELECT embedding_status, embedding_dirty FROM pages WHERE id = $1`, [id],
    );
    expect(row.rows[0]).toEqual({ embedding_status: 'embedded', embedding_dirty: false });
    expect(seams.events).toEqual([{ type: 'policy_changed', pageId: id, userId: owner, from: 'all', to: 'all', revision: 1 }]);
  });

  it('first publication of a created Confluence page carries the admitted policy (review A)', async () => {
    const owner = await user();
    seq += 1;
    const publication = {
      confluenceId: `created-${seq}`, spaceKey: 'LW', parentConfluenceId: null, title: 'New', storage: '<p>n</p>', version: 1,
      ...initialPolicyFromEffect({ initialPolicy: 'none', initialLabels: ['AI_None', 'tag'] }),
    };
    expect(publication).toMatchObject({ initialPolicy: 'none', initialLabels: ['no-ai', 'tag'] });
    const published = await tx((c) => publishCreatedConfluencePage(c, publication));
    expect(published).toMatchObject({ labels: ['no-ai', 'tag'], aiPolicy: 'none' });
    expect(await state(published.id)).toMatchObject({ ai_policy: 'none', labels: ['no-ai', 'tag'] });
    // A re-run after an acknowledgement loss accepts the row it published.
    expect((await tx((c) => publishCreatedConfluencePage(c, publication))).id).toBe(published.id);
    // A tampered effect cannot loosen below its own labels, and garbage is refused.
    expect(initialPolicyFromEffect({ initialPolicy: 'all', initialLabels: ['no-ai'] }).initialPolicy).toBe('none');
    expect(() => initialPolicyFromEffect({ initialPolicy: 'wide-open', initialLabels: [] }))
      .toThrow(expect.objectContaining({ statusCode: 409, reason: 'intent_recovery_metadata_invalid' }));
    expect(() => initialPolicyFromEffect({ initialPolicy: 'none', initialLabels: 'no-ai' }))
      .toThrow(expect.objectContaining({ statusCode: 409, reason: 'intent_recovery_metadata_invalid' }));
    // `owner` keeps the linter honest about the fixture user.
    expect(owner).toBeTruthy();
  });

  it('recovery emits policy_changed once, strictly after its commit (review E)', async () => {
    // The original actor must still reach the space-backed page (RBAC); a
    // system admin does without space fixtures.
    const owner = await user('admin');
    const admin = await user('admin');
    const { id, confluenceId } = await confluencePage({ owner, labels: ['one'] });
    seams.remoteLabels = ['one', 'no-ai'];
    const intentId = await fencedLabelIntent({
      actor: owner, admin, pageId: id, confluenceId, priorLabels: ['one'], targetLabels: ['one', 'no-ai'],
    });
    await expect(reconcilePageWriteIntent(intentId, { actorId: admin, reason: 'Recover the acknowledged label mutation' }))
      .resolves.toEqual({ intentId, status: 'reconciled_applied' });
    expect(await state(id)).toMatchObject({ labels: ['no-ai', 'one'], ai_policy: 'none', ai_policy_revision: '1', embedding_status: 'policy_blocked' });
    expect(seams.events).toEqual([{ type: 'policy_changed', pageId: id, userId: owner, from: 'all', to: 'none', revision: 1 }]);
    expect((await query<{ status: string }>(`SELECT status FROM page_write_intents WHERE id = $1`, [intentId])).rows[0]!.status).toBe('reconciled_applied');
  });

  it('recovery never claims a mirror the local policy no longer admits (review D)', async () => {
    const owner = await user('admin');
    const admin = await user('admin');
    // Confluence holds ['one'] after the writer removed `no-ai`; meanwhile the
    // page was tightened to `none` locally, so recovery would restore the
    // canonical label and diverge from the provider. That is a 409, not a
    // claimed mirror, and no event leaves the rolled-back transaction.
    const { id, confluenceId } = await confluencePage({ owner, labels: ['one', 'no-ai'], policy: 'none', revision: 1 });
    seams.remoteLabels = ['one'];
    const intentId = await fencedLabelIntent({
      actor: owner, admin, pageId: id, confluenceId, priorLabels: ['one', 'no-ai'], targetLabels: ['one'],
    });
    await expect(reconcilePageWriteIntent(intentId, { actorId: admin, reason: 'Recover a label removal the policy no longer admits' }))
      .rejects.toMatchObject({ statusCode: 409, reason: 'intent_terminal_evidence_mismatch' });
    expect(await state(id)).toMatchObject({ labels: ['one', 'no-ai'], ai_policy: 'none', ai_policy_revision: '1' });
    expect(seams.events).toEqual([]);
    expect((await query<{ status: string }>(`SELECT status FROM page_write_intents WHERE id = $1`, [intentId])).rows[0]!.status).toBe('pending');
  });

  it('a newly added restrictive label tightens; policy, revision, labels and purge are one commit', async () => {
    const owner = await user();
    const id = await page({ owner, labels: ['one'] });
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const applied = await applyPageLabelsOnClient(client, { userId: owner, pageId: id, targetLabels: ['one', 'AI_None'] });
      expect(applied).toMatchObject({ labels: ['one', 'no-ai'], policy: 'none', revision: 1 });
      expect(applied.changes).toEqual([{ pageId: id, userId: owner, from: 'all', to: 'none', revision: 1 }]);
      expect((await state(id)).ai_policy).toBe('all'); // invisible until COMMIT
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await state(id)).toMatchObject({
      labels: ['one', 'no-ai'], ai_policy: 'none', ai_policy_revision: '1',
      embedding_status: 'policy_blocked', summary_status: 'policy_blocked', ai_policy_block_reason: 'policy_none',
    });
  });

  it('a carried-over label is inert after an explicit relaxation: policy and revision stay', async () => {
    const owner = await user();
    // Creation tightened the page from its label (migration 135 trigger); the
    // policy endpoint then relaxed it to `all` at revision 1 and the label
    // remained behind.
    const id = await page({ owner, labels: ['no-ai'] });
    expect(await state(id)).toMatchObject({ ai_policy: 'none' });
    await query(`UPDATE pages SET ai_policy = 'all', ai_policy_revision = 1 WHERE id = $1`, [id]);
    const applied = await tx((c) => applyPageLabelsOnClient(c, { userId: owner, pageId: id, targetLabels: ['no-ai', 'x'] }));
    expect(applied).toMatchObject({ labels: ['no-ai', 'x'], policy: 'all', revision: 1, changes: [] });
    expect(await state(id)).toMatchObject({ labels: ['no-ai', 'x'], ai_policy: 'all', ai_policy_revision: '1', embedding_status: 'not_embedded' });
  });

  it('contradictory reserved labels are a 422 and nothing is written', async () => {
    const owner = await user();
    const id = await page({ owner, labels: ['one'] });
    await expect(
      tx((c) => applyPageLabelsOnClient(c, { userId: owner, pageId: id, targetLabels: ['no-ai', 'ai-local-only'] })),
    ).rejects.toMatchObject({ statusCode: 422, reason: 'ai_policy_label_conflict' });
    expect(await state(id)).toMatchObject({ labels: ['one'], ai_policy: 'all', ai_policy_revision: '0' });
  });

  it('removing the canonical label does not relax: it is restored and the revision stays', async () => {
    const owner = await user();
    const id = await page({ owner, labels: ['no-ai', 'one'], policy: 'none' });
    const applied = await tx((c) => applyPageLabelsOnClient(c, { userId: owner, pageId: id, targetLabels: ['one'] }));
    expect(applied.plan.restoredLabel).toBe('no-ai');
    expect(applied.changes).toEqual([]);
    expect(await state(id)).toMatchObject({ labels: ['one', 'no-ai'], ai_policy: 'none', ai_policy_revision: '0' });
  });

  it('an explicit relaxation label needs policy authority (shared editors have none)', async () => {
    const owner = await user();
    const editor = await user();
    const id = await page({ owner, labels: ['no-ai'], policy: 'none', visibility: 'shared' });
    await expect(
      tx((c) => applyPageLabelsOnClient(c, { userId: editor, pageId: id, targetLabels: ['all-ai'] })),
    ).rejects.toMatchObject({ statusCode: 403, reason: 'ai_policy_not_authorized' });
    expect(await state(id)).toMatchObject({ labels: ['no-ai'], ai_policy: 'none', ai_policy_revision: '0' });

    const applied = await tx((c) => applyPageLabelsOnClient(c, { userId: owner, pageId: id, targetLabels: ['all-ai'] }));
    expect(applied).toMatchObject({ labels: ['all-ai'], policy: 'all', revision: 1 });
    expect(await state(id)).toMatchObject({
      labels: ['all-ai'], ai_policy: 'all', ai_policy_revision: '1', embedding_status: 'not_embedded', ai_policy_block_reason: null,
    });
  });

  it('a missing page is a PageWriteError 404', async () => {
    const owner = await user();
    await expect(
      tx((c) => applyPageLabelsOnClient(c, { userId: owner, pageId: 999_999, targetLabels: ['x'] })),
    ).rejects.toBeInstanceOf(PageWriteError);
  });

  it('applyLabelChanges (local branch) runs end to end through the primitive', async () => {
    const owner = await user();
    const id = await page({ owner, labels: ['one'] });
    expect(await applyLabelChanges(owner, String(id), { add: ['ai-local'] })).toEqual(['one', 'ai-local-only']);
    expect(await state(id)).toMatchObject({ ai_policy: 'local_only', ai_policy_revision: '1', embedding_status: 'not_embedded' });

    await expect(applyLabelChanges(owner, String(id), { add: ['no-ai'] }))
      .rejects.toMatchObject({ statusCode: 422, reason: 'ai_policy_label_conflict' });
    expect(await state(id)).toMatchObject({ ai_policy: 'local_only', ai_policy_revision: '1' });

    expect(await applyLabelChanges(owner, String(id), { add: [], remove: ['ai-local-only'] })).toEqual(['one', 'ai-local-only']);
    expect(await state(id)).toMatchObject({ ai_policy: 'local_only', ai_policy_revision: '1' });
  });
});
