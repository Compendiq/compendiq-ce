import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { request } from 'undici';
import type * as Undici from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  insertPreexistingLegacyRuntime,
  insertTestRuntime,
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { getPool, query } from '../db/postgres.js';
import { encryptPat } from '../utils/crypto.js';
import { registerOrdinaryPageWriteReconcilers } from '../../domains/confluence/services/ordinary-page-write-reconciler.js';
import { setAiPolicyEnforcementForTest } from './ai-policy-activation.js';
import { observeIngestionAdmission, reconcileDeferredIngestionPolicy } from './ai-policy-deferred-ingestion.js';
import { admitAutomaticIngestionPolicy } from './ai-policy-ingestion.js';
import { AI_POLICY_RUNTIME_GUARD_CONSTRAINT, isAiPolicyRuntimeGuardError } from './ai-policy-runtime-guard.js';
import { reconcilePageWriteIntent } from './page-write-admission.js';

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof Undici>()),
  request: vi.fn(),
}));
const mockRequest = vi.mocked(request);

const dbAvailable = await isDbAvailable();

const TIGHTENING_REFUSED = { code: '55000', constraint: AI_POLICY_RUNTIME_GUARD_CONSTRAINT };
const REGISTRATION_REFUSED = { code: '55000', constraint: 'ai_policy_incompatible_runtime_registration' };

type Queryable = Pick<PoolClient, 'query'>;

/** Exactly the statement a pre-#1881 binary issues: it does not know the column. */
function registerOldBinary(runner: Queryable, runtimeId: string, onConflictDoNothing = false) {
  return runner.query(
    `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity, enforcement_version)
     VALUES ($1, '{"host":"old-binary","pid":1}'::jsonb, 1)
     ${onConflictDoNothing ? 'ON CONFLICT (runtime_id) DO NOTHING' : ''}`,
    [runtimeId],
  );
}

async function insertPage(
  policy: 'all' | 'local_only' | 'none',
  opts: { labels?: string[]; deleted?: boolean; client?: Queryable } = {},
): Promise<number> {
  const runner = opts.client ?? getPool();
  const inserted = await runner.query<{ id: number }>(
    `INSERT INTO pages (title, ai_policy, labels, deleted_at)
     VALUES ('door', $1, $2::text[], CASE WHEN $3::boolean THEN NOW() END) RETURNING id`,
    [policy, opts.labels ?? [], opts.deleted === true],
  );
  return inserted.rows[0]!.id;
}

async function pagePolicy(pageId: number): Promise<string> {
  return (await query<{ ai_policy: string }>('SELECT ai_policy FROM pages WHERE id = $1', [pageId])).rows[0]!.ai_policy;
}

async function fenceRuntime(runtimeId: string): Promise<void> {
  await query(
    `UPDATE page_writer_runtimes
        SET fenced_at = NOW(), fence_reason = 'Test fixture: old binary verified terminated',
            fence_proof = '{"kind":"verified_local_termination"}'::jsonb
      WHERE runtime_id = $1`,
    [runtimeId],
  );
}

/**
 * Run `statement` while another transaction holds the activation row FOR
 * UPDATE. A statement that takes the row lock would wait and trip the 1 s
 * `lock_timeout`; one that completes never locked.
 */
async function completesWithoutLockingActivationRow(statement: (client: PoolClient) => Promise<unknown>): Promise<void> {
  const holder = await getPool().connect();
  const probe = await getPool().connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM ai_policy_activation_state WHERE singleton = TRUE FOR UPDATE');
    await probe.query('BEGIN');
    await probe.query(`SET LOCAL lock_timeout = '1s'`);
    await statement(probe);
    await probe.query('COMMIT');
  } finally {
    await probe.query('ROLLBACK').catch(() => undefined);
    await holder.query('ROLLBACK').catch(() => undefined);
    probe.release();
    holder.release();
  }
}

async function backendPid(client: PoolClient): Promise<number> {
  return (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
}

async function isBlockedBy(waiter: number, holder: number): Promise<boolean> {
  return (await query<{ blocked: boolean }>(
    'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked',
    [waiter, holder],
  )).rows[0]!.blocked;
}

const settle = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));

