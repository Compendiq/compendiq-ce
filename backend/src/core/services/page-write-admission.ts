import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { PAGE_LIFECYCLE_LOCK_KEY } from '../db/advisory-locks.js';
import { getPool } from '../db/postgres.js';
import { flushPageWriteInvalidations } from './page-write-invalidation.js';
import {
  capturePageWriterDeploymentIdentity,
  verifyLocalPageWriterTermination,
} from './page-writer-process-identity.js';

const MAX_PAGE_ID = 2_147_483_647;
const MAX_EFFECT_BYTES = 32 * 1024;
const RECOVERY_HISTORY_MAX_ATTEMPTS = 32;
const RECOVERY_HISTORY_MAX_BYTES = 64 * 1024;
const KIND_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,99}$/;
type IntentEffectClass = 'local' | 'remote';
export type IntentRecoveryMode = 'local_verified' | 'remote_conditional' | 'remote_terminal_only';

type IntentPolicy = {
  effectClass: IntentEffectClass;
  recoveryMode: IntentRecoveryMode;
};

/**
 * Security boundary: an intent kind fixes whether it mutates local or remote
 * state and which recovery claim is possible. Callers cannot relabel an
 * unversioned provider mutation as local or conditionally replayable.
 */
const INTENT_POLICIES = {
  'attachment.local.put': { effectClass: 'local', recoveryMode: 'local_verified' },
  'baseline.prepare': { effectClass: 'local', recoveryMode: 'local_verified' },
  'icon.image.delete': { effectClass: 'local', recoveryMode: 'local_verified' },
  'icon.image.put': { effectClass: 'local', recoveryMode: 'local_verified' },
  'icon.metadata.patch': { effectClass: 'local', recoveryMode: 'local_verified' },
  'import.notion.overwrite': { effectClass: 'local', recoveryMode: 'local_verified' },
  'import.notion.placeholder.delete': { effectClass: 'local', recoveryMode: 'local_verified' },
  'import.notion.publish': { effectClass: 'local', recoveryMode: 'local_verified' },
  'import.notion.reparent': { effectClass: 'local', recoveryMode: 'local_verified' },
  'pages.bulk.delete.local': { effectClass: 'local', recoveryMode: 'local_verified' },
  'pages.delete.local': { effectClass: 'local', recoveryMode: 'local_verified' },
  'pages.delete.standalone': { effectClass: 'local', recoveryMode: 'local_verified' },
  'pages.image.upload': { effectClass: 'local', recoveryMode: 'local_verified' },
  'pages.image.import.store': { effectClass: 'local', recoveryMode: 'local_verified' },
  'attachment.confluence.put': { effectClass: 'remote', recoveryMode: 'remote_terminal_only' },
  'page.labels': { effectClass: 'remote', recoveryMode: 'remote_terminal_only' },
  'page.relocate': { effectClass: 'remote', recoveryMode: 'remote_terminal_only' },
  'pages.bulk.delete.remote': { effectClass: 'remote', recoveryMode: 'remote_terminal_only' },
  'pages.bulk.replace_tags': { effectClass: 'remote', recoveryMode: 'remote_terminal_only' },
  'pages.bulk.tags': { effectClass: 'remote', recoveryMode: 'remote_terminal_only' },
  'pages.create.labels': { effectClass: 'remote', recoveryMode: 'remote_terminal_only' },
  'pages.delete.confluence': { effectClass: 'remote', recoveryMode: 'remote_terminal_only' },
  'pages.draft.publish.confluence': { effectClass: 'remote', recoveryMode: 'remote_terminal_only' },
  'pages.update.confluence': { effectClass: 'remote', recoveryMode: 'remote_terminal_only' },
  'page.ai_apply': { effectClass: 'remote', recoveryMode: 'remote_conditional' },
  'page.version_restore': { effectClass: 'remote', recoveryMode: 'remote_conditional' },
} as const satisfies Record<string, IntentPolicy>;

export type IntentKind = keyof typeof INTENT_POLICIES;

function policyForIntent(kind: string, effect: Record<string, unknown>): IntentPolicy {
  if (!KIND_PATTERN.test(kind)) {
    throw new PageWriteError(400, 'invalid_intent_kind', 'Intent kind must be a stable namespaced identifier');
  }
  const policy = INTENT_POLICIES[kind as IntentKind] as IntentPolicy | undefined;
  if (!policy) {
    throw new PageWriteError(
      400,
      'unclassified_intent_kind',
      'The write intent kind has no closed effect and recovery policy',
    );
  }
  if (effect.effectClass !== policy.effectClass) {
    throw new PageWriteError(
      400,
      'intent_effect_class_mismatch',
      `Intent kind ${kind} requires effectClass ${policy.effectClass}`,
    );
  }
  if (policy.recoveryMode === 'remote_conditional') {
    const parsedExpectedVersion = parseNonnegativeVersion(effect.expectedRemoteVersion);
    const digest = effect.intendedStateDigest;
    if (
      typeof effect.pageId !== 'number' ||
      !Number.isSafeInteger(effect.pageId) ||
      effect.pageId <= 0 ||
      typeof effect.confluenceId !== 'string' ||
      effect.confluenceId.length === 0 ||
      parsedExpectedVersion === null ||
      parsedExpectedVersion <= 0n ||
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest)
    ) {
      throw new PageWriteError(
        400,
        'invalid_conditional_effect',
        'Conditional remote intent metadata must durably identify the page, expected version, and intended digest',
      );
    }
  }
  return policy;
}


export class PageWriteError extends Error {
  readonly statusCode: number;
  readonly reason: string;

