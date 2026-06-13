import type { ConfluenceClient } from './confluence-client.js';
import { confluenceToHtml, htmlToText } from '../../../core/services/content-converter.js';
import { upsertVersionMetadata, fillVersionBody } from '../../../core/services/version-snapshot.js';
import { logger } from '../../../core/utils/logger.js';

/**
 * #722: Import the version LIST (metadata only) for a Confluence-synced page.
 *
 * Calls `getPageVersions` to retrieve all version metadata from Confluence DC
 * and upserts one `page_versions` row per version (idempotent). No bodies are
 * fetched here — those are lazily retrieved only when a version is previewed,
 * compared, or restored. Standalone/local pages (no confluence_id) must not
 * reach this function.
 */
export async function backfillVersionHistory(
  pageId: number,
  confluenceId: string,
  client: ConfluenceClient,
): Promise<{ imported: number }> {
  const versions = await client.getPageVersions(confluenceId);
  for (const v of versions) {
    await upsertVersionMetadata(pageId, v.number, `v${v.number}`, {
      editedAt: v.when ?? null,
      author: v.author,
      message: v.message,
    });
  }
  logger.info({ pageId, confluenceId, imported: versions.length }, '#722: backfilled version metadata');
  return { imported: versions.length };
}

/**
 * #722: Lazily fetch and persist a historical body for a version row that was
 * created by `backfillVersionHistory` (metadata-only, body_html IS NULL).
 *
 * Fetches the storage XHTML from Confluence DC, converts it to clean HTML via
 * `confluenceToHtml` (ADR-003), derives plain text, persists via `fillVersionBody`,
 * and returns the converted HTML + text so the caller can return them immediately
 * without a second DB read.
 */
export async function getHistoricalBody(
  pageId: number,
  confluenceId: string,
  versionNumber: number,
  client: ConfluenceClient,
): Promise<{ bodyHtml: string; bodyText: string }> {
  const storage = await client.getHistoricalPageBody(confluenceId, versionNumber);
  const bodyHtml = confluenceToHtml(storage, confluenceId);
  const bodyText = htmlToText(bodyHtml);
  await fillVersionBody(pageId, versionNumber, bodyHtml, bodyText);
  return { bodyHtml, bodyText };
}
