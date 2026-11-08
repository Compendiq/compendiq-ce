/**
 * #1881 — the article AI policy enforcement switch, against real Postgres.
 *
 * Design §2.3/§2.4 and §5 row A4: every blocker is observed from real rows,
 * the acknowledgement overrides only the two legacy-client blockers and never
 * carries over a disable, transitions are idempotent and audited once, two
 * concurrent enables serialize on the row lock, a held lock answers the
 * retryable 503 after `lock_timeout`, and the process cache only ever
 * changes by reading the database (cold load, bus signal, reconnect, poll,
 * writer reload, test seam).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RedisClientType } from 'redis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPool, query } from '../db/postgres.js';
import {
  insertTestRuntime,
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { getAccessTokenLifetimeSeconds } from '../plugins/auth.js';
import { logger } from '../utils/logger.js';
import { prefixedRedisChannel } from '../utils/prefixed-redis-channel.js';
import { close as closeCacheBus, initCacheBus } from './redis-cache-bus.js';
import { isAiPolicyEnforcementAvailable } from './ai-policy-service.js';
import {
  _resetAiPolicyActivationForTests,
  AI_POLICY_ACTIVATION_CHANNEL,
  AI_POLICY_ACTIVATION_POLL_MS,
  AiPolicyActivationError,
  getAiPolicyActivationState,
  isAiPolicyEnforcementEnabledCached,
  loadAiPolicyActivation,
  registerAiPolicyActivationReadiness,
  setAiPolicyEnforcementEnabled,
  setAiPolicyEnforcementForTest,
  stopAiPolicyActivation,
  warnIfAiPolicyEnforcementEnvSet,
} from './ai-policy-activation.js';

const available = await isDbAvailable();
const LIFETIME_SECONDS = getAccessTokenLifetimeSeconds();
const SLACK_SECONDS = 30;

async function insertUser(role: 'admin' | 'user', displayName: string | null = null): Promise<string> {
  const username = `activation-${role}-${randomUUID().slice(0, 8)}`;
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
    [username, displayName, role],
  );
  return result.rows[0]!.id;
}

async function auditRows(): Promise<Array<{ user_id: string | null; action: string; metadata: Record<string, unknown> }>> {
  const result = await query<{ user_id: string | null; action: string; metadata: Record<string, unknown> }>(
    `SELECT user_id, action, metadata FROM audit_log
      WHERE action IN ('AI_POLICY_ENFORCEMENT_ACTIVATED', 'AI_POLICY_ENFORCEMENT_DEACTIVATED')
      ORDER BY created_at, id`,
  );
  return result.rows;
}

async function stateRow() {
  const result = await query<{
    enabled: boolean; changed_at: Date | null; changed_by_user_id: string | null;
    changed_by_name: string | null; legacy_clients_acknowledged: boolean;
  }>(
    `SELECT enabled, changed_at, changed_by_user_id, changed_by_name, legacy_clients_acknowledged
       FROM ai_policy_activation_state WHERE singleton`,
  );
  return result.rows[0]!;
}

async function observeLegacyClient(userId: string, expiresInSeconds: number, lastSeenSecondsAgo = 0): Promise<void> {
  await query(
    `INSERT INTO ai_policy_legacy_client_observations (user_id, last_seen_at, token_expires_at, observations)
     VALUES ($1, NOW() - make_interval(secs => $3::double precision), NOW() + make_interval(secs => $2::double precision), 1)`,
    [userId, expiresInSeconds, lastSeenSecondsAgo],
  );
}

function expectRefusal(err: unknown, codes: string[]): void {
  expect(err).toBeInstanceOf(AiPolicyActivationError);
  const refusal = err as AiPolicyActivationError;
  expect(refusal.statusCode).toBe(409);
  expect(refusal.body.error).toBe('ai_policy_activation_refused');
  if (refusal.body.error !== 'ai_policy_activation_refused') throw new Error('unreachable');
  expect(refusal.body.blockers.map((blocker) => blocker.code).sort()).toEqual([...codes].sort());
}

/** Minimal stand-in for the Redis client pair the cache bus duplicates. */
function createMockRedis() {
  const channelHandlers = new Map<string, (message: string) => void>();
  const readyListeners: Array<() => void> = [];
  const subscriber = {
    on: (event: string, fn: () => void) => { if (event === 'ready') readyListeners.push(fn); },
    connect: async () => undefined,
    subscribe: async (channel: string, handler: (message: string) => void) => { channelHandlers.set(channel, handler); },
    unsubscribe: async () => { channelHandlers.clear(); },
    quit: async () => undefined,
  };
  const main = { duplicate: () => subscriber, publish: async () => 1 };
  return {
    main: main as unknown as RedisClientType,
    emit(channel: string, message: string) {
      const handler = channelHandlers.get(prefixedRedisChannel(channel));
      if (!handler) throw new Error(`no subscriber for channel ${channel}`);
      handler(message);
    },
    emitReady() { for (const fn of readyListeners) fn(); },
  };
}

