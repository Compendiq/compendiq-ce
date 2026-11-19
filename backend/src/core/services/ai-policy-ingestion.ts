import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { AI_POLICY_LABEL_SYNONYMS } from '@compendiq/contracts';
import {
  applyCanonicalAiPolicyLabel,
  canMutateAiPolicy,
  isAiPolicy,
  isAiPolicyEnforcementAvailable,
  isStricterPolicy,
  planLabelPolicyChange,
  policyFromLabels,
  resolveCreationAiPolicy,
  stricterPolicy,
  type AiPolicy,
} from './ai-policy-service.js';
import { PageWriteError } from './page-write-admission.js';

/**
 * Ingestion policy helpers (SPEC-WORK-002).
 *
 * Every ingestion creation path (Confluence sync and bulk refresh, Notion
 * import, other imports) resolves a NEW row's policy through the
 * SPEC-CORE-002 creation-default hook and takes the stricter of that default
 * and the incoming labels. An EXISTING row is tighten-only: re-ingestion may
 * raise its policy from labels but never lowers it.
 */
export async function resolveIngestionAiPolicy(input: {
  userId: string;
  spaceKey: string | null;
  labels: readonly string[] | null | undefined;
}): Promise<AiPolicy> {
  // `explicit` is never passed: an ingestion source cannot choose a policy,
  // it can only contribute labels.
  return resolveCreationAiPolicy({
    userId: input.userId,
    spaceKey: input.spaceKey,
    labels: input.labels ?? [],
    mode: 'ingestion',
  });
}

/** In-memory form of the tighten-only rule for an existing row. */
export function tightenExistingAiPolicy(
  current: AiPolicy,
  incomingLabels: readonly string[] | null | undefined,
): AiPolicy {
  return stricterPolicy(current, policyFromLabels(incomingLabels));
}

/**
 * Publication admission, not planning. Call on the transaction holding the
 * target row before any write. Closed rollout defers the entire snapshot;
 * it must never store a restrictive label beside an unchanged `all` policy.
 * The source snapshot remains retryable (Confluence holds its cursor; Notion
 * reports a failed item). Only the journal validator below may supply recovery
 * authority, and only for the exact snapshot it validated.
 */
export function admitAutomaticIngestionPolicy(input: {
  identity: string;
  currentPolicy: AiPolicy;
  candidate: AiPolicy;
}): AiPolicy {
  if (!isAiPolicy(input.currentPolicy) || !isAiPolicy(input.candidate)) {
    throw new PageWriteError(503, 'ai_policy_unavailable', 'The ingestion policy is unavailable');
  }
  const policy = stricterPolicy(input.currentPolicy, input.candidate);
  if (isStricterPolicy(policy, input.currentPolicy) && !isAiPolicyEnforcementAvailable()) {
    throw new FreshPublicationDeferredError(input.identity, 'ai_policy_enforcement_unavailable');
  }
  return policy;
}

// ─────────────────────────────────────────────────────────────────────────
//  First-publication fence (#281)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Read the admitted first-publication policy from a durable
 * `pages.create.confluence` effect. Malformed values are refused (409)
 * rather than defaulted: a create whose policy statement cannot be trusted
 * is not published at `all`. Shared by the create reconciler and the sync
 * walker's fence (this module has no dependency on either).
 */
export function initialPolicyFromEffect(effect: Record<string, unknown>): {
  initialPolicy: AiPolicy | undefined;
  initialLabels: string[] | undefined;
} {
  const rawPolicy = effect.initialPolicy;
  const rawLabels = effect.initialLabels;
  if (rawPolicy === undefined && rawLabels === undefined) {
    return { initialPolicy: undefined, initialLabels: undefined };
  }
  if (!isAiPolicy(rawPolicy)) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'The initial AI policy is invalid');
  }
  if (!Array.isArray(rawLabels) || rawLabels.some((label) => typeof label !== 'string')) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'The initial labels are invalid');
  }
  // Never looser than its own labels, even if the effect was edited.
  const planned = planLabelPolicyChange({ currentPolicy: 'all', currentLabels: [], targetLabels: rawLabels });
  const initialPolicy = stricterPolicy(rawPolicy, planned.policy);
  return { initialPolicy, initialLabels: applyCanonicalAiPolicyLabel(rawLabels, initialPolicy) };
}

