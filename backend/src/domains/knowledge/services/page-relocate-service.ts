/**
 * Relocate an article between a local space and Confluence (#1123).
 *
 * This is the only code path in the app that mutates `pages.source` after
 * insert, so it is also the only one that changes which identifier a page's
 * children must store in `parent_id`. The whole local side runs in one
 * transaction under {@link PAGE_MOVE_ADVISORY_LOCK_ID}; the irreversible
 * upstream call is ordered so that no failure can destroy the user's article.
 *
 * ## Ordering (the part that matters)
 *
 * **local → Confluence.** Create upstream FIRST, commit `confluence_id` LAST.
 * Between the two, the row still has `confluence_id IS NULL`, so
 * `detectDeletedPages` — whose candidate query is
 * `WHERE space_key=$1 AND deleted_at IS NULL AND confluence_id IS NOT NULL` —
 * cannot see it. Committing a `confluence_id` for a page the upstream create
 * never produced would get the article soft-deleted on the next sync; that is
 * structurally impossible here. If anything after the create fails, the
 * just-created Confluence page is deleted again and nothing local changed.
 *
 * **Confluence → local.** Commit the local flip FIRST, delete upstream after.
 * Once `confluence_id` is NULL the article is permanently outside deletion
 * reconciliation's reach. The inverse order — delete upstream, then commit —
 * would leave a window where a committed-`confluence_id` row points at a
 * trashed page, which reconciliation resolves by soft-deleting the user's
 * article. If the upstream delete then fails, we confirm via `getPage()`
 * whether it actually succeeded (404 / `status: 'trashed'`, exactly the test
 * `detectDeletedPages` uses); only if the page is provably still live do we
 * compensate by restoring the pre-move state, so neither side changed.
 *
 * ## Filesystem
 *
 * Attachment files cannot join a database transaction. Bytes are COPIED to the
 * new key before COMMIT (an abort leaves the originals untouched) and the old
 * directory is removed only after COMMIT, best-effort — the same split
 * `pages-crud`'s delete flow uses. Worst case is an orphaned directory, never
 * a missing image.
 */

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import type { PoolClient } from 'pg';
import { query, getPool } from '../../../core/db/postgres.js';
import { PAGE_MOVE_ADVISORY_LOCK_ID } from '../../../core/db/advisory-locks.js';
import { logger } from '../../../core/utils/logger.js';
import {
  htmlToConfluence,
  confluenceToHtml,
  htmlToText,
} from '../../../core/services/content-converter.js';
import {
  listCachedAttachments,
  readCachedAttachmentFile,
  writeAttachmentCacheAt,
  removeAttachmentDirectory,
  getMimeType,
} from '../../confluence/services/attachment-handler.js';
import {
  listLocalAttachmentsForRelocate,
  writeLocalAttachmentFileForRelocate,
  localAttachmentsDir,
} from '../../../core/services/local-attachment-service.js';
import {
  ConfluenceError,
  type ConfluenceClient,
} from '../../confluence/services/confluence-client.js';
import type { RelocatePageInput, RelocatePageResponse } from '@compendiq/contracts';

/** Error carrying the HTTP status the route should surface. */
export class RelocateError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RelocateError';
  }
}

/** The page columns a relocate reads and restores. */
export interface RelocatablePage {
  id: number;
  title: string;
  source: string;
  space_key: string | null;
  confluence_id: string | null;
  visibility: string;
  created_by_user_id: string | null;
  body_html: string | null;
  body_storage: string | null;
  version: number;
}

export const RELOCATABLE_COLUMNS =
  'id, title, source, space_key, confluence_id, visibility, created_by_user_id, body_html, body_storage, version';

/** Everything the compensating restore needs; captured before any mutation. */
interface PreMoveSnapshot extends RelocatablePage {
  /** Direct children that stored the pre-move identifier. */
  childIds: number[];
  oldKey: string;
}

/**
 * The identifier a page's children store in `parent_id`: its `confluence_id`
 * when Confluence-sourced, its numeric id as text when standalone. This is the
 * dual-identifier scheme the tree CTE resolves with
 * `COALESCE(t.confluence_id, t.id::text)` (`pages-crud.ts`).
 */
