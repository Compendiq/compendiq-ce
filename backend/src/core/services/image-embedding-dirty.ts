/**
 * #1115 P2 — raising `pages.image_embedding_dirty`.
 *
 * **The flag is the queue.** `processDirtyPageImages` walks nothing else, so a
 * write that does not raise it leaves `page_image_embeddings` describing bytes
 * that have changed or gone — and nothing ever notices, because a stale row
 * and a correct one are the same shape. That is the failure mode this module
 * exists to make hard to reintroduce: one place, two entry points, every
 * writer calling one of them.
 *
 * **It lives in `core` because its callers are spread across three layers**
 * that cannot import each other — `domains/confluence` (the sync attachment
 * writers), `domains/knowledge` (the relocate) and `routes/knowledge` (paste,
 * import and the local draw.io save). `core` is the only place all three may
 * reach (`backend/eslint.config.js:50-53`).
 *
 * **`embedding_dirty` is never touched here**, and that is the whole reason
 * migration 093 gave the two flags separate columns: an attachment changing
 * under an *unchanged page version* must re-embed the images and not the text.
 * A shared `SET … = TRUE` would silently re-chunk and re-embed the corpus every
 * time somebody pasted a screenshot.
 *
 * Neither function throws for a page it cannot find. They are called from the
 * tail of a write that has already succeeded, and a whole sync must not die on
 * the way to raising a flag — a missed flag costs one stale row until the next
 * write or re-scan, an exception costs the sync.
 */
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

/**
 * Raise the flag for one page, by its numeric primary key.
 *
 * Folders and soft-deleted pages are excluded, matching the worker's own
 * `WHERE`: marking them sets a flag no scan will ever clear, which shows up on
 * the Embeddings card as a backlog that never drains.
 */
export async function markPageImagesDirty(pageId: number): Promise<void> {
  try {
    await query(
      `UPDATE pages SET image_embedding_dirty = TRUE
        WHERE id = $1 AND deleted_at IS NULL AND COALESCE(page_type, 'page') != 'folder'`,
      [pageId],
    );
  } catch (err) {
    logger.warn({ err, pageId }, 'Could not mark a page image_embedding_dirty');
  }
}

/**
 * Largest value `pages.id` (an `INTEGER`) can hold. A key above it is a
 * Confluence id, not a page id, and casting it would raise `22003` rather than
 * miss.
 */
const PG_INT4_MAX = 2_147_483_647;

/**
 * Raise the flag for whichever page owns an ATTACHMENT DIRECTORY KEY.
 *
 * The Confluence-style tree is keyed by `confluence_id` for a Confluence page
 * and by the numeric id otherwise — `parentKeyFor`'s rule, restated in
 * `attachment-store.ts` — and the sync writers only ever hold that key, never
 * the row.
 *
 * **Two statements, not one `OR`, and both are index-sargable.** This runs once
 * per page that downloaded an attachment, so on a full sync of a large space it
 * runs thousands of times. `confluence_id = $1 OR id::text = $1` looks tidier
 * and is a sequential scan of `pages` every time, because the cast makes the
 * second half unusable by the primary key. So: the indexed lookup first, and
 * the id lookup only when it matched nothing.
 *
 * **The numeric parse happens in JS, deliberately.** `$1::int` throws on a
 * non-numeric key — the fixtures here use `page-1`, and Confluence ids are not
 * contractually numeric — and it *overflows* on a real Confluence id, which is
 * routinely wider than `INTEGER`. Turning a bookkeeping update into an aborted
 * sync is the worse failure by a wide margin. `String(parsed) === key` also
 * refuses a zero-padded `007`, which would otherwise mark page 7.
 */
export async function markPageImagesDirtyByAttachmentKey(attachmentKey: string): Promise<void> {
  if (!attachmentKey) return;
  try {
    const byConfluenceId = await query(
      `UPDATE pages SET image_embedding_dirty = TRUE
        WHERE confluence_id = $1
          AND deleted_at IS NULL
          AND COALESCE(page_type, 'page') != 'folder'`,
      [attachmentKey],
    );
    if ((byConfluenceId.rowCount ?? 0) > 0) return;

    const asId = Number(attachmentKey);
    if (
      !Number.isInteger(asId) ||
      asId <= 0 ||
      asId > PG_INT4_MAX ||
      String(asId) !== attachmentKey
    ) {
      return;
    }
    await query(
      `UPDATE pages SET image_embedding_dirty = TRUE
        WHERE id = $1
          AND source <> 'confluence'
          AND deleted_at IS NULL
          AND COALESCE(page_type, 'page') != 'folder'`,
      [asId],
    );
  } catch (err) {
    logger.warn({ err, attachmentKey }, 'Could not mark a page image_embedding_dirty by attachment key');
  }
}
