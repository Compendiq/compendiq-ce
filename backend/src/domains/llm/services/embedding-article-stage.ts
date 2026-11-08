import { AI_POLICY_PROVENANCE_VERSION, type ConversationTurnAiProvenance } from '@compendiq/contracts';
import type { PoolClient } from 'pg';
import { getPool, query } from '../../../core/db/postgres.js';
import { embeddingDraftAnchor } from '../../../core/services/embedding-draft-continuity.js';
import { newAiOperation } from '../../../core/enterprise/ai-policy-hooks.js';
import { AI_POLICY_LOCK_NAMESPACE, isAiPolicy } from '../../../core/services/ai-policy-service.js';
import { asRevision, type AiPolicyAdmission } from './ai-policy-admission.js';
import { ArticleStageRefusedError, validateArticleStageOnClient } from './article-stage-admission.js';
import { resolveArticleUsecaseOnClient } from './llm-provider-resolver.js';
import type { ArticleTransportStage } from './openai-compatible-client.js';

export type EmbeddingArticle = ConversationTurnAiProvenance['pages'][number] & {
  /** PostgreSQL row version: a successor claim/reset invalidates this work even
   * when neither authored content nor policy changed. Never exposed on the wire. */
  rowVersion: string;
  imageRevision: string;
  published?: { title: string; spaceKey: string; bodyHtml: string; draftAnchor: string };
};

/** Bind the caller's bytes to authoritative revisions before composition. */
export async function captureEmbeddingArticle(
  pageId: number, title: string, spaceKey: string, bodyHtml: string,
): Promise<EmbeddingArticle> {
  const result = await query(`SELECT title, space_key, body_html, ai_policy, ai_policy_revision, content_revision,
    xmin::text AS row_version, image_analysis_revision::text AS image_revision
    FROM pages WHERE id = $1 AND deleted_at IS NULL`, [pageId]);
  const row = result.rows[0];
  const policyRevision = asRevision(row?.ai_policy_revision);
  const contentRevision = asRevision(row?.content_revision);
  if (!row || row.title !== title || (row.space_key ?? '') !== (spaceKey ?? '') || row.body_html !== bodyHtml
    || !isAiPolicy(row.ai_policy) || policyRevision === null || contentRevision === null) {
    throw new ArticleStageRefusedError();
  }
  return { pageId, policy: row.ai_policy, policyRevision, contentRevision,
    rowVersion: row.row_version, imageRevision: row.image_revision,
    published: { title, spaceKey, bodyHtml,
      draftAnchor: await embeddingDraftAnchor(getPool(), pageId, row.row_version) } };
}

/** Claim one selected row, not a batch of potentially superseded rows. A claim
 * is scheduling state, never inference admission. A later claim wins by xmin. */
export async function claimEmbeddingArticle(page: EmbeddingArticle): Promise<EmbeddingArticle | null> {
  const result = await query(`UPDATE pages SET embedding_status = 'embedding', embedding_error = NULL
    WHERE id = $1 AND xmin::text = $2 AND embedding_dirty = TRUE AND deleted_at IS NULL
      AND ai_policy <> 'none'
    RETURNING xmin::text AS row_version`, [page.pageId, page.rowVersion]);
  return result.rows[0] ? { ...page, rowVersion: result.rows[0].row_version,
    published: page.published ? { ...page.published, draftAnchor: result.rows[0].row_version } : undefined } : null;
}

/** The held page row is the final source/claim fence for all publication. */
export async function validateEmbeddingSourceOnClient(client: PoolClient, page: EmbeddingArticle): Promise<void> {
  const result = await client.query(`SELECT xmin::text AS row_version, image_analysis_revision::text AS image_revision,
    ai_policy, ai_policy_revision, content_revision, title, space_key, body_html
    FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [page.pageId]);
  const row = result.rows[0];
  const samePublished = row && page.published
    && row.title === page.published.title && (row.space_key ?? '') === page.published.spaceKey
    && row.body_html === page.published.bodyHtml
    && await embeddingDraftAnchor(client, page.pageId, row.row_version) === page.published.draftAnchor;
  if (!row || row.image_revision !== page.imageRevision
    || row.ai_policy !== page.policy || asRevision(row.ai_policy_revision) !== page.policyRevision
    || (!samePublished && (row.row_version !== page.rowVersion
      || asRevision(row.content_revision) !== page.contentRevision))) throw new ArticleStageRefusedError();
}

/** Revalidate the effective live assignment on the publishing transaction,
 * rather than merely certifying that the old provider still exists. */
export async function validateEmbeddingPublicationOnClient(
  client: PoolClient, page: EmbeddingArticle, stage: ArticleTransportStage, model: string,
): Promise<void> {
  if (stage.context.stage === 'shadow_embedding') {
    // The candidate assignment is the active migration, not the live usecase.
    // Hold it and its provider against native writers through publication.
    await client.query('LOCK TABLE llm_providers IN SHARE MODE');
    const saved = await client.query<{ setting_value: string }>(
      "SELECT setting_value FROM admin_settings WHERE setting_key = 'embedding_shadow_migration' FOR SHARE",
    );
    const target = JSON.parse(saved.rows[0]?.setting_value ?? 'null');
    if (!target || target.status !== 'active' || target.providerId !== stage.provenance.providerId
      || target.model !== model) throw new ArticleStageRefusedError();
  } else {
    const target = await resolveArticleUsecaseOnClient(client, 'embedding');
    if (!target || target.config.providerId !== stage.provenance.providerId || target.model !== model
      || asRevision(target.config.configRevision) !== stage.provenance.configRevision) throw new ArticleStageRefusedError();
  }
  await validateArticleStageOnClient(client, stage.provenance, null, stage.context.embeddingSources);
  await validateEmbeddingSourceOnClient(client, page);
}

/** Non-inference settlement must not overwrite successor article/job state. */
export async function settleEmbeddingArticle(
  page: EmbeddingArticle,
  publish: (client: PoolClient) => Promise<void>,
): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared($1, $2)', [AI_POLICY_LOCK_NAMESPACE, page.pageId]);
    await validateEmbeddingSourceOnClient(client, page);
    await publish(client);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof ArticleStageRefusedError) return false;
    throw err;
  } finally {
    client.release();
  }
}

export function embeddingArticleStage(
  page: EmbeddingArticle,
  admission: Extract<AiPolicyAdmission, { admitted: true }>,
  stage: 'embedding' | 'shadow_embedding',
  operation = newAiOperation('embedding', { kind: 'worker', id: 'embedding' }),
): ArticleTransportStage {
  return {
    provenance: {
      version: AI_POLICY_PROVENANCE_VERSION,
      providerId: admission.providerId, configRevision: admission.configRevision,
      locality: admission.locality, pages: [{ pageId: page.pageId, policy: page.policy,
        policyRevision: page.policyRevision, contentRevision: page.contentRevision }],
    },
    userId: null,
    usecase: 'embedding',
    context: { operation, stage, attempt: 1,
      embeddingSources: [{ pageId: page.pageId, rowVersion: page.rowVersion, imageRevision: page.imageRevision, published: page.published }] },
  };
}
