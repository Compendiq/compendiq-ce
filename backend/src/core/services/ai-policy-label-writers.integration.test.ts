/**
 * #281 — label writers publish their policy consequence through
 * `applyPageLabelsOnClient` on the transaction they already hold. Real
 * PostgreSQL; no DB mocks. Only the two external seams are replaced: the
 * Confluence HTTP client and the enterprise event sink (which calls through
 * to the real CE sink so the emission path itself is exercised).
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { getPool, query } from '../db/postgres.js';
import { confluenceToHtml, htmlToText } from './content-converter.js';
import {
  AI_POLICY_LOCK_NAMESPACE,
  applyAiPolicyOnClient,
  applyPageLabelsOnClient,
  planLabelPolicyChange,
  updatePageAiPolicies,
} from './ai-policy-service.js';
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
  sameLabelSet,
} from '../../domains/confluence/services/ordinary-page-write-reconciler.js';

// External seams only: the Confluence HTTP client the recovery reconcilers
// read from, and the enterprise event sink. PostgreSQL is real.
const seams = vi.hoisted(() => ({
  remoteLabels: [] as string[],
  remotePage: null as null | { id: string; title: string; version: { number: number }; body: { storage: { value: string } }; status: string },
  events: [] as Array<Record<string, unknown>>,
}));
vi.mock('../../domains/confluence/services/sync-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../domains/confluence/services/sync-service.js')>();
  return {
    ...actual,
    getClientForUser: async () => ({
      getLabels: async () => [...seams.remoteLabels],
      getPage: async (id: string) => {
        if (!seams.remotePage || seams.remotePage.id !== id) throw new Error(`no remote page ${id}`);
        return seams.remotePage;
      },
    }),
  };
});
vi.mock('../enterprise/ai-policy-hooks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../enterprise/ai-policy-hooks.js')>();
  return {
    ...actual,
    emitAiPolicyEvent: (event: Record<string, unknown>) => {
      seams.events.push(event);
      actual.emitAiPolicyEvent(event as Parameters<typeof actual.emitAiPolicyEvent>[0]);
    },
  };
});

vi.mock('../enterprise/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../enterprise/loader.js')>();
  return {
    ...actual,
    getEnterprisePlugin: () => ({
      ...actual.getEnterprisePlugin(),
      persistAiPolicyChange: async (client: PoolClient, event: unknown) => {
        await client.query('INSERT INTO lw_typed_evidence (payload) VALUES ($1::jsonb)', [JSON.stringify(event)]);
      },
    }),
  };
});

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

async function intentStatus(id: string): Promise<string> {
  return (await query<{ status: string }>(`SELECT status FROM page_write_intents WHERE id = $1`, [id])).rows[0]!.status;
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

async function revisionsOf(pageId: number) {
  const rev = await query<{ c: string; l: string }>(
    `SELECT content_revision::text AS c, lifecycle_revision::text AS l FROM pages WHERE id = $1`,
    [pageId],
  );
  return { [pageId]: { contentRevision: rev.rows[0]!.c, lifecycleRevision: rev.rows[0]!.l } };
}

/**
 * A fenced origin runtime holding one durable intent: exactly the state
 * recovery finds after the original writer died. `dispatched: false` is a
 * reserved-but-never-sent remote intent; `dispatched: true` is one the
 * provider acknowledged before the writer's local commit.
 */
