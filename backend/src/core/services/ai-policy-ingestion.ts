import {
  policyFromLabels,
  resolveCreationAiPolicy,
  stricterPolicy,
  type AiPolicy,
} from './ai-policy-service.js';

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
