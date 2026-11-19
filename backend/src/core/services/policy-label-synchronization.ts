import type { PoolClient } from 'pg';
import { isConfluenceEnabled } from './confluence-integration.js';
import { advancePageWriteIntentInTransaction, reservePageWriteIntentInTransaction, type PageWriteIntent } from './page-write-admission.js';
import { enqueuePageWriteInvalidation } from './page-write-invalidation.js';

export type PolicyLabelWrite = { intent: PageWriteIntent; confluenceId: string; labels: string[]; deferred?: boolean };

/** Reserve on the policy/publication transaction, including recovered creation. */
export async function reservePolicyLabelSynchronization(client: PoolClient, userId: string, pageId: number): Promise<PolicyLabelWrite | null> {
  if (!await isConfluenceEnabled(userId, client)) return null;
  const result = await client.query<{ source: string; confluence_id: string | null; labels: string[]; ai_policy_revision: string }>(
    'SELECT source, confluence_id, labels, ai_policy_revision::text FROM pages WHERE id = $1', [pageId]);
  const row = result.rows[0];
  if (!row || row.source !== 'confluence' || !row.confluence_id) return null;
  const existing = await client.query<{ id: string; runtime_id: string; page_ids: number[]; revisions: PageWriteIntent['revisions'] }>(
    `SELECT id, runtime_id, page_ids, revisions FROM page_write_intents
      WHERE status = 'pending' AND page_ids = ARRAY[$1]::int[]
        AND ((kind = 'page.labels' AND effect ? 'autoTagStage' AND remote_effect_started_at IS NOT NULL)
          OR (kind = 'pages.create.labels' AND effect->>'localPolicyCommitted' = 'true')) FOR UPDATE`, [pageId]);
  const pending = existing.rows[0];
  if (pending) {
    // Generated compensation remains the sole remote owner.
    return { intent: { id: pending.id, runtimeId: pending.runtime_id, pageIds: pending.page_ids, revisions: pending.revisions },
      confluenceId: row.confluence_id, labels: row.labels, deferred: true };
  }
  const intent = await reservePageWriteIntentInTransaction(client, {
    pageIds: [pageId], kind: 'pages.create.labels', actorId: userId,
    effect: { effectClass: 'remote', confluenceId: row.confluence_id,
      priorLabels: row.labels, targetLabels: row.labels,
      localPolicyCommitted: true, policyRevision: row.ai_policy_revision },
  });
  // Local publication is already an effect; shutdown must not cancel this debt.
  const advanced = await advancePageWriteIntentInTransaction(client, intent, async () => undefined);
  intent.revisions = advanced.revisions;
  await enqueuePageWriteInvalidation(client, intent.id);
  return { intent, confluenceId: row.confluence_id, labels: row.labels };
}
