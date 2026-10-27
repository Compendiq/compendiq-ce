import type { PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { AI_POLICY_CANONICAL_LABELS, aiPolicyLabelConflict, applyCanonicalAiPolicyLabel as canonicalLabels, normalizeAiPolicyLabel as parseReservedAiPolicyLabel, type AiOperationContext, type AiPolicyChangeEvent } from '@compendiq/contracts';
import { getPool } from '../db/postgres.js';
import { exactAiPolicyRevision, safeAiPolicyRevision } from './ai-policy-revision.js';
import { isSystemAdmin, userCanAccessPage, userHasPermission } from './rbac-service.js';
import { getEnterprisePlugin } from '../enterprise/loader.js';
import { PageWriteError, withAiPolicyWriteTransaction } from './page-write-admission.js';

/**
 * Article AI policy (SPEC-CORE-001/003). `pages.ai_policy` is the single
 * authority; labels only seed it at creation and can only make it stricter.
 */
export type AiPolicy = 'all' | 'local_only' | 'none';

const RANK: Record<AiPolicy, number> = { all: 0, local_only: 1, none: 2 };

export function isAiPolicy(value: unknown): value is AiPolicy {
  return value === 'all' || value === 'local_only' || value === 'none';
}

export function stricterPolicy(a: AiPolicy, b: AiPolicy): AiPolicy {
  return RANK[a] >= RANK[b] ? a : b;
}

/** `a` is strictly more restrictive than `b`. */
export function isStricterPolicy(a: AiPolicy, b: AiPolicy): boolean {
  return RANK[a] > RANK[b];
}

/**
 * The frozen label table (SPEC-CORE-002), shared with the contracts package
 * and with SQL `ai_policy_label_value` (migration 136). Matching is
 * lowercase + trim only — no regex, no fuzzy forms. The restrictive entries
 * are what ingestion reads; `all` entries only matter to a label WRITER
 * stating an explicit relaxation (which needs policy authority).
 */
export function normalizeAiPolicyLabel(label: string): AiPolicy | null {
  const policy = parseReservedAiPolicyLabel(label);
  return policy === 'all' ? null : policy;
}

/**
 * The reserved policy labels a label WRITER understands: the ingestion table
 * plus the `all` spellings (`all-ai`, `ai:all`).
 */
export function reservedAiPolicyLabel(label: string): AiPolicy | null {
  return parseReservedAiPolicyLabel(label);
}

/** One canonical label per policy; a newly stated policy is stored as this. */
export function canonicalAiPolicyLabel(policy: AiPolicy): string {
  return AI_POLICY_CANONICAL_LABELS[policy];
}

export type LabelPolicyPlan = {
  /** The label set to store (and, for a remote page, to publish). */
  labels: string[];
  /** The policy the page must hold once these labels are stored. */
  policy: AiPolicy;
  /** How the policy moves relative to the row the plan was made from. */
  kind: 'unchanged' | 'tighten' | 'relax';
  /** A canonical label the caller tried to drop was put back. */
  restoredLabel: string | null;
};

/**
 * Plan an interactive existing-row label write from its locked authority.
 * Validate the entire target, including carried labels. A carried identity is
 * not a fresh policy command, even when its spelling is stale; repair its
 * reserved slot to the authoritative policy instead. Removal alone likewise
 * preserves policy. Every actual move still goes through the shared mutation
 * authority/revision/readiness checks. Ingestion uses its tighten-only planner.
 */
export function planLabelPolicyChange(input: {
  currentPolicy: AiPolicy;
  currentLabels: readonly string[] | null | undefined;
  targetLabels: readonly string[];
}): LabelPolicyPlan {
  const named = aiPolicyLabelConflict(input.targetLabels);
  if (named.length > 1) throw new AiPolicyLabelConflictError(named);
  const currentNamed = aiPolicyLabelConflict(input.currentLabels ?? []);
  const command = named[0];
  const policy = command !== undefined && !currentNamed.includes(command)
    ? command : input.currentPolicy;
  const kind = policy === input.currentPolicy ? 'unchanged'
    : isStricterPolicy(policy, input.currentPolicy) ? 'tighten' : 'relax';
  const canonical = canonicalAiPolicyLabel(policy);
  const labels = canonicalLabels([...new Set(input.targetLabels)], policy);
  const restoredLabel = kind === 'unchanged' && !named.includes(policy) ? canonical : null;
  return { labels, policy, kind, restoredLabel };
}

export function policyFromLabels(labels: readonly string[] | null | undefined): AiPolicy {
  let out: AiPolicy = 'all';
  for (const l of labels ?? []) {
    const p = normalizeAiPolicyLabel(l);
    if (p) out = stricterPolicy(out, p);
  }
  return out;
}

/** Advisory-lock namespace shared by policy mutations and admission. */
export const AI_POLICY_LOCK_NAMESPACE = 0x41_49_50; // 'AIP'

/**
 * Lock order (SPEC-CORE-003): runtime epoch → hierarchy SHARE → per-page
 * lifecycle → AI-policy advisory lock → `pages` row lock. A transaction that
 * will (or may) move `pages.ai_policy` takes this BEFORE its first
 * `FOR UPDATE` on the row, so it can never wait on the policy lock while
 * holding the row another policy writer waits for. Ids are taken in order.
 */
export async function lockAiPolicyForPages(client: PoolClient, pageIds: readonly number[]): Promise<void> {
  const ids = [...new Set(pageIds)].sort((a, b) => a - b);
  for (const id of ids) {
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [AI_POLICY_LOCK_NAMESPACE, id]);
  }
}

