import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../db/postgres.js';
import { PageWriteError, withPageWriteTransaction } from './page-write-admission.js';
import { applyAiPolicyOnClient, aiPolicyRefusalFromResult, isAiPolicyEnforcementAvailable,
  lockAiPolicyForPages, stricterPolicy, type AiPolicy } from './ai-policy-service.js';
import { admitAutomaticIngestionPolicy, FreshPublicationDeferredError } from './ai-policy-ingestion.js';
import { isAiPolicyRuntimeGuardError } from './ai-policy-runtime-guard.js';

/** Notion's dashed/undashed, case-insensitive IDs name the same source.
 * Confluence IDs are opaque and must never receive Notion normalization.
 */
export function ingestionSourceId(source: 'confluence' | 'notion', id: string): string {
  return source === 'notion' ? id.replace(/-/g, '').toLowerCase() : id;
}

export interface IngestionObservation {
  source: 'confluence' | 'notion';
  sourceScope: string;
  sourceId: string;
  observedRevision: string;
  userId: string;
  policy: AiPolicy;
}

/** Run the admission decision and its deferred observation in ONE transaction.
 * A refusal is thrown only AFTER the observation commits. Never wrap this in a
 * transaction that rolls the observation back along with the refused snapshot.
 * A successful preflight is not publication: the publisher must call
 * publishIngestionPolicyOnClient on its own held transaction.
 */
export async function observeIngestionAdmission<T>(
  observation: IngestionObservation,
  decide: (client: PoolClient, pendingPolicy: AiPolicy) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  let deferred: FreshPublicationDeferredError | undefined;
  let result: T;
  try {
    await client.query('BEGIN');
    const pending = await client.query<{ policy: AiPolicy }>(
      `SELECT policy FROM ai_policy_deferred_ingestion
       WHERE source=$1 AND source_scope=$2 AND source_id=$3 AND applied_at IS NULL`,
      [observation.source, observation.sourceScope, ingestionSourceId(observation.source, observation.sourceId)],
    );
    const policy = pending.rows.reduce((p, row) => stricterPolicy(p, row.policy), observation.policy);
    try {
      result = await decide(client, policy);
    } catch (err) {
      if (!(err instanceof FreshPublicationDeferredError)
        || err.reason !== 'ai_policy_enforcement_unavailable' || policy === 'all') throw err;
      await client.query(
        `INSERT INTO ai_policy_deferred_ingestion
         (id, source, source_scope, source_id, observed_revision, policy, observed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [randomUUID(), observation.source, observation.sourceScope, ingestionSourceId(observation.source, observation.sourceId),
          observation.observedRevision, policy, observation.userId],
      );
      deferred = err;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
  if (deferred) throw deferred;
  return result!;
}

type IngestionTarget = {
  source: 'confluence' | 'notion'; sourceScope: string; sourceId: string;
  pageId: number; userId: string;
};

/** Publish on the content writer's transaction, after lifecycle admission and
 * before any target row lock. Fresh rows must be inserted at all with only
 * ordinary labels first, on this same transaction. The shared primitive owns
 * authority, revision, purge and evidence; a sink failure rolls back both the
 * article and observation consumption. No network work belongs here.
 *
 * A tightening the migration-151 guard refuses leaves here as the raw 55000
 * error (`isAiPolicyRuntimeGuardError`) so each caller classifies it on its
 * own terms: the Confluence sync defers the page and holds its cursor, a
 * Notion item fails and stays retryable, HTTP maps it centrally to 409.
 */
export async function publishIngestionPolicyOnClient(
  client: PoolClient,
  input: IngestionTarget & { candidate?: AiPolicy; consumeObservations?: boolean },
): Promise<{ policy: AiPolicy; consumed: number }> {
  await lockAiPolicyForPages(client, [input.pageId]);
  const page = await client.query<{ ai_policy: AiPolicy; confluence_id: string | null;
    notion_page_id: string | null; created_by_user_id: string | null; source: string }>(
    `SELECT ai_policy, confluence_id, notion_page_id, created_by_user_id, source
     FROM pages WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [input.pageId],
  );
  const row = page.rows[0];
  if (!row || (input.source === 'confluence'
    ? row.source !== 'confluence' || input.sourceScope !== 'shared' || row.confluence_id !== input.sourceId
    : row.source !== 'standalone' || row.created_by_user_id !== input.sourceScope
      || row.notion_page_id === null
      || ingestionSourceId('notion', row.notion_page_id) !== ingestionSourceId('notion', input.sourceId))) {
    throw new PageWriteError(404, 'page_not_found', 'Page not found');
  }
  const pending = await client.query<{ id: string; policy: AiPolicy }>(
    `SELECT id, policy FROM ai_policy_deferred_ingestion
     WHERE source=$1 AND source_scope=$2 AND source_id=$3 AND applied_at IS NULL
     ORDER BY id FOR UPDATE`, [input.source, input.sourceScope, ingestionSourceId(input.source, input.sourceId)],
  );
  const candidate = pending.rows.reduce((p, intent) => stricterPolicy(p, intent.policy), input.candidate ?? 'all');
  const policy = admitAutomaticIngestionPolicy({ identity: input.sourceId, currentPolicy: row.ai_policy, candidate });
  // Ordinary content ingestion already has its own source admission. With no
  // pending policy intent and no policy move there is no policy operation to
  // authorize or evidence (notably before a fresh Confluence ACL is mirrored).
  if (policy === row.ai_policy && pending.rows.length === 0) return { policy, consumed: 0 };
  const applied = await applyAiPolicyOnClient(client, {
    userId: input.userId, items: [{ pageId: input.pageId, policy }],
    operation: { operationId: randomUUID(), actor: { kind: 'user', id: input.userId },
      source: 'ingestion_publication', cascadeId: null },
  });
  if (!applied.ok) throw aiPolicyRefusalFromResult(applied);
  // Closed rollout must not consume deferred intent even when the current row
  // happens to be at least as strict. Reconciliation remains explicitly gated.
  // Provisional placeholders may be deleted if attachment preparation fails.
  const consumed = input.consumeObservations !== false && isAiPolicyEnforcementAvailable() ? pending.rows.length : 0;
  if (consumed) {
    await client.query(`UPDATE ai_policy_deferred_ingestion SET applied_at=NOW(), applied_page_id=$2
      WHERE id=ANY($1::uuid[])`, [pending.rows.map((intent) => intent.id), input.pageId]);
  }
  return { policy, consumed };
}

/** Explicit activation reconciliation uses the same held-client publisher as
 * fresh ingestion. Repeated calls consume no applied observations, so a later
 * explicit relaxation wins. Missing fresh rows remain pending for ingestion.
 * A tightening the migration-151 guard refuses (a pre-#1881 writer is still
 * active) is a refused tightening like a closed switch: the transaction has
 * rolled back, nothing was consumed, and the observation stays pending until
 * that runtime is fenced or quiesced and the reconciliation is retried.
 */
export async function reconcileDeferredIngestionPolicy(input: IngestionTarget): Promise<number> {
  if (!isAiPolicyEnforcementAvailable()) return 0;
  try {
    return await withPageWriteTransaction([input.pageId], async (client) => {
      if (!isAiPolicyEnforcementAvailable()) return 0;
      return (await publishIngestionPolicyOnClient(client, input)).consumed;
    });
  } catch (err) {
    if (isAiPolicyRuntimeGuardError(err)) return 0;
    throw err;
  }
}
