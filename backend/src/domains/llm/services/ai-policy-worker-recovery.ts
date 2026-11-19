import { query } from '../../../core/db/postgres.js';
import { loadProviderMetadata } from './ai-policy-admission.js';

/** Scheduling only, never permission to dispatch. Select eligible rows BEFORE
 * the bounded window so still-forbidden rows cannot starve recoverable work.
 * Stage status owns recovery; the legacy page-wide reason is only display data.
 * Every consumer must retain its authoritative transport/publication admission.
 */
export async function recoverPolicyBlockedStage(
  stage: 'embedding' | 'summary' | 'quality' | 'image_analysis',
  providerId: string,
  limit = 100,
): Promise<number> {
  let provider;
  try {
    provider = await loadProviderMetadata({ query }, providerId);
  } catch {
    // A scheduling read cannot grant permission or consume the blocked job.
    // Leave it parked for the next normal reconciliation cadence.
    return 0;
  }
  if (!provider) return 0;
  const local = provider.effectiveLocality === 'local';
  if (stage === 'image_analysis') {
    const result = await query(
      `UPDATE page_image_analyses a SET status = 'pending', ai_policy_block_reason = NULL,
          next_attempt_at = NULL, updated_at = NOW()
        WHERE a.id IN (
          SELECT work.id FROM page_image_analyses work JOIN pages p ON p.id = work.page_id
           WHERE work.status = 'policy_blocked' AND p.deleted_at IS NULL
             AND COALESCE(p.page_type, 'page') <> 'folder'
             AND (p.ai_policy = 'all' OR (p.ai_policy = 'local_only' AND $1::boolean))
           ORDER BY work.id LIMIT $2
        ) AND a.status = 'policy_blocked'`, [local, limit],
    );
    return result.rowCount ?? 0;
  }
  // Closed stage union: no caller-controlled SQL identifiers.
  const status = `${stage}_status`;
  const target = stage === 'embedding' ? 'not_embedded' : 'pending';
  const result = await query(
    `UPDATE pages SET ${status} = $3${stage === 'embedding' ? ', embedding_dirty = TRUE' : ''}
      WHERE id IN (
        SELECT id FROM pages WHERE ${status} = 'policy_blocked'
          AND deleted_at IS NULL AND COALESCE(page_type, 'page') <> 'folder'
          AND (ai_policy = 'all' OR (ai_policy = 'local_only' AND $1::boolean))
        ORDER BY id LIMIT $2
      ) AND ${status} = 'policy_blocked'
        AND (ai_policy = 'all' OR (ai_policy = 'local_only' AND $1::boolean))`, [local, limit, target],
  );
  return result.rowCount ?? 0;
}
