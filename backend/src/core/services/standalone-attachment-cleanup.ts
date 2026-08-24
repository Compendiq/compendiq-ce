/**
 * #1349 — remove a hard-deleted standalone page's attachment directories.
 *
 * A standalone page's bytes can sit in THREE places, all keyed by its numeric
 * PK: pasted images land in the Confluence-style tree under
 * `<ATTACHMENTS_DIR>/<pk>/` (the paste route keys standalone pages by PK —
 * `pages-crud.ts`'s writer), and draw.io saves / relocated attachments in the
 * local store under `<ATTACHMENTS_DIR>/local/<pk>/`, and an uploaded page mark
 * in the page-icon store under `<ATTACHMENTS_DIR>/page-icons/<pk>/`. The row
 * deletes remove `local_attachments` rows via CASCADE but never files, so
 * before this every standalone hard delete and every trash purge leaked all
 * three directories.
 *
 * **The Confluence-style tree's keyspace is SHARED.** Confluence DC ids are
 * numeric and sit inside `pages.id`'s range, and both kinds of page cache into
 * one tree (`attachmentPageId = source === 'standalone' ? String(id) :
 * confluence_id ?? String(id)`). So `<pk>/` is removed ONLY when no page row
 * claims `confluence_id = String(pk)` — when one does, that directory is a
 * live Confluence page's whole cache and deleting it would evict every one of
 * its attachments. The leftover standalone files inside it (if any) are the
 * orphan sweep's per-file rule's job, which reconciles filenames against every
 * body. The local store has no such ambiguity: `local/<pk>/` belongs to
 * exactly this page and is removed unconditionally.
 *
 * **This removal consults no keep-set, and that is an accepted loss, not an
 * oversight** (fixer r1, review). The sweep in the same PR holds a global
 * `Set<filename>` per store precisely because attachment URLs are copied
 * verbatim between bodies — "a filename referenced ANYWHERE is kept
 * EVERYWHERE" — and this path deliberately does not: a hard delete removes
 * `<pk>/` whole on the strength of the ownership `EXISTS` and the age check
 * alone. The reachable spelling is editor copy/paste: paste an
 * `<img src="/api/attachments/<pkA>/x.png">` out of standalone page A into
 * page B, then hard-delete A, and B's picture goes with it. CE has no
 * duplicate-page or save-as-template route, so nothing produces that sharing
 * as a product feature. It is the behaviour the issue's design of record
 * prescribes, and it is kept for two reasons: an event-driven delete that has
 * to reconcile against every body in the system is no longer best-effort
 * cleanup, and deferring to the sweep would put the ordinary case — paste,
 * delete an hour later — back on a 24-hour window on every hard delete, which
 * is the leak this module exists to close. The ADMIN-GUIDE's retention
 * section states the same caveat where an operator will read it.
 *
 * **Best-effort by contract, never throws.** Both call sites run AFTER the
 * database work has committed (the route's DELETE, the purge's batch) —
 * mirroring how the Confluence delete branch treats `cleanPageAttachments`: a
 * filesystem hiccup leaves orphaned files only, which the sweep converges, and
 * must never fail a request or a retention cycle whose DB work already
 * succeeded.
 *
 * Lives in `core` because `data-retention-service.ts` (core) is one of the two
 * callers and core may not import a domain (`backend/eslint.config.js`).
 */

import fs from 'node:fs/promises';
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { attachmentCacheDir, removeCachedAttachmentDirectory } from './attachment-store.js';
import { removeLocalAttachmentDirectory } from './local-attachment-service.js';
import { deletePageIconImage } from './page-icon-store.js';

/**
 * The `EXISTS` below asks whether a Confluence page owns the key RIGHT NOW,
 * and during a first sync the answer is "not yet": attachments are downloaded
 * into `<confluence_id>/` BEFORE the `pages` INSERT. Hard-deleting a
 * standalone page whose numeric PK equals that Confluence id inside that
 * window would delete the freshly downloaded cache (#1349 review).
 *
 * **FIVE MINUTES, deliberately not the sweep's 24 hours.** The two guards
 * answer different questions. The sweep judges directories nobody claims, so
 * its window must cover the whole "bytes exist before the row does" span at
 * its most generous. This one runs when a page really has just been destroyed
 * and its directory is by construction that page's own — so a 24h window would
 * leak the common case (paste an image, delete the page an hour later) on
 * every hard delete, which is the very leak this module exists to close.
 * The sync race it needs to cover is per-page and measured in seconds; five
 * minutes clears it with room to spare. And the leak it does admit is
 * self-healing: a pageless directory younger than five minutes becomes an
 * ordinary directory-level sweep candidate a day later.
 */
const CACHE_DIR_GRACE_MS = 5 * 60 * 1000;

export async function cleanupStandalonePageAttachmentDirs(pageId: number): Promise<void> {
  // The local store first: unambiguous ownership, so nothing to check.
  try {
    await removeLocalAttachmentDirectory(pageId);
  } catch (err) {
    logger.warn(
      { err, pageId },
      'standalone-attachment-cleanup: could not remove local attachment directory (orphaned files only — DB is consistent)',
    );
  }

  // The page-icon store (#1349 review r1). `page-icons/<pk>/` is the THIRD
  // store under this root, and until now nothing but `PUT`/`DELETE
  // /pages/:id/icon` ever removed from it — so a hard-deleted or purged page's
  // uploaded mark stayed on disk forever, and the sweep is structurally
  // forbidden from reaching it (`ATTACHMENT_ROOT_RESERVED_DIRNAMES`, which is
  // the correct call: an `rm -rf` there is unrecoverable, since migrations
  // 095/096 persist only the sha). Unlike the Confluence-style tree this
  // keyspace is NOT shared — the directory is keyed by `pages.id` alone, so
  // the row that just went is its only possible owner — and unlike that tree
  // there is no write-before-INSERT race to wait out: the icon route writes
  // only for a page that already exists. So it needs neither the ownership
  // EXISTS nor the grace window, only the same best-effort contract.
  try {
    await deletePageIconImage(pageId);
  } catch (err) {
    logger.warn(
      { err, pageId },
      'standalone-attachment-cleanup: could not remove page icon directory (orphaned files only — DB is consistent)',
    );
  }

  // The Confluence-style tree: only when no Confluence page owns the key.
  try {
    const key = String(pageId);
    const owned = await query<{ owned: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pages WHERE confluence_id = $1) AS owned`,
      [key],
    );
    if (owned.rows[0]?.owned) {
      logger.info(
        { pageId },
        'standalone-attachment-cleanup: a Confluence page owns this attachment key — leaving the directory to the orphan sweep',
      );
      return;
    }
    // …and only when the directory has aged past the first-sync race window
    // (see CACHE_DIR_GRACE_MS). ENOENT means nothing to remove; any other stat
    // failure means we cannot establish the age, and "unknown" resolves to
    // leaving it alone — the same discipline the sweep applies to a directory
    // it could not read.
    let dirStat;
    try {
      dirStat = await fs.stat(attachmentCacheDir(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return;
    }
    if (Date.now() - dirStat.mtimeMs < CACHE_DIR_GRACE_MS) {
      logger.info(
        { pageId },
        'standalone-attachment-cleanup: cache directory is younger than the grace window — leaving it to the orphan sweep',
      );
      return;
    }
    await removeCachedAttachmentDirectory(key);
  } catch (err) {
    logger.warn(
      { err, pageId },
      'standalone-attachment-cleanup: could not remove cached attachment directory (orphaned files only — DB is consistent)',
    );
  }
}