export function parentKeyFor(source: string, id: number, confluenceId: string | null): string {
  return source === 'confluence' && confluenceId ? confluenceId : String(id);
}

/**
 * Refuse the move when the identifier a child would resolve against is not
 * unique across the table.
 *
 * `parent_id` is an unconstrained TEXT column resolved against *either*
 * `confluence_id` *or* `id::text`, and Confluence DC page ids are numeric
 * strings — so a standalone page with `id = 1234567` and a Confluence page
 * with `confluence_id = '1234567'` are indistinguishable to every reader. If
 * either the old or the new key collides, rewriting `parent_id = <key>` would
 * silently re-parent another page's children. Detect it and refuse rather than
 * corrupt the tree.
 */
async function assertIdentifierUnambiguous(
  key: string,
  pageId: number,
  label: string,
): Promise<void> {
  const clash = await query<{ id: number; title: string }>(
    `SELECT id, title FROM pages
      WHERE deleted_at IS NULL AND id <> $2 AND (confluence_id = $1 OR id::text = $1)`,
    [key, pageId],
  );
  const first = clash.rows[0];
  if (first) {
    throw new RelocateError(
      409,
      `Cannot relocate: the ${label} identifier "${key}" is also used by page ${first.id} ` +
        `("${first.title}"), so re-pointing child pages would be ambiguous.`,
      { conflictingPageId: first.id },
    );
  }
}

/**
 * Rewrite attachment URLs in editor HTML from one or more source prefixes to a
 * single destination prefix, returning the new HTML and the filenames touched.
 *
 * Both attachment stores appear in `body_html`:
 * `/api/attachments/<key>/<file>` (the Confluence cache — also where pasted
 * images on standalone pages land) and `/api/local-attachments/<id>/<file>`
 * (the local store). A relocate changes the key, so every reference must
 * follow.
 *
 * When `markAsConfluenceAttachment` is set, each rewritten `<img>` also gets
 * `data-confluence-filename` / `data-confluence-image-source`. That is what
 * `htmlToConfluence` reads to emit a correct `ri:attachment`; without it the
 * converter falls back to the last path segment of the src, and images from
 * the local store are not matched by its `img[src^="/api/attachments/"]`
 * selector at all — they would survive into storage format as raw `<img>`.
 */
export function rewriteAttachmentRefs(
  html: string,
  fromPrefixes: string[],
  toPrefix: string,
  markAsConfluenceAttachment: boolean,
): { html: string; filenames: string[] } {
  if (!html) return { html, filenames: [] };
  if (!fromPrefixes.some((p) => html.includes(p))) return { html, filenames: [] };

  const dom = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' });
  const doc = dom.window.document;
  const filenames = new Set<string>();
  let changed = false;

  const rewriteOne = (el: Element, attr: string): void => {
    const value = el.getAttribute(attr) ?? '';
    const matched = fromPrefixes.find((p) => value.startsWith(p));
    if (matched === undefined) return;
    const encodedName = value.slice(matched.length);
    if (!encodedName || encodedName.includes('/')) return;
    let filename: string;
    try {
      filename = decodeURIComponent(encodedName);
    } catch {
      filename = encodedName;
    }
    filenames.add(filename);
    el.setAttribute(attr, `${toPrefix}${encodeURIComponent(filename)}`);
    if (markAsConfluenceAttachment && el.tagName.toLowerCase() === 'img') {
      // An external-URL image round-trips as ri:url, not ri:attachment —
      // leave its markers alone or htmlToConfluence emits the wrong element.
      if (el.getAttribute('data-confluence-image-source') !== 'external-url') {
        el.setAttribute('data-confluence-filename', filename);
        el.setAttribute('data-confluence-image-source', 'attachment');
      }
    }
    changed = true;
  };

  for (const img of doc.querySelectorAll('img[src]')) rewriteOne(img, 'src');
  for (const anchor of doc.querySelectorAll('a[href]')) rewriteOne(anchor, 'href');

  return { html: changed ? doc.body.innerHTML : html, filenames: [...filenames] };
}

