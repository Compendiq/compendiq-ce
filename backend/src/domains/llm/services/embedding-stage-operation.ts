import type { AiOperationContext } from '@compendiq/contracts';
import { query } from '../../../core/db/postgres.js';
import { newAiOperation } from '../../../core/enterprise/ai-policy-hooks.js';
import type { EmbeddingArticle } from './embedding-article-stage.js';
import { ArticleStageRefusedError } from './article-stage-admission.js';
import { emitUnresolvedDecision } from './ai-policy-admission.js';

/** Allocation failure cannot establish a global ordinal. Preserve the operation,
 * emit one uniquely identified refusal with an unknown attempt, and never dispatch. */
export async function allocateEmbeddingAttempt(
  pageId: number, operation: AiOperationContext, stage: string,
  allocate: () => Promise<number>, destination?: { providerId: string; model: string },
): Promise<number> {
  try {
    return await allocate();
  } catch {
    await emitUnresolvedDecision(pageId, 'embedding', { operation, stage, attempt: null }, 'policy_unavailable', destination);
    throw new ArticleStageRefusedError();
  }
}

/** One shadow operation per article generation and migration epoch, not job pass. */
export async function shadowEmbeddingAttempt(pageId: number, epoch: string,
  destination?: { providerId: string; model: string },
): Promise<{ operation: AiOperationContext; attempt: number }> {
  // This request identity is adopted by a new job. If the identity store itself
  // is unreadable it identifies the allocation request only, not a reconstructed
  // historical job; the allocation stage and null ordinal make that gap explicit.
  const operation = newAiOperation('shadow_backfill', { kind: 'worker', id: 'shadow-reembed' });
  let floor: number;
  try {
    const result = await query(`INSERT INTO shadow_embedding_ai_operations
      (page_id, epoch, content_revision, image_revision, attempt, operation_id)
      SELECT id, $2, content_revision, image_analysis_revision, 1, $3 FROM pages
      WHERE id = $1 AND deleted_at IS NULL
      ON CONFLICT (page_id) DO UPDATE SET
        epoch = EXCLUDED.epoch, content_revision = EXCLUDED.content_revision,
        image_revision = EXCLUDED.image_revision,
        operation_id = CASE WHEN shadow_embedding_ai_operations.epoch = EXCLUDED.epoch
          AND shadow_embedding_ai_operations.content_revision = EXCLUDED.content_revision
          AND shadow_embedding_ai_operations.image_revision = EXCLUDED.image_revision
          THEN shadow_embedding_ai_operations.operation_id ELSE EXCLUDED.operation_id END,
        attempt = CASE WHEN shadow_embedding_ai_operations.epoch = EXCLUDED.epoch
          AND shadow_embedding_ai_operations.content_revision = EXCLUDED.content_revision
          AND shadow_embedding_ai_operations.image_revision = EXCLUDED.image_revision
          THEN shadow_embedding_ai_operations.attempt + 1 ELSE 1 END
      RETURNING operation_id, attempt`, [pageId, epoch, operation.operationId]);
    const row = result.rows[0];
    if (!row) throw new ArticleStageRefusedError();
    operation.operationId = row.operation_id;
    floor = row.attempt - 1;
  } catch {
    await emitUnresolvedDecision(pageId, 'embedding', { operation, stage: 'shadow_embedding_allocation', attempt: null },
      'policy_unavailable', destination);
    throw new ArticleStageRefusedError();
  }
  // The independent counter survives replacement of the generation row while
  // an older job is still in flight. Do not double-emit its refusal above.
  const attempt = await allocateEmbeddingAttempt(pageId, operation, 'shadow_embedding',
    () => nextExplicitEmbeddingAttempt({ pageId }, operation, floor), destination);
  return { operation, attempt };
}

/** Explicit callers retain their actor/source; only numbering belongs to persistence. */
export async function nextExplicitEmbeddingAttempt(article: Pick<EmbeddingArticle, 'pageId'>, operation: AiOperationContext, previousAttempt = 0): Promise<number> {
  const result = await query(`INSERT INTO explicit_embedding_ai_attempts (page_id, operation_id, attempt)
    VALUES ($1, $2, $3 + 1) ON CONFLICT (page_id, operation_id)
    DO UPDATE SET attempt = GREATEST(explicit_embedding_ai_attempts.attempt, $3) + 1 RETURNING attempt`,
  [article.pageId, operation.operationId, previousAttempt]);
  const row = result.rows[0];
  if (!row) throw new ArticleStageRefusedError();
  return row.attempt;
}
