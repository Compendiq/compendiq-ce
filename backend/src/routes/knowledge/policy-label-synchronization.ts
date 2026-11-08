import { isConfluenceEnabled } from '../../core/services/confluence-integration.js';
import { userCanAccessPage } from '../../core/services/rbac-service.js';
import { completePageWriteIntent, PageWriteError, runPageWriteIntentEffect, withPageWriteTransaction } from '../../core/services/page-write-admission.js';
import { enqueuePageWriteInvalidation } from '../../core/services/page-write-invalidation.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import { sameLabelSet } from '../../domains/confluence/services/ordinary-page-write-reconciler.js';
import type { PolicyLabelWrite } from '../../core/services/policy-label-synchronization.js';
export { reservePolicyLabelSynchronization, type PolicyLabelWrite } from '../../core/services/policy-label-synchronization.js';

export type PolicyLabelSynchronization = { status: 'complete' | 'pending'; pendingIntentIds: string[] };

/** Remote uncertainty retains the durable journal and never undoes local policy. */
export async function synchronizePolicyLabels(userId: string, writes: readonly PolicyLabelWrite[]): Promise<PolicyLabelSynchronization> {
  const pendingIntentIds: string[] = [];
  for (const { intent, confluenceId, labels, deferred } of writes) {
    if (deferred) { pendingIntentIds.push(intent.id); continue; }
    try {
      const confluence = await withPageWriteTransaction(intent.pageIds, async (client) => {
        if (!await isConfluenceEnabled(userId, client) || !await userCanAccessPage(userId, intent.pageIds[0]!, client)) {
          throw new PageWriteError(409, 'intent_access_changed', 'Label synchronization authority changed');
        }
        return getClientForUser(userId, client);
      }, { intent });
      if (!confluence) throw new PageWriteError(409, 'intent_provider_unavailable', 'Confluence is unavailable');
      const prior = await confluence.getLabels(confluenceId);
      await runPageWriteIntentEffect(intent, { kind: 'remote', completesRemoteWork: true }, async () => {
        const add = labels.filter((label) => !prior.includes(label));
        if (add.length) await confluence.addLabels(confluenceId, add);
        for (const label of prior.filter((label) => !labels.includes(label))) await confluence.removeLabel(confluenceId, label);
        if (!sameLabelSet(await confluence.getLabels(confluenceId), labels)) {
          throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'Remote labels differ from the committed target');
        }
      });
      await completePageWriteIntent(intent, async (client) => {
        const current = await client.query<{ labels: string[] }>('SELECT labels FROM pages WHERE id = $1', [intent.pageIds[0]]);
        if (!current.rows[0] || !sameLabelSet(current.rows[0].labels, labels)) {
          throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'Committed labels changed');
        }
        await enqueuePageWriteInvalidation(client, intent.id);
      });
    } catch {
      pendingIntentIds.push(intent.id);
    }
  }
  return { status: pendingIntentIds.length ? 'pending' : 'complete', pendingIntentIds };
}
