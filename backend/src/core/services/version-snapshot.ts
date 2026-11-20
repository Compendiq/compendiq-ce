import type { PoolClient } from 'pg';
import { PageWriteError } from './page-write-admission.js';
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

/**
 * Upsert Confluence version metadata (editedAt, author, message) for a page
 * version. Inserts a new metadata-only row when none exists; updates the
 * metadata columns on conflict, using COALESCE so existing values are never
 * overwritten with NULL. Idempotent.
 *
 * Lives in core so version-backfill (confluence domain) can call it without
 * crossing the domain boundary into knowledge.
 */
export async function upsertVersionMetadata(
  pageId: number,
  versionNumber: number,
  title: string,
  meta: { editedAt: string | Date | null; author: string | null; message: string | null },
): Promise<void> {
  await query(
    `INSERT INTO page_versions (page_id, version_number, title, edited_at, author, message)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (page_id, version_number) DO UPDATE SET
       edited_at = COALESCE(EXCLUDED.edited_at, page_versions.edited_at),
       author    = COALESCE(EXCLUDED.author, page_versions.author),
       message   = COALESCE(EXCLUDED.message, page_versions.message),
       title     = EXCLUDED.title`,
    [pageId, versionNumber, title, meta.editedAt, meta.author, meta.message],
  );
}

/**
 * Fill in body_html / body_text for a version row that has no body yet
 * (metadata-only rows created by backfillVersionHistory). The WHERE clause
 * ensures we never overwrite an existing body.
 */
export async function fillVersionBody(
  pageId: number,
  versionNumber: number,
  bodyHtml: string,
  bodyText: string,
): Promise<void> {
  await query(
    `UPDATE page_versions SET body_html = $3, body_text = $4
       WHERE page_id = $1 AND version_number = $2 AND body_html IS NULL`,
    [pageId, versionNumber, bodyHtml, bodyText],
  );
}

/**
 * Insert a version snapshot for a page given its internal integer `page_id`.
 *
 * `page_id` is the universal FK in `page_versions` (migration 030), so this
 * works for both Confluence-synced and standalone/local pages. Idempotent —
 * re-inserting an existing (page_id, version_number) is a no-op.
 *
 * This is ordinary best-effort history, never baseline evidence. A baseline
 * protects only the exact snapshot it explicitly links through
 * `page_baselines.version_snapshot_id`; inserting here creates no such link.
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
 * `confluence_id`.
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

/**
 * Preserve the locked local version before overwriting it. The caller must
 * hold the page row lock and use the same transaction for the snapshot and
 * overwrite, so both commit or roll back together.
 *
 * Claims a body-less history placeholder unless a baseline references it.
 * An existing identical snapshot is sufficient. Different content raises
 * local_edit_snapshot_conflict, and database errors propagate to the caller.
 */
export async function snapshotLocalVersionBeforeOverwrite(
  client: PoolClient,
  row: { id: number; version: number; title: string; body_html: string | null; body_text: string | null },
): Promise<void> {
  const stored = await client.query(
    `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (page_id, version_number) DO UPDATE
       SET title = EXCLUDED.title, body_html = EXCLUDED.body_html,
           body_text = EXCLUDED.body_text, synced_at = NOW()
       WHERE page_versions.body_html IS NULL
         AND NOT EXISTS (SELECT 1 FROM page_baselines b WHERE b.version_snapshot_id = page_versions.id)`,
    [row.id, row.version, row.title, row.body_html, row.body_text],
  );
  if ((stored.rowCount ?? 0) > 0) return;
  const preserved = await client.query(
    `SELECT 1 FROM page_versions
      WHERE page_id = $1 AND version_number = $2 AND title IS NOT DISTINCT FROM $3
        AND body_html IS NOT DISTINCT FROM $4 AND body_text IS NOT DISTINCT FROM $5`,
    [row.id, row.version, row.title, row.body_html, row.body_text],
  );
  if (preserved.rowCount === 0) {
    throw new PageWriteError(
      409,
      'local_edit_snapshot_conflict',
      `Version ${row.version} in the page's version history already holds other content, so the local edit `
        + 'could not be stored there and was kept; saving the page with the Confluence integration off gives it a new version number',
    );
  }
}
