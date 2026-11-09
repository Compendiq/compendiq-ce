/**
 * Article AI policy enforcement switch (#1881).
 *
 * One durable, cluster-wide row (`ai_policy_activation_state`, migration 151)
 * decides whether NEW restrictive policies may be chosen. Admission never
 * reads it: stored restrictions are enforced in both switch states, so this
 * module only opens or closes new tightening. The binary one-way door lives
 * in the migration's triggers, independent of this switch and of the cache.
 *
 * Reading: `isAiPolicyEnforcementEnabledCached()` is the synchronous view
 * every tightening gate consults. It is a process cache loaded from
 * PostgreSQL at startup (`loadAiPolicyActivation`, before routes and
 * workers); a failed first load starts the process DISABLED (fail closed). It
 * is re-read on the `ai_policy:activation:changed` bus channel (the payload is
 * a reload signal and is ignored), on bus reconnect, and by an unref'd 30 s
 * poll. The writing process reloads its own cache right after commit. No
 * production path sets the cache without reading PostgreSQL.
 *
 * Writing: `setAiPolicyEnforcementEnabled` runs one transaction with
 * `lock_timeout = '5s'` (a timeout answers 503 `ai_policy_activation_busy`):
 * the acting user's row `FOR SHARE` (active system administrator — a
 * concurrent demotion serialises with it), the state row `FOR UPDATE`, then
 * readiness on the same client. Already in the requested state → the existing
 * record, no audit, no rewrite. Enabling refuses with 409
 * `ai_policy_activation_refused` while a non-overridable blocker stands or a
 * legacy-client blocker is not acknowledged; the acknowledgement is stored by
 * the enabling transition only (and only when it actually overrode a
 * legacy-client blocker) and is reset by every disable. Disabling needs no
 * preconditions. State and audit event commit together.
 *
 * Design: `docs/architecture/article-ai-policy-activation.md`.
 */