/** Direct children of a page under a given identifier flavour. */
async function loadChildIds(key: string, pageId: number): Promise<number[]> {
  const res = await query<{ id: number }>(
    'SELECT id FROM pages WHERE parent_id = $1 AND deleted_at IS NULL AND id <> $2 ORDER BY id',
    [key, pageId],
  );
  return res.rows.map((r) => r.id);
}

/** Number of local version snapshots a move to Confluence would discard. */
export async function countLocalVersions(pageId: number): Promise<number> {
  const res = await query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM page_versions WHERE page_id = $1',
    [pageId],
  );
  return parseInt(res.rows[0]?.count ?? '0', 10);
}

/** Every attachment filename a page owns, across both stores. */
export async function collectAttachmentFilenames(page: {
  id: number;
  source: string;
  confluence_id: string | null;
}): Promise<string[]> {
  const names = new Set<string>();
  for (const name of await listCachedAttachments(parentKeyFor(page.source, page.id, page.confluence_id))) {
    names.add(name);
  }
  if (page.source === 'standalone') {
    // A standalone page's pasted images land in the Confluence cache keyed by
    // its numeric id (`POST /pages/:id/images`), while draw.io saves and
    // explicit uploads land in the local store. Both must migrate.
    for (const row of await listLocalAttachmentsForRelocate(page.id)) names.add(row.filename);
  }
  return [...names];
}

/** Read an attachment's bytes from whichever store currently holds it. */
async function readAttachmentBytes(
  page: { id: number; source: string; confluence_id: string | null },
  filename: string,
): Promise<Buffer | null> {
  const cached = await readCachedAttachmentFile(
    parentKeyFor(page.source, page.id, page.confluence_id),
    filename,
  );
  if (cached) return cached;
  if (page.source !== 'standalone') return null;
  const row = (await listLocalAttachmentsForRelocate(page.id)).find((r) => r.filename === filename);
  if (!row) return null;
  try {
    return await fs.readFile(row.path);
  } catch {
    return null;
  }
}

/**
 * Take the page row for update inside the caller's transaction, re-reading it
 * under both the advisory lock and a row lock so nothing observed during the
 * pre-checks can have changed underneath.
 */
