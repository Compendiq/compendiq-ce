import type { AiOperationContext } from '@compendiq/contracts';
import { getPool, query } from '../../../core/db/postgres.js';
import { ArticleStageRefusedError } from './article-stage-admission.js';
import type { EmbeddingArticle } from './embedding-article-stage.js';

/** One operation per dirty article generation, surviving worker/process retries.
 * Lock the source before the evidence row, matching the reset trigger's order. */
export async function embeddingOperation(article: EmbeddingArticle): Promise<AiOperationContext> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const page = await client.query(`SELECT id FROM pages WHERE id = $1 AND xmin::text = $2
      AND deleted_at IS NULL FOR SHARE`, [article.pageId, article.rowVersion]);
    if (!page.rows.length) throw new ArticleStageRefusedError();
    const result = await client.query(`INSERT INTO embedding_ai_operations (page_id, content_revision, image_revision)
      VALUES ($1, $2, $3) ON CONFLICT (page_id) DO UPDATE SET page_id = EXCLUDED.page_id
      RETURNING operation_id`, [article.pageId, article.contentRevision, article.imageRevision]);
    await client.query('COMMIT');
    return { operationId: result.rows[0].operation_id, actor: { kind: 'worker', id: 'embedding' },
      source: 'embedding', cascadeId: null };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** Allocate before every new batch or retry, not from a loop-local index. */
export async function nextEmbeddingAttempt(article: EmbeddingArticle, operation: AiOperationContext): Promise<number> {
  const result = await query(`UPDATE embedding_ai_operations SET attempt = attempt + 1
    WHERE page_id = $1 AND operation_id = $2 AND content_revision = $3 AND image_revision = $4
    RETURNING attempt`, [article.pageId, operation.operationId, article.contentRevision, article.imageRevision]);
  const row = result.rows[0];
  if (!row) throw new ArticleStageRefusedError();
  return row.attempt;
}
