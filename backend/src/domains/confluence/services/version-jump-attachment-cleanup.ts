/**
 * The attachment-cache cleanup `syncPage` runs when an existing Confluence
 * page arrives with a newer upstream version (#1773).
 *
 * The page's cache directory `attachmentCacheDir(<confluence_id>)` is not only
 * a Confluence cache. Images pasted or imported into the page's editor land
 * there too (`imageAttachmentPageKey`), and until the page is published they
 * have no upstream copy. Removing the whole directory — what this cleanup did
 * before — made a draft's pasted image answer 404 after the next upstream
 * edit. So the cleanup is selective, per page:
 *
 *  - **incoming**: what the new upstream `body_storage` references, i.e.
 *    `getExpectedAttachmentFilenames` (image refs, draw.io `<name>.png`) plus
 *    each diagram's `<name>.drawio` source and `<name>.drawio.png` preview.
 *    These are removed ON PURPOSE: the downloaders skip a file already on
 *    disk and cached names carry no version, so a same-name attachment
 *    changed upstream would otherwise be served stale for good.
 *  - **localKeep**: what this page's `body_html`, `draft_body_html`,
 *    `body_storage`, `draft_body_storage` and `page_versions.body_html` rows
 *    name: `/api/attachments/…` URLs through the #1349 collector
 *    (`collectAttachmentUrlReferences`), storage refs through
 *    `getExpectedAttachmentFilenames`. A diagram any of them names keeps all
 *    three of its files.
 *
 * A cached file goes when it is incoming or not in localKeep; every other file
 * stays. Dot-files are not cached files (no reader can address them) and are
 * never touched: they are draw.io classification receipts, which name one
 * exact attachment identity and so stay true across versions, or an
 * in-flight upload's staging file. The keep-set is read from two per-page
 * queries — never the corpus-wide sweep keep-set — after the directory is
 * listed and before anything is deleted. The delete is best-effort and
 * outside any transaction: a filesystem error is logged and the sync goes
 * on. The Redis failure counters and the image re-read flag follow exactly
 * as in `cleanPageAttachments`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';
import {
  attachmentCacheDir,
  isStorableAttachmentFilename,
  removeCachedAttachmentFile,
} from '../../../core/services/attachment-store.js';
import { clearAttachmentFailures, getRedisClient } from '../../../core/services/redis-cache.js';
import { markPageImagesDirtyByAttachmentKey } from '../../../core/services/image-analysis-dirty.js';
import { getExpectedAttachmentParts } from './attachment-handler.js';
import { collectAttachmentUrlReferences, type AttachmentKeepSets } from './attachment-sweep-service.js';

/** The URL prefix of this cache. The collector matches no other spelling of it. */
const CACHE_URL_PREFIX = '/api/attachments/';
const DRAWIO_SOURCE_SUFFIX = '.drawio';
const DRAWIO_PREVIEW_SUFFIX = '.drawio.png';

/** One page's local content, as read before any delete. */
export interface VersionJumpLocalSources {
  bodyHtml: string | null;
  draftBodyHtml: string | null;
  bodyStorage: string | null;
  draftBodyStorage: string | null;
  /** `pages.space_key`: resolves cross-page refs in the stored storage the way their download named them. */
  spaceKey: string | null;
  /** The page's `page_versions.body_html` rows that can name a cached file. */
  versionBodiesHtml: readonly string[];
}

export interface VersionJumpSelectionInput {
  /** Regular files with storable names in the page's cache directory. */
  cached: readonly string[];
  /** The new upstream `body_storage`. */
  incomingStorage: string;
  /** The space being synced: the `currentSpaceKey` the downloads name files with. */
  spaceKey: string;
  local: VersionJumpLocalSources;
}

/** A diagram's three cached files, named the way `safeAttachmentPath` writes them. */
function addDiagramFiles(into: Set<string>, diagramName: string): void {
  for (const suffix of ['.png', DRAWIO_SOURCE_SUFFIX, DRAWIO_PREVIEW_SUFFIX]) {
    into.add(path.basename(`${diagramName}${suffix}`));
  }
}

/** Every cached file one storage-format body references: image refs and each diagram's three files. */
function addStorageReferences(into: Set<string>, storage: string, spaceKey: string | undefined): void {
  const { imageFiles, diagramNames } = getExpectedAttachmentParts(storage, spaceKey);
  for (const name of imageFiles) into.add(path.basename(name));
  for (const name of diagramNames) addDiagramFiles(into, name);
}

/**
 * The cached files a version jump removes, in `cached` order: the ones the
 * incoming body references, and the ones no local source names. Pure apart
 * from parsing the storage bodies; throws only if a body cannot be parsed.
 */