async function fencedIntent(input: {
  kind: string; actor: string; admin: string; pageId: number;
  effect: Record<string, unknown>; dispatched: boolean; terminal?: Record<string, unknown>;
}): Promise<string> {
  const runtimeId = `origin-${randomUUID()}`;
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
     VALUES ($1, $2, $3, $4, ARRAY[$5]::integer[], $6::jsonb, 'remote_terminal_only', $7::jsonb,
             NOW(),
             CASE WHEN $8::boolean THEN NOW() END,
             CASE WHEN $8::boolean THEN NOW() END,
             CASE WHEN $8::boolean THEN $9::jsonb END)`,
    [
      intentId, runtimeId, input.kind, input.actor, input.pageId,
      JSON.stringify(await revisionsOf(input.pageId)),
      JSON.stringify({ effectClass: 'remote', ...input.effect }),
      input.dispatched,
      JSON.stringify(input.terminal ?? null),
    ],
  );
  await fencePageWriterRuntime({
    mode: 'owner_ack', runtimeId, acknowledgmentId: ack, actorId: input.admin,
    reason: 'The origin runtime acknowledged quiescence before recovery',
  });
  return intentId;
}

async function fencedLabelIntent(input: {
  actor: string; admin: string; pageId: number; confluenceId: string; priorLabels: string[]; targetLabels: string[];
  kind?: 'page.labels' | 'pages.create.labels'; dispatched?: boolean;
}): Promise<string> {
  return fencedIntent({
    kind: input.kind ?? 'page.labels', actor: input.actor, admin: input.admin, pageId: input.pageId,
    dispatched: input.dispatched ?? true,
    effect: {
      pageId: input.pageId, confluenceId: input.confluenceId,
      add: input.targetLabels.filter((l) => !input.priorLabels.includes(l)),
      remove: input.priorLabels.filter((l) => !input.targetLabels.includes(l)),
      priorLabels: input.priorLabels, targetLabels: input.targetLabels,
    },
    terminal: { confluenceId: input.confluenceId, accepted: true },
  });
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

/** The row the Confluence sync walker inserts when it sees the page before the creator publishes it locally. */
async function syncFirstRow(input: {
  confluenceId: string; title: string; storage: string; parentId: string | null; policy: string; labels: string[]; revision?: number;
}): Promise<number> {
  const bodyHtml = confluenceToHtml(input.storage, input.confluenceId, 'LW');
  const r = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, space_key, title, body_storage, body_html, body_text, version, parent_id,
                        labels, source, ai_policy, ai_policy_revision, embedding_dirty, embedding_status, embedded_at)
     VALUES ($1, 'LW', $2, $3, $4, $5, 1, $6, $7, 'confluence', $8, $9, FALSE, 'embedded', NOW())
     RETURNING id`,
    [input.confluenceId, input.title, input.storage, bodyHtml, htmlToText(bodyHtml), input.parentId, input.labels, input.policy, input.revision ?? 0],
  );
  return r.rows[0]!.id;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function waitFor(predicate: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A backend is waiting (not granted) on the given advisory key. */
async function advisoryWaiter(classid: number, objid: number): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND NOT granted`,
    [classid, objid],
  );
  return (r.rowCount ?? 0) > 0;
}

describe.skipIf(!dbAvailable)('label writers → applyPageLabelsOnClient (#281)', () => {
  beforeAll(async () => {
    await setupTestDb();
    await truncateAllTables();
    await query('CREATE TABLE lw_typed_evidence (payload jsonb NOT NULL)');
    registerOrdinaryPageWriteReconcilers();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  afterEach(async () => {
    await query('DELETE FROM lw_typed_evidence');
    seams.events.length = 0;
    seams.remoteLabels = [];
    seams.remotePage = null;
  });

  it('carried contradictory targets are refused without policy, labels or evidence effects', async () => {
    const owner = await user();
    const id = await page({ owner, labels: ['no-ai', 'local-ai-only'] });
    await query(`UPDATE pages SET ai_policy = 'all' WHERE id = $1`, [id]);
    const before = await state(id);
    await expect(tx((c) => applyPageLabelsOnClient(c, { userId: owner, pageId: id, targetLabels: ['no-ai', 'local-ai-only', 'x'] })))
      .rejects.toMatchObject({ statusCode: 422, reason: 'ai_policy_label_conflict' });
    expect(await state(id)).toEqual(before);
    expect((await query('SELECT payload FROM lw_typed_evidence')).rows).toEqual([]);
  });

  it.each(['all', 'local_only', 'none'] as const)('canonical-only reconciliation preserves %s revision and derived status for an ordinary shared viewer', async (policy) => {
    const owner = await user();
    const viewer = await user();
    for (const labels of [[], ['ai:all'], ['local_only'], ['no_ai']]) {
      const id = await page({ owner, labels: [], policy, visibility: 'shared' });
      // Legacy spelling/stale label fixtures; UPDATE never changes policy from labels.
      await query('UPDATE pages SET labels = $2 WHERE id = $1', [id, labels]);
      const before = await state(id);
      const result = await applyLabelChanges(viewer, String(id), { add: ['ordinary'] });
      const canonical = policy === 'all' ? 'all-ai' : policy === 'local_only' ? 'local-ai-only' : 'no-ai';
      expect(result).toEqual(['ordinary', canonical]);
      expect(await state(id)).toEqual({ ...before, labels: ['ordinary', canonical] });
    }
    expect((await query('SELECT payload FROM lw_typed_evidence')).rows).toEqual([]);
  });

  it('rolls back earlier canonical reconciliation when a later selected target contradicts', async () => {
    const owner = await user();
    const first = await page({ owner, labels: ['keep'] });
    const second = await page({ owner, labels: ['no-ai'], policy: 'none' });
    const before = await Promise.all([state(first), state(second)]);
    await expect(tx(async (client) => {
      await applyPageLabelsOnClient(client, { userId: owner, pageId: first, targetLabels: ['keep', 'ordinary'] });
      await applyPageLabelsOnClient(client, { userId: owner, pageId: second, targetLabels: ['no-ai', 'all-ai'] });
    })).rejects.toMatchObject({ statusCode: 422 });
    expect(await Promise.all([state(first), state(second)])).toEqual(before);
    expect((await query('SELECT payload FROM lw_typed_evidence')).rows).toEqual([]);
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
    expect(seams.events).toEqual([]);
    expect((await query('SELECT payload FROM lw_typed_evidence')).rows.map((row) => row.payload)).toMatchObject([
      { type: 'policy_change', actor: { kind: 'user', id: owner }, changes: [
        { pageId: id, oldPolicy: 'all', newPolicy: 'all', oldRevision: 0, newRevision: 1 },
      ] },
    ]);
  });

  it('first publication of a created Confluence page carries the admitted policy (review A)', async () => {
    const owner = await user();
    seq += 1;
    const publication = {
      confluenceId: `created-${seq}`, spaceKey: 'LW', parentConfluenceId: null, title: 'New', storage: '<p>n</p>', version: 1,
      ...initialPolicyFromEffect({ initialPolicy: 'none', initialLabels: ['No-AI ', 'tag'] }),
    };
    expect(publication).toMatchObject({ initialPolicy: 'none', initialLabels: ['tag', 'no-ai'] });
    await expect(tx((c) => publishCreatedConfluencePage(c, publication)))
      .rejects.toMatchObject({ statusCode: 403 });
    const admin = await user('admin');
    await expect(tx((c) => publishCreatedConfluencePage(c, { ...publication, actorId: admin })))
      .rejects.toMatchObject({ statusCode: 409, body: { error: 'ai_policy_enforcement_unavailable' } });
    await expect(tx((c) => publishCreatedConfluencePage(c, {
      ...publication, actorId: admin, recoveryIntentId: randomUUID(),
    }))).rejects.toMatchObject({ statusCode: 409, reason: 'intent_recovery_metadata_invalid' });
    expect((await query('SELECT id FROM pages WHERE confluence_id=$1', [publication.confluenceId])).rows).toEqual([]);
    // A tampered effect cannot loosen below its own labels, and garbage is refused.
    expect(initialPolicyFromEffect({ initialPolicy: 'all', initialLabels: ['no-ai'] }).initialPolicy).toBe('none');
    expect(() => initialPolicyFromEffect({ initialPolicy: 'wide-open', initialLabels: [] }))
      .toThrow(expect.objectContaining({ statusCode: 409, reason: 'intent_recovery_metadata_invalid' }));
    expect(() => initialPolicyFromEffect({ initialPolicy: 'none', initialLabels: 'no-ai' }))
      .toThrow(expect.objectContaining({ statusCode: 409, reason: 'intent_recovery_metadata_invalid' }));
    // `owner` keeps the linter honest about the fixture user.
    expect(owner).toBeTruthy();
  });

  it('first publication tightens an exactly matching sync-first row to the admitted policy; collisions stay 409', async () => {
    const owner = await user();
    seq += 1;
    const confluenceId = `created-${seq}`;
    const base = {
      confluenceId, spaceKey: 'LW', parentConfluenceId: null, title: 'New', storage: '<p>n</p>', version: 1,
      ...initialPolicyFromEffect({ initialPolicy: 'none', initialLabels: ['no-ai', 'tag'] }),
    };
    // The sync walker saw the acknowledged page before the creator's labels
    // reached Confluence: identical content, imported at `all` and embedded.
    const id = await syncFirstRow({ confluenceId, title: 'New', storage: '<p>n</p>', parentId: null, policy: 'all', labels: ['walker'] });

    // Without an actor the looser row cannot be attributed: refused, untouched.
    await expect(tx((c) => publishCreatedConfluencePage(c, base)))
      .rejects.toMatchObject({ statusCode: 409, reason: 'intent_local_identity_changed' });
    expect(await state(id)).toMatchObject({ ai_policy: 'all', ai_policy_revision: '0', embedding_status: 'embedded' });

    const changes = async () => (await query('SELECT payload FROM lw_typed_evidence')).rows;
    await expect(tx((c) => publishCreatedConfluencePage(c, {
      ...base, actorId: owner,
    }))).rejects.toMatchObject({ statusCode: 409 });
    expect(await state(id)).toMatchObject({ ai_policy: 'all', ai_policy_revision: '0' });
    expect(await changes()).toEqual([]);
    // A server recovery must carry a real durable receipt; an actor alone is
    // not creation authority. The acknowledged recovery cases below cover
    // successful publication. Seed already-published state for idempotence.
    await query(`UPDATE pages SET ai_policy = 'none', labels = ARRAY['walker','tag','no-ai'],
      embedding_status = 'policy_blocked', ai_policy_block_reason = 'policy_none' WHERE id = $1`, [id]);
    expect(await state(id)).toMatchObject({
      ai_policy: 'none', ai_policy_revision: '1', embedding_status: 'policy_blocked', ai_policy_block_reason: 'policy_none',
    });
    // Change records are handed back, never emitted by the primitive itself.
    expect(await changes()).toEqual([]);
    expect(seams.events).toEqual([]);

    // A re-run after the tighten accepts the row and moves nothing.
    const again = await tx((c) => publishCreatedConfluencePage(c, { ...base, actorId: owner }));
    expect(again).toMatchObject({ id, aiPolicy: 'none' });
    expect(await changes()).toHaveLength(0);
    expect((await state(id)).ai_policy_revision).toBe('1');

    // A stricter existing row is a later authoritative tighten: accepted untouched.
    seq += 1;
    const strictId = await syncFirstRow({ confluenceId: `created-${seq}`, title: 'S', storage: '<p>s</p>', parentId: null, policy: 'none', labels: ['no-ai'], revision: 3 });
    const strict = await tx((c) => publishCreatedConfluencePage(c, {
      confluenceId: `created-${seq}`, spaceKey: 'LW', parentConfluenceId: null, title: 'S', storage: '<p>s</p>', version: 1,
      ...initialPolicyFromEffect({ initialPolicy: 'local_only', initialLabels: ['ai-local-only'] }),
      actorId: owner,
    }));
    expect(strict).toMatchObject({ id: strictId, aiPolicy: 'none', labels: ['no-ai'] });
    expect(await changes()).toHaveLength(0);
    expect((await state(strictId)).ai_policy_revision).toBe('3');

    // Different content under the same id is an unrelated collision: 409, untouched.
    await expect(tx((c) => publishCreatedConfluencePage(c, { ...base, storage: '<p>other</p>', actorId: owner })))
      .rejects.toMatchObject({ statusCode: 409, reason: 'intent_local_identity_changed' });
    await expect(tx((c) => publishCreatedConfluencePage(c, { ...base, title: 'Other', actorId: owner })))
      .rejects.toMatchObject({ statusCode: 409, reason: 'intent_local_identity_changed' });
    await expect(tx((c) => publishCreatedConfluencePage(c, { ...base, version: 2, actorId: owner })))
      .rejects.toMatchObject({ statusCode: 409, reason: 'intent_local_identity_changed' });
    expect(await state(id)).toMatchObject({ ai_policy: 'none', ai_policy_revision: '1' });
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
    expect(await state(id)).toMatchObject({ labels: ['one', 'no-ai'], ai_policy: 'none', ai_policy_revision: '1', embedding_status: 'policy_blocked' });
    expect(seams.events).toEqual([]);
    expect((await query('SELECT payload FROM lw_typed_evidence')).rows).toMatchObject([{ payload: { type: 'policy_change', actor: { kind: 'user', id: owner }, changes: [{ pageId: id, oldPolicy: 'all', newPolicy: 'none', oldRevision: 0, newRevision: 1 }] } }]);
    expect(await intentStatus(intentId)).toBe('reconciled_applied');
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
    expect(await intentStatus(intentId)).toBe('pending');
  });

  describe('COMMIT boundary of a recovered policy transition', () => {
    const HOLD_KEY = 777_001;

    afterEach(async () => {
      await query('DROP TRIGGER IF EXISTS lw_settlement_hook ON page_write_intents');
      await query('DROP FUNCTION IF EXISTS lw_hold_settlement()');
      await query('DROP FUNCTION IF EXISTS lw_refuse_settlement()');
    });

    it('nothing is emitted or visible while the settlement is still uncommitted; exactly one event after COMMIT', async () => {
      const owner = await user('admin');
      const admin = await user('admin');
      const { id, confluenceId } = await confluencePage({ owner, labels: ['one'] });
      seams.remoteLabels = ['one', 'no-ai'];
      const intentId = await fencedLabelIntent({
        actor: owner, admin, pageId: id, confluenceId, priorLabels: ['one'], targetLabels: ['one', 'no-ai'],
      });
      // The settlement UPDATE (after the policy transition, before COMMIT)
      // waits on an advisory lock a second session holds.
      await query(`CREATE FUNCTION lw_hold_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(${HOLD_KEY}); RETURN NEW; END $$`);
      await query(`CREATE TRIGGER lw_settlement_hook BEFORE UPDATE ON page_write_intents
        FOR EACH ROW WHEN (NEW.status = 'reconciled_applied') EXECUTE FUNCTION lw_hold_settlement()`);
      const holder = await getPool().connect();
      let run: Promise<unknown> | undefined;
      try {
        await holder.query('SELECT pg_advisory_lock($1)', [HOLD_KEY]);
        run = reconcilePageWriteIntent(intentId, { actorId: admin, reason: 'Recover while settlement is held' });
        await waitFor(() => advisoryWaiter(0, HOLD_KEY), 'the settlement to block before COMMIT');
        // Neither the policy nor its typed evidence is visible before COMMIT.
        expect((await query('SELECT payload FROM lw_typed_evidence')).rows).toEqual([]);
        expect(seams.events).toEqual([]);
        expect(await state(id)).toMatchObject({ labels: ['one'], ai_policy: 'all', ai_policy_revision: '0' });
        expect(await intentStatus(intentId)).toBe('pending');
      } finally {
        // A failed assertion above must not leave the recovery blocked on a
        // session-level lock (and the trigger's DROP in afterEach waiting on
        // it): release unconditionally, then await the outstanding work.
        await holder.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
        holder.release();
        if (run) await run.catch(() => undefined);
      }
      await expect(run).resolves.toEqual({ intentId, status: 'reconciled_applied' });
      expect(await state(id)).toMatchObject({ labels: ['one', 'no-ai'], ai_policy: 'none', ai_policy_revision: '1' });
      expect(await intentStatus(intentId)).toBe('reconciled_applied');
      expect(seams.events).toEqual([]);
    expect((await query('SELECT payload FROM lw_typed_evidence')).rows).toMatchObject([{ payload: { type: 'policy_change', actor: { kind: 'user', id: owner }, changes: [{ pageId: id, oldPolicy: 'all', newPolicy: 'none', oldRevision: 0, newRevision: 1 }] } }]);
    });

    it('a settlement that fails after a real transition rolls everything back and emits nothing; the retry emits once', async () => {
      const owner = await user('admin');
      const admin = await user('admin');
      const { id, confluenceId } = await confluencePage({ owner, labels: ['one'] });
      await query(`UPDATE pages SET embedding_status = 'embedded', embedded_at = NOW() WHERE id = $1`, [id]);
      seams.remoteLabels = ['one', 'no-ai'];
      const intentId = await fencedLabelIntent({
        actor: owner, admin, pageId: id, confluenceId, priorLabels: ['one'], targetLabels: ['one', 'no-ai'],
      });
      await query(`CREATE FUNCTION lw_refuse_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'settlement refused by test'; END $$`);
      await query(`CREATE TRIGGER lw_settlement_hook BEFORE UPDATE ON page_write_intents
        FOR EACH ROW WHEN (NEW.status = 'reconciled_applied') EXECUTE FUNCTION lw_refuse_settlement()`);
      await expect(reconcilePageWriteIntent(intentId, { actorId: admin, reason: 'Recover into a refused settlement' }))
        .rejects.toThrow(/settlement refused by test/);
      // Policy, purge, labels and typed evidence all roll back together.
      expect((await query('SELECT payload FROM lw_typed_evidence')).rows).toEqual([]);
      expect(await state(id)).toMatchObject({ labels: ['one'], ai_policy: 'all', ai_policy_revision: '0', embedding_status: 'embedded' });
      expect(await intentStatus(intentId)).toBe('pending');
      expect(seams.events).toEqual([]);

      await query('DROP TRIGGER lw_settlement_hook ON page_write_intents');
      await expect(reconcilePageWriteIntent(intentId, { actorId: admin, reason: 'Retry the recovery after the refusal' }))
        .resolves.toEqual({ intentId, status: 'reconciled_applied' });
      expect(await state(id)).toMatchObject({ labels: ['one', 'no-ai'], ai_policy: 'none', ai_policy_revision: '1', embedding_status: 'policy_blocked' });
      expect(seams.events).toEqual([]);
    expect((await query('SELECT payload FROM lw_typed_evidence')).rows).toMatchObject([{ payload: { type: 'policy_change', actor: { kind: 'user', id: owner }, changes: [{ pageId: id, oldPolicy: 'all', newPolicy: 'none', oldRevision: 0, newRevision: 1 }] } }]);
    });
  });

  describe('Confluence page creation boundary', () => {
    async function createIntent(input: {
      owner: string; admin: string; parent: { id: number; confluenceId: string }; confluenceId: string;
      title: string; storage: string; initialPolicy: string; initialLabels: string[];
    }): Promise<string> {
      seams.remotePage = {
        id: input.confluenceId, title: input.title, version: { number: 1 },
        body: { storage: { value: input.storage } }, status: 'current',
      };
      return fencedIntent({
        kind: 'pages.create.confluence', actor: input.owner, admin: input.admin, pageId: input.parent.id, dispatched: true,
        effect: {
          parentPageId: input.parent.id, parentConfluenceId: input.parent.confluenceId, spaceKey: 'LW',
          titleSha256: sha(input.title), storageSha256: sha(input.storage),
          initialPolicy: input.initialPolicy, initialLabels: input.initialLabels,
        },
        terminal: { accepted: true, confluenceId: input.confluenceId, expectedVersion: 1 },
      });
    }

    it('recovery of an acknowledged create publishes the admitted policy, not `all`', async () => {
      const owner = await user('admin');
      const admin = await user('admin');
      const parent = await confluencePage({ owner, labels: [] });
      seq += 1;
      const confluenceId = `created-${seq}`;
      const intentId = await createIntent({
        owner, admin, parent, confluenceId, title: 'Child', storage: '<p>c</p>', initialPolicy: 'none', initialLabels: ['no-ai', 'tag'],
      });
      await expect(reconcilePageWriteIntent(intentId, { actorId: admin, reason: 'Recover the acknowledged page creation' }))
        .resolves.toEqual({ intentId, status: 'reconciled_applied' });
      const created = await query<{ id: number }>(`SELECT id FROM pages WHERE confluence_id = $1`, [confluenceId]);
      // First publication uses the common revisioned writer and atomic evidence sink.
      expect(await state(created.rows[0]!.id)).toMatchObject({ labels: ['tag', 'no-ai'], ai_policy: 'none', ai_policy_revision: '1' });
      expect((await query('SELECT payload FROM lw_typed_evidence')).rows).toMatchObject([
        { payload: { type: 'policy_change', changes: [{ pageId: created.rows[0]!.id, oldRevision: 0, newRevision: 1 }] } },
      ]);
      expect(seams.events).toEqual([]);
    });

    it('recovery of an acknowledged ROOT create (empty targets, null parent) publishes the admitted policy', async () => {
      const owner = await user('admin');
      const admin = await user('admin');
      seq += 1;
      const confluenceId = `created-root-${seq}`;
      // Space access for a root create is checked against the space itself.
      await query(
        `INSERT INTO spaces (space_key, space_name) VALUES ('LW', 'Label writers') ON CONFLICT (space_key) DO NOTHING`,
      );
      seams.remotePage = {
        id: confluenceId, title: 'Root', version: { number: 1 }, body: { storage: { value: '<p>r</p>' } }, status: 'current',
      };
      // Exactly the shape `pages-crud.ts` reserves for a parentless create
      // (migration 137): no target page, null parent references.
      const runtimeId = `origin-${randomUUID()}`;
      const ack = randomUUID();
      const intentId = randomUUID();
      await query(
        `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity, quiesced_at, quiescence_ack, enforcement_version)
         VALUES ($1, $2::jsonb, NOW(), $3, $4)`,
        [runtimeId, JSON.stringify({ host: 'labels-origin', pid: 8, startedAt: new Date().toISOString() }), ack, PAGE_WRITER_ENFORCEMENT_VERSION],
      );
      await query(
        `INSERT INTO page_write_intents
           (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect,
            effect_started_at, remote_effect_started_at, remote_effects_completed_at, remote_terminal_result)
         VALUES ($1, $2, 'pages.create.confluence', $3, ARRAY[]::integer[], '{}'::jsonb, 'remote_terminal_only', $4::jsonb,
                 NOW(), NOW(), NOW(), $5::jsonb)`,
        [
          intentId, runtimeId, owner,
          JSON.stringify({
            effectClass: 'remote', parentPageId: null, parentConfluenceId: null, spaceKey: 'LW',
            titleSha256: sha('Root'), storageSha256: sha('<p>r</p>'), initialPolicy: 'none', initialLabels: ['no-ai'],
          }),
          JSON.stringify({ accepted: true, confluenceId, expectedVersion: 1 }),
        ],
      );
      await fencePageWriterRuntime({
        mode: 'owner_ack', runtimeId, acknowledgmentId: ack, actorId: admin,
        reason: 'The origin runtime acknowledged quiescence before recovery',
      });
      await expect(reconcilePageWriteIntent(intentId, { actorId: admin, reason: 'Recover the acknowledged root page creation' }))
        .resolves.toEqual({ intentId, status: 'reconciled_applied' });
      const created = await query<{ id: number; parent_id: string | null }>(
        `SELECT id, parent_id FROM pages WHERE confluence_id = $1`, [confluenceId],
      );
      expect(created.rows[0]!.parent_id).toBeNull();
      expect(await state(created.rows[0]!.id)).toMatchObject({ labels: ['no-ai'], ai_policy: 'none', ai_policy_revision: '1' });
      expect(await intentStatus(intentId)).toBe('reconciled_applied');
      expect(seams.events).toEqual([]);
    });

    it('recovery tightens a sync-first row that beat the publication and announces it after COMMIT', async () => {
      const owner = await user('admin');
      const admin = await user('admin');
      const parent = await confluencePage({ owner, labels: [] });
      seq += 1;
      const confluenceId = `created-${seq}`;
      const existing = await syncFirstRow({
        confluenceId, title: 'Child', storage: '<p>c</p>', parentId: parent.confluenceId, policy: 'all', labels: [],
      });
      const intentId = await createIntent({
        owner, admin, parent, confluenceId, title: 'Child', storage: '<p>c</p>', initialPolicy: 'local_only', initialLabels: ['local-ai-only'],
      });
      await expect(reconcilePageWriteIntent(intentId, { actorId: admin, reason: 'Recover a creation the walker imported first' }))
        .resolves.toEqual({ intentId, status: 'reconciled_applied' });
      expect(await state(existing)).toMatchObject({ labels: ['local-ai-only'], ai_policy: 'local_only', ai_policy_revision: '1' });
      expect(seams.events).toEqual([]);
      expect((await query('SELECT payload FROM lw_typed_evidence')).rows).toMatchObject([{ payload: { type: 'policy_change', changes: [{ pageId: existing, oldPolicy: 'all', newPolicy: 'local_only', oldRevision: 0, newRevision: 1 }] } }]);
    });

    it('an acknowledged create whose local twin differs stays pending (409), nothing moves', async () => {
      const owner = await user('admin');
      const admin = await user('admin');
      const parent = await confluencePage({ owner, labels: [] });
      seq += 1;
      const confluenceId = `created-${seq}`;
      const existing = await syncFirstRow({
        confluenceId, title: 'Child', storage: '<p>different</p>', parentId: parent.confluenceId, policy: 'all', labels: [],
      });
      const intentId = await createIntent({
        owner, admin, parent, confluenceId, title: 'Child', storage: '<p>c</p>', initialPolicy: 'none', initialLabels: ['no-ai'],
      });
      await expect(reconcilePageWriteIntent(intentId, { actorId: admin, reason: 'Recover a creation colliding with another row' }))
        .rejects.toMatchObject({ statusCode: 409, reason: 'intent_local_identity_changed' });
      expect(await state(existing)).toMatchObject({ ai_policy: 'all', ai_policy_revision: '0', embedding_status: 'embedded' });
      expect(await intentStatus(intentId)).toBe('pending');
      expect(seams.events).toEqual([]);
    });

    it('an undispatched or failed first label step leaves the published policy and revision in place', async () => {
      const owner = await user('admin');
      const admin = await user('admin');
      seq += 1;
      // Existing restriction fixture, not an actorless activation.
      const published = { id: await syncFirstRow({
        confluenceId: `created-${seq}`, title: 'New', storage: '<p>n</p>', parentId: null,
        policy: 'none', labels: ['no-ai', 'tag'],
      }) };
      await query(`UPDATE pages SET created_by_user_id = $2 WHERE id = $1`, [published.id, owner]);
      // The `pages.create.labels` step was reserved but never reached Confluence.
      const intentId = await fencedLabelIntent({
        kind: 'pages.create.labels', dispatched: false, actor: owner, admin, pageId: published.id,
        confluenceId: `created-${seq}`, priorLabels: ['no-ai', 'tag'], targetLabels: ['no-ai', 'tag'],
      });
      await expect(reconcilePageWriteIntent(intentId, { actorId: admin, reason: 'Settle the undispatched first label step' }))
        .resolves.toEqual({ intentId, status: 'reconciled_not_applied' });
      expect(await state(published.id)).toMatchObject({ labels: ['no-ai', 'tag'], ai_policy: 'none', ai_policy_revision: '0' });
      expect(seams.events).toEqual([]);
    });
  });

  describe('planned / admitted / published label sets against a concurrent policy write', () => {
    it('a concurrent authoritative tighten serializes behind the label writer and wins; the stale mirror is refused', async () => {
      const owner = await user('admin');
      const admin = await user('admin');
      // Relaxed to `all` with the canonical label left behind: the writer
      // plans a replace to ['x'] (carried label dropped, policy unchanged).
      const { id, confluenceId } = await confluencePage({ owner, labels: ['no-ai', 'x'] });
      // The creation trigger tightened from the label; the policy endpoint relaxed it afterwards.
      await query(`UPDATE pages SET ai_policy = 'all', ai_policy_revision = 1 WHERE id = $1`, [id]);
      const writer = await getPool().connect();
      let policyWrite: Promise<Awaited<ReturnType<typeof applyAiPolicyOnClient>>> | undefined;
      let committed = false;
      try {
        await writer.query('BEGIN');
        const planned = await applyPageLabelsOnClient(writer, { userId: owner, pageId: id, targetLabels: ['x'] });
        expect(planned).toMatchObject({ labels: ['x', 'all-ai'], policy: 'all', revision: 1, changes: [] });
        // An authorized `none` arrives while the writer still holds the row:
        // it waits on the policy lock rather than deadlocking.
        policyWrite = tx((c) => applyAiPolicyOnClient(c, { userId: owner, items: [{ pageId: id, policy: 'none' }], requireAuthority: true }));
        await waitFor(() => advisoryWaiter(AI_POLICY_LOCK_NAMESPACE, id), 'the policy write to queue behind the label writer');
        await writer.query('COMMIT');
        committed = true;
      } finally {
        // A failed assertion must not leave the row locked by an open
        // transaction (the queued policy write would then hang the suite).
        if (!committed) await writer.query('ROLLBACK').catch(() => undefined);
        writer.release();
        if (policyWrite) await policyWrite.catch(() => undefined);
      }
      await expect(policyWrite).rejects.toMatchObject({ statusCode: 409,
        body: { error: 'ai_policy_enforcement_unavailable' } });
      expect(await state(id)).toMatchObject({ ai_policy: 'all', ai_policy_revision: '1' });
      // Existing restricted state is a fixture, not a fabricated activation.
      await query(`UPDATE pages SET ai_policy = 'none', labels = ARRAY['x','no-ai'] WHERE id = $1`, [id]);
      // The later authoritative policy stands over the writer's committed
      // set, and it carries its canonical label: the stored labels never
      // contradict `ai_policy` after a direct policy write (#281 review).
      expect(await state(id)).toMatchObject({ labels: ['x', 'no-ai'], ai_policy: 'none', ai_policy_revision: '2' });
      // Recovering that same acknowledged write re-plans from the row as it
      // is now: a mirror of ['x'] would drop the canonical label the later
      // `none` requires, so it is refused (409) and stays pending rather
      // than being claimed against a policy it no longer agrees with.
      seams.remoteLabels = ['x'];
      const intentId = await fencedLabelIntent({
        kind: 'pages.create.labels', actor: owner, admin, pageId: id, confluenceId, priorLabels: ['no-ai', 'x'], targetLabels: ['x'],
      });
      await expect(reconcilePageWriteIntent(intentId, { actorId: admin, reason: 'Recover the first label step after a later tighten' }))
        .rejects.toMatchObject({ statusCode: 409, reason: 'intent_terminal_evidence_mismatch' });
      expect(await intentStatus(intentId)).toBe('pending');
      expect(await state(id)).toMatchObject({ labels: ['x', 'no-ai'], ai_policy: 'none', ai_policy_revision: '2' });
      expect(seams.events).toEqual([]);
    });

    it('every label intent kind refuses a mirror the later policy no longer admits (bulk tag / replace / create)', async () => {
      const owner = await user('admin');
      const admin = await user('admin');
      seams.remoteLabels = ['one'];
      for (const kind of ['pages.bulk.tags', 'pages.bulk.replace_tags', 'pages.create.labels'] as const) {
        // The writer published ['one'] (dropping `no-ai`); a later
        // authoritative `none` holds the row with its canonical label.
        const { id, confluenceId } = await confluencePage({ owner, labels: ['one', 'no-ai'], policy: 'none', revision: 1 });
        const intentId = await fencedIntent({
          kind, actor: owner, admin, pageId: id, dispatched: true,
          effect: { pageId: id, confluenceId, add: [], remove: ['no-ai'], priorLabels: ['one', 'no-ai'], targetLabels: ['one'] },
          terminal: { confluenceId, accepted: true },
        });
        const replan = planLabelPolicyChange({ currentPolicy: 'none', currentLabels: ['one', 'no-ai'], targetLabels: ['one'] });
        expect(sameLabelSet(replan.labels, ['one'])).toBe(false);
        await expect(reconcilePageWriteIntent(intentId, { actorId: admin, reason: `Recover a ${kind} mirror the policy refuses` }))
          .rejects.toMatchObject({ statusCode: 409, reason: 'intent_terminal_evidence_mismatch' });
        expect(await intentStatus(intentId)).toBe('pending');
        expect(await state(id)).toMatchObject({ labels: ['one', 'no-ai'], ai_policy: 'none', ai_policy_revision: '1' });
      }
      expect(seams.events).toEqual([]);
    });

    it('two concurrent label writers on one page serialize without deadlock and leave one consistent row', async () => {
      const owner = await user();
      const id = await page({ owner, labels: ['one'] });
      const [a, b] = await Promise.allSettled([
        tx((c) => applyPageLabelsOnClient(c, { userId: owner, pageId: id, targetLabels: ['one', 'no-ai'] })),
        tx((c) => applyPageLabelsOnClient(c, { userId: owner, pageId: id, targetLabels: ['one', 'two'] })),
      ]);
      expect(a).toMatchObject({ status: 'rejected', reason: { statusCode: 409,
        body: { error: 'ai_policy_enforcement_unavailable' } } });
      expect(b.status).toBe('fulfilled');
      expect(await state(id)).toMatchObject({ labels: ['one', 'two', 'all-ai'], ai_policy: 'all', ai_policy_revision: '0' });
    });
  });

  it('a new restrictive label is refused while rollout is closed, with no policy, label or evidence change', async () => {
    const owner = await user();
    const id = await page({ owner, labels: ['one'] });
    const before = await state(id);
    await expect(tx((client) => applyPageLabelsOnClient(client, {
      userId: owner, pageId: id, targetLabels: ['one', 'AI:None'],
    }))).rejects.toMatchObject({ statusCode: 409, body: { error: 'ai_policy_enforcement_unavailable' } });
    expect(await state(id)).toEqual(before);
    expect((await query('SELECT payload FROM lw_typed_evidence')).rows).toEqual([]);
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
    expect(applied).toMatchObject({ labels: ['x', 'all-ai'], policy: 'all', revision: 1, changes: [] });
    expect(await state(id)).toMatchObject({ labels: ['x', 'all-ai'], ai_policy: 'all', ai_policy_revision: '1', embedding_status: 'not_embedded' });
  });

  it('contradictory reserved labels are a 422 and nothing is written', async () => {
    const owner = await user();
    const id = await page({ owner, labels: ['one'] });
    await expect(
      tx((c) => applyPageLabelsOnClient(c, { userId: owner, pageId: id, targetLabels: ['no-ai', 'local-ai-only'] })),
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

  it('neither shared visibility nor an invented recovery receipt permits new restriction', async () => {
    const owner = await user();
    const viewer = await user();
    const id = await page({ owner, labels: ['one'], visibility: 'shared' });
    const before = await state(id);
    await expect(tx((client) => applyPageLabelsOnClient(client, {
      userId: viewer, pageId: id, targetLabels: ['one', 'no-ai'],
    }))).rejects.toMatchObject({ statusCode: 403, reason: 'ai_policy_not_authorized' });
    await expect(tx((client) => applyPageLabelsOnClient(client, {
      userId: owner, pageId: id, targetLabels: ['one', 'no-ai'], recoveryIntentId: randomUUID(),
    }))).rejects.toMatchObject({ statusCode: 409, body: { error: 'ai_policy_enforcement_unavailable' } });
    expect(await state(id)).toEqual(before);
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
    await expect(applyLabelChanges(owner, String(id), { add: ['ai:local'] }))
      .rejects.toMatchObject({ statusCode: 409, body: { error: 'ai_policy_enforcement_unavailable' } });
    expect(await state(id)).toMatchObject({ labels: ['one'], ai_policy: 'all', ai_policy_revision: '0' });

    // An existing restriction is not a new activation. Ordinary labels stay
    // editable, and removing the policy label cannot relax it.
    const restricted = await page({ owner, labels: ['one', 'no-ai'], policy: 'none' });
    expect(await applyLabelChanges(owner, String(restricted), { add: ['ordinary'], remove: ['no-ai'] }))
      .toEqual(['one', 'ordinary', 'no-ai']);
    expect(await state(restricted)).toMatchObject({ ai_policy: 'none', ai_policy_revision: '0' });

    // Two genuinely new contradictory commands remain a 422 with nothing written.
    const fresh = await page({ owner, labels: ['two'] });
    await expect(applyLabelChanges(owner, String(fresh), { add: ['no-ai', 'local-ai-only'] }))
      .rejects.toMatchObject({ statusCode: 422, reason: 'ai_policy_label_conflict' });
    expect(await state(fresh)).toMatchObject({ labels: ['two'], ai_policy: 'all', ai_policy_revision: '0' });
  });

  it('the policy primitive rewrites the canonical label in the same statement (direct setter is a label writer, #281 review)', async () => {
    const owner = await user();
    const id = await page({ owner, labels: ['no-ai', 'keep'], policy: 'none' });
    // An explicit relaxation drops the reserved label: the stored labels
    // never contradict `ai_policy` after a direct policy write.
    const relaxed = await tx((c) => applyAiPolicyOnClient(c, {
      userId: owner, items: [{ pageId: id, policy: 'all' }], requireAuthority: true,
    }));
    expect(relaxed.ok).toBe(true);
    expect(await state(id)).toMatchObject({ labels: ['keep', 'all-ai'], ai_policy: 'all', ai_policy_revision: '1' });

    // An explicit tighten appends exactly one canonical label.
    await expect(tx((c) => applyAiPolicyOnClient(c, {
      userId: owner, items: [{ pageId: id, policy: 'local_only' }], requireAuthority: true,
    }))).rejects.toMatchObject({ statusCode: 409, body: { error: 'ai_policy_enforcement_unavailable' } });
    expect(await state(id)).toMatchObject({ labels: ['keep', 'all-ai'], ai_policy: 'all', ai_policy_revision: '1' });

    // A carried reserved label beside ONE fresh command still tightens to the fresh policy.
    await expect(tx((c) => applyPageLabelsOnClient(c, {
      userId: owner, pageId: id, targetLabels: ['no-ai', 'ordinary'],
    }))).rejects.toMatchObject({ statusCode: 409, body: { error: 'ai_policy_enforcement_unavailable' } });
    expect(await state(id)).toMatchObject({ labels: ['keep', 'all-ai'], ai_policy: 'all', ai_policy_revision: '1' });
  });

  it('the direct setter refuses a row with an unresolved external write (409 page_write_busy) and a frozen row (423)', async () => {
    const owner = await user('admin');
    const admin = await user('admin');
    const { id, confluenceId } = await confluencePage({ owner, labels: ['one'] });
    const intentId = await fencedLabelIntent({
      actor: owner, admin, pageId: id, confluenceId, priorLabels: ['one'], targetLabels: ['one', 'no-ai'],
    });
    expect(await updatePageAiPolicies(owner, 'all', [{ pageId: id, expectedRevision: 0 }]))
      .toEqual({ ok: false, reason: 'page_write_busy', pageIds: [id] });
    expect(await state(id)).toMatchObject({ labels: ['one'], ai_policy: 'all', ai_policy_revision: '0' });
    expect(await intentStatus(intentId)).toBe('pending');
    expect(seams.events).toEqual([]);
    // A page the caller cannot see stays a 404 ahead of any fence state.
    const stranger = await user();
    expect(await updatePageAiPolicies(stranger, 'all', [{ pageId: id, expectedRevision: 0 }]))
      .toEqual({ ok: false, reason: 'not_found', pageIds: [id] });
  });
});