/**
 * The policy a NOT-YET-BOUND create is assumed to carry for fencing
 * purposes. Unreadable/absent metadata is `none` (the strictest): an
 * unknown statement never infers `all`.
 */
export function fencePolicyOfEffect(effect: Record<string, unknown>): { policy: AiPolicy; labels: string[] } {
  try {
    const decoded = initialPolicyFromEffect(effect);
    if (decoded.initialPolicy === undefined) return { policy: 'none', labels: [] };
    return { policy: decoded.initialPolicy, labels: decoded.initialLabels ?? [] };
  } catch {
    return { policy: 'none', labels: [] };
  }
}

/**
 * TS twin of the per-row create clause of `FRESH_PUBLICATION_FENCE_ACTIVE_SQL`:
 * a dispatched pending create holds the global fence while its identity is
 * not validly bound AND its durable statement is not a clean `all`. Tests
 * run both forms over the same stored metadata to prove they agree.
 */
export function createIntentHoldsFence(row: {
  effect: Record<string, unknown>;
  remote_terminal_result: Record<string, unknown> | null;
  remote_effects_completed_at: Date | string | null;
}): boolean {
  if (boundConfluenceId(row.remote_terminal_result, row.remote_effects_completed_at) !== null) return false;
  return fencePolicyOfEffect(row.effect).policy !== 'all';
}

/**
 * A usable, VALIDATED acknowledged identity. Mirrors the receipt rules the
 * create reconciler enforces before it trusts a terminal result
 * (`confirmPagePublication` in the ordinary reconciler, which this module
 * cannot import without a cycle): the remote phase must be durably
 * completed, the receipt must be an explicit acceptance carrying a
 * verifiable version, and any observed identity/version it carries must
 * agree with the command identity. A non-empty id with `accepted: false`,
 * `expectedVersion: 0`, a conflicting observed id or no completion
 * timestamp is NOT a binding: such metadata stays globally unbound so the
 * fence keeps holding, exactly as recovery would refuse it (#281).
 */
export function boundConfluenceId(
  terminal: Record<string, unknown> | null | undefined,
  remoteEffectsCompletedAt: Date | string | null | undefined,
): string | null {
  if (remoteEffectsCompletedAt === null || remoteEffectsCompletedAt === undefined) return null;
  if (!terminal || typeof terminal !== 'object') return null;
  const id = terminal.confluenceId;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (terminal.accepted !== true) return null;
  const expectedVersion = terminal.expectedVersion;
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return null;
  }
  if (terminal.observedConfluenceId !== undefined && terminal.observedConfluenceId !== id) return null;
  if (terminal.version !== undefined && terminal.version !== expectedVersion) return null;
  return id;
}

/**
 * SQL form of `boundConfluenceId` for a `page_write_intents` row aliased `i`.
 * TRUE only for a validated binding; NULL/malformed receipts coalesce to
 * FALSE so three-valued logic can never drop an unbound row from the fence.
 */
const BOUND_CONFLUENCE_ID_SQL = `COALESCE(
  i.remote_effects_completed_at IS NOT NULL
  AND jsonb_typeof(i.remote_terminal_result -> 'confluenceId') = 'string'
  AND length(i.remote_terminal_result ->> 'confluenceId') > 0
  AND i.remote_terminal_result -> 'accepted' = 'true'::jsonb
  -- expectedVersion: a JSON number that is a safe positive integer. Compared
  -- numerically (never by text pattern) so "1.0"/"1e0" decode as TS does.
  AND jsonb_typeof(i.remote_terminal_result -> 'expectedVersion') = 'number'
  AND (i.remote_terminal_result ->> 'expectedVersion')::numeric >= 1
  AND (i.remote_terminal_result ->> 'expectedVersion')::numeric <= 9007199254740991
  AND (i.remote_terminal_result ->> 'expectedVersion')::numeric = trunc((i.remote_terminal_result ->> 'expectedVersion')::numeric)
  -- observedConfluenceId: absent (missing key) or a JSON STRING equal to the
  -- command id. JSON null, a number spelling the same digits, or any other
  -- type is NOT a match (strict TS inequality), so it stays unbound.
  AND (i.remote_terminal_result -> 'observedConfluenceId' IS NULL
       OR (jsonb_typeof(i.remote_terminal_result -> 'observedConfluenceId') = 'string'
           AND i.remote_terminal_result ->> 'observedConfluenceId' = i.remote_terminal_result ->> 'confluenceId'))
  -- version: absent or a JSON NUMBER numerically equal to expectedVersion.
  AND (i.remote_terminal_result -> 'version' IS NULL
       OR (jsonb_typeof(i.remote_terminal_result -> 'version') = 'number'
           AND (i.remote_terminal_result ->> 'version')::numeric = (i.remote_terminal_result ->> 'expectedVersion')::numeric)),
  FALSE
)`;

