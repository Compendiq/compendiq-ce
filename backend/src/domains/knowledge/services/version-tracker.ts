import { query, getPool } from '../../../core/db/postgres.js';
import { resolveUsecase } from '../../llm/services/llm-provider-resolver.js';
import { chat } from '../../llm/services/openai-compatible-client.js';
import { htmlToMarkdown, htmlToText } from '../../../core/services/content-converter.js';
import { sanitizeLlmInput } from '../../../core/utils/sanitize-llm-input.js';

// Re-export from core so existing consumers keep working
export { saveVersionSnapshot, saveVersionSnapshotByPageId } from '../../../core/services/version-snapshot.js';

interface PageVersion {
  id: string;
  pageId: number;
  confluenceId: string | null;
  versionNumber: number;
  title: string;
  bodyHtml: string | null;
  bodyText: string | null;
  syncedAt: Date;
}

/**
 * Get version history for a page, keyed by the internal integer `page_id`.
 *
 * History is stored against `page_versions.page_id` (the universal FK since
 * migration 030), so both Confluence-synced and standalone/local pages surface
 * their snapshots here. RBAC is enforced by the caller before this runs (the
 * route resolves and access-checks the page first).
 */
export async function getVersionHistory(
  pageId: number,
): Promise<Omit<PageVersion, 'bodyHtml' | 'bodyText'>[]> {
  const result = await query<{
    id: string;
    page_id: number;
    confluence_id: string | null;
    version_number: number;
    title: string;
    synced_at: Date;
  }>(
    `SELECT pv.id, pv.page_id, p.confluence_id, pv.version_number, pv.title, pv.synced_at
     FROM page_versions pv
     JOIN pages p ON pv.page_id = p.id
     WHERE pv.page_id = $1
       AND p.deleted_at IS NULL
     ORDER BY pv.version_number DESC`,
    [pageId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    pageId: row.page_id,
    confluenceId: row.confluence_id,
    versionNumber: row.version_number,
    title: row.title,
    syncedAt: row.synced_at,
  }));
}

/**
 * Get a specific version of a page by internal `page_id` + version number.
 * RBAC is enforced by the caller before this runs.
 */
export async function getVersion(
  pageId: number,
  versionNumber: number,
): Promise<PageVersion | null> {
  const result = await query<{
    id: string;
    page_id: number;
    confluence_id: string | null;
    version_number: number;
    title: string;
    body_html: string | null;
    body_text: string | null;
    synced_at: Date;
  }>(
    `SELECT pv.id, pv.page_id, p.confluence_id, pv.version_number, pv.title, pv.body_html, pv.body_text, pv.synced_at
     FROM page_versions pv
     JOIN pages p ON pv.page_id = p.id
     WHERE pv.page_id = $1
       AND p.deleted_at IS NULL
       AND pv.version_number = $2`,
    [pageId, versionNumber],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0]!;
  return {
    id: row.id,
    pageId: row.page_id,
    confluenceId: row.confluence_id,
    versionNumber: row.version_number,
    title: row.title,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    syncedAt: row.synced_at,
  };
}

export interface RestoreResult {
  pageId: number;
  title: string;
  /** New live version after the restore (old version + bump). */
  newVersion: number;
  bodyHtml: string | null;
  bodyText: string | null;
}

/**
 * Non-destructive, Confluence-style restore of an older snapshot.
 *
 * In a single transaction:
 *   1. Snapshot the CURRENT live state into `page_versions` (so the revert is
 *      itself reversible and intermediate manual edits aren't lost — a plain
 *      edit-save does not snapshot, only sync/draft-publish/this path do).
 *   2. Apply the target snapshot's title / body_html / body_text to the live
 *      `pages` row, re-deriving body_text from body_html when needed.
 *   3. Bump `version` and mark the page `embedding_dirty` so the change flows
 *      through search/embedding the same way an edit-save does.
 *
 * The Confluence push (for synced pages) and audit/webhook events are the
 * caller's responsibility — this keeps the domain service DB-only and lets the
 * route reuse the exact edit-save side-effect path.
 *
 * @returns the applied content + new version, or `null` if the target version
 *          doesn't exist for the page.
 */