import type { PoolClient } from 'pg';
import type {
  AiPolicyActivationBlocker,
  AiPolicyActivationRequest,
  AiPolicyActivationState,
} from '@compendiq/contracts';
import { getPool, query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { getAccessTokenLifetimeSeconds } from '../plugins/auth.js';
import type { AuditAction } from './audit-service.js';
import { onReconnect, publish, subscribe } from './redis-cache-bus.js';
import { AI_POLICY_ENFORCEMENT_VERSION } from './ai-policy-runtime-guard.js';

/**
 * The AI-policy enforcement protocol this build speaks (defined in the
 * dependency-free runtime guard module so `page-write-admission.ts` can
 * register it without importing this one). Migration 151's triggers refuse a
 * new active runtime on any other version while the switch is on or a
 * restriction exists.
 */
export { AI_POLICY_ENFORCEMENT_VERSION };

/** Cache-bus reload signal. Receivers ignore the payload and re-read the row. */
export const AI_POLICY_ACTIVATION_CHANNEL = 'ai_policy:activation:changed';

/** Unref'd poll so a pod that misses the bus signal is stale for at most this long. */
export const AI_POLICY_ACTIVATION_POLL_MS = 30_000;

/**
 * The legacy-client observer throttles its upsert to one write per user and
 * process per 30 s, so an observed token may be up to this much younger than
 * `last_seen_at` says. Both legacy blockers add it to their windows.
 */
const LEGACY_CLIENT_SLACK_SECONDS = 30;

const ACTIVATION_LOCK_TIMEOUT = '5s';
const LOCK_NOT_AVAILABLE = '55P03';
const MAX_RUNTIME_DETAILS = 50;
const MAX_LEGACY_CLIENT_DETAILS = 20;

export type AiPolicyActivationErrorBody =
  | { error: 'not_authorized'; message: string }
  | { error: 'ai_policy_activation_refused'; message: string; blockers: AiPolicyActivationBlocker[] }
  | { error: 'ai_policy_activation_busy'; message: string }
  | { error: 'ai_policy_activation_unavailable'; message: string };

/** Serialized verbatim by the activation route; nothing else maps it. */
export class AiPolicyActivationError extends Error {
  readonly statusCode: 403 | 409 | 503;
  readonly body: AiPolicyActivationErrorBody;

  constructor(statusCode: 403 | 409 | 503, body: AiPolicyActivationErrorBody) {
    super(body.message);
    this.name = 'AiPolicyActivationError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

interface ActivationRow {
  enabled: boolean;
  changed_at: Date | null;
  changed_by_user_id: string | null;
  changed_by_name: string | null;
  legacy_clients_acknowledged: boolean;
}

interface ActorRow {
  id: string;
  username: string;
  display_name: string | null;
}

// ── Process cache ───────────────────────────────────────────────────────────

let enabledCache = false;
let pollTimer: NodeJS.Timeout | null = null;
let unsubscribeBus: (() => void) | null = null;
let unsubscribeReconnect: (() => void) | null = null;

type ReloadPhase = 'cold-load' | 'bus' | 'reconnect' | 'poll' | 'writer' | 'test-seam';

async function readEnabledFromDb(): Promise<boolean> {
  const result = await query<{ enabled: boolean }>(
    'SELECT enabled FROM ai_policy_activation_state WHERE singleton',
  );
  const row = result.rows[0];
  if (!row) throw new Error('ai_policy_activation_state singleton row is missing');
  return row.enabled;
}

/**
 * Re-read the switch from PostgreSQL. A failed cold load leaves the process
 * disabled (fail closed); a failed re-read keeps the previous value — the
 * poll retries, and a stale value weakens no safety property (admission and
 * the tightening trigger never consult this cache).
 */
async function reloadFromDb(phase: ReloadPhase): Promise<boolean> {
  try {
    enabledCache = await readEnabledFromDb();
  } catch (err) {
    logger.warn(
      { err, phase },
      phase === 'cold-load'
        ? 'ai-policy-activation: cold-load failed — starting DISABLED (fail closed) and polling'
        : 'ai-policy-activation: re-read failed — keeping the previous value',
    );
  }
  return enabledCache;
}

/** Synchronous view of the switch; `isAiPolicyEnforcementAvailable()` delegates here. */
export function isAiPolicyEnforcementEnabledCached(): boolean {
  return enabledCache;
}

/**
 * Cold-load the switch and wire its propagation. Call once at startup AFTER
 * `initCacheBus` and BEFORE routes and workers. Idempotent: a second call
 * replaces the previous subscriptions and timer (test apps rebuild often).
 */
export async function loadAiPolicyActivation(): Promise<void> {
  await reloadFromDb('cold-load');
  stopAiPolicyActivation();
  unsubscribeBus = subscribe(AI_POLICY_ACTIVATION_CHANNEL, () => {
    void reloadFromDb('bus');
  });
  unsubscribeReconnect = onReconnect(() => {
    void reloadFromDb('reconnect');
  });
  pollTimer = setInterval(() => {
    void reloadFromDb('poll');
  }, AI_POLICY_ACTIVATION_POLL_MS);
  pollTimer.unref();
}

/** Stop the poll and bus subscriptions (app `onClose`). The cached value is kept. */
export function stopAiPolicyActivation(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  unsubscribeBus?.();
  unsubscribeBus = null;
  unsubscribeReconnect?.();
  unsubscribeReconnect = null;
}

/**
 * Startup notice for the retired EE `COMPENDIQ_AI_POLICY_ENFORCEMENT` flag
 * (`FTS_LANGUAGE` precedent). WARN, not INFO: a set value is a deliberate
 * attempt to enable enforcement that now does nothing — the switch alone
 * decides, and an env-flag deployment comes up disabled until an
 * administrator enables it.
 */
export function warnIfAiPolicyEnforcementEnvSet(): void {
  if (!process.env.COMPENDIQ_AI_POLICY_ENFORCEMENT) return;
  logger.warn(
    { envVar: 'COMPENDIQ_AI_POLICY_ENFORCEMENT', route: 'PUT /api/admin/ai-policy/activation' },
    'COMPENDIQ_AI_POLICY_ENFORCEMENT is set but ignored — article AI policy enforcement is a durable switch '
      + '(ai_policy_activation_state) that an administrator turns on in Settings → Article AI policy '
      + 'or through PUT /api/admin/ai-policy/activation. Stored restrictions stay enforced either way.',
  );
}

// ── Readiness ───────────────────────────────────────────────────────────────

export type AiPolicyReadinessProvider = (client: PoolClient) => Promise<AiPolicyActivationBlocker[]>;

let readinessProvider: AiPolicyReadinessProvider | null = null;

/**
 * Install at startup beside `registerPageBaselineEnforcementReadiness`, before
 * routes. Until then every readiness read reports
 * `ai_policy_enforcement_not_registered` and enabling is refused.
 */
export function registerAiPolicyActivationReadiness(): void {
  readinessProvider = readActivationBlockers;
}

/** Observable preconditions (design §2.3), evaluated on the caller's client. */
async function readActivationBlockers(client: PoolClient): Promise<AiPolicyActivationBlocker[]> {
  const blockers: AiPolicyActivationBlocker[] = [];

  const runtimes = await client.query<{
    total: string; runtime_id: string; host: string | null; pid: number | null; started_at: Date;
  }>(
    `SELECT count(*) OVER () AS total,
            runtime_id,
            deployment_identity->>'host' AS host,
            CASE WHEN deployment_identity->>'pid' ~ '^[0-9]{1,10}$'
                  AND (deployment_identity->>'pid')::bigint <= 2147483647
                 THEN (deployment_identity->>'pid')::int END AS pid,
            started_at
       FROM page_writer_runtimes
      WHERE fenced_at IS NULL AND quiesced_at IS NULL
        AND ai_policy_enforcement_version <> $1
      ORDER BY started_at DESC, runtime_id
      LIMIT $2`,
    [AI_POLICY_ENFORCEMENT_VERSION, MAX_RUNTIME_DETAILS],
  );
  if (runtimes.rows.length > 0) {
    blockers.push({
      code: 'incompatible_ai_policy_runtime',
      overridable: false,
      total: Number(runtimes.rows[0]!.total),
      runtimes: runtimes.rows.map((row) => ({
        runtimeId: row.runtime_id,
        host: row.host,
        pid: row.pid,
        startedAt: row.started_at.toISOString(),
      })),
    });
  }

  const legacy = await client.query<{
    users: string; clears_at: Date; user_id: string; username: string; last_seen_at: Date;
  }>(
    `SELECT count(*) OVER () AS users,
            max(o.token_expires_at) OVER () + make_interval(secs => $1::double precision) AS clears_at,
            o.user_id, u.username, o.last_seen_at
       FROM ai_policy_legacy_client_observations o
       JOIN users u ON u.id = o.user_id
      WHERE o.token_expires_at + make_interval(secs => $1::double precision) > NOW()
      ORDER BY o.last_seen_at DESC, o.user_id
      LIMIT $2`,
    [LEGACY_CLIENT_SLACK_SECONDS, MAX_LEGACY_CLIENT_DETAILS],
  );
  if (legacy.rows.length > 0) {
    blockers.push({
      code: 'legacy_clients_active',
      overridable: true,
      users: Number(legacy.rows[0]!.users),
      recent: legacy.rows.map((row) => ({
        userId: row.user_id,
        username: row.username,
        lastSeenAt: row.last_seen_at.toISOString(),
      })),
      clearsAt: legacy.rows[0]!.clears_at.toISOString(),
    });
  }

  // The observer is blind to tokens issued before it existed (observing_since
  // = migration 151) or by an old replica up to its owner-acknowledged drain
  // (quiesced_at of a version-0 runtime; fencing a long-dead row does not
  // restart the clock). Compared on the database clock, like token_expires_at.
  const window = await client.query<{ since: Date; clears_at: Date; open: boolean }>(
    `SELECT w.since,
            w.since + make_interval(secs => $2::double precision) AS clears_at,
            NOW() < w.since + make_interval(secs => $2::double precision) AS open
       FROM (SELECT GREATEST(
                      s.observing_since,
                      (SELECT max(r.quiesced_at) FROM page_writer_runtimes r
                        WHERE r.ai_policy_enforcement_version <> $1)
                    ) AS since
               FROM ai_policy_activation_state s
              WHERE s.singleton) w`,
    [AI_POLICY_ENFORCEMENT_VERSION, getAccessTokenLifetimeSeconds() + LEGACY_CLIENT_SLACK_SECONDS],
  );
  const open = window.rows[0];
  if (open?.open) {
    blockers.push({
      code: 'legacy_client_window_open',
      overridable: true,
      since: open.since.toISOString(),
      clearsAt: open.clears_at.toISOString(),
    });
  }

  return blockers;
}

/**
 * Readiness as the GET reports it and as enabling decides on it. Outside a
 * transaction a failed read is simply reported; inside one the caller wraps
 * the read in a savepoint so a disable is never lost to an aborted
 * transaction (see `evaluateReadinessInTransaction`).
 */
async function evaluateReadiness(client: PoolClient): Promise<AiPolicyActivationBlocker[]> {
  if (!readinessProvider) return [{ code: 'ai_policy_enforcement_not_registered', overridable: false }];
  try {
    return await readinessProvider(client);
  } catch (err) {
    logger.warn({ err }, 'ai-policy-activation: readiness read failed');
    return [{ code: 'ai_policy_readiness_unavailable', overridable: false }];
  }
}

async function evaluateReadinessInTransaction(client: PoolClient): Promise<AiPolicyActivationBlocker[]> {
  if (!readinessProvider) return [{ code: 'ai_policy_enforcement_not_registered', overridable: false }];
  await client.query('SAVEPOINT ai_policy_readiness');
  try {
    const blockers = await readinessProvider(client);
    await client.query('RELEASE SAVEPOINT ai_policy_readiness');
    return blockers;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT ai_policy_readiness');
    logger.warn({ err }, 'ai-policy-activation: readiness read failed');
    return [{ code: 'ai_policy_readiness_unavailable', overridable: false }];
  }
}

// ── State ───────────────────────────────────────────────────────────────────

async function activationRow(client: PoolClient, lock?: 'exclusive'): Promise<ActivationRow> {
  const result = await client.query<ActivationRow>(
    `SELECT enabled, changed_at, changed_by_user_id, changed_by_name, legacy_clients_acknowledged
       FROM ai_policy_activation_state
      WHERE singleton
      ${lock === 'exclusive' ? 'FOR UPDATE' : ''}`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new AiPolicyActivationError(503, {
      error: 'ai_policy_activation_unavailable',
      message: 'AI policy activation state is unavailable',
    });
  }
  return row;
}

/**
 * The acting user must be an active system administrator NOW, on this
 * transaction. `FOR SHARE` makes a concurrent demotion or deactivation (an
 * UPDATE of the same row) wait for this transaction, or this one for it.
 */
async function assertActiveAdmin(client: PoolClient, actorId: string, lock: boolean): Promise<ActorRow> {
  const result = await client.query<ActorRow>(
    `SELECT id, username, display_name
       FROM users
      WHERE id = $1 AND deactivated_at IS NULL AND role = 'admin'
      ${lock ? 'FOR SHARE' : ''}`,
    [actorId],
  );
  const actor = result.rows[0];
  if (!actor) {
    throw new AiPolicyActivationError(403, {
      error: 'not_authorized',
      message: 'System-admin authority is required',
    });
  }
  return actor;
}

function toState(row: ActivationRow, blockers: AiPolicyActivationBlocker[]): AiPolicyActivationState {
  return {
    enabled: row.enabled,
    changedAt: row.changed_at?.toISOString() ?? null,
    changedBy: row.changed_by_user_id,
    changedByName: row.changed_by_name,
    legacyClientsAcknowledged: row.legacy_clients_acknowledged,
    ready: blockers.length === 0,
    blockers,
  };
}

async function appendTransitionAudit(
  client: PoolClient,
  actorId: string,
  action: Extract<AuditAction, 'AI_POLICY_ENFORCEMENT_ACTIVATED' | 'AI_POLICY_ENFORCEMENT_DEACTIVATED'>,
  metadata: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, 'system', NULL, $3::jsonb)`,
    [actorId, action, JSON.stringify(metadata)],
  );
}

/** Admin read of the record and its current readiness. */
export async function getAiPolicyActivationState(actorId: string): Promise<AiPolicyActivationState> {
  const client = await getPool().connect();
  try {
    await assertActiveAdmin(client, actorId, false);
    const row = await activationRow(client);
    return toState(row, await evaluateReadiness(client));
  } finally {
    client.release();
  }
}

/**
 * Turn the switch on or off (design §2.4). Resolves with the committed record;
 * rejects with `AiPolicyActivationError` (403 not an active admin, 409 refused
 * with the observed blockers, 503 busy on a lock timeout).
 */
export async function setAiPolicyEnforcementEnabled(
  actorId: string,
  input: AiPolicyActivationRequest,
): Promise<AiPolicyActivationState> {
  const client = await getPool().connect();
  let row: ActivationRow;
  let blockers: AiPolicyActivationBlocker[];
  let changed = false;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${ACTIVATION_LOCK_TIMEOUT}'`);
    const actor = await assertActiveAdmin(client, actorId, true);
    const current = await activationRow(client, 'exclusive');
    // Read once, under the row lock and before any write: enabling decides
    // on it, and a disable must never be lost to an aborted transaction.
    blockers = await evaluateReadinessInTransaction(client);

    if (current.enabled === input.enabled) {
      // Already there (or a concurrent transition won): the existing record,
      // no second audit row, no rewrite.
      row = current;
    } else if (input.enabled) {
      const acknowledged = input.acknowledgeLegacyClients === true;
      const unmet = blockers.filter((blocker) => !(blocker.overridable && acknowledged));
      if (unmet.length > 0) {
        throw new AiPolicyActivationError(409, {
          error: 'ai_policy_activation_refused',
          message: 'Article AI policy enforcement cannot be enabled while its preconditions are unmet',
          blockers,
        });
      }
      // Recorded only when it overrode something: an acknowledgement with
      // nothing to acknowledge is not a residual the administrator accepted.
      const legacyClientsAcknowledged = acknowledged && blockers.some((blocker) => blocker.overridable);
      row = await writeTransition(client, true, actor, legacyClientsAcknowledged);
      await appendTransitionAudit(client, actorId, 'AI_POLICY_ENFORCEMENT_ACTIVATED', {
        enabled: true,
        blockers,
        legacyClientsAcknowledged,
      });
      changed = true;
    } else {
      row = await writeTransition(client, false, actor, false);
      await appendTransitionAudit(client, actorId, 'AI_POLICY_ENFORCEMENT_DEACTIVATED', {
        enabled: false,
        blockers,
        legacyClientsAcknowledged: false,
      });
      changed = true;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === LOCK_NOT_AVAILABLE) {
      throw new AiPolicyActivationError(503, {
        error: 'ai_policy_activation_busy',
        message: 'Another activation change or runtime registration is in progress; retry shortly',
      });
    }
    throw err;
  } finally {
    client.release();
  }

  if (changed) {
    // The writer sees its own commit immediately; peers get a reload signal
    // (payload ignored) and otherwise catch up on reconnect or the poll. A
    // failed publish is logged by the bus; the committed state still stands.
    await reloadFromDb('writer');
    await publish(AI_POLICY_ACTIVATION_CHANNEL, { changedAt: row.changed_at?.toISOString() ?? null });
  }
  return toState(row, blockers);
}

