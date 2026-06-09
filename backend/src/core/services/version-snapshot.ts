import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

/**
 * Insert a version snapshot for a page given its internal integer `page_id`.
 *
 * `page_id` is the universal FK in `page_versions` (migration 030), so this
 * works for both Confluence-synced and standalone/local pages. Idempotent —
 * re-inserting an existing (page_id, version_number) is a no-op.
 *
 * Lives in core so both the confluence and knowledge domains can use it
 * without violating domain boundary rules.
 */
export async function saveVersionSnapshotByPageId(
  pageId: number,
  versionNumber: number,
  title: string,
  bodyHtml: string | null,
  bodyText: string | null,
): Promise<void> {
  try {
    await query(
      `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (page_id, version_number) DO NOTHING`,
      [pageId, versionNumber, title, bodyHtml, bodyText],
    );
  } catch (err) {
    // Never let version tracking break the sync flow
    logger.error({ err, pageId, versionNumber }, 'Failed to save version snapshot');
  }
}

/**
 * Save a version snapshot before updating a page, resolving from a
 * `confluence_id`. Called during sync to preserve the current state.
 *
 * Resolves the confluence_id to the internal integer `page_id`, then delegates
 * to {@link saveVersionSnapshotByPageId}.
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
    await saveVersionSnapshotByPageId(
      pageResult.rows[0]!.id,
      versionNumber,
      title,
      bodyHtml,
      bodyText,
    );
  } catch (err) {
    // Never let version tracking break the sync flow
    logger.error({ err, confluenceId, versionNumber }, 'Failed to save version snapshot');
  }
}