export async function restoreVersion(
  pageId: number,
  targetVersion: number,
): Promise<RestoreResult | null> {
  const txClient = await getPool().connect();
  try {
    await txClient.query('BEGIN');

    // Lock the live row so concurrent edits/restores serialise.
    const liveRes = await txClient.query<{
      version: number;
      title: string;
      body_html: string | null;
      body_text: string | null;
    }>(
      `SELECT version, title, body_html, body_text
       FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [pageId],
    );
    if (liveRes.rows.length === 0) {
      await txClient.query('ROLLBACK');
      return null;
    }
    const live = liveRes.rows[0]!;

    // Load the target snapshot to restore.
    const targetRes = await txClient.query<{
      title: string;
      body_html: string | null;
      body_text: string | null;
    }>(
      `SELECT title, body_html, body_text
       FROM page_versions WHERE page_id = $1 AND version_number = $2`,
      [pageId, targetVersion],
    );
    if (targetRes.rows.length === 0) {
      await txClient.query('ROLLBACK');
      return null;
    }
    const target = targetRes.rows[0]!;

    // 1. Snapshot the current live state first (idempotent — DO NOTHING if the
    //    live version already has a snapshot, e.g. from a prior sync).
    await txClient.query(
      `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text, synced_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (page_id, version_number) DO NOTHING`,
      [pageId, live.version, live.title, live.body_html, live.body_text],
    );

    // 2 + 3. Apply the target snapshot as a NEW live version.
    const newVersion = live.version + 1;
    const restoredBodyText = target.body_text ?? (target.body_html ? htmlToText(target.body_html) : null);
    await txClient.query(
      `UPDATE pages SET
         title = $2, body_html = $3, body_text = $4,
         version = $5, last_modified_at = NOW(), embedding_dirty = TRUE,
         embedding_status = 'not_embedded', embedded_at = NULL,
         local_modified_at = NOW()
       WHERE id = $1`,
      [pageId, target.title, target.body_html, restoredBodyText, newVersion],
    );

    await txClient.query('COMMIT');

    return {
      pageId,
      title: target.title,
      newVersion,
      bodyHtml: target.body_html,
      bodyText: restoredBodyText,
    };
  } catch (err) {
    await txClient.query('ROLLBACK');
    throw err;
  } finally {
    txClient.release();
  }
}

/**
 * Generate a semantic diff between two versions using LLM.
 *
 * Sends both versions' text to the LLM and asks for a human-readable
 * description. `model` is an optional caller override; when falsy the `chat`
 * use-case assignment (resolved below) supplies the concrete model, so the
 * route never has to depend on a hardcoded model name (ADR-021).
 */
export async function getSemanticDiff(
  pageId: number,
  v1: number,
  v2: number,
  model?: string,
): Promise<string> {
  const [version1, version2] = await Promise.all([
    getVersion(pageId, v1),
    getVersion(pageId, v2),
  ]);

  if (!version1) throw new Error(`Version ${v1} not found for page ${pageId}`);
  if (!version2) throw new Error(`Version ${v2} not found for page ${pageId}`);

  // Convert to markdown for LLM consumption
  const text1 = version1.bodyHtml ? htmlToMarkdown(version1.bodyHtml) : (version1.bodyText ?? '');
  const text2 = version2.bodyHtml ? htmlToMarkdown(version2.bodyHtml) : (version2.bodyText ?? '');

  // Truncate to prevent excessive LLM input
  const maxLen = 8000;
  const t1 = text1.length > maxLen ? text1.slice(0, maxLen) + '\n[...truncated]' : text1;
  const t2 = text2.length > maxLen ? text2.slice(0, maxLen) + '\n[...truncated]' : text2;

  const { sanitized: sanitized1 } = sanitizeLlmInput(t1);
  const { sanitized: sanitized2 } = sanitizeLlmInput(t2);

  const systemPrompt = `You are a technical documentation reviewer. Compare the two versions of a document below and provide a concise, human-readable summary of what changed between them. Focus on:
1. Content additions (new sections, paragraphs, information)
2. Content removals (deleted sections, information)
3. Content modifications (rewording, restructuring)
4. Significance of changes (is this a minor edit or major revision?)

Format your response as a clear bullet-point list. Be specific about what changed.`;

  const userPrompt = `## Version ${v1} (Title: "${version1.title}")
${sanitized1}

---

## Version ${v2} (Title: "${version2.title}")
${sanitized2}`;

  const { config, model: resolvedModel } = await resolveUsecase('chat');
  return chat(config, model || resolvedModel, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
}
