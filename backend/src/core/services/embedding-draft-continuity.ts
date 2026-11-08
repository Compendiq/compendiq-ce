import type { PoolClient } from 'pg';

const key = (pageId: number) => `embedding_draft_continuity:${pageId}`;

/** A single bounded scheduling receipt per page, not content or AI evidence.
 * Only the draft writer may advance it, on the transaction holding the page.
 * Any intervening worker claim/reset breaks the xmin chain, even if its values
 * are identical. Missing receipts conservatively invalidate old work. */
export async function embeddingDraftAnchor(
  client: Pick<PoolClient, 'query'>, pageId: number, rowVersion: string,
): Promise<string> {
  const result = await client.query<{ anchor: string }>(
    `SELECT setting_value::jsonb->>'anchor' AS anchor FROM admin_settings
      WHERE setting_key = $1 AND setting_value::jsonb->>'rowVersion' = $2`,
    [key(pageId), rowVersion],
  );
  return result.rows[0]?.anchor ?? rowVersion;
}

/** Preserve only proven draft-only writes. The JSON comparison intentionally
 * includes every non-draft column (policy, image revision, embedding state,
 * source, title and published body), including future columns by default. */
export async function withEmbeddingDraftContinuity<T>(
  client: PoolClient, pageId: number, write: () => Promise<T>,
): Promise<T> {
  const snapshot = async () => (await client.query<{ row_version: string; stable: string }>(
    `SELECT xmin::text AS row_version,
      (to_jsonb(p) - ARRAY['draft_body_html','draft_body_text','draft_body_storage',
        'draft_updated_at','draft_updated_by','content_revision'])::text AS stable
      FROM pages p WHERE id = $1 FOR UPDATE`, [pageId],
  )).rows[0];
  const before = await snapshot();
  const anchor = before ? await embeddingDraftAnchor(client, pageId, before.row_version) : null;
  const operation = (await client.query(`SELECT * FROM embedding_ai_operations WHERE page_id = $1 FOR UPDATE`, [pageId])).rows[0];
  const result = await write();
  const after = await snapshot();
  if (before && after && before.stable === after.stable && anchor) {
    if (operation) await client.query(`INSERT INTO embedding_ai_operations
      (page_id, content_revision, image_revision, operation_id, attempt) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (page_id) DO NOTHING`,
    [pageId, operation.content_revision, operation.image_revision, operation.operation_id, operation.attempt]);
    await client.query(`INSERT INTO admin_settings (setting_key, setting_value)
      VALUES ($1, $2) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
    [key(pageId), JSON.stringify({ anchor, rowVersion: after.row_version })]);
  }
  return result;
}
