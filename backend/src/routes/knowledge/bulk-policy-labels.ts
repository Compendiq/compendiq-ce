import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import pLimit from 'p-limit';
import { isConfluenceEnabled } from '../../core/services/confluence-integration.js';
import { userCanAccessPage, userCanEditPage } from '../../core/services/rbac-service.js';
import { AiPolicyDeniedError, applyPageLabelsOnClient, lockAiPolicyForPages } from '../../core/services/ai-policy-service.js';
import {
  advancePageWriteIntentInTransaction, completePageWriteIntent, PageWriteError,
  reservePageWriteIntentInTransaction, runPageWriteIntentEffect, withPageWriteTransaction,
  type PageWriteIntent,
} from '../../core/services/page-write-admission.js';
import { enqueuePageWriteInvalidation } from '../../core/services/page-write-invalidation.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import { sameLabelSet } from '../../domains/confluence/services/ordinary-page-write-reconciler.js';

type SelectedPage = {
  id: number; source: string; confluenceId: string | null; labels: string[];
  contentRevision: string; lifecycleRevision: string;
};

/**
 * Policy-affecting bulk labels have ONE publication point, before remote I/O.
 * All selected labels, policy revisions, evidence and remote reservations commit
 * together. Remote failures never roll back or partially apply that decision.
 * Pending intents retain the committed target and fence later content writers.
 */
export async function publishBulkPolicyLabels(
  userId: string,
  rows: readonly SelectedPage[],
  target: (labels: readonly string[]) => string[],
  kind: 'pages.bulk.tags' | 'pages.bulk.replace_tags',
) {
  const ids = rows.map((row) => row.id).sort((a, b) => a - b);
  const pending = await withPageWriteTransaction(ids, async (client) => {
    await lockAiPolicyForPages(client, ids);
    const actor = await client.query('SELECT 1 FROM users WHERE id = $1 AND deactivated_at IS NULL', [userId]);
    if (actor.rowCount !== 1) throw new PageWriteError(404, 'page_not_found', 'Page not found');
    const enabled = await isConfluenceEnabled(userId, client);
    const remote: Array<{ intent: PageWriteIntent; confluenceId: string; labels: string[]; prior: string[] }> = [];
    // Validate the full original selection before publishing anything. The
    // transaction also rolls back all preceding writes on any later refusal.
    for (const row of rows) {
      const fresh = await client.query<{
        source: string; confluence_id: string | null; content_revision: string; lifecycle_revision: string;
      }>(`SELECT source, confluence_id, content_revision::text, lifecycle_revision::text
            FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [row.id]);
      const page = fresh.rows[0];
      if (!page || !(await userCanAccessPage(userId, row.id, client))) {
        throw new PageWriteError(404, 'page_not_found', 'Page not found');
      }
      if (page.source !== row.source || page.confluence_id !== row.confluenceId
        || page.content_revision !== row.contentRevision || page.lifecycle_revision !== row.lifecycleRevision) {
        throw new PageWriteError(409, 'stale_content_revision', 'The selected pages changed; refresh explicitly');
      }
      if (page.source === 'confluence' && !(await userCanEditPage(userId, row.id, client))) {
        throw new AiPolicyDeniedError([row.id]);
      }
    }
    for (const row of rows) {
      const applied = await applyPageLabelsOnClient(client, { userId, pageId: row.id, targetLabels: target(row.labels) });
      if (enabled && row.source === 'confluence' && row.confluenceId) {
        // Reserve AFTER our local publication, on the same transaction, so
        // the journal's CAS pair describes the committed state, not the old one.
        const intent = await reservePageWriteIntentInTransaction(client, {
          pageIds: [row.id], kind, actorId: userId,
          effect: {
            effectClass: 'remote', confluenceId: row.confluenceId,
            priorLabels: row.labels, targetLabels: applied.labels,
            targetLabelsSha256: createHash('sha256').update(JSON.stringify(applied.labels)).digest('hex'),
            localPolicyCommitted: true,
          },
        });
        // Local publication is already work: crash/quiescence must not cancel
        // this reservation as an unused intent, or restore its prior labels.
        const advanced = await advancePageWriteIntentInTransaction(client, intent, async () => undefined);
        intent.revisions = advanced.revisions;
        await enqueuePageWriteInvalidation(client, intent.id);
        remote.push({ intent, confluenceId: row.confluenceId, labels: applied.labels, prior: row.labels });
      }
    }
    return remote;
  });

  const syncPending: string[] = [];
  const limit = pLimit(5);
  await Promise.all(pending.map(({ intent, confluenceId, labels, prior }) => limit(async () => {
    try {
      // Revocation after the publication does not undo policy. It may prevent
      // write-back, in which case the durable intent remains explicitly pending.
      const confluence = await withPageWriteTransaction(intent.pageIds, async (client) => {
        if (!(await isConfluenceEnabled(userId, client))
          || !(await userCanAccessPage(userId, intent.pageIds[0]!, client))) {
          throw new PageWriteError(409, 'intent_access_changed', 'Label synchronization requires reconciliation');
        }
        return getClientForUser(userId, client);
      }, { intent });
      if (!confluence) throw new PageWriteError(409, 'intent_provider_unavailable', 'Confluence is unavailable');
      await runPageWriteIntentEffect(intent, { kind: 'remote', completesRemoteWork: true }, async () => {
        const add = labels.filter((label) => !prior.includes(label));
        if (add.length) await confluence.addLabels(confluenceId, add);
        for (const label of prior.filter((label) => !labels.includes(label))) {
          await confluence.removeLabel(confluenceId, label);
        }
      });
      await completePageWriteIntent(intent, async (client: PoolClient) => {
        const current = await client.query<{ labels: string[] }>('SELECT labels FROM pages WHERE id = $1', [intent.pageIds[0]]);
        if (!current.rows[0] || !sameLabelSet(current.rows[0].labels, labels)) {
          throw new PageWriteError(409, 'ai_policy_label_diverged', 'The committed label target changed');
        }
        // No second policy writer and no fresh authority decision here: this
        // is acknowledgment of the already-committed whole-selection change.
        await enqueuePageWriteInvalidation(client, intent.id);
      });
    } catch {
      syncPending.push(intent.id);
    }
  })));
  return { succeeded: rows.length, failed: 0, errors: [] as string[],
    synchronization: { status: syncPending.length ? 'pending' : 'complete', pendingIntentIds: syncPending } };
}