async function seedAdmin(prefix: string, opts: { confluence?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO users (id, username, email, password_hash, role) VALUES ($1::uuid, $2, $3, 'x', 'admin')`,
    [id, `${prefix}-${id}`, `${id}@test.invalid`],
  );
  if (opts.confluence) {
    await query(
      `INSERT INTO user_settings (user_id, confluence_url, confluence_pat)
       VALUES ($1, 'https://confluence.example.com', $2)`,
      [id, encryptPat('door-pat')],
    );
  }
  return id;
}

function labelsReply(labels: string[]) {
  return {
    statusCode: 200,
    headers: {},
    body: { text: async () => JSON.stringify({ results: labels.map((name) => ({ name })) }) },
  } as never;
}

describe.skipIf(!dbAvailable)('article AI policy binary door (migration 151) — real PostgreSQL', () => {
  beforeAll(async () => {
    await setupTestDb();
    registerOrdinaryPageWriteReconcilers();
  });
  beforeEach(async () => {
    await truncateAllTables();
    mockRequest.mockReset();
  });
  afterEach(async () => {
    await setAiPolicyEnforcementForTest(false);
  });
  afterAll(async () => { await teardownTestDb(); });

  describe('isAiPolicyRuntimeGuardError', () => {
    it('recognizes the tightening guard by SQLSTATE and constraint name only', async () => {
      await registerOldBinary(getPool(), 'old-binary');
      const refused = await settle(insertPage('none'));
      expect('error' in refused && isAiPolicyRuntimeGuardError(refused.error)).toBe(true);
      expect(isAiPolicyRuntimeGuardError({ code: '55000' })).toBe(false);
      expect(isAiPolicyRuntimeGuardError({ code: '55000', constraint: 'ai_policy_incompatible_runtime_registration' })).toBe(false);
      expect(isAiPolicyRuntimeGuardError({ code: '23514', constraint: AI_POLICY_RUNTIME_GUARD_CONSTRAINT })).toBe(false);
      expect(isAiPolicyRuntimeGuardError(new Error('55000'))).toBe(false);
      expect(isAiPolicyRuntimeGuardError(null)).toBe(false);
    });
  });

  describe('registration guard', () => {
    it('admits a new old-binary runtime while the switch is off and nothing is restricted', async () => {
      await insertPage('all', { labels: ['all-ai'] });
      await registerOldBinary(getPool(), 'old-binary');
      expect((await query(
        `SELECT enforcement_version, ai_policy_enforcement_version FROM page_writer_runtimes WHERE runtime_id = 'old-binary'`,
      )).rows).toEqual([{ enforcement_version: 1, ai_policy_enforcement_version: 0 }]);
    });

    it('refuses a new old-binary runtime while the switch is on, and admits it again once off', async () => {
      await query('UPDATE ai_policy_activation_state SET enabled = TRUE');
      await expect(registerOldBinary(getPool(), 'old-binary')).rejects.toMatchObject(REGISTRATION_REFUSED);
      await expect(insertTestRuntime({ legacy: true })).rejects.toMatchObject(REGISTRATION_REFUSED);
      // A current binary is never affected.
      await expect(insertTestRuntime()).resolves.toBeTypeOf('string');
      await query('UPDATE ai_policy_activation_state SET enabled = FALSE');
      await expect(registerOldBinary(getPool(), 'old-binary')).resolves.toMatchObject({ rowCount: 1 });
    });

    it.each([
      ['a live restricted page', false],
      ['a soft-deleted restricted page (fail closed)', true],
    ])('refuses a new old-binary runtime while %s exists, independent of the switch', async (_label, deleted) => {
      await insertPage('local_only', { deleted });
      await expect(registerOldBinary(getPool(), 'old-binary')).rejects.toMatchObject(REGISTRATION_REFUSED);
      expect((await query(`SELECT count(*)::int AS n FROM page_writer_runtimes WHERE runtime_id = 'old-binary'`)).rows[0]!.n).toBe(0);
    });

    it('refuses downgrading an active runtime to version 0 while a restriction exists, and allows it otherwise', async () => {
      const runtimeId = await insertTestRuntime();
      const pageId = await insertPage('none');
      await expect(query('UPDATE page_writer_runtimes SET ai_policy_enforcement_version = 0 WHERE runtime_id = $1', [runtimeId]))
        .rejects.toMatchObject(REGISTRATION_REFUSED);
      await query(`UPDATE pages SET ai_policy = 'all' WHERE id = $1`, [pageId]);
      await expect(query('UPDATE page_writer_runtimes SET ai_policy_enforcement_version = 0 WHERE runtime_id = $1', [runtimeId]))
        .resolves.toMatchObject({ rowCount: 1 });
      await expect(query('UPDATE page_writer_runtimes SET ai_policy_enforcement_version = 1 WHERE runtime_id = $1', [runtimeId]))
        .resolves.toMatchObject({ rowCount: 1 });
    });

    it('never locks the activation row for a current-version registration, even while the switch is on', async () => {
      await query('UPDATE ai_policy_activation_state SET enabled = TRUE');
      await completesWithoutLockingActivationRow((client) => insertTestRuntime({ client }));
    });

    it('never locks or raises for the per-admission re-registration of an existing old-binary runtime', async () => {
      await registerOldBinary(getPool(), 'old-binary');
      // Restrictions now exist only in the pre-151 sense (installed before
      // the door); the live old binary keeps re-registering on every admission.
      await insertPage('none', { client: await lockedDoorBypass() });
      await completesWithoutLockingActivationRow(async (client) => {
        await expect(registerOldBinary(client, 'old-binary', true)).resolves.toMatchObject({ rowCount: 0 });
      });
    });

    it('never locks or raises for already fenced or quiesced version-0 fixture rows beside a restriction', async () => {
      await insertPage('none');
      await completesWithoutLockingActivationRow(async (client) => {
        await insertTestRuntime({ legacy: true, fenced: true, client });
        await insertTestRuntime({ legacy: true, quiesced: true, client });
      });
      expect((await query(
        `SELECT count(*)::int AS n FROM page_writer_runtimes WHERE ai_policy_enforcement_version = 0`,
      )).rows[0]!.n).toBe(2);
      // Those rows do not count as active for the tightening guard either.
      await expect(insertPage('local_only')).resolves.toBeTypeOf('number');
    });

    it('raises when the activation state row is missing instead of admitting the runtime', async () => {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM ai_policy_activation_state');
        await expect(registerOldBinary(client, 'old-binary')).rejects.toMatchObject({ code: '55000' });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  describe('tightening guard', () => {
    it('refuses every path that stores a restriction while an old-binary runtime is active, and admits them once it is fenced', async () => {
      await registerOldBinary(getPool(), 'old-binary');
      await expect(insertPage('none')).rejects.toMatchObject(TIGHTENING_REFUSED);
      await expect(insertPage('local_only')).rejects.toMatchObject(TIGHTENING_REFUSED);
      // The BEFORE INSERT label trigger (135) produces the restriction; the
      // AFTER guard sees that value, not the inserted 'all'.
      await expect(insertPage('all', { labels: ['no-ai'] })).rejects.toMatchObject(TIGHTENING_REFUSED);
      const pageId = await insertPage('all', { labels: ['all-ai'] });
      await expect(query(`UPDATE pages SET ai_policy = 'local_only' WHERE id = $1`, [pageId])).rejects.toMatchObject(TIGHTENING_REFUSED);
      await expect(query(`UPDATE pages SET ai_policy = 'none', ai_policy_revision = 1 WHERE id = $1`, [pageId])).rejects.toMatchObject(TIGHTENING_REFUSED);
      // Non-policy writes are untouched.
      await expect(query(`UPDATE pages SET labels = ARRAY['ordinary'], title = 'renamed' WHERE id = $1`, [pageId])).resolves.toMatchObject({ rowCount: 1 });
      expect(await pagePolicy(pageId)).toBe('all');
      expect((await query('SELECT count(*)::int AS n FROM pages')).rows[0]!.n).toBe(1);

      await fenceRuntime('old-binary');
      await expect(query(`UPDATE pages SET ai_policy = 'local_only' WHERE id = $1`, [pageId])).resolves.toMatchObject({ rowCount: 1 });
      await expect(insertPage('none')).resolves.toBeTypeOf('number');
      await expect(insertPage('all', { labels: ['no-ai'] })).resolves.toBeTypeOf('number');
    });

    it('is cleared by quiescence as well as fencing', async () => {
      await registerOldBinary(getPool(), 'old-binary');
      await expect(insertPage('none')).rejects.toMatchObject(TIGHTENING_REFUSED);
      await query(
        `UPDATE page_writer_runtimes SET quiesced_at = NOW(), quiescence_ack = gen_random_uuid() WHERE runtime_id = 'old-binary'`,
      );
      await expect(insertPage('none')).resolves.toBeTypeOf('number');
    });

    it('admits relaxations and unchanged writes beside a pre-151 old-binary runtime, refuses only what is stricter', async () => {
      const pageId = await insertPage('none', { labels: ['no-ai'] });
      await insertPreexistingLegacyRuntime();
      // Relaxations never lock the activation row either.
      await completesWithoutLockingActivationRow(async (client) => {
        await client.query(`UPDATE pages SET ai_policy = 'local_only' WHERE id = $1`, [pageId]);
        await client.query(`UPDATE pages SET labels = ARRAY['local-ai-only', 'extra'] WHERE id = $1`, [pageId]);
      });
      expect(await pagePolicy(pageId)).toBe('local_only');
      await expect(query(`UPDATE pages SET ai_policy = 'none' WHERE id = $1`, [pageId])).rejects.toMatchObject(TIGHTENING_REFUSED);
      expect(await pagePolicy(pageId)).toBe('local_only');
      await expect(query(`UPDATE pages SET ai_policy = 'all' WHERE id = $1`, [pageId])).resolves.toMatchObject({ rowCount: 1 });
      await expect(query(`UPDATE pages SET ai_policy = 'local_only' WHERE id = $1`, [pageId])).rejects.toMatchObject(TIGHTENING_REFUSED);
      expect(await pagePolicy(pageId)).toBe('all');
    });

    it('raises when the activation state row is missing instead of storing the restriction', async () => {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM ai_policy_activation_state');
        await expect(insertPage('none', { client })).rejects.toMatchObject({ code: '55000' });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  describe('two-connection interleavings', () => {
    it('registration first: the tightening waits on the activation row, then sees the committed old runtime and is refused', async () => {
      const registering = await getPool().connect();
      const tightening = await getPool().connect();
      let attempt: Promise<unknown> | undefined;
      try {
        await registering.query('BEGIN');
        const registeringPid = await backendPid(registering);
        await registerOldBinary(registering, 'racing-old-binary');
        await tightening.query('BEGIN');
        const tighteningPid = await backendPid(tightening);
        attempt = settle(tightening.query(`INSERT INTO pages (title, ai_policy) VALUES ('race', 'none')`));
        await expect.poll(() => isBlockedBy(tighteningPid, registeringPid), { timeout: 5_000 }).toBe(true);
        await registering.query('COMMIT');
        await expect(attempt).resolves.toMatchObject({ error: TIGHTENING_REFUSED });
      } finally {
        await attempt;
        await tightening.query('ROLLBACK').catch(() => undefined);
        await registering.query('ROLLBACK').catch(() => undefined);
        tightening.release();
        registering.release();
      }
      expect((await query(`SELECT count(*)::int AS n FROM pages`)).rows[0]!.n).toBe(0);
      expect((await query(`SELECT count(*)::int AS n FROM page_writer_runtimes WHERE runtime_id = 'racing-old-binary'`)).rows[0]!.n).toBe(1);
    });

    it('tightening first: the registration waits on the activation row, then sees the committed restriction and is refused', async () => {
      const registering = await getPool().connect();
      const tightening = await getPool().connect();
      let attempt: Promise<unknown> | undefined;
      try {
        await tightening.query('BEGIN');
        const tighteningPid = await backendPid(tightening);
        await tightening.query(`INSERT INTO pages (title, ai_policy) VALUES ('race', 'none')`);
        await registering.query('BEGIN');
        const registeringPid = await backendPid(registering);
        attempt = settle(registerOldBinary(registering, 'racing-old-binary'));
        await expect.poll(() => isBlockedBy(registeringPid, tighteningPid), { timeout: 5_000 }).toBe(true);
        await tightening.query('COMMIT');
        await expect(attempt).resolves.toMatchObject({ error: REGISTRATION_REFUSED });
      } finally {
        await attempt;
        await registering.query('ROLLBACK').catch(() => undefined);
        await tightening.query('ROLLBACK').catch(() => undefined);
        registering.release();
        tightening.release();
      }
      expect((await query(`SELECT ai_policy FROM pages`)).rows).toEqual([{ ai_policy: 'none' }]);
      expect((await query(`SELECT count(*)::int AS n FROM page_writer_runtimes WHERE runtime_id = 'racing-old-binary'`)).rows[0]!.n).toBe(0);
    });

    it('tightenings share the activation row with each other, while an enabling FOR UPDATE waits for them', async () => {
      const first = await getPool().connect();
      const second = await getPool().connect();
      const enabling = await getPool().connect();
      let enable: Promise<unknown> | undefined;
      try {
        await first.query('BEGIN');
        const firstPid = await backendPid(first);
        await first.query(`INSERT INTO pages (title, ai_policy) VALUES ('first', 'none')`);
        await second.query('BEGIN');
        await second.query(`SET LOCAL lock_timeout = '1s'`);
        await expect(second.query(`INSERT INTO pages (title, ai_policy) VALUES ('second', 'local_only')`)).resolves.toMatchObject({ rowCount: 1 });
        await second.query('COMMIT');
        await enabling.query('BEGIN');
        const enablingPid = await backendPid(enabling);
        enable = settle(enabling.query('SELECT 1 FROM ai_policy_activation_state WHERE singleton = TRUE FOR UPDATE'));
        await expect.poll(() => isBlockedBy(enablingPid, firstPid), { timeout: 5_000 }).toBe(true);
        await first.query('COMMIT');
        await expect(enable).resolves.toMatchObject({ value: { rowCount: 1 } });
        await enabling.query('COMMIT');
      } finally {
        await enable;
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        await enabling.query('ROLLBACK').catch(() => undefined);
        first.release();
        second.release();
        enabling.release();
      }
      expect((await query(`SELECT count(*)::int AS n FROM pages WHERE ai_policy <> 'all'`)).rows[0]!.n).toBe(2);
    });
  });

  describe('N24: workers and recovery treat the refusal as a refused tightening', () => {
    it('deferred ingestion stays pending on the refusal and completes once the old runtime is fenced', async () => {
      const actor = await seedAdmin('ingestion');
      const sourceId = randomUUID();
      const observation = {
        source: 'notion' as const, sourceScope: actor, sourceId,
        observedRevision: '1', userId: actor, policy: 'none' as const,
      };
      // Observed while the switch was closed: the restriction is remembered.
      await expect(observeIngestionAdmission(observation, async (_client, policy) =>
        admitAutomaticIngestionPolicy({ identity: sourceId, currentPolicy: 'all', candidate: policy })))
        .rejects.toMatchObject({ reason: 'ai_policy_enforcement_unavailable' });
      const pageId = (await query<{ id: number }>(
        `INSERT INTO pages (title, source, visibility, created_by_user_id, notion_page_id, labels)
         VALUES ('Imported', 'standalone', 'private', $1, $2, ARRAY['all-ai']) RETURNING id`,
        [actor, sourceId],
      )).rows[0]!.id;
      // An old binary that registered before the switch was turned on.
      const oldRuntime = await insertTestRuntime({ legacy: true });
      await setAiPolicyEnforcementForTest(true);

      expect(await reconcileDeferredIngestionPolicy({ ...observation, pageId })).toBe(0);
      expect((await query('SELECT ai_policy, ai_policy_revision FROM pages WHERE id = $1', [pageId])).rows)
        .toEqual([{ ai_policy: 'all', ai_policy_revision: '0' }]);
      expect((await query('SELECT applied_at, applied_page_id FROM ai_policy_deferred_ingestion WHERE source_scope = $1', [actor])).rows)
        .toEqual([{ applied_at: null, applied_page_id: null }]);

      await fenceRuntime(oldRuntime);
      expect(await reconcileDeferredIngestionPolicy({ ...observation, pageId })).toBe(1);
      expect((await query('SELECT ai_policy, ai_policy_revision FROM pages WHERE id = $1', [pageId])).rows)
        .toEqual([{ ai_policy: 'none', ai_policy_revision: '1' }]);
      expect((await query('SELECT applied_at IS NOT NULL AS applied, applied_page_id FROM ai_policy_deferred_ingestion WHERE source_scope = $1', [actor])).rows)
        .toEqual([{ applied: true, applied_page_id: pageId }]);
    });

    it('recovery replay of an acknowledged restrictive label write stays pending on the refusal and completes once the old runtime is fenced', async () => {
      const actor = await seedAdmin('writer', { confluence: true });
      const recoveryAdmin = await seedAdmin('recovery');
      await query(`INSERT INTO spaces (space_key, space_name) VALUES ('REC', 'Recovery') ON CONFLICT (space_key) DO NOTHING`);
      const page = (await query<{ id: number; content_revision: string; lifecycle_revision: string }>(
        `INSERT INTO pages (confluence_id, space_key, title, labels, source, visibility, created_by_user_id)
         VALUES ('remote-label-page', 'REC', 'Label recovery', ARRAY['before'], 'confluence', 'private', $1)
         RETURNING id, content_revision::text, lifecycle_revision::text`,
        [actor],
      )).rows[0]!;
      const deadWriter = await insertTestRuntime({ fenced: true });
      const intentId = randomUUID();
      await query(
        `INSERT INTO page_write_intents
           (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect,
            effect_started_at, remote_effect_started_at, remote_effects_completed_at, remote_terminal_result)
         VALUES ($1, $2, 'page.labels', $3, ARRAY[$4]::int[], $5::jsonb, 'remote_terminal_only', $6::jsonb,
                 NOW(), NOW(), NOW(), '{}'::jsonb)`,
        [
          intentId, deadWriter, actor, page.id,
          JSON.stringify({ [page.id]: { contentRevision: page.content_revision, lifecycleRevision: page.lifecycle_revision } }),
          JSON.stringify({
            effectClass: 'remote', pageId: page.id, confluenceId: 'remote-label-page',
            priorLabels: ['before'], targetLabels: ['after', 'no-ai'],
          }),
        ],
      );
      const oldRuntime = await insertTestRuntime({ legacy: true });
      mockRequest.mockResolvedValue(labelsReply(['after', 'no-ai']));

      // The journal is valid, so the replay reaches the policy primitive; the
      // guard refuses the tightening and the whole settlement rolls back.
      await expect(reconcilePageWriteIntent(intentId, {
        actorId: recoveryAdmin, reason: 'Finish the acknowledged restrictive label write',
      })).rejects.toMatchObject(TIGHTENING_REFUSED);
      expect((await query('SELECT status FROM page_write_intents WHERE id = $1', [intentId])).rows)
        .toEqual([{ status: 'pending' }]);
      expect((await query('SELECT ai_policy, labels FROM pages WHERE id = $1', [page.id])).rows)
        .toEqual([{ ai_policy: 'all', labels: ['before'] }]);

      await fenceRuntime(oldRuntime);
      await expect(reconcilePageWriteIntent(intentId, {
        actorId: recoveryAdmin, reason: 'Finish the acknowledged restrictive label write',
      })).resolves.toEqual({ intentId, status: 'reconciled_applied' });
      const settled = (await query<{ ai_policy: string; labels: string[] }>(
        'SELECT ai_policy, labels FROM pages WHERE id = $1', [page.id],
      )).rows[0]!;
      expect(settled.ai_policy).toBe('none');
      expect([...settled.labels].sort()).toEqual(['after', 'no-ai']);
      expect((await query('SELECT status FROM page_write_intents WHERE id = $1', [intentId])).rows)
        .toEqual([{ status: 'reconciled_applied' }]);
    });
  });
});

/**
 * The re-registration test needs a restriction stored beside a live old
 * binary — the pre-151 state. Store it with the tightening guard off for one
 * statement, on a pooled client that is released right away.
 */
async function lockedDoorBypass(): Promise<Queryable> {
  return {
    query: (async (text: string, values?: unknown[]) => {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE pages DISABLE TRIGGER guard_ai_policy_tightening_insert');
        const result = await client.query(text, values);
        await client.query('ALTER TABLE pages ENABLE TRIGGER guard_ai_policy_tightening_insert');
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }) as PoolClient['query'],
  };
}