  constructor(statusCode: number, reason: string, message: string) {
    super(message);
    this.name = 'PageWriteError';
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

export type PageRevision = {
  contentRevision: string;
  lifecycleRevision: string;
};

export type PageWriteIntent = {
  id: string;
  runtimeId: string;
  pageIds: number[];
  revisions: Record<number, PageRevision>;
};

export type PageRuntimeAdmission = {
  id: string;
  runtimeId: string;
  pageId: number;
  lifecycleRevision: string;
};

export type RuntimeQuiescenceAcknowledgment = {
  runtimeId: string;
  acknowledgmentId: string;
  deploymentIdentity: {
    host: string;
    pid: number;
    startedAt: string;
  };
};

export type PageWriteRecoveryAuthorization = {
  actorId: string;
  reason: string;
  ipAddress?: string;
  userAgent?: string;
};

export type PageWriteReconciliationProof =
  | {
      kind: 'local_bytes_verified';
      observedAt: string;
      reference: string;
      details: {
        syscallSettled: true;
        intendedStateDigest: string;
        observedStateDigest: string;
        intendedSize: number;
        observedSize: number;
      };
    }
  | {
      kind: 'local_effect_absence_verified';
      observedAt: string;
      reference: string;
      details: {
        syscallSettled: true;
        observedAbsent: true;
      };
    }
  | {
      kind: 'local_intended_absence_verified';
      observedAt: string;
      reference: string;
      details: {
        syscallSettled: true;
        observedAbsent: true;
        intendedIdentity: string;
      };
    }
  | {
      kind: 'remote_conditional_effect_converged';
      observedAt: string;
      reference: string;
      details: {
        recoveryAttempted: true;
        conditionalExpectedVersion: string;
        observedRemoteVersion: string;
        providerResult: 'applied' | 'historical_version_observed';
        intendedStateDigest: string;
        observedStateDigest: string;
      };
    }
  | {
      kind: 'remote_effect_not_started';
      observedAt: string;
      reference: string;
      details: {
        syscallSettled: true;
        remoteEffectStarted: false;
        observedAbsent: true;
      };
    }
  | {
      kind: 'remote_terminal_effect_verified';
      observedAt: string;
      reference: string;
      details: {
        remoteEffectsCompleted: true;
        terminalEvidence: string;
      };
    };

export type PageWriteRecoveryIntent = PageWriteIntent & {
  kind: string;
  actorId: string | null;
  effect: Record<string, unknown>;
  createdAt: string;
  recoveryMode: IntentRecoveryMode;
  deletedPageIds: number[];
  effectStartedAt: string | null;
  effectFinishedAt: string | null;
  remoteEffectStartedAt: string | null;
  remoteEffectsCompletedAt: string | null;
  recoveryStartedAt: string | null;
  remoteTerminalResult: Record<string, unknown> | null;
  cacheInvalidationPending: boolean;
  recoveryHistory: Record<string, unknown>[];
};

export type PageWriteIntentReconciler = (
  client: PoolClient,
  intent: PageWriteRecoveryIntent,
) => Promise<
  | {
      outcome: 'applied' | 'not_applied';
      proof: PageWriteReconciliationProof;
      result: unknown;
    }
  | {
      outcome: 'repair_required';
      observedState: 'staged_only' | 'partially_applied';
    }
>;

export type PageWriteIntentRepairer = (intent: PageWriteRecoveryIntent) => Promise<void>;

const intentReconcilers = new Map<IntentKind, PageWriteIntentReconciler>();
const intentRepairers = new Map<IntentKind, PageWriteIntentRepairer>();

/**
 * Register trusted server code for one closed intent kind. HTTP handlers must
 * never translate request bodies into proof objects or verifier callbacks.
 */
export function registerPageWriteIntentReconciler(
  kind: IntentKind,
  reconciler: PageWriteIntentReconciler,
  repairer?: PageWriteIntentRepairer,
): void {
  const policy = INTENT_POLICIES[kind];
  if (repairer && policy.recoveryMode !== 'local_verified') {
    throw new PageWriteError(400, 'intent_repair_not_local', 'Only local verified intents may register a repairer');
  }
  if (intentReconcilers.has(kind)) {
    throw new PageWriteError(409, 'reconciler_already_registered', `A reconciler is already registered for ${kind}`);
  }
  intentReconcilers.set(kind, reconciler);
  if (repairer) intentRepairers.set(kind, repairer);
}

export type PageWriteRecoveryState = {
  intents: PageWriteRecoveryIntent[];
  admissions: Array<{
    id: string;
    runtimeId: string;
    pageId: number;
    actorId: string | null;
    lifecycleRevision: string;
    admittedAt: string;
  }>;
  runtimes: Array<{
    runtimeId: string;
    deploymentIdentity: Record<string, unknown>;
    startedAt: string;
    quiescedAt: string | null;
    acknowledgmentId: string | null;
    fencedAt: string | null;
    fenceReason: string | null;
  }>;
  truncated: {
    intents: boolean;
    admissions: boolean;
    runtimes: boolean;
  };
};

type PageStateRow = {
  id: number;
  content_revision: string;
  lifecycle_revision: string;
  baseline_id: string | null;
};

type IntentRow = {
  id: string;
  runtime_id: string;
  kind: string;
  actor_id: string | null;
  page_ids: number[];
  revisions: Record<string, PageRevision>;
  deleted_page_ids: number[];
  recovery_mode: IntentRecoveryMode;
  effect: Record<string, unknown>;
  effect_started_at: Date | null;
  effect_finished_at: Date | null;
  remote_effect_started_at: Date | null;
  remote_effects_completed_at: Date | null;
  remote_terminal_result: Record<string, unknown> | null;
  recovery_started_at: Date | null;
  cache_invalidation_pending: boolean;
  recovery_history: Record<string, unknown>[];
  status: string;
  created_at: Date;
};

type AdmissionRow = {
  id: string;
  runtime_id: string;
  page_id: number;
  actor_id: string | null;
  lifecycle_revision: string;
  admitted_at: Date;
  released_at: Date | null;
};

const processRuntimeId = randomUUID();
const processDeploymentIdentity = capturePageWriterDeploymentIdentity();
let processRuntimeRegistration: Promise<string> | undefined;
function publicDeploymentIdentity(identity: unknown): { host?: string; pid?: number; startedAt?: string } {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return {};
  const value = identity as Record<string, unknown>;
  return {
    ...(typeof value.host === 'string' ? { host: value.host } : {}),
    ...(typeof value.pid === 'number' ? { pid: value.pid } : {}),
    ...(typeof value.startedAt === 'string' ? { startedAt: value.startedAt } : {}),
  };
}
let processAcceptingEffects = true;
let localOperationCount = 0;
const localIntentEffects = new Map<
  string,
  'reserved' | 'reserved_uncommitted' | 'running' | 'succeeded' | 'failed'
>();
const localIntentRecoveryModes = new Map<string, IntentRecoveryMode>();
const localIntentFailedRemotePhases = new Set<string>();
const localAdmissions = new Set<string>();
const localRecoveries = new Map<string, 'running' | 'failed'>();
const localRecoveryAdmins = new Map<string, string>();
const localDrainWaiters = new Set<() => void>();

// Successful phases are continuations, not terminal work: only settlement
// releases their ownership. Failed effects may drain because their durable
// pending intent remains the recovery fence; no-start reservations are
// cancelled atomically with the runtime acknowledgment below.
function localRuntimeDrained(): boolean {
  if (localOperationCount !== 0 || localAdmissions.size !== 0) return false;
  for (const state of localIntentEffects.values()) {
    if (state === 'running' || state === 'succeeded') return false;
  }
  return true;
}

function notifyLocalDrainWaiters(): void {
  if (!localRuntimeDrained()) return;
  for (const resolve of localDrainWaiters) resolve();
  localDrainWaiters.clear();
}

function beginLocalOperation(allowWhileQuiescing: boolean): void {
  if (!allowWhileQuiescing && !processAcceptingEffects) {
    throw new PageWriteError(
      409,
      'runtime_quiescing',
      'This runtime has closed its admission and external-effect gate',
    );
  }
  localOperationCount += 1;
}

function finishLocalOperation(): void {
  localOperationCount -= 1;
  notifyLocalDrainWaiters();
}

async function waitForLocalRuntimeDrain(): Promise<void> {
  while (!localRuntimeDrained()) {
    await new Promise<void>((resolve) => localDrainWaiters.add(resolve));
  }
}
function normalizePageIds(pageIds: readonly number[], allowEmpty = false): number[] {
  if (!allowEmpty && pageIds.length === 0) {
    throw new PageWriteError(400, 'invalid_page_ids', 'At least one page id is required');
  }
  const normalized = [...new Set(pageIds)];
  for (const pageId of normalized) {
    if (!Number.isInteger(pageId) || pageId <= 0 || pageId > MAX_PAGE_ID) {
      throw new PageWriteError(400, 'invalid_page_ids', 'Page ids must be positive 32-bit integers');
    }
  }
  return normalized.sort((a, b) => a - b);
}

function samePageIds(left: readonly number[], right: readonly number[]): boolean {
  const a = normalizePageIds(left);
  const b = normalizePageIds(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function parseNonnegativeVersion(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}


function cloneBoundedObject(value: Record<string, unknown>, field: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new PageWriteError(400, `invalid_${field}`, `${field} must be a JSON object`);
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new PageWriteError(400, `invalid_${field}`, `${field} must be JSON serializable`);
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_EFFECT_BYTES) {
    throw new PageWriteError(400, `invalid_${field}`, `${field} exceeds the durable metadata limit`);
  }
  const parsed: unknown = JSON.parse(encoded);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new PageWriteError(400, `invalid_${field}`, `${field} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function revisionsForRows(rows: readonly PageStateRow[]): Record<number, PageRevision> {
  return Object.fromEntries(
    rows.map((row) => [
      row.id,
      {
        contentRevision: String(row.content_revision),
        lifecycleRevision: String(row.lifecycle_revision),
      },
    ]),
  );
}

function intentFromRow(row: IntentRow): PageWriteIntent {
  const revisions = Object.fromEntries(
    Object.entries(row.revisions).map(([pageId, revision]) => [Number(pageId), revision]),
  );
  return {
    id: row.id,
    runtimeId: row.runtime_id,
    pageIds: [...row.page_ids].sort((a, b) => a - b),
    revisions,
  };
}

function recoveryIntentFromRow(row: IntentRow): PageWriteRecoveryIntent {
  return {
    ...intentFromRow(row),
    kind: row.kind,
    actorId: row.actor_id,
    recoveryMode: row.recovery_mode,
    effect: row.effect,
    deletedPageIds: [...row.deleted_page_ids].sort((a, b) => a - b),
    effectStartedAt: row.effect_started_at ? asIso(row.effect_started_at) : null,
    effectFinishedAt: row.effect_finished_at ? asIso(row.effect_finished_at) : null,
    remoteEffectStartedAt: row.remote_effect_started_at ? asIso(row.remote_effect_started_at) : null,
    remoteEffectsCompletedAt: row.remote_effects_completed_at
      ? asIso(row.remote_effects_completed_at)
      : null,
    recoveryStartedAt: row.recovery_started_at ? asIso(row.recovery_started_at) : null,
    remoteTerminalResult: row.remote_terminal_result,
    cacheInvalidationPending: row.cache_invalidation_pending,
    recoveryHistory: row.recovery_history,
    createdAt: row.created_at.toISOString(),
  };
}

async function inTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  let discard: Error | undefined;
  let began = false;
  // pg rejects the active query AND emits an error on a checked-out client.
  // Preserve that failure for the caller and discard its unusable connection.
  const recordConnectionError = (error: Error) => { discard = error; };
  client.on('error', recordConnectionError);
  try {
    await client.query('BEGIN');
    began = true;
    const result = await operation(client);
    if (discard) throw discard;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (began && !discard) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
    }
    throw error;
  } finally {
    client.release(discard);
    client.off('error', recordConnectionError);
  }
}

async function assertActiveRecoveryAdmin(client: PoolClient, actorId: string): Promise<void> {
  const actor = await client.query(
    `SELECT 1
       FROM users
      WHERE id = $1
        AND role = 'admin'
        AND deactivated_at IS NULL
      FOR SHARE`,
    [actorId],
  );
  if (actor.rowCount !== 1) {
    throw new PageWriteError(
      403,
      'recovery_admin_required',
      'An active system administrator is required.',
    );
  }
}

async function assertRecoveryAdminForIntent(
  client: PoolClient,
  intent: PageWriteIntent,
): Promise<void> {
  const recoveryAdminId = localRecoveryAdmins.get(intent.id);
  if (recoveryAdminId !== undefined) {
    await assertActiveRecoveryAdmin(client, recoveryAdminId);
  }
}

async function registerRuntimeOnClient(client: PoolClient, runtimeId: string): Promise<void> {
  if (runtimeId.length === 0 || runtimeId.length > 200) {
    throw new PageWriteError(400, 'invalid_runtime_id', 'Runtime id is invalid');
  }
  await client.query(
    `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (runtime_id) DO NOTHING`,
    [runtimeId, JSON.stringify(await processDeploymentIdentity)],
  );
  const result = await client.query<{
    fenced_at: Date | null;
    quiesced_at: Date | null;
  }>(
    `SELECT fenced_at, quiesced_at
       FROM page_writer_runtimes
      WHERE runtime_id = $1`,
    [runtimeId],
  );
  if (result.rows[0]?.fenced_at) {
    throw new PageWriteError(409, 'runtime_fenced', 'This writer runtime has been permanently fenced');
  }
  if (result.rows[0]?.quiesced_at) {
    throw new PageWriteError(409, 'runtime_quiesced', 'This writer runtime has acknowledged quiescence');
  }
}

async function registerRuntime(runtimeId: string): Promise<void> {
  await inTransaction((client) => registerRuntimeOnClient(client, runtimeId));
}

async function assertRuntimeActive(client: PoolClient, runtimeId: string): Promise<void> {
  const result = await client.query<{ fenced_at: Date | null; quiesced_at: Date | null }>(
    `SELECT fenced_at, quiesced_at
       FROM page_writer_runtimes
      WHERE runtime_id = $1
      FOR SHARE`,
    [runtimeId],
  );
  if (!result.rows[0]) {
    throw new PageWriteError(409, 'runtime_unknown', 'The writer runtime is not registered');
  }
  if (result.rows[0].fenced_at) {
    throw new PageWriteError(409, 'runtime_fenced', 'This writer runtime has been permanently fenced');
  }
  if (result.rows[0].quiesced_at) {
    throw new PageWriteError(409, 'runtime_quiesced', 'This writer runtime has acknowledged quiescence');
  }
}

/**
 * Lock the named current-process epoch before caller-owned lifecycle
 * transactions. New lifecycle decisions opt into the local admission gate;
 * continuations already admitted by an intent may finish during quiescence.
 * The SHARE lock makes the durable acknowledgment wait for either transaction.
 * Re-entering on one transaction is safe, so later intent reservation reuses it.
 */
export async function lockPageWriterRuntime(
  client: PoolClient,
  runtimeId: string,
  options?: { newAdmission?: boolean },
): Promise<void> {
  if (runtimeId !== processRuntimeId) {
    throw new PageWriteError(409, 'runtime_mismatch', 'Only the current process epoch may be locked');
  }
  if (options?.newAdmission) beginLocalOperation(false);
  try {
    await registerRuntimeOnClient(client, runtimeId);
    await assertRuntimeActive(client, runtimeId);
  } finally {
    if (options?.newAdmission) finishLocalOperation();
  }
}

async function loadPageStates(
  client: PoolClient,
  pageIds: readonly number[],
  allowDurablyDeleted = false,
): Promise<PageStateRow[]> {
  const ids = normalizePageIds(pageIds);
  const result = await client.query<PageStateRow>(
    `SELECT id, content_revision::text, lifecycle_revision::text, baseline_id
       FROM pages
      WHERE id = ANY($1::integer[])
      ORDER BY id`,
    [ids],
  );
  if (!allowDurablyDeleted && result.rows.length !== ids.length) {
    throw new PageWriteError(404, 'page_not_found', 'One or more pages no longer exist');
  }
  return result.rows;
}

function assertEditable(rows: readonly PageStateRow[]): void {
  if (rows.some((row) => row.baseline_id !== null)) {
    throw new PageWriteError(423, 'page_is_frozen', 'Protected page content is frozen');
  }
}

function assertExpectedRevisions(
  rows: readonly PageStateRow[],
  expected: Readonly<Record<number, PageRevision>>,
): void {
  for (const row of rows) {
    const revision = expected[row.id];
    if (!revision) {
      throw new PageWriteError(409, 'stale_content_revision', 'The write intent does not cover every page');
    }
    if (String(row.lifecycle_revision) !== String(revision.lifecycleRevision)) {
      throw new PageWriteError(409, 'stale_lifecycle', 'The page lifecycle changed after admission');
    }
    if (String(row.content_revision) !== String(revision.contentRevision)) {
      throw new PageWriteError(409, 'stale_content_revision', 'The page content changed after admission');
    }
  }
}

async function loadPendingIntentForUpdate(client: PoolClient, intent: PageWriteIntent): Promise<IntentRow> {
  const result = await client.query<IntentRow>(
    `SELECT id, runtime_id, kind, actor_id, page_ids, revisions, deleted_page_ids, recovery_mode,
            effect, effect_started_at, effect_finished_at, remote_effect_started_at, recovery_started_at,
            remote_effects_completed_at, remote_terminal_result, cache_invalidation_pending,
            recovery_history, status, created_at
       FROM page_write_intents
      WHERE id = $1
      FOR UPDATE`,
    [intent.id],
  );
  const row = result.rows[0];
  if (!row || row.status !== 'pending') {
    throw new PageWriteError(409, 'intent_not_pending', 'The write intent is no longer pending');
  }
  if (row.runtime_id !== intent.runtimeId || !samePageIds(row.page_ids, intent.pageIds)) {
    throw new PageWriteError(409, 'intent_token_mismatch', 'The write intent token does not match durable state');
  }
  const durable = intentFromRow(row);
  for (const pageId of durable.pageIds) {
    const supplied = intent.revisions[pageId];
    const stored = durable.revisions[pageId];
    if (
      !supplied ||
      !stored ||
      supplied.contentRevision !== stored.contentRevision ||
      supplied.lifecycleRevision !== stored.lifecycleRevision
    ) {
      throw new PageWriteError(409, 'intent_token_mismatch', 'The write intent revision does not match durable state');
    }
  }
  return row;
}

async function assertNoCompetingIntent(
  client: PoolClient,
  pageIds: readonly number[],
  exceptId?: string,
): Promise<void> {
  if (pageIds.length === 0) return;
  const result = await client.query<{ id: string }>(
    `SELECT id
       FROM page_write_intents
      WHERE status = 'pending'
        AND page_ids && $1::integer[]
        AND ($2::uuid IS NULL OR id <> $2::uuid)
      LIMIT 1`,
    [normalizePageIds(pageIds), exceptId ?? null],
  );
  if (result.rows[0]) {
    throw new PageWriteError(409, 'page_write_busy', 'Another external page write is unresolved');
  }
}

/** Acquire only the shared per-page transaction advisory locks, in ascending order. */
export async function lockPageLifecycle(
  client: PoolClient,
  pageIds: readonly number[],
  options: { tryLock?: boolean } = {},
): Promise<void> {
  for (const pageId of normalizePageIds(pageIds, true)) {
    if (options.tryLock) {
      const result = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1, $2) AS acquired',
        [PAGE_LIFECYCLE_LOCK_KEY, pageId],
      );
      if (result.rows[0]?.acquired !== true) {
        throw new PageWriteError(409, 'freeze_busy', 'A protected page write is currently committing');
      }
    } else {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
        PAGE_LIFECYCLE_LOCK_KEY,
        pageId,
      ]);
    }
  }
}

/**
 * Lock and validate a protected write on the same client that will execute it.
 * The caller must already have opened a transaction and must not acquire any
 * collaboration, attachment, move, or page-row lock before calling this.
 */
export async function lockPageWrites(
  client: PoolClient,
  pageIds: readonly number[],
  options: { intent?: PageWriteIntent; admission?: PageRuntimeAdmission } = {},
): Promise<void> {
  if (options.intent && options.admission) {
    throw new PageWriteError(400, 'invalid_write_admission', 'A write cannot use two admission tokens');
  }
  const ids = normalizePageIds(pageIds, true);
  const tokenRuntimeId = options.intent?.runtimeId ?? options.admission?.runtimeId;
  if (tokenRuntimeId !== processRuntimeId) {
    // Tokenless SQL still belongs to this process epoch. Keep its row locked
    // through the caller's transaction so a fence cannot overtake its commit.
    beginLocalOperation(tokenRuntimeId !== undefined);
    try {
      await lockPageWriterRuntime(client, processRuntimeId);
    } finally {
      finishLocalOperation();
    }
  }
  if (ids.length === 0) {
    if (options.intent || options.admission) {
      throw new PageWriteError(400, 'invalid_page_ids', 'An admission token cannot cover an empty page set');
    }
    return;
  }
  if (options.intent) await assertRuntimeActive(client, options.intent.runtimeId);
  if (options.admission) await assertRuntimeActive(client, options.admission.runtimeId);
  await lockPageLifecycle(client, ids);
  if (options.intent) {
    const durable = await loadPendingIntentForUpdate(client, options.intent);
    const rows = await loadPageStates(client, ids, true);
    const liveIds = new Set(rows.map((row) => row.id));
    const missingIds = ids.filter((pageId) => !liveIds.has(pageId));
    const durablyDeleted = [...durable.deleted_page_ids].sort((a, b) => a - b);
    if (
      missingIds.length !== durablyDeleted.length ||
      missingIds.some((pageId, index) => pageId !== durablyDeleted[index])
    ) {
      throw new PageWriteError(
        409,
        'intent_deletion_tombstone_mismatch',
        'A missing page was not deleted by this durable write intent',
      );
    }
    assertEditable(rows);
    // Runtime epoch was locked before the page lifecycle lock.
    assertExpectedRevisions(rows, intentFromRow(durable).revisions);
    await assertNoCompetingIntent(client, ids, durable.id);
    return;
  }

  const rows = await loadPageStates(client, ids);
  assertEditable(rows);
  if (options.admission) {
    const admission = options.admission;
    if (ids.length !== 1 || ids[0] !== admission.pageId) {
      throw new PageWriteError(409, 'admission_token_mismatch', 'The room admission covers a different page');
    }
    const result = await client.query<AdmissionRow>(
      `SELECT id, runtime_id, page_id, actor_id, lifecycle_revision::text, admitted_at, released_at
         FROM page_runtime_admissions
        WHERE id = $1
        FOR UPDATE`,
      [admission.id],
    );
    const stored = result.rows[0];
    if (
      !stored ||
      stored.released_at ||
      stored.runtime_id !== admission.runtimeId ||
      stored.page_id !== admission.pageId ||
      String(stored.lifecycle_revision) !== admission.lifecycleRevision
    ) {
      throw new PageWriteError(409, 'admission_token_mismatch', 'The writable room admission is stale');
    }
    // Runtime epoch was locked before the page lifecycle lock.
    if (String(rows[0]!.lifecycle_revision) !== admission.lifecycleRevision) {
      throw new PageWriteError(409, 'stale_lifecycle', 'The page lifecycle changed after room admission');
    }
    await assertNoCompetingIntent(client, ids);
    return;
  }

  await assertNoCompetingIntent(client, ids);
}

export async function withPageWriteTransaction<T>(
  pageIds: readonly number[],
  operation: (client: PoolClient) => Promise<T>,
  options: { intent?: PageWriteIntent; admission?: PageRuntimeAdmission } = {},
): Promise<T> {
  beginLocalOperation(options.intent !== undefined || options.admission !== undefined);
  try {
    return await inTransaction(async (client) => {
      await lockPageWrites(client, pageIds, options);
      return operation(client);
    });
  } finally {
    finishLocalOperation();
  }
}

export type PageWriteIntentInput = {
  pageIds: readonly number[];
  kind: string;
  actorId?: string;
  effect: Record<string, unknown>;
  /** Phased work must not adopt a newer content/lifecycle epoch between steps. */
  expectedRevisions?: Readonly<Record<number, PageRevision>>;
};

async function reservePageWriteIntentOnClient(
  client: PoolClient,
  input: PageWriteIntentInput,
  runtimeId: string,
): Promise<PageWriteIntent> {
  const pageIds = normalizePageIds(input.pageIds);
  const effect = cloneBoundedObject(input.effect, 'intent_effect');
  const policy = policyForIntent(input.kind, effect);
  await registerRuntimeOnClient(client, runtimeId);
  await assertRuntimeActive(client, runtimeId);
  await lockPageWrites(client, pageIds);
  const rows = await loadPageStates(client, pageIds);
  if (input.expectedRevisions) assertExpectedRevisions(rows, input.expectedRevisions);
  const revisions = revisionsForRows(rows);
  const id = randomUUID();
  await client.query(
    `INSERT INTO page_write_intents
       (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect)
     VALUES ($1, $2, $3, $4, $5::integer[], $6::jsonb, $7, $8::jsonb)`,
    [
      id,
      runtimeId,
      input.kind,
      input.actorId ?? null,
      pageIds,
      JSON.stringify(revisions),
      policy.recoveryMode,
      JSON.stringify(effect),
    ],
  );
  return { id, runtimeId, pageIds, revisions };
}

/**
 * Reserve an intent inside a caller-owned transaction. The caller must acquire
 * no page-row or subsystem lock before the lifecycle lock. Runtime registration
 * uses this same client, so this helper never checks out another pooled client
 * while the caller holds the lifecycle lock.
 *
 * The returned token becomes executable only after the caller commits.
 * runPageWriteIntentEffect synchronously claims the local gate and then adopts
 * the committed durable row before invoking any supplied I/O callback.
 */
export async function reservePageWriteIntentInTransaction(
  client: PoolClient,
  input: PageWriteIntentInput,
): Promise<PageWriteIntent> {
  beginLocalOperation(false);
  try {
    const intent = await reservePageWriteIntentOnClient(client, input, processRuntimeId);
    localIntentEffects.set(intent.id, 'reserved_uncommitted');
    localIntentRecoveryModes.set(
      intent.id,
      INTENT_POLICIES[input.kind as IntentKind].recoveryMode,
    );
    return intent;
  } finally {
    finishLocalOperation();
  }
}

export async function reservePageWriteIntent(
  input: PageWriteIntentInput,
): Promise<PageWriteIntent> {
  beginLocalOperation(false);
  try {
    const runtimeId = await getPageWriterRuntimeId();
    const intent = await inTransaction((client) => reservePageWriteIntentOnClient(client, input, runtimeId));
    localIntentEffects.set(intent.id, 'reserved');
    localIntentRecoveryModes.set(
      intent.id,
      INTENT_POLICIES[input.kind as IntentKind].recoveryMode,
    );
    return intent;
  } finally {
    finishLocalOperation();
  }
}

export type PageWriteIntentPhase<T> =
  | { kind: 'local' }
  | {
      kind: 'remote';
      completesRemoteWork: boolean;
      terminalResult?: (result: T) => Record<string, unknown>;
    };

async function markPageWriteIntentEffectStarted<T>(
  intent: PageWriteIntent,
  phase: PageWriteIntentPhase<T>,
): Promise<IntentRow> {
  return inTransaction(async (client) => {
    await lockPageWrites(client, intent.pageIds, { intent });
    await assertRecoveryAdminForIntent(client, intent);
    const durable = await loadPendingIntentForUpdate(client, intent);
    if (phase.kind === 'remote' && durable.remote_effects_completed_at !== null) {
      throw new PageWriteError(
        409,
        'remote_work_already_completed',
        'No remote phase may start after all declared remote work completed',
      );
    }
    await client.query(
      `UPDATE page_write_intents
          SET effect_started_at = COALESCE(effect_started_at, NOW()),
              effect_finished_at = NULL,
              remote_effect_started_at = CASE
                WHEN $2::boolean THEN COALESCE(remote_effect_started_at, NOW())
                ELSE remote_effect_started_at
              END
        WHERE id = $1 AND status = 'pending'`,
      [intent.id, phase.kind === 'remote'],
    );
    return durable;
  });
}

async function markPageWriteIntentEffectFinished<T>(
  intent: PageWriteIntent,
  phase: PageWriteIntentPhase<T>,
  result: T,
): Promise<void> {
  const terminalResult =
    phase.kind === 'remote' && phase.completesRemoteWork
      ? cloneBoundedObject(
          phase.terminalResult?.(result) ?? {},
          'remote_terminal_result',
        )
      : null;
  await inTransaction(async (client) => {
    await lockPageWrites(client, intent.pageIds, { intent });
    await assertRecoveryAdminForIntent(client, intent);
    const updated = await client.query(
      `UPDATE page_write_intents
          SET effect_finished_at = NOW(),
              remote_effects_completed_at = CASE
                WHEN $2::boolean THEN NOW()
                ELSE remote_effects_completed_at
              END,
              remote_terminal_result = CASE
                WHEN $2::boolean THEN $3::jsonb
                ELSE remote_terminal_result
              END
        WHERE id = $1
          AND status = 'pending'
          AND effect_started_at IS NOT NULL
          AND (NOT $2::boolean OR remote_effect_started_at IS NOT NULL)`,
      [
        intent.id,
        phase.kind === 'remote' && phase.completesRemoteWork,
        JSON.stringify(terminalResult),
      ],
    );
    if (updated.rowCount !== 1) {
      throw new PageWriteError(409, 'intent_not_pending', 'The write intent was settled concurrently');
    }
  });
}

/**
 * Mandatory gate around one declared local or remote phase. A local phase can
 * stage bytes, but only a remote phase records durable dispatch. The final
 * remote callback alone records all-remote-work completion; later local
 * publication phases preserve that proof.
 */
export async function runPageWriteIntentEffect<T>(
  intent: PageWriteIntent,
  phase: PageWriteIntentPhase<T>,
  operation: () => Promise<T>,
): Promise<T> {
  if (intent.runtimeId !== processRuntimeId) {
    throw new PageWriteError(409, 'intent_runtime_mismatch', 'Only the owning runtime may execute an effect');
  }
  const state = localIntentEffects.get(intent.id);
  // A successful phase keeps ownership of its admitted continuation. Closing
  // the gate refuses a first effect or retry, but not the next declared phase.
  beginLocalOperation(state === 'succeeded');
  let needsDurableAdoption = false;
  try {
    if (state === 'running') {
      throw new PageWriteError(409, 'intent_effect_state', 'The intent effect is already running');
    }
    if (state === 'failed' && localIntentFailedRemotePhases.has(intent.id)) {
      throw new PageWriteError(
        409,
        'intent_outcome_unknown',
        'A remote mutation with an unknown outcome cannot be reissued by the original runtime',
      );
    }
    needsDurableAdoption = state === undefined || state === 'reserved_uncommitted';
    // Registration happens synchronously before the first await. Quiescence
    // therefore sees and drains the start marker and effect together.
    localIntentEffects.set(intent.id, 'running');
  } finally {
    finishLocalOperation();
  }
  try {
    const durable = await markPageWriteIntentEffectStarted(intent, phase);
    if (needsDurableAdoption) {
      localIntentRecoveryModes.set(intent.id, durable.recovery_mode);
    }
    const result = await operation();
    await markPageWriteIntentEffectFinished(intent, phase, result);
    localIntentEffects.set(intent.id, 'succeeded');
    localIntentFailedRemotePhases.delete(intent.id);
    return result;
  } catch (error) {
    if (phase.kind === 'remote') localIntentFailedRemotePhases.add(intent.id);
    if (needsDurableAdoption && localIntentRecoveryModes.get(intent.id) === undefined) {
      localIntentEffects.delete(intent.id);
      localIntentFailedRemotePhases.delete(intent.id);
    } else {
      localIntentEffects.set(intent.id, 'failed');
    }
    throw error;
  } finally {
    notifyLocalDrainWaiters();
  }
}

export async function completePageWriteIntent<T>(
  intent: PageWriteIntent,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  beginLocalOperation(true);
  try {
    const result = await inTransaction(async (client) => {
      await lockPageWrites(client, intent.pageIds, { intent });
      const durable = await loadPendingIntentForUpdate(client, intent);
      const effectClass = durable.effect.effectClass;
      const effectState = localIntentEffects.get(intent.id);
      if (
        effectState === 'running' ||
        effectState === 'failed' ||
        ((effectClass === 'remote' || durable.kind === 'baseline.prepare') &&
          (durable.runtime_id !== processRuntimeId || effectState !== 'succeeded')) ||
        (effectClass === 'remote' && durable.remote_effects_completed_at === null)
      ) {
        throw new PageWriteError(
          409,
          'effect_not_terminal',
          'The owning runtime has not observed durable completion of every required effect',
        );
      }
      const value = await operation(client);
      const finalRows = await client.query<PageStateRow>(
        `SELECT id, content_revision::text, lifecycle_revision::text, baseline_id
           FROM pages WHERE id = ANY($1::integer[]) ORDER BY id`,
        [normalizePageIds(intent.pageIds)],
      );
      const settlementProof = effectClass === 'remote'
        ? {
            kind: 'owning_runtime_terminal_response',
            recoveryMode: durable.recovery_mode,
            completedByRuntime: processRuntimeId,
            finalRevisions: revisionsForRows(finalRows.rows),
          }
        : { finalRevisions: revisionsForRows(finalRows.rows) };
      const settled = await client.query<{ cache_invalidation_pending: boolean }>(
        `UPDATE page_write_intents
            SET status = 'completed', settled_at = NOW(), settlement_reason = 'effect_committed',
                settlement_proof = $2::jsonb
          WHERE id = $1 AND status = 'pending'
        RETURNING cache_invalidation_pending`,
        [intent.id, JSON.stringify(settlementProof)],
      );
      if (settled.rowCount !== 1) {
        throw new PageWriteError(409, 'intent_not_pending', 'The write intent was settled concurrently');
      }
      return {
        value,
        invalidationPending: settled.rows[0]?.cache_invalidation_pending === true,
      };
    });
    localIntentEffects.delete(intent.id);
    localIntentRecoveryModes.delete(intent.id);
    localIntentFailedRemotePhases.delete(intent.id);
    if (result.invalidationPending) {
      await flushPageWriteInvalidations(intent.id).catch(() => undefined);
    }
    return result.value;
  } catch (error) {
    // COMMIT can succeed before its response is lost. Re-read the durable row
    // so that exact terminal evidence releases local ownership; any unreadable
    // or still-pending result stays tracked and keeps quiescence blocked.
    try {
      const durable = await getPool().query<{
        status: string;
        cache_invalidation_pending: boolean;
      }>(
        `SELECT status, cache_invalidation_pending
           FROM page_write_intents
          WHERE id = $1 AND runtime_id = $2`,
        [intent.id, intent.runtimeId],
      );
      if (durable.rows[0]?.status === 'completed') {
        localIntentEffects.delete(intent.id);
        localIntentRecoveryModes.delete(intent.id);
        localIntentFailedRemotePhases.delete(intent.id);
        if (durable.rows[0].cache_invalidation_pending) {
          await flushPageWriteInvalidations(intent.id).catch(() => undefined);
        }
      }
    } catch {
      // Uncertainty must retain ownership.
    }
    throw error;
  } finally {
    finishLocalOperation();
  }
}

export async function cancelPageWriteIntentBeforeEffect(intent: PageWriteIntent): Promise<void> {
  beginLocalOperation(true);
  try {
    const localState = localIntentEffects.get(intent.id);
    if (
      intent.runtimeId !== processRuntimeId ||
      (localState !== 'reserved' && localState !== 'reserved_uncommitted')
    ) {
      throw new PageWriteError(
        409,
        'effect_may_have_started',
        'Only the owning runtime may cancel a locally reserved effect that never started',
      );
    }
    await inTransaction(async (client) => {
      await lockPageWrites(client, intent.pageIds, { intent });
      const settled = await client.query(
        `UPDATE page_write_intents
            SET status = 'cancelled', settled_at = NOW(), settlement_reason = 'before_effect',
                settlement_proof = '{"assertion":"no_io_began"}'::jsonb
          WHERE id = $1 AND status = 'pending'
            AND effect_started_at IS NULL AND recovery_started_at IS NULL`,
        [intent.id],
      );
      if (settled.rowCount !== 1) {
        throw new PageWriteError(409, 'intent_not_pending', 'The write intent was settled concurrently');
      }
    });
    localIntentEffects.delete(intent.id);
    localIntentRecoveryModes.delete(intent.id);
    localIntentFailedRemotePhases.delete(intent.id);
  } finally {
    finishLocalOperation();
  }
}

/** SQL progress starts owned work; only the enclosing effect gate can certify I/O completion. */
export async function advancePageWriteIntent<T>(
  intent: PageWriteIntent,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  beginLocalOperation(true);
  try {
    const committed = await inTransaction(async (client) => {
      await lockPageWrites(client, intent.pageIds, { intent });
      await assertRecoveryAdminForIntent(client, intent);
      const result = await operation(client);
      const rows = await loadPageStates(client, intent.pageIds, true);
      const liveIds = new Set(rows.map((row) => row.id));
      const deletedPageIds = intent.pageIds.filter((pageId) => !liveIds.has(pageId));
      const revisions = {
        ...intent.revisions,
        ...revisionsForRows(rows),
      };
      const updated = await client.query(
        `UPDATE page_write_intents
            SET revisions = $2::jsonb, deleted_page_ids = $3::integer[],
                effect_started_at = COALESCE(effect_started_at, NOW())
          WHERE id = $1 AND status = 'pending'`,
        [intent.id, JSON.stringify(revisions), deletedPageIds],
      );
      if (updated.rowCount !== 1) {
        throw new PageWriteError(409, 'intent_not_pending', 'The write intent was settled concurrently');
      }
      return { result, revisions };
    });
    intent.revisions = committed.revisions;
    return committed.result;
  } finally {
    finishLocalOperation();
  }
}

export async function admitPageRuntime(
  pageId: number,
  actorId: string,
  runtimeId?: string,
): Promise<PageRuntimeAdmission> {
  beginLocalOperation(false);
  try {
    const id = runtimeId ?? (await getPageWriterRuntimeId());
    if (runtimeId) await registerRuntime(runtimeId);
    const admission = await inTransaction(async (client) => {
      await assertRuntimeActive(client, id);
      await lockPageWrites(client, [pageId]);
      const rows = await loadPageStates(client, [pageId]);
      const admissionId = randomUUID();
      const lifecycleRevision = String(rows[0]!.lifecycle_revision);
      await client.query(
        `INSERT INTO page_runtime_admissions
           (id, runtime_id, page_id, actor_id, lifecycle_revision)
         VALUES ($1, $2, $3, $4, $5::bigint)`,
        [admissionId, id, pageId, actorId, lifecycleRevision],
      );
      return { id: admissionId, runtimeId: id, pageId, lifecycleRevision };
    });
    localAdmissions.add(admission.id);
    return admission;
  } finally {
    finishLocalOperation();
  }
}

export async function releasePageRuntime(admission: PageRuntimeAdmission): Promise<void> {
  beginLocalOperation(true);
  try {
    await inTransaction(async (client) => {
      await assertRuntimeActive(client, admission.runtimeId);
      await lockPageLifecycle(client, [admission.pageId]);
      const result = await client.query<AdmissionRow>(
        `SELECT id, runtime_id, page_id, actor_id, lifecycle_revision::text, admitted_at, released_at
           FROM page_runtime_admissions WHERE id = $1 FOR UPDATE`,
        [admission.id],
      );
      const stored = result.rows[0];
      if (!stored) {
        throw new PageWriteError(409, 'admission_token_mismatch', 'The writable room admission is unknown');
      }
      if (
        stored.runtime_id !== admission.runtimeId ||
        stored.page_id !== admission.pageId ||
        String(stored.lifecycle_revision) !== admission.lifecycleRevision
      ) {
        throw new PageWriteError(409, 'admission_token_mismatch', 'The writable room admission token is stale');
      }
      if (stored.released_at) return;
      // Runtime epoch was locked before the page lifecycle lock.
      await client.query(
        `UPDATE page_runtime_admissions
            SET released_at = NOW(), release_kind = 'clean_disconnect'
          WHERE id = $1 AND released_at IS NULL`,
        [admission.id],
      );
    });
    localAdmissions.delete(admission.id);
  } finally {
    finishLocalOperation();
  }
}

export async function getPageWriterRuntimeId(): Promise<string> {
  if (!processRuntimeRegistration) {
    processRuntimeRegistration = registerRuntime(processRuntimeId)
      .then(() => processRuntimeId)
      .catch((error) => {
        processRuntimeRegistration = undefined;
        throw error;
      });
  }
  return processRuntimeRegistration;
}

/**
 * Close this process epoch's external-effect/admission gate, drain all work it
 * can still start, and durably acknowledge quiescence.  This is intentionally
 * irreversible for the process lifetime.
 */
export async function quiescePageWriterRuntime(
  authorization: PageWriteRecoveryAuthorization,
): Promise<RuntimeQuiescenceAcknowledgment> {
  const reason = authorization.reason.trim();
  if (reason.length < 10 || authorization.reason.length > 1000) {
    throw new PageWriteError(
      400,
      'invalid_quiescence_reason',
      'Runtime quiescence reason must be 10 to 1000 characters',
    );
  }
  const runtimeId = await getPageWriterRuntimeId();

  // Accept and durably record the retirement request while the actor's admin
  // row is SHARE-locked. Only a committed request may close the process gate.
  await inTransaction(async (client) => {
    await assertActiveRecoveryAdmin(client, authorization.actorId);
    await client.query(
      `INSERT INTO audit_log
         (user_id, action, resource_type, resource_id, metadata, ip_address, user_agent)
       VALUES ($1, 'ADMIN_ACTION', 'page_writer_runtime', $2, $3::jsonb, $4, $5)`,
      [
        authorization.actorId,
        runtimeId,
        JSON.stringify({ action: 'page_writer_quiesce_requested', reason }),
        authorization.ipAddress ?? null,
        authorization.userAgent ?? null,
      ],
    );
  });

  processAcceptingEffects = false;
  await waitForLocalRuntimeDrain();

  const acknowledgmentId = await inTransaction(async (client) => {
    const current = await client.query<{
      fenced_at: Date | null;
      quiescence_ack: string | null;
    }>(
      `SELECT fenced_at, quiescence_ack
         FROM page_writer_runtimes
        WHERE runtime_id = $1
        FOR UPDATE`,
      [runtimeId],
    );
    if (!current.rows[0]) {
      throw new PageWriteError(409, 'runtime_unknown', 'The writer runtime is not registered');
    }
    if (current.rows[0].fenced_at) {
      throw new PageWriteError(409, 'runtime_fenced', 'This writer runtime has been permanently fenced');
    }
    const activeAdmissions = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM page_runtime_admissions
          WHERE runtime_id = $1 AND released_at IS NULL
       ) AS exists`,
      [runtimeId],
    );
    if (activeAdmissions.rows[0]?.exists) {
      throw new PageWriteError(
        409,
        'runtime_admissions_active',
        'The runtime cannot acknowledge quiescence while a writable admission remains',
      );
    }
    // The runtime UPDATE lock excludes every effect-start marker while this
    // transaction cancels only DB-proven no-start reservations. In particular,
    // an intent reserved by a caller-owned transaction cannot commit behind
    // this check and become executable after the acknowledgment.
    const noStartTargets = await client.query<{ page_id: number }>(
      `SELECT DISTINCT page_id
         FROM (
           SELECT unnest(page_ids) AS page_id
             FROM page_write_intents
            WHERE runtime_id = $1
              AND status = 'pending'
              AND effect_started_at IS NULL
              AND recovery_started_at IS NULL
         ) targets
        ORDER BY page_id`,
      [runtimeId],
    );
    if (noStartTargets.rows.length > 0) {
      await lockPageLifecycle(client, noStartTargets.rows.map((target) => target.page_id));
    }
    // The actor may have been demoted or deactivated while this process
    // drained. Hold the user row through cancellation and acknowledgment.
    await assertActiveRecoveryAdmin(client, authorization.actorId);
    await client.query(
      `UPDATE page_write_intents
          SET status = 'cancelled', settled_at = NOW(), settled_by = $2,
              settlement_reason = 'before_effect',
              settlement_proof = '{"assertion":"no_io_began"}'::jsonb
        WHERE runtime_id = $1
          AND status = 'pending'
          AND effect_started_at IS NULL
          AND recovery_started_at IS NULL`,
      [runtimeId, authorization.actorId],
    );
    if (current.rows[0].quiescence_ack) return current.rows[0].quiescence_ack;
    const ack = randomUUID();
    await client.query(
      `UPDATE page_writer_runtimes
          SET quiesced_at = NOW(), quiescence_ack = $2
        WHERE runtime_id = $1 AND quiesced_at IS NULL`,
      [runtimeId, ack],
    );
    return ack;
  });
  return {
    runtimeId,
    acknowledgmentId,
    deploymentIdentity: publicDeploymentIdentity(await processDeploymentIdentity) as {
      host: string;
      pid: number;
      startedAt: string;
    },
  };
}

/** Called by freeze while it holds the page lifecycle lock. */
export async function assertPageFreezeIdle(client: PoolClient, pageId: number): Promise<void> {
  const [intent, admission] = await Promise.all([
    client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM page_write_intents
          WHERE status = 'pending' AND page_ids && ARRAY[$1]::integer[]
       ) AS exists`,
      [pageId],
    ),
    client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM page_runtime_admissions
          WHERE page_id = $1 AND released_at IS NULL
       ) AS exists`,
      [pageId],
    ),
  ]);
  if (intent.rows[0]?.exists || admission.rows[0]?.exists) {
    throw new PageWriteError(409, 'freeze_busy', 'The page has an active writer or unresolved effect');
  }
}