async function lockAndReload(txClient: PoolClient, pageId: number): Promise<RelocatablePage> {
  await txClient.query('SELECT pg_advisory_xact_lock($1)', [PAGE_MOVE_ADVISORY_LOCK_ID]);
  const fresh = await txClient.query<RelocatablePage>(
    `SELECT ${RELOCATABLE_COLUMNS} FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [pageId],
  );
  const row = fresh.rows[0];
  if (!row) throw new RelocateError(404, 'Page not found');
  return row;
}

/**
 * Resolve the Confluence id of a page's parent, if the parent is itself a
 * Confluence page. A standalone parent has no upstream counterpart, so the
 * relocated page is created at the target space's root.
 */
async function resolveConfluenceParent(pageId: number): Promise<string | null> {
  const res = await query<{ confluence_id: string | null }>(
    `SELECT parent.confluence_id
       FROM pages child
       JOIN pages parent
         ON (parent.confluence_id = child.parent_id OR parent.id::text = child.parent_id)
      WHERE child.id = $1 AND parent.deleted_at IS NULL AND parent.confluence_id IS NOT NULL
      LIMIT 1`,
    [pageId],
  );
  return res.rows[0]?.confluence_id ?? null;
}

/** Move a standalone article into Confluence. */
async function relocateToConfluence(opts: {
  page: RelocatablePage;
  userId: string;
  spaceKey: string;
  client: ConfluenceClient;
  expectedVersionCount: number;
}): Promise<RelocatePageResponse> {
  const { page, userId, spaceKey, client } = opts;
  const oldKey = String(page.id);
  const warnings: string[] = [];

  await assertIdentifierUnambiguous(oldKey, page.id, 'current');

  const versionCount = await countLocalVersions(page.id);
  if (versionCount !== opts.expectedVersionCount) {
    throw new RelocateError(
      409,
      `Version count changed: ${versionCount} local version(s) would be discarded, but the ` +
        `confirmation acknowledged ${opts.expectedVersionCount}. Reload and confirm again.`,
      { localVersionCount: versionCount },
    );
  }

  // Read every attachment's bytes BEFORE the upstream create, so a missing
  // file is noticed while nothing has happened yet.
  const payloads: Array<{ filename: string; data: Buffer }> = [];
  for (const filename of await collectAttachmentFilenames(page)) {
    const data = await readAttachmentBytes(page, filename);
    if (data === null) {
      warnings.push(`Attachment "${filename}" is referenced but missing on disk; it was not published.`);
      continue;
    }
    payloads.push({ filename, data });
  }

  // Normalise every attachment reference onto the Confluence-cache form and
  // tag it, so `htmlToConfluence` emits a correct `ri:attachment` for images
  // from BOTH stores. Storage format references attachments by filename only,
  // so this body is already key-independent and can be sent upstream as-is.
  const { html: normalisedHtml } = rewriteAttachmentRefs(
    page.body_html ?? '',
    [`/api/attachments/${encodeURIComponent(oldKey)}/`, `/api/local-attachments/${page.id}/`],
    `/api/attachments/${encodeURIComponent(oldKey)}/`,
    true,
  );
  const storageBody = htmlToConfluence(normalisedHtml);
  const parentConfluenceId = await resolveConfluenceParent(page.id);

  // 1. Create the page upstream. Nothing local points at it yet, so a failure
  //    from here on is fully reversible by deleting it again.
  const created = await client.createPage(
    spaceKey,
    page.title,
    storageBody,
    parentConfluenceId ?? undefined,
  );
  const newConfluenceId = created.id;

  try {
    await assertIdentifierUnambiguous(newConfluenceId, page.id, 'new Confluence');

    // 2. Upload the bytes. A failure aborts the move: an article whose
    //    `ri:attachment` references point at files that were never uploaded
    //    renders with broken images on both sides.
    for (const { filename, data } of payloads) {
      await client.updateAttachment(newConfluenceId, filename, data, getMimeType(filename));
    }

    // 3. Stage the cache under the new key (copy — the old key stays intact
    //    until after COMMIT).
    for (const { filename, data } of payloads) {
      await writeAttachmentCacheAt(newConfluenceId, filename, data);
    }

    // Re-derive the local body from the storage Confluence accepted, exactly
    // as `POST /api/pages` does — this is what re-keys every `<img src>` onto
    // the new confluence id.
    const finalStorage = created.body?.storage?.value ?? storageBody;
    const finalHtml = confluenceToHtml(finalStorage, newConfluenceId, spaceKey);
    const finalText = htmlToText(finalHtml);

    // 4. One transaction for the entire local side.
    const txClient = await getPool().connect();
    try {
      await txClient.query('BEGIN');
      const fresh = await lockAndReload(txClient, page.id);
      if (fresh.source !== 'standalone' || fresh.confluence_id !== null) {
        throw new RelocateError(409, 'Page was relocated by someone else while this move was in flight');
      }

      await txClient.query(
        `UPDATE pages SET
           source = 'confluence',
           confluence_id = $2,
           space_key = $3,
           body_html = $4,
           body_storage = $5,
           body_text = $6,
           -- Confluence has no standalone-visibility analogue; the space's
           -- RBAC governs access from here. Normalising to 'shared' keeps a
           -- stale 'private' from resurfacing if the page is moved back.
           visibility = 'shared',
           version = $7,
           last_synced = NOW(),
           embedding_dirty = TRUE,
           embedding_status = 'not_embedded',
           embedded_at = NULL
         WHERE id = $1`,
        [page.id, newConfluenceId, spaceKey, finalHtml, finalStorage, finalText, created.version.number],
      );

      // Every direct child stored the numeric id; they must now store the
      // confluence_id or the tree CTE stops resolving them.
      const repointed = await txClient.query(
        'UPDATE pages SET parent_id = $2 WHERE parent_id = $1 AND deleted_at IS NULL AND id <> $3',
        [oldKey, newConfluenceId, page.id],
      );

      // Decision 3: local history is discarded — Confluence is the historian now.
      const discarded = await txClient.query('DELETE FROM page_versions WHERE page_id = $1', [page.id]);

      // The local attachment store rejects non-standalone pages outright, so
      // these rows would be stranded. The bytes are in Confluence and in the
      // Confluence cache under the new key.
      await txClient.query('DELETE FROM local_attachments WHERE page_id = $1', [page.id]);

      await txClient.query('COMMIT');

      return {
        pageId: page.id,
        source: 'confluence',
        spaceKey,
        confluenceId: newConfluenceId,
        childrenRepointed: repointed.rowCount ?? 0,
        versionsDiscarded: discarded.rowCount ?? 0,
        attachmentsMigrated: payloads.length,
        upstreamDeleted: false,
        warnings,
      };
    } catch (err) {
      await txClient.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      txClient.release();
    }
  } catch (err) {
    // Nothing local changed. Remove the page we created upstream so retries do
    // not accumulate orphans and the next sync does not import it.
    try {
      await client.deletePage(newConfluenceId);
    } catch (cleanupErr) {
      logger.error(
        {
          pageId: page.id,
          userId,
          confluenceId: newConfluenceId,
          err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        },
        'Relocate aborted but the newly created Confluence page could not be deleted — the next sync will import it as a new page',
      );
    }
    if (newConfluenceId !== oldKey) {
      await removeAttachmentDirectory(newConfluenceId).catch(() => undefined);
    }
    throw err;
  }
}

/**
 * Move a Confluence-sourced article into a local space, deleting the upstream
 * page (product decision 1: this is a true move, not a detach — a detach would
 * be re-imported as a duplicate by the next `syncSpace`).
 */
async function relocateToLocal(opts: {
  page: RelocatablePage;
  userId: string;
  spaceKey: string | null;
  visibility: 'private' | 'shared';
  client: ConfluenceClient;
}): Promise<RelocatePageResponse> {
  const { page, userId, spaceKey, visibility, client } = opts;
  const oldConfluenceId = page.confluence_id!;
  const newKey = String(page.id);
  const warnings: string[] = [];

  await assertIdentifierUnambiguous(oldConfluenceId, page.id, 'current');
  await assertIdentifierUnambiguous(newKey, page.id, 'new local');

  // Stage attachment bytes into the LOCAL store before the commit. A standalone
  // page's diagrams are fetched from `/api/local-attachments/<id>/…`, so leaving
  // them in the Confluence cache would break inline draw.io editing after the
  // move, and the cache's on-miss refetch has no upstream to fall back to.
  const staged: Array<{ filename: string; contentType: string; size: number; sha: string }> = [];
  for (const filename of await listCachedAttachments(oldConfluenceId)) {
    const data = await readCachedAttachmentFile(oldConfluenceId, filename);
    if (data === null) continue;
    await writeLocalAttachmentFileForRelocate(page.id, filename, data);
    staged.push({
      filename,
      contentType: getMimeType(filename),
      size: data.length,
      sha: createHash('sha256').update(data).digest('hex'),
    });
  }

  const { html: rewrittenHtml } = rewriteAttachmentRefs(
    page.body_html ?? '',
    [`/api/attachments/${encodeURIComponent(oldConfluenceId)}/`],
    `/api/local-attachments/${page.id}/`,
    false,
  );
  // `body_storage` needs no rewrite: Confluence storage format references
  // attachments as `<ri:attachment ri:filename="…">`, which carries no page
  // key. It is kept verbatim so macro fidelity survives a later move back.

  const snapshot: PreMoveSnapshot = {
    ...page,
    childIds: await loadChildIds(oldConfluenceId, page.id),
    oldKey: oldConfluenceId,
  };

  let childrenRepointed = 0;
  const txClient = await getPool().connect();
  try {
    await txClient.query('BEGIN');
    const fresh = await lockAndReload(txClient, page.id);
    if (fresh.source !== 'confluence' || fresh.confluence_id !== oldConfluenceId) {
      throw new RelocateError(409, 'Page changed while this move was in flight');
    }

    await txClient.query(
      `UPDATE pages SET
         source = 'standalone',
         confluence_id = NULL,
         space_key = $2,
         visibility = $3,
         -- The relocating user owns the article afterwards. Confluence rows
         -- carry a NULL created_by_user_id, and a 'private' page with no owner
         -- is invisible to everyone — including the person who moved it.
         created_by_user_id = $4,
         body_html = $5,
         embedding_dirty = TRUE,
         embedding_status = 'not_embedded',
         embedded_at = NULL,
         local_modified_at = NOW(),
         local_modified_by = $4
       WHERE id = $1`,
      [page.id, spaceKey, visibility, userId, rewrittenHtml],
    );

    const repointed = await txClient.query(
      'UPDATE pages SET parent_id = $2 WHERE parent_id = $1 AND deleted_at IS NULL AND id <> $3',
      [oldConfluenceId, newKey, page.id],
    );
    childrenRepointed = repointed.rowCount ?? 0;

    for (const s of staged) {
      await txClient.query(
        `INSERT INTO local_attachments (page_id, filename, content_type, size_bytes, sha256, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (page_id, filename) DO UPDATE SET
           content_type = EXCLUDED.content_type,
           size_bytes   = EXCLUDED.size_bytes,
           sha256       = EXCLUDED.sha256,
           updated_at   = NOW()`,
        [page.id, s.filename, s.contentType, s.size, s.sha, userId],
      );
    }

    await txClient.query('COMMIT');
  } catch (err) {
    await txClient.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    txClient.release();
  }

  // The local side is committed and the article now sits permanently outside
  // deletion reconciliation's reach (`confluence_id IS NULL`). Only now do we
  // touch the irreversible upstream side.
  let upstreamDeleted = true;
  try {
    await client.deletePage(oldConfluenceId);
  } catch (err) {
    if (await confirmUpstreamGone(client, oldConfluenceId, err)) {
      // DELETE reported an error but the page is gone (404, or DC trashed it).
      upstreamDeleted = true;
    } else {
      // Provably still live: put everything back so neither side changed,
      // rather than leaving a duplicate for the next sync to import.
      await restorePreMoveState(snapshot, staged.map((s) => s.filename));
      throw err;
    }
  }

  // Post-commit, best-effort: the Confluence-keyed cache directory is now
  // unreachable but harmless if it lingers.
  await removeAttachmentDirectory(oldConfluenceId).catch((err: unknown) => {
    logger.warn(
      {
        pageId: page.id,
        confluenceId: oldConfluenceId,
        err: err instanceof Error ? err.message : String(err),
      },
      'Relocate committed but the old attachment cache directory could not be removed (orphaned files only)',
    );
  });

  return {
    pageId: page.id,
    source: 'standalone',
    spaceKey,
    confluenceId: null,
    childrenRepointed,
    versionsDiscarded: 0,
    attachmentsMigrated: staged.length,
    upstreamDeleted,
    warnings,
  };
}

/**
 * Decide whether a failed `deletePage` nevertheless left the page gone.
 *
 * Reuses the exact test `detectDeletedPages` applies: a 404, or a 200 whose
 * `status` is `trashed` (DC's DELETE trashes rather than purges). Anything
 * else — 403, 5xx, network — means the page may still be live, so the caller
 * must not assume success.
 */
async function confirmUpstreamGone(
  client: ConfluenceClient,
  confluenceId: string,
  originalErr: unknown,
): Promise<boolean> {
  if (originalErr instanceof ConfluenceError && originalErr.statusCode === 404) return true;
  try {
    return (await client.getPage(confluenceId)).status === 'trashed';
  } catch (probeErr) {
    return probeErr instanceof ConfluenceError && probeErr.statusCode === 404;
  }
}

/**
 * Compensating transaction: restore every column and child link the move
 * changed. Runs only when the upstream delete provably did not happen, so the
 * restored `confluence_id` points at a page that is still live — the state
 * deletion reconciliation expects.
 */
async function restorePreMoveState(
  snapshot: PreMoveSnapshot,
  stagedFilenames: string[],
): Promise<void> {
  const txClient = await getPool().connect();
  try {
    await txClient.query('BEGIN');
    await txClient.query('SELECT pg_advisory_xact_lock($1)', [PAGE_MOVE_ADVISORY_LOCK_ID]);
    await txClient.query(
      `UPDATE pages SET
         source = $2, confluence_id = $3, space_key = $4, visibility = $5,
         created_by_user_id = $6, body_html = $7, body_storage = $8
       WHERE id = $1`,
      [
        snapshot.id,
        snapshot.source,
        snapshot.confluence_id,
        snapshot.space_key,
        snapshot.visibility,
        snapshot.created_by_user_id,
        snapshot.body_html,
        snapshot.body_storage,
      ],
    );
    if (snapshot.childIds.length > 0) {
      await txClient.query('UPDATE pages SET parent_id = $1 WHERE id = ANY($2::int[])', [
        snapshot.oldKey,
        snapshot.childIds,
      ]);
    }
    if (stagedFilenames.length > 0) {
      await txClient.query(
        'DELETE FROM local_attachments WHERE page_id = $1 AND filename = ANY($2::text[])',
        [snapshot.id, stagedFilenames],
      );
    }
    await txClient.query('COMMIT');
    logger.warn(
      { pageId: snapshot.id, confluenceId: snapshot.confluence_id },
      'Relocate rolled back: the Confluence page is still live, so the local move was reverted — neither side changed',
    );
  } catch (restoreErr) {
    await txClient.query('ROLLBACK').catch(() => undefined);
    // The article itself is safe — it is a standalone row with no upstream
    // link, so nothing can soft-delete it. The Confluence page also still
    // exists, so the next sync imports it as a separate row: recoverable, and
    // never data loss.
    logger.error(
      {
        pageId: snapshot.id,
        confluenceId: snapshot.confluence_id,
        err: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
      },
      'Relocate compensation failed — the article is local and safe, but the Confluence page still exists and will be re-imported by the next sync',
    );
  } finally {
    txClient.release();
  }
}

/** Best-effort removal of the local attachment directory after a move away. */
async function removeLocalAttachmentDirectory(pageId: number): Promise<void> {
  try {
    await fs.rm(localAttachmentsDir(pageId), { recursive: true, force: true });
  } catch {
    // Orphaned files only — the DB is consistent.
  }
}

/**
 * Entry point. `page` must already have been authorised by the route
 * (`pages:relocate` + target-space write access + page access); this function
 * verifies the acknowledgements that depend on live state.
 */
export async function relocatePage(opts: {
  page: RelocatablePage;
  userId: string;
  input: RelocatePageInput;
  client: ConfluenceClient;
}): Promise<RelocatePageResponse> {
  const { page, userId, input, client } = opts;

  if (input.target === 'confluence') {
    if (page.source !== 'standalone') {
      throw new RelocateError(400, 'Page is already a Confluence page');
    }
    const result = await relocateToConfluence({
      page,
      userId,
      spaceKey: input.spaceKey,
      client,
      expectedVersionCount: input.acknowledgeDiscardedVersions,
    });
    // Post-commit cleanup of the source-side stores. Guarded against the case
    // where Confluence handed back an id equal to our numeric key.
    if (result.confluenceId !== String(page.id)) {
      await removeAttachmentDirectory(String(page.id)).catch(() => undefined);
    }
    await removeLocalAttachmentDirectory(page.id);
    return result;
  }

  if (page.source !== 'confluence' || !page.confluence_id) {
    throw new RelocateError(400, 'Page is already a local article');
  }
  return relocateToLocal({
    page,
    userId,
    spaceKey: input.spaceKey,
    visibility: input.visibility,
    client,
  });
}
