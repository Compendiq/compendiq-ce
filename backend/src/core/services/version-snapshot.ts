import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

/**
 * Save a version snapshot before updating a page.
 * Called during sync to preserve the current state.
 * Shared table (no user_id).
 *
 * Lives in core so both confluence and knowledge domains can use it
 * without violating domain boundary rules.
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
