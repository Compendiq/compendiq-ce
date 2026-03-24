import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

/**
 * Save a version snapshot before updating a page.
 * Called during sync to preserve the current state.
 * Shared table — uses pages.id (integer PK) as the FK in page_versions.
 *
 * Accepts a confluence_id, resolves it to the internal integer page_id,
 * then inserts into page_versions(page_id, version_number, ...).
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
    const pageResult = await query<{ id: number }>(
      'SELECT id FROM pages WHERE confluence_id = $1',
      [confluenceId],
    );
    if (pageResult.rows.length === 0) {
      logger.warn({ confluenceId, versionNumber }, 'Cannot save version snapshot: page not found');
      return;
    }
    const pageId = pageResult.rows[0].id;

    await query(
      `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (page_id, version_number) DO NOTHING`,
      [pageId, versionNumber, title, bodyHtml, bodyText],
    );
  } catch (err) {
    // Never let version tracking break the sync flow
    logger.error({ err, confluenceId, versionNumber }, 'Failed to save version snapshot');
  }
}