/**
 * Policy authority is independent of ordinary content-edit authority. A live
 * visible page permits its standalone owner, or an exact scoped `edit`
 * permission (including page ACEs). Standalone nonowners are not excluded
 * from the scoped-editor branch. Shared visibility alone grants nothing.
 */
export async function canMutateAiPolicy(
  userId: string,
  pageId: number,
  client: PoolClient,
): Promise<boolean> {
  const r = await client.query<{
    source: string; created_by_user_id: string | null; space_key: string | null; deleted_at: Date | null;
  }>(
    `SELECT source, created_by_user_id, space_key, deleted_at FROM pages WHERE id = $1`,
    [pageId],
  );
  const page = r.rows[0];
  if (!page || page.deleted_at) return false;
  if (await isSystemAdmin(userId, client)) return true;
  if (!(await userCanAccessPage(userId, pageId, client))) return false;
  if (page.source === 'standalone' && page.created_by_user_id === userId) return true;
  if (!page.space_key) return false;
  return userHasPermission(userId, 'edit', page.space_key, pageId, client);
}

/**
 * Policy authority for an EXPLICIT policy stated at creation, before any row
 * exists (#280 review): a standalone creator is the new owner (always
 * allowed); a Confluence create needs an edit permission in the target
 * space or system admin — a read-only role cannot choose a policy for a
 * page it may not edit. Omitted explicit policy never consults this.
 */
export async function canChoosePolicyAtCreation(
  userId: string,
  target: { source: 'standalone' | 'confluence'; spaceKey: string | null },
  client: PoolClient,
): Promise<boolean> {
  if (target.source === 'standalone') return true;
  if (await isSystemAdmin(userId, client)) return true;
  if (!target.spaceKey) return false;
  return userHasPermission(userId, 'edit', target.spaceKey, undefined, client);
}

/**
 * The frozen wire bodies of a policy refusal (contracts `AiPolicyDeniedSchema`,
 * `AiPolicyConflictSchema`, `AiPolicyLabelConflictSchema`). Carried by
 * `AiPolicyRefusalError` so a page route whose other failures go through the
 * generic `PageWriteError` serializer can still answer the policy contract.
 */
export type AiPolicyRefusalBody =
  | { error: 'ai_policy_denied'; pageIds: number[] }
  | { error: 'ai_policy_unavailable'; pageIds: number[] }
  | { error: 'ai_policy_conflict'; reason: 'stale_revision'; pageIds: number[] }
  | { error: 'ai_policy_label_conflict'; policies: AiPolicy[] }
  | { error: 'ai_policy_enforcement_unavailable'; pageIds: number[] };