export type PageWriterFenceRequest = {
  runtimeId: string;
  actorId: string;
  reason: string;
} & (
  | { mode: 'owner_ack'; acknowledgmentId: string }
  | { mode: 'durable_no_started_effects' }
  | { mode: 'verified_local_termination' }
);

/**
 * Permanently fence one writer epoch. Owner acknowledgement is the graceful
 * path. A crashed runtime without started work can instead be fenced from
 * server-owned durable evidence: the runtime row is locked before its page
 * lifecycle locks, so either an effect-start/reservation commits first and is
 * observed here, or this fence commits first and the late writer is refused.
 * A started effect additionally requires independently verified local process
 * death; its intent remains pending for the kind-specific reconciler.
 */
export async function fencePageWriterRuntime(
  input: PageWriterFenceRequest,
): Promise<{ unresolvedIntents: number }> {
  if (input.reason.trim().length < 10 || input.reason.length > 1000) {
    throw new PageWriteError(400, 'invalid_fence_reason', 'Runtime fence reason must be 10 to 1000 characters');
  }
  return inTransaction(async (client) => {
    const runtime = await client.query<{
      fenced_at: Date | null;
      quiescence_ack: string | null;
      deployment_identity: Record<string, unknown>;
    }>(
      `SELECT fenced_at, quiescence_ack::text, deployment_identity
         FROM page_writer_runtimes
        WHERE runtime_id = $1
        FOR UPDATE`,
      [input.runtimeId],
    );
    const row = runtime.rows[0];
    if (!row) {
      throw new PageWriteError(404, 'runtime_unknown', 'The writer runtime is not registered');
    }

    if (input.mode === 'owner_ack') {
      if (!row.quiescence_ack || row.quiescence_ack !== input.acknowledgmentId) {
        throw new PageWriteError(
          409,
          'runtime_not_quiesced',
          'The owning process has not acknowledged this exact quiescent epoch',
        );
      }
      const activeAdmissions = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM page_runtime_admissions
            WHERE runtime_id = $1 AND released_at IS NULL
         ) AS exists`,
        [input.runtimeId],
      );
      if (activeAdmissions.rows[0]?.exists) {
        throw new PageWriteError(
          409,
          'runtime_admissions_active',
          'Durable writable admissions still prevent owner-acknowledged fencing',
        );
      }
    } else if (input.mode === 'durable_no_started_effects') {
      const started = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM page_write_intents
            WHERE runtime_id = $1
              AND status = 'pending'
              AND (effect_started_at IS NOT NULL OR recovery_started_at IS NOT NULL)
         ) AS exists`,
        [input.runtimeId],
      );
      if (started.rows[0]?.exists) {
        throw new PageWriteError(
          409,
          'runtime_effects_started',
          'The runtime has started work; durable no-start evidence cannot fence it',
        );
      }
    } else if (!(await verifyLocalPageWriterTermination(row.deployment_identity))) {
      throw new PageWriteError(
        409,
        'runtime_termination_unverified',
        'This server cannot independently verify that the original local writer process terminated',
      );
    }

    const targetResult = await client.query<{ page_id: number }>(
      `SELECT DISTINCT page_id
         FROM (
           SELECT unnest(page_ids) AS page_id
             FROM page_write_intents
            WHERE runtime_id = $1 AND status = 'pending'
           UNION ALL
           SELECT page_id
             FROM page_runtime_admissions
            WHERE runtime_id = $1 AND released_at IS NULL
         ) targets
        ORDER BY page_id`,
      [input.runtimeId],
    );
    const targets = targetResult.rows.map((target) => target.page_id);
    if (targets.length > 0) await lockPageLifecycle(client, targets);
    await assertActiveRecoveryAdmin(client, input.actorId);

    if (!row.fenced_at) {
      const fenceProof =
        input.mode === 'owner_ack'
          ? {
              kind: 'owner_quiescence_ack',
              acknowledgmentId: input.acknowledgmentId,
              deploymentIdentity: publicDeploymentIdentity(row.deployment_identity),
            }
          : {
              kind: input.mode,
              deploymentIdentity: publicDeploymentIdentity(row.deployment_identity),
            };
      await client.query(
        `UPDATE page_writer_runtimes
            SET fenced_at = NOW(), fenced_by = $2, fence_reason = $3, fence_proof = $4::jsonb
          WHERE runtime_id = $1 AND fenced_at IS NULL`,
        [input.runtimeId, input.actorId, input.reason.trim(), JSON.stringify(fenceProof)],
      );
    }

    if (input.mode !== 'owner_ack') {
      await client.query(
        `UPDATE page_write_intents
            SET status = 'cancelled',
                settled_at = NOW(),
                settled_by = $2,
                settlement_reason = 'runtime_fenced_before_effect',
                settlement_proof = jsonb_build_object('assertion', $3::text)
          WHERE runtime_id = $1
            AND status = 'pending'
            AND effect_started_at IS NULL
            AND recovery_started_at IS NULL`,
        [input.runtimeId, input.actorId, input.mode],
      );
      await client.query(
        `UPDATE page_runtime_admissions
            SET released_at = NOW(), release_kind = 'runtime_fenced'
          WHERE runtime_id = $1 AND released_at IS NULL`,
        [input.runtimeId],
      );
    }

    const unresolved = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM page_write_intents
        WHERE runtime_id = $1 AND status = 'pending'`,
      [input.runtimeId],
    );
    return { unresolvedIntents: Number(unresolved.rows[0]?.count ?? '0') };
  });
}

/**
 * Reconcile an unknown I/O outcome after the original runtime has a
 * server-proven fence. The proof comes only from trusted server code registered
 * for the closed intent kind; HTTP callers can supply neither a verifier nor a
 * proof object.
 *
 * Remote conditional recovery is read-only: it observes exact provider
 * history at expected version E+1 and compares its canonical state digest.
 * Unversioned remote mutations are terminal-only and can never enter this
 * recovery path: losing durability after their response remains unresolved.
 */
export async function reconcilePageWriteIntent(
  intentId: string,
  authorization: Pick<PageWriteRecoveryAuthorization, 'actorId' | 'reason'>,
): Promise<{ intentId: string; status: 'reconciled_applied' | 'reconciled_not_applied' }> {
  const previousRecoveryState = localRecoveries.get(intentId);
  if (previousRecoveryState === 'running') {
    throw new PageWriteError(409, 'intent_recovery_running', 'This runtime is already reconciling the intent');
  }
  beginLocalOperation(false);
  localRecoveries.set(intentId, 'running');
  let recoveryClaimed = false;
  try {
    if (authorization.reason.trim().length < 10 || authorization.reason.length > 1000) {
      throw new PageWriteError(400, 'invalid_reconciliation_reason', 'Reconciliation reason must be 10 to 1000 characters');
    }
    localRecoveryAdmins.set(intentId, authorization.actorId);
    const discovered = await getPool().query<IntentRow>(
      `SELECT id, runtime_id, kind, actor_id, page_ids, revisions, deleted_page_ids, recovery_mode,
              effect, effect_started_at, effect_finished_at, remote_effect_started_at, recovery_started_at,
              remote_effects_completed_at, remote_terminal_result, cache_invalidation_pending,
              recovery_history, status, created_at
         FROM page_write_intents WHERE id = $1`,
      [intentId],
    );
    if (!discovered.rows[0]) {
      throw new PageWriteError(404, 'intent_not_found', 'The write intent does not exist');
    }
    const discoveredIntent = discovered.rows[0];
    if (
      discoveredIntent.recovery_mode === 'remote_terminal_only' &&
      discoveredIntent.remote_effect_started_at !== null &&
      discoveredIntent.remote_effects_completed_at === null
    ) {
      throw new PageWriteError(
        409,
        'intent_outcome_unrecoverable',
        'The unversioned remote mutation has no durable terminal response and must remain unresolved',
      );
    }
    const verifier = intentReconcilers.get(discoveredIntent.kind as IntentKind);
    if (!verifier) {
      throw new PageWriteError(
        409,
        'intent_reconciler_unavailable',
        'No trusted server reconciler is registered for this intent kind',
      );
    }
    const token = intentFromRow(discovered.rows[0]);
  
    const currentRuntimeId = await getPageWriterRuntimeId();
    const retryingHere = token.runtimeId === currentRuntimeId && previousRecoveryState === 'failed';
    const recoveryToken = await inTransaction(async (client) => {
      await lockPageWriterRuntime(client, currentRuntimeId);
      if (!retryingHere) {
        const oldRuntime = await client.query<{ fenced_at: Date | null }>(
          `SELECT fenced_at FROM page_writer_runtimes WHERE runtime_id = $1 FOR SHARE`,
          [token.runtimeId],
        );
        if (!oldRuntime.rows[0]?.fenced_at) {
          throw new PageWriteError(409, 'runtime_not_safely_fenced', 'A server-proven original runtime fence is required');
        }
      }
      await lockPageLifecycle(client, token.pageIds);
      const durable = await loadPendingIntentForUpdate(client, token);
      const rows = await loadPageStates(client, durable.page_ids, true);
      const liveIds = new Set(rows.map((row) => row.id));
      const missingIds = durable.page_ids
        .filter((pageId) => !liveIds.has(pageId))
        .sort((a, b) => a - b);
      const durablyDeleted = [...durable.deleted_page_ids].sort((a, b) => a - b);
      if (
        missingIds.length !== durablyDeleted.length ||
        missingIds.some((pageId, index) => pageId !== durablyDeleted[index])
      ) {
        throw new PageWriteError(
          409,
          'intent_deletion_tombstone_mismatch',
          'A missing page was not deleted by this durable write intent',
        );
      }
      assertEditable(rows);
      assertExpectedRevisions(rows, intentFromRow(durable).revisions);
      await assertNoCompetingIntent(client, durable.page_ids, durable.id);
      await assertActiveRecoveryAdmin(client, authorization.actorId);
      // Commit the acting administrator before trusted verification or repair
      // can mutate external state. The current segment stays bounded for token
      // readers; a rollover archives the complete prior segment in this same
      // locked claim statement, so neither half can commit without the other.
      const claimed = await client.query<IntentRow>(
        `WITH recovery_attempt(value) AS MATERIALIZED (
           SELECT jsonb_build_object(
             'attemptKind', CASE WHEN $6::boolean THEN 'same_runtime_retry' ELSE 'runtime_transfer' END,
             'fromRuntimeId', $3::text,
             'toRuntimeId', $2::text,
             'attemptedAt', NOW(),
             'transferredAt', CASE WHEN $6::boolean THEN NULL ELSE NOW() END,
             'actorId', $4::text,
             'reason', $5::text,
             'observedState', 'verification_pending',
             'priorEffectStartedAt', i.effect_started_at,
             'priorEffectFinishedAt', i.effect_finished_at
           )
             FROM page_write_intents i
            WHERE i.id = $1
              AND i.runtime_id = $3
              AND i.status = 'pending'
         ),
         claim_plan AS MATERIALIZED (
           SELECT i.id,
                  i.recovery_history,
                  a.value AS recovery_attempt,
                  (
                    jsonb_array_length(i.recovery_history) + 1 > $7
                    OR octet_length(
                      (i.recovery_history || jsonb_build_array(a.value))::text
                    ) > $8
                  ) AS archive_required
             FROM page_write_intents i
             CROSS JOIN recovery_attempt a
            WHERE i.id = $1
              AND i.runtime_id = $3
              AND i.status = 'pending'
         ),
         archived AS (
           INSERT INTO page_write_recovery_history_segments (intent_id, recovery_history)
           SELECT id, recovery_history
             FROM claim_plan
            WHERE archive_required
           RETURNING intent_id
         )
         UPDATE page_write_intents i
            SET runtime_id = $2,
                recovery_started_at = COALESCE(i.recovery_started_at, NOW()),
                recovery_history = CASE
                  WHEN p.archive_required THEN jsonb_build_array(p.recovery_attempt)
                  ELSE p.recovery_history || jsonb_build_array(p.recovery_attempt)
                END
           FROM claim_plan p
          WHERE i.id = p.id
            AND (
              NOT p.archive_required
              OR EXISTS (SELECT 1 FROM archived WHERE intent_id = i.id)
            )
        RETURNING i.id, i.runtime_id, i.kind, i.actor_id, i.page_ids, i.revisions,
                  i.deleted_page_ids, i.recovery_mode, i.effect, i.effect_started_at,
                  i.effect_finished_at, i.recovery_started_at, i.remote_effect_started_at,
                  i.remote_effects_completed_at, i.remote_terminal_result,
                  i.cache_invalidation_pending, i.recovery_history, i.status, i.created_at`,
        [
          durable.id,
          currentRuntimeId,
          token.runtimeId,
          authorization.actorId,
          authorization.reason.trim(),
          retryingHere,
          RECOVERY_HISTORY_MAX_ATTEMPTS,
          RECOVERY_HISTORY_MAX_BYTES,
        ],
      );
      if (claimed.rowCount !== 1) {
        throw new PageWriteError(409, 'intent_transfer_conflict', 'The recovery intent was transferred concurrently');
      }
      // COMMIT may succeed while its acknowledgement is lost. Retain local
      // retry eligibility before awaiting it; a real rollback still leaves the
      // old durable owner, so the next attempt must take the fenced-transfer path.
      recoveryClaimed = true;
      return recoveryIntentFromRow(claimed.rows[0]!);
    });
    // The durable claim survives a connection loss or process death while a
    // verifier publishes files. Original phase markers remain evidence, not
    // invented starts; recovery_started_at independently prevents a no-start fence.
    const verifyAndSettle = (attemptToken: PageWriteIntent) => inTransaction(async (client) => {
      await lockPageWriterRuntime(client, currentRuntimeId);
      await lockPageLifecycle(client, attemptToken.pageIds);
      const durable = await loadPendingIntentForUpdate(client, attemptToken);
      const rows = await loadPageStates(client, durable.page_ids, true);
      const liveIds = new Set(rows.map((row) => row.id));
      const missingIds = durable.page_ids
        .filter((pageId) => !liveIds.has(pageId))
        .sort((a, b) => a - b);
      const durablyDeleted = [...durable.deleted_page_ids].sort((a, b) => a - b);
      if (
        missingIds.length !== durablyDeleted.length ||
        missingIds.some((pageId, index) => pageId !== durablyDeleted[index])
      ) {
        throw new PageWriteError(
          409,
          'intent_deletion_tombstone_mismatch',
          'A missing page was not deleted by this durable write intent',
        );
      }
      assertEditable(rows);
      assertExpectedRevisions(rows, intentFromRow(durable).revisions);
      await assertNoCompetingIntent(client, durable.page_ids, durable.id);
      await assertActiveRecoveryAdmin(client, authorization.actorId);
  
      const reconciled = await verifier(client, recoveryIntentFromRow(durable));
      if (reconciled.outcome === 'repair_required') {
        if (durable.recovery_mode !== 'local_verified') {
          throw new PageWriteError(400, 'invalid_repair_verdict', 'Only local verified intents may require repair');
        }
        return {
          kind: 'repair_required' as const,
          observedState: reconciled.observedState,
          durable,
        };
      }
      const proof = cloneBoundedObject(
        reconciled.proof as unknown as Record<string, unknown>,
        'reconciliation_proof',
      ) as unknown as PageWriteReconciliationProof;
      const proofKinds = [
        'local_bytes_verified',
        'local_effect_absence_verified',
        'local_intended_absence_verified',
        'remote_conditional_effect_converged',
        'remote_effect_not_started',
        'remote_terminal_effect_verified',
      ];
      const details = (proof.details ?? {}) as unknown as Record<string, unknown>;
      const localBytesValid =
        proof.kind !== 'local_bytes_verified' ||
        (reconciled.outcome === 'applied' &&
          details.syscallSettled === true &&
          typeof details.intendedStateDigest === 'string' &&
          details.intendedStateDigest.length > 0 &&
          details.observedStateDigest === details.intendedStateDigest &&
          typeof details.intendedSize === 'number' &&
          Number.isSafeInteger(details.intendedSize) &&
          details.intendedSize >= 0 &&
          details.observedSize === details.intendedSize);
      const localAbsenceValid =
        proof.kind !== 'local_effect_absence_verified' ||
        (reconciled.outcome === 'not_applied' &&
          details.syscallSettled === true &&
          details.observedAbsent === true);
      const localIntendedAbsenceValid =
        proof.kind !== 'local_intended_absence_verified' ||
        (reconciled.outcome === 'applied' &&
          details.syscallSettled === true &&
          details.observedAbsent === true &&
          typeof details.intendedIdentity === 'string' &&
          details.intendedIdentity.length > 0);
      const expectedRemoteVersion = parseNonnegativeVersion(details.conditionalExpectedVersion);
      const observedRemoteVersion = parseNonnegativeVersion(details.observedRemoteVersion);
      const remoteBaseValid =
        details.recoveryAttempted === true &&
        expectedRemoteVersion !== null &&
        expectedRemoteVersion > 0n &&
        observedRemoteVersion !== null &&
        typeof details.intendedStateDigest === 'string' &&
        details.intendedStateDigest.length > 0 &&
        typeof details.observedStateDigest === 'string';
      const expectedResultVersion =
        expectedRemoteVersion === null ? null : expectedRemoteVersion + 1n;
      const observedExpectedResult =
        expectedResultVersion !== null && observedRemoteVersion === expectedResultVersion;
      const remoteAppliedValid =
        reconciled.outcome === 'applied' &&
        (details.providerResult === 'applied' ||
          details.providerResult === 'historical_version_observed') &&
        remoteBaseValid &&
        observedExpectedResult &&
        details.observedStateDigest === details.intendedStateDigest;
      const remoteNotAppliedValid =
        reconciled.outcome === 'not_applied' &&
        details.providerResult === 'historical_version_observed' &&
        remoteBaseValid &&
        observedExpectedResult &&
        details.observedStateDigest !== details.intendedStateDigest;
      const remoteDetailsValid =
        proof.kind !== 'remote_conditional_effect_converged' ||
        remoteAppliedValid ||
        remoteNotAppliedValid;
      const remoteNotStartedValid =
        proof.kind !== 'remote_effect_not_started' ||
        (reconciled.outcome === 'not_applied' &&
          durable.remote_effect_started_at === null &&
          durable.remote_effects_completed_at === null &&
          details.syscallSettled === true &&
          details.remoteEffectStarted === false &&
          details.observedAbsent === true);
      const remoteTerminalValid =
        proof.kind !== 'remote_terminal_effect_verified' ||
        ((reconciled.outcome === 'applied' || reconciled.outcome === 'not_applied') &&
          durable.remote_effect_started_at !== null &&
          durable.remote_effects_completed_at !== null &&
          details.remoteEffectsCompleted === true &&
          typeof details.terminalEvidence === 'string' &&
          details.terminalEvidence.length > 0);
      const proofMatchesRecoveryMode =
        (durable.recovery_mode === 'remote_conditional' &&
          proof.kind === 'remote_conditional_effect_converged') ||
        (durable.recovery_mode === 'remote_terminal_only' &&
          ((durable.remote_effect_started_at === null &&
            proof.kind === 'remote_effect_not_started') ||
            (durable.remote_effects_completed_at !== null &&
              proof.kind === 'remote_terminal_effect_verified'))) ||
        (durable.recovery_mode === 'local_verified' &&
          (proof.kind === 'local_bytes_verified' ||
            proof.kind === 'local_effect_absence_verified' ||
            proof.kind === 'local_intended_absence_verified'));
      if (
        !proofKinds.includes(proof.kind) ||
        typeof proof.observedAt !== 'string' ||
        !Number.isFinite(Date.parse(proof.observedAt)) ||
        typeof proof.reference !== 'string' ||
        proof.reference.trim().length === 0 ||
        proof.reference.length > 1000 ||
        proof.details === null ||
        Array.isArray(proof.details) ||
        typeof proof.details !== 'object' ||
        !proofMatchesRecoveryMode ||
        !localBytesValid ||
        !localAbsenceValid ||
        !localIntendedAbsenceValid ||
        !remoteDetailsValid ||
        !remoteNotStartedValid ||
        !remoteTerminalValid
      ) {
        throw new PageWriteError(
          400,
          'invalid_reconciliation_proof',
          'The intent kind did not prove a converged or safely absent outcome',
        );
      }
      const status: 'reconciled_applied' | 'reconciled_not_applied' =
        reconciled.outcome === 'applied' ? 'reconciled_applied' : 'reconciled_not_applied';
      const settled = await client.query<{ cache_invalidation_pending: boolean }>(
        `UPDATE page_write_intents
            SET status = $2, settled_at = NOW(), settled_by = $3,
                settlement_reason = $4, settlement_proof = $5::jsonb
          WHERE id = $1 AND status = 'pending'
        RETURNING cache_invalidation_pending`,
        [
          durable.id,
          status,
          authorization.actorId,
          authorization.reason.trim(),
          JSON.stringify(proof),
        ],
      );
      if (settled.rowCount !== 1) {
        throw new PageWriteError(409, 'intent_not_pending', 'The write intent was settled concurrently');
      }
      return {
        kind: 'settled' as const,
        result: { intentId: durable.id, status },
        invalidationPending: settled.rows[0]?.cache_invalidation_pending === true,
      };
    });
  
    const inspected = await verifyAndSettle(recoveryToken);
    if (inspected.kind === 'settled') {
      localIntentEffects.delete(recoveryToken.id);
      localIntentRecoveryModes.delete(recoveryToken.id);
      localIntentFailedRemotePhases.delete(recoveryToken.id);
      if (inspected.invalidationPending) {
        await flushPageWriteInvalidations(intentId).catch(() => undefined);
      }
      return inspected.result;
    }
  
    const repairer = intentRepairers.get(discoveredIntent.kind as IntentKind);
    if (!repairer) {
      throw new PageWriteError(
        409,
        'intent_repair_unavailable',
        'The trusted local verifier found partial state but no repairer is registered',
      );
    }

    // Do not dispatch trusted repair code from an authorization decision made
    // before verification. Repair transactions repeat this guard through the
    // effect-marker and advancePageWriteIntent boundaries without holding a
    // connection across filesystem work.
    await inTransaction((client) => assertActiveRecoveryAdmin(client, authorization.actorId));
  
    // Verification completed inside this admitted recovery. Its local repair
    // is a continuation, so an intervening quiesce waits rather than aborting it.
    localIntentEffects.set(recoveryToken.id, 'succeeded');
    localIntentRecoveryModes.set(recoveryToken.id, 'local_verified');
    await runPageWriteIntentEffect(recoveryToken, { kind: 'local' }, () => repairer(recoveryToken));
    const repaired = await verifyAndSettle(recoveryToken);
    if (repaired.kind === 'repair_required') {
      throw new PageWriteError(
        409,
        'intent_repair_incomplete',
        'The trusted repair did not produce an exactly verifiable terminal state',
      );
    }
    localIntentEffects.delete(recoveryToken.id);
    localIntentRecoveryModes.delete(recoveryToken.id);
    localIntentFailedRemotePhases.delete(recoveryToken.id);
    if (repaired.invalidationPending) {
      await flushPageWriteInvalidations(recoveryToken.id).catch(() => undefined);
    }
    return repaired.result;
  } catch (error) {
    if (recoveryClaimed && localIntentEffects.has(intentId)) localIntentEffects.set(intentId, 'failed');
    if (recoveryClaimed || previousRecoveryState === 'failed') localRecoveries.set(intentId, 'failed');
    else localRecoveries.delete(intentId);
    throw error;
  } finally {
    if (localRecoveries.get(intentId) === 'running') localRecoveries.delete(intentId);
    localRecoveryAdmins.delete(intentId);
    finishLocalOperation();
  }
}

/** Admin-only routes may expose this bounded status; it never changes state. */
export async function getPageWriteRecoveryState(pageId?: number): Promise<PageWriteRecoveryState> {
  const pageFilter = pageId === undefined ? null : normalizePageIds([pageId]);
  const [intents, admissions, runtimes] = await Promise.all([
    getPool().query<IntentRow>(
      `SELECT id, runtime_id, kind, actor_id, page_ids, revisions, deleted_page_ids, recovery_mode,
              effect, effect_started_at, effect_finished_at, remote_effect_started_at, recovery_started_at,
              remote_effects_completed_at, remote_terminal_result, cache_invalidation_pending,
              recovery_history, status, created_at
         FROM page_write_intents
        WHERE status = 'pending'
          AND ($1::integer[] IS NULL OR page_ids && $1::integer[])
        ORDER BY created_at, id
        LIMIT 501`,
      [pageFilter],
    ),
    getPool().query<AdmissionRow>(
      `SELECT id, runtime_id, page_id, actor_id, lifecycle_revision::text, admitted_at, released_at
         FROM page_runtime_admissions
        WHERE released_at IS NULL
          AND ($1::integer[] IS NULL OR page_id = ANY($1::integer[]))
        ORDER BY admitted_at, id
        LIMIT 501`,
      [pageFilter],
    ),
    getPool().query<{
      runtime_id: string;
      deployment_identity: Record<string, unknown>;
      started_at: Date;
      quiesced_at: Date | null;
      quiescence_ack: string | null;
      fenced_at: Date | null;
      fence_reason: string | null;
    }>(
      `SELECT runtime_id, deployment_identity, started_at, quiesced_at,
              quiescence_ack::text, fenced_at, fence_reason
         FROM page_writer_runtimes
        WHERE runtime_id IN (
          SELECT runtime_id
            FROM page_write_intents
           WHERE status = 'pending'
             AND ($1::integer[] IS NULL OR page_ids && $1::integer[])
          UNION
          SELECT runtime_id
            FROM page_runtime_admissions
           WHERE released_at IS NULL
             AND ($1::integer[] IS NULL OR page_id = ANY($1::integer[]))
        )
        ORDER BY started_at, runtime_id
        LIMIT 501`,
      [pageFilter],
    ),
  ]);
  return {
    intents: intents.rows.slice(0, 500).map(recoveryIntentFromRow),
    admissions: admissions.rows.slice(0, 500).map((row) => ({
      id: row.id,
      runtimeId: row.runtime_id,
      pageId: row.page_id,
      actorId: row.actor_id,
      lifecycleRevision: String(row.lifecycle_revision),
      admittedAt: asIso(row.admitted_at),
    })),
    runtimes: runtimes.rows.slice(0, 500).map((row) => ({
      runtimeId: row.runtime_id,
      deploymentIdentity: publicDeploymentIdentity(row.deployment_identity),
      startedAt: asIso(row.started_at),
      quiescedAt: row.quiesced_at ? asIso(row.quiesced_at) : null,
      acknowledgmentId: row.quiescence_ack,
      fencedAt: row.fenced_at ? asIso(row.fenced_at) : null,
      fenceReason: row.fence_reason,
    })),
    truncated: {
      intents: intents.rows.length > 500,
      admissions: admissions.rows.length > 500,
      runtimes: runtimes.rows.length > 500,
    },
  };
}