export function selectVersionJumpCacheDeletions(input: VersionJumpSelectionInput): string[] {
  const { local } = input;
  const incoming = new Set<string>();
  addStorageReferences(incoming, input.incomingStorage, input.spaceKey);

  // Storage columns get the URL pass too: storage can carry `/api/attachments/…`
  // URLs verbatim (the sweep's keep-set reads them the same way).
  const urls: AttachmentKeepSets = { confluence: new Set(), local: new Set() };
  for (const text of [
    local.bodyHtml,
    local.draftBodyHtml,
    local.bodyStorage,
    local.draftBodyStorage,
    ...local.versionBodiesHtml,
  ]) {
    collectAttachmentUrlReferences(text, urls);
  }
  const localKeep = new Set(urls.confluence);
  // A diagram in HTML always carries its `<name>.drawio` source locator, and
  // its preview files go with it.
  for (const name of urls.confluence) {
    if (name.endsWith(DRAWIO_PREVIEW_SUFFIX)) {
      addDiagramFiles(localKeep, name.slice(0, -DRAWIO_PREVIEW_SUFFIX.length));
    } else if (name.endsWith(DRAWIO_SOURCE_SUFFIX)) {
      addDiagramFiles(localKeep, name.slice(0, -DRAWIO_SOURCE_SUFFIX.length));
    }
  }
  for (const storage of [local.bodyStorage, local.draftBodyStorage]) {
    if (storage) addStorageReferences(localKeep, storage, local.spaceKey ?? undefined);
  }

  return input.cached.filter((name) => incoming.has(name) || !localKeep.has(name));
}

export interface PruneVersionJumpAttachmentCacheInput {
  /** `pages.id` of the existing row. */
  pageId: number;
  /** The cache directory key: the page's `confluence_id`. */
  attachmentKey: string;
  /** The new upstream `body_storage`. */
  incomingStorage: string;
  /** The space being synced. */
  spaceKey: string;
}

/**
 * The cached files, as `listCachedAttachments` reads them (regular files with
 * storable names, so never a dot-file), except that a failure other than an
 * absent directory is logged rather than silently read as "empty".
 */
async function listCachedFiles(attachmentKey: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(attachmentCacheDir(attachmentKey), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && isStorableAttachmentFilename(entry.name))
      .map((entry) => entry.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(
        { err, attachmentKey },
        'Version-jump attachment cleanup could not list the cache directory; nothing removed',
      );
    }
    return [];
  }
}

/** The keep-set's sources for one page: its row, and the history rows that can name a cached file. */
async function readLocalSources(pageId: number): Promise<VersionJumpLocalSources> {
  const page = await query<{
    body_html: string | null;
    draft_body_html: string | null;
    body_storage: string | null;
    draft_body_storage: string | null;
    space_key: string | null;
  }>(
    `SELECT body_html, draft_body_html, body_storage, draft_body_storage, space_key
       FROM pages WHERE id = $1`,
    [pageId],
  );
  const versions = await query<{ body_html: string }>(
    `SELECT body_html FROM page_versions WHERE page_id = $1 AND strpos(body_html, $2) > 0`,
    [pageId, CACHE_URL_PREFIX],
  );
  const row = page.rows[0];
  return {
    bodyHtml: row?.body_html ?? null,
    draftBodyHtml: row?.draft_body_html ?? null,
    bodyStorage: row?.body_storage ?? null,
    draftBodyStorage: row?.draft_body_storage ?? null,
    spaceKey: row?.space_key ?? null,
    versionBodiesHtml: versions.rows.map((version) => version.body_html),
  };
}

/**
 * Clean the page's attachment cache before a newer upstream version is
 * applied. Uses the pool and opens no transaction, so call it with none open.
 * A filesystem error never escapes; a database or parse error propagates after
 * the counters and flag are reset, with nothing deleted.
 */
export async function pruneVersionJumpAttachmentCache(
  input: PruneVersionJumpAttachmentCacheInput,
): Promise<void> {
  const { pageId, attachmentKey } = input;
  try {
    // List first: a file written after this point is not a candidate, and a
    // reference saved before the read below still protects its file.
    const cached = await listCachedFiles(attachmentKey);
    if (cached.length === 0) return;
    // The keep-set is read before any delete, and every delete derives from it.
    const local = await readLocalSources(pageId);
    const remove = selectVersionJumpCacheDeletions({
      cached,
      incomingStorage: input.incomingStorage,
      spaceKey: input.spaceKey,
      local,
    });
    for (const filename of remove) {
      try {
        await removeCachedAttachmentFile(attachmentKey, filename);
      } catch (err) {
        logger.warn({ err, attachmentKey, filename }, 'Version-jump attachment cleanup could not remove a cached file');
      }
    }
    logger.debug(
      { attachmentKey, pageId, cached: cached.length, removed: remove.length },
      'Version-jump attachment cleanup complete',
    );
  } finally {
    // Exactly cleanPageAttachments' tail: the new version gets fresh failure
    // budgets, and the page's images are re-read on the next scan because the
    // bytes behind them may have changed.
    await clearAttachmentFailures(getRedisClient(), attachmentKey);
    await markPageImagesDirtyByAttachmentKey(attachmentKey);
  }
}