export class AiPolicyRefusalError extends Error {
  readonly statusCode: number;
  readonly body: AiPolicyRefusalBody;
  constructor(statusCode: number, body: AiPolicyRefusalBody, message: string) {
    super(message);
    this.name = 'AiPolicyRefusalError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

function requireSafeAiPolicyRevision(value: unknown): number {
  const revision = safeAiPolicyRevision(value);
  if (revision === null) {
    throw new AiPolicyRefusalError(503, { error: 'ai_policy_unavailable', pageIds: [] },
      'The policy revision cannot be represented safely');
  }
  return revision;
}

/**
 * 422 `ai_policy_label_conflict` (contracts `AiPolicyLabelConflictSchema`):
 * a label set naming two different policies. Thrown by
 * `planLabelPolicyChange`, so EVERY label writer — the page create/update
 * routes, the label routes, the bulk taggers and the auto-tagger — refuses
 * the same structured body. It stays a `PageWriteError` (422,
 * `ai_policy_label_conflict`) so every existing writer and the generic
 * serializer keep working, and carries the frozen `body` the page routes'
 * refusal serializer (`sendAiPolicyRefusal`) answers verbatim.
 */
export class AiPolicyLabelConflictError extends PageWriteError {
  readonly body: Extract<AiPolicyRefusalBody, { error: 'ai_policy_label_conflict' }>;
  readonly policies: AiPolicy[];
  constructor(policies: AiPolicy[]) {
    super(
      422,
      'ai_policy_label_conflict',
      `Labels name contradictory AI policies: ${policies.map(canonicalAiPolicyLabel).join(', ')}`,
    );
    this.name = 'AiPolicyLabelConflictError';
    this.policies = [...policies];
    this.body = { error: 'ai_policy_label_conflict', policies: [...policies] };
  }
}

/** Keep lifecycle error compatibility while carrying the shared policy wire contract. */
export class AiPolicyDeniedError extends PageWriteError {
  readonly body: Extract<AiPolicyRefusalBody, { error: 'ai_policy_denied' }>;
  constructor(pageIds: number[]) {
    super(403, 'ai_policy_not_authorized', 'Not authorized to change this page\'s AI policy');
    this.name = 'AiPolicyDeniedError';
    this.body = { error: 'ai_policy_denied', pageIds: [...pageIds] };
  }
}

/** Anything a page route answers through `sendAiPolicyRefusal`. */
export type AiPolicyRefusal = AiPolicyRefusalError | AiPolicyLabelConflictError | AiPolicyDeniedError;

export function isAiPolicyRefusal(err: unknown): err is AiPolicyRefusal {
  return err instanceof AiPolicyRefusalError || err instanceof AiPolicyLabelConflictError
    || err instanceof AiPolicyDeniedError;
}

export function aiPolicyRefusalFromResult(
  result: { reason: 'stale_revision' | 'not_authorized' | 'not_found' | 'enforcement_unavailable'; pageIds: number[] },
): AiPolicyRefusalError | PageWriteError {
  switch (result.reason) {
    case 'stale_revision':
      return new AiPolicyRefusalError(409, { error: 'ai_policy_conflict', reason: 'stale_revision', pageIds: result.pageIds },
        'The page AI policy changed since you loaded it');
    case 'not_authorized':
      return new AiPolicyRefusalError(403, { error: 'ai_policy_denied', pageIds: result.pageIds },
        'Not authorized to change this page\'s AI policy');
    case 'enforcement_unavailable':
      return new AiPolicyRefusalError(409, { error: 'ai_policy_enforcement_unavailable', pageIds: result.pageIds },
        'Restrictive AI policies require the enterprise enforcement component.');
    default:
      return new PageWriteError(404, 'page_not_found', 'Page not found');
  }
}

/**
 * Foundation-only deployments (no EE enforcement hook) refuse to ACTIVATE a
 * restrictive policy: storing `local_only`/`none` without workers that honour
 * it would be a false promise. Relaxing back to `all` is always allowed.
 */
export function isAiPolicyEnforcementAvailable(): boolean {
  return getEnterprisePlugin().aiPolicyEnforcementAvailable?.() === true;
}

export type AiPolicyMutationResult =
  | { ok: true; rows: Array<{ pageId: number; policy: AiPolicy; revision: number }> }
  | {
      ok: false;
      reason: 'stale_revision' | 'not_authorized' | 'not_found' | 'enforcement_unavailable'
        | 'page_is_frozen' | 'page_write_busy';
      pageIds: number[];
    };

/**
 * Rewrite the reserved labels so exactly ONE canonical label spells the
 * policy, including `all-ai`. The contracts helper and SQL
 * `ai_policy_apply_label` share this vocabulary; ordinary labels retain order.
 */
export function applyCanonicalAiPolicyLabel(
  labels: readonly string[] | null | undefined,
  policy: AiPolicy,
): string[] {
  return canonicalLabels(labels ?? [], policy);
}

/** Mutation result records; typed evidence is persisted on the held client before COMMIT. */
export type AiPolicyChangeRecord = {
  pageId: number;
  userId: string;
  from: AiPolicy;
  to: AiPolicy;
  revision: number;
};

/**
 * THE policy mutation primitive (SPEC-CORE-003). Every writer that moves
 * `pages.ai_policy` — the policy endpoints, every label writer, and the
 * Confluence recovery reconciler — goes through this on the transaction it
 * already holds, so policy, revision and derived-state invalidation always
 * land in one commit with the caller's other row changes.
 *
 * Takes the AI-policy advisory lock (see `lockAiPolicyForPages`) and then
 * the row lock. A caller that locked the row earlier in the same transaction
 * must have taken the policy lock first.
 *
 * Authority: every actual policy move requires live visibility and
 * `canMutateAiPolicy`, in both directions. An unchanged ordinary label save
 * requires visibility only. `requireAuthority` additionally checks explicit
 * re-assertions; it is never an authorization bypass for tightening.
 *
 * Returns the prospective committed rows and change records. Typed evidence
 * is persisted on this client; callers must not emit duplicate change events.
 * Reported failures require rollback; readiness and sink failures may throw.
 */
export async function applyAiPolicyOnClient(
  client: PoolClient,
  input: {
    userId: string;
    items: ReadonlyArray<{ pageId: number; policy: AiPolicy; expectedRevision?: number }>;
    requireAuthority?: boolean;
    /** Server recovery only: verified against the durable journal, never a boolean bypass. */
    recovery?: { intentId: string; targetLabels: readonly string[] };
    /** Stable server-owned context shared by the entire mutation/cascade. */
    operation?: AiOperationContext;
  },
): Promise<
  | { ok: true; rows: Array<{ pageId: number; policy: AiPolicy; revision: number }>; changes: AiPolicyChangeRecord[] }
  | { ok: false; reason: 'stale_revision' | 'not_authorized' | 'not_found'; pageIds: number[] }
> {
  const sorted = [...input.items].sort((a, b) => a.pageId - b.pageId);
  const ids = sorted.map((i) => i.pageId);
  if (ids.length === 0) return { ok: true, rows: [], changes: [] };
  await lockAiPolicyForPages(client, ids);
  const locked = await client.query<{ id: number; ai_policy: AiPolicy; ai_policy_revision: string; labels: string[] | null }>(
    `SELECT id, ai_policy, ai_policy_revision, labels FROM pages
      WHERE id = ANY($1::int[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE`,
    [ids],
  );
  const byId = new Map(locked.rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  // Every caller must see the live row. Earlier content admission is not
  // policy authority, and tightening is not an exception to hidden-404.
  for (const id of ids) {
    if (byId.has(id) && !(await userCanAccessPage(input.userId, id, client))) missing.push(id);
  }
  if (missing.length) return { ok: false, reason: 'not_found', pageIds: missing.sort((a, b) => a - b) };
  const denied: number[] = [];
  for (const item of sorted) {
    const current = byId.get(item.pageId)!.ai_policy;
    // An ordinary label/content save may preserve a restriction without
    // policy-setter rights. Every actual policy move requires those rights.
    if ((input.requireAuthority || current !== item.policy)
      && !(await canMutateAiPolicy(input.userId, item.pageId, client))) {
      denied.push(item.pageId);
    }
  }
  if (denied.length) return { ok: false, reason: 'not_authorized', pageIds: denied };
  // Validate every output revision, including the prospective increment,
  // before any row or evidence is changed. Never round a bigint CAS token.
  for (const item of sorted) {
    const before = byId.get(item.pageId)!;
    const revision = exactAiPolicyRevision(before.ai_policy_revision);
    const increments = before.ai_policy !== item.policy || input.requireAuthority;
    if (revision === null || safeAiPolicyRevision(revision + (increments ? 1n : 0n)) === null) {
      throw new AiPolicyRefusalError(503, { error: 'ai_policy_unavailable', pageIds: [item.pageId] },
        'The policy revision cannot be represented safely');
    }
  }
  const stale = sorted
    .filter((i) => i.expectedRevision !== undefined
      && (safeAiPolicyRevision(i.expectedRevision) === null
        || exactAiPolicyRevision(byId.get(i.pageId)!.ai_policy_revision) !== exactAiPolicyRevision(i.expectedRevision)))
    .map((i) => i.pageId);
  if (stale.length) return { ok: false, reason: 'stale_revision', pageIds: stale };
  for (const item of sorted) {
    const before = byId.get(item.pageId)!;
    const kind = item.policy === before.ai_policy ? 'unchanged'
      : isStricterPolicy(item.policy, before.ai_policy) ? 'tighten' : 'relax';
    if (kind !== 'tighten' && !input.recovery) continue;
    await assertLabelPolicyChangeOnClient(client, {
      userId: input.userId, pageId: item.pageId,
      plan: {
        policy: item.policy, kind, restoredLabel: null,
        labels: input.recovery?.targetLabels
          ? [...input.recovery.targetLabels]
          : applyCanonicalAiPolicyLabel(before.labels, item.policy),
      },
      recoveryIntentId: input.recovery?.intentId,
    });
  }

  const rows: Array<{ pageId: number; policy: AiPolicy; revision: number }> = [];
  const changes: AiPolicyChangeRecord[] = [];
  const purge: number[] = [];
  const requeue: number[] = [];
  for (const item of sorted) {
    const before = byId.get(item.pageId)!;
    if (before.ai_policy === item.policy && !input.requireAuthority) {
      // Label-driven: nothing moved, so the revision (and every worker's
      // admitted binding to it) stays put.
      rows.push({ pageId: item.pageId, policy: before.ai_policy, revision: safeAiPolicyRevision(before.ai_policy_revision)! });
      continue;
    }
    // ONE statement moves the policy, its revision AND the stored labels'
    // reserved slot (#281 review: the direct setter is a label writer too —
    // the stored labels must keep telling the truth about `ai_policy`, in
    // the same commit, for every writer that reaches this primitive). Label
    // writers that store a planned set afterwards store the same canonical
    // spelling, so the two writes agree.
    const updated = await client.query<{ ai_policy: AiPolicy; ai_policy_revision: string }>(
      `UPDATE pages
          SET ai_policy = $2,
              ai_policy_revision = ai_policy_revision + 1,
              labels = $3::text[]
        WHERE id = $1 RETURNING ai_policy, ai_policy_revision`,
      [item.pageId, item.policy, applyCanonicalAiPolicyLabel(before.labels, item.policy)],
    );
    const row = updated.rows[0]!;
    const revision = requireSafeAiPolicyRevision(row.ai_policy_revision);
    rows.push({ pageId: item.pageId, policy: row.ai_policy, revision });
    changes.push({ pageId: item.pageId, userId: input.userId, from: before.ai_policy, to: row.ai_policy, revision });
    // Explicit re-assertion of `none` purges again; any other MOVE
    // (relaxation, or all → local_only) re-queues: nothing is purged for a
    // tighten that still permits SOME provider (the policy forbids future
    // external calls, not past results — SPEC-CORE-003), but every stage is
    // re-queued so the next pass is admitted against the new rule. An
    // explicit re-assertion of `all`/`local_only` (requireAuthority with the
    // same policy) bumps the revision only: finished derived state stays
    // valid under an unchanged rule, so nothing is re-queued.
    if (item.policy === 'none') purge.push(item.pageId);
    else if (before.ai_policy !== item.policy) requeue.push(item.pageId);
  }
  if (purge.length) await purgeDerivedAiState(client, purge);
  if (requeue.length) await requeueDerivedAiState(client, requeue);
  if (changes.length) {
    const event: AiPolicyChangeEvent = {
      ...(input.operation ?? {
        operationId: randomUUID(), actor: { kind: 'user', id: input.userId },
        source: 'policy_mutation', cascadeId: null,
      }),
      eventId: randomUUID(), occurredAt: new Date().toISOString(), type: 'policy_change',
      changes: changes.map((change) => ({
        pageId: change.pageId, oldPolicy: change.from, newPolicy: change.to,
        oldRevision: requireSafeAiPolicyRevision(byId.get(change.pageId)!.ai_policy_revision), newRevision: change.revision,
      })),
    };
    // Failure must propagate to the transaction owner: policy and evidence
    // must commit or roll back together on this exact client.
    await getEnterprisePlugin().persistAiPolicyChange?.(client, event);
  }
  return { ok: true, rows, changes };
}

/**
 * Label-driven policy publication on a held client: plan the label/policy
 * outcome from the LOCKED row (never from a stale pre-read), then store the
 * labels and apply the policy through `applyAiPolicyOnClient` in the same
 * statement sequence. A relaxation the actor may not perform is refused as
 * 403 `ai_policy_not_authorized`; nothing is written in that case.
 *
 * Callers that talk to a provider must run `planLabelPolicyChange` on their
 * admitted row BEFORE the remote call too (so a contradiction never reaches
 * the provider, and an unauthorized relaxation is refused before egress);
 * this function re-plans from the row it locks so a policy change between
 * admission and commit cannot be bypassed.
 */
export async function assertLabelPolicyChangeOnClient(
  client: PoolClient,
  input: { userId: string; pageId: number; plan: LabelPolicyPlan; recoveryIntentId?: string },
): Promise<void> {
  if (input.plan.kind === 'unchanged' && !input.recoveryIntentId) return;
  if (!(await userCanAccessPage(input.userId, input.pageId, client))) {
    throw new PageWriteError(404, 'page_not_found', 'Page not found');
  }
  // Content/tag permission is not policy permission, in EITHER direction.
  if (input.plan.kind !== 'unchanged' && !(await canMutateAiPolicy(input.userId, input.pageId, client))) {
    throw new AiPolicyDeniedError([input.pageId]);
  }
  if (!input.recoveryIntentId && (input.plan.kind !== 'tighten' || isAiPolicyEnforcementAvailable())) return;

  // Recovery is not a caller-supplied boolean grant. Only a pending, durably
  // acknowledged remote label operation at the original row revisions may
  // finish while rollout is closed. Ordinary writers cannot create this
  // receipt: they must pass this admission before making a remote call.
  if (input.recoveryIntentId) {
    const creation = await client.query<{
      effect: Record<string, unknown>; title: string; body_storage: string;
    }>(
      `SELECT i.effect, p.title, p.body_storage
         FROM page_write_intents i JOIN pages p ON p.id = $2
        WHERE i.id = $1 AND i.actor_id = $3 AND i.status = 'pending'
          AND i.kind = 'pages.create.confluence'
          AND i.effect->>'effectClass' = 'remote'
          AND i.remote_effect_started_at IS NOT NULL AND i.remote_effects_completed_at IS NOT NULL
          AND i.remote_terminal_result->>'accepted' = 'true'
          AND i.remote_terminal_result->>'confluenceId' = p.confluence_id
          AND i.remote_terminal_result->>'expectedVersion' = p.version::text
          AND i.effect->>'spaceKey' = p.space_key
          AND i.effect->>'parentConfluenceId' IS NOT DISTINCT FROM p.parent_id
          AND i.effect->>'initialPolicy' = $4
          AND p.source = 'confluence' AND p.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM unnest(i.page_ids) AS target(page_id)
            LEFT JOIN pages referenced ON referenced.id = target.page_id
            WHERE referenced.id IS NULL OR referenced.deleted_at IS NOT NULL
               OR i.revisions->target.page_id::text->>'contentRevision' IS DISTINCT FROM referenced.content_revision::text
               OR i.revisions->target.page_id::text->>'lifecycleRevision' IS DISTINCT FROM referenced.lifecycle_revision::text
          ) FOR SHARE OF i`,
      [input.recoveryIntentId, input.pageId, input.userId, input.plan.policy],
    );
    const created = creation.rows[0];
    const sameLabels = (value: unknown): boolean => {
      if (!Array.isArray(value) || value.some((label) => typeof label !== 'string')) return false;
      const expected = [...new Set(value as string[])].sort();
      const actual = [...new Set(input.plan.labels)].sort();
      return expected.length === actual.length && expected.every((label, index) => label === actual[index]);
    };
    if (created && typeof created.body_storage === 'string'
      && sameLabels(created.effect.initialLabels)
      && created.effect.titleSha256 === createHash('sha256').update(created.title).digest('hex')
      && created.effect.storageSha256 === createHash('sha256').update(created.body_storage).digest('hex')) return;
    const receipt = await client.query<{ target_labels: unknown }>(
      `SELECT i.effect->'targetLabels' AS target_labels
         FROM page_write_intents i JOIN pages p ON p.id = $2
        WHERE i.id = $1 AND i.actor_id = $3 AND i.status = 'pending'
          AND i.kind = ANY($4::text[]) AND i.page_ids = ARRAY[$2]::integer[]
          AND i.effect->>'effectClass' = 'remote'
          AND i.effect->>'confluenceId' = p.confluence_id
          AND i.remote_effect_started_at IS NOT NULL
          AND i.remote_effects_completed_at IS NOT NULL
          AND i.revisions->$2::text->>'contentRevision' = p.content_revision::text
          AND i.revisions->$2::text->>'lifecycleRevision' = p.lifecycle_revision::text`,
      [input.recoveryIntentId, input.pageId, input.userId,
        ['page.labels', 'pages.bulk.replace_tags', 'pages.bulk.tags', 'pages.create.labels']],
    );
    const target = receipt.rows[0]?.target_labels;
    if (Array.isArray(target) && target.every((label) => typeof label === 'string')) {
      const expected = [...new Set(target)].sort();
      const actual = [...new Set(input.plan.labels)].sort();
      if (expected.length === actual.length && expected.every((label, index) => label === actual[index])) return;
      const repair = await client.query<{ after: unknown }>(
        `SELECT r.plan->'after' AS after FROM page_label_canonical_repairs r
          JOIN page_write_intents i ON i.id = r.intent_id JOIN pages p ON p.id = $2
         WHERE r.intent_id = $1 AND r.completed_at IS NOT NULL AND NOT r.in_flight
           AND r.plan->'before' = to_jsonb(ARRAY(SELECT DISTINCT jsonb_array_elements_text(i.effect->'targetLabels') ORDER BY 1))
           AND r.plan->>'policy' = p.ai_policy AND p.ai_policy = $3
           AND r.plan->>'policyRevision' = p.ai_policy_revision::text
           AND NOT (i.effect ? 'autoTagStage')`,
        [input.recoveryIntentId, input.pageId, input.plan.policy]);
      if (input.plan.kind === 'unchanged' && sameLabels(repair.rows[0]?.after)) return;
      throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'The label target no longer matches the policy publication');
    }
    if (input.plan.kind === 'tighten' && !isAiPolicyEnforcementAvailable()) {
      throw aiPolicyRefusalFromResult({ reason: 'enforcement_unavailable', pageIds: [input.pageId] });
    }
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Policy publication does not match its pending journal');
  }
  throw aiPolicyRefusalFromResult({ reason: 'enforcement_unavailable', pageIds: [input.pageId] });
}

export async function applyPageLabelsOnClient(
  client: PoolClient,
  input: { userId: string; pageId: number; targetLabels: readonly string[]; recoveryIntentId?: string },
): Promise<{ labels: string[]; policy: AiPolicy; revision: number; plan: LabelPolicyPlan; changes: AiPolicyChangeRecord[] }> {
  await lockAiPolicyForPages(client, [input.pageId]);
  const locked = await client.query<{ ai_policy: AiPolicy; ai_policy_revision: string; labels: string[] | null }>(
    `SELECT ai_policy, ai_policy_revision, labels FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [input.pageId],
  );
  const row = locked.rows[0];
  if (!row) throw new PageWriteError(404, 'page_not_found', 'Page not found');
  const plan = planLabelPolicyChange({
    currentPolicy: row.ai_policy,
    currentLabels: row.labels,
    targetLabels: input.targetLabels,
  });
  await assertLabelPolicyChangeOnClient(client, { ...input, plan });
  const applied = await applyAiPolicyOnClient(client, {
    userId: input.userId,
    items: [{ pageId: input.pageId, policy: plan.policy, expectedRevision: requireSafeAiPolicyRevision(row.ai_policy_revision) }],
    ...(input.recoveryIntentId ? { recovery: { intentId: input.recoveryIntentId, targetLabels: plan.labels } } : {}),
  });
  if (!applied.ok) {
    if (applied.reason === 'not_authorized') throw new AiPolicyDeniedError(applied.pageIds);
    throw aiPolicyRefusalFromResult(applied);
  }
  await client.query('UPDATE pages SET labels = $2 WHERE id = $1', [input.pageId, plan.labels]);
  return {
    labels: plan.labels,
    policy: applied.rows[0]!.policy,
    revision: applied.rows[0]!.revision,
    plan,
    changes: applied.changes,
  };
}

/**
 * All-or-nothing update of one or more pages. Rows are locked in id order;
 * any missing, unauthorized or stale row rolls the whole request back.
 */
export async function updatePageAiPolicies(
  userId: string,
  policy: AiPolicy,
  items: Array<{ pageId: number; expectedRevision: number }>,
): Promise<AiPolicyMutationResult> {
  if (policy !== 'all' && !isAiPolicyEnforcementAvailable()) {
    return { ok: false, reason: 'enforcement_unavailable', pageIds: items.map((i) => i.pageId) };
  }
  const ids = [...new Set(items.map((i) => i.pageId))].sort((a, b) => a - b);
  if (ids.length === 0) return { ok: true, rows: [] };

  // Hidden-404 precedence: a page the caller cannot see answers like a
  // missing one BEFORE any lifecycle/intent state could leak as 423/409.
  // The authoritative check is repeated under the lock by the primitive.
  const live = await getPool().query<{ id: number }>(
    'SELECT id FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL',
    [ids],
  );
  const liveIds = new Set(live.rows.map((r) => r.id));
  const hidden: number[] = [];
  for (const id of ids) {
    if (!liveIds.has(id) || !(await userCanAccessPage(userId, id))) hidden.push(id);
  }
  if (hidden.length) return { ok: false, reason: 'not_found', pageIds: hidden };

  // #281 review (direct-setter authority): the explicit policy endpoints run
  // under the SAME page-write fence as every other label writer
  // (`withAiPolicyWriteTransaction`: runtime epoch → hierarchy SHARE → lifecycle
  // locks → frozen check → no pending external intent on the row) BEFORE the
  // AI-policy lock, so a row with an unresolved Confluence write answers 409
  // `page_write_busy` and a frozen row 423 `page_is_frozen`, instead of a
  // label mirror settling later that contradicts the new policy. The
  // canonical label lands in the primitive's own UPDATE; `content_revision`
  // moves so an admitted-but-unsettled content/label writer observes it.
  try {
    const committed = await withAiPolicyWriteTransaction(ids, async (client) => {
      const result = await applyAiPolicyOnClient(client, {
        userId,
        items: items.map((i) => ({ pageId: i.pageId, policy, expectedRevision: i.expectedRevision })),
        requireAuthority: true,
      });
      if (!result.ok) throw new AiPolicyMutationRollback(result);
      await client.query(
        'UPDATE pages SET content_revision = content_revision + 1 WHERE id = ANY($1::int[])',
        [ids],
      );
      return result;
    });
    return { ok: true, rows: committed.rows };
  } catch (err) {
    if (err instanceof AiPolicyMutationRollback) return err.result;
    if (err instanceof PageWriteError) {
      if (err.reason === 'page_is_frozen') return { ok: false, reason: 'page_is_frozen', pageIds: ids };
      if (err.reason === 'page_write_busy') return { ok: false, reason: 'page_write_busy', pageIds: ids };
      if (err.reason === 'page_not_found') return { ok: false, reason: 'not_found', pageIds: ids };
    }
    throw err;
  }
}

/** Internal: unwinds the write fence with a reported (not thrown) refusal. */
class AiPolicyMutationRollback extends Error {
  constructor(readonly result: Extract<AiPolicyMutationResult, { ok: false }>) {
    super('ai policy mutation rolled back');
    this.name = 'AiPolicyMutationRollback';
  }
}

/**
 * SPEC-WORK-001 — a page set to `none` keeps its authored content (body,
 * attachments, versions, FTS) and loses every AI-derived artefact in the
 * SAME transaction as the policy write: vectors (live and shadow), the
 * materialized averages, summary, quality scores and image-analysis
 * payloads. Each stage is left `policy_blocked` with `policy_none` recorded,
 * so no worker re-queues it and status surfaces count it apart from work and
 * from failure. The dirty flags are left raised on purpose: relaxation only
 * has to clear the block for the next pass to pick the page up.
 */
export async function purgeDerivedAiState(client: PoolClient, ids: number[]): Promise<void> {
  await client.query(`DELETE FROM page_embeddings WHERE page_id = ANY($1::int[])`, [ids]);
  // Similarity edges are a persisted derivative of the vectors just deleted;
  // label/link edges are authored facts and stay.
  await client.query(
    `DELETE FROM page_relationships
      WHERE relationship_type = 'embedding_similarity'
        AND (page_id_1 = ANY($1::int[]) OR page_id_2 = ANY($1::int[]))`,
    [ids],
  );
  const shadow = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'pages' AND column_name = 'page_avg_embedding_next'
     ) AS present`,
  );
  const shadowSet = shadow.rows[0]?.present ? `, page_avg_embedding_next = NULL` : '';
  await client.query(
    `UPDATE pages
        SET page_avg_embedding = NULL${shadowSet},
            embedding_status = 'policy_blocked', embedding_error = NULL, embedded_at = NULL,
            summary_text = NULL, summary_html = NULL, summary_status = 'policy_blocked',
            summary_error = NULL, summary_content_hash = NULL, summary_generated_at = NULL,
            summary_model = NULL, summary_retry_count = 0,
            quality_score = NULL, quality_completeness = NULL, quality_clarity = NULL,
            quality_structure = NULL, quality_accuracy = NULL, quality_readability = NULL,
            quality_summary = NULL, quality_status = 'policy_blocked', quality_error = NULL,
            quality_retry_count = 0, quality_analyzed_at = NULL,
            ai_policy_block_reason = 'policy_none',
            image_analysis_revision = image_analysis_revision + 1
      WHERE id = ANY($1::int[])`,
    [ids],
  );
  await client.query(
    `UPDATE page_image_analyses
        SET status = 'policy_blocked', payload = NULL, attempts = 0, next_attempt_at = NULL,
            error = NULL, ai_policy_block_reason = 'policy_none', updated_at = NOW()
      WHERE page_id = ANY($1::int[])`,
    [ids],
  );
}

/**
 * `purgeDerivedAiState` in its own transaction, for an ingestion path whose
 * label-driven tighten landed a page on `none` outside `updatePageAiPolicies`
 * (Confluence sync's upsert). Takes the same exclusive per-page lock the
 * policy write takes, so a worker's shared admission read cannot interleave.
 */
export async function purgeDerivedAiStateForPages(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await lockAiPolicyForPages(client, ids);
    await purgeDerivedAiState(client, ids);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Relaxation (or a tightening that still permits SOME provider): clear every
 * block, flip the blocked stages back to their queued state and raise the
 * dirty flags so each worker re-admits the page against the new policy on
 * its next pass. Nothing is generated here — admission at dispatch decides.
 */
export async function requeueDerivedAiState(client: PoolClient, ids: number[]): Promise<void> {
  await client.query(
    `UPDATE pages
        SET ai_policy_block_reason = NULL,
            embedding_dirty = TRUE,
            embedding_status = CASE WHEN embedding_status = 'policy_blocked' THEN 'not_embedded' ELSE embedding_status END,
            summary_status = CASE WHEN summary_status = 'policy_blocked' THEN 'pending' ELSE summary_status END,
            quality_status = CASE WHEN quality_status = 'policy_blocked' THEN 'pending' ELSE quality_status END,
            image_analysis_dirty = TRUE
      WHERE id = ANY($1::int[])`,
    [ids],
  );
  await client.query(
    `UPDATE page_image_analyses
        SET status = 'pending', ai_policy_block_reason = NULL, updated_at = NOW()
      WHERE page_id = ANY($1::int[]) AND status = 'policy_blocked'`,
    [ids],
  );
}

/**
 * Interactive creation: stricter of the EE/CE creation default and the
 * labels. An explicit choice is honoured only when the creator holds policy
 * authority (always true for a new owner) and enforcement is available for
 * restrictive values; it still never drops below the labels.
 */
export async function resolveCreationAiPolicy(input: {
  userId: string;
  spaceKey: string | null;
  labels: readonly string[] | undefined;
  explicit?: AiPolicy;
  /** Interactive creation must refuse a restriction before any local or remote effect.
   * Ingestion resolves a tighten-only candidate separately from its publication fence. */
  mode?: 'ingestion';
}): Promise<AiPolicy> {
  if (input.mode !== 'ingestion') {
    const named = new Set((input.labels ?? []).map(reservedAiPolicyLabel).filter((p): p is AiPolicy => p !== null));
    if (input.explicit !== undefined) named.add(input.explicit);
    if (named.size > 1) throw new AiPolicyLabelConflictError([...named]);
  }
  const hook = getEnterprisePlugin().resolveAiPolicyCreationDefault;
  const raw = hook ? await hook({ userId: input.userId, spaceKey: input.spaceKey }) : 'all';
  const hookDefault: AiPolicy = isAiPolicy(raw) ? raw : 'none';
  const fromLabels = policyFromLabels(input.labels);
  const policy = stricterPolicy(input.explicit ?? hookDefault, fromLabels);
  if (input.mode !== 'ingestion' && policy !== 'all' && !isAiPolicyEnforcementAvailable()) {
    throw aiPolicyRefusalFromResult({ reason: 'enforcement_unavailable', pageIds: [] });
  }
  return policy;
}