/**
 * Every code point JavaScript's `String.prototype.trim` strips (WhiteSpace +
 * LineTerminator, ECMA-262). SQL `btrim` strips only U+0020 by default, so
 * the cursor predicate must trim with THIS class to decode a label exactly
 * as the shared normalizer (`label.trim().toLowerCase()`) does.
 */
export const JS_TRIM_CODE_POINTS: readonly number[] = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

/** PostgreSQL `E'...'` literal holding the trim class as a regex bracket body. */
const JS_TRIM_CLASS_SQL = `E'${JS_TRIM_CODE_POINTS.map((cp) => `\\u${cp.toString(16).padStart(4, '0')}`).join('')}'`;

/** `regexp_replace(<expr>, ...)` that trims exactly the characters JS `trim` trims. */
export function JS_TRIM_SQL(expr: string): string {
  return `regexp_replace(${expr}, '^[' || ${JS_TRIM_CLASS_SQL} || ']+|[' || ${JS_TRIM_CLASS_SQL} || ']+$', '', 'g')`;
}

/**
 * SQL form of `fencePolicyOfEffect(effect).policy = 'all'` for a row aliased
 * `i`: an effect is inert for the fence ONLY when its policy is a valid
 * explicit `all` AND its labels are a valid string array naming no
 * restrictive policy. The restrictive spellings are the frozen TS synonym
 * table (`AI_POLICY_LABEL_SYNONYMS`, lowercase + trim only) — NOT
 * `ai_policy_from_labels`, whose regex normalizer admits a different set —
 * so the cursor predicate decodes exactly as `initialPolicyFromEffect`.
 * Trimming uses the JS `trim` whitespace class (`JS_TRIM_SQL`), not SQL
 * `btrim`'s space-only default: `'no-ai\t'` is restrictive for both.
 * Anything else (absent, malformed, restrictive labels next to `all`)
 * holds the fence, exactly as fresh-row admission would.
 */
const RESTRICTIVE_LABEL_SPELLINGS_SQL = Object.entries(AI_POLICY_LABEL_SYNONYMS)
  .filter(([, policy]) => policy !== 'all')
  .map(([label]) => `'${label.replace(/'/g, "''")}'`)
  .join(', ');