describe.skipIf(!available)('article AI policy activation switch (#1881)', () => {
  let adminId: string;

  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { _resetAiPolicyActivationForTests(); await teardownTestDb(); });
  beforeEach(async () => {
    await truncateAllTables();
    _resetAiPolicyActivationForTests();
    registerAiPolicyActivationReadiness();
    adminId = await insertUser('admin', '  Ada Admin ');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  describe('readiness and transitions', () => {
    it('refuses to enable before the readiness provider is registered (not overridable)', async () => {
      _resetAiPolicyActivationForTests();
      const state = await getAiPolicyActivationState(adminId);
      expect(state).toMatchObject({ enabled: false, ready: false, legacyClientsAcknowledged: false, changedAt: null, changedBy: null });
      expect(state.blockers).toEqual([{ code: 'ai_policy_enforcement_not_registered', overridable: false }]);
      await setAiPolicyEnforcementEnabled(adminId, { enabled: true, acknowledgeLegacyClients: true })
        .then(() => { throw new Error('enabled without readiness'); }, (err) => expectRefusal(err, ['ai_policy_enforcement_not_registered']));
      expect((await stateRow()).enabled).toBe(false);
      expect(await auditRows()).toEqual([]);
      expect(isAiPolicyEnforcementEnabledCached()).toBe(false);
    });

    it('a fresh database is ready; enabling records actor and time once, the writer sees it immediately, a repeat is idempotent', async () => {
      const before = await getAiPolicyActivationState(adminId);
      expect(before).toMatchObject({ enabled: false, ready: true, blockers: [] });
      expect(isAiPolicyEnforcementAvailable()).toBe(false);

      const started = Date.now();
      const enabled = await setAiPolicyEnforcementEnabled(adminId, { enabled: true });
      expect(enabled).toMatchObject({
        enabled: true, ready: true, blockers: [], legacyClientsAcknowledged: false,
        changedBy: adminId, changedByName: 'Ada Admin',
      });
      expect(Math.abs(new Date(enabled.changedAt!).getTime() - started)).toBeLessThan(10_000);
      // The writer reloads its own cache from the committed row — no bus involved.
      expect(isAiPolicyEnforcementEnabledCached()).toBe(true);
      expect(isAiPolicyEnforcementAvailable()).toBe(true);

      const audits = await auditRows();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ user_id: adminId, action: 'AI_POLICY_ENFORCEMENT_ACTIVATED' });
      expect(audits[0]!.metadata).toMatchObject({ enabled: true, blockers: [], legacyClientsAcknowledged: false });

      const repeat = await setAiPolicyEnforcementEnabled(adminId, { enabled: true });
      expect(repeat).toEqual(enabled);
      expect(await auditRows()).toHaveLength(1);
      expect(await getAiPolicyActivationState(adminId)).toEqual(enabled);
    });

    it('disabling needs no preconditions, records actor and time, and a repeat is idempotent', async () => {
      await setAiPolicyEnforcementEnabled(adminId, { enabled: true });
      const other = await insertUser('admin');
      const disabled = await setAiPolicyEnforcementEnabled(other, { enabled: false });
      expect(disabled).toMatchObject({ enabled: false, changedBy: other, legacyClientsAcknowledged: false });
      expect(isAiPolicyEnforcementEnabledCached()).toBe(false);
      const audits = await auditRows();
      expect(audits.map((row) => row.action)).toEqual(['AI_POLICY_ENFORCEMENT_ACTIVATED', 'AI_POLICY_ENFORCEMENT_DEACTIVATED']);
      expect(audits[1]).toMatchObject({ user_id: other });
      expect(await setAiPolicyEnforcementEnabled(adminId, { enabled: false })).toEqual(disabled);
      expect(await auditRows()).toHaveLength(2);
    });

    it('an active version-0 runtime is a non-overridable blocker with total and details; fenced and quiesced rows are ignored', async () => {
      await insertTestRuntime();
      await insertTestRuntime({ legacy: true, fenced: true });
      const legacyId = await insertTestRuntime({ legacy: true, runtimeId: 'legacy-active-writer' });

      const state = await getAiPolicyActivationState(adminId);
      expect(state.ready).toBe(false);
      const runtime = state.blockers.find((blocker) => blocker.code === 'incompatible_ai_policy_runtime');
      expect(runtime).toMatchObject({
        overridable: false, total: 1,
        runtimes: [{ runtimeId: legacyId, host: 'test-fixture', pid: process.pid }],
      });
      expect(runtime && runtime.code === 'incompatible_ai_policy_runtime' ? runtime.runtimes[0]!.startedAt : null)
        .toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(state.blockers.map((blocker) => blocker.code)).toEqual(['incompatible_ai_policy_runtime']);

      // The acknowledgement covers legacy CLIENTS only; a runtime stays a veto.
      await setAiPolicyEnforcementEnabled(adminId, { enabled: true, acknowledgeLegacyClients: true })
        .then(() => { throw new Error('enabled beside a legacy runtime'); }, (err) => expectRefusal(err, ['incompatible_ai_policy_runtime']));
      expect((await stateRow()).enabled).toBe(false);
      expect(await auditRows()).toEqual([]);

      await query(`UPDATE page_writer_runtimes SET quiesced_at = NOW(), quiescence_ack = gen_random_uuid() WHERE runtime_id = $1`, [legacyId]);
      const after = await getAiPolicyActivationState(adminId);
      expect(after.blockers.map((blocker) => blocker.code)).not.toContain('incompatible_ai_policy_runtime');
    });

    it('legacy clients: observations inside expiry + 30 s slack block, are attributed, and are overridable only by an acknowledgement that is reset by disable', async () => {
      const recent = await insertUser('user');
      const slackOnly = await insertUser('user');
      const expired = await insertUser('user');
      await observeLegacyClient(recent, 3_600, 5);
      await observeLegacyClient(slackOnly, -10, 60);
      await observeLegacyClient(expired, -40, 120);

      const state = await getAiPolicyActivationState(adminId);
      expect(state.blockers.map((blocker) => blocker.code)).toEqual(['legacy_clients_active']);
      const legacy = state.blockers[0]!;
      if (legacy.code !== 'legacy_clients_active') throw new Error('unreachable');
      expect(legacy).toMatchObject({ overridable: true, users: 2 });
      expect(legacy.recent.map((entry) => entry.userId)).toEqual([recent, slackOnly]);
      expect(legacy.recent[0]!.username).toMatch(/^activation-user-/);
      const expiry = (await query<{ at: Date }>(
        'SELECT token_expires_at AS at FROM ai_policy_legacy_client_observations WHERE user_id = $1', [recent],
      )).rows[0]!.at.getTime();
      expect(new Date(legacy.clearsAt).getTime()).toBe(expiry + SLACK_SECONDS * 1_000);

      await setAiPolicyEnforcementEnabled(adminId, { enabled: true })
        .then(() => { throw new Error('enabled over unacknowledged legacy clients'); }, (err) => expectRefusal(err, ['legacy_clients_active']));
      expect(await auditRows()).toEqual([]);

      const enabled = await setAiPolicyEnforcementEnabled(adminId, { enabled: true, acknowledgeLegacyClients: true });
      expect(enabled).toMatchObject({ enabled: true, legacyClientsAcknowledged: true, ready: false });
      expect(enabled.blockers.map((blocker) => blocker.code)).toEqual(['legacy_clients_active']);
      expect((await stateRow()).legacy_clients_acknowledged).toBe(true);
      const audit = (await auditRows())[0]!;
      expect(audit.metadata).toMatchObject({ enabled: true, legacyClientsAcknowledged: true });
      expect(audit.metadata.blockers).toEqual([expect.objectContaining({
        code: 'legacy_clients_active', users: 2, clearsAt: legacy.clearsAt,
        recent: expect.arrayContaining([expect.objectContaining({ userId: recent })]),
      })]);

      // Disable resets the acknowledgement; re-enabling needs it again.
      const disabled = await setAiPolicyEnforcementEnabled(adminId, { enabled: false });
      expect(disabled).toMatchObject({ enabled: false, legacyClientsAcknowledged: false });
      expect((await stateRow()).legacy_clients_acknowledged).toBe(false);
      await setAiPolicyEnforcementEnabled(adminId, { enabled: true })
        .then(() => { throw new Error('acknowledgement carried over a disable'); }, (err) => expectRefusal(err, ['legacy_clients_active']));
      const again = await setAiPolicyEnforcementEnabled(adminId, { enabled: true, acknowledgeLegacyClients: true });
      expect(again).toMatchObject({ enabled: true, legacyClientsAcknowledged: true });
      expect((await auditRows()).map((row) => row.action)).toEqual([
        'AI_POLICY_ENFORCEMENT_ACTIVATED', 'AI_POLICY_ENFORCEMENT_DEACTIVATED', 'AI_POLICY_ENFORCEMENT_ACTIVATED',
      ]);
    });

    it('an acknowledgement with nothing to acknowledge is not recorded', async () => {
      const enabled = await setAiPolicyEnforcementEnabled(adminId, { enabled: true, acknowledgeLegacyClients: true });
      expect(enabled).toMatchObject({ enabled: true, ready: true, legacyClientsAcknowledged: false });
      expect((await auditRows())[0]!.metadata).toMatchObject({ legacyClientsAcknowledged: false });
    });

    it('legacy_client_window_open: open for one token lifetime + slack after the observer appears, closed after it, re-opened by a version-0 quiesced_at (not by a fence)', async () => {
      await query('UPDATE ai_policy_activation_state SET observing_since = NOW() WHERE singleton');
      const fresh = await getAiPolicyActivationState(adminId);
      expect(fresh.blockers.map((blocker) => blocker.code)).toEqual(['legacy_client_window_open']);
      const window = fresh.blockers[0]!;
      if (window.code !== 'legacy_client_window_open') throw new Error('unreachable');
      expect(window.overridable).toBe(true);
      const since = new Date(window.since).getTime();
      expect(Math.abs(since - Date.now())).toBeLessThan(10_000);
      expect(new Date(window.clearsAt).getTime() - since).toBe((LIFETIME_SECONDS + SLACK_SECONDS) * 1_000);

      await setAiPolicyEnforcementEnabled(adminId, { enabled: true })
        .then(() => { throw new Error('enabled inside the blind window'); }, (err) => expectRefusal(err, ['legacy_client_window_open']));

      await query(
        `UPDATE ai_policy_activation_state SET observing_since = NOW() - make_interval(secs => $1::double precision) WHERE singleton`,
        [LIFETIME_SECONDS + SLACK_SECONDS + 1],
      );
      expect((await getAiPolicyActivationState(adminId)).blockers).toEqual([]);

      // A fenced long-dead version-0 row does not restart the clock…
      await insertTestRuntime({ legacy: true, fenced: true });
      expect((await getAiPolicyActivationState(adminId)).blockers).toEqual([]);
      // …an owner-acknowledged drain of a live old process does.
      const quiesced = await insertTestRuntime({ legacy: true, quiesced: true });
      const reopened = await getAiPolicyActivationState(adminId);
      expect(reopened.blockers.map((blocker) => blocker.code)).toEqual(['legacy_client_window_open']);
      const quiescedAt = (await query<{ at: Date }>(
        'SELECT quiesced_at AS at FROM page_writer_runtimes WHERE runtime_id = $1', [quiesced],
      )).rows[0]!.at.toISOString();
      expect(reopened.blockers[0]).toMatchObject({ since: quiescedAt });

      const enabled = await setAiPolicyEnforcementEnabled(adminId, { enabled: true, acknowledgeLegacyClients: true });
      expect(enabled).toMatchObject({ enabled: true, legacyClientsAcknowledged: true });
    });

    it('a readiness read that throws reports ai_policy_readiness_unavailable, refuses enabling, and still lets a disable commit', async () => {
      await setAiPolicyEnforcementEnabled(adminId, { enabled: true });
      // Break the provider's second query mid-transaction: the window read
      // joins the activation row, so a missing observations table throws.
      await query('ALTER TABLE ai_policy_legacy_client_observations RENAME TO ai_policy_legacy_client_observations_hidden');
      try {
        const state = await getAiPolicyActivationState(adminId);
        expect(state.blockers).toEqual([{ code: 'ai_policy_readiness_unavailable', overridable: false }]);
        const disabled = await setAiPolicyEnforcementEnabled(adminId, { enabled: false });
        expect(disabled).toMatchObject({ enabled: false, ready: false });
        expect((await stateRow()).enabled).toBe(false);
        await setAiPolicyEnforcementEnabled(adminId, { enabled: true, acknowledgeLegacyClients: true })
          .then(() => { throw new Error('enabled on unreadable readiness'); }, (err) => expectRefusal(err, ['ai_policy_readiness_unavailable']));
      } finally {
        await query('ALTER TABLE ai_policy_legacy_client_observations_hidden RENAME TO ai_policy_legacy_client_observations');
      }
    });

    it('two concurrent enables on two clients: one audit row, the loser returns the winner\'s record', async () => {
      const second = await insertUser('admin');
      const [a, b] = await Promise.all([
        setAiPolicyEnforcementEnabled(adminId, { enabled: true }),
        setAiPolicyEnforcementEnabled(second, { enabled: true }),
      ]);
      expect(a).toEqual(b);
      expect(a.enabled).toBe(true);
      expect([adminId, second]).toContain(a.changedBy);
      const audits = await auditRows();
      expect(audits).toHaveLength(1);
      expect(audits[0]!.user_id).toBe(a.changedBy);
    });

    it('a held state-row lock answers 503 ai_policy_activation_busy after the 5 s lock_timeout and changes nothing', async () => {
      // Real wall-clock on purpose: `lock_timeout` is PostgreSQL's clock (N25
      // binds it to 5 s), so no fake timer can drive it.
      const holder = await getPool().connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM ai_policy_activation_state WHERE singleton FOR UPDATE');
        const started = Date.now();
        await setAiPolicyEnforcementEnabled(adminId, { enabled: true }).then(
          () => { throw new Error('enabled through a held lock'); },
          (err) => {
            expect(err).toBeInstanceOf(AiPolicyActivationError);
            expect(err).toMatchObject({ statusCode: 503, body: { error: 'ai_policy_activation_busy' } });
          },
        );
        expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
        expect(Date.now() - started).toBeLessThan(15_000);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      expect((await stateRow()).enabled).toBe(false);
      expect(await auditRows()).toEqual([]);
      expect(isAiPolicyEnforcementEnabledCached()).toBe(false);
    }, 20_000);

    it('only an active system administrator may read or change the switch (403, nothing written)', async () => {
      const user = await insertUser('user');
      const gone = randomUUID();
      for (const actor of [user, gone]) {
        await expect(getAiPolicyActivationState(actor)).rejects.toMatchObject({ statusCode: 403, body: { error: 'not_authorized' } });
        await expect(setAiPolicyEnforcementEnabled(actor, { enabled: true })).rejects.toMatchObject({ statusCode: 403 });
      }
      await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [adminId]);
      await expect(setAiPolicyEnforcementEnabled(adminId, { enabled: true })).rejects.toMatchObject({ statusCode: 403 });
      expect((await stateRow()).enabled).toBe(false);
      expect(await auditRows()).toEqual([]);
    });

    it('the users-row FOR SHARE serializes with a concurrent demotion: the activation that waits sees the committed demotion', async () => {
      const demoter = await getPool().connect();
      try {
        await demoter.query('BEGIN');
        await demoter.query(`UPDATE users SET role = 'user' WHERE id = $1`, [adminId]);
        const attempt = setAiPolicyEnforcementEnabled(adminId, { enabled: true });
        // The activation is parked on the users-row lock the demotion holds:
        // observe the server-side wait rather than guessing a duration.
        await vi.waitFor(async () => {
          const waiting = await query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
          );
          expect(waiting.rows[0]!.n).toBeGreaterThanOrEqual(1);
        });
        await demoter.query('COMMIT');
        await expect(attempt).rejects.toMatchObject({ statusCode: 403, body: { error: 'not_authorized' } });
      } finally {
        await demoter.query('ROLLBACK').catch(() => undefined);
        demoter.release();
      }
      expect((await stateRow()).enabled).toBe(false);
      expect(await auditRows()).toEqual([]);
    });
  });

  describe('propagation (ADR-024): the cache only changes by reading PostgreSQL', () => {
    afterEach(async () => { stopAiPolicyActivation(); await closeCacheBus(); });

    it('the test seam writes the real row and reads it back', async () => {
      await setAiPolicyEnforcementForTest(true);
      expect((await stateRow()).enabled).toBe(true);
      expect(isAiPolicyEnforcementEnabledCached()).toBe(true);
      await setAiPolicyEnforcementForTest(false);
      expect((await stateRow()).enabled).toBe(false);
      expect(isAiPolicyEnforcementEnabledCached()).toBe(false);
    });

    it('a bus signal re-reads the row and ignores its payload; a reconnect reloads too', async () => {
      const redis = createMockRedis();
      await initCacheBus(redis.main);
      await loadAiPolicyActivation();
      expect(isAiPolicyEnforcementEnabledCached()).toBe(false);

      await query('UPDATE ai_policy_activation_state SET enabled = TRUE WHERE singleton');
      redis.emit(AI_POLICY_ACTIVATION_CHANNEL, JSON.stringify({ enabled: false }));
      await vi.waitFor(() => expect(isAiPolicyEnforcementEnabledCached()).toBe(true));

      await query('UPDATE ai_policy_activation_state SET enabled = FALSE WHERE singleton');
      redis.emit(AI_POLICY_ACTIVATION_CHANNEL, JSON.stringify({ enabled: true }));
      await vi.waitFor(() => expect(isAiPolicyEnforcementEnabledCached()).toBe(false));

      await query('UPDATE ai_policy_activation_state SET enabled = TRUE WHERE singleton');
      redis.emitReady(); // the initial connect sentinel is not a reconnect
      redis.emitReady();
      await vi.waitFor(() => expect(isAiPolicyEnforcementEnabledCached()).toBe(true));
    });

    it('a failed first load starts disabled and keeps polling; the poll re-reads the row; a failed re-read keeps the previous value', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      await query('DELETE FROM ai_policy_activation_state');
      await loadAiPolicyActivation();
      expect(isAiPolicyEnforcementEnabledCached()).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'cold-load' }),
        expect.stringContaining('starting DISABLED'),
      );

      await query(`INSERT INTO ai_policy_activation_state (singleton, enabled, observing_since)
                   VALUES (TRUE, TRUE, NOW() - interval '2 days')`);
      vi.advanceTimersByTime(AI_POLICY_ACTIVATION_POLL_MS);
      await vi.waitFor(() => expect(isAiPolicyEnforcementEnabledCached()).toBe(true));

      await query('DELETE FROM ai_policy_activation_state');
      warn.mockClear();
      vi.advanceTimersByTime(AI_POLICY_ACTIVATION_POLL_MS);
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'poll' }),
        expect.stringContaining('keeping the previous value'),
      ));
      expect(isAiPolicyEnforcementEnabledCached()).toBe(true);

      await query(`INSERT INTO ai_policy_activation_state (singleton, enabled, observing_since)
                   VALUES (TRUE, FALSE, NOW() - interval '2 days')`);
      vi.advanceTimersByTime(AI_POLICY_ACTIVATION_POLL_MS);
      await vi.waitFor(() => expect(isAiPolicyEnforcementEnabledCached()).toBe(false));
    });
  });

  describe('retired COMPENDIQ_AI_POLICY_ENFORCEMENT flag', () => {
    afterEach(() => { vi.unstubAllEnvs(); });

    it('is reported as ignored, naming the switch that replaced it', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
      vi.stubEnv('COMPENDIQ_AI_POLICY_ENFORCEMENT', 'enabled');
      warnIfAiPolicyEnforcementEnvSet();
      expect(warn).toHaveBeenCalledTimes(1);
      const [context, message] = warn.mock.calls[0]! as [Record<string, unknown>, string];
      expect(context).toMatchObject({ envVar: 'COMPENDIQ_AI_POLICY_ENFORCEMENT' });
      expect(message).toContain('ignored');
      expect(message).toContain('PUT /api/admin/ai-policy/activation');
      expect(message).toContain('ai_policy_activation_state');
    });

    it('says nothing when unset or empty', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
      vi.stubEnv('COMPENDIQ_AI_POLICY_ENFORCEMENT', undefined);
      warnIfAiPolicyEnforcementEnvSet();
      vi.stubEnv('COMPENDIQ_AI_POLICY_ENFORCEMENT', '');
      warnIfAiPolicyEnforcementEnvSet();
      expect(warn).not.toHaveBeenCalled();
    });

    it('is wired into buildApp beside the cold load, after the cache bus and before any route', () => {
      const source = readFileSync(new URL('../../app.ts', import.meta.url), 'utf8');
      const notice = source.indexOf('warnIfAiPolicyEnforcementEnvSet();');
      const load = source.indexOf('await loadAiPolicyActivation();');
      const bus = source.indexOf('await initCacheBus(app.redis);');
      const firstRoute = source.indexOf('await app.register(healthRoutes');
      const guard = source.indexOf('registerLegacyClientGuard(app);');
      const enterpriseRoutes = source.indexOf('await enterprise.registerRoutes(app, license);');
      expect(notice).toBeGreaterThan(0);
      expect(load).toBeGreaterThan(bus);
      expect(load).toBeLessThan(firstRoute);
      expect(source).toContain('registerAiPolicyActivationReadiness();');
      expect(guard).toBeGreaterThan(0);
      expect(guard).toBeLessThan(enterpriseRoutes);
    });
  });
});
