import type { PoolClient } from 'pg';
import { getPool } from '../../../core/db/postgres.js';
import { AI_POLICY_LOCK_NAMESPACE } from '../../../core/services/ai-policy-service.js';
import { userCanAccessPage } from '../../../core/services/rbac-service.js';
import { emitAiPolicyEvent } from '../../../core/enterprise/ai-policy-hooks.js';
import { ConversationTurnAiProvenanceSchema, type ConversationTurnAiProvenance } from '@compendiq/contracts';
import { asRevision, loadProviderMetadata } from './ai-policy-admission.js';
import { pageAdmittedFor } from './ai-policy-retrieval.js';

/** Short admission/publication only: never holds a transaction across inference. */
export async function admitArticleStage(
  provenance: ConversationTurnAiProvenance,
  userId: string,
  usecase: 'chat' | 'rerank',
  publish?: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const parsed = ConversationTurnAiProvenanceSchema.safeParse(provenance);
  if (!parsed.success) throw new Error('Unknown article provenance');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const page of [...provenance.pages].sort((a, b) => a.pageId - b.pageId)) {
      await client.query('SELECT pg_advisory_xact_lock_shared($1, $2)', [AI_POLICY_LOCK_NAMESPACE, page.pageId]);
    }
    const pages = await client.query('SELECT id, ai_policy, ai_policy_revision, content_revision FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL ORDER BY id FOR SHARE', [provenance.pages.map((p) => p.pageId)]);
    await client.query('SELECT id FROM llm_providers WHERE id::text = $1 FOR SHARE', [provenance.providerId]);
    const provider = await loadProviderMetadata(client, provenance.providerId);
    if (!provider || provider.configRevision !== provenance.configRevision || provider.effectiveLocality !== provenance.locality) {
      throw new Error('Article destination changed or unavailable');
    }
    for (const page of provenance.pages) {
      const current = pages.rows.find((r) => r.id === page.pageId);
      if (!current || current.ai_policy !== page.policy
        || asRevision(current.ai_policy_revision) !== page.policyRevision
        || asRevision(current.content_revision) !== page.contentRevision
        || !pageAdmittedFor(page.policy, provider.effectiveLocality)
        || !(await userCanAccessPage(userId, page.pageId, client))) {
        throw new Error('Article grounding no longer admitted');
      }
    }
    await publish?.(client);
    await client.query('COMMIT');
    if (!publish) for (const page of provenance.pages) emitAiPolicyEvent({
      type: 'admitted', pageId: page.pageId, usecase, providerId: provenance.providerId,
      configRevision: provenance.configRevision, policy: page.policy, policyRevision: page.policyRevision,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