const EFFECT_STATES_ALL_SQL = `COALESCE(
  i.effect ->> 'initialPolicy' = 'all'
  AND jsonb_typeof(i.effect -> 'initialLabels') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(i.effect -> 'initialLabels') AS l
     WHERE jsonb_typeof(l) <> 'string'
        OR lower(${JS_TRIM_SQL(`l #>> '{}'`)}) IN (${RESTRICTIVE_LABEL_SPELLINGS_SQL})
  ),
  FALSE
)`;

/**
 * SQL predicate (no parameters) that is TRUE while a GLOBAL unknown-identity
 * fence is active: a dispatched, still-pending outbound creation whose
 * remote identity is not durably bound. Two durable authorities feed it:
 *
 *   * `pages.create.confluence` intents whose remote phase started and whose
 *     terminal result carries no usable `confluenceId`, unless the creator
 *     explicitly stated `all` (then no fresh import can be looser than it);
 *   * outbound `page.relocate` intents (`page_relocation_preparations`
 *     direction `to_confluence`) whose remote phase started and whose
 *     `created_confluence_id` is not yet recorded.
 *
 * The scope is deliberately global: Confluence lets a visible page move to
 * another space before a withheld/lost acknowledgment arrives, so neither
 * space, title, creator nor endpoint identifies the unknown result. The sync
 * walker embeds this into its `spaces.last_synced` UPDATE so the shared
 * cursor cannot advance past a page another principal may see.
 */
export const FRESH_PUBLICATION_FENCE_ACTIVE_SQL = `(
  EXISTS (
    SELECT 1 FROM page_write_intents i
     WHERE i.status = 'pending'
       AND i.kind = 'pages.create.confluence'
       AND i.remote_effect_started_at IS NOT NULL
       -- Unbound = no VALIDATED receipt (same rules as boundConfluenceId /
       -- the create reconciler): a lost reply, a non-accepted or
       -- version-less receipt or a conflicting observed id all hold.
       AND NOT ${BOUND_CONFLUENCE_ID_SQL}
       -- Inert only for a valid explicit 'all' with no restrictive label
       -- (same decoding as initialPolicyFromEffect / fencePolicyOfEffect).
       AND NOT ${EFFECT_STATES_ALL_SQL}
  )
  OR EXISTS (
    SELECT 1 FROM page_write_intents i
      JOIN page_relocation_preparations p ON p.intent_id = i.id
     WHERE i.status = 'pending'
       AND i.kind = 'page.relocate'
       AND p.direction = 'to_confluence'
       AND i.remote_effect_started_at IS NOT NULL
       AND p.created_confluence_id IS NULL
  )
)`;

/** A fresh Confluence import that must wait for durable publication authority. */
export class FreshPublicationDeferredError extends Error {
  readonly confluenceId: string;
  readonly reason: 'unbound_create' | 'bound_relocation' | 'unbound_relocation' | 'ai_policy_enforcement_unavailable';
  constructor(confluenceId: string, reason: FreshPublicationDeferredError['reason']) {
    super(`Fresh publication of Confluence page ${confluenceId} deferred: ${reason}`);
    this.name = 'FreshPublicationDeferredError';
    this.confluenceId = confluenceId;
    this.reason = reason;
  }
}

/**
 * Decide, on the transaction that will INSERT a FRESH Confluence row, whether
 * that row may be published and at which policy. Call it AFTER the upstream
 * page snapshot and immediately before the publication statement — never
 * from a cached negative check taken before upstream I/O: an intent's
 * remote phase is marked durable before its HTTP dispatch, so a page that
 * exists in the snapshot is always visible here as dispatched.
 *
 *   * Dispatched create with NO bound identity: if its (trusted, or unreadable
 *     → `none`) policy is stricter than the row's independently resolved
 *     ingestion policy, the import is deferred — in EVERY space, for EVERY
 *     creator — until the acknowledgment binds an exact id. The unbound
 *     policy is never assigned to an unrelated row.
 *   * Dispatched create bound to EXACTLY this `confluence_id`: the row is
 *     seeded at the stricter of its trusted initial policy and the ingestion
 *     policy, with the creator's canonical labels. Other bound ids are inert.
 *   * Outbound relocation with no bound id: every fresh import is deferred
 *     (a duplicate row for the relocating article cannot be told apart). A
 *     relocation bound to this exact id: deferred until the relocation
 *     publishes its EXISTING authoritative row (no duplicate, no snapshot).
 *
 * The caller's transaction must not span network inference; this reads the
 * journals only. There is no timeout and no fabricated identity: a lost
 * acknowledgment holds weaker fresh imports until an operator settles it.
 */
export async function admitFreshConfluencePublication(
  client: PoolClient,
  input: {
    confluenceId: string; resolvedPolicy: AiPolicy; labels: readonly string[];
    /** Server-fetched snapshot, never request metadata. Required to borrow a journal policy. */
    snapshot?: { spaceKey: string; parentId: string | null; title: string; storage: string; version: number };
  },
): Promise<{ policy: AiPolicy; labels: string[] }> {
  // A supplied candidate is not authority to weaken the upstream snapshot.
  // Refuse malformed candidates before reading journals or producing a plan.
  if (!isAiPolicy(input.resolvedPolicy)) {
    throw new PageWriteError(503, 'ai_policy_unavailable', 'The creation policy is unavailable');
  }
  const upstreamPolicy = stricterPolicy(input.resolvedPolicy, policyFromLabels(input.labels));
  const relocations = await client.query<{ created_confluence_id: string | null }>(
    `SELECT p.created_confluence_id
       FROM page_write_intents i
       JOIN page_relocation_preparations p ON p.intent_id = i.id
      WHERE i.status = 'pending'
        AND i.kind = 'page.relocate'
        AND p.direction = 'to_confluence'
        AND i.remote_effect_started_at IS NOT NULL`,
  );
  for (const row of relocations.rows) {
    if (row.created_confluence_id === null) {
      throw new FreshPublicationDeferredError(input.confluenceId, 'unbound_relocation');
    }
    if (row.created_confluence_id === input.confluenceId) {
      throw new FreshPublicationDeferredError(input.confluenceId, 'bound_relocation');
    }
  }

  const creates = await client.query<{
    effect: Record<string, unknown>;
    remote_terminal_result: Record<string, unknown> | null;
    remote_effects_completed_at: Date | null;
    authority_valid: boolean;
    actor_id: string;
    page_ids: number[];
  }>(
    `SELECT i.effect, i.remote_terminal_result, i.remote_effects_completed_at, i.actor_id, i.page_ids,
            (EXISTS (SELECT 1 FROM users u WHERE u.id = i.actor_id AND u.deactivated_at IS NULL)
             AND i.effect->>'effectClass' = 'remote'
             AND NOT EXISTS (
               SELECT 1 FROM unnest(i.page_ids) AS target(page_id)
               LEFT JOIN pages p ON p.id = target.page_id
               WHERE p.id IS NULL OR p.deleted_at IS NOT NULL
                  OR i.revisions->target.page_id::text->>'contentRevision' IS DISTINCT FROM p.content_revision::text
                  OR i.revisions->target.page_id::text->>'lifecycleRevision' IS DISTINCT FROM p.lifecycle_revision::text
             )) AS authority_valid
       FROM page_write_intents i
      WHERE i.status = 'pending'
        AND i.kind = 'pages.create.confluence'
        AND i.remote_effect_started_at IS NOT NULL
      FOR SHARE OF i`,
  );
  let policy = upstreamPolicy;
  let recoveredPolicy: AiPolicy = 'all';
  const labels = [...input.labels];
  for (const row of creates.rows) {
    const bound = boundConfluenceId(row.remote_terminal_result, row.remote_effects_completed_at);
    const stated = fencePolicyOfEffect(row.effect);
    if (bound === null) {
      if (isStricterPolicy(stated.policy, input.resolvedPolicy)) {
        throw new FreshPublicationDeferredError(input.confluenceId, 'unbound_create');
      }
      continue;
    }
    if (bound !== input.confluenceId) continue;
    // The restrictive fallback is a fence, not a recorded authorization.
    // Legacy or unreadable policy metadata must never become permission to
    // publish `none` while activation is closed merely because the ID binds.
    let decoded: ReturnType<typeof initialPolicyFromEffect>;
    try {
      decoded = initialPolicyFromEffect(row.effect);
    } catch {
      throw new FreshPublicationDeferredError(input.confluenceId, 'unbound_create');
    }
    if (decoded.initialPolicy === undefined) {
      throw new FreshPublicationDeferredError(input.confluenceId, 'unbound_create');
    }
    const snapshot = input.snapshot;
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    if (!snapshot || row.authority_valid !== true
      || row.remote_terminal_result?.expectedVersion !== snapshot.version
      || row.effect.spaceKey !== snapshot.spaceKey
      || row.effect.parentConfluenceId !== snapshot.parentId
      || row.effect.titleSha256 !== digest(snapshot.title)
      || row.effect.storageSha256 !== digest(snapshot.storage)) {
      throw new FreshPublicationDeferredError(input.confluenceId, 'unbound_create');
    }
    // Content/lifecycle revisions do not change when an ACE or role changes.
    // A still-live actor and matching revisions are not policy authority.
    for (const pageId of row.page_ids) {
      if (!(await canMutateAiPolicy(row.actor_id, pageId, client))) {
        throw new FreshPublicationDeferredError(input.confluenceId, 'unbound_create');
      }
    }
    recoveredPolicy = stricterPolicy(recoveredPolicy, stated.policy);
    policy = stricterPolicy(policy, stated.policy);
    for (const label of stated.labels) if (!labels.includes(label)) labels.push(label);
  }
  // Planning is not rollout admission. Do not import a restriction as `all`,
  // discard its labels, or advance the sync cursor past it. The caller handles
  // this as a deferred publication and retries the upstream snapshot later.
  // A validated journal may finish its already dispatched restriction, but
  // cannot authorize a stricter upstream/default policy than it recorded.
  admitAutomaticIngestionPolicy({ identity: input.confluenceId, currentPolicy: recoveredPolicy, candidate: policy });
  return { policy, labels: applyCanonicalAiPolicyLabel(labels, policy) };
}
