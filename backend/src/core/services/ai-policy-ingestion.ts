import type { PoolClient } from 'pg';
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

/** A usable acknowledged identity: a non-empty `confluenceId` string. */
function boundConfluenceId(terminal: Record<string, unknown> | null): string | null {
  const id = terminal?.confluenceId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

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
       -- NULL terminal result (reply never arrived) must count as UNBOUND:
       -- coalesce so three-valued logic cannot drop the row.
       AND NOT COALESCE(
         jsonb_typeof(i.remote_terminal_result -> 'confluenceId') = 'string'
         AND length(i.remote_terminal_result ->> 'confluenceId') > 0,
         FALSE
       )
       AND COALESCE(i.effect ->> 'initialPolicy', '') <> 'all'
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
  }>(
    `SELECT effect, remote_terminal_result
       FROM page_write_intents
      WHERE status = 'pending'
        AND kind = 'pages.create.confluence'
        AND remote_effect_started_at IS NOT NULL`,
  );
  let policy = input.resolvedPolicy;
  const labels = [...input.labels];
  for (const row of creates.rows) {
    const bound = boundConfluenceId(row.remote_terminal_result);
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