async function writeTransition(
  client: PoolClient,
  enabled: boolean,
  actor: ActorRow,
  legacyClientsAcknowledged: boolean,
): Promise<ActivationRow> {
  const result = await client.query<ActivationRow>(
    `UPDATE ai_policy_activation_state
        SET enabled = $1,
            changed_at = NOW(),
            changed_by_user_id = $2::uuid,
            changed_by_name = $3,
            legacy_clients_acknowledged = $4
      WHERE singleton
      RETURNING enabled, changed_at, changed_by_user_id, changed_by_name, legacy_clients_acknowledged`,
    [enabled, actor.id, actor.display_name?.trim() || actor.username, legacyClientsAcknowledged],
  );
  return result.rows[0]!;
}

// ── Test seams ──────────────────────────────────────────────────────────────

/**
 * Tests that need an open switch write the REAL row and reload the cache the
 * way production does — never a plugin spy or a bare cache assignment.
 */
export async function setAiPolicyEnforcementForTest(enabled: boolean): Promise<void> {
  await query(
    `UPDATE ai_policy_activation_state
        SET enabled = $1,
            legacy_clients_acknowledged = CASE WHEN $1 THEN legacy_clients_acknowledged ELSE FALSE END
      WHERE singleton`,
    [enabled],
  );
  await reloadFromDb('test-seam');
}

export function _resetAiPolicyActivationForTests(): void {
  stopAiPolicyActivation();
  enabledCache = false;
  readinessProvider = null;
}
