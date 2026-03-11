import { query } from '../db/postgres.js';
import { chat } from './ollama-service.js';
import { htmlToMarkdown } from './content-converter.js';
import { sanitizeLlmInput } from '../utils/sanitize-llm-input.js';
import { logger } from '../utils/logger.js';

export interface PageVersion {
  id: string;
  confluenceId: string;
  versionNumber: number;
  title: string;
  bodyHtml: string | null;
  bodyText: string | null;
  syncedAt: Date;
}

/**
 * Save a version snapshot before updating a page.
 * Called during sync to preserve the current state.
 * Shared table (no user_id).
 */
export async function saveVersionSnapshot(
  confluenceId: string,
  versionNumber: number,
  title: string,
  bodyHtml: string | null,
  bodyText: string | null,
): Promise<void> {
  try {
    await query(
      `INSERT INTO page_versions (confluence_id, version_number, title, body_html, body_text)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (confluence_id, version_number) DO NOTHING`,
      [confluenceId, versionNumber, title, bodyHtml, bodyText],
    );
  } catch (err) {
    // Never let version tracking break the sync flow
    logger.error({ err, confluenceId, versionNumber }, 'Failed to save version snapshot');
  }
}

/**
 * Get version history for a page.
 * Access controlled via caller verifying user has access to the page's space.
 */
export async function getVersionHistory(
  userId: string,
  confluenceId: string,
): Promise<Omit<PageVersion, 'bodyHtml' | 'bodyText'>[]> {
  const result = await query<{
    id: string;
    confluence_id: string;
    version_number: number;
    title: string;
    synced_at: Date;
  }>(
    `SELECT pv.id, pv.confluence_id, pv.version_number, pv.title, pv.synced_at
     FROM page_versions pv
     JOIN cached_pages cp ON pv.confluence_id = cp.confluence_id
     JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
     WHERE pv.confluence_id = $2
     ORDER BY pv.version_number DESC`,
    [userId, confluenceId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    confluenceId: row.confluence_id,
    versionNumber: row.version_number,
    title: row.title,
    syncedAt: row.synced_at,
  }));
}

/**
 * Get a specific version of a page.
 */
export async function getVersion(
  userId: string,
  confluenceId: string,
  versionNumber: number,
): Promise<PageVersion | null> {
  const result = await query<{
    id: string;
    confluence_id: string;
    version_number: number;
    title: string;
    body_html: string | null;
    body_text: string | null;
    synced_at: Date;
  }>(
    `SELECT pv.id, pv.confluence_id, pv.version_number, pv.title, pv.body_html, pv.body_text, pv.synced_at
     FROM page_versions pv
     JOIN cached_pages cp ON pv.confluence_id = cp.confluence_id
     JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
     WHERE pv.confluence_id = $2 AND pv.version_number = $3`,
    [userId, confluenceId, versionNumber],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    confluenceId: row.confluence_id,
    versionNumber: row.version_number,
    title: row.title,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    syncedAt: row.synced_at,
  };
}

/**
 * Generate a semantic diff between two versions using LLM.
 * Sends both versions' text to Ollama and asks for a human-readable description.
 */
export async function getSemanticDiff(
  userId: string,
  confluenceId: string,
  v1: number,
  v2: number,
  model: string,
): Promise<string> {
  const [version1, version2] = await Promise.all([
    getVersion(userId, confluenceId, v1),
    getVersion(userId, confluenceId, v2),
  ]);

  if (!version1) throw new Error(`Version ${v1} not found for page ${confluenceId}`);
  if (!version2) throw new Error(`Version ${v2} not found for page ${confluenceId}`);

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

  return chat(model, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
}
