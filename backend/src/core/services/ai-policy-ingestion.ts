import type { PoolClient } from 'pg';
import { AI_POLICY_LABEL_SYNONYMS } from '@compendiq/contracts';
import {
  isAiPolicy,
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
 * SQL expression evaluating to the stricter of `currentExpr` and the policy
 * derived from `labelsExpr` (both SQL fragments supplied by trusted code,
 * never by user input). Uses the migration-135 functions; never relaxes.
 */
export function TIGHTEN_ONLY_POLICY_SQL(currentExpr: string, labelsExpr: string): string {
  return `CASE WHEN ai_policy_rank(ai_policy_from_labels(${labelsExpr})) > ai_policy_rank(${currentExpr})
            THEN ai_policy_from_labels(${labelsExpr}) ELSE ${currentExpr} END`;
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
  return { initialPolicy: stricterPolicy(rawPolicy, planned.policy), initialLabels: planned.labels };
}

/**
 * The policy a NOT-YET-BOUND create is assumed to carry for fencing
 * purposes. Unreadable/absent metadata is `none` (the strictest): an
 * unknown statement never infers `all`.
 */
function fencePolicyOfEffect(effect: Record<string, unknown>): { policy: AiPolicy; labels: string[] } {
  try {
    const decoded = initialPolicyFromEffect(effect);
    if (decoded.initialPolicy === undefined) return { policy: 'none', labels: [] };
    return { policy: decoded.initialPolicy, labels: decoded.initialLabels ?? [] };
  } catch {
    return { policy: 'none', labels: [] };
  }
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
  AND jsonb_typeof(i.remote_terminal_result -> 'expectedVersion') = 'number'
  AND (i.remote_terminal_result ->> 'expectedVersion') ~ '^[0-9]+$'
  AND (i.remote_terminal_result ->> 'expectedVersion')::numeric >= 1
  AND (i.remote_terminal_result ->> 'expectedVersion')::numeric <= 9007199254740991
  AND (i.remote_terminal_result -> 'observedConfluenceId' IS NULL
       OR i.remote_terminal_result ->> 'observedConfluenceId' = i.remote_terminal_result ->> 'confluenceId')
  AND (i.remote_terminal_result -> 'version' IS NULL
       OR (jsonb_typeof(i.remote_terminal_result -> 'version') = 'number'
           AND i.remote_terminal_result -> 'version' = i.remote_terminal_result -> 'expectedVersion')),
  FALSE
)`;

/**
 * SQL form of `fencePolicyOfEffect(effect).policy = 'all'` for a row aliased
 * `i`: an effect is inert for the fence ONLY when its policy is a valid
 * explicit `all` AND its labels are a valid string array naming no
 * restrictive policy. The restrictive spellings are the frozen TS synonym
 * table (`AI_POLICY_LABEL_SYNONYMS`, lowercase + trim only) — NOT
 * `ai_policy_from_labels`, whose regex normalizer admits a different set —
 * so the cursor predicate decodes exactly as `initialPolicyFromEffect`.
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
        OR lower(btrim(l #>> '{}')) IN (${RESTRICTIVE_LABEL_SPELLINGS_SQL})
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
  readonly reason: 'unbound_create' | 'bound_relocation' | 'unbound_relocation';
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
  input: { confluenceId: string; resolvedPolicy: AiPolicy; labels: readonly string[] },
): Promise<{ policy: AiPolicy; labels: string[] }> {
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
  }>(
    `SELECT effect, remote_terminal_result, remote_effects_completed_at
       FROM page_write_intents
      WHERE status = 'pending'
        AND kind = 'pages.create.confluence'
        AND remote_effect_started_at IS NOT NULL`,
  );
  let policy = input.resolvedPolicy;
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
    policy = stricterPolicy(policy, stated.policy);
    for (const label of stated.labels) if (!labels.includes(label)) labels.push(label);
  }
  return { policy, labels };
}
